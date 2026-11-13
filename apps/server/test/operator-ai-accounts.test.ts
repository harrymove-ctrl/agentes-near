import { afterAll, beforeAll, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { createTestServer, type TestServer } from "./harness";

/** ADR 0150: the operator's reads of the AI accounts people connected. */

const TOKEN = "operator-test-token-".padEnd(48, "x");
const RANGE = "from=2026-10-01&to=2026-10-31";
const HOUR = 3_600_000;

let t: TestServer;
let get: (path: string, authorization?: string) => Promise<Response>;
let ada: string;
let lia: string;
const id = (n: number) => `0193eeee-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeAll(async () => {
  t = await createTestServer({ env: { OPERATOR_API_TOKEN: TOKEN } });
  const app = createOperatorApp({ db: t.db, config: t.config, version: "test", log: createLogger("error") }, TOKEN);
  get = async (path, authorization = `Bearer ${TOKEN}`) =>
    app.request(`/api/operator/v1${path}`, { headers: { authorization } });
  const orgs = await t.db
    .insert(schema.organizations)
    .values([{ name: "Ada Labs" }, { name: "Lia Studio" }])
    .returning({ id: schema.organizations.id });
  ada = orgs[0]?.id ?? "";
  lia = orgs[1]?.id ?? "";
  const signedIn = { claude: { version: "2.1.0", loggedIn: true } };
  const m = await t.db
    .insert(schema.machines)
    .values([
      { orgId: ada, name: "Box", protocol: 50, runnerVersion: "1.2.3", executors: { mode: "system", ...signedIn } },
      { orgId: ada, name: "Mac", protocol: 50, executors: { claude: { version: "2.1.0", loggedIn: false } } },
      { orgId: lia, name: "Lia box", protocol: 45, executors: signedIn },
      { orgId: lia, name: "Gone", executors: signedIn, deletedAt: new Date() },
    ])
    .returning({ id: schema.machines.id });
  const [box, mac, liaBox, gone] = m.map((r) => r.id);
  const now = Date.now();
  const account = (n: number, over: Partial<typeof schema.machineAccounts.$inferInsert>) => ({
    id: id(n),
    orgId: ada,
    machineId: box ?? "",
    kind: "claude_code",
    label: "Claude",
    status: "active",
    ...over,
  });
  await t.db.insert(schema.machineAccounts).values([
    account(1, {
      authMethod: "setup_token",
      email: "ada@example.com",
      providerOrgId: "org-ada",
      shared: true,
      lastUsedAt: new Date(now - HOUR),
      usage: { windows: [], source: "probe", at: "2026-10-05T10:00:00.000Z" },
      createdAt: new Date("2026-10-05T09:00:00Z"),
    }),
    // The same Claude account signed in on another computer: one provider account.
    account(2, {
      authMethod: "setup_token",
      machineId: mac ?? "",
      email: "Ada@Example.com",
      providerOrgId: "org-ada",
      createdAt: new Date("2026-10-05T10:00:00Z"),
    }),
    // The same email in another Claude organization: another provider account.
    account(3, {
      authMethod: "cli_login",
      status: "signed_out",
      email: "ada@example.com",
      providerOrgId: "org-ada-team",
      createdAt: new Date("2026-10-06T10:00:00Z"),
    }),
    account(4, { statusUnknown: true, email: "ada@example.com", lastUsedAt: new Date(now - 72 * HOUR) }),
    account(5, { authMethod: "setup_token", status: "signing_in", createdAt: new Date("2026-10-05T11:00:00Z") }),
    account(6, { authMethod: "setup_token", status: "removing" }),
    account(7, { authMethod: "api_key", provider: "zai", keyHint: "9xyz" }),
    account(8, { authMethod: "cli_login", kind: "codex", lastUsedAt: new Date(now - 48 * HOUR) }),
    account(9, {
      orgId: lia,
      machineId: liaBox ?? "",
      authMethod: "cli_login",
      kind: "grok",
      email: "lia@example.com",
    }),
    // On a removed computer: kept for its return, counted and listed nowhere.
    account(10, {
      orgId: lia,
      machineId: gone ?? "",
      authMethod: "setup_token",
      email: "lia@example.com",
      providerOrgId: "org-lia",
      lastUsedAt: new Date(now - HOUR),
      createdAt: new Date("2026-10-07T10:00:00Z"),
    }),
  ]);
  // Three agents on one shared account: still one connection. An archived fourth thinks with nothing.
  await t.db.insert(schema.agents).values(
    [1, 2, 3, 4].map((n) => ({
      orgId: ada,
      name: `Agent ${n}`,
      handle: `agent${n}`,
      model: "x",
      brainAccountId: id(1),
      ...(n === 4 ? { archivedAt: new Date() } : {}),
    })),
  );
  const credential = (orgId: string, provider: string, revokedAt: Date | null = null) => ({
    orgId,
    provider,
    label: "Key",
    secretCiphertext: "v1.fake.fake.fake",
    wrappedDataKey: "fake",
    kekId: "local:v1",
    keyHint: "abcd",
    revokedAt,
  });
  await t.db
    .insert(schema.providerCredentials)
    .values([credential(ada, "anthropic"), credential(ada, "openai", new Date()), credential(lia, "anthropic")]);
  const failure = (at: string, orgId: string, accountId: string, cause: string, authMethod: string | null) => ({
    type: "account.failure",
    orgId,
    createdAt: new Date(at),
    data: {
      accountId,
      machineId: box,
      kind: "claude_code",
      authMethod,
      cause,
      code: "claude_failed",
      runnerVersion: "1.2.3",
    },
  });
  await t.db
    .insert(schema.operatorEvents)
    .values([
      failure("2026-09-01T10:00:00Z", ada, id(1), "auth_rejected", "setup_token"),
      failure("2026-10-10T10:00:00Z", ada, id(1), "auth_rejected", "setup_token"),
      failure("2026-10-10T11:00:00Z", ada, id(1), "auth_rejected", "setup_token"),
      failure("2026-10-10T12:00:00Z", ada, id(1), "auth_rejected", "setup_token"),
      failure("2026-10-11T10:00:00Z", ada, id(4), "account_disabled", null),
      failure("2026-10-12T10:00:00Z", lia, id(9), "auth_rejected", "cli_login"),
    ]);
});

afterAll(() => t.close());

async function ok<T = Record<string, unknown>>(res: Response) {
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const PRIVATE = ["ada@example.com", "Ada@Example.com", "lia@example.com", "9xyz", "abcd", "org-ada", "org-lia"];

test("both reads need the token", async () => {
  expect((await get(`/analytics/ai-accounts?${RANGE}`, "Bearer wrong")).status).toBe(401);
  expect((await get("/ai-accounts", "Bearer wrong")).status).toBe(401);
});

test("the totals reconcile: statuses, identities, API keys and the computers' own sign-ins apart", async () => {
  const res = await get(`/analytics/ai-accounts?${RANGE}`);
  const text = await res.clone().text();
  for (const p of PRIVATE) expect(text).not.toContain(p);
  const a = await ok<Record<string, unknown> & { byDimension: unknown[] }>(res);
  expect(a.totals).toEqual({
    connections: 7,
    usable: 5,
    unknown: 1,
    signedOut: 1,
    inProgress: 1,
    removing: 1,
    workspaces: 2,
    usedLast24h: 1,
    usedLast7d: 3,
    apiCredentials: 2,
    apiCredentialWorkspaces: 2,
    inheritedMachineLogins: 2,
  });
  const row = (provider: string, runtime: string, authMethod: string, billing: string, n: number[]) => {
    const [connections, usable, signedOut, unknown, usedLast7d] = n;
    return { provider, runtime, authMethod, billing, connections, usable, signedOut, unknown, usedLast7d };
  };
  expect(a.byDimension).toHaveLength(7);
  expect(a.byDimension).toEqual(
    expect.arrayContaining([
      row("anthropic", "claude_code", "setup_token", "subscription", [2, 2, 0, 0, 1]),
      row("anthropic", "claude_code", "cli_login", "subscription", [1, 0, 1, 0, 0]),
      row("anthropic", "claude_code", "unknown", "subscription", [1, 0, 0, 1, 1]),
      row("zai", "claude_code", "api_key", "coding_plan", [1, 1, 0, 0, 0]),
      row("openai", "codex", "cli_login", "subscription", [1, 1, 0, 0, 1]),
      row("xai", "grok", "cli_login", "subscription", [1, 1, 0, 0, 0]),
      row("anthropic", "api", "api_key", "metered_api", [2, 2, 0, 0, 0]),
    ]),
  );
  expect(a.identity).toEqual({ withProviderIdentity: 3, withoutIdentity: 4, distinctProviderAccounts: 2 });
  const failures = a.failures as { byCause: unknown[]; recent: Record<string, unknown>[] };
  expect(failures.byCause).toHaveLength(3);
  expect(failures.byCause[0]).toEqual({
    cause: "auth_rejected",
    authMethod: "setup_token",
    attempts: 3,
    accounts: 1,
    workspaces: 1,
  });
  expect(failures.byCause).toEqual(
    expect.arrayContaining([
      { cause: "account_disabled", authMethod: "unknown", attempts: 1, accounts: 1, workspaces: 1 },
      { cause: "auth_rejected", authMethod: "cli_login", attempts: 1, accounts: 1, workspaces: 1 },
    ]),
  );
  expect(failures.recent.map((f) => f.at)).toEqual([
    "2026-10-12T10:00:00.000Z",
    "2026-10-11T10:00:00.000Z",
    "2026-10-10T12:00:00.000Z",
    "2026-10-10T11:00:00.000Z",
    "2026-10-10T10:00:00.000Z",
  ]);
  expect(failures.recent[0]).toEqual({
    at: "2026-10-12T10:00:00.000Z",
    orgId: lia,
    machineId: expect.any(String),
    accountId: id(9),
    kind: "claude_code",
    authMethod: "cli_login",
    cause: "auth_rejected",
    code: "claude_failed",
    runnerVersion: "1.2.3",
  });
  expect(a.added).toEqual([
    { day: "2026-10-05", authMethod: "setup_token", count: 2 },
    { day: "2026-10-06", authMethod: "cli_login", count: 1 },
  ]);
  expect(a.addedSource).toBe("retained_rows");
  expect((a.coverage as { eventsSince: string }).eventsSince).toBe("2026-09-01T10:00:00.000Z");
});

test("the dates are checked", async () => {
  for (const q of ["from=2026-10-31&to=2026-10-01", "from=2025-01-01&to=2026-10-31", "from=x&to=2026-10-31"]) {
    const res = await get(`/analytics/ai-accounts?${q}`);
    expect(res.status).toBe(400);
  }
  expect((await get("/analytics/ai-accounts")).status).toBe(400);
});

type Page = { accounts: { id: string; agents: number; [k: string]: unknown }[]; next: string | null };

test("the list: keyset pages newest first, agents counted once each, no email or key hint", async () => {
  const seen: Page["accounts"] = [];
  let cursor: string | null = null;
  do {
    const res = await get(`/ai-accounts?limit=4${cursor ? `&cursor=${cursor}` : ""}`);
    const text = await res.clone().text();
    for (const p of PRIVATE) expect(text).not.toContain(p);
    const page: Page = await ok<Page>(res);
    expect(page.accounts.length).toBeLessThanOrEqual(4);
    seen.push(...page.accounts);
    cursor = page.next;
  } while (cursor);
  expect(seen.map((a) => a.id).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(id));
  const created = seen.map((a) => a.createdAt as string);
  expect(created).toEqual([...created].sort().reverse());
  const one = seen.find((a) => a.id === id(1));
  expect(one).toEqual({
    id: id(1),
    orgId: ada,
    orgName: "Ada Labs",
    machineId: expect.any(String),
    machineName: "Box",
    kind: "claude_code",
    provider: null,
    authMethod: "setup_token",
    label: "Claude",
    plan: null,
    status: "active",
    statusUnknown: false,
    shared: true,
    ownerId: null,
    agents: 3,
    createdAt: "2026-10-05T09:00:00.000Z",
    lastUsedAt: expect.any(String),
    lastSuccessAt: null,
    lastFailureCause: null,
    lastFailureAt: null,
    usageAt: "2026-10-05T10:00:00.000Z",
    usageSource: "probe",
    runnerVersion: "1.2.3",
    protocol: 50,
  });
  expect(seen.find((a) => a.id === id(2))?.runnerVersion).toBeNull();
});

test("the list's filters and bounds", async () => {
  const ids = async (q: string) => (await ok<Page>(await get(`/ai-accounts?${q}`))).accounts.map((a) => a.id);
  expect(await ids(`orgId=${lia}`)).toEqual([id(9)]);
  expect(await ids("kind=codex")).toEqual([id(8)]);
  expect(await ids("authMethod=unknown")).toEqual([id(4)]);
  expect(await ids("status=signing_in")).toEqual([id(5)]);
  expect(await ids(`orgId=${ada}&authMethod=cli_login`)).toEqual([id(8), id(3)]);
  for (const q of ["limit=0", "limit=201", "kind=bard", "authMethod=password", "status=gone", "orgId=nope"]) {
    expect((await get(`/ai-accounts?${q}`)).status).toBe(400);
  }
  const bad = await get("/ai-accounts?cursor=nope");
  expect(bad.status).toBe(400);
  expect(await code(bad)).toBe("invalid_cursor");
});
