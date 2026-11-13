import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type ConnectorDeps,
  clientRefused,
  completeOAuth,
  connectionHeaders,
  connectionView,
  connectorGrantValidator,
  createApiKeyConnection,
  createConnectorToolSource,
  createToolGateway,
  decideApproval,
  drainOutbox,
  ForbiddenError,
  fillTitle,
  listApprovals,
  listMessages,
  MisconfiguredError,
  postPersonMessage,
  revokeConnection,
  setAgentScopes,
  startOAuth,
  TokenRefused,
  ValidationError,
  wrapExternal,
} from "../src";
import { fakeGithubMcp } from "./fake-mcp";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const depsOf = (fx: Fixture, extra: Partial<ConnectorDeps> = {}): ConnectorDeps => ({
  db: fx.db,
  keyWrappers: [fx.keyWrapper],
  publicUrl: "https://chat.example.com",
  oauthApps: { github: { clientId: "gh-client", clientSecret: "gh-secret" } },
  ...extra,
});

test("fillTitle fills approval templates", () => {
  expect(fillTitle("Merge PR #{pullNumber} in {owner}/{repo}", { pullNumber: 42, owner: "acme", repo: "app" })).toBe(
    "Merge PR #42 in acme/app",
  );
  expect(fillTitle("{missing}", {})).toBe("?");
});

describe("connections", () => {
  test("API-key connection: sealed at rest, admins only, one active per connector", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    await expect(
      createApiKeyConnection(depsOf(f), member.id, f.org.id, { connector: "github", apiKey: "ghp_secret_123456" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, { connector: "jira", apiKey: "x".repeat(10) }),
    ).rejects.toBeInstanceOf(ValidationError);
    const first = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    const raw = JSON.stringify(await f.db.select().from(schema.connectorConnections));
    expect(raw).not.toContain("ghp_secret_123456");
    expect(await connectionHeaders(depsOf(f), first)).toEqual({ authorization: "Bearer ghp_secret_123456" });

    // Grants survive reconnecting.
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [{ connectionId: first.id, scope: "github:pr.read" }],
      connectorGrantValidator,
    );
    const second = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_rotated_654321",
    });
    const scopes = await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.agentId, f.agent.id));
    expect(scopes.find((s) => s.scope === "github:pr.read")?.connectionId).toBe(second.id);
    const active = (await f.db.select().from(schema.connectorConnections)).filter((c) => !c.revokedAt);
    expect(active.map((c) => c.id)).toEqual([second.id]);
  });

  test("a new connection is every agent's at Ler e escrever, each in the audit log; reconnecting keeps what people chose", async () => {
    f = await setup();
    const [ops, gone] = await f.db
      .insert(schema.agents)
      .values([
        { orgId: f.org.id, name: "Ops", handle: "ops", model: "claude-sonnet-5-5" },
        { orgId: f.org.id, name: "Old", handle: "old", model: "claude-sonnet-5-5", archivedAt: new Date() },
      ])
      .returning();
    const who = (agentId: string | null) => (agentId === f.agent.id ? "dev" : agentId === ops?.id ? "ops" : "old");
    const grantsOn = async (connectionId: string) =>
      (await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, connectionId)))
        .map((g) => [who(g.agentId), g.scope, g.grantedByUserId])
        .sort();
    const audited = async () =>
      (await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "agent.access_changed")))
        .map((a) => [who(a.targetId), a.actorId, a.details])
        .sort();

    const first = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    // The whole connection (`connector:*`), sensitive tools included: they still ask a person on every call.
    expect(await grantsOn(first.id)).toEqual([
      ["dev", "connector:*", f.owner.id],
      ["ops", "connector:*", f.owner.id],
    ]);
    expect(gone?.archivedAt).not.toBeNull();
    const details = { connectionId: first.id, label: "GitHub", level: "write" };
    expect(await audited()).toEqual([
      ["dev", f.owner.id, details],
      ["ops", f.owner.id, details],
    ]);

    // Someone narrows Dev to reading pull requests; a new key for the same connector keeps that and grants nothing.
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [{ connectionId: first.id, scope: "github:pr.read" }],
      connectorGrantValidator,
    );
    await f.db
      .insert(schema.approvalRules)
      .values({ orgId: f.org.id, agentId: f.agent.id, connectionId: first.id, tool: "issue_write" });
    const second = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_rotated_654321",
    });
    expect((await f.db.select().from(schema.approvalRules)).map((r) => r.connectionId)).toEqual([second.id]);
    expect(await grantsOn(second.id)).toEqual([
      ["dev", "github:pr.read", f.owner.id],
      ["ops", "connector:*", f.owner.id],
    ]);
    expect(await audited()).toHaveLength(2);
  });

  test("grants must name a scope of the connection's catalog, in this org", async () => {
    f = await setup();
    const c = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    const set = (grants: { connectionId: string | null; scope: string }[]) =>
      setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, grants, connectorGrantValidator);
    await expect(set([{ connectionId: c.id, scope: "github:admin" }])).rejects.toThrow("Unknown scope");
    await expect(set([{ connectionId: c.id, scope: "sentry:issues.read" }])).rejects.toThrow("Unknown scope");
    await expect(set([{ connectionId: null, scope: "root" }])).rejects.toThrow("Unknown scope");
    await expect(set([{ connectionId: crypto.randomUUID(), scope: "github:pr.read" }])).rejects.toThrow(
      "not an active",
    );
    await set([
      { connectionId: c.id, scope: "github:pr.read" },
      { connectionId: null, scope: "context:read" },
    ]);
  });
});

