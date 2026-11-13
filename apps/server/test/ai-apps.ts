import { createHash, randomBytes } from "node:crypto";
import { type Browser, ORIGIN, type TestServer } from "./harness";

/** AI apps (ADR 0119) in tests: an app registering, the person allowing it, the code traded for tokens. */

export const LOOPBACK = "http://127.0.0.1:33418/callback";

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export async function registerClient(t: TestServer, body: Record<string, unknown>, ip = "203.0.113.7") {
  return t.app.request("/api/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

export function authorizeUrl(params: Record<string, string | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  return `/api/oauth/authorize?${q}`;
}

/** Where `/api/oauth/authorize` sends the browser. */
export async function authorize(t: TestServer, params: Record<string, string | undefined>) {
  const res = await t.app.request(authorizeUrl(params));
  return { status: res.status, location: res.headers.get("location") ?? "" };
}

export const requestIdOf = (location: string) => new URL(location).searchParams.get("req") ?? "";

export async function token(t: TestServer, form: Record<string, string>, ip = "203.0.113.7") {
  const res = await t.app.request("/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body: new URLSearchParams(form).toString(),
  });
  return { res, json: (await res.json()) as Record<string, string | number> };
}

export interface Connected {
  clientId: string;
  access: string;
  refresh: string;
  expiresIn: number;
  redirectUri: string;
}

/** The whole flow: register (or a given client), authorize, allow on the consent API, trade the code. */
export async function connectApp(
  t: TestServer,
  person: Browser,
  orgId: string,
  options: {
    name?: string;
    redirectUri?: string;
    access?: "read" | "write" | "manage";
    clientId?: string;
    scope?: string;
  } = {},
): Promise<Connected> {
  const redirectUri = options.redirectUri ?? LOOPBACK;
  let clientId = options.clientId;
  if (!clientId) {
    const reg = await registerClient(t, { client_name: options.name ?? "Claude Code", redirect_uris: [redirectUri] });
    if (reg.status !== 201) throw new Error(`register: ${reg.status} ${await reg.text()}`);
    clientId = ((await reg.json()) as { client_id: string }).client_id;
  }
  const { verifier, challenge } = pkce();
  const { location } = await authorize(t, {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
    scope: options.scope ?? "read write",
    resource: `${ORIGIN}/mcp`,
  });
  const req = requestIdOf(location);
  if (!req) throw new Error(`authorize: ${location}`);
  const decided = await person(`/api/app/authorize/${req}`, {
    json: { decision: "allow", orgId, access: options.access ?? "write" },
  });
  if (decided.status !== 200) throw new Error(`consent: ${decided.status} ${await decided.text()}`);
  const { redirectTo } = (await decided.json()) as { redirectTo: string };
  const code = new URL(redirectTo).searchParams.get("code") ?? "";
  const { res, json } = await token(t, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  if (res.status !== 200) throw new Error(`token: ${res.status} ${JSON.stringify(json)}`);
  return {
    clientId,
    access: String(json.access_token),
    refresh: String(json.refresh_token),
    expiresIn: Number(json.expires_in),
    redirectUri,
  };
}

/** A raw JSON-RPC call on `/mcp` (the 2025 protocol needs no session here: the endpoint is stateless). */
export async function mcp(t: TestServer, bearer: string | null, body: unknown, headers: Record<string, string> = {}) {
  const res = await t.app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return res;
}

let rpcId = 0;
/** `tools/call` over the 2025 protocol, the tool's result. */
export async function callTool(t: TestServer, bearer: string, name: string, args: Record<string, unknown>) {
  const res = await mcp(t, bearer, {
    jsonrpc: "2.0",
    id: ++rpcId,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const json = (await res.json()) as {
    result?: { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
    error?: { code: number; message: string };
  };
  if (!json.result) throw new Error(`tools/call ${name}: ${res.status} ${JSON.stringify(json)}`);
  return json.result;
}
