import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { schema } from "@agenteschat/db";
import {
  appPermissionsFor,
  CONNECTOR_CATALOG,
  type ConnectorDeps,
  createApiKeyConnection,
  createConnectorToolSource,
  type GitHubAppConfig,
  githubAppManifest,
  SIGNATURE_MARK,
  syncGitHubAppConnection,
  type ToolContext,
} from "../src";
import { fakeGithubMcp } from "./fake-mcp";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP: GitHubAppConfig = {
  appId: "123",
  privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  slug: "agentes-chat",
};
const API = "https://api.github.test";

/**
 * GitHub's REST API for the app: `acme/*` is installation 1's; the person's GitHub account is 583231. `refuse`: a
 * permission installation 1 hasn't accepted (GitHub answers 422 to any set that asks it).
 */
function fakeRest(refuse?: string) {
  const minted: { body: Record<string, unknown> }[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (/\/repos\/acme\/[^/]+\/installation$/.test(url)) return Response.json({ id: 1 });
    if (url.includes("/repos/")) return new Response("not found", { status: 404 });
    if (url.endsWith("/app/installations/1/access_tokens")) {
      const body = JSON.parse(String(init?.body)) as { permissions?: Record<string, string> };
      if (refuse && body.permissions && refuse in body.permissions) return new Response("refused", { status: 422 });
      minted.push({ body });
      return Response.json(
        { token: `ghs_app_${minted.length}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
        { status: 201 },
      );
    }
    if (url === `${API}/user/583231`) return Response.json({ login: "ana-gh" });
    return new Response("unexpected", { status: 500 });
  }) as typeof globalThis.fetch;
  return { fetch: fake, minted };
}

async function world(options: { account?: boolean; refuse?: string } = {}) {
  f = await setup();
  const mcp = fakeGithubMcp({ writes: true });
  const rest = fakeRest(options.refuse);
  const deps: ConnectorDeps = { db: f.db, keyWrappers: [f.keyWrapper], publicUrl: "https://chat.example.com" };
  if (options.account) {
    await createApiKeyConnection(deps, f.owner.id, f.org.id, { connector: "github", apiKey: "ghp_secret_123456" });
  }
  await f.db.insert(schema.githubAppInstallations).values({
    orgId: f.org.id,
    installationId: 1,
    accountLogin: "acme",
    accountType: "Organization",
    createdByUserId: f.owner.id,
  });
  await syncGitHubAppConnection(f.db, f.org.id, { type: "person", id: f.owner.id });
  const source = createConnectorToolSource({
    ...deps,
    connect: mcp.connect,
    githubApp: { app: () => APP, http: { fetch: rest.fetch, apiUrl: API } },
  });
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: crypto.randomUUID(),
    channelId: f.general.id,
    threadRootId: crypto.randomUUID(),
    triggerMessageId: crypto.randomUUID(),
  };
  const call = async (name: string, input: Record<string, unknown>) => {
    const tool = (await source.tools(ctx)).find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    const before = mcp.sessions.length;
    const out = await tool.execute(input, ctx);
    const session = mcp.sessions.length > before ? mcp.sessions.at(-1) : undefined;
    return { out, auth: session?.headers.authorization, args: mcp.calls.at(-1)?.args };
  };
  return { mcp, rest, source, ctx, call };
}

describe("GitHub's tools act as the app where it is installed (ADR 0156)", () => {
  test("what the app's token may do, by the tool's scope: most first", () => {
    expect(appPermissionsFor("push_files", "repo.write")).toEqual([
      { contents: "write", workflows: "write" },
      { contents: "write" },
    ]);
    expect(appPermissionsFor("pull_request_read", "pr.read")).toEqual([
      { pull_requests: "read", checks: "read", statuses: "read" },
    ]);
    expect(appPermissionsFor("merge_pull_request", "pr.merge")).toEqual([
      { contents: "write", pull_requests: "write" },
    ]);
    expect(appPermissionsFor("update_pull_request_branch", "pr.write")).toEqual([
      { pull_requests: "write", contents: "write" },
    ]);
    expect(appPermissionsFor("actions_run_trigger", "actions.run")).toEqual([{ actions: "write" }]);
    // An organization's Projects; an item's title and fields are its issue's or pull request's.
    expect(appPermissionsFor("projects_list", "projects.read")).toEqual([
      { organization_projects: "read", issues: "read", pull_requests: "read" },
      { organization_projects: "read" },
    ]);
    expect(appPermissionsFor("projects_write", "projects.write")).toEqual([
      { organization_projects: "write", issues: "read", pull_requests: "read" },
      { organization_projects: "write" },
    ]);
    // A pull request's number goes through the issues endpoints too (comments, labels, assignees).
    expect(appPermissionsFor("add_issue_comment", "issues.write")).toEqual([
      { issues: "write", pull_requests: "write" },
      { issues: "write" },
    ]);
    expect(appPermissionsFor("issue_read", "issues.read")).toEqual([
      { issues: "read", pull_requests: "read" },
      { issues: "read" },
    ]);
  });

  test("the widened scopes ask only what their tools need: each kind of security alert its own permission", () => {
    expect(appPermissionsFor("create_repository", "repo.admin")).toEqual([{ administration: "write" }]);
    expect(appPermissionsFor("delete_repository", "repo.admin")).toEqual([{ administration: "write" }]);
    expect(appPermissionsFor("create_repository_ruleset", "repo.admin")).toEqual([{ administration: "write" }]);
    expect(appPermissionsFor("repository_ruleset_read", "repo.read")).toEqual([
      { administration: "read" },
      { metadata: "read" },
    ]);
    expect(appPermissionsFor("list_discussions", "discussions.read")).toEqual([{ discussions: "read" }]);
    expect(appPermissionsFor("discussion_comment_write", "discussions.write")).toEqual([{ discussions: "write" }]);
    expect(appPermissionsFor("label_write", "issues.write")).toEqual([
      { issues: "write", pull_requests: "write" },
      { issues: "write" },
    ]);
    expect(appPermissionsFor("get_team_members", "org.read")).toEqual([{ members: "read" }]);
    expect(appPermissionsFor("get_code_scanning_alert", "security.read")).toEqual([{ security_events: "read" }]);
    expect(appPermissionsFor("list_dependabot_alerts", "security.read")).toEqual([{ vulnerability_alerts: "read" }]);
    expect(appPermissionsFor("get_secret_scanning_alert", "security.read")).toEqual([
      { secret_scanning_alerts: "read" },
    ]);
    expect(appPermissionsFor("list_repository_security_advisories", "security.read")).toEqual([
      { repository_advisories: "read" },
    ]);
    expect(appPermissionsFor("list_org_repository_security_advisories", "security.read")).toEqual([
      { repository_advisories: "write" },
    ]);
  });

  test("every GitHub tool can go as the app, asking only permissions the app's manifest has", () => {
    const granted: Record<string, string> = githubAppManifest("https://chat.example.com").default_permissions;
    const beyond: string[] = [];
    for (const [name, tool] of Object.entries(CONNECTOR_CATALOG.github?.tools ?? {})) {
      if (tool.ours) continue;
      const sets = appPermissionsFor(name, tool.scope);
      if (!sets) beyond.push(`${name}: no permissions`);
      for (const [permission, level] of (sets ?? []).flatMap((set) => Object.entries(set))) {
        const has = granted[permission];
        if (!has || (level === "write" && has !== "write")) beyond.push(`${name}: ${permission} ${level}`);
      }
    }
    expect(beyond).toEqual([]);
  });

  test("a covered repository goes with its app token; anywhere else with the account, as before", async () => {
    const w = await world({ account: true });
    const covered = await w.call("github_add_issue_comment", {
      owner: "acme",
      repo: "api",
      issue_number: 4,
      body: "Done",
    });
    expect(covered.auth).toBe("Bearer ghs_app_1");
    expect(w.rest.minted.at(-1)?.body).toEqual({
      repositories: ["api"],
      permissions: { issues: "write", pull_requests: "write" },
    });
    const elsewhere = await w.call("github_add_issue_comment", {
      owner: "other",
      repo: "x",
      issue_number: 1,
      body: "Hi",
    });
    expect(elsewhere.auth).toBe("Bearer ghp_secret_123456");
    // An account named alone: that installation's token.
    expect((await w.call("github_list_issue_types", { owner: "acme" })).auth).toBe("Bearer ghs_app_2");
    expect((await w.call("github_list_issue_types", { owner: "someone" })).auth).toBe("Bearer ghp_secret_123456");
  });

  test("through the app alone: listed with the installation's token, uncovered repositories refused", async () => {
    const w = await world();
    const listed = (await w.source.tools(w.ctx)).map((t) => t.name);
    expect(listed).toContain("github_add_issue_comment");
    expect(listed).toContain("github_projects_list");
    expect(w.mcp.sessions[0]?.headers.authorization).toBe("Bearer ghs_app_1");
    expect(w.rest.minted[0]?.body).toEqual({ permissions: { metadata: "read" } });

    const refused = await w.call("github_add_issue_comment", {
      owner: "other",
      repo: "x",
      issue_number: 1,
      body: "Hi",
    });
    expect(refused.out).toMatchObject({ isError: true });
    expect(refused.out.content).toContain("isn't installed on other/x");
    expect(refused.auth).toBeUndefined();
    expect(
      (await w.call("github_add_issue_comment", { owner: "acme", repo: "app", issue_number: 1, body: "Hi" })).auth,
    ).toStartWith("Bearer ghs_app_");
  });
});

describe("where the agent's words went on GitHub is kept with its conversation", () => {
  test("a pull request it opened is its own; an issue it commented on is kept too; reads and failures aren't", async () => {
    const w = await world();
    await w.call("github_create_pull_request", { owner: "acme", repo: "App", title: "T", head: "a", base: "main" });
    await w.call("github_add_issue_comment", { owner: "acme", repo: "api", issue_number: 4, body: "On it" });
    await w.call("github_pull_request_read", { owner: "acme", repo: "app", pullNumber: 3 });
    await w.call("github_add_issue_comment", { owner: "other", repo: "x", issue_number: 1, body: "Refused" });
    const items = await f.db.select().from(schema.githubItems).orderBy(schema.githubItems.repo);
    expect(
      items.map((i) => ({
        repo: i.repo,
        number: i.number,
        authored: i.authored,
        agentId: i.agentId,
        channelId: i.channelId,
        threadId: i.threadId,
        runId: i.runId,
      })),
    ).toEqual([
      {
        repo: "acme/api",
        number: 4,
        authored: false,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadId: w.ctx.threadRootId,
        runId: w.ctx.runId,
      },
      {
        repo: "acme/app",
        number: 12,
        authored: true,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadId: w.ctx.threadRootId,
        runId: w.ctx.runId,
      },
    ]);
  });
});

describe("what only an organization's installation reaches (ADR 0156, addendum)", () => {
  const personal = () =>
    f.db.insert(schema.githubAppInstallations).values({
      orgId: f.org.id,
      installationId: 2,
      accountLogin: "ana-gh",
      accountType: "User",
      createdByUserId: f.owner.id,
    });

  test("Projects and new repositories go as the app on an organization; a person's need an account", async () => {
    const w = await world();
    await personal();
    const projects = await w.call("github_projects_list", { owner: "acme" });
    expect(projects.auth).toStartWith("Bearer ghs_app_");
    expect(w.rest.minted.at(-1)?.body).toEqual({
      permissions: { organization_projects: "read", issues: "read", pull_requests: "read" },
    });
    const theirs = await w.call("github_projects_list", { owner: "ana-gh" });
    expect(theirs.out.content).toContain("This needs a GitHub account");
    expect(theirs.auth).toBeUndefined();
    expect((await w.call("github_create_repository", { name: "site" })).out.content).toContain(
      "This needs a GitHub account",
    );
    const created = await w.call("github_create_repository", { name: "site", organization: "acme" });
    expect(created.auth).toStartWith("Bearer ghs_app_");
    expect(w.rest.minted.at(-1)?.body).toEqual({ permissions: { administration: "write" } });
  });

  test("with an account too, a person's Projects go as the account", async () => {
    const w = await world({ account: true });
    await personal();
    expect((await w.call("github_projects_list", { owner: "ana-gh" })).auth).toBe("Bearer ghp_secret_123456");
    expect((await w.call("github_create_repository", { name: "site" })).auth).toBe("Bearer ghp_secret_123456");
  });

  test("an organization's tools name it as org: that installation's token, with the tool's permission", async () => {
    const w = await world();
    expect((await w.call("github_get_team_members", { org: "acme", team_slug: "core" })).auth).toStartWith(
      "Bearer ghs_app_",
    );
    expect(w.rest.minted.at(-1)?.body).toEqual({ permissions: { members: "read" } });
    await w.call("github_list_org_repository_security_advisories", { org: "acme" });
    expect(w.rest.minted.at(-1)?.body).toEqual({ permissions: { repository_advisories: "write" } });
    await w.call("github_list_code_scanning_alerts", { owner: "acme", repo: "api" });
    expect(w.rest.minted.at(-1)?.body).toEqual({ repositories: ["api"], permissions: { security_events: "read" } });
  });

  test("an installation that hasn't accepted a new permission: the account does it, or the agent says who accepts", async () => {
    const alone = await world({ refuse: "discussions" });
    const input = { owner: "acme", repo: "app", method: "add", discussionNumber: 3, body: "Thanks" };
    const refused = await alone.call("github_discussion_comment_write", input);
    expect(refused.out.content).toContain("accepts the app's new permissions on GitHub");
    expect(refused.auth).toBeUndefined();
    await f.close();
    const withAccount = await world({ account: true, refuse: "discussions" });
    expect((await withAccount.call("github_discussion_comment_write", input)).auth).toBe("Bearer ghp_secret_123456");
  });
});

describe("what agents write on GitHub is signed (ADR 0156)", () => {
  test("bodies end with one line naming the agent and the person; an edit replaces the old one", async () => {
    const w = await world({ account: true });
    const line = `${SIGNATURE_MARK}\n<sub>Dev, agente de ana no agentes.chat</sub>`;
    const first = await w.call("github_add_issue_comment", {
      owner: "acme",
      repo: "app",
      issue_number: 1,
      body: "Fixed.",
    });
    expect(first.args?.body).toBe(`Fixed.\n\n${line}`);
    // Signed whichever token: the account's too.
    const other = await w.call("github_add_issue_comment", { owner: "other", repo: "x", issue_number: 1, body: "Ok" });
    expect(other.args?.body).toBe(`Ok\n\n${line}`);
    const edit = await w.call("github_update_issue_comment", {
      owner: "acme",
      repo: "app",
      comment_id: 9,
      body: `Fixed, and tested.\n\n${line}`,
    });
    expect(edit.args?.body).toBe(`Fixed, and tested.\n\n${line}`);
    // Only where a body is given; a pull request always gets one.
    const titled = await w.call("github_issue_write", { owner: "acme", repo: "app", method: "update", title: "New" });
    expect(titled.args).not.toHaveProperty("body");
    const pr = await w.call("github_create_pull_request", {
      owner: "acme",
      repo: "app",
      title: "T",
      head: "a",
      base: "main",
    });
    expect(pr.args?.body).toBe(line);
  });

  test("API commits credit the person when they linked GitHub to sign in", async () => {
    const w = await world({ account: true });
    const files = [{ path: "a.txt", content: "x" }];
    const plain = await w.call("github_push_files", { owner: "acme", repo: "app", branch: "b", files, message: "Fix" });
    expect(plain.args?.message).toBe("Fix");
    await f.db.insert(schema.accounts).values({
      id: crypto.randomUUID(),
      accountId: "583231",
      providerId: "github",
      userId: f.owner.id,
    });
    const credited = await w.call("github_push_files", {
      owner: "acme",
      repo: "app",
      branch: "b",
      files,
      message: "Fix login\n\nSigned-off-by: Dev <dev@example.com>",
    });
    expect(credited.args?.message).toBe(
      "Fix login\n\nSigned-off-by: Dev <dev@example.com>\nCo-authored-by: ana <583231+ana-gh@users.noreply.github.com>",
    );
  });
});
