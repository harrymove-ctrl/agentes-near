import { afterEach, expect, test } from "bun:test";
import {
  accountCodeAad,
  generateSecretKeyPair,
  MACHINE_PROTOCOL_VERSION,
  openSecret,
  type RunnerAccountInfo,
  type ServerFrame,
  sealSecret,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, joinByInvitation, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.9.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

const OLD_ACCOUNT = "0193dddd-0000-4000-8000-000000000001";

interface Account {
  id: string;
  kind: string;
  label: string;
  email: string | null;
  plan: string | null;
  status: string;
  ownerId: string | null;
  ownerName: string | null;
  mine: boolean;
  usedBy: string[];
}

/** A runner that signs Claude Code in like the real one would: a key per sign-in, the code opened with the AAD. */
function fakeRunner() {
  const hub = t.engine.machineHub;
  const keys = new Map<string, string>();
  const codes = new Map<string, string>();
  const requests: Extract<ServerFrame, { type: "request" }>[] = [];
  /** What the CLI says once a sign-in is done. */
  const signedIn = { email: "ana@example.com", plan: "max" };
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request") return;
      requests.push(frame);
      setTimeout(async () => {
        const ok = (data: unknown) => void reply({ type: "result", id: frame.id, ok: true, data });
        if (frame.op !== "account") return ok({});
        if (frame.action === "begin") {
          const pair = await generateSecretKeyPair();
          keys.set(frame.loginId, pair.privateKey);
          return ok({ url: "https://claude.ai/oauth/authorize?code=true", publicKey: pair.publicKey });
        }
        if (frame.action === "code") {
          codes.set(frame.loginId, await openSecret(keys.get(frame.loginId) ?? "", frame.box, frame.aad));
          return ok({});
        }
        if (frame.action === "status") {
          return codes.has(frame.loginId)
            ? ok({ state: "done", account: { id: frame.loginId, kind: "claude_code", loggedIn: true, ...signedIn } })
            : ok({ state: "waiting" });
        }
        return ok({});
      }, 1);
    },
    close() {},
  });
  return {
    codes,
    requests,
    signedIn,
    accountRequests: (action: string) => requests.filter((r) => r.op === "account" && r.action === action),
    hello: (token: string, accounts: RunnerAccountInfo[] = []) =>
      hub.message(conn, JSON.stringify({ type: "hello", token, ...RUNNER, exec: true, accounts })),
    changed: (accounts: RunnerAccountInfo[]) => reply({ type: "accounts.changed", accounts }),
  };
}

