import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { en, ptBR } from "@agenteschat/i18n";
import {
  accessMatrix,
  BUILTIN_TOOL_INFO,
  BUILTIN_TOOLS,
  type ConnectorDeps,
  connectorGrantValidator,
  createApiKeyConnection,
  createConnectorToolSource,
  createToolGateway,
  ForbiddenError,
  getAgentAccess,
  grantKey,
  postPersonMessage,
  resolveApps,
  setAgentAccess,
  setAgentScopes,
  toolAccess,
  ValidationError,
} from "../src";
import { fakeGithubMcp } from "./fake-mcp";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const none = { all: false, connectors: {}, scopes: [], tools: { allow: [], deny: [] } };

test("resolution: deny > tool allow > connector wildcard > scope > all", () => {
  const tool = { name: "github_delete_branch", scope: "github:repo.write", connectionId: "c1" };
  const keys = (...k: [string | null, string][]) => new Set(k.map(([c, s]) => grantKey(c, s)));
  expect(toolAccess(keys([null, "*"]), tool)).toBe("inherited");
  expect(toolAccess(keys(["c1", "connector:*"]), tool)).toBe("inherited");
  expect(toolAccess(keys(["c1", "github:repo.write"]), tool)).toBe("granted");
  expect(toolAccess(keys(["c1", "tool:github_delete_branch"]), tool)).toBe("granted");
  expect(toolAccess(keys([null, "*"], ["c1", "connector:*"], ["c1", "deny:github_delete_branch"]), tool)).toBe(
    "denied",
  );
  expect(toolAccess(keys(), tool)).toBe("off");
  expect(toolAccess(keys(), { name: "ask_user", scope: "", connectionId: null })).toBe("inherited");
});

describe("agent access", () => {
  async function withGithub() {
    const mcp = fakeGithubMcp();
    const deps: ConnectorDeps = { db: f.db, keyWrappers: [f.keyWrapper], publicUrl: "https://chat.example.com" };
    const gateway = createToolGateway({ sources: [createConnectorToolSource({ ...deps, connect: mcp.connect })] });
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
    return { deps, gateway, ctx };
  }

  test("all covers a connector added later; deny overrides all; sensitive tools still ask for approval", async () => {
    f = await setup();
    const { deps, gateway, ctx } = await withGithub();
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, { ...none, all: true });
    expect(await gateway.list(ctx)).toEqual([]); // nothing connected yet
    const github = await createApiKeyConnection(deps, f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    const names = (await gateway.list(ctx)).map((t) => t.name);
    expect(names).toContain("github_pull_request_read");
    expect(names).toContain("github_merge_pull_request");

    const merge = await gateway.invoke(ctx, {
      toolUseId: "t1",
      name: "github_merge_pull_request",
      input: {
        owner: "acme",
        repo: "app",
        pullNumber: 1,
        why: "The checks passed and the change was reviewed: this action finishes what was asked.",
      },
    });
    expect(merge.type).toBe("approval"); // `all` never removes approvals

    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, {
      ...none,
      all: true,
      connectors: { [github.id]: true },
      tools: { allow: [], deny: [{ connectionId: github.id, name: "github_merge_pull_request" }] },
    });
    expect((await gateway.list(ctx)).map((t) => t.name)).not.toContain("github_merge_pull_request");
    const denied = await gateway.invoke(ctx, {
      toolUseId: "t2",
      name: "github_merge_pull_request",
      input: {
        owner: "acme",
        repo: "app",
        pullNumber: 1,
        why: "The checks passed and the change was reviewed: this action finishes what was asked.",
      },
    });
    expect(denied).toMatchObject({ type: "result", output: { isError: true } });

    const tree = await getAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id);
    expect(tree.all).toBe(true);
    const gh = tree.connectors.find((c) => c.connectionId === github.id);
    expect(gh?.state).toBe("granted");
    const tools = gh?.scopes.flatMap((s) => s.tools) ?? [];
    expect(tools.find((t) => t.name === "github_merge_pull_request")).toMatchObject({
      state: "denied",
      sensitive: true,
    });
    expect(tools.find((t) => t.name === "github_pull_request_read")?.state).toBe("inherited");
    expect(tree.builtins.find((b) => b.scope === "drive:write")?.state).toBe("inherited");
    // The two changes here, and GitHub given to the agent when it was connected.
    const audit = await f.db.select().from(schema.auditLog);
    expect(audit.filter((a) => a.action === "agent.access_changed")).toHaveLength(3);
  });

  test("only admins or the owner change access; the matrix shows effective states", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(setAgentAccess(f.db, bia.id, f.org.id, f.agent.id, { ...none, all: true })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, {
      ...none,
      scopes: [{ connectionId: null, scope: "drive:read" }],
      tools: {
        allow: [{ connectionId: null, name: "create_issue" }],
        deny: [{ connectionId: null, name: "list_artifacts" }],
      },
    });
    const matrix = await accessMatrix(f.db, f.owner.id, f.org.id);
    const cells = matrix.cells[f.agent.id] ?? {};
    expect(cells["builtin|read_artifact"]).toBe("granted");
    expect(cells["builtin|list_artifacts"]).toBe("denied");
    expect(cells["builtin|create_issue"]).toBe("granted");
    expect(cells["builtin|update_issue"]).toBe("off");
    expect(cells["builtin|ask_user"]).toBe("inherited");
    await expect(accessMatrix(f.db, bia.id, f.org.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("the agent's owner (not an admin) only narrows its access: giving more is an admin's call", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const deny = [{ connectionId: null, name: "list_artifacts" }];
    const scopes = (...names: string[]) => names.map((scope) => ({ connectionId: null, scope }));
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, {
      ...none,
      scopes: scopes("drive:read", "issues:read"),
      tools: { allow: [], deny },
    });
    await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
    const wider = [
      { ...none, all: true, scopes: scopes("drive:read", "issues:read"), tools: { allow: [], deny } },
      { ...none, scopes: scopes("drive:read", "issues:read", "sandbox:run"), tools: { allow: [], deny } },
      {
        ...none,
        scopes: scopes("drive:read", "issues:read"),
        tools: { allow: [{ connectionId: null, name: "create_issue" }], deny },
      },
      // Lifting a denial gives the tool back.
      { ...none, scopes: scopes("drive:read", "issues:read") },
    ];
    for (const input of wider) {
      await expect(setAgentAccess(f.db, bia.id, f.org.id, f.agent.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Dropping a grant and denying another tool narrows it.
    await setAgentAccess(f.db, bia.id, f.org.id, f.agent.id, {
      ...none,
      scopes: scopes("drive:read"),
      tools: { allow: [], deny: [...deny, { connectionId: null, name: "read_artifact" }] },
    });
    const matrix = await accessMatrix(f.db, f.owner.id, f.org.id);
    const cells = matrix.cells[f.agent.id] ?? {};
    expect(cells["builtin|list_issues"]).toBe("off");
    expect(cells["builtin|read_artifact"]).toBe("denied");
  });
});

test("write implies read for built-ins: issues:write lets the agent list its issues", async () => {
  f = await setup();
  await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, {
    ...none,
    scopes: [
      { connectionId: null, scope: "issues:write" },
      { connectionId: null, scope: "drive:write" },
    ],
  });
  const keys = new Set([grantKey(null, "issues:write")]);
  expect(toolAccess(keys, { name: "list_issues", scope: "issues:read", connectionId: null })).toBe("inherited");
  expect(toolAccess(keys, { name: "list_events", scope: "calendar:read", connectionId: null })).toBe("off");
  const tree = await getAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id);
  const issuesRead = tree.builtins.find((b) => b.scope === "issues:read");
  expect(issuesRead?.state).toBe("inherited");
  expect(issuesRead?.tools.map((t) => [t.name, t.state])).toEqual([["list_issues", "inherited"]]);
  expect(tree.builtins.find((b) => b.scope === "drive:read")?.tools.every((t) => t.state === "inherited")).toBe(true);
  expect(tree.builtins.find((b) => b.scope === "calendar:read")?.state).toBe("off");
});

