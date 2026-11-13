import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveSecret } from "../crypto";

/**
 * The credential a computer uses with our git proxy (ADR 0024). It is ours, not
 * GitHub's: an HMAC over org, agent, computer, a revocation generation and
 * an expiry. GitHub's token stays on the server and never enters a computer.
 */
export interface GitTokenClaims {
  orgId: string;
  agentId: string;
  /** The machine it was issued to (`machines.id`; the field keeps its name inside the token). */
  sandboxId: string;
  /** The machine's generation (`machineGitGen` of its token hash): re-pairing or deleting it revokes every token. */
  gen: number;
  /** `machine`: issued to a connected machine (ADR 0024 addendum); the proxy refuses any other token. */
  kind?: "machine";
  /** Unix seconds. */
  exp: number;
}

/** Tokens live 6 hours; `git.sync` hands the computer a fresh one each time. */
export const GIT_TOKEN_TTL_SECONDS = 6 * 3600;

const PREFIX = "agtgit1";

function key(masterSecret: string) {
  return Buffer.from(deriveSecret(masterSecret, "git-proxy"), "hex");
}

export function issueGitToken(masterSecret: string, claims: GitTokenClaims): string {
  const body = Buffer.from(
    JSON.stringify({
      o: claims.orgId,
      a: claims.agentId,
      s: claims.sandboxId,
      g: claims.gen,
      e: claims.exp,
      ...(claims.kind === "machine" ? { k: "m" } : {}),
    }),
  ).toString("base64url");
  const mac = createHmac("sha256", key(masterSecret)).update(`${PREFIX}.${body}`).digest("base64url");
  return `${PREFIX}.${body}.${mac}`;
}

/** The claims of a valid, unexpired token; null otherwise (never throws on bad input). */
export function verifyGitToken(masterSecret: string, token: string, now = new Date()): GitTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, body, mac] = parts as [string, string, string];
  const expected = createHmac("sha256", key(masterSecret)).update(`${PREFIX}.${body}`).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    const claims: GitTokenClaims = {
      orgId: String(c.o),
      agentId: String(c.a),
      sandboxId: String(c.s),
      gen: Number(c.g),
      exp: Number(c.e),
      ...(c.k === "m" ? { kind: "machine" as const } : {}),
    };
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now.getTime()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** A connected machine's revocation generation: from its token's hash (re-pairing or deleting it changes it). */
export const machineGitGen = (tokenHash: string) => Number.parseInt(tokenHash.slice(0, 8), 16);

/** The proxy's base URL for one org's GitHub connection: `https://HOST/api/git/{orgId}/{connectionId}/`. */
export const gitProxyBase = (publicUrl: string, orgId: string, connectionId: string) =>
  `${publicUrl.replace(/\/$/, "")}/api/git/${orgId}/${connectionId}/`;

/** An agent's commit email, on our host: `theo@agents.agentes.chat` for `https://agentes.chat` (or any URL under it). */
export const agentCommitEmail = (publicUrl: string, handle: string) =>
  `${handle}@agents.${new URL(publicUrl).hostname}`;