async function workspace() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${seeded.orgId}${path}`, init);
  const admin = browser(t);
  await signUp(admin, "bia@example.com");
  await joinByInvitation(t, owner, seeded.orgId, "bia@example.com", { role: "admin", as: admin });
  const asAdmin = (path: string, init?: Parameters<typeof admin>[1]) =>
    admin(`/api/app/organizations/${seeded.orgId}${path}`, init);
  return {
    ...seeded,
    api,
    asAdmin,
    ownerId: await userId("owner@example.com"),
    adminId: await userId("bia@example.com"),
  };
}

async function userId(email: string) {
  const [row] = await t.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (!row) throw new Error(`no user ${email}`);
  return row.id;
}

const accountRow = async (id: string) =>
  (await t.db.select().from(schema.machineAccounts).where(eq(schema.machineAccounts.id, id)))[0] ?? null;

const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

/** Lets the hub's own requests (sent outside the frame that caused them) and their replies land. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
};

test("accounts on a computer: the runner's list, signing in with a sealed code, rename, pick for an agent, remove", async () => {
  const { api, asAdmin, agentId, orgId, ownerId } = await workspace();
  const mac = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "mac" });
  const runner = fakeRunner();
  await runner.hello(mac.token, [{ id: OLD_ACCOUNT, kind: "codex", loggedIn: false }]);
  const base = `/machines/${mac.machineId}`;

  // The runner's accounts (signed in on the computer itself: its pairer's), as the owner and an admin see them.
  const listed = await api(`${base}/accounts`);
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({
    accounts: [
      {
        id: OLD_ACCOUNT,
        kind: "codex",
        label: "ChatGPT",
        email: null,
        plan: null,
        status: "signed_out",
        statusKnown: true,
        ownerId,
        ownerName: "owner",
        mine: true,
        usedBy: [],
        usedByIds: [],
        usage: null,
        provider: null,
        keyHint: null,
        shared: false,
        providerOrgId: null,
      },
    ],
    canManage: true,
    supported: true,
  });
  expect(((await (await asAdmin(`${base}/accounts`)).json()) as { canManage: boolean }).canManage).toBe(false);

  // On a computer a person connected, only that person signs in.
  const refused = await asAdmin(`${base}/account-logins`, { json: { kind: "claude_code" } });
  expect(refused.status).toBe(403);
  expect(await code(refused)).toBe("account.not_owner");
  expect((await api(`${base}/account-logins`, { json: { kind: "gemini" } })).status).toBe(400);

  const begun = await api(`${base}/account-logins`, { json: { kind: "claude_code" } });
  expect(begun.status).toBe(201);
  const login = (await begun.json()) as { loginId: string; url: string; publicKey: string; expiresAt: string };
  expect(login.url).toBe("https://claude.ai/oauth/authorize?code=true");
  const waiting = (await (await api(`${base}/account-logins/${login.loginId}`)).json()) as { state: string };
  expect(waiting.state).toBe("waiting");

  // The code goes sealed in the browser; the server only relays it.
  const box = await sealSecret(login.publicKey, "abc#123", accountCodeAad(login.loginId, orgId));
  const sent = await api(`${base}/account-logins/${login.loginId}/code`, { json: { box } });
  expect(sent.status).toBe(204);
  expect(runner.codes.get(login.loginId)).toBe("abc#123");
  const done = (await (await api(`${base}/account-logins/${login.loginId}`)).json()) as {
    state: string;
    account: Account;
  };
  expect(done).toMatchObject({
    state: "done",
    account: { id: login.loginId, kind: "claude_code", label: "Claude", plan: "max", status: "active", mine: true },
  });
  const stored = JSON.stringify(await t.db.select().from(schema.machineAccounts));
  expect(stored).not.toContain("abc#123");
  expect((await api(`${base}/account-logins/${login.loginId}`, { method: "DELETE" })).status).toBe(204);

  // Rename; the agent thinks with it, at high effort.
  const renamed = await api(`${base}/accounts/${login.loginId}`, { method: "PATCH", json: { label: "Trabalho" } });
  expect(renamed.status).toBe(200);
  expect(((await renamed.json()) as Account).label).toBe("Trabalho");
  expect((await api(`${base}/accounts/${login.loginId}`, { method: "PATCH", json: { label: "" } })).status).toBe(400);
  expect((await asAdmin(`${base}/accounts/${login.loginId}`, { method: "PATCH", json: { label: "Meu" } })).status).toBe(
    403,
  );
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: mac.machineId } });
  const brain = await api(`/agents/${agentId}/brain`, {
    method: "PUT",
    json: { brain: "claude_code", account: login.loginId, effort: "high" },
  });
  expect(brain.status).toBe(200);
  expect(await brain.json()).toMatchObject({
    account: login.loginId,
    effort: "high",
    canManageAccounts: true,
    accountsSupported: true,
  });
  expect((await api(`/agents/${agentId}/brain`, { method: "PUT", json: { account: OLD_ACCOUNT } })).status).toBe(400);
  expect((await api(`/agents/${agentId}/brain`, { method: "PUT", json: { effort: "turbo" } })).status).toBe(400);
  // An admin picks among the owner's too: the computer's own sign-in, since the owner connected the Mac, and back.
  const moved = await asAdmin(`/agents/${agentId}/brain`, { method: "PUT", json: { account: null } });
  expect(moved.status).toBe(200);
  expect(await moved.json()).toMatchObject({ account: null, canUsePlans: false, canManageAccounts: false });
  const back = await asAdmin(`/agents/${agentId}/brain`, { method: "PUT", json: { account: login.loginId } });
  expect(await back.json()).toMatchObject({ account: login.loginId });

  // Remove: signed out on the computer, the agent back on the computer's own sign-in.
  expect((await asAdmin(`${base}/accounts/${login.loginId}`, { method: "DELETE" })).status).toBe(403);
  expect((await api(`${base}/accounts/${login.loginId}`, { method: "DELETE" })).status).toBe(204);
  expect(runner.requests.at(-1)).toMatchObject({
    op: "account",
    action: "remove",
    kind: "claude_code",
    accountId: login.loginId,
  });
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  expect(agent?.brainAccountId).toBeNull();
  const after = (await (await api(`${base}/accounts`)).json()) as { accounts: Account[] };
  expect(after.accounts.map((a) => a.id)).toEqual([OLD_ACCOUNT]);
});

test("an offline computer: no sign-in starts, renaming works, and removing leaves a tombstone until it is back", async () => {
  const { api, orgId, ownerId } = await workspace();
  const mac = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "mac" });
  await t.db.insert(schema.machineAccounts).values({
    id: OLD_ACCOUNT,
    orgId,
    machineId: mac.machineId,
    kind: "claude_code",
    label: "Claude",
    createdBy: ownerId,
  });
  const base = `/machines/${mac.machineId}`;
  const offline = await api(`${base}/account-logins`, { json: { kind: "claude_code" } });
  expect(offline.status).toBe(409);
  expect(await code(offline)).toBe("machine.offline");
  const renamed = await api(`${base}/accounts/${OLD_ACCOUNT}`, { method: "PATCH", json: { label: "Pessoal" } });
  expect(renamed.status).toBe(200);
  expect(((await renamed.json()) as Account).label).toBe("Pessoal");

  expect((await api(`${base}/accounts/${OLD_ACCOUNT}`, { method: "DELETE" })).status).toBe(204);
  expect(await accountRow(OLD_ACCOUNT)).toMatchObject({ status: "removing" });
  expect(((await (await api(`${base}/accounts`)).json()) as { accounts: Account[] }).accounts).toEqual([]);

  // The computer comes back still signed in to it: told to remove it, and the row goes.
  const runner = fakeRunner();
  await runner.hello(mac.token, [{ id: OLD_ACCOUNT, kind: "claude_code", loggedIn: true, email: "w@example.com" }]);
  await settle();
  expect(runner.accountRequests("remove")).toMatchObject([{ kind: "claude_code", accountId: OLD_ACCOUNT }]);
  expect(await accountRow(OLD_ACCOUNT)).toBeNull();
});

test("a computer nobody connected: anyone signs in, the account is theirs from the start, its email only theirs", async () => {
  const { api, asAdmin, orgId, adminId } = await workspace();
  const box = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "box" });
  await t.db.update(schema.machines).set({ pairedByUserId: null }).where(eq(schema.machines.id, box.machineId));
  const runner = fakeRunner();
  await runner.hello(box.token);
  runner.signedIn.email = "bia@example.com";
  const base = `/machines/${box.machineId}`;

  // The address that names the account is a plain one: anything else never reaches the computer.
  for (const email of ["a&calc&x@y.z", "x@y.z & calc", '"a"@y.z']) {
    const refused = await asAdmin(`${base}/account-logins`, { json: { kind: "claude_code", email } });
    expect(refused.status).toBe(400);
    expect(await code(refused)).toBe("account.invalid_email");
  }
  expect(runner.accountRequests("begin")).toEqual([]);

  const begun = await asAdmin(`${base}/account-logins`, { json: { kind: "claude_code", email: "bia@example.com" } });
  expect(begun.status).toBe(201);
  const login = (await begun.json()) as { loginId: string; publicKey: string };
  expect(runner.accountRequests("begin")).toMatchObject([{ loginId: login.loginId, email: "bia@example.com" }]);
  // Bound when it starts.
  expect(await accountRow(login.loginId)).toMatchObject({ status: "signing_in", createdBy: adminId });
  // Nobody else follows it or sends its code.
  const theirs = await api(`${base}/account-logins/${login.loginId}`);
  expect(theirs.status).toBe(403);
  expect(await code(theirs)).toBe("account.not_owner");

  const sealed = await sealSecret(login.publicKey, "abc#123", accountCodeAad(login.loginId, orgId));
  expect((await asAdmin(`${base}/account-logins/${login.loginId}/code`, { json: { box: sealed } })).status).toBe(204);
  // The runner says it has the account before Bia's page asks: still hers.
  await runner.changed([
    { id: login.loginId, kind: "claude_code", loggedIn: true, email: "bia@example.com", plan: "max" },
  ]);
  expect(await accountRow(login.loginId)).toMatchObject({ status: "active", createdBy: adminId, label: "Claude" });
  const done = (await (await asAdmin(`${base}/account-logins/${login.loginId}`)).json()) as {
    state: string;
    account: Account;
  };
  expect(done).toMatchObject({ state: "done", account: { email: "bia@example.com", mine: true } });

  // Only Bia sees the email; the others see whose it is.
  const asOwner = (await (await api(`${base}/accounts`)).json()) as { accounts: Account[]; canManage: boolean };
  expect(asOwner.canManage).toBe(true);
  expect(asOwner.accounts).toMatchObject([{ id: login.loginId, email: null, mine: false, ownerName: "bia" }]);
  expect(JSON.stringify(asOwner)).not.toContain("bia@example.com");

  // The same account again: a login of its own for another agent, under the account's name, nothing removed there.
  const again = (await (await asAdmin(`${base}/account-logins`, { json: { kind: "claude_code" } })).json()) as {
    loginId: string;
    publicKey: string;
  };
  const sealedAgain = await sealSecret(again.publicKey, "abc#456", accountCodeAad(again.loginId, orgId));
  await asAdmin(`${base}/account-logins/${again.loginId}/code`, { json: { box: sealedAgain } });
  const second = await asAdmin(`${base}/account-logins/${again.loginId}`);
  expect(await second.json()).toMatchObject({
    state: "done",
    account: { id: again.loginId, label: "Claude", email: "bia@example.com", mine: true },
  });
  expect(runner.accountRequests("remove")).toEqual([]);
  expect(await accountRow(again.loginId)).toMatchObject({ status: "active", label: "Claude", createdBy: adminId });

  // Each start runs a CLI on the shared computer: ten per person per computer every 15 minutes.
  for (let n = 0; n < 5; n++) {
    expect((await asAdmin(`${base}/account-logins`, { json: { kind: "claude_code", email: "x" } })).status).toBe(400);
  }
  const tooMany = await asAdmin(`${base}/account-logins`, { json: { kind: "claude_code" } });
  expect(tooMany.status).toBe(429);
  expect(await code(tooMany)).toBe("rate_limited");
  expect((await api(`${base}/account-logins`, { json: { kind: "claude_code", email: "x" } })).status).toBe(400);
});

test("the OpenAPI document lists the account routes", async () => {
  t = await createTestServer();
  const doc = (await (await t.app.request("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
  for (const path of [
    "/app/organizations/{orgId}/machines/{machineId}/accounts",
    "/app/organizations/{orgId}/machines/{machineId}/accounts/{accountId}",
    "/app/organizations/{orgId}/machines/{machineId}/account-logins",
    "/app/organizations/{orgId}/machines/{machineId}/account-logins/{loginId}",
    "/app/organizations/{orgId}/machines/{machineId}/account-logins/{loginId}/code",
    "/app/organizations/{orgId}/ai-accounts",
    "/app/organizations/{orgId}/ai-accounts/refresh",
  ]) {
    expect(Object.keys(doc.paths)).toContain(path);
  }
});

test("refreshing plan usage: 202, the computer is asked to look the caller's accounts up again; the usage it reports shows", async () => {
  const { api, ownerId } = await workspace();
  const mac = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "mac" });
  const runner = fakeRunner();
  await runner.hello(mac.token, [{ id: OLD_ACCOUNT, kind: "codex", loggedIn: true }]);
  const res = await api("/ai-accounts/refresh", { json: {} });
  expect(res.status).toBe(202);
  await settle();
  expect(runner.accountRequests("list")).toEqual([
    expect.objectContaining({ fresh: [OLD_ACCOUNT, "own:claude_code", "own:codex"] }),
  ]);
  // What the computer found comes back with the list.
  const usage = { windows: [{ kind: "five_hour", usedPercent: 12 }], source: "probe", at: "2030-01-01T10:00:00.000Z" };
  await runner.changed([{ id: OLD_ACCOUNT, kind: "codex", loggedIn: true, usage } as RunnerAccountInfo]);
  const listed = (await (await api(`/machines/${mac.machineId}/accounts`)).json()) as { accounts: Account[] };
  expect(listed.accounts[0]).toMatchObject({ id: OLD_ACCOUNT, ownerId, usage });
});

test("Contas de IA: the caller's own accounts with their computer, and where they can add one; an unknown plan is refused", async () => {
  const { api } = await workspace();
  const mac = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "mac" });
  const runner = fakeRunner();
  await runner.hello(mac.token, [{ id: OLD_ACCOUNT, kind: "codex", loggedIn: true }]);
  const res = await api("/ai-accounts");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    accounts: (Account & { machineId: string; computer: string })[];
    computers: { machineId: string; name: string; canAdd: boolean; keys: boolean }[];
  };
  expect(body.accounts).toMatchObject([{ id: OLD_ACCOUNT, machineId: mac.machineId, computer: "mac", provider: null }]);
  expect(body.computers).toMatchObject([{ machineId: mac.machineId, name: "mac", canAdd: true, keys: true }]);
  const bad = await api(`/machines/${mac.machineId}/account-logins`, {
    json: { kind: "claude_code", provider: "nope" },
  });
  expect(bad.status).toBe(400);
});
