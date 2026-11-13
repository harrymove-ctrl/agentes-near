import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { desc, eq, schema } from "@agenteschat/db";
import {
  agentMergeRepos,
  agentRepositoryList,
  type ConnectorDeps,
  cleanRepoList,
  connectorGrantValidator,
  createAgentRuns,
  createApiKeyConnection,
  createConnectorToolSource,
  createGitToolSource,
  createToolGateway,
  dropAgentRules,
  ForbiddenError,
  getAgentMergeRepositories,
  getAgentRepositories,
  githubOrgAccess,
  insertMessage,
  invokeToolForRun,
  listOrgRepositories,
  listRuns,
  mergeReposOfCall,
  normalizeRepoEntry,
  postPersonMessage,
  repoInList,
  repositoriesPrompt,
  reposOfGithubCall,
  revokeConnection,
  setAgentMergeRepositories,
  setAgentRepositories,
  setAgentScopes,
  type ToolContext,
  takeBridgeEffects,
  ValidationError,
  wrapExternal,
} from "../src";
import { fakeGithubMcp } from "./fake-mcp";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const PUBLIC_URL = "https://agentes.test";
const API = "https://api.github.test";
const depsOf = (fx: Fixture): ConnectorDeps => ({ db: fx.db, keyWrappers: [fx.keyWrapper], publicUrl: PUBLIC_URL });

describe("the list", () => {
  test("entries: owner/name, owner/*, URLs and .git; anything else is refused", () => {
    expect(normalizeRepoEntry(" acme/app ")).toBe("acme/app");
    expect(normalizeRepoEntry("https://github.com/acme/app.git")).toBe("acme/app");
    expect(normalizeRepoEntry("git@github.com:acme/app.git")).toBe("acme/app");
    expect(normalizeRepoEntry("acme/*")).toBe("acme/*");
    for (const bad of ["acme", "acme/app/x", "/app", "acme/..", "ac me/app", "*/app", ""]) {
      expect(normalizeRepoEntry(bad)).toBeNull();
    }
  });

  test("matching is case-insensitive; owner/* takes the whole account; empty allows everything", () => {
    expect(repoInList([], "x", "y")).toBe(true);
    expect(repoInList(["Acme/App"], "acme", "app")).toBe(true);
    expect(repoInList(["acme/app"], "acme", "api")).toBe(false);
    expect(repoInList(["acme/*"], "ACME", "anything")).toBe(true);
    expect(repoInList(["acme/*"], "beta", "app")).toBe(false);
  });

  test("cleaning keeps the order, drops repeats and repositories an account already covers", () => {
    expect(cleanRepoList(["acme/api", "walt/notes", "ACME/api", "acme/*", "acme/web", "nope"])).toEqual({
      list: ["walt/notes", "acme/*"],
      invalid: ["nope"],
    });
  });

  test("the repositories a call names: owner + repo, repo, or a search's repo: qualifiers", () => {
    expect(reposOfGithubCall({ owner: "acme", repo: "app", pullNumber: 1 })).toEqual(["acme/app"]);
    expect(reposOfGithubCall({ repo: "https://github.com/acme/app" })).toEqual(["acme/app"]);
    expect(reposOfGithubCall({ query: "token repo:acme/app repo:acme/api" })).toEqual(["acme/app", "acme/api"]);
    // A search over whole accounts, or with no repository: names none.
    expect(reposOfGithubCall({ query: "token repo:acme/app org:beta" })).toBeNull();
    expect(reposOfGithubCall({ query: "token" })).toBeNull();
    expect(reposOfGithubCall({ number: 1 })).toBeNull();
  });

  test("the prompt says the repositories and where to start", () => {
    expect(repositoriesPrompt([])).toBe("");
    const text = repositoriesPrompt(["acme/app", "walt/*"]);
    expect(text).toContain("# Your GitHub repositories");
    expect(text).toContain("acme/app, every repository of walt (walt/*)");
    expect(text).toContain("When nobody names a repository, work in acme/app.");
    expect(repositoriesPrompt(["walt/*"])).toContain("search the repositories of walt first (search_code)");
  });
});