test("names every object has (constructor, toString) are no app or scope", async () => {
  f = await setup();
  const apps = await resolveApps(f.db, f.org.id, ["constructor", "toString", "__proto__"]);
  expect(apps.unknown).toEqual(["constructor", "toString", "__proto__"]);
  const scopes = (scope: string) => ({ ...none, scopes: [{ connectionId: null, scope }] });
  await expect(setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, scopes("constructor"))).rejects.toBeInstanceOf(
    ValidationError,
  );
  await expect(
    setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, [{ connectionId: null, scope: "toString" }]),
  ).rejects.toBeInstanceOf(ValidationError);
  const [linear] = await f.db
    .insert(schema.connectorConnections)
    .values({
      orgId: f.org.id,
      connector: "linear",
      toolPrefix: "linear",
      label: "Linear",
      serverUrl: "https://linear.example.com/mcp",
      authType: "none",
    })
    .returning();
  expect(
    await connectorGrantValidator(f.db, f.org.id, { connectionId: linear?.id ?? null, scope: "linear:constructor" }),
  ).toBe("Unknown scope linear:constructor for linear");
});

test("tools carry a label, a description and readOnly", async () => {
  f = await setup();
  const tree = await getAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id);
  const tools = tree.builtins.flatMap((b) => b.tools);
  expect(tools.find((t) => t.name === "list_issues")).toMatchObject({ label: "View issues", readOnly: true });
  expect(tools.find((t) => t.name === "create_issue")).toMatchObject({ label: "Create issue", readOnly: false });
  const matrix = await accessMatrix(f.db, f.owner.id, f.org.id);
  expect(matrix.tools.find((t) => t.name === "read_artifact")).toMatchObject({ label: "Read file", readOnly: true });
});

test("every tool the Acesso page lists has its label and description, in English and in Portuguese", () => {
  const key = (name: string) => name.replace(/[^a-zA-Z0-9]/g, "_");
  const worded = (strings: { builtinTools: object }, name: string) => {
    const words = (strings.builtinTools as Record<string, { label?: string; description?: string }>)[key(name)];
    return Boolean(words?.label && words.description);
  };
  // The always-on "ask the person" tools ("" scope) have no row there.
  const listed = Object.entries(BUILTIN_TOOLS).flatMap(([scope, names]) => (scope ? names : []));
  expect(listed.filter((name) => !BUILTIN_TOOL_INFO[name]?.description)).toEqual([]);
  expect(listed.filter((name) => !worded(en, name))).toEqual([]);
  expect(listed.filter((name) => !worded(ptBR, name))).toEqual([]);
});
