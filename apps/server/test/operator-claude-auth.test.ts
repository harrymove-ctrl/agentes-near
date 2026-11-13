import { afterAll, beforeAll, expect, test } from "bun:test";
import { CLAUDE_AUTH_PROTOCOL } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { createTestServer, type TestServer } from "./harness";

/** ADR 0150: how new Claude sign-ins for all agents are made, through the operator API. */

const TOKEN = "operator-test-token-".padEnd(48, "x");

let t: TestServer;
let call: (method: string, path: string, json?: unknown, authorization?: string) => Promise<Response>;
let ada: string;
let lia: string;
let machineIds: { system: string; old: string; own: string };

beforeAll(async () => {
  t = await createTestServer({ env: { OPERATOR_API_TOKEN: TOKEN } });
  const app = createOperatorApp({ db: t.db, config: t.config, version: "test", log: createLogger("error") }, TOKEN);
  call = async (method, path, json, authorization = `Bearer ${TOKEN}`) =>
    app.request(`/api/operator/v1${path}`, {
      method,
      headers: { authorization, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
  const orgs = await t.db
    .insert(schema.organizations)
    .values([{ name: "Ada Labs" }, { name: "Lia Studio" }])
    .returning({ id: schema.organizations.id });
  ada = orgs[0]?.id ?? "";
  lia = orgs[1]?.id ?? "";
  const machines = await t.db
    .insert(schema.machines)
    .values([
      {
        orgId: ada,
        name: "Box",
        protocol: CLAUDE_AUTH_PROTOCOL,
        executors: { mode: "system", claudeLoginMethods: ["setup_token"], claudeLoginBlocked: "Bash is missing" },
      },
      { orgId: ada, name: "Old box", protocol: CLAUDE_AUTH_PROTOCOL - 1, executors: { mode: "system" } },
      { orgId: ada, name: "Mac", protocol: CLAUDE_AUTH_PROTOCOL, executors: { claudeLoginMethods: ["cli_login"] } },
      { orgId: ada, name: "Gone", deletedAt: new Date() },
    ])
    .returning({ id: schema.machines.id });
  machineIds = { system: machines[0]?.id ?? "", old: machines[1]?.id ?? "", own: machines[2]?.id ?? "" };
  const gone = machines[3]?.id ?? "";
  const account = (id: string, over: Partial<typeof schema.machineAccounts.$inferInsert>) => ({
    id,
    orgId: ada,
    machineId: machineIds.system,
    kind: "claude_code",
    label: "Claude",
    email: "ada@example.com",
    status: "active",
    ...over,
  });
  await t.db.insert(schema.machineAccounts).values([
    account("0193eeee-0000-4000-8000-000000000001", { authMethod: "setup_token" }),
    account("0193eeee-0000-4000-8000-000000000002", { authMethod: "setup_token", status: "signed_out" }),
    account("0193eeee-0000-4000-8000-000000000003", { authMethod: "cli_login", machineId: machineIds.own }),
    account("0193eeee-0000-4000-8000-000000000004", {}),
    // Not counted: a sign-in in progress, a tombstone, a plan's key, ChatGPT, one on a removed computer.
    account("0193eeee-0000-4000-8000-000000000005", { authMethod: "setup_token", status: "signing_in" }),
    account("0193eeee-0000-4000-8000-000000000006", { authMethod: "setup_token", status: "removing" }),
    account("0193eeee-0000-4000-8000-000000000007", { authMethod: "api_key", provider: "zai" }),
    account("0193eeee-0000-4000-8000-000000000008", { authMethod: "cli_login", kind: "codex" }),
    account("0193eeee-0000-4000-8000-000000000009", { authMethod: "setup_token", machineId: gone }),
  ]);
});

afterAll(() => t.close());

async function ok<T = Record<string, unknown>>(res: Response) {
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

test("every route needs the token", async () => {
  for (const [method, path] of [
    ["GET", "/claude-auth"],
    ["PUT", "/claude-auth"],
    ["GET", `/orgs/${ada}/claude-auth`],
  ] as const) {
    expect((await call(method, path, undefined, "Bearer wrong")).status).toBe(401);
  }
});

test("the policy: setup-token by default, set for the listed workspaces, the same again changes nothing", async () => {
  const connections = { cli_login: 1, setup_token: 2, api_key: 0, unknown: 1 };
  expect(await ok(await call("GET", "/claude-auth"))).toEqual({
    method: "setup_token",
    rollout: "selected",
    orgIds: [],
    changedAt: null,
    connections,
  });
  const set = await ok<{ changedAt: string }>(
    await call("PUT", "/claude-auth", { method: "cli_login", rollout: "selected", orgIds: [ada, ada] }),
  );
  expect(set).toMatchObject({ method: "cli_login", rollout: "selected", orgIds: [ada], connections });
  expect(set.changedAt).toEqual(expect.any(String));
  const again = await ok(
    await call("PUT", "/claude-auth", { method: "cli_login", rollout: "selected", orgIds: [ada] }),
  );
  expect(again.changedAt).toBe(set.changedAt);

  // The workspace's view: its computers where each agent is its own OS user get Claude's own login, which only
  // a runner that says it can do may use; elsewhere a sign-in for all agents is always Claude's own login.
  expect(await ok(await call("GET", `/orgs/${ada}/claude-auth`))).toEqual({
    effective: { method: "cli_login" },
    policy: { method: "cli_login", rollout: "selected", orgIds: [ada], changedAt: set.changedAt },
    machines: [
      {
        id: machineIds.system,
        name: "Box",
        system: true,
        protocol: CLAUDE_AUTH_PROTOCOL,
        claudeLoginMethods: ["setup_token"],
        supportsSelected: false,
        claudeLoginBlocked: "Bash is missing",
      },
      {
        id: machineIds.old,
        name: "Old box",
        system: true,
        protocol: CLAUDE_AUTH_PROTOCOL - 1,
        claudeLoginMethods: ["setup_token"],
        supportsSelected: false,
        claudeLoginBlocked: null,
      },
      {
        id: machineIds.own,
        name: "Mac",
        system: false,
        protocol: CLAUDE_AUTH_PROTOCOL,
        claudeLoginMethods: ["cli_login"],
        supportsSelected: true,
        claudeLoginBlocked: null,
      },
    ],
  });
  const other = await ok<{ effective: unknown; machines: unknown[] }>(await call("GET", `/orgs/${lia}/claude-auth`));
  expect(other).toMatchObject({ effective: { method: "setup_token" }, machines: [] });

  await ok(await call("PUT", "/claude-auth", { method: "setup_token", rollout: "selected", orgIds: [] }));
  // Back on setup-token, a reason the runner stored for Claude's own login no longer applies.
  const back = await ok<{ machines: { name: string; supportsSelected: boolean; claudeLoginBlocked: unknown }[] }>(
    await call("GET", `/orgs/${ada}/claude-auth`),
  );
  expect(back.machines.find((m) => m.name === "Box")).toMatchObject({
    supportsSelected: true,
    claudeLoginBlocked: null,
  });
});

test("refusals: a bad body, too many workspaces, one that doesn't exist; an unknown workspace's view is a 404", async () => {
  const put = (json: unknown) => call("PUT", "/claude-auth", json);
  for (const bad of [
    { method: "api_key", rollout: "all", orgIds: [] },
    { method: "cli_login", rollout: "some", orgIds: [] },
    { method: "cli_login", rollout: "all", orgIds: ["not-a-uuid"] },
    { method: "cli_login", rollout: "all" },
    { method: "cli_login", rollout: "all", orgIds: Array.from({ length: 501 }, () => crypto.randomUUID()) },
  ]) {
    const res = await put(bad);
    expect(res.status).toBe(400);
  }
  const unknown = await put({ method: "cli_login", rollout: "selected", orgIds: [ada, crypto.randomUUID()] });
  expect(unknown.status).toBe(400);
  expect(await code(unknown)).toBe("claude_auth.unknown_org");
  expect((await ok(await call("GET", "/claude-auth"))).method).toBe("setup_token");
  expect((await call("GET", `/orgs/${crypto.randomUUID()}/claude-auth`)).status).toBe(404);
});
