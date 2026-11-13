import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

export interface PqKeyPair {
  algorithm: "ML-DSA-65";
  publicKeyHex: string;
  secretKeyHex: string;
  fingerprint: string;
}

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const entries = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`,
  );
  return `{${entries.join(",")}}`;
}

export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? utf8ToBytes(input) : input;
  return bytesToHex(sha256(bytes));
}

export function hashCanonical(payload: unknown): string {
  return sha256Hex(canonicalizeJson(payload));
}

export function formatShortFingerprint(hex: string, prefix = "pq:mldsa65"): string {
  const clean = hex.replace(/^0x/, "");
  if (clean.length <= 16) return `${prefix}:${clean}`;
  return `${prefix}:${clean.slice(0, 8)}..${clean.slice(-6)}`;
}

export function generatePqIdentity(seedText?: string): PqKeyPair {
  const seed = seedText ? sha256(utf8ToBytes(seedText)) : undefined;
  const { publicKey, secretKey } = ml_dsa65.keygen(seed);
  const publicKeyHex = bytesToHex(publicKey);
  const secretKeyHex = bytesToHex(secretKey);
  const digest = sha256Hex(publicKey);
  return {
    algorithm: "ML-DSA-65",
    publicKeyHex,
    secretKeyHex,
    fingerprint: formatShortFingerprint(digest),
  };
}

export function signCanonicalPayload(secretKeyHex: string, payload: unknown): string {
  const msgBytes = utf8ToBytes(canonicalizeJson(payload));
  const sigBytes = ml_dsa65.sign(msgBytes, hexToBytes(secretKeyHex));
  return bytesToHex(sigBytes);
}

export function verifyCanonicalPayload(
  publicKeyHex: string,
  payload: unknown,
  signatureHex: string,
): boolean {
  try {
    const msgBytes = utf8ToBytes(canonicalizeJson(payload));
    return ml_dsa65.verify(
      hexToBytes(signatureHex),
      msgBytes,
      hexToBytes(publicKeyHex),
    );
  } catch {
    return false;
  }
}
