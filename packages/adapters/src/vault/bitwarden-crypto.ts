/**
 * The part of Bitwarden's cryptography the Vault's Bitwarden source needs (ADR 0144): the master key from
 * the master password (PBKDF2-SHA256 or Argon2id, with the account's own settings), its HKDF stretch, the user key it
 * protects, per-cipher keys and EncStrings of type 2 (AES-256-CBC with an HMAC-SHA256 checked before decrypting).
 *
 * Nothing here keeps a key or logs one. The caller holds the user key in memory for a few minutes at most.
 *
 * PBKDF2 runs on WebCrypto (native, off the event loop: 600,000 rounds are the default) and the rest on the
 * `@noble` primitives, which are audited and pure JS.
 */
import { cbc } from "@noble/ciphers/aes.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { expand } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** The account's key derivation, as its server reports it. Argon2id memory is in MiB, as Bitwarden counts it. */
export type BitwardenKdf =
  | { type: "pbkdf2"; iterations: number }
  | { type: "argon2id"; iterations: number; memoryMiB: number; parallelism: number };

/** An AES-256-CBC key with its HMAC-SHA256 key (Bitwarden's "symmetric key": 64 bytes, encryption key first). */
export interface SymmetricKey {
  encKey: Uint8Array;
  macKey: Uint8Array;
}

export type BitwardenCryptoFailure =
  /** The MAC didn't match: the wrong key (a wrong master password, for the user key) or changed data. */
  | "mac"
  /** The text isn't an EncString we can read. */
  | "format"
  /** The padding was wrong after decrypting (only possible for the legacy unauthenticated user key). */
  | "padding"
  /** An EncString type or key size this client doesn't read. */
  | "unsupported"
  /** The account's key derivation settings are out of the range Bitwarden itself allows (or this server's). */
  | "kdf";

/** A failure of this module. Its message is ours and never carries key material or plaintext. */
export class BitwardenCryptoError extends Error {
  constructor(readonly reason: BitwardenCryptoFailure) {
    super(`Bitwarden crypto: ${reason}`);
    this.name = "BitwardenCryptoError";
  }
}

/** The floors Bitwarden's own clients refuse to go below. */
const PBKDF2_MIN_ITERATIONS = 5_000;
const PBKDF2_MAX_ITERATIONS = 2_000_000;
const ARGON2_MIN_ITERATIONS = 2;
const ARGON2_MAX_ITERATIONS = 10;
const ARGON2_MIN_MEMORY_MIB = 16;
/**
 * Bitwarden allows up to 1 GiB. Argon2id here is pure JS in the server's own memory, so a ceiling keeps one
 * connection from taking the server down; the default (64 MiB) is well under it.
 */
export const ARGON2_MAX_MEMORY_MIB = 256;
/**
 * The most work one derivation may take, as MiB of memory times iterations (ADR 0144): the account's server picks
 * the settings, and the time Argon2id takes here grows with both, so their product is capped too. Bitwarden's
 * default (64 MiB, 3 iterations) is under it; 64 MiB with 4 iterations is the most at that memory.
 */
export const ARGON2_MAX_WORK_MIB_ITERATIONS = 256;
const ARGON2_MIN_PARALLELISM = 1;
const ARGON2_MAX_PARALLELISM = 16;

const IV_BYTES = 16;
const MAC_BYTES = 32;
const KEY_BYTES = 32;

const encoder = new TextEncoder();
const utf8 = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text);