describe("GitHub and the GitHub App's installations (ADR 0156)", () => {
  test("disconnecting an account while installations remain keeps GitHub through the app; disconnecting that ends both", async () => {
    f = await setup();
    const c = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [{ connectionId: c.id, scope: "github:pr.read" }],
      connectorGrantValidator,
    );
    await f.db
      .insert(schema.githubAppInstallations)
      .values({ orgId: f.org.id, installationId: 1, accountLogin: "acme", accountType: "Organization" });
    const row = async () =>
      (await f.db.select().from(schema.connectorConnections).where(eq(schema.connectorConnections.id, c.id)))[0];
    const scopes = () => f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, c.id));

    await revokeConnection(f.db, f.owner.id, f.org.id, c.id);
    expect(await row()).toMatchObject({
      revokedAt: null,
      authType: "github_app",
      accountLabel: "acme",
      secretCiphertext: null,
      wrappedDataKey: null,
    });
    expect((await scopes()).map((s) => s.scope)).toEqual(["github:pr.read"]);
    expect(await connectionHeaders(depsOf(f), (await row()) as NonNullable<Awaited<ReturnType<typeof row>>>)).toEqual(
      {},
    );

    await revokeConnection(f.db, f.owner.id, f.org.id, c.id);
    expect((await row())?.revokedAt).not.toBeNull();
    expect(await scopes()).toEqual([]);
    expect(await f.db.select().from(schema.githubAppInstallations)).toEqual([]);
  });

  test("without installations, disconnecting GitHub revokes it as before", async () => {
    f = await setup();
    const c = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    await revokeConnection(f.db, f.owner.id, f.org.id, c.id);
    const [row] = await f.db.select().from(schema.connectorConnections).where(eq(schema.connectorConnections.id, c.id));
    expect(row).toMatchObject({ authType: "api_key" });
    expect(row?.revokedAt).not.toBeNull();
  });
});

