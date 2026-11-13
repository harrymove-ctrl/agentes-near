import type { SecretBox } from "@agenteschat/client";
import { MAX_SECRET_BYTES } from "@agenteschat/client/lib/secret-box";
import { gcm } from "@noble/ciphers/aes.js";
import { p256 } from "@noble/curves/nist.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * The phone's half of ADR 0027, as the web's `sealSecret` (`@agenteschat/client/lib/secret-box`): a secret
 * sealed to the key the agent's computer made for this request, so our server only relays a box it can't open.
 * Same algorithm and bytes (ECDH P-256 → HKDF-SHA256 → AES-256-GCM, the request bound in as AAD); React Native
 * has no WebCrypto, so it runs on the audited pure-JS `@noble` libraries. `random`: secure random bytes (the
 * app's is `expo-crypto`, ./secret-box.ts). Pure, so `test/secret-seal.test.ts` opens what it seals with the
 * computer's own code.
 */
const INFO = new TextEncoder().encode("agentes.chat secret v1");

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
};
const unb64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

export function sealSecretWith(
  random: (n: number) => Uint8Array,
  recipientPublicKey: string,
  plaintext: string,
  aad: string,
): SecretBox {
  const data = new TextEncoder().encode(plaintext);
  if (data.byteLength === 0) throw new Error("empty");
  if (data.byteLength > MAX_SECRET_BYTES) throw new Error("too_large");
  const recipient = unb64(recipientPublicKey);
  const eph = p256.utils.randomSecretKey(random(p256.lengths.seed ?? 48));
  // The raw (uncompressed) point, as WebCrypto exports it.
  const epk = p256.getPublicKey(eph, false);
  // WebCrypto's ECDH bits are the shared point's x: the compressed point without its prefix byte.
  const shared = p256.getSharedSecret(eph, recipient, true).slice(1);
  const key = hkdf(sha256, shared, epk, INFO, 32);
  const iv = random(12);
  // Ciphertext then the 16-byte tag, as WebCrypto's AES-GCM.
  const ct = gcm(key, iv, new TextEncoder().encode(aad)).encrypt(data);
  return { v: 1, epk: b64(epk), iv: b64(iv), ct: b64(ct) };
}
