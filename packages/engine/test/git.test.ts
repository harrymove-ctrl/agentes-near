import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { deflateSync, gzipSync } from "node:zlib";
import {
  DELETE_BRANCHES_POINTER,
  NO_TERMINAL_COMMANDS,
  otherBranchPointer,
} from "@agenteschat/adapters/command-policy";
import { and, eq, schema } from "@agenteschat/db";
import {
  agentCommitEmail,
  ConflictError,
  type ConnectorDeps,
  connectorGrantValidator,
  createApiKeyConnection,
  createGitToolSource,
  createToolGateway,
  decideApproval,
  drainOutbox,
  type GitHubAppConfig,
  type GitProxyDeps,
  getAgentAccess,
  handleGitProxy,
  type InvokeResult,
  inflateZlib,
  insertMessage,
  issueGitToken,
  machineGitGen,
  parseReceivePackRequest,
  pkt,
  postPersonMessage,
  pushGrantKey,
  pushGrants,
  type RoutineBrief,
  readPack,
  refRule,
  removeApprovalRule,
  SIGNATURE_MARK,
  setAgentAccess,
  setAgentComputerTarget,
  setAgentHold,
  setAgentRepositories,
  setAgentScopes,
  setOrgStanding,
  type ToolContext,
  verifyGitToken,
  ZERO_OID,
} from "../src";
import { readBody } from "../src/git/proxy";
import { type Fixture, SECRET, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const GH_TOKEN = "ghp_secret_123456";
const PUBLIC_URL = "https://agentes.test";

// ── Building packs like git does ─────────────────────────────────────────────

const sha1 = (type: string, data: Uint8Array) =>
  createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

/** `late`: `parent` lines after the committer, a header git ignores (to git, those aren't parents). */
function commitObject(parents: string[], message: string, late: string[] = []) {
  const data = enc(
    [
      `tree ${"4b825dc642cb6eb9a060e54bf8d69288fbee4904"}`,
      ...parents.map((p) => `parent ${p}`),
      "author Dev (agentes) <dev@agents.agentes.chat> 1760000000 +0000",
      "committer Dev (agentes) <dev@agents.agentes.chat> 1760000000 +0000",
      ...late.map((p) => `parent ${p}`),
      "",
      message,
      "",
    ].join("\n"),
  );
  return { type: 1, data, oid: sha1("commit", data) };
}

function blobObject(text: string) {
  const data = enc(text);
  return { type: 3, data, oid: sha1("blob", data) };
}

function packOf(objects: { type: number; data: Uint8Array }[]) {
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(12);
  header.set(enc("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, objects.length);
  parts.push(header);
  for (const o of objects) {
    let size = o.data.length;
    const bytes = [(o.type << 4) | (size & 15)];
    size = Math.floor(size / 16);
    while (size > 0) {
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) | 0x80;
      bytes.push(size & 0x7f);
      size = Math.floor(size / 128);
    }
    parts.push(new Uint8Array(bytes), new Uint8Array(deflateSync(o.data)));
  }
  const body = Buffer.concat(parts);
  return new Uint8Array(Buffer.concat([body, createHash("sha1").update(body).digest()]));
}

function pushBody(commands: { old: string; new: string; ref: string }[], pack?: Uint8Array) {
  const lines = commands
    .map((c, i) => pkt(`${c.old} ${c.new} ${c.ref}${i === 0 ? "\0report-status side-band-64k" : ""}\n`))
    .join("");
  return new Uint8Array(Buffer.concat([Buffer.from(`${lines}0000`), Buffer.from(pack ?? new Uint8Array())]));
}

describe("pack reading", () => {
  test("rejects declared objects and commits above the inflated limits", () => {
    const blob = packOf([blobObject("x".repeat(100))]);
    expect(() => readPack(blob, 0, { maxInflatedBytes: 99 })).toThrow("uncompressed size limit");
    const commit = packOf([commitObject([], "x".repeat(100))]);
    expect(() => readPack(commit, 0, { maxCommitBytes: 99 })).toThrow("commit exceeds size limit");
    const pair = packOf([blobObject("x".repeat(60)), blobObject("y".repeat(60))]);
    expect(() => readPack(pair, 0, { maxInflatedBytes: 100 })).toThrow("uncompressed size limit");
  });

  test("inflate matches zlib and reports where each stream ends", () => {
    const inputs = [
      new Uint8Array(),
      enc("hello"),
      enc("abc".repeat(10_000)),
      new Uint8Array(randomBytes(70_000)),
      enc(Array.from({ length: 3000 }, (_, i) => `line ${i % 37} ${"x".repeat(i % 50)}`).join("\n")),
    ];
    for (const input of inputs) {
      for (const level of [0, 1, 6, 9]) {
        const z = new Uint8Array(deflateSync(input, { level }));
        const glued = new Uint8Array(Buffer.concat([z, Buffer.from("TRAILING")]));
        const out = inflateZlib(glued, 0);
        expect(Buffer.from(out.data ?? []).equals(Buffer.from(input))).toBe(true);
        expect(out.end).toBe(z.length);
        expect(inflateZlib(glued, 0, { keep: false }).end).toBe(z.length);
      }
    }
  });

  test("commits and parents from a pack, and the push commands before it", () => {
    const a = commitObject([], "first");
    const b = commitObject([a.oid], "second");
    const blob = blobObject("console.log(1)\n".repeat(500));
    const pack = packOf([a, blob, b]);
    const read = readPack(pack);
    expect(read.objects).toBe(3);
    expect(read.commits).toEqual([
      { oid: a.oid, parents: [] },
      { oid: b.oid, parents: [a.oid] },
    ]);
    const body = pushBody([{ old: ZERO_OID, new: b.oid, ref: "refs/heads/agentes/dev/x" }], pack);
    const parsed = parseReceivePackRequest(body);
    expect(parsed.commands).toEqual([{ oldOid: ZERO_OID, newOid: b.oid, ref: "refs/heads/agentes/dev/x" }]);
    expect(parsed.capabilities).toEqual(["report-status", "side-band-64k"]);
    expect(readPack(body, parsed.packStart).commits).toHaveLength(2);
  });

  test("ref rules: agentes/{handle}/… goes, another existing branch needs a grant; no tags, deletes or new branches", () => {
    const c = (ref: string, newOid = "a".repeat(40), oldOid = ZERO_OID) => ({ oldOid, newOid, ref });
    const old = "b".repeat(40);
    expect(refRule(c("refs/heads/agentes/dev/fix-login"), "dev")).toEqual({ ok: true });
    expect(refRule(c("refs/heads/main", "a".repeat(40), old), "dev")).toEqual({ grant: "main" });
    expect(refRule(c("refs/heads/agentes/qa/x", "a".repeat(40), old), "dev")).toEqual({ grant: "agentes/qa/x" });
    expect(refRule(c("refs/heads/main"), "dev")).toMatchObject({ kind: "create" });
    expect(refRule(c("refs/heads/agentes/dev/"), "dev")).toMatchObject({ kind: "ref" });
    expect(refRule(c("refs/notes/commits"), "dev")).toMatchObject({ kind: "ref" });
    expect(refRule(c("refs/tags/v1"), "dev")).toMatchObject({ kind: "tag" });
    // Deleting goes through delete_branches, the agent's own branches too.
    expect(refRule(c("refs/heads/agentes/dev/x", ZERO_OID, old), "dev")).toMatchObject({ kind: "delete" });
    expect(refRule(c("refs/heads/ana/fix", ZERO_OID, old), "dev")).toMatchObject({ kind: "delete" });
  });

  test("the computer credential: valid, tampered, expired", () => {
    const claims = { orgId: "o", agentId: "a", sandboxId: "s", gen: 0, exp: Math.floor(Date.now() / 1000) + 60 };
    const token = issueGitToken(SECRET, claims);
    expect(verifyGitToken(SECRET, token)).toEqual(claims);
    expect(verifyGitToken(SECRET, `${token}x`)).toBeNull();
    expect(verifyGitToken("another-secret".padEnd(48, "y"), token)).toBeNull();
    expect(verifyGitToken(SECRET, token, new Date(Date.now() + 120_000))).toBeNull();
  });
});

test("git request body stops reading once it exceeds the limit", async () => {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      controller.enqueue(new Uint8Array(4));
    },
  });
  const req = new Request("https://agentes.test/api/git", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  expect(await readBody(req, 10)).toBeNull();
  expect(reads).toBeLessThan(10);
});

