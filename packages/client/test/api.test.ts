import { describe, expect, test } from "bun:test";
import { ApiError, createApiClient, createHttpApi, createRequester } from "../src/index";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Record<string, { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const key = `${init.method} ${url}`;
    const r = responses[key] ??
      responses[url] ?? { status: 404, body: { error: { code: "not_found", message: "Route not found" } } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

describe("requester", () => {
  test("GET has no body nor content-type; writes are JSON (CSRF rule)", async () => {
    const { fetch, calls } = fakeFetch({
      "/a": { status: 200, body: { ok: 1 } },
      "POST /b": { status: 201, body: {} },
    });
    const request = createRequester({ fetch });
    expect(await request("/a")).toEqual({ ok: 1 });
    await request("/b", { json: { x: 1 } });
    const [get, post] = calls as [Call, Call];
    expect(get?.init.method).toBe("GET");
    expect((get.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect(get?.init.body).toBeUndefined();
    expect(get?.init.credentials).toBe("same-origin");
    expect(post?.init.method).toBe("POST");
    expect((post.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(post?.init.body).toBe('{"x":1}');
  });

  test("errors become ApiError with the server's code and message; 204 is undefined", async () => {
    const { fetch } = fakeFetch({
      "POST /bad": { status: 409, body: { error: { code: "conflict", message: "@ada is already taken" } } },
      "DELETE /gone": { status: 204 },
    });
    const request = createRequester({ fetch });
    const error = await request("/bad", { json: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "conflict", message: "@ada is already taken" });
    expect(await request("/gone", { method: "DELETE" })).toBeUndefined();
  });

  test("deleting: a code is asked for that deletion, the proof rides in a DELETE's body, a restore goes bare", async () => {
    const org = "/api/app/organizations/o1";
    const sent = { status: 202, body: { email: "ana@x.com", resendIn: 60 } };
    const { fetch, calls } = fakeFetch({
      [`POST ${org}/deletion/code`]: sent,
      "POST /api/app/account/deletion/code": sent,
      [`POST ${org}/deletion`]: { status: 202, body: { deletion: { dueAt: "2026-11-06T12:00:00.000Z" } } },
      [`DELETE ${org}/deletion`]: { status: 204 },
      "DELETE /api/app/account": { status: 204 },
    });
    const api = createHttpApi({ fetch });
    expect(await api.orgs.deletionCode("o1")).toEqual({ email: "ana@x.com", resendIn: 60 });
    expect(await api.account.deletionCode()).toEqual({ email: "ana@x.com", resendIn: 60 });
    expect(await api.orgs.deleteWorkspace("o1", { code: "482913" })).toEqual({ dueAt: "2026-11-06T12:00:00.000Z" });
    await api.orgs.restore("o1");
    await api.account.delete({ password: "pw" });
    await api.account.delete();
    const [, , deleting, restore, withProof, bare] = calls;
    expect(deleting?.init.body).toBe('{"code":"482913"}');
    expect(restore?.init).toMatchObject({ method: "DELETE", body: undefined });
    expect(withProof?.init).toMatchObject({ method: "DELETE", body: '{"password":"pw"}' });
    expect((withProof?.init.headers as Record<string, string> | undefined)?.["content-type"]).toBe("application/json");
    expect(bare?.init.body).toBe("{}");
  });

  test("query strings skip empty values", async () => {
    const { fetch, calls } = fakeFetch({});
    const request = createRequester({ fetch });
    await request("/x", { query: { a: 1, b: undefined, c: null, d: "z" } }).catch(() => {});
    expect(calls[0]?.url).toBe("/x?a=1&d=z");
  });

  test("the bot check's token rides only on the calls that carry one", async () => {
    const { fetch, calls } = fakeFetch({
      "POST /api/app/sign-in-options": { status: 200, body: { account: false } },
      "POST /api/app/invitations/tok/code": { status: 202, body: { email: "a@x.com", resendIn: 60 } },
    });
    const api = createHttpApi({ fetch });
    await api.account.signInOptions({ email: "a@x.com" }, "tok-1");
    await api.invites.sendCode("tok", { email: "a@x.com" }, "tok-2");
    await api.account.signInOptions({ email: "a@x.com" });
    const header = (c: Call) => (c.init.headers as Record<string, string>)["x-captcha-response"];
    expect(calls.map(header)).toEqual(["tok-1", "tok-2", undefined]);
    // Never in the body.
    expect(calls.every((c) => !String(c.init.body).includes("tok-"))).toBe(true);
  });
});

describe("transport options (the phone app)", () => {
  test("baseUrl prefixes every path, sends no browser cookie, and merges headers into JSON and file requests", async () => {
    const { fetch, calls } = fakeFetch({
      "https://app.agentes.chat/api/app/me": { status: 200, body: { user: { id: "u1" } } },
      "POST https://app.agentes.chat/api/app/organizations/o1/artifacts/files": {
        status: 201,
        body: { id: "a1", kind: "file" },
      },
      "https://app.agentes.chat/api/app/organizations/o1/artifacts/a1/file": { status: 200, body: { raw: true } },
    });
    let n = 0;
    const api = createHttpApi({
      baseUrl: "https://app.agentes.chat/",
      fetch,
      headers: async () => ({ cookie: `session=${++n}`, "x-agentes-client": "mobile" }),
    });
    await api.account.me();
    await api.artifacts.upload("o1", new File(["x"], "a.txt", { type: "text/plain" }), { title: "a" });
    await api.artifacts.fileBlob("o1", "a1");
    expect(calls.map((c) => c.url)).toEqual([
      "https://app.agentes.chat/api/app/me",
      "https://app.agentes.chat/api/app/organizations/o1/artifacts/files",
      "https://app.agentes.chat/api/app/organizations/o1/artifacts/a1/file",
    ]);
    for (const [i, c] of calls.entries()) {
      expect(c.init.credentials).toBe("omit");
      const headers = c.init.headers as Record<string, string>;
      expect(headers.cookie).toBe(`session=${i + 1}`);
      expect(headers["x-agentes-client"]).toBe("mobile");
    }
    expect(((calls[0] as Call).init.headers as Record<string, string>).accept).toBe("application/json");
    expect(api.artifacts.fileUrl("o1", "a1")).toBe(
      "https://app.agentes.chat/api/app/organizations/o1/artifacts/a1/file",
    );
  });

  test("without options: same origin and the browser's cookie", async () => {
    const { fetch, calls } = fakeFetch({ "/api/app/me": { status: 200, body: {} } });
    const api = createHttpApi({ fetch });
    await api.account.me();
    expect(api.artifacts.fileUrl("o1", "a1")).toBe("/api/app/organizations/o1/artifacts/a1/file");
    expect(calls[0]?.url).toBe("/api/app/me");
    expect(calls[0]?.init.credentials).toBe("same-origin");
  });
});

describe("HTTP client (real endpoints)", () => {
  const org = "/api/app/organizations/o1";
  test("me is null when signed out; usage null without permission; preview null when expired", async () => {
    const { fetch } = fakeFetch({
      "/api/app/me": { status: 401, body: { error: { code: "unauthorized", message: "Sign in" } } },
      [`${org}/usage`]: { status: 403, body: { error: { code: "forbidden", message: "no" } } },
      "/api/app/invitations/t1": { status: 404, body: { error: { code: "not_found", message: "expired" } } },
    });
    const api = createHttpApi({ fetch });
    expect(await api.account.me()).toBeNull();
    expect(await api.agents.usage("o1")).toBeNull();
    expect(await api.orgs.previewInvitation("t1")).toBeNull();
  });

  test("unwraps list envelopes and builds the documented paths", async () => {
    const { fetch, calls } = fakeFetch({
      [`${org}/channels`]: { status: 200, body: { channels: [{ id: "c1" }] } },
      [`${org}/channels/c1/messages?threadId=m1&limit=200`]: { status: 200, body: { messages: [{ id: "m1" }] } },
      [`POST ${org}/channels/c1/messages`]: { status: 201, body: { id: "m2" } },
      [`PATCH ${org}/agents/a1`]: { status: 200, body: { id: "a1" } },
      "POST /api/app/invitations/tok/accept": { status: 200, body: { orgId: "o1" } },
    });
    const api = createHttpApi({ fetch });
    expect(await api.chat.channels("o1")).toEqual([{ id: "c1" }] as never);
    expect(await api.chat.messages("o1", "c1", { threadId: "m1", limit: 200 })).toEqual([{ id: "m1" }] as never);
    await api.chat.post("o1", "c1", { body: "oi" });
    await api.agents.update("o1", "a1", { monthlyBudgetUsd: 40 });
    await api.orgs.acceptInvitation("tok");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `GET ${org}/channels`,
      `GET ${org}/channels/c1/messages?threadId=m1&limit=200`,
      `POST ${org}/channels/c1/messages`,
      `PATCH ${org}/agents/a1`,
      "POST /api/app/invitations/tok/accept",
    ]);
    expect(calls[2]?.init.body).toBe('{"body":"oi"}');
  });

  test("the composed client never sends provider keys anywhere but the credentials endpoint", async () => {
    const { fetch, calls } = fakeFetch({
      [`POST ${org}/credentials`]: { status: 201, body: { id: "k", keyHint: "7f2a" } },
    });
    const api = createApiClient({ fetch });
    const cred = await api.agents.addCredential("o1", { provider: "anthropic", label: "x", apiKey: "sk-ant-secret" });
    expect(cred).toEqual({ id: "k", keyHint: "7f2a" } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${org}/credentials`);
  });
});

describe("HTTP client: approvals, connectors, scopes (phases 2 and 3)", () => {
  const org = "/api/app/organizations/o1";
  test("approvals: list with filters, approve and refuse with a reason", async () => {
    const approval = { id: "a1", status: "pending", canDecide: true };
    const { fetch, calls } = fakeFetch({
      [`${org}/approvals?status=pending&agentId=ag`]: { status: 200, body: { approvals: [approval] } },
      [`POST ${org}/approvals/a1/approve`]: { status: 200, body: { ...approval, status: "approved" } },
      [`POST ${org}/approvals/a1/refuse`]: {
        status: 409,
        body: { error: { code: "conflict", message: "Already decided" } },
      },
    });
    const api = createHttpApi({ fetch });
    expect(await api.approvals.list("o1", { status: "pending", agentId: "ag" })).toEqual([approval] as never);
    expect((await api.approvals.approve("o1", "a1")).status).toBe("approved");
    const refused = await api.approvals.refuse("o1", "a1", "Precisa de revisão").catch((e) => e);
    expect(refused).toMatchObject({ status: 409, code: "conflict" });
    expect(calls[1]?.init.body).toBe("{}");
    expect(calls[2]?.init.body).toBe('{"reason":"Precisa de revisão"}');
  });

  test("Aprovar sempre: approve with `always`, the agent's rules, removing one", async () => {
    const rule = { id: "r1", connectionId: "c1", server: "Composio", tool: "close_ticket", action: "" };
    const { fetch, calls } = fakeFetch({
      [`POST ${org}/approvals/a1/approve`]: { status: 200, body: { id: "a1", status: "approved" } },
      [`${org}/agents/ag/approval-rules`]: { status: 200, body: { rules: [rule] } },
      [`DELETE ${org}/agents/ag/approval-rules/r1`]: { status: 204 },
    });
    const api = createHttpApi({ fetch });
    await api.approvals.approve("o1", "a1", undefined, true);
    expect(calls[0]?.init.body).toBe('{"always":true}');
    expect(await api.approvals.rules("o1", "ag")).toEqual([rule] as never);
    expect(await api.approvals.removeRule("o1", "ag", "r1")).toBeUndefined();
    expect(calls[2]?.init.method).toBe("DELETE");
  });

  test("connectors: catalog, connections, API key, OAuth start, disconnect", async () => {
    const { fetch, calls } = fakeFetch({
      "/api/app/connectors/catalog": { status: 200, body: { connectors: [{ id: "github" }], builtinScopes: [] } },
      [`${org}/connectors`]: { status: 200, body: { connections: [{ id: "c1" }] } },
      [`POST ${org}/connectors`]: { status: 201, body: { id: "c2" } },
      [`POST ${org}/connectors/github/oauth/start`]: { status: 200, body: { authorizeUrl: "https://gh/authorize" } },
      [`DELETE ${org}/connectors/c1`]: { status: 204 },
    });
    const api = createHttpApi({ fetch });
    expect((await api.connectors.catalog()).connectors).toEqual([{ id: "github" }] as never);
    expect(await api.connectors.list("o1")).toEqual([{ id: "c1" }] as never);
    await api.connectors.connectWithKey("o1", { connector: "sentry", apiKey: "sntrys_123456" });
    expect(await api.connectors.startOAuth("o1", "github", { returnTo: "/org/o1/settings" })).toBe(
      "https://gh/authorize",
    );
    await api.connectors.disconnect("o1", "c1");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "GET /api/app/connectors/catalog",
      `GET ${org}/connectors`,
      `POST ${org}/connectors`,
      `POST ${org}/connectors/github/oauth/start`,
      `DELETE ${org}/connectors/c1`,
    ]);
    expect(calls[3]?.init.body).toBe('{"returnTo":"/org/o1/settings"}');
  });

  test("agent scopes: GET and PUT { scopes }", async () => {
    const grants = [{ connectionId: null, scope: "context:read" }];
    const { fetch, calls } = fakeFetch({
      [`${org}/agents/a1/scopes`]: { status: 200, body: { scopes: grants } },
      [`PUT ${org}/agents/a1/scopes`]: { status: 200, body: { scopes: grants } },
    });
    const api = createHttpApi({ fetch });
    expect(await api.scopes.get("o1", "a1")).toEqual(grants);
    expect(await api.scopes.set("o1", "a1", grants)).toEqual(grants);
    expect(calls[1]?.init.method).toBe("PUT");
    expect(calls[1]?.init.body).toBe(JSON.stringify({ scopes: grants }));
  });
});

describe("HTTP client: management (phase 4)", () => {
  const org = "/api/app/organizations/o1";
  test("settings, overview, people, invitations, usage report", async () => {
    const { fetch, calls } = fakeFetch({
      [`${org}/settings`]: { status: 200, body: { name: "Acme", context: "" } },
      [`PATCH ${org}/settings`]: { status: 200, body: { name: "Acme", context: "novo" } },
      [`${org}/overview`]: { status: 200, body: { people: 7, agents: 4 } },
      [`${org}/people`]: { status: 200, body: { people: [{ userId: "u", online: true }] } },
      [`${org}/invitations/all`]: { status: 200, body: { invitations: [{ id: "i", status: "expired" }] } },
      [`POST ${org}/invitations/batch`]: { status: 200, body: { results: [{ email: "a@x.com", status: "invited" }] } },
      [`POST ${org}/invitations/i/resend`]: { status: 200, body: { url: "u", expiresAt: "e" } },
      [`${org}/usage/report`]: { status: 200, body: { totalUsd: 1 } },
    });
    const api = createHttpApi({ fetch });
    await api.orgs.settings("o1");
    expect((await api.orgs.updateSettings("o1", { context: "novo" })).context).toBe("novo");
    expect((await api.orgs.overview("o1")).people).toBe(7);
    expect((await api.orgs.people("o1"))[0]?.online).toBe(true);
    expect((await api.orgs.allInvitations("o1"))[0]?.status).toBe("expired");
    expect(await api.orgs.inviteMany("o1", { emails: ["a@x.com"], roleIds: [] })).toEqual([
      { email: "a@x.com", status: "invited" },
    ]);
    expect((await api.orgs.resendInvitation("o1", "i")).url).toBe("u");
    expect((await api.orgs.usageReport("o1")).totalUsd).toBe(1);
    expect(calls[5]?.init.body).toBe('{"emails":["a@x.com"],"roleIds":[]}');
  });

  test("credentials rotate/purge/platform, agent detail, channels, runs, roster, channel update, auto-reply", async () => {
    const { fetch, calls } = fakeFetch({
      [`POST ${org}/credentials/k/rotate`]: { status: 200, body: { id: "k", keyHint: "9999" } },
      [`DELETE ${org}/credentials/k?purge=true`]: { status: 204 },
      [`${org}/credentials/platform`]: { status: 200, body: { available: false } },
      [`${org}/agents/a1`]: { status: 200, body: { id: "a1", budgetUsedPercent: 30.8 } },
      [`PUT ${org}/agents/a1/channels`]: {
        status: 200,
        body: { channels: [{ id: "c1", name: "eng", autoReply: false }] },
      },
      [`${org}/runs?agentId=a1&limit=200`]: { status: 200, body: { runs: [{ id: "r1" }] } },
      [`${org}/runs/r1`]: { status: 200, body: { run: { id: "r1" }, steps: [] } },
      [`${org}/channels/c1/roster`]: { status: 200, body: { members: [{ type: "agent", id: "a1", autoReply: true }] } },
      [`PATCH ${org}/channels/c1`]: { status: 200, body: { id: "c1", topic: "novo" } },
      [`PATCH ${org}/channels/c1/members/agents/a1`]: { status: 204 },
    });
    const api = createHttpApi({ fetch });
    expect((await api.agents.rotateCredential("o1", "k", { apiKey: "sk-ant-9999" })).keyHint).toBe("9999");
    await api.agents.removeCredential("o1", "k", true);
    expect(await api.agents.platformKeyAvailable("o1")).toBe(false);
    expect((await api.agents.detail("o1", "a1")).budgetUsedPercent).toBe(30.8);
    expect(await api.agents.setChannels("o1", "a1", [{ channelId: "c1" }])).toHaveLength(1);
    expect(await api.agents.runs("o1", { agentId: "a1", limit: 200 })).toEqual([{ id: "r1" }] as never);
    expect((await api.agents.run("o1", "r1")).steps).toEqual([]);
    expect((await api.chat.roster("o1", "c1"))[0]?.autoReply).toBe(true);
    expect((await api.chat.update("o1", "c1", { topic: "novo" })).topic).toBe("novo");
    await api.chat.setAutoReply("o1", "c1", "a1", false);
    expect(calls[1]?.init.method).toBe("DELETE");
    expect(calls[4]?.init.body).toBe('{"channels":[{"channelId":"c1"}]}');
    expect(calls[9]?.init.body).toBe('{"autoReply":false}');
  });
});

describe("HTTP client: drive, storage, issues, routines, calendar, custom MCP, invites (no mocks left)", () => {
  const org = "/api/app/organizations/o1";
  const artifact = { id: "a1", kind: "document", title: "Relatório", version: 2, untrusted: false };

  test("artifacts: list with filters, get by version, versions, save a version, download, file URL, delete", async () => {
    const { fetch, calls } = fakeFetch({
      [`${org}/artifacts?q=rel&kind=document&channelId=c1&authorType=agent&authorId=ag`]: {
        status: 200,
        body: { artifacts: [artifact] },
      },
      [`${org}/artifacts/a1?version=1`]: { status: 200, body: { ...artifact, shownVersion: 1 } },
      [`${org}/artifacts/a1/versions`]: { status: 200, body: { versions: [{ version: 2 }, { version: 1 }] } },
      [`POST ${org}/artifacts/a1/versions`]: { status: 409, body: { error: { code: "conflict", message: "Stale" } } },
      [`${org}/artifacts/a1/download`]: { status: 200, body: { url: "https://bucket/x?sig", expiresAt: "t" } },
      [`DELETE ${org}/artifacts/a1`]: { status: 204 },
    });
    const api = createHttpApi({ fetch });
    expect(
      await api.artifacts.list("o1", {
        q: "rel",
        kind: "document",
        channelId: "c1",
        author: { type: "agent", id: "ag" },
      }),
    ).toEqual([artifact] as never);
    expect((await api.artifacts.get("o1", "a1", 1)).shownVersion).toBe(1);
    expect((await api.artifacts.versions("o1", "a1")).map((v) => v.version)).toEqual([2, 1]);
    const stale = await api.artifacts
      .update("o1", "a1", { content: { kind: "document", markdown: "x" }, baseVersion: 1, note: "n" })
      .catch((e) => e);
    expect(stale).toMatchObject({ status: 409 });
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({
      content: { kind: "document", markdown: "x" },
      baseVersion: 1,
      note: "n",
    });
    expect((await api.artifacts.download("o1", "a1")).url).toBe("https://bucket/x?sig");
    expect(api.artifacts.fileUrl("o1", "a1", { version: 2, format: "pdf" })).toBe(
      `${org}/artifacts/a1/file?version=2&format=pdf`,
    );
    expect(api.artifacts.fileUrl("o1", "a1")).toBe(`${org}/artifacts/a1/file`);
    await api.artifacts.remove("o1", "a1");
    expect(calls.at(-1)?.init.method).toBe("DELETE");
  });

  test("file uploads are multipart (no JSON content-type), new versions too; previews read the bytes", async () => {
    const detail = { ...artifact, kind: "file", shownVersion: 1 };
    const { fetch, calls } = fakeFetch({
      [`POST ${org}/artifacts/files`]: { status: 201, body: detail },
      [`POST ${org}/artifacts/a1/files`]: {
        status: 413,
        body: { error: { code: "artifact.file_too_large", message: "The file is too large (max 50 MB)" } },
      },
      [`GET ${org}/artifacts/a1/file?version=1`]: { status: 200, body: { raw: true } },
    });
    const api = createHttpApi({ fetch });
    const file = new File(["oi"], "nota.txt", { type: "text/plain" });
    expect((await api.artifacts.upload("o1", file, { title: "Nota", channelId: "c1" })).kind).toBe("file");
    const form = calls[0]?.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get("file") as File).name).toBe("nota.txt");
    expect(form.get("title")).toBe("Nota");
    expect(form.get("channelId")).toBe("c1");
    expect(((calls[0] as Call).init.headers as Record<string, string>)["content-type"]).toBeUndefined();
    const tooLarge = await api.artifacts.uploadVersion("o1", "a1", file, { note: "v2" }).catch((e) => e);
    expect(tooLarge).toMatchObject({ status: 413, code: "artifact.file_too_large" });
    expect(((calls[1] as Call).init.body as FormData).get("note")).toBe("v2");
    expect(await (await api.artifacts.fileBlob("o1", "a1", 1)).text()).toBe('{"raw":true}');
  });

  test("connected computers: the device code, desktop release and access reduce (ADR 0036)", async () => {
    const access = { folders: [], tools: { claude: true, codex: false, commands: false } };
    const release = {
      version: "0.2.0",
      url: "/api/desktop/download/0.2.0/agentes.dmg",
      sha256: "ab",
      publishedAt: "t",
    };
    const { fetch, calls } = fakeFetch({
      "GET /api/app/machines/device/K7Q4ZP": {
        status: 200,
        body: { name: "MacBook", os: "darwin", arch: "arm64", hostname: "mbp", version: "0.2.0" },
      },
      [`POST ${org}/machines/device/K7Q4ZP/confirm`]: { status: 201, body: { id: "m9", name: "Mac" } },
      "POST /api/app/machines/device/K7Q4ZP/deny": { status: 204 },
      [`POST ${org}/machines/m1/access/reduce`]: { status: 200, body: { access } },
      [`POST ${org}/machines/m2/access/reduce`]: { status: 200, body: access },
      "GET /api/desktop/latest?target=darwin&arch=aarch64": { status: 200, body: release },
    });
    const api = createHttpApi({ fetch });
    expect((await api.machines.device("K7Q4ZP")).name).toBe("MacBook");
    expect((await api.machines.confirmDevice("o1", "K7Q4ZP", { name: "Mac" })).id).toBe("m9");
    await api.machines.denyDevice("K7Q4ZP");
    // The new access comes bare or wrapped in `{ access }`.
    expect(await api.machines.reduceAccess("o1", "m1", { disableTool: "claude" })).toEqual(access);
    expect(await api.machines.reduceAccess("o1", "m2", { removeFolder: { path: "/p", agentId: "a1" } })).toEqual(
      access,
    );
    expect(await api.machines.desktopLatest("darwin", "aarch64")).toEqual(release);
    // No release published (or the server can't read them): 404 → null.
    expect(await api.machines.desktopLatest("darwin", "x86_64")).toBeNull();
    // An expired code is an error the page turns into "Esse código expirou".
    await expect(api.machines.device("ZZZZZZ")).rejects.toBeInstanceOf(ApiError);
    expect(calls.slice(0, 6).map((c) => `${c.init.method} ${c.url} ${c.init.body ?? ""}`)).toEqual([
      "GET /api/app/machines/device/K7Q4ZP ",
      `POST ${org}/machines/device/K7Q4ZP/confirm {"name":"Mac"}`,
      "POST /api/app/machines/device/K7Q4ZP/deny {}",
      `POST ${org}/machines/m1/access/reduce {"disableTool":"claude"}`,
      `POST ${org}/machines/m2/access/reduce {"removeFolder":{"path":"/p","agentId":"a1"}}`,
      "GET /api/desktop/latest?target=darwin&arch=aarch64 ",
    ]);
  });

  test("the desktop app's newest build: the server's own, else agentes.chat's, asked without the cookie", async () => {
    const release = {
      version: "0.6.0",
      url: "https://app.agentes.chat/api/desktop/download/0.6.0/agentes_0.6.0_x64-setup.exe",
      sha256: "ab",
      publishedAt: "t",
    };
    const { fetch, calls } = fakeFetch({
      "GET https://app.agentes.chat/api/desktop/latest?target=windows&arch=x64": { status: 200, body: release },
    });
    const api = createHttpApi({ fetch });
    expect(await api.machines.desktopLatest("windows", "x64")).toEqual(release);
    expect(calls.map((c) => [c.url, c.init.credentials])).toEqual([
      ["/api/desktop/latest?target=windows&arch=x64", "same-origin"],
      ["https://app.agentes.chat/api/desktop/latest?target=windows&arch=x64", "omit"],
    ]);
  });

  test("connected computers: list, rename, remove, and the agent's target", async () => {
    const machine = { id: "m1", name: "Escritório", online: true };
    const { fetch, calls } = fakeFetch({
      [`GET ${org}/machines`]: { status: 200, body: { machines: [machine] } },
      [`PATCH ${org}/machines/m1`]: { status: 200, body: { id: "m1", name: "Sala 2" } },
      [`DELETE ${org}/machines/m1`]: { status: 204 },
      [`PUT ${org}/agents/ag/computer/target`]: {
        status: 200,
        body: { kind: "machine", machineId: "m1", name: "Sala 2", online: true },
      },
    });
    const api = createHttpApi({ fetch });
    expect(await api.machines.list("o1")).toEqual([machine] as never);
    expect(await api.machines.rename("o1", "m1", "Sala 2")).toEqual({ id: "m1", name: "Sala 2" });
    await api.machines.remove("o1", "m1");
    expect((await api.sandbox.setTarget("o1", "ag", "m1")).kind).toBe("machine");
    expect(calls.map((c) => `${c.init.method} ${c.url} ${c.init.body ?? ""}`)).toEqual([
      `GET ${org}/machines `,
      `PATCH ${org}/machines/m1 {"name":"Sala 2"}`,
      `DELETE ${org}/machines/m1 `,
      `PUT ${org}/agents/ag/computer/target {"machineId":"m1"}`,
    ]);
  });

  test("the server's own computer: whether it works here (404: null), and turning it back on", async () => {
    const state = { machineId: "m9", on: false };
    const { fetch, calls } = fakeFetch({
      [`GET ${org}/machines/host`]: { status: 200, body: state },
      [`POST ${org}/machines/host`]: { status: 200, body: { ...state, on: true } },
    });
    const api = createHttpApi({ fetch });
    expect(await api.machines.host("o1")).toEqual(state);
    expect(await api.machines.hostOn("o1")).toEqual({ machineId: "m9", on: true });
    expect(calls.map((c) => `${c.init.method} ${c.url} ${c.init.body ?? ""}`)).toEqual([
      `GET ${org}/machines/host `,
      `POST ${org}/machines/host {}`,
    ]);
    const none = fakeFetch({
      [`GET ${org}/machines/host`]: { status: 404, body: { error: { code: "machine.host_none", message: "no" } } },
    });
    expect(await createHttpApi({ fetch: none.fetch }).machines.host("o1")).toBeNull();
  });

  test("storage: get, test, save, migrate and migration status", async () => {
    const config = { kind: "agentes", s3: null, migration: null };
    const s3 = { endpoint: "https://r2", region: "auto", bucket: "b", prefix: null, pathStyle: true };
    const { fetch, calls } = fakeFetch({
      [`${org}/storage`]: { status: 200, body: config },
      [`POST ${org}/storage/test`]: { status: 200, body: { ok: true, steps: [] } },
      [`PUT ${org}/storage`]: { status: 200, body: { ...config, kind: "s3" } },
      [`POST ${org}/storage/migrate`]: { status: 200, body: { status: "running", copied: 0, total: 3, error: null } },
      [`${org}/storage/migration`]: { status: 200, body: null },
    });
    const api = createHttpApi({ fetch });
    expect(await api.storage.get("o1")).toEqual(config as never);
    expect((await api.storage.test("o1", s3)).ok).toBe(true);
    expect((await api.storage.save("o1", { kind: "s3", s3 })).kind).toBe("s3");
    expect((await api.storage.migrate("o1")).status).toBe("running");
    expect(await api.storage.migration("o1")).toBeNull();
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `GET ${org}/storage`,
      `POST ${org}/storage/test`,
      `PUT ${org}/storage`,
      `POST ${org}/storage/migrate`,
      `GET ${org}/storage/migration`,
    ]);
  });

  test("issues and routines", async () => {
    const issue = { id: "i1", number: 131 };
    const { fetch, calls } = fakeFetch({
      [`${org}/issues?q=wa`]: { status: 200, body: { issues: [issue] } },
      [`${org}/issues/by-number/131`]: { status: 200, body: issue },
      [`PATCH ${org}/issues/i1`]: { status: 200, body: issue },
      [`PUT ${org}/issues/i1/criteria/c1`]: { status: 200, body: issue },
      [`${org}/issues/i1/activity`]: { status: 200, body: { activity: [] } },
      [`POST ${org}/issues/i1/comments`]: { status: 201, body: { id: "x" } },
      [`POST ${org}/issues/i1/ask-agent`]: { status: 200, body: issue },
      [`${org}/routines`]: { status: 200, body: { routines: [] } },
      [`POST ${org}/routines/parse-schedule`]: { status: 200, body: { ok: false, error: "?" } },
      [`PATCH ${org}/routines/r1`]: { status: 200, body: { id: "r1" } },
      [`POST ${org}/routines/r1/run`]: { status: 200, body: { id: "r1" } },
      [`POST ${org}/routines/r1/stop`]: { status: 200, body: { id: "r1" } },
      [`POST ${org}/routines/r1/take-over`]: { status: 200, body: { id: "r1" } },
      [`${org}/routines/r1/runs`]: { status: 200, body: { runs: [{ id: "run" }] } },
    });
    const api = createHttpApi({ fetch });
    expect(await api.issues.list("o1", { q: "wa" })).toEqual([issue] as never);
    expect((await api.issues.get("o1", 131)).id).toBe("i1");
    await api.issues.update("o1", "i1", { status: "done" });
    await api.issues.setCriterion("o1", "i1", "c1", true);
    expect(await api.issues.activity("o1", "i1")).toEqual([]);
    await api.issues.comment("o1", "i1", "oi");
    await api.issues.askAgent("o1", "i1", "ag");
    expect(await api.routines.list("o1")).toEqual([]);
    expect(await api.routines.parseSchedule("o1", "quando der")).toEqual({ ok: false, error: "?" });
    await api.routines.setActive("o1", "r1", false);
    await api.routines.runNow("o1", "r1");
    // ADR 0053: Parar, and "Assumir rotina".
    await api.routines.stop("o1", "r1");
    await api.routines.takeOver("o1", "r1");
    expect((await api.routines.runs("o1", "r1"))[0]?.id).toBe("run");
    const bodies = calls.filter((c) => c.init.method !== "GET").map((c) => c.init.body);
    expect(bodies).toEqual([
      '{"status":"done"}',
      '{"done":true}',
      '{"text":"oi"}',
      '{"agentId":"ag"}',
      '{"phrase":"quando der"}',
      '{"active":false}',
      "{}",
      "{}",
      "{}",
    ]);
    expect(calls.map((c) => c.url).filter((u) => /stop|take-over/.test(u))).toEqual([
      `${org}/routines/r1/stop`,
      `${org}/routines/r1/take-over`,
    ]);
  });

  test("a webhook routine's address: read it, a new one, a signing secret or none, Testar", async () => {
    const hook = { url: "https://app.agentes.test/api/hooks/t", signed: true, methods: ["POST" as const], calls: [] };
    const { fetch, calls } = fakeFetch({
      [`${org}/routines/r1/hook`]: { status: 200, body: hook },
      [`POST ${org}/routines/r1/hook/address`]: { status: 200, body: hook },
      [`POST ${org}/routines/r1/hook/secret`]: { status: 200, body: { secret: "s3", hook } },
      [`DELETE ${org}/routines/r1/hook/secret`]: { status: 200, body: { ...hook, signed: false } },
      [`POST ${org}/routines/r1/hook/test`]: { status: 200, body: { runId: "rr1", hook } },
    });
    const api = createHttpApi({ fetch });
    expect(await api.routines.hook("o1", "r1")).toEqual(hook);
    expect(await api.routines.newHookAddress("o1", "r1")).toEqual(hook);
    expect((await api.routines.newHookSecret("o1", "r1")).secret).toBe("s3");
    expect((await api.routines.removeHookSecret("o1", "r1")).signed).toBe(false);
    expect((await api.routines.testHook("o1", "r1")).runId).toBe("rr1");
    expect(calls.map((c) => `${c.init.method ?? "GET"} ${c.url}`)).toEqual([
      `GET ${org}/routines/r1/hook`,
      `POST ${org}/routines/r1/hook/address`,
      `POST ${org}/routines/r1/hook/secret`,
      `DELETE ${org}/routines/r1/hook/secret`,
      `POST ${org}/routines/r1/hook/test`,
    ]);
  });

  test("calendar, custom MCP and invites", async () => {
    const { fetch, calls } = fakeFetch({
      [`${org}/calendar?from=2026-10-12&to=2026-10-19`]: {
        status: 200,
        body: { events: [], routines: [], deadlines: [], proposals: [] },
      },
      [`POST ${org}/calendar/events`]: { status: 201, body: { id: "e1" } },
      [`POST ${org}/calendar/proposals/p1/confirm`]: { status: 200, body: { id: "e2" } },
      [`POST ${org}/calendar/proposals/p1/dismiss`]: { status: 204 },
      [`${org}/connectors/custom`]: { status: 200, body: { servers: [] } },
      [`POST ${org}/connectors/custom`]: { status: 200, body: { status: "needs_key" } },
      [`PUT ${org}/connectors/custom/s1/tools`]: { status: 200, body: { id: "s1" } },
      [`POST ${org}/invite-links`]: { status: 201, body: { id: "l1", url: "https://x/invite/t", expiresAt: "t" } },
      [`GET ${org}/invite-links`]: { status: 200, body: { links: [{ id: "l1", url: null }] } },
      [`DELETE ${org}/invite-links/l1`]: { status: 204 },
      "POST /api/app/invitations/tok/requests": { status: 201, body: { status: "pending", email: "a@x.com" } },
      "POST /api/app/invitations/tok/code": { status: 202, body: { email: "a@x.com", resendIn: 60 } },
      "POST /api/app/invitations/tok/code/check": { status: 200, body: { verified: true } },
      "POST /api/app/invitations/tok/request-new": { status: 204 },
      [`GET ${org}/join-requests`]: { status: 200, body: { requests: [{ id: "r1" }] } },
      [`POST ${org}/join-requests/r1/approve`]: { status: 200, body: { outcome: "joined" } },
      [`POST ${org}/join-requests/r1/deny`]: { status: 204 },
    });
    const api = createHttpApi({ fetch });
    expect((await api.calendar.range("o1", "2026-10-12", "2026-10-19")).events).toEqual([]);
    await api.calendar.create("o1", { title: "x", start: "a", end: "b", recurrence: "none", participants: [] });
    expect((await api.calendar.confirmProposal("o1", "p1")).id).toBe("e2");
    await api.calendar.dismissProposal("o1", "p1");
    expect(await api.customConnectors.list("o1")).toEqual([]);
    expect(await api.customConnectors.connect("o1", { serverUrl: "https://mcp", returnTo: "/" })).toEqual({
      status: "needs_key",
    });
    await api.customConnectors.saveTools("o1", "s1", { label: "x", tools: [] });
    expect((await api.invites.createLink("o1")).url).toBe("https://x/invite/t");
    expect(await api.invites.links("o1")).toEqual([expect.objectContaining({ id: "l1", url: null })]);
    await api.invites.turnOff("o1", "l1");
    expect(await api.invites.sendCode("tok", { email: "a@x.com" })).toEqual({ email: "a@x.com", resendIn: 60 });
    expect(await api.invites.checkCode("tok", { email: "a@x.com", code: "123456" })).toEqual({ verified: true });
    expect((await api.invites.ask("tok", { name: "Ana", email: "a@x.com", code: "123456" })).status).toBe("pending");
    await api.invites.requestNew("tok");
    expect(await api.joinRequests.list("o1")).toEqual([expect.objectContaining({ id: "r1" })]);
    expect(await api.joinRequests.approve("o1", "r1", ["r-admin"])).toEqual({ outcome: "joined" });
    await api.joinRequests.deny("o1", "r1", "Not now");
    const sent = (path: string) => calls.find((c) => c.url === path && c.init.method === "POST")?.init.body;
    expect(sent(`${org}/join-requests/r1/approve`)).toBe('{"roleIds":["r-admin"]}');
    expect(sent(`${org}/join-requests/r1/deny`)).toBe('{"reason":"Not now"}');
    expect(sent("/api/app/invitations/tok/requests")).toBe('{"name":"Ana","email":"a@x.com","code":"123456"}');
    expect(sent("/api/app/invitations/tok/code/check")).toBe('{"email":"a@x.com","code":"123456"}');
    // Writes carry JSON (the server's CSRF rule); a DELETE needs no body.
    expect(calls.every((c) => ["GET", "DELETE"].includes(String(c.init.method)) || c.init.body !== undefined)).toBe(
      true,
    );
  });
});

describe("phone app endpoints", () => {
  test("pins, thread follows, working runs and reminders hit their routes", async () => {
    const o = "/api/app/organizations/o1";
    const pin = { messageId: "m1", channelId: "c1", threadId: null, pinnedByUserId: "u1", pinnedAt: "t", message: {} };
    const reminder = { id: "r1", message: "x", at: "t", timezone: "UTC", description: "", forUserId: "u1" };
    const { fetch, calls } = fakeFetch({
      [`GET ${o}/channels/c1/pins`]: { status: 200, body: { pins: [pin] } },
      [`POST ${o}/channels/c1/pins/m1`]: { status: 200, body: pin },
      [`DELETE ${o}/channels/c1/pins/m1`]: { status: 204 },
      [`PUT ${o}/threads/t1/follow`]: { status: 200, body: { threadId: "t1", channelId: "c1", following: true } },
      [`DELETE ${o}/threads/t1/follow`]: { status: 200, body: { threadId: "t1", channelId: "c1", following: false } },
      [`GET ${o}/active-runs`]: { status: 200, body: { runs: [{ runId: "r" }] } },
      [`POST ${o}/reminders`]: { status: 201, body: reminder },
      [`GET ${o}/reminders`]: { status: 200, body: { reminders: [reminder] } },
      [`DELETE ${o}/reminders/r1`]: { status: 200, body: { ...reminder, done: true } },
    });
    const api = createHttpApi({ fetch });
    expect(await api.pins?.list("o1", "c1")).toEqual([pin] as never);
    expect((await api.pins?.pin("o1", "c1", "m1"))?.messageId).toBe("m1");
    await api.pins?.unpin("o1", "c1", "m1");
    expect((await api.threadFollows?.follow("o1", "t1"))?.following).toBe(true);
    expect((await api.threadFollows?.unfollow("o1", "t1"))?.following).toBe(false);
    expect((await api.working?.list("o1"))?.map((r) => r.runId)).toEqual(["r"]);
    await api.reminders?.create("o1", { channelId: "c1", messageId: "m1", at: "2030-01-01T09:00:00Z" });
    expect(JSON.parse(String(calls.at(-1)?.init.body))).toEqual({
      channelId: "c1",
      messageId: "m1",
      at: "2030-01-01T09:00:00Z",
    });
    expect((await api.reminders?.list("o1"))?.length).toBe(1);
    expect((await api.reminders?.cancel("o1", "r1"))?.done).toBe(true);
    expect(calls.map((c) => c.init.method)).toEqual([
      "GET",
      "POST",
      "DELETE",
      "PUT",
      "DELETE",
      "GET",
      "POST",
      "GET",
      "DELETE",
    ]);
  });
});

describe("push devices (ADR 0035, ADR 0071)", () => {
  test("a browser's subscription and a phone's token share the route; the key is null when Web Push is off", async () => {
    const endpoint = "https://push.example/send/abc?x=1";
    const { fetch, calls } = fakeFetch({
      "GET /api/app/push/web": { status: 200, body: { publicKey: "BPk" } },
      "POST /api/app/push/devices": { status: 204 },
      "POST /api/app/push/devices/forget": { status: 204 },
    });
    const api = createHttpApi({ fetch });
    expect(await api.push.webKey()).toBe("BPk");
    await api.push.register({ platform: "web", endpoint, keys: { p256dh: "p", auth: "a" }, locale: "pt-BR" });
    expect(JSON.parse(String(calls.at(-1)?.init.body))).toEqual({
      platform: "web",
      endpoint,
      keys: { p256dh: "p", auth: "a" },
      locale: "pt-BR",
    });
    await api.push.register({ platform: "ios", token: "ExponentPushToken[abcdefgh12345]", locale: "en" });
    expect(JSON.parse(String(calls.at(-1)?.init.body))).toEqual({
      platform: "ios",
      token: "ExponentPushToken[abcdefgh12345]",
      locale: "en",
    });
    // Forgotten by a body, not a path: an endpoint's encoded slashes don't survive every proxy.
    await api.push.unregister(endpoint);
    expect(calls.at(-1)?.url).toBe("/api/app/push/devices/forget");
    expect(calls.at(-1)?.init.method).toBe("POST");
    expect(JSON.parse(String(calls.at(-1)?.init.body))).toEqual({ token: endpoint });

    const off = fakeFetch({
      "GET /api/app/push/web": { status: 404, body: { error: { code: "web_push_off", message: "Off" } } },
    });
    expect(await createHttpApi({ fetch: off.fetch }).push.webKey()).toBeNull();
  });

  test("stale: the ids go in, the server's stale ones come back (clear on read)", async () => {
    const { fetch, calls } = fakeFetch({
      "POST /api/app/push/stale": { status: 200, body: { stale: ["n2"] } },
    });
    const api = createHttpApi({ fetch });
    expect(await api.push.stale(["n1", "n2"])).toEqual(["n2"]);
    expect(calls.at(-1)?.init.method).toBe("POST");
    expect(JSON.parse(String(calls.at(-1)?.init.body))).toEqual({ ids: ["n1", "n2"] });
  });
});