describe("MCP tools through the Tool Gateway", () => {
  test("only catalog tools the agent was granted are exposed; calls go over MCP with the org's key", async () => {
    f = await setup();
    const mcp = fakeGithubMcp();
    const c = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    const source = createConnectorToolSource({ ...depsOf(f), connect: mcp.connect });
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    const all = await source.tools(ctx);
    expect(all.map((t) => [t.name, t.scope, t.sensitive]).sort()).toEqual([
      ["github_issue_read", "github:issues.read", false],
      ["github_merge_pull_request", "github:pr.merge", true],
      ["github_pull_request_read", "github:pr.read", false],
    ]);
    // Counted under the catalog's id, by the server's own tool names (ADR 0103).
    expect(Object.fromEntries(all.map((t) => [t.name, t.connector]))).toEqual({
      github_issue_read: { key: "github", via: "mcp", tool: "issue_read" },
      github_pull_request_read: { key: "github", via: "mcp", tool: "pull_request_read" },
      github_merge_pull_request: { key: "github", via: "mcp", tool: "merge_pull_request" },
    });
    // The chat draws each call with the connector's own logo.
    expect(new Set(all.map((t) => t.service))).toEqual(new Set(["github"]));
    expect(mcp.sessions[0]).toEqual({
      serverUrl: "https://api.githubcopilot.com/mcp/",
      // Actions, Projects, discussions, labels, security alerts and rulesets too, besides the server's default toolsets.
      headers: {
        authorization: "Bearer ghp_secret_123456",
        "X-MCP-Toolsets":
          "context,repos,issues,pull_requests,users,actions,projects,discussions,labels,code_security,dependabot,secret_protection,security_advisories,governance",
      },
    });

    const gateway = createToolGateway({ sources: [source] });
    // A new connection is every agent's, whole (the merge still asks a person, below).
    expect((await gateway.list(ctx)).map((t) => t.name).sort()).toEqual([
      "github_issue_read",
      "github_merge_pull_request",
      "github_pull_request_read",
    ]);
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [
        { connectionId: c.id, scope: "github:pr.read" },
        { connectionId: c.id, scope: "github:issues.read" },
      ],
      connectorGrantValidator,
    );
    expect((await gateway.list(ctx)).map((t) => t.name)).toEqual(["github_issue_read", "github_pull_request_read"]);

    // Grant rows need a run for steps; use a real one.
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "x",
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
      })
      .returning();
    const rctx = { ...ctx, runId: run?.id ?? "" };
    expect(
      await gateway.invoke(rctx, {
        toolUseId: "t1",
        name: "github_pull_request_read",
        input: { owner: "acme", repo: "app", pullNumber: 42 },
      }),
    ).toMatchObject({
      type: "result",
      // The MCP server's text is third-party data: wrapped for the model.
      output: { content: wrapExternal("github_pull_request_read", "PR #42: fix token refresh (checks passing)") },
    });
    expect(
      await gateway.invoke(rctx, { toolUseId: "t2", name: "github_issue_read", input: { number: 1 } }),
    ).toMatchObject({
      output: { content: wrapExternal("github_issue_read", "boom"), isError: true },
    });
    expect(
      await gateway.invoke(rctx, { toolUseId: "t3", name: "github_star_repository", input: { repo: "app" } }),
    ).toMatchObject({
      output: { content: "Unknown tool github_star_repository", isError: true },
    });
    expect(mcp.calls.map((c) => c.tool)).toEqual(["pull_request_read"]);
    const used = await f.db.select().from(schema.connectorUsageDays).orderBy(schema.connectorUsageDays.tool);
    expect(used.map((r) => [r.connector, r.via, r.tool, r.calls, r.errors])).toEqual([
      ["github", "mcp", "issue_read", 1, 1],
      ["github", "mcp", "pull_request_read", 1, 0],
    ]);

    // Disconnecting removes the tools and the grants.
    await revokeConnection(f.db, f.owner.id, f.org.id, c.id);
    expect(await gateway.list(ctx)).toEqual([]);
    expect(await f.db.select().from(schema.agentScopes)).toEqual([]);
  });

  test("deleting a repository and adding a ruleset ask a person; creating one, labels and discussions don't", async () => {
    f = await setup();
    const mcp = fakeGithubMcp({ writes: true });
    await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, { connector: "github", apiKey: "ghp_secret_123456" });
    const source = createConnectorToolSource({ ...depsOf(f), connect: mcp.connect });
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "x",
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
      })
      .returning();
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run?.id ?? "",
      channelId: f.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
    };
    const sensitive = Object.fromEntries((await source.tools(ctx)).map((t) => [t.name, t.sensitive]));
    expect(sensitive).toMatchObject({
      github_delete_repository: true,
      github_create_repository_ruleset: true,
      github_create_repository: false,
      github_label_write: false,
      github_discussion_comment_write: false,
      github_list_code_scanning_alerts: false,
    });

    const gateway = createToolGateway({ sources: [source] });
    const why = "The person asked to clean up the old repositories: this is the one they named.";
    const call = (name: string, input: Record<string, unknown>) =>
      gateway.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
    const deletion = await call("github_delete_repository", { owner: "acme", repo: "old", why });
    expect(deletion).toMatchObject({ type: "approval", approval: { title: "Delete acme/old" } });
    const ruleset = await call("github_create_repository_ruleset", {
      owner: "acme",
      repo: "app",
      name: "main",
      rules: [{ type: "deletion" }],
      why,
    });
    expect(ruleset).toMatchObject({ type: "approval", approval: { title: "Create ruleset main" } });
    expect(await call("github_create_repository", { name: "new", organization: "acme" })).toMatchObject({
      type: "result",
    });
    expect(
      await call("github_label_write", { owner: "acme", repo: "app", method: "delete", name: "stale" }),
    ).toMatchObject({
      type: "result",
    });
    expect(mcp.calls.map((x) => x.tool)).toEqual(["create_repository", "label_write"]);
  });

  test("end to end: mention → MCP read → merge approval → approve → merged over MCP with exactly the approved params", async () => {
    const mcp = fakeGithubMcp();
    let deps: ConnectorDeps | undefined;
    f = await setup({
      toolSources: [
        {
          name: "lazy-connectors",
          tools: (ctx) => createConnectorToolSource({ ...(deps as ConnectorDeps), connect: mcp.connect }).tools(ctx),
        },
      ],
      reply: (req) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (last.includes("Merged PR #42")) return { chunks: ["Merge feito."] };
        if (last.includes("checks passing"))
          return {
            chunks: ["Checks passing."],
            toolUses: [
              {
                name: "github_merge_pull_request",
                input: {
                  owner: "acme",
                  repo: "app",
                  pullNumber: 42,
                  why: "The checks passed and the change was reviewed: this action finishes what was asked.",
                },
              },
            ],
          };
        return {
          chunks: [],
          toolUses: [{ name: "github_pull_request_read", input: { owner: "acme", repo: "app", pullNumber: 42 } }],
        };
      },
    });
    deps = depsOf(f);
    const c = await createApiKeyConnection(deps, f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [
        { connectionId: c.id, scope: "github:pr.read" },
        { connectionId: c.id, scope: "github:pr.merge" },
      ],
      connectorGrantValidator,
    );

    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev merge PR 42",
    });
    await drainOutbox(f.db, f.handlers);
    const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
    expect(approval).toMatchObject({
      title: "Merge PR #42 in acme/app",
      scope: "github:pr.merge",
      tool: "github_merge_pull_request",
    });
    expect(approval?.detail).toBe("github.merge_pull_request · owner=acme · repo=app · pullNumber=42");
    expect(mcp.calls.map((x) => x.tool)).toEqual(["pull_request_read"]);

    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
      decision: "approve",
    });
    await drainOutbox(f.db, f.handlers);
    expect(mcp.calls).toEqual([
      { tool: "pull_request_read", args: { owner: "acme", repo: "app", pullNumber: 42 } },
      { tool: "merge_pull_request", args: { owner: "acme", repo: "app", pullNumber: 42 } },
    ]);
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.at(-1)?.body).toBe("Merge feito.");
  });
});