test("git request rejects compressed bodies above the expanded limit", async () => {
  const req = new Request("https://agentes.test/api/git", {
    method: "POST",
    headers: { "content-encoding": "gzip" },
    body: gzipSync(Buffer.alloc(2048)),
  });
  expect(await readBody(req, 1024)).toBeNull();
});

// ── The proxy against a fake GitHub ──────────────────────────────────────────

/** A branch on the fake GitHub: classic protection and the types of the ruleset rules that apply to it. */
type FakeBranch = { protected?: boolean; rules?: string[] };

function fakeGitHub(
  options: {
    compare?: Record<string, string>;
    /** acme/app's branches (`/branches`, `/rules/branches`, deleting a ref). */
    branches?: Record<string, FakeBranch>;
    defaultBranch?: string;
    /** Branch questions go unanswered. */
    down?: boolean;
    /** Branches GitHub won't delete (422). */
    keep?: string[];
    /** Our GitHub App on acme (installation 5), without these permissions (asking for one is a 422). */
    app?: { lacks: string[] };
  } = {},
) {
  const calls: { url: string; method: string; auth: string | null; body: number; text?: string }[] = [];
  const apiUrl = "https://api.github.test";
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body ? ((init.body as Uint8Array).byteLength ?? 0) : 0;
    const text = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization"), body, text });
    if (options.app && /\/repos\/acme\/[^/]+\/installation$/.test(url)) return Response.json({ id: 5 });
    if (options.app && url.endsWith("/app/installations/5/access_tokens")) {
      const asked = Object.keys((JSON.parse(text ?? "{}") as { permissions?: object }).permissions ?? {});
      if (asked.some((p) => options.app?.lacks.includes(p))) return Response.json({ message: "no" }, { status: 422 });
      return Response.json({ token: "ghs_app", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    const api = url.startsWith(`${apiUrl}/repos/acme/app/`) ? url.slice(`${apiUrl}/repos/acme/app/`.length) : "";
    const named = (prefix: string) =>
      api.startsWith(prefix) ? api.slice(prefix.length).split("/").map(decodeURIComponent).join("/") : null;
    const branch = named("branches/");
    const rules = named("rules/branches/");
    const ref = named("git/refs/heads/");
    const branches = options.branches ?? {};
    if ((branch !== null || rules !== null) && options.down) return new Response("unavailable", { status: 503 });
    if (branch !== null) {
      const b = branches[branch];
      return b ? Response.json({ name: branch, protected: b.protected === true }) : new Response("{}", { status: 404 });
    }
    if (rules !== null) return Response.json((branches[rules]?.rules ?? []).map((type) => ({ type })));
    if (ref !== null && init?.method === "DELETE") {
      if (!branches[ref] || options.keep?.includes(ref)) return Response.json({ message: "no" }, { status: 422 });
      delete branches[ref];
      return new Response(null, { status: 204 });
    }
    if (url.includes("/info/refs")) {
      return new Response("001e# service=git-upload-pack\n0000", {
        headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      });
    }
    if (url.endsWith("/git-upload-pack"))
      return new Response("0008NAK\n", { headers: { "content-type": "application/x-git-upload-pack-result" } });
    if (url.endsWith("/git-receive-pack"))
      return new Response("000eunpack ok\n0000", {
        headers: { "content-type": "application/x-git-receive-pack-result" },
      });
    const compare = /\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(url);
    if (compare) return Response.json({ status: options.compare?.[`${compare[1]}...${compare[2]}`] ?? "diverged" });
    if (url.endsWith("/repos/acme/app")) return Response.json({ default_branch: options.defaultBranch ?? "main" });
    if (url.endsWith("/repos/acme/app/pulls") && init?.method === "POST") {
      return Response.json({ number: 7, html_url: "https://github.com/acme/app/pull/7" }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, gitUrl: "https://github.test", apiUrl, options };
}

async function world(scopes: string[] = ["github:git.read", "github:git.write"], github = fakeGitHub()) {
  f = await setup();
  const connectors: ConnectorDeps = { db: f.db, keyWrappers: [f.keyWrapper], publicUrl: PUBLIC_URL };
  const connection = await createApiKeyConnection(connectors, f.owner.id, f.org.id, {
    connector: "github",
    apiKey: GH_TOKEN,
  });
  await setAgentScopes(
    f.db,
    f.owner.id,
    f.org.id,
    f.agent.id,
    scopes.map((scope) => ({ connectionId: connection.id, scope })),
    connectorGrantValidator,
  );
  // The agent on a connected computer, with the credential issued to it (ADR 0024 addendum).
  const m = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Mac" });
  await setAgentComputerTarget({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id, m.machineId);
  const [row] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, m.machineId));
  const deps: GitProxyDeps = { db: f.db, secret: SECRET, connectors, upstream: github };
  const token = issueGitToken(SECRET, {
    orgId: f.org.id,
    agentId: f.agent.id,
    sandboxId: m.machineId,
    gen: machineGitGen(row?.tokenHash ?? ""),
    exp: Math.floor(Date.now() / 1000) + 3600,
    kind: "machine",
  });
  const auth = `Basic ${Buffer.from(`agentes:${token}`).toString("base64")}`;
  const call = (
    path: string,
    init: {
      method?: string;
      body?: Uint8Array;
      auth?: string | null;
      query?: string;
      limits?: GitProxyDeps["limits"];
    } = {},
  ) =>
    handleGitProxy(
      init.limits ? { ...deps, limits: init.limits } : deps,
      new Request(`${PUBLIC_URL}/api/git/${f.org.id}/${connection.id}/${path}${init.query ?? ""}`, {
        method: init.method ?? "GET",
        headers: {
          ...(init.auth === null ? {} : { authorization: init.auth ?? auth }),
          ...(init.body ? { "content-type": "application/x-git-receive-pack-request" } : {}),
        },
        body: init.body,
      }),
      { orgId: f.org.id, connectionId: connection.id, path },
    );
  return { connection, connectors, machine: m, github, deps, call, token };
}

const audits = async (action: string) =>
  f.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, action)));