/** Strict base64 (standard alphabet, padded), or null. */
export function fromBase64(text: string): Uint8Array | null {
  if (!text || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Compares two MACs in time that depends only on their length (a MAC's length is public). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Whether the account's KDF settings are ones Bitwarden allows and this server can run. */
export function kdfSupported(kdf: BitwardenKdf): boolean {
  const int = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
  if (kdf.type === "pbkdf2") return int(kdf.iterations, PBKDF2_MIN_ITERATIONS, PBKDF2_MAX_ITERATIONS);
  return (
    int(kdf.iterations, ARGON2_MIN_ITERATIONS, ARGON2_MAX_ITERATIONS) &&
    int(kdf.memoryMiB, ARGON2_MIN_MEMORY_MIB, ARGON2_MAX_MEMORY_MIB) &&
    int(kdf.parallelism, ARGON2_MIN_PARALLELISM, ARGON2_MAX_PARALLELISM) &&
    kdf.memoryMiB * kdf.iterations <= ARGON2_MAX_WORK_MIB_ITERATIONS
  );
}

/**
 * The master key: PBKDF2-SHA256(password, email) or Argon2id(password, SHA-256(email)), 32 bytes. The email is
 * trimmed and lowercased first, as every Bitwarden client does. The password is used exactly as typed.
 */
export async function deriveMasterKey(password: string, email: string, kdf: BitwardenKdf): Promise<Uint8Array> {
  if (!kdfSupported(kdf)) throw new BitwardenCryptoError("kdf");
  const salt = utf8(email.trim().toLowerCase());
  const secret = utf8(password);
  try {
    if (kdf.type === "pbkdf2") {
      const subtle = globalThis.crypto?.subtle;
      if (!subtle) throw new BitwardenCryptoError("unsupported");
      const base = await subtle.importKey("raw", secret, "PBKDF2", false, ["deriveBits"]);
      const bits = await subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations: kdf.iterations },
        base,
        KEY_BYTES * 8,
      );
      return new Uint8Array(bits);
    }
    const memoryKiB = kdf.memoryMiB * 1024;
    return await argon2idAsync(secret, sha256(salt), {
      t: kdf.iterations,
      m: memoryKiB,
      p: kdf.parallelism,
      dkLen: KEY_BYTES,
      maxmem: memoryKiB * 1024,
    });
  } finally {
    secret.fill(0);
  }
}

/** The stretched master key: HKDF-Expand(SHA-256) of the master key with info `enc` and `mac`, 32 bytes each. */
export function stretchMasterKey(masterKey: Uint8Array): SymmetricKey {
  if (masterKey.length !== KEY_BYTES) throw new BitwardenCryptoError("unsupported");
  return {
    encKey: expand(sha256, masterKey, utf8("enc"), KEY_BYTES),
    macKey: expand(sha256, masterKey, utf8("mac"), KEY_BYTES),
  };
}

/** A 64-byte key as Bitwarden stores it (encryption key, then MAC key). */
export function symmetricKeyFrom(bytes: Uint8Array): SymmetricKey {
  if (bytes.length !== KEY_BYTES * 2) throw new BitwardenCryptoError("unsupported");
  return { encKey: bytes.slice(0, KEY_BYTES), macKey: bytes.slice(KEY_BYTES) };
}

type ParsedEncString =
  | { type: 2; iv: Uint8Array; data: Uint8Array; mac: Uint8Array }
  | { type: 0; iv: Uint8Array; data: Uint8Array };

/** `2.iv|data|mac` (or the legacy `0.iv|data`, only ever for a user key) with every part's size checked. */
export function parseEncString(text: string): ParsedEncString {
  const dot = text.indexOf(".");
  if (dot < 1) throw new BitwardenCryptoError("format");
  const type = text.slice(0, dot);
  const parts = text.slice(dot + 1).split("|");
  if (type !== "2" && type !== "0") throw new BitwardenCryptoError("unsupported");
  const iv = fromBase64(parts[0] ?? "");
  const data = fromBase64(parts[1] ?? "");
  if (!iv || iv.length !== IV_BYTES || !data || data.length === 0 || data.length % 16 !== 0) {
    throw new BitwardenCryptoError("format");
  }
  if (type === "0") {
    if (parts.length !== 2) throw new BitwardenCryptoError("format");
    return { type: 0, iv, data };
  }
  const mac = parts.length === 3 ? fromBase64(parts[2] ?? "") : null;
  if (!mac || mac.length !== MAC_BYTES) throw new BitwardenCryptoError("format");
  return { type: 2, iv, data, mac };
}

function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  try {
    return cbc(key, iv).decrypt(data);
  } catch {
    throw new BitwardenCryptoError("padding");
  }
}

/** Decrypts an EncString of type 2: the MAC over `iv || data` is checked (in constant time) before anything else. */
export function decryptBytes(encString: string, key: SymmetricKey): Uint8Array {
  const parsed = parseEncString(encString);
  if (parsed.type !== 2) throw new BitwardenCryptoError("unsupported");
  const expected = hmac(sha256, key.macKey, concat(parsed.iv, parsed.data));
  if (!constantTimeEqual(expected, parsed.mac)) throw new BitwardenCryptoError("mac");
  return aesCbcDecrypt(key.encKey, parsed.iv, parsed.data);
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Decrypts an EncString of type 2 holding text (a name, a username, a website, a password). */
export function decryptString(encString: string, key: SymmetricKey): string {
  const bytes = decryptBytes(encString, key);
  try {
    return decoder.decode(bytes);
  } catch {
    throw new BitwardenCryptoError("format");
  }
}

/** A 64-byte key wrapped in an EncString of type 2 (a cipher's own key, under the user key). */
export function decryptSymmetricKey(encString: string, key: SymmetricKey): SymmetricKey {
  return symmetricKeyFrom(decryptBytes(encString, key));
}

/**
 * The user key from the account's protected key and its master key. Type 2 (the norm) is checked with the stretched
 * master key's MAC, so a wrong master password fails with `mac`. Type 0 is the legacy form older accounts may still
 * have: plain AES-256-CBC under the master key itself, where a wrong password shows as bad padding or a wrong size.
 */
export function decryptUserKey(protectedKey: string, masterKey: Uint8Array): SymmetricKey {
  const parsed = parseEncString(protectedKey);
  if (parsed.type === 0) {
    const bytes = aesCbcDecrypt(masterKey, parsed.iv, parsed.data);
    if (bytes.length !== KEY_BYTES * 2) throw new BitwardenCryptoError("padding");
    return symmetricKeyFrom(bytes);
  }
  const stretched = stretchMasterKey(masterKey);
  try {
    return symmetricKeyFrom(decryptBytes(protectedKey, stretched));
  } finally {
    stretched.encKey.fill(0);
    stretched.macKey.fill(0);
  }
}

/** Encrypts bytes as an EncString of type 2: a random IV, then the MAC over `iv || data` that decryption checks. */
export function encryptBytes(plain: Uint8Array, key: SymmetricKey, iv?: Uint8Array): string {
  const nonce = iv ?? globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = cbc(key.encKey, nonce).encrypt(plain);
  const mac = hmac(sha256, key.macKey, concat(nonce, data));
  return `2.${toBase64(nonce)}|${toBase64(data)}|${toBase64(mac)}`;
}

/** Text as an EncString of type 2 (a new login's name, username, website, password). */
export function encryptString(plain: string, key: SymmetricKey, iv?: Uint8Array): string {
  return encryptBytes(utf8(plain), key, iv);
}
