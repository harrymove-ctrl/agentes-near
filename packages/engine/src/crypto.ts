import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { KeyWrapper } from "@agenteschat/adapters";

/**
 * Purposes for keys derived from AGENTES_SECRET (docs/adr/0004-configuration.md).
 * Each purpose gets an independent key, so a key leaked for one use cannot
 * decrypt another. Never rename an existing purpose: data protected with it
 * would become unreadable.
 */
export type KeyPurpose =
  | "sessions"
  | "provider-credentials-kek"
  | "git-proxy"
  | "invite-links"
  | "invitations"
  | "invitation-mail"
  | "routine-hooks"
  | "github-app-manifest";

function deriveKey(masterSecret: string, purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync("sha256", masterSecret, "agentes.chat", `agentes.chat/${purpose}/v1`, 32));
}

/** A purpose-specific secret (hex) for libraries that take a string secret, e.g. Better Auth. */
export function deriveSecret(masterSecret: string, purpose: KeyPurpose): string {
  return deriveKey(masterSecret, purpose).toString("hex");
}

/**
 * AES-256-GCM with associated data. Format: `v1.<iv>.<ciphertext>.<tag>`,
 * base64url parts. The version prefix lets us change the scheme later.
 * `aad` is authenticated but not stored: decrypting with a different `aad`
 * (e.g. another org's id) fails.
 */
export function aesGcmEncrypt(key: Uint8Array, plaintext: Uint8Array, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ["v1", iv, ciphertext, cipher.getAuthTag()]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

/**
 * A sealed value this key can never open: sealed with another key (another AGENTES_SECRET), for another
 * owner (`aad`), or damaged. Unlike a key service that doesn't answer, trying again won't change it.
 */
export class SealedValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealedValueError";
  }
}

export function aesGcmDecrypt(key: Uint8Array, encrypted: string, aad: string): Buffer {
  const [version, iv, ciphertext, tag] = encrypted.split(".");
  if (version !== "v1" || !iv || ciphertext === undefined || !tag)
    throw new SealedValueError("unsupported encrypted value");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
  } catch (error) {
    // Only local computation here: a wrong key, `aad` or tag, never a passing failure.
    throw new SealedValueError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Self-host key-encryption key: derived from AGENTES_SECRET. Cloud replaces it
 * with a KMS-backed `KeyWrapper` through a module.
 */
export function createLocalKeyWrapper(masterSecret: string): KeyWrapper {
  const kek = deriveKey(masterSecret, "provider-credentials-kek");
  return {
    id: "local:v1",
    wrap: async (dataKey, aad) => aesGcmEncrypt(kek, dataKey, `kek|${aad}`),
    unwrap: async (wrapped, aad) => aesGcmDecrypt(kek, wrapped, `kek|${aad}`),
  };
}

export interface SealedSecret {
  ciphertext: string;
  wrappedDataKey: string;
  kekId: string;
}

/**
 * Envelope encryption: a fresh random data key encrypts the secret; the key
 * wrapper encrypts the data key. Both are bound to `aad`.
 */
export async function sealSecret(wrapper: KeyWrapper, plaintext: string, aad: string): Promise<SealedSecret> {
  const dataKey = randomBytes(32);
  try {
    return {
      ciphertext: aesGcmEncrypt(dataKey, Buffer.from(plaintext, "utf8"), aad),
      wrappedDataKey: await wrapper.wrap(dataKey, aad),
      kekId: wrapper.id,
    };
  } finally {
    dataKey.fill(0);
  }
}

/** Opens a sealed secret with whichever wrapper matches its `kekId`. */
export async function openSecret(wrappers: KeyWrapper[], sealed: SealedSecret, aad: string): Promise<string> {
  const wrapper = wrappers.find((w) => w.id === sealed.kekId);
  if (!wrapper) throw new Error(`no key wrapper for ${sealed.kekId}`);
  const dataKey = Buffer.from(await wrapper.unwrap(sealed.wrappedDataKey, aad));
  try {
    return aesGcmDecrypt(dataKey, sealed.ciphertext, aad).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}

/**
 * The token of a workspace's invitation link (ADR 0068): an HMAC of the link's id, so the same link can be shown
 * again while only its hash is stored. A new `AGENTES_SECRET` gives every link a token that no longer matches.
 */
export function inviteLinkToken(masterSecret: string, linkId: string): string {
  return createHmac("sha256", deriveKey(masterSecret, "invite-links")).update(linkId).digest("base64url");
}

/**
 * The token of an email invitation (ADR 0090): an HMAC of its id, as a workspace's link, so its link can be copied
 * again and sending it again keeps it, while only its hash is stored.
 */
export function invitationToken(masterSecret: string, invitationId: string): string {
  return createHmac("sha256", deriveKey(masterSecret, "invitations")).update(invitationId).digest("base64url");
}

/**
 * What only an email invitation's own message carries (ADR 0090): an HMAC of its id, on the emailed link's `?mail=`.
 * The link an admin copies has none, so accepting with it is what shows the mailbox got the message: only then does
 * the address count as confirmed.
 */
export function invitationMailProof(masterSecret: string, invitationId: string): string {
  return createHmac("sha256", deriveKey(masterSecret, "invitation-mail")).update(invitationId).digest("base64url");
}

/** The token in a routine's webhook address (ADR 0106), made the same way from its hook's key id. */
export function routineHookToken(masterSecret: string, keyId: string): string {
  return createHmac("sha256", deriveKey(masterSecret, "routine-hooks")).update(keyId).digest("base64url");
}

/** URL-safe random token, e.g. for invitation links. */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