describe("git proxy", () => {
  test("clone: our credential in, GitHub's token added only upstream, audited", async () => {
    const w = await world(["github:git.read"]);
    expect((await w.call("acme/app.git/info/refs", { query: "?service=git-upload-pack", auth: null })).status).toBe(
      401,
    );
    const refs = await w.call("acme/app.git/info/refs", { query: "?service=git-upload-pack" });
    expect(refs.status).toBe(200);
    expect(await refs.text()).toContain("service=git-upload-pack");
    const fetched = await w.call("acme/app.git/git-upload-pack", {
      method: "POST",
      body: enc("0032want abc\n00000009done\n"),
    });
    expect(await fetched.text()).toBe("0008NAK\n");
    expect(w.github.calls.map((c) => [c.method, c.url.replace(w.github.gitUrl, "")])).toEqual([
      ["GET", "/acme/app.git/info/refs?service=git-upload-pack"],
      ["POST", "/acme/app.git/git-upload-pack"],
    ]);
    const basic = `Basic ${Buffer.from(`x-access-token:${GH_TOKEN}`).toString("base64")}`;
    expect(w.github.calls.every((c) => c.auth === basic)).toBe(true);
    expect(await audits("git.fetch")).toHaveLength(1);
    // Read-only: no push, not even the advertisement.
    expect((await w.call("acme/app.git/info/refs", { query: "?service=git-receive-pack" })).status).toBe(403);
  });

  test("a connection dropped mid-transfer answers git with a 503, and anything else still throws", async () => {
    const w = await world(["github:git.read"]);
    const fails = (error: Error) => ({
      ...w.deps,
      upstream: { ...w.github, fetch: (async () => Promise.reject(error)) as unknown as typeof fetch },
    });
    const ask = (deps: GitProxyDeps) =>
      handleGitProxy(
        deps,
        new Request(
          `${PUBLIC_URL}/api/git/${f.org.id}/${w.connection.id}/acme/app.git/info/refs?service=git-upload-pack`,
          { headers: { authorization: `Basic ${Buffer.from(`agentes:${w.token}`).toString("base64")}` } },
        ),
        { orgId: f.org.id, connectionId: w.connection.id, path: "acme/app.git/info/refs" },
      );
    const reset = await ask(fails(new TypeError("ECONNRESET: The socket connection was closed unexpectedly.")));
    expect(reset.status).toBe(503);
    const aborted = await ask(fails(Object.assign(new Error("The connection was closed."), { name: "AbortError" })));
    expect(aborted.status).toBe(503);
    expect(ask(fails(new Error("a bug of ours")))).rejects.toThrow("a bug of ours");
  });

  test("push: only agentes/{handle}/*, fast-forward, no tags; refused pushes never reach GitHub", async () => {
    const w = await world();
    const a = commitObject([], "base");
    const b = commitObject([a.oid], "work");

    const toMain = await w.call("acme/app.git/git-receive-pack", {
      method: "POST",
      body: pushBody([{ old: ZERO_OID, new: b.oid, ref: "refs/heads/main" }], packOf([a, b])),
    });
    expect(toMain.status).toBe(200);
    const report = await toMain.text();
    expect(report).toContain("ng refs/heads/main");
    expect(report).toContain("agentes/dev/");
    const tag = await w.call("acme/app.git/git-receive-pack", {
      method: "POST",
      body: pushBody([{ old: ZERO_OID, new: b.oid, ref: "refs/tags/v1" }], packOf([a, b])),
    });
    expect(await tag.text()).toContain("ng refs/tags/v1");
    expect(w.github.calls.filter((c) => c.url.endsWith("git-receive-pack"))).toHaveLength(0);
    expect(await audits("git.push_refused")).toHaveLength(2);

    // A new branch of its own: goes through, audited with the commit count.
    const created = await w.call("acme/app.git/git-receive-pack", {
      method: "POST",
      body: pushBody([{ old: ZERO_OID, new: b.oid, ref: "refs/heads/agentes/dev/fix" }], packOf([a, b])),
    });
    expect(await created.text()).toContain("unpack ok");
    const [pushed] = await audits("git.push");
    expect(pushed?.details).toMatchObject({ commits: 2, refs: [{ ref: "refs/heads/agentes/dev/fix", to: b.oid }] });

    // Fast-forward on top of it: fine.
    const c = commitObject([b.oid], "more");
    const ff = await w.call("acme/app.git/git-receive-pack", {
      method: "POST",
      body: pushBody([{ old: b.oid, new: c.oid, ref: "refs/heads/agentes/dev/fix" }], packOf([c])),
    });
    expect(await ff.text()).toContain("unpack ok");

    // A rewritten history (force push): its new commits don't lead to the old tip, and GitHub says diverged.
    const rewritten = commitObject([a.oid], "rewritten");
    const force = await w.call("acme/app.git/git-receive-pack", {
      method: "POST",
      body: pushBody([{ old: c.oid, new: rewritten.oid, ref: "refs/heads/agentes/dev/fix" }], packOf([rewritten])),
    });
    expect(await force.text()).toContain("not a fast-forward");
    expect(w.github.calls.filter((x) => x.url.endsWith("git-receive-pack"))).toHaveLength(2);
  });

  test("policy: scope, repository list, revoked or foreign credentials, size limit", async () => {
    const w = await world(["github:git.read"]);
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app"]);
    expect((await w.call("acme/app.git/info/refs", { query: "?service=git-upload-pack" })).status).toBe(200);
    const outside = await w.call("acme/other.git/info/refs", { query: "?service=git-upload-pack" });
    expect(outside.status).toBe(403);
    expect(await outside.text()).toContain("acme/other isn't one of");
    // A whole account: every repository of it.
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/*"]);
    expect((await w.call("acme/other.git/info/refs", { query: "?service=git-upload-pack" })).status).toBe(200);
    expect((await w.call("beta/other.git/info/refs", { query: "?service=git-upload-pack" })).status).toBe(403);
    expect((await w.call("acme/app.git/info/refs", { query: "?service=git-receive-pack" })).status).toBe(403);

    const big = await handleGitProxy(
      { ...w.deps, limits: { fetchRequestBytes: 10 } },
      new Request(`${PUBLIC_URL}/x`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`agentes:${w.token}`).toString("base64")}` },
        body: enc("0032want abc\n0000"),
      }),
      { orgId: f.org.id, connectionId: w.connection.id, path: "acme/app.git/git-upload-pack" },
    );
    expect(big.status).toBe(413);

    // Another org's path with this credential: refused.
    const other = await handleGitProxy(
      w.deps,
      new Request(`${PUBLIC_URL}/x?service=git-upload-pack`, {
        headers: { authorization: `Basic ${Buffer.from(`agentes:${w.token}`).toString("base64")}` },
      }),
      { orgId: crypto.randomUUID(), connectionId: w.connection.id, path: "acme/app.git/info/refs" },
    );
    expect(other.status).toBe(401);

    // The agent off its computer: revoked; back on it, it works again.
    const deps = { db: f.db, pubsub: f.pubsub };
    await setAgentComputerTarget(deps, f.owner.id, f.org.id, f.agent.id, null);
    expect((await w.call("acme/app.git/info/refs", { query: "?service=git-upload-pack" })).status).toBe(401);
    await setAgentComputerTarget(deps, f.owner.id, f.org.id, f.agent.id, w.machine.machineId);
    expect((await w.call("acme/app.git/info/refs", { query: "?service=git-upload-pack" })).status).toBe(200);

    // Without any git scope: refused.
    await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, []);
    const noScope = await w.call("acme/app.git/info/refs", { query: "?service=git-upload-pack" });
    expect(noScope.status).toBe(403);
  });

  test("standing: a workspace on hold or suspended, or a held agent, gets no git through us", async () => {
    const w = await world();
    const refs = () => w.call("acme/app.git/info/refs", { query: "?service=git-upload-pack" });
    const standing = (state: "active" | "hold" | "suspended") =>
      setOrgStanding({ db: f.db, pubsub: f.pubsub }, f.org.id, { state, reason: "Review", notice: "silent" });
    expect((await refs()).status).toBe(200);
    for (const state of ["hold", "suspended"] as const) {
      await standing(state);
      const refused = await refs();
      expect(refused.status).toBe(403);
      expect(await refused.text()).not.toContain("Review");
      await standing("active");
    }
    await setAgentHold(f.db, f.org.id, f.agent.id, { held: true, reason: "Spam" });
    const held = await refs();
    expect(held.status).toBe(403);
    expect(await held.text()).toBe("agentes: This agent is paused for now.\n");
    await setAgentHold(f.db, f.org.id, f.agent.id, { held: false, reason: null });
    expect((await refs()).status).toBe(200);
    // Refused before anything reached GitHub.
    expect(w.github.calls).toHaveLength(2);
  });
});

// ── Branches that aren't the agent's own: delete_branches and request_branch_push ────────────────────────────

const WHY = "These branches were merged weeks ago and nobody pushed to them since: the list reads better without them.";

/** The git tools behind the Tool Gateway on the world's fake GitHub, and a run to call them in (a person's or a routine's). */
async function toolsOf(w: Awaited<ReturnType<typeof world>>, routine?: RoutineBrief) {
  const gateway = createToolGateway({
    sources: [
      createGitToolSource({
        sandbox: {} as never,
        connectors: w.connectors,
        github: { apiUrl: w.github.apiUrl, fetch: w.github.fetch },
      }),
    ],
  });
  const msg = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "@dev limpa as branches velhas da acme/app",
    meta: routine ? { routineBrief: routine, background: true } : {},
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      background: Boolean(routine),
    })
    .returning();
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run?.id ?? "",
    channelId: f.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
  let seq = 0;
  const invoke = (name: string, input: Record<string, unknown>) =>
    gateway.invoke(ctx, { toolUseId: `call-${++seq}`, name, input });
  const decide = (approvalId: string, always = false) =>
    decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approvalId, {
      decision: "approve",
      ...(always ? { always } : {}),
    });
  /** Runs an approved request as the resumed run does. */
  const runApproved = async (approvalId: string) => {
    const [row] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
    if (!row) throw new Error("no approval");
    return gateway.executeApproved(ctx, row);
  };
  return { gateway, ctx, invoke, decide, runApproved };
}

function asked(result: InvokeResult) {
  if (result.type !== "approval") throw new Error(`expected an approval, got ${JSON.stringify(result)}`);
  return result.approval;
}
function answered(result: InvokeResult) {
  if (result.type !== "result") throw new Error(`expected a result, got ${result.type}`);
  return result.output;
}
const deletes = (w: Awaited<ReturnType<typeof world>>) =>
  w.github.calls
    .filter((c) => c.method === "DELETE")
    .map((c) => c.url.replace(`${w.github.apiUrl}/repos/acme/app/`, ""));
const receivePacks = (w: Awaited<ReturnType<typeof world>>) =>
  w.github.calls.filter((c) => c.url.endsWith("git-receive-pack")).length;

describe("branches that aren't the agent's own", () => {
  test("proxy: deleting is refused with the pointer to delete_branches, said once for 7 refs; nothing reaches GitHub", async () => {
    const w = await world();
    const old = "c".repeat(40);
    const refs = Array.from({ length: 7 }, (_, i) => `refs/heads/old-${i + 1}`);
    const res = await w.call("acme/app.git/git-receive-pack", {
      method: "POST",
      body: pushBody(refs.map((ref) => ({ old, new: ZERO_OID, ref }))),
    });
    const report = await res.text();
    expect(report.split(`agentes: ${DELETE_BRANCHES_POINTER}`)).toHaveLength(2);
    expect(DELETE_BRANCHES_POINTER).toContain("Ask with delete_branches (repo, branches, why)");
    expect(DELETE_BRANCHES_POINTER).toContain("Never give the person a terminal command to run.");
    expect(report.split(NO_TERMINAL_COMMANDS)).toHaveLength(2);
    for (const ref of refs) expect(report).toContain(`ng ${ref} branches are deleted with delete_branches`);
    const [refused] = await audits("git.push_refused");
    expect(refused?.details.refs).toEqual(refs);
    // More refs than one push may carry: refused before any is looked up.
    const many = await w.call("acme/app.git/git-receive-pack", {
      method: "POST",
      body: pushBody(refs.map((ref) => ({ old, new: ZERO_OID, ref }))),
      limits: { maxCommands: 6 },
    });
    expect(many.status).toBe(413);
    expect(await many.text()).toBe("agentes: a push may update at most 6 refs at once\n");
    expect(receivePacks(w)).toBe(0);
    expect(await audits("git.push_refused")).toHaveLength(1);
  });

  test("proxy: someone else's branch waits for a person, then goes for 24 h, for that agent, repository and branch only", async () => {
    const w = await world(undefined, fakeGitHub({ branches: { "ana/fix": {}, "bob/x": {} } }));
    const t = await toolsOf(w);
    const a = commitObject([], "base");
    const b = commitObject([a.oid], "fix");
    const push = async (ref: string) =>
      (
        await w.call("acme/app.git/git-receive-pack", {
          method: "POST",
          body: pushBody([{ old: a.oid, new: b.oid, ref }], packOf([b])),
        })
      ).text();

    const before = await push("refs/heads/ana/fix");
    expect(before).toContain(`agentes: ${otherBranchPointer(["ana/fix"], "dev")}`);
    expect(otherBranchPointer(["ana/fix"], "dev")).toBe(
      "ana/fix isn't your branch (yours: agentes/dev/…). To push there, ask with request_branch_push (repo, branch, why); once a person approves, push again. Or push to agentes/dev/<topic> and open a pull request. Never give the person a terminal command to run.",
    );
    expect(before).toContain("ng refs/heads/ana/fix not your branch (ask with request_branch_push)");

    const request = asked(await t.invoke("request_branch_push", { repo: "acme/app", branch: "ana/fix", why: WHY }));
    expect(request).toMatchObject({
      title: "Enviar para ana/fix em acme/app (24 h, sem force push)",
      scope: "github:git.write",
      approveAlways: { tool: "request_branch_push", actions: ["acme/app:ana/fix"] },
    });
    // Asking alone lets nothing through.
    expect(await push("refs/heads/ana/fix")).toContain("not your branch");
    await t.decide(request.id);
    expect((await t.runApproved(request.id)).content).toBe(
      "Approved: push to ana/fix in acme/app again now with git (fast-forward only, no force push).",
    );
    expect(await push("refs/heads/ana/fix")).toContain("unpack ok");
    const [pushed] = await audits("git.push");
    expect(pushed?.details.grants).toEqual({ "refs/heads/ana/fix": { approvalId: request.id } });

    // Another branch still asks; the grant is this agent's, for this repository, in any case.
    expect(await push("refs/heads/bob/x")).toContain("bob/x isn't your branch");
    const at = { orgId: f.org.id, agentId: f.agent.id, connectionId: w.connection.id };
    const now = new Date();
    const key = pushGrantKey({ owner: "Acme", repo: "App" }, "ana/fix");
    expect(key).toBe("acme/app:ana/fix");
    const grants = await pushGrants(f.db, at, [key, "acme/other:ana/fix", "acme/app:ana/Fix"], now);
    expect([...grants]).toEqual([[key, { approvalId: request.id }]]);
    expect((await pushGrants(f.db, { ...at, agentId: crypto.randomUUID() }, [key], now)).size).toBe(0);

    // An hour after the decision it still goes; a day and an hour after, it doesn't.
    const decidedAgo = (hours: number) =>
      f.db
        .update(schema.approvals)
        .set({ decidedAt: new Date(Date.now() - hours * 3600_000) })
        .where(eq(schema.approvals.id, request.id));
    await decidedAgo(1);
    expect(await push("refs/heads/ana/fix")).toContain("unpack ok");
    await decidedAgo(25);
    expect(await push("refs/heads/ana/fix")).toContain("ana/fix isn't your branch");
    expect(receivePacks(w)).toBe(2);
  });

  test("proxy: Aprovar sempre lets the agent push there with no card, until someone removes the rule", async () => {
    const w = await world(undefined, fakeGitHub({ branches: { "release-x": {}, "ana/fix": {} } }));
    const t = await toolsOf(w);
    const a = commitObject([], "base");
    const b = commitObject([a.oid], "fix");
    const push = async () =>
      (
        await w.call("acme/app.git/git-receive-pack", {
          method: "POST",
          body: pushBody([{ old: a.oid, new: b.oid, ref: "refs/heads/release-x" }], packOf([b])),
        })
      ).text();
    // The name checks for connector actions (release, deploy…) don't apply to a branch: it can be remembered.
    const request = asked(await t.invoke("request_branch_push", { repo: "acme/app", branch: "release-x", why: WHY }));
    expect(request.approveAlways).toEqual({ tool: "request_branch_push", actions: ["acme/app:release-x"] });
    await t.decide(request.id, true);
    const [rule] = await f.db.select().from(schema.approvalRules);
    expect(rule).toMatchObject({
      agentId: f.agent.id,
      connectionId: w.connection.id,
      tool: "request_branch_push",
      action: "acme/app:release-x",
      createdByUserId: f.owner.id,
    });
    // Approved more than a day ago, the rule still lets it go.
    const decidedAgo = (hours: number) =>
      f.db
        .update(schema.approvals)
        .set({ decidedAt: new Date(Date.now() - hours * 3600_000) })
        .where(eq(schema.approvals.id, request.id));
    await decidedAgo(48);
    expect(await push()).toContain("unpack ok");
    const [pushed] = await audits("git.push");
    expect(pushed?.details.grants).toEqual({ "refs/heads/release-x": { ruleId: rule?.id } });
    // Turned off for the agent, by the name its access lists, the rule lets nothing through; back on, it does.
    const listed = (await getAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id)).connectors.flatMap((c) =>
      c.scopes.flatMap((s) => s.tools.map((tool) => tool.name)),
    );
    expect(listed).toEqual(expect.arrayContaining(["git_clone", "delete_branches", "request_branch_push"]));
    const denying = (deny: string[]) =>
      setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, {
        all: false,
        connectors: {},
        scopes: ["github:git.read", "github:git.write"].map((scope) => ({ connectionId: w.connection.id, scope })),
        tools: { allow: [], deny: deny.map((name) => ({ connectionId: w.connection.id, name })) },
      });
    await denying(["request_branch_push"]);
    expect(await push()).toContain("release-x isn't your branch");
    await denying([]);
    expect(await push()).toContain("unpack ok");
    // Asking again runs with no card; another branch asks.
    const again = answered(await t.invoke("request_branch_push", { repo: "acme/app", branch: "release-x" }));
    expect(again.content).toContain("Approved: push to release-x");
    asked(await t.invoke("request_branch_push", { repo: "acme/app", branch: "ana/fix", why: WHY }));
    expect(await f.db.select().from(schema.approvals)).toHaveLength(2);

    // Removed, it asks again at once: the approval the rule came from, an hour old, doesn't let it push either.
    await decidedAgo(1);
    await removeApprovalRule(f.db, f.owner.id, f.org.id, f.agent.id, rule?.id ?? "");
    expect(await push()).toContain("release-x isn't your branch");
    const [removed] = await audits("agent.approval_rule_removed");
    expect(removed?.details).toMatchObject({ tool: "request_branch_push", action: "acme/app:release-x" });
    // A person's approval after the removal does.
    const later = asked(await t.invoke("request_branch_push", { repo: "acme/app", branch: "release-x", why: WHY }));
    await t.decide(later.id);
    expect(await push()).toContain("unpack ok");
  });

  test("proxy: granted, still refused for the default branch, a protected one, a new branch, a force push or no answer", async () => {
    const github = fakeGitHub({ branches: { main: {}, "ana/fix": {} } });
    const w = await world(undefined, github);
    const rule = (branch: string) => ({
      orgId: f.org.id,
      agentId: f.agent.id,
      connectionId: w.connection.id,
      tool: "request_branch_push",
      action: `acme/app:${branch}`,
    });
    await f.db.insert(schema.approvalRules).values([rule("main"), rule("ana/fix")]);
    const a = commitObject([], "base");
    const b = commitObject([a.oid], "fix");
    const push = async (ref: string, old = a.oid, next = b) =>
      (
        await w.call("acme/app.git/git-receive-pack", {
          method: "POST",
          body: pushBody([{ old, new: next.oid, ref }], packOf([next])),
        })
      ).text();
    expect(await push("refs/heads/main")).toContain(
      "agentes: main is the default branch: push to agentes/dev/<topic> and open a pull request; merging asks a person",
    );
    github.options.branches = { main: {}, "ana/fix": { protected: true } };
    expect(await push("refs/heads/ana/fix")).toContain("ng refs/heads/ana/fix protected");
    github.options.branches = { main: {}, "ana/fix": { rules: ["pull_request"] } };
    expect(await push("refs/heads/ana/fix")).toContain("ana/fix is protected");
    github.options.branches = { main: {} };
    expect(await push("refs/heads/ana/fix")).toContain("ana/fix isn't on GitHub");
    expect(await push("refs/heads/ana/fix", ZERO_OID)).toContain("agents create only branches agentes/dev/…");
    // Rules about deleting and force pushing don't guard an update: this one goes.
    github.options.branches = { main: {}, "ana/fix": { rules: ["deletion", "non_fast_forward"] } };
    expect(await push("refs/heads/ana/fix")).toContain("unpack ok");
    const rewritten = commitObject([], "rewritten");
    const force = await push("refs/heads/ana/fix", b.oid, rewritten);
    expect(force).toContain("not a fast-forward");
    expect(force.split(`agentes: ${NO_TERMINAL_COMMANDS}`)).toHaveLength(2);
    // A root commit with a `parent` line after its committer: git reads no parent there, so it's a force push too.
    expect(await push("refs/heads/ana/fix", b.oid, commitObject([], "forged", [b.oid]))).toContain(
      "not a fast-forward",
    );
    github.options.down = true;
    expect(await push("refs/heads/ana/fix")).toContain("GitHub didn't say whether ana/fix is protected");
    expect(receivePacks(w)).toBe(1);
  });

  test("delete_branches: one card for the whole batch, never Aprovar sempre; deleted only once a person approves", async () => {
    const names = ["old-1", "old-2", "old-3", "old-4", "old-5", "old-6", "guarded"];
    const w = await world(
      undefined,
      fakeGitHub({
        branches: {
          ...Object.fromEntries(names.map((n) => [n, {}])),
          guarded: { rules: ["pull_request", "non_fast_forward"] },
          main: {},
          release: { protected: true },
          keep: { rules: ["deletion"] },
        },
      }),
    );
    const t = await toolsOf(w);
    // The default branch, a protected one (classic or a ruleset's deletion rule) and a missing one: refused before
    // any card, naming them all.
    const refused = answered(
      await t.invoke("delete_branches", {
        repo: "acme/app",
        branches: ["old-1", "main", "release", "keep", "gone"],
        why: WHY,
      }),
    );
    expect(refused.isError).toBe(true);
    expect(refused.content).toBe(
      "Refused, nothing was asked or deleted: main (the default branch), release (protected), keep (protected), gone (not on GitHub). The default branch and protected branches are never deleted. Ask again without them.",
    );
    expect(
      answered(await t.invoke("delete_branches", { repo: "acme/app", branches: ["a", "a"], why: WHY })).content,
    ).toBe("Named more than once: a. Name each branch once.");
    expect(
      answered(await t.invoke("delete_branches", { repo: "acme/app", branches: ["refs/heads/x"], why: WHY })).content,
    ).toContain("Not branch names: refs/heads/x");
    // Names the card would cut: the person must see every branch it deletes.
    const long = Array.from({ length: 11 }, (_, i) => `agentes/dev/${"x".repeat(180)}-${i}`);
    expect(answered(await t.invoke("delete_branches", { repo: "acme/app", branches: long, why: WHY })).content).toBe(
      "These names don't fit on one card. Ask in smaller batches.",
    );
    expect(await f.db.select().from(schema.approvals)).toEqual([]);

    const request = asked(await t.invoke("delete_branches", { repo: "acme/app", branches: names, why: WHY }));
    expect(request).toMatchObject({
      title: "Apagar 7 branches em acme/app",
      detail: names.join("\n"),
      scope: "github:git.write",
      approveAlways: null,
    });
    expect(deletes(w)).toEqual([]);
    await expect(t.decide(request.id, true)).rejects.toBeInstanceOf(ConflictError);
    await t.decide(request.id);
    const out = await t.runApproved(request.id);
    expect(out).toMatchObject({ content: `Deleted on GitHub: ${names.join(", ")}.` });
    expect(out.isError).toBeUndefined();
    expect(deletes(w)).toEqual(names.map((n) => `git/refs/heads/${n}`));
    expect(w.github.calls.filter((c) => c.method === "DELETE").every((c) => c.auth === `Bearer ${GH_TOKEN}`)).toBe(
      true,
    );
    const calls = (await audits("tool.call"))
      .filter((r) => r.targetId === "delete_branches")
      .sort((x, y) => x.id.localeCompare(y.id));
    expect(calls.map((r) => [r.outcome, r.details.approvalId ?? null])).toEqual([
      ["refused", null],
      ["refused", null],
      ["refused", null],
      ["refused", null],
      ["pending", request.id],
      ["done", request.id],
    ]);
    expect(calls.at(-1)?.details.input).toEqual({ repo: "acme/app", branches: names });
  });

  test("delete_branches: checked again right before deleting; a partial delete says which and counts as failed", async () => {
    const github = fakeGitHub({ branches: { a: {}, b: {}, c: {} }, keep: ["c"] });
    const w = await world(undefined, github);
    const t = await toolsOf(w);
    const first = asked(await t.invoke("delete_branches", { repo: "acme/app", branches: ["a", "b"], why: WHY }));
    await t.decide(first.id);
    github.options.branches = { a: {}, b: { protected: true }, c: {} };
    expect(await t.runApproved(first.id)).toMatchObject({
      isError: true,
      content: expect.stringContaining("b (protected)"),
    });
    expect(deletes(w)).toEqual([]);

    const second = asked(await t.invoke("delete_branches", { repo: "acme/app", branches: ["a", "c"], why: WHY }));
    await t.decide(second.id);
    const out = await t.runApproved(second.id);
    expect(out).toMatchObject({
      isError: true,
      content: "Deleted on GitHub: a.\nNot deleted: c (GitHub answered 422).",
      data: { deleted: ["a"], failed: ["c (GitHub answered 422)"] },
    });
    const [last] = (await audits("tool.call")).filter(
      (r) => r.details.approvalId === second.id && r.outcome !== "pending",
    );
    expect(last?.outcome).toBe("failed");
    expect(last?.details.reason).toContain("Not deleted: c (GitHub answered 422)");
  });

  test("request_branch_push: refused for its own, a missing, the default or a protected branch; a routine never remembers", async () => {
    const w = await world(undefined, fakeGitHub({ branches: { main: {}, rel: { protected: true }, "ana/fix": {} } }));
    const t = await toolsOf(w);
    const refusal = async (branch: string) =>
      answered(await t.invoke("request_branch_push", { repo: "acme/app", branch, why: WHY })).content;
    expect(await refusal("agentes/dev/x")).toBe("agentes/dev/x is your own branch: just push to it, nothing to ask.");
    expect(await refusal("nope")).toBe(
      "nope isn't on GitHub, and an approval only covers updating an existing branch, never creating one. Push to agentes/dev/<topic> and open a pull request.",
    );
    expect(await refusal("main")).toBe(
      "main is the default branch: push to agentes/dev/<topic> and open a pull request; merging asks a person.",
    );
    expect(await refusal("rel")).toContain("rel is protected");
    expect(await f.db.select().from(schema.approvals)).toEqual([]);

    const routine = await toolsOf(w, {
      routineId: crypto.randomUUID(),
      routineRunId: crypto.randomUUID(),
      name: "Branches",
      creatorUserId: f.owner.id,
      deliverTo: { channelId: f.general.id, threadId: null },
      access: "act",
      report: "when_new",
      trigger: "schedule",
      dueAt: new Date().toISOString(),
    });
    const fromRoutine = asked(
      await routine.invoke("request_branch_push", { repo: "acme/app", branch: "ana/fix", why: WHY }),
    );
    expect(fromRoutine.approveAlways).toBeNull();
  });
});