describe("saving", () => {
  test("in order, by admins or the agent's owner; audited", async () => {
    f = await setup();
    expect(await getAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id)).toEqual([]);
    expect(
      await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["walt/notes", "acme/app", "acme/app"]),
    ).toEqual(["walt/notes", "acme/app"]);
    expect(await agentRepositoryList(f.db, f.org.id, f.agent.id)).toEqual(["walt/notes", "acme/app"]);
    // Reordered: the first is where it starts.
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app", "walt/notes"]);
    expect(await getAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id)).toEqual(["acme/app", "walt/notes"]);

    await expect(setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme"])).rejects.toBeInstanceOf(
      ValidationError,
    );
    const member = await addMember(f.db, f.org.id, "member");
    await expect(setAgentRepositories(f.db, member.id, f.org.id, f.agent.id, [])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // Members read it.
    expect(await getAgentRepositories(f.db, member.id, f.org.id, f.agent.id)).toEqual(["acme/app", "walt/notes"]);
    // The agent's owner (not an admin) only narrows it: more repositories, or every one (empty), is an admin's call.
    await f.db.update(schema.agents).set({ ownerUserId: member.id }).where(eq(schema.agents.id, f.agent.id));
    for (const wider of [[], ["acme/app", "acme/infra"], ["acme/*"]]) {
      await expect(setAgentRepositories(f.db, member.id, f.org.id, f.agent.id, wider)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect(await setAgentRepositories(f.db, member.id, f.org.id, f.agent.id, ["ACME/app"])).toEqual(["ACME/app"]);
    // An admin widens it again.
    expect(await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, [])).toEqual([]);
    const audits = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "agent.repositories_changed"));
    expect(audits.map((a) => a.details)).toEqual([
      { repositories: ["walt/notes", "acme/app"] },
      { repositories: ["acme/app", "walt/notes"] },
      { repositories: ["ACME/app"] },
      { repositories: [] },
    ]);
  });
});

