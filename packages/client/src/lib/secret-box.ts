import type { SecretBox, SecretTarget } from "../api/types";

/**
 * The browser's half of ADR 0027: seals a secret to the key the agent's
 * computer made for this request, so our server only ever relays a box it
 * can't open. Same algorithm as `packages/adapters/src/secret-box.ts`
 * (ECDH P-256 → HKDF-SHA256 → AES-256-GCM, the request bound in as AAD);
 * `test/secret-box.test.ts` opens what this seals with that code.
 */
export const MAX_SECRET_BYTES = 16 * 1024;

const EC = { name: "ECDH", namedCurve: "P-256" } as const;
const INFO = new TextEncoder().encode("agentes.chat secret v1");

const b64 = (bytes: ArrayBuffer | Uint8Array) => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const byte of u) s += String.fromCharCode(byte);
  return btoa(s);
};
const unb64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

export function secretAad(input: { requestId: string; orgId: string; name: string; target: SecretTarget }) {
  const t = input.target;
  const target = t.kind === "file" ? `file:${t.path}` : t.kind === "site" ? `site:${t.site}` : "env";
  return `agentes-secret|v1|${input.requestId}|${input.orgId}|${input.name}|${target}`;
}

/**
 * ADR 0041 §2: the code Claude shows when adding an account, bound to that
 * sign-in. Same string as `accountCodeAad` in
 * `packages/adapters/src/machine-protocol.ts` (the client doesn't depend on adapters).
 */
export const accountCodeAad = (loginId: string, orgId: string) => `${loginId}|${orgId}|account`;

export async function sealSecret(recipientPublicKey: string, plaintext: string, aad: string): Promise<SecretBox> {
  const subtle = globalThis.crypto.subtle;
  const data = new TextEncoder().encode(plaintext);
  if (data.byteLength === 0) throw new Error("empty");
  if (data.byteLength > MAX_SECRET_BYTES) throw new Error("too_large");
  const recipient = await subtle.importKey("raw", unb64(recipientPublicKey), EC, false, []);
  const eph = (await subtle.generateKey(EC, true, ["deriveBits"])) as CryptoKeyPair;
  const epk = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
  const shared = await subtle.deriveBits({ name: "ECDH", public: recipient }, eph.privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: epk, info: INFO },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, data);
  return { v: 1, epk: b64(epk), iv: b64(iv), ct: b64(ct) };
}