describe("the computer", () => {
  test("agents commit as handle@agents.<our host>: theo@agents.agentes.chat on agentes.chat", () => {
    expect(agentCommitEmail("https://agentes.chat", "theo")).toBe("theo@agents.agentes.chat");
    expect(agentCommitEmail("https://agentes.chat/api/git/o/c/", "theo")).toBe("theo@agents.agentes.chat");
    expect(agentCommitEmail("http://localhost:3000", "theo")).toBe("theo@agents.localhost");
  });

  test("git_clone with no computer says so; open_pull_request goes through the org's GitHub", async () => {
    f = await setup();
    const connectors: ConnectorDeps = { db: f.db, keyWrappers: [f.keyWrapper], publicUrl: PUBLIC_URL };
    const connection = await createApiKeyConnection(connectors, f.owner.id, f.org.id, {
      connector: "github",
      apiKey: GH_TOKEN,
    });
    const github = fakeGitHub();
    const source = createGitToolSource({
      sandbox: {} as never,
      connectors,
      github: { apiUrl: github.apiUrl, fetch: github.fetch },
    });
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev oi",
    });
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns);
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run?.id ?? "",
      channelId: f.general.id,
      threadRootId: run?.threadRootId ?? msg.id,
      triggerMessageId: msg.id,
    };
    const tools = await source.tools(ctx);
    expect(tools.map((t) => [t.name, t.scope, t.connectionId, t.sensitive === true])).toEqual([
      ["git_clone", "github:git.read", connection.id, false],
      ["open_pull_request", "github:pr.write", connection.id, false],
      ["delete_branches", "github:git.write", connection.id, true],
      ["request_branch_push", "github:git.write", connection.id, true],
    ]);
    const clone = tools.find((t) => t.name === "git_clone");
    const result = await clone?.execute({ repo: "https://github.com/acme/app.git" }, ctx);
    expect(result).toMatchObject({ isError: true });
    expect(result?.content).toContain("You have no computer");
    const open = tools.find((t) => t.name === "open_pull_request");
    // The audit's title, in English like every other call's (the apps word the row by the tool).
    expect(open?.describe?.({ repo: "acme/app", branch: "agentes/dev/fix", title: "Fix login" })).toEqual({
      title: "Open a pull request in acme/app: Fix login",
    });
    const pr = await open?.execute({ repo: "acme/app", branch: "agentes/dev/fix", title: "Fix login" }, ctx);
    expect(pr?.content).toContain("https://github.com/acme/app/pull/7");
    const post = github.calls.find((c) => c.method === "POST");
    expect(post?.auth).toBe(`Bearer ${GH_TOKEN}`);
    // Signed for the person who asked (ADR 0156), though the model wrote no body.
    expect(JSON.parse(post?.text ?? "{}").body).toBe(
      `${SIGNATURE_MARK}\n<sub>Dev, agente de ana no agentes.chat</sub>`,
    );
  });
});