describe('"Pode fazer merge sem perguntar": who chooses, and what', () => {
  test("its owner or an admin, exact repositories it may use; audited", async () => {
    f = await setup();
    const set = (userId: string, list: string[]) => setAgentMergeRepositories(f.db, userId, f.org.id, f.agent.id, list);
    expect(await getAgentMergeRepositories(f.db, f.owner.id, f.org.id, f.agent.id)).toEqual([]);
    expect(await set(f.owner.id, ["acme/app", "ACME/app", "https://github.com/acme/api.git"])).toEqual([
      "acme/app",
      "acme/api",
    ]);
    // A whole account is never chosen in one go, and neither is what isn't a repository.
    await expect(set(f.owner.id, ["acme/*"])).rejects.toBeInstanceOf(ValidationError);
    await expect(set(f.owner.id, ["acme"])).rejects.toBeInstanceOf(ValidationError);
    const member = await addMember(f.db, f.org.id, "member");
    await expect(set(member.id, [])).rejects.toBeInstanceOf(ForbiddenError);
    await f.db.update(schema.agents).set({ ownerUserId: member.id }).where(eq(schema.agents.id, f.agent.id));
    expect(await set(member.id, ["acme/app"])).toEqual(["acme/app"]);
    const audits = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "agent.merge_repositories_changed"));
    expect(audits.map((a) => [a.actorId, a.details])).toEqual([
      [f.owner.id, { repositories: ["acme/app", "acme/api"] }],
      [member.id, { repositories: ["acme/app"] }],
    ]);
  });

  test("only within the agent's repositories; one taken from the agent stops at once", async () => {
    f = await setup();
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/*", "labs/notes"]);
    await expect(
      setAgentMergeRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["beta/app"]),
    ).rejects.toBeInstanceOf(ValidationError);
    await setAgentMergeRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app", "labs/notes"]);
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["labs/notes"]);
    expect(await agentMergeRepos(f.db, f.org.id, f.agent.id)).toEqual(["labs/notes"]);
  });

  test("a new owner decides afresh: handing the agent over clears it, audited", async () => {
    f = await setup();
    await setAgentMergeRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app"]);
    await dropAgentRules(f.db, f.org.id, [f.agent.id], { type: "person", id: f.owner.id });
    expect(await agentMergeRepos(f.db, f.org.id, f.agent.id)).toEqual([]);
    const [audit] = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "agent.merge_repositories_changed"))
      // By id (UUIDv7): two audits in the same millisecond share a createdAt.
      .orderBy(desc(schema.auditLog.id));
    expect(audit?.details).toEqual({ repositories: [], reason: "owner_changed" });
  });
});

describe('"Pode fazer merge sem perguntar": the GitHub connector', () => {
  async function world() {
    f = await setup();
    const github = fakeGithubMcp();
    const deps = { ...depsOf(f), connect: github.connect };
    const connection = await createApiKeyConnection(deps, f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, [
      { connectionId: connection.id, scope: "github:pr.merge" },
    ]);
    const gateway = createToolGateway({ sources: [createConnectorToolSource(deps)] });
    const ctx = await runContext(f);
    const merge = (repo: string, pullNumber: number, why?: string) =>
      gateway.invoke(ctx, {
        toolUseId: crypto.randomUUID(),
        name: "github_merge_pull_request",
        input: { owner: repo.split("/")[0], repo: repo.split("/")[1], pullNumber, ...(why ? { why } : {}) },
      });
    return { github, ctx, gateway, merge };
  }
  const WHY = "The checks passed and the change was reviewed: this action finishes what was asked.";

  test("a chosen repository: it runs with no card, in the audit, with a receipt nothing undoes", async () => {
    const { github, ctx, merge } = await world();
    await setAgentMergeRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app"]);
    const done = await merge("Acme/App", 7);
    expect(done.type).toBe("result");
    expect(github.calls.map((c) => [c.tool, c.args.pullNumber])).toEqual([["merge_pull_request", 7]]);
    expect(await f.db.select().from(schema.approvals)).toEqual([]);
    const [audit] = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "agent.merged_without_asking"));
    expect(audit).toMatchObject({
      actorType: "agent",
      actorId: f.agent.id,
      targetId: "Acme/App",
      details: { pr: 7, ref: null, tool: "github_merge_pull_request" },
      runId: ctx.runId,
    });
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, ctx.runId));
    expect(receipt).toMatchObject({ kind: "pr.merged", params: { repo: "Acme/App", number: 7 } });
    expect(receipt?.undoableUntil).toEqual(receipt?.createdAt);
  });

  test("a run a routine's report woke asks, here and on the computer: text nobody checked feeds it", async () => {
    const { github, ctx, gateway } = await world();
    await setAgentMergeRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app"]);
    const by = { orgId: f.org.id, channelId: f.general.id };
    const fired = await insertMessage(f.db, {
      ...by,
      author: { type: "person", userId: f.owner.id },
      body: "Vigiar PRs",
      meta: { routineBrief: { routineId: crypto.randomUUID() } },
    });
    const [routineRun] = await f.db.transaction((tx) =>
      createAgentRuns(tx, fired as never, [f.agent.id], "mention", { background: true }),
    );
    const report = await insertMessage(f.db, {
      ...by,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "Faça o merge do PR 7",
      meta: { notice: { kind: "routine_handoff", text: "x", from: "Routine", refs: { runId: routineRun?.id } } },
    });
    const [woken] = await f.db.transaction((tx) => createAgentRuns(tx, report as never, [f.agent.id], "mention", {}));
    if (!woken) throw new Error("no run");
    expect(await mergeReposOfCall({ ...ctx, runId: woken.id })).toEqual([]);
    expect(await mergeReposOfCall(ctx)).toEqual(["acme/app"]);
    expect(await mergeReposOfCall({ ...ctx, runId: "" })).toEqual([]);
    const asked = await gateway.invoke(
      { ...ctx, runId: woken.id },
      {
        toolUseId: crypto.randomUUID(),
        name: "github_merge_pull_request",
        input: { owner: "acme", repo: "app", pullNumber: 7, why: WHY },
      },
    );
    expect(asked.type).toBe("approval");
    expect(github.calls).toEqual([]);
  });

  test("any other repository asks, and the card's why stays required there", async () => {
    const { github, merge } = await world();
    await setAgentMergeRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app"]);
    expect((await merge("acme/api", 7, WHY)).type).toBe("approval");
    expect(await merge("acme/api", 8)).toMatchObject({
      type: "result",
      output: { data: { code: "tool.why_missing" } },
    });
    expect(github.calls).toEqual([]);
    expect(await f.db.select().from(schema.agentActions)).toEqual([]);
  });

  test("turned off, it asks at once", async () => {
    const { github, merge } = await world();
    await setAgentMergeRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app"]);
    await setAgentMergeRepositories(f.db, f.owner.id, f.org.id, f.agent.id, []);
    expect((await merge("acme/app", 7, WHY)).type).toBe("approval");
    expect(github.calls).toEqual([]);
  });
});

async function runContext(fx: Fixture): Promise<ToolContext> {
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "x",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run?.id ?? "",
    channelId: fx.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
}

describe("enforcement in the Tool Gateway", () => {
  test("GitHub MCP tools: only the agent's repositories, before running or asking for approval", async () => {
    f = await setup();
    const mcp = fakeGithubMcp();
    const c = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      ["github:pr.read", "github:pr.merge", "github:issues.read"].map((scope) => ({ connectionId: c.id, scope })),
      connectorGrantValidator,
    );
    const gateway = createToolGateway({ sources: [createConnectorToolSource({ ...depsOf(f), connect: mcp.connect })] });
    const ctx = await runContext(f);
    const pr = (owner: string, repo: string) => ({ owner, repo, pullNumber: 4 });

    // No list: every repository; the result says which one it touched.
    expect(
      await gateway.invoke(ctx, { toolUseId: "a", name: "github_pull_request_read", input: pr("x", "y") }),
    ).toMatchObject({ type: "result", output: { data: { repo: "x/y" } } });

    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app", "walt/*"]);
    expect(
      await gateway.invoke(ctx, { toolUseId: "b", name: "github_pull_request_read", input: pr("acme", "app") }),
    ).toMatchObject({
      type: "result",
      output: { content: wrapExternal("github_pull_request_read", "PR #4: fix token refresh (checks passing)") },
    });
    expect(
      await gateway.invoke(ctx, { toolUseId: "c", name: "github_pull_request_read", input: pr("walt", "anything") }),
    ).toMatchObject({ type: "result", output: { data: { repo: "walt/anything" } } });

    const denied = await gateway.invoke(ctx, {
      toolUseId: "d",
      name: "github_pull_request_read",
      input: pr("acme", "infra"),
    });
    expect(denied).toMatchObject({ type: "result", output: { isError: true, data: { deniedRepo: "acme/infra" } } });
    expect(denied.type === "result" && denied.output.content).toContain(
      "acme/infra isn't one of your GitHub repositories",
    );

    // A merge outside the list: refused, no approval asked.
    const merge = await gateway.invoke(ctx, {
      toolUseId: "e",
      name: "github_merge_pull_request",
      input: pr("acme", "infra"),
    });
    expect(merge).toMatchObject({ type: "result", output: { isError: true, data: { deniedRepo: "acme/infra" } } });
    expect(await f.db.select().from(schema.approvals)).toEqual([]);
    // Inside the list it still asks a person.
    expect(
      (
        await gateway.invoke(ctx, {
          toolUseId: "f",
          name: "github_merge_pull_request",
          input: { ...pr("acme", "app"), why: "CI passed and the review is done: merging ships the fix today." },
        })
      ).type,
    ).toBe("approval");

    // A call that names no repository can't run while the agent has a list.
    expect(
      await gateway.invoke(ctx, { toolUseId: "g", name: "github_issue_read", input: { number: 1 } }),
    ).toMatchObject({
      type: "result",
      output: { isError: true, data: {} },
    });
    expect(mcp.calls.map((x) => `${x.tool} ${x.args.owner}/${x.args.repo}`)).toEqual([
      "pull_request_read x/y",
      "pull_request_read acme/app",
      "pull_request_read walt/anything",
    ]);
  });

  test("a computer brain's calls through the runner bridge get the same limits, and the run keeps the refusal", async () => {
    f = await setup();
    const mcp = fakeGithubMcp();
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
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app"]);
    const tools = createToolGateway({ sources: [createConnectorToolSource({ ...depsOf(f), connect: mcp.connect })] });
    const ctx = await runContext(f);
    // The engine builds the transcript before a computer turn; the bridge keeps effects on it.
    await f.db.update(schema.agentRuns).set({ transcript: {} }).where(eq(schema.agentRuns.id, ctx.runId));
    const deps = { db: f.db, pubsub: f.pubsub, tools };
    const id = { orgId: f.org.id, agentId: f.agent.id, runId: ctx.runId, machineId: "m-1" };
    const pr = (owner: string, repo: string) => ({ owner, repo, pullNumber: 4 });

    const denied = await invokeToolForRun(deps, id, {
      id: "b-1",
      name: "github_pull_request_read",
      input: pr("acme", "infra"),
    });
    expect(denied).toMatchObject({ result: { isError: true }, code: "tool.not_allowed" });
    expect(denied.result.content).toContain("acme/infra isn't one of your GitHub repositories");
    const allowed = await invokeToolForRun(deps, id, {
      id: "b-2",
      name: "github_pull_request_read",
      input: pr("acme", "app"),
    });
    expect(allowed.result.isError).toBeUndefined();
    expect(mcp.calls.map((x) => `${x.tool} ${x.args.owner}/${x.args.repo}`)).toEqual(["pull_request_read acme/app"]);
    // What the engine takes at the end of the turn: the refused repository and the one it worked in.
    expect(await takeBridgeEffects(f.db, ctx.runId)).toMatchObject({ deniedRepo: "acme/infra", repo: "acme/app" });
  });

  test("open_pull_request outside the list never reaches GitHub", async () => {
    f = await setup();
    const connectors = depsOf(f);
    const connection = await createApiKeyConnection(connectors, f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [{ connectionId: connection.id, scope: "github:pr.write" }],
      connectorGrantValidator,
    );
    const calls: string[] = [];
    const github = {
      apiUrl: API,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        if (String(input).endsWith("/pulls"))
          return Response.json({ number: 9, html_url: "https://x/9" }, { status: 201 });
        return Response.json({ default_branch: "main" });
      }) as typeof fetch,
    };
    const gateway = createToolGateway({
      sources: [createGitToolSource({ sandbox: {} as never, connectors, github })],
    });
    const ctx = await runContext(f);
    await setAgentRepositories(f.db, f.owner.id, f.org.id, f.agent.id, ["acme/app"]);
    const open = (repo: string, id: string) =>
      gateway.invoke(ctx, {
        toolUseId: id,
        name: "open_pull_request",
        input: { repo, branch: "agentes/dev/x", title: "t" },
      });
    expect(await open("acme/infra", "a")).toMatchObject({
      output: { isError: true, data: { deniedRepo: "acme/infra" } },
    });
    expect(calls).toEqual([]);
    expect(await open("acme/app", "b")).toMatchObject({ output: { content: "Opened PR #9: https://x/9" } });
    expect(calls).toEqual([`GET ${API}/repos/acme/app`, `POST ${API}/repos/acme/app/pulls`]);
  });
});

test("runs say the repository they worked in and the one they were refused", async () => {
  f = await setup();
  const ctx = await runContext(f);
  await f.db
    .update(schema.agentRuns)
    .set({ transcript: { repo: "acme/app", deniedRepo: "acme/infra" } })
    .where(eq(schema.agentRuns.id, ctx.runId));
  const [run] = await listRuns(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  expect(run).toMatchObject({ repo: "acme/app", deniedRepo: "acme/infra" });
});

describe("the organization's repositories", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const APP = { appId: "1", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
  const repo = (full: string, extra: Record<string, unknown> = {}) => ({
    full_name: full,
    name: full.split("/")[1],
    private: true,
    pushed_at: "2026-10-01T00:00:00Z",
    owner: { login: full.split("/")[0], type: full.startsWith("acme/") ? "Organization" : "User" },
    ...extra,
  });

  test("the organizations a connection reaches, read live, for who manages connectors", async () => {
    f = await setup();
    await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, { connector: "github", apiKey: "ghp_user_token" });
    let orgs = [{ login: "acme" }];
    const fetch = (async (input: string | URL | Request) =>
      String(input) === `${API}/user/orgs?per_page=100`
        ? Response.json(orgs)
        : new Response("no", { status: 500 })) as typeof globalThis.fetch;
    const connectors = { ...depsOf(f), oauthApps: { github: { clientId: "Ov23li", clientSecret: "fake" } } };
    const deps = { db: f.db, connectors, github: { apiUrl: API, fetch } };

    // An API key isn't our app's: no page of ours on GitHub to send anyone to.
    expect(await githubOrgAccess(deps, f.owner.id, f.org.id)).toEqual({ orgs: ["acme"], manageUrl: null });
    await f.db
      .update(schema.connectorConnections)
      .set({ authType: "oauth" })
      .where(eq(schema.connectorConnections.orgId, f.org.id));
    orgs = [{ login: "acme" }, { login: "beta" }];
    expect(await githubOrgAccess(deps, f.owner.id, f.org.id)).toEqual({
      orgs: ["acme", "beta"],
      manageUrl: "https://github.com/settings/connections/applications/Ov23li",
    });
    const down = { ...deps, github: { apiUrl: API, fetch: (async () => new Response("", { status: 502 })) as never } };
    expect((await githubOrgAccess(down, f.owner.id, f.org.id)).orgs).toBeNull();
    const member = await addMember(f.db, f.org.id, "member");
    await expect(githubOrgAccess(deps, member.id, f.org.id)).rejects.toThrow();
  });

  test("back from granting an organization on GitHub, its repositories show at once, not when the listing expires", async () => {
    f = await setup();
    await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, { connector: "github", apiKey: "ghp_user_token" });
    let repos = [repo("walt/one")];
    const fetch = (async (input: string | URL | Request) =>
      Response.json(String(input).includes("/user/orgs") ? [{ login: "acme" }] : repos)) as typeof globalThis.fetch;
    const deps = { db: f.db, connectors: depsOf(f), github: { apiUrl: API, fetch } };
    const logins = async () => (await listOrgRepositories(deps, f.owner.id, f.org.id)).accounts.map((a) => a.login);

    expect(await logins()).toEqual(["walt"]);
    repos = [repo("walt/one"), repo("acme/two")];
    expect(await logins()).toEqual(["walt"]);
    await githubOrgAccess(deps, f.owner.id, f.org.id);
    expect(await logins()).toEqual(["acme", "walt"]);
  });

  test("the connection's and the bound installations', merged by account, cached, without tokens", async () => {
    f = await setup();
    await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, { connector: "github", apiKey: "ghp_user_token" });
    await f.db
      .insert(schema.githubAppInstallations)
      .values([{ orgId: f.org.id, installationId: 7, accountLogin: "acme", accountType: "Organization" }]);
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      calls.push(`${init?.method ?? "GET"} ${url.replace(API, "")} ${auth.startsWith("Bearer ey") ? "jwt" : auth}`);
      if (url.startsWith(`${API}/user/repos`)) {
        return Response.json([
          repo("walt/notes", { pushed_at: "2026-10-10T00:00:00Z" }),
          repo("acme/app", { private: false }),
          repo("walt/old", { pushed_at: "2025-01-01T00:00:00Z" }),
        ]);
      }
      if (url.endsWith("/app/installations/7/access_tokens"))
        return Response.json({ token: "ghs_inst" }, { status: 201 });
      if (url.startsWith(`${API}/installation/repositories`)) {
        return Response.json({ repositories: [repo("acme/app"), repo("acme/infra")] });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof globalThis.fetch;
    const deps = { db: f.db, connectors: depsOf(f), app: APP, github: { apiUrl: API, fetch } };

    const listing = await listOrgRepositories(deps, f.owner.id, f.org.id);
    expect(listing.connected).toBe(true);
    expect(listing.truncated).toBe(false);
    expect(listing.accounts.map((a) => [a.login, a.type, a.repositories.map((r) => r.name)])).toEqual([
      ["acme", "Organization", ["app", "infra"]],
      ["walt", "User", ["notes", "old"]],
    ]);
    // The installation's copy of acme/app came last (private).
    expect(listing.accounts[0]?.repositories[0]).toMatchObject({ fullName: "acme/app", private: true });
    expect(JSON.stringify(listing)).not.toContain("ghp_");
    expect(JSON.stringify(listing)).not.toContain("ghs_");
    expect(calls).toEqual([
      "GET /user/repos?per_page=100&page=1&sort=pushed&affiliation=owner,collaborator,organization_member Bearer ghp_user_token",
      "POST /app/installations/7/access_tokens jwt",
      "GET /installation/repositories?per_page=100&page=1 Bearer ghs_inst",
    ]);
    // Cached for a minute.
    await listOrgRepositories(deps, f.owner.id, f.org.id);
    expect(calls).toHaveLength(3);
    // Members can read it; an installation of another organization never counts.
    const member = await addMember(f.db, f.org.id, "member");
    expect((await listOrgRepositories(deps, member.id, f.org.id)).accounts).toHaveLength(2);
  });

  test("a GitHub connection made, replaced or removed shows at once, the minute's cache notwithstanding", async () => {
    f = await setup();
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (!String(input).startsWith(`${API}/user/repos`)) return new Response("unexpected", { status: 500 });
      return Response.json(auth === "Bearer ghp_second_token" ? [repo("walt/new")] : [repo("walt/notes")]);
    }) as typeof globalThis.fetch;
    const deps = { db: f.db, connectors: depsOf(f), app: null, github: { apiUrl: API, fetch } };
    const names = async () => {
      const listing = await listOrgRepositories(deps, f.owner.id, f.org.id);
      return [listing.connected, listing.accounts.flatMap((a) => a.repositories.map((r) => r.name))];
    };
    expect(await names()).toEqual([false, []]);
    const connect = (apiKey: string) =>
      createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, { connector: "github", apiKey });
    await connect("ghp_first_token");
    expect(await names()).toEqual([true, ["notes"]]);
    const second = await connect("ghp_second_token");
    expect(await names()).toEqual([true, ["new"]]);
    await revokeConnection(f.db, f.owner.id, f.org.id, second.id);
    expect(await names()).toEqual([false, []]);
  });

  test("no GitHub: not connected, nothing listed", async () => {
    f = await setup();
    const listing = await listOrgRepositories(
      { db: f.db, connectors: depsOf(f), app: null, github: { apiUrl: API, fetch: (() => Promise.reject()) as never } },
      f.owner.id,
      f.org.id,
    );
    expect(listing).toEqual({ connected: false, accounts: [], truncated: false });
  });
});
