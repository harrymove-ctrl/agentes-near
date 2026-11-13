/**
 * Secrets sent to an agent's computer end to end (ADR 0027). The computer
 * makes a key pair per request and keeps the private key; the browser seals
 * the value to the public key; our server only relays the box. WebCrypto
 * only (browsers, Node 20+, Bun), so this file imports nothing: the runner
 * bundles it, and the web app has its own copy of `sealSecret`
 * (apps/web/src/lib/secret-box.ts).
 *
 * ECDH P-256 (an ephemeral key from the sender) → HKDF-SHA256 → AES-256-GCM,
 * with the request bound in as additional data.
 */

export const SECRET_BOX_VERSION = 1;
/** Largest value a person can send (UTF-8 bytes). */
export const MAX_SECRET_BYTES = 16 * 1024;
/** `GITHUB_TOKEN`, `NPM_TOKEN`… */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/**
 * Names a secret can't have: what decides where an AI CLI's sign-in, key or requests go (its endpoint, its
 * proxy, the certificates it trusts, what loads into it). A person asked for one would hand the agent a
 * way to send someone's plan elsewhere.
 */
export const isReservedSecretName = (name: string) =>
  /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|OPENCODE_|XAI_|GROK_|GEMINI_|AGY_|GOOGLE_(?:API_KEY$|GEMINI_|GENAI_)|NODE_|SSL_CERT_|LD_|DYLD_)|_PROXY$/.test(
    name.toUpperCase(),
  );

export interface SecretBox {
  v: number;
  /** The sender's ephemeral public key (raw, base64). */
  epk: string;
  /** AES-GCM nonce (12 bytes, base64). */
  iv: string;
  /** Ciphertext with its tag (base64). */
  ct: string;
}

/**
 * Where a delivered secret goes on the computer: an environment variable of the agent's commands, a file in its
 * folder, or (`site`) only the agent browser's password typing on that one site (an origin, `https://host`), never
 * its commands.
 */
export type SecretTarget = { kind: "env" } | { kind: "file"; path: string } | { kind: "site"; site: string };

const subtle = () => {
  const c = globalThis.crypto?.subtle;
  if (!c) throw new Error("WebCrypto is not available here");
  return c;
};

const b64 = (bytes: ArrayBuffer | Uint8Array) => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const byte of u) s += String.fromCharCode(byte);
  return btoa(s);
};
const unb64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

const EC = { name: "ECDH", namedCurve: "P-256" } as const;
const INFO = new TextEncoder().encode("agentes.chat secret v1");

/** What binds a box to one request: replayed onto another request or target, it doesn't open. */
export function secretAad(input: { requestId: string; orgId: string; name: string; target: SecretTarget }) {
  const t = input.target;
  const target = t.kind === "file" ? `file:${t.path}` : t.kind === "site" ? `site:${t.site}` : "env";
  return `agentes-secret|v${SECRET_BOX_VERSION}|${input.requestId}|${input.orgId}|${input.name}|${target}`;
}

/**
 * What a Vault value is for once it reaches the computer (ADR 0144): typed into a login field on the sites a rule
 * names (`exact:https://host[:port]` or `site:<registrable domain>`, see `vault/site.ts`), or given to one command
 * as one variable.
 */
export type VaultUse = { kind: "fill"; rule: string } | { kind: "env"; name: string };

/**
 * What binds a Vault box to one in-memory key of one agent and to one use (ADR 0144). The runner rebuilds it from
 * its own key record, its own agent id and the use it was asked for, so a box replayed onto another key, agent,
 * site rule or variable doesn't open.
 */
export function vaultAad(input: { keyId: string; agentId: string; use: VaultUse }) {
  const use = input.use.kind === "fill" ? `fill:${input.use.rule}` : `env:${input.use.name}`;
  return `agentes-vault|v${SECRET_BOX_VERSION}|${input.keyId}|${input.agentId}|${use}`;
}

/** What binds a password an agent's computer made to the one request that asked for it (ADR 0144 §8). */
export const madePasswordAad = (input: { requestId: string; agentId: string }) =>
  `agentes-vault|v${SECRET_BOX_VERSION}|${input.requestId}|${input.agentId}|made`;

/** The computer's side: a fresh pair; the private key (PKCS#8, base64) never leaves it. */
export async function generateSecretKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await subtle().generateKey(EC, true, ["deriveBits"])) as CryptoKeyPair;
  const [pub, priv] = await Promise.all([
    subtle().exportKey("raw", pair.publicKey),
    subtle().exportKey("pkcs8", pair.privateKey),
  ]);
  return { publicKey: b64(pub), privateKey: b64(priv) };
}

async function aesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
  usage: "encrypt" | "decrypt",
) {
  const shared = await subtle().deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdf = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: INFO },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** The sender's side (the browser; here for tests and tools). */
export async function sealSecret(recipientPublicKey: string, plaintext: string, aad: string): Promise<SecretBox> {
  const data = new TextEncoder().encode(plaintext);
  if (data.byteLength === 0) throw new Error("The secret is empty");
  if (data.byteLength > MAX_SECRET_BYTES) throw new Error(`The secret is larger than ${MAX_SECRET_BYTES} bytes`);
  const recipient = await subtle().importKey("raw", unb64(recipientPublicKey), EC, false, []);
  const eph = (await subtle().generateKey(EC, true, ["deriveBits"])) as CryptoKeyPair;
  const epk = new Uint8Array(await subtle().exportKey("raw", eph.publicKey));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(eph.privateKey, recipient, epk, "encrypt");
  const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, data);
  return { v: SECRET_BOX_VERSION, epk: b64(epk), iv: b64(iv), ct: b64(ct) };
}

/** The computer's side. Throws when the box was made for another key, request or target. */
export async function openSecret(privateKey: string, box: SecretBox, aad: string): Promise<string> {
  if (box?.v !== SECRET_BOX_VERSION) throw new Error("Unknown secret box version");
  const priv = await subtle().importKey("pkcs8", unb64(privateKey), EC, false, ["deriveBits"]);
  const epk = unb64(box.epk);
  const sender = await subtle().importKey("raw", epk, EC, false, []);
  const key = await aesKey(priv, sender, epk, "decrypt");
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: unb64(box.iv), additionalData: new TextEncoder().encode(aad) },
    key,
    unb64(box.ct),
  );
  return new TextDecoder().decode(plain);
}

/** A box as it arrives from a client: the right fields and sizes, or null. */
export function parseSecretBox(value: unknown): SecretBox | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const ok = (s: unknown, max: number) => typeof s === "string" && s.length > 0 && s.length <= max;
  if (v.v !== SECRET_BOX_VERSION || !ok(v.epk, 200) || !ok(v.iv, 40) || !ok(v.ct, MAX_SECRET_BYTES * 2)) return null;
  return { v: SECRET_BOX_VERSION, epk: v.epk as string, iv: v.iv as string, ct: v.ct as string };
}

/**
 * Replaces each secret value in `text` with `[secret:NAME]` (longest first,
 * so a value that contains another is caught whole). Values shorter than 4
 * characters are left alone: they would mangle ordinary output.
 */
export function redactSecrets(text: string, secrets: { name: string; value: string }[]): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.value.length - a.value.length)) {
    if (s.value.length < 4) continue;
    out = out.split(s.value).join(`[secret:${s.name}]`);
  }
  return out;
}