describe("OAuth (state + PKCE)", () => {
  /** A token endpoint that checks the PKCE verifier against the challenge from the authorize URL. */
  function tokenEndpoint() {
    const seen: URLSearchParams[] = [];
    let challenge = "";
    let n = 0;
    const http = (async (_url: string, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      seen.push(form);
      if (form.get("grant_type") === "authorization_code") {
        const ok =
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url") === challenge;
        if (!ok || form.get("code") !== "good-code") return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      n++;
      return Response.json({ access_token: `gho_token_${n}`, refresh_token: `ghr_refresh_${n}`, expires_in: 3600 });
    }) as unknown as typeof fetch;
    return { http, seen, setChallenge: (c: string) => (challenge = c) };
  }

  test("start → callback stores sealed tokens; state is single use, per person, and expires", async () => {
    f = await setup();
    const token = tokenEndpoint();
    const deps = depsOf(f, { http: token.http });
    const { authorizeUrl, state } = await startOAuth(deps, f.owner.id, f.org.id, "github", {
      returnTo: "/settings/connectors",
    });
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "gh-client",
      redirect_uri: "https://chat.example.com/api/app/connectors/oauth/callback",
      response_type: "code",
      scope: "repo read:org workflow project",
      state,
      code_challenge_method: "S256",
    });
    token.setChallenge(url.searchParams.get("code_challenge") ?? "");
    const stored = JSON.stringify(await f.db.select().from(schema.oauthStates));
    expect(stored).not.toContain(state);

    const other = await addMember(f.db, f.org.id, "admin", "other");
    await expect(completeOAuth(deps, { id: other.id }, { state, code: "good-code" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(completeOAuth(deps, { id: f.owner.id }, { state: "forged", code: "good-code" })).rejects.toThrow(
      "invalid or expired",
    );

    const { connection, returnTo } = await completeOAuth(deps, { id: f.owner.id }, { state, code: "good-code" });
    expect(returnTo).toBe("/settings/connectors");
    expect(connection).toMatchObject({
      connector: "github",
      authType: "oauth",
      oauthScopes: "repo read:org workflow project",
    });
    expect(connectionView(connection).reconnectAdds).toEqual([]);
    // A sign-in from before Projects (the migration kept what it granted): Reconectar adds `project`.
    expect(connectionView({ ...connection, oauthScopes: "repo read:org workflow" }).reconnectAdds).toEqual(["project"]);
    expect(connectionView({ ...connection, authType: "api_key", oauthScopes: null }).reconnectAdds).toEqual([]);
    expect(JSON.stringify(await f.db.select().from(schema.connectorConnections))).not.toContain("gho_token_1");
    expect(await connectionHeaders(deps, connection)).toEqual({ authorization: "Bearer gho_token_1" });
    expect(token.seen[0]?.get("client_secret")).toBe("gh-secret");

    await expect(completeOAuth(deps, { id: f.owner.id }, { state, code: "good-code" })).rejects.toMatchObject({
      code: "oauth.link_used",
    });

    const late = await startOAuth(deps, f.owner.id, f.org.id, "github");
    const later = depsOf(f, { http: token.http, now: () => new Date(Date.now() + 11 * 60_000) });
    await expect(completeOAuth(later, { id: f.owner.id }, { state: late.state, code: "good-code" })).rejects.toThrow(
      "expired",
    );
  });

  test("a wrong PKCE verifier or code is refused by the provider; unconfigured OAuth is refused", async () => {
    f = await setup();
    const token = tokenEndpoint();
    const deps = depsOf(f, { http: token.http });
    const { state } = await startOAuth(deps, f.owner.id, f.org.id, "github");
    token.setChallenge("something-else");
    await expect(completeOAuth(deps, { id: f.owner.id }, { state, code: "good-code" })).rejects.toThrow(
      "invalid_grant",
    );
    await expect(startOAuth(deps, f.owner.id, f.org.id, "linear")).rejects.toThrow("not configured");
  });

  test("this server's OAuth app refused (a wrong client id or secret): misconfigured, naming the provider", async () => {
    f = await setup();
    // The token endpoint refusing the client itself, never the person's code.
    expect(["invalid_client", "incorrect_client_credentials"].map(clientRefused)).toEqual([true, true]);
    // A code expired or used, a cancel, another callback address, no code at all: another try can work.
    const others = ["invalid_grant", "bad_verification_code", "access_denied", "redirect_uri_mismatch", undefined];
    expect(others.map(clientRefused)).toEqual([false, false, false, false, false]);
    // GitHub says it with a 200 and its own code; other servers with OAuth's invalid_client.
    const answers = [
      () =>
        Response.json({
          error: "incorrect_client_credentials",
          error_description: "The client_id and/or client_secret passed are incorrect.",
        }),
      () => Response.json({ error: "invalid_client" }, { status: 401 }),
    ];
    for (const answer of answers) {
      const deps = depsOf(f, { http: (async () => answer()) as unknown as typeof fetch });
      const { state } = await startOAuth(deps, f.owner.id, f.org.id, "github");
      const failed = await completeOAuth(deps, { id: f.owner.id }, { state, code: "c" }).catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(MisconfiguredError);
      expect(failed).toMatchObject({ code: "connector.misconfigured", params: { provider: "GitHub" } });
    }
    // The person's code refused stays what it was: a refusal, which another try can get past.
    const expired = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as unknown as typeof fetch;
    const deps = depsOf(f, { http: expired });
    const { state } = await startOAuth(deps, f.owner.id, f.org.id, "github");
    const refused = await completeOAuth(deps, { id: f.owner.id }, { state, code: "c" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TokenRefused);
  });

  test("tokens about to expire are refreshed before a call", async () => {
    f = await setup();
    const token = tokenEndpoint();
    const deps = depsOf(f, { http: token.http });
    const { authorizeUrl, state } = await startOAuth(deps, f.owner.id, f.org.id, "github");
    token.setChallenge(new URL(authorizeUrl).searchParams.get("code_challenge") ?? "");
    const { connection } = await completeOAuth(deps, { id: f.owner.id }, { state, code: "good-code" });
    const soon = depsOf(f, { http: token.http, now: () => new Date(Date.now() + 3590_000) });
    expect(await connectionHeaders(soon, connection)).toEqual({ authorization: "Bearer gho_token_2" });
    expect(token.seen.at(-1)?.get("grant_type")).toBe("refresh_token");
    expect(token.seen.at(-1)?.get("refresh_token")).toBe("ghr_refresh_1");
  });

  test("a refreshed token keeps the tools as listed; a new sign-in lists them again", async () => {
    f = await setup();
    const token = tokenEndpoint();
    const deps = depsOf(f, { http: token.http });
    const signIn = async () => {
      const { authorizeUrl, state } = await startOAuth(deps, f.owner.id, f.org.id, "github");
      token.setChallenge(new URL(authorizeUrl).searchParams.get("code_challenge") ?? "");
      await completeOAuth(deps, { id: f.owner.id }, { state, code: "good-code" });
    };
    await signIn();
    const mcp = fakeGithubMcp();
    // A minute before the token ends: the first listing refreshes it. Each listing opens a session.
    const soon = depsOf(f, { http: token.http, now: () => new Date(Date.now() + 3590_000) });
    const source = createConnectorToolSource({ ...soon, connect: mcp.connect });
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    const names = async () => (await source.tools(ctx)).map((t) => t.name);
    const listed = await names();
    expect(listed.length).toBeGreaterThan(0);
    expect(token.seen.at(-1)?.get("grant_type")).toBe("refresh_token");
    expect(mcp.sessions.map((s) => s.headers.authorization)).toEqual(["Bearer gho_token_2"]);
    expect(await names()).toEqual(listed);
    expect(mcp.sessions).toHaveLength(1);

    await signIn();
    expect(await names()).toEqual(listed);
    expect(mcp.sessions).toHaveLength(2);
  });
});

describe("a sign-in that stops working", () => {
  const ctxOf = (fx: Fixture) => ({
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: crypto.randomUUID(),
    channelId: fx.general.id,
    threadRootId: crypto.randomUUID(),
    triggerMessageId: crypto.randomUUID(),
  });
  const rowOf = async (fx: Fixture, id: string) =>
    (await fx.db.select().from(schema.connectorConnections).where(eq(schema.connectorConnections.id, id)))[0];

  test("a refresh the provider refuses: Precisa reconectar, no tools; a busy provider marks nothing; Reconectar heals", async () => {
    f = await setup();
    let refresh: "busy" | "refused" | "ok" = "busy";
    let n = 0;
    const http = (async (_url: string, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "refresh_token" && refresh === "busy")
        return Response.json({ error: "server_error" }, { status: 503 });
      // GitHub says no with a 200.
      if (form.get("grant_type") === "refresh_token" && refresh === "refused")
        return Response.json({
          error: "bad_refresh_token",
          error_description: "The refresh token passed is incorrect",
        });
      n++;
      return Response.json({ access_token: `gho_token_${n}`, refresh_token: `ghr_refresh_${n}`, expires_in: 3600 });
    }) as unknown as typeof fetch;
    const deps = depsOf(f, { http });
    const signIn = async () => {
      const { state } = await startOAuth(deps, f.owner.id, f.org.id, "github");
      return (await completeOAuth(deps, { id: f.owner.id }, { state, code: "good-code" })).connection;
    };
    const connection = await signIn();
    const soon = depsOf(f, { http, now: () => new Date(Date.now() + 3590_000) });
    await expect(connectionHeaders(soon, connection)).rejects.not.toBeInstanceOf(TokenRefused);
    expect((await rowOf(f, connection.id))?.status).toBe("active");

    refresh = "refused";
    await expect(connectionHeaders(soon, connection)).rejects.toBeInstanceOf(TokenRefused);
    const dead = await rowOf(f, connection.id);
    expect(dead?.status).toBe("needs_reconnect");
    expect(dead?.lastError).toContain("The refresh token passed is incorrect");
    expect(dead && connectionView(dead).status).toBe("needs_reconnect");
    const mcp = fakeGithubMcp();
    const source = createConnectorToolSource({ ...soon, connect: mcp.connect });
    expect(await source.tools(ctxOf(f))).toEqual([]);

    refresh = "ok";
    const again = await signIn();
    expect((await rowOf(f, again.id))?.status).toBe("active");
    expect(connectionView(again).status).toBe("active");
  });

  test("a server that answers 401 to the connection's key: Precisa reconectar, its tools gone until a new one", async () => {
    f = await setup();
    const mcp = fakeGithubMcp();
    let revoked = true;
    const connect: typeof mcp.connect = async (c, headers) => {
      if (revoked) throw new StreamableHTTPError(401, "Error POSTing to endpoint: Bad credentials");
      return mcp.connect(c, headers);
    };
    const c = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    const source = createConnectorToolSource({ ...depsOf(f), connect });
    expect(await source.tools(ctxOf(f))).toEqual([]);
    expect(await rowOf(f, c.id)).toMatchObject({ status: "needs_reconnect" });
    revoked = false;
    // Hidden until someone reconnects, even once the server would answer.
    expect(await source.tools(ctxOf(f))).toEqual([]);
    const fresh = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_other_654321",
    });
    expect(fresh.status).toBe("active");
    expect((await source.tools(ctxOf(f))).length).toBeGreaterThan(0);
  });
});