describe("the git proxy and the GitHub App (ADR 0156)", () => {
  const APP: GitHubAppConfig = {
    appId: "123",
    privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString(),
  };
  const bind = () =>
    f.db
      .insert(schema.githubAppInstallations)
      .values({ orgId: f.org.id, installationId: 5, accountLogin: "acme", accountType: "Organization" });

  test("a push goes with the app's token, asking for workflow files first and contents alone where not granted", async () => {
    const app = { lacks: [] as string[] };
    const w = await world(undefined, fakeGitHub({ app }));
    await bind();
    w.deps.app = APP;
    const push = async (repo: string) => {
      const a = commitObject([], `base ${repo}`);
      const res = await w.call(`${repo}.git/git-receive-pack`, {
        method: "POST",
        body: pushBody([{ old: ZERO_OID, new: a.oid, ref: "refs/heads/agentes/dev/ci" }], packOf([a])),
      });
      expect(await res.text()).toContain("unpack ok");
      return w.github.calls
        .filter((c) => c.url.endsWith("/access_tokens"))
        .map((c) => JSON.parse(c.text ?? "{}").permissions);
    };
    expect(await push("acme/app")).toEqual([{ contents: "write", workflows: "write" }]);
    const upstream = w.github.calls.find((c) => c.url.endsWith("/git-receive-pack"));
    expect(upstream?.auth).toBe(`Basic ${Buffer.from("x-access-token:ghs_app").toString("base64")}`);
    w.github.calls.length = 0;
    app.lacks = ["workflows"];
    expect(await push("acme/ci")).toEqual([{ contents: "write", workflows: "write" }, { contents: "write" }]);
  });

  test("GitHub through the app alone: a repository the app isn't on is refused with the way out", async () => {
    const w = await world(undefined, fakeGitHub({ app: { lacks: [] } }));
    await bind();
    w.deps.app = APP;
    await f.db
      .update(schema.connectorConnections)
      .set({ authType: "github_app", secretCiphertext: null, wrappedDataKey: null, kekId: null })
      .where(eq(schema.connectorConnections.id, w.connection.id));
    const refused = await w.call("other/thing.git/info/refs", { query: "?service=git-upload-pack" });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("isn't installed on other/thing");
    expect((await w.call("acme/app.git/info/refs", { query: "?service=git-upload-pack" })).status).toBe(200);
  });
});
