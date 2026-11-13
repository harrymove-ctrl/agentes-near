import { afterEach, expect, test } from "bun:test";
import {
  ACCOUNT_LOGIN_TTL_MS,
  ACCOUNTS_PROTOCOL,
  accountCodeAad,
  BRAIN_PROTOCOL,
  CLAUDE_AUTH_PROTOCOL,
  generateSecretKeyPair,
  type MachineRequest,
  OPENCODE_KEY_PROVIDER,
  OPENCODE_PROTOCOL,
  type OwnPlanUsage,
  openSecret,
  orgTopic,
  PLAN_KEYS_PROTOCOL,
  PLAN_USAGE_PROTOCOL,
  type PlanUsage,
  type RunnerAccountInfo,
  type ServerFrame,
  SHARED_ACCOUNTS_PROTOCOL,
  SHARED_CODEX_PROTOCOL,
  sealSecret,
} from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { runMigration } from "@agenteschat/db/testing";
import {
  accountLoginStatus,
  beginAccountLogin,
  ConflictError,
  cancelAccountLogin,
  claudeAuthMethodFor,
  claudeAuthPolicy,
  createMachineHub,
  deleteAccount,
  ForbiddenError,
  getAgentBrain,
  getMachineAccounts,
  listAiAccounts,
  listMachineAccounts,
  type MachineHub,
  MachineOfflineError,
  type MachineStatus,
  NotFoundError,
  noteModelLimit,
  refreshAiAccounts,
  removeMachineAccount,
  removeMember,
  renameMachineAccount,
  sendAccountLoginCode,
  setAgentBrain,
  setAgentComputerTarget,
  setClaudeAuthPolicy,
  syncMachineAccounts,
  ValidationError,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * ADR 0041 and ADR 0059: accounts of the computer brains on a connected
 * computer. An account is the person's who started its sign-in, bound when
 * it starts; one the desktop app signed in is the pairer's. The runner's
 * hello keeps the rows in sync; only the owner renames an account or picks
 * it for an agent (one agent per account); the owner or the pairer removes
 * it, with a tombstone while the computer is off.
 */

let f: Fixture;
const hubs: MachineHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const CLAUDE_ID = "0193dddd-0000-4000-8000-000000000001";
const CODEX_ID = "0193dddd-0000-4000-8000-000000000002";
const RUNNER = { hostname: "mac", os: "darwin", arch: "arm64", version: "0.9.0", workspace: "/Users/a/agentes" };

/** A computer the fixture's owner connected, on a runner that knows accounts (Claude Code and Codex on it). */
async function ownedMachine(protocol = ACCOUNTS_PROTOCOL) {
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "mac",
    ...RUNNER,
    protocol,
    exec: true,
  });
  await f.db
    .update(schema.machines)
    .set({
      protocol,
      executors: {
        claude: { version: "2.1.304", loggedIn: true },
        codex: { version: "codex-cli 0.170.0" },
        detectedAt: new Date().toISOString(),
      },
    })
    .where(eq(schema.machines.id, paired.machineId));
  return paired;
}

/** A computer nobody connected (the Cloud's, a server's own): every member adds accounts there. */
async function sharedMachine() {
  const paired = await ownedMachine();
  await f.db.update(schema.machines).set({ pairedByUserId: null }).where(eq(schema.machines.id, paired.machineId));
  return paired;
}

async function addAccount(machineId: string, id: string, kind: "claude_code" | "codex" | "opencode", over = {}) {
  await f.db.insert(schema.machineAccounts).values({
    id,
    orgId: f.org.id,
    machineId,
    kind,
    label: kind === "codex" ? "Codex" : "Trabalho",
    email: kind === "codex" ? null : "ana@example.com",
    status: "active",
    createdBy: f.owner.id,
    ...over,
  });
}

test("OpenCode's CLI on a computer is no sign-in of anyone's: a real key still lists", async () => {
  f = await setup();
  const { machineId } = await sharedMachine();
  await f.db
    .update(schema.machines)
    .set({
      protocol: OPENCODE_PROTOCOL,
      execAllowed: true,
      executors: { opencode: { version: "1.19.5" }, detectedAt: new Date().toISOString() },
    })
    .where(eq(schema.machines.id, machineId));
  const page = await listAiAccounts({ db: f.db }, f.owner.id, f.org.id);
  const row = page.computers.find((c) => c.machineId === machineId);
  // Available to choose (the free tier), claimed by nobody.
  expect(row?.own).toEqual({});
  expect(row?.brains.opencode).toBe(true);
  expect(row?.canAdd).toBe(true);
  expect(page.accounts.filter((a) => a.machineId === machineId)).toEqual([]);

  await f.db.update(schema.machines).set({ pairedByUserId: f.owner.id }).where(eq(schema.machines.id, machineId));
  expect(
    (await listAiAccounts({ db: f.db }, f.owner.id, f.org.id)).computers.find((c) => c.machineId === machineId)?.own,
  ).toEqual({});

  const key = "00000000-0000-4000-8000-0000000000c0";
  await addAccount(machineId, key, "opencode", { provider: OPENCODE_KEY_PROVIDER, label: "OpenCode" });
  const keyed = await listAiAccounts({ db: f.db }, f.owner.id, f.org.id);
  expect(keyed.accounts.filter((a) => a.machineId === machineId).map((a) => a.id)).toEqual([key]);
});

const agentRow = async (id = f.agent.id) => {
  const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, id));
  if (!row) throw new Error("no agent");
  return row;
};

const accountRows = (machineId: string) =>
  f.db
    .select()
    .from(schema.machineAccounts)
    .where(and(eq(schema.machineAccounts.orgId, f.org.id), eq(schema.machineAccounts.machineId, machineId)))
    .orderBy(schema.machineAccounts.createdAt, schema.machineAccounts.id);

const accountRow = async (id: string) =>
  (await f.db.select().from(schema.machineAccounts).where(eq(schema.machineAccounts.id, id)))[0] ?? null;

/** Lets the hub's own requests (sent outside the frame that caused them) and their replies land. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
};

type AccountReq = Extract<MachineRequest, { op: "account" }>;

/** A hub stand-in: the machine's status and the runner's answers to `op: "account"`. */
function fakeHub(
  machineId: string,
  answer: (req: AccountReq) => unknown | Promise<unknown>,
  over: Partial<MachineStatus> = {},
) {
  const calls: AccountReq[] = [];
  const hub = {
    status: async (): Promise<MachineStatus> => ({
      id: machineId,
      orgId: f.org.id,
      name: "mac",
      online: true,
      execAllowed: true,
      os: "darwin",
      protocol: ACCOUNTS_PROTOCOL,
      executors: {},
      ...over,
    }),
    call: async (_id: string, req: MachineRequest) => {
      if (req.op !== "account") throw new Error(`unexpected ${req.op}`);
      if (over.online === false) throw new MachineOfflineError("mac", null);
      calls.push(req);
      return (await answer(req)) as never;
    },
  };
  return { deps: { db: f.db, pubsub: f.pubsub, hub }, calls };
}

/** A runner that signs Claude Code in: a key per sign-in, `done` once its code arrived, with `account()`'s answer. */
function signingRunner(
  machineId: string,
  account: (loginId: string) => Omit<RunnerAccountInfo, "id" | "kind">,
  over: Partial<MachineStatus> = {},
) {
  const keys = new Map<string, string>();
  const codes = new Map<string, string>();
  return {
    codes,
    ...fakeHub(
      machineId,
      async (req) => {
        if (req.action === "begin") {
          const pair = await generateSecretKeyPair();
          keys.set(req.loginId, pair.privateKey);
          return { url: "https://claude.ai/oauth/authorize?code=true", publicKey: pair.publicKey };
        }
        if (req.action === "code") {
          codes.set(req.loginId, await openSecret(keys.get(req.loginId) ?? "", req.box, req.aad));
          return {};
        }
        if (req.action === "status") {
          return codes.has(req.loginId)
            ? { state: "done", account: { id: req.loginId, kind: "claude_code", ...account(req.loginId) } }
            : { state: "waiting" };
        }
        return {};
      },
      over,
    ),
  };
}

/** Signs in the whole way: begin, the sealed code, the poll that finds it done. */
async function signIn(
  runner: ReturnType<typeof signingRunner>,
  userId: string,
  machineId: string,
  options: { email?: string } = {},
) {
  const login = await beginAccountLogin(
    runner.deps,
    userId,
    f.org.id,
    machineId,
    "claude_code",
    undefined,
    options.email,
  );
  const box = await sealSecret(login.publicKey ?? "", "abc#123", accountCodeAad(login.loginId, f.org.id));
  await sendAccountLoginCode(runner.deps, userId, f.org.id, machineId, login.loginId, box);
  return { login, status: await accountLoginStatus(runner.deps, userId, f.org.id, machineId, login.loginId) };
}

/** A runner on a real hub (each hello on a new connection): it answers every request with `{}` and keeps them. */
function connectedRunner(hub: MachineHub, token: string) {
  const requests: Extract<ServerFrame, { type: "request" }>[] = [];
  let last: ReturnType<MachineHub["open"]> | null = null;
  const open = () => {
    const conn = hub.open({
      send(text: string) {
        const frame = JSON.parse(text) as ServerFrame;
        if (frame.type !== "request") return;
        requests.push(frame);
        const reply = { type: "result", id: frame.id, ok: true, data: {} };
        setTimeout(() => void hub.message(conn, JSON.stringify(reply)), 1);
      },
      close() {},
    });
    last = conn;
    return conn;
  };
  return {
    removals: () => requests.flatMap((r) => (r.op === "account" && r.action === "remove" ? [r] : [])),
    hello: (accounts: RunnerAccountInfo[], protocol = ACCOUNTS_PROTOCOL, extra: Record<string, unknown> = {}) =>
      hub.message(
        open(),
        JSON.stringify({ type: "hello", token, ...RUNNER, protocol, exec: true, accounts, ...extra }),
      ),
    /** `accounts.changed` on the last connection. */
    changed: (accounts: RunnerAccountInfo[], ownUsage?: OwnPlanUsage) =>
      last
        ? hub.message(last, JSON.stringify({ type: "accounts.changed", accounts, ...(ownUsage ? { ownUsage } : {}) }))
        : Promise.resolve(),
  };
}

test("hello.accounts: new accounts are added as the pairer's, known ones refreshed, missing ones removed (their agents released)", async () => {
  f = await setup();
  const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  hubs.push(hub);
  const { machineId, token } = await ownedMachine();
  const runner = connectedRunner(hub, token);

  await runner.hello([
    { id: CLAUDE_ID, kind: "claude_code", loggedIn: true, email: "ana@example.com", plan: "max" },
    { id: CODEX_ID, kind: "codex", loggedIn: false },
  ]);
  let rows = await accountRows(machineId);
  // Signed in on the computer itself (the desktop app): the pairer's from the start.
  expect(rows.map((r) => [r.id, r.kind, r.label, r.email, r.plan, r.status, r.createdBy])).toEqual([
    [CLAUDE_ID, "claude_code", "Claude", "ana@example.com", "max", "active", f.owner.id],
    [CODEX_ID, "codex", "ChatGPT", null, null, "signed_out", f.owner.id],
  ]);

  // An agent thinks with the Claude account; the computer no longer has it.
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainAccountId: CLAUDE_ID })
    .where(eq(schema.agents.id, f.agent.id));
  expect((await listMachineAccounts({ db: f.db }, f.org.id, machineId, f.owner.id))[0]?.usedBy).toEqual(["Dev"]);
  await renameMachineAccount({ db: f.db }, f.owner.id, f.org.id, machineId, CODEX_ID, "Pessoal");
  await runner.hello([{ id: CODEX_ID, kind: "codex", loggedIn: true, email: "ana@example.com", plan: "plus" }]);
  rows = await accountRows(machineId);
  // The name people gave it stays; what the CLI says is refreshed.
  expect(rows.map((r) => [r.id, r.label, r.email, r.plan, r.status])).toEqual([
    [CODEX_ID, "Pessoal", "ana@example.com", "plus", "active"],
  ]);
  expect((await agentRow()).brainAccountId).toBeNull();

  // A runner that says nothing about accounts (an older one) changes nothing.
  await runner.hello([], ACCOUNTS_PROTOCOL - 1);
  expect((await accountRows(machineId)).length).toBe(1);
});

test("hello.accounts: what the runner found since hello, sent the moment welcome arrives, lands over hello's list", async () => {
  f = await setup();
  const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  hubs.push(hub);
  const { machineId, token } = await ownedMachine();
  const newer: RunnerAccountInfo[] = [
    { id: CLAUDE_ID, kind: "claude_code", loggedIn: true, email: "ana@example.com" },
    { id: CODEX_ID, kind: "codex", loggedIn: true },
  ];
  let changed: Promise<unknown> = Promise.resolve();
  const conn = hub.open({
    send(text: string) {
      if ((JSON.parse(text) as ServerFrame).type !== "welcome") return;
      queueMicrotask(() => {
        changed = hub.message(conn, JSON.stringify({ type: "accounts.changed", accounts: newer }));
      });
    },
    close() {},
  });
  const older: RunnerAccountInfo[] = [{ id: CLAUDE_ID, kind: "claude_code", loggedIn: false }];
  await hub.message(
    conn,
    JSON.stringify({ type: "hello", token, ...RUNNER, protocol: ACCOUNTS_PROTOCOL, exec: true, accounts: older }),
  );
  await changed;
  expect((await accountRows(machineId)).map((r) => [r.id, r.status])).toEqual([
    [CLAUDE_ID, "active"],
    [CODEX_ID, "active"],
  ]);
});

test("a sign-in that fails on the computer: its code and the CLI's words (masked) reach the poll, an error is logged", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  const ends = new Map<string, unknown>();
  const { deps } = fakeHub(machineId, (req) => {
    if (req.action === "begin")
      return { url: "https://claude.ai/oauth/authorize?code=true", publicKey: "k".repeat(44) };
    return req.action === "status" ? ends.get(req.loginId) : {};
  });
  const logged: { level: string; message: string; data?: Record<string, unknown> }[] = [];
  const log = {
    error: (message: string, data?: Record<string, unknown>) => logged.push({ level: "error", message, data }),
    warn: (message: string, data?: Record<string, unknown>) => logged.push({ level: "warn", message, data }),
  };
  const ended = async (end: unknown) => {
    const login = await beginAccountLogin(deps, f.owner.id, f.org.id, machineId, "claude_code");
    ends.set(login.loginId, end);
    const status = await accountLoginStatus({ ...deps, log }, f.owner.id, f.org.id, machineId, login.loginId);
    expect(await accountRow(login.loginId)).toBeNull();
    return status;
  };

  const refused = await ended({
    state: "failed",
    error: "Claude Code couldn't sign in with that code",
    code: "bad_code",
    message: "OAuth error: invalid_grant for ya29.FAKE-not-a-real-token-xxxx",
  });
  expect(refused).toEqual({
    state: "failed",
    error: "Claude Code couldn't sign in with that code",
    code: "bad_code",
    message: "OAuth error: invalid_grant for ••••",
  });
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({
    level: "error",
    data: { orgId: f.org.id, userId: f.owner.id, machineId, accountKind: "claude_code", code: "bad_code" },
  });
  expect(String(logged[0]?.data?.error)).toBe(
    "Error: claude_code sign-in failed: bad_code: OAuth error: invalid_grant for ••••",
  );

  // An older runner's failure, a code this server doesn't know, a cancel and an expiry.
  expect(await ended({ state: "failed", error: "Canceled" })).toEqual({ state: "failed", error: "Canceled" });
  expect(await ended({ state: "failed", error: "x", code: "made_up", message: "y" })).toEqual({
    state: "failed",
    error: "x",
  });
  expect(await ended({ state: "failed", error: "Canceled", code: "canceled" })).toMatchObject({ code: "canceled" });
  expect(await ended({ state: "expired", error: "The sign-in took too long.", code: "timeout" })).toEqual({
    state: "expired",
    code: "timeout",
  });
  expect(logged.map((l) => l.level)).toEqual(["error", "warn"]);
});

test("signing in: the person who connected the computer; the code is sealed to it; done stores the account once", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  const admin = await addMember(f.db, f.org.id, "admin", "bia");
  const runner = signingRunner(machineId, () => ({ loggedIn: true, email: "ana@example.com", plan: "max" }));
  const { deps, calls } = runner;

  // Someone else on a computer a person connected (an admin either): refused before anything reaches it.
  const notOwner = await beginAccountLogin(deps, admin.id, f.org.id, machineId, "claude_code").catch((e) => e);
  expect(notOwner).toBeInstanceOf(ForbiddenError);
  expect(notOwner.code).toBe("account.not_owner");
  expect(calls).toEqual([]);
  expect(await beginAccountLogin(deps, f.owner.id, f.org.id, machineId, "gemini").catch((e) => e)).toBeInstanceOf(
    ValidationError,
  );

  const before = Date.now();
  const login = await beginAccountLogin(deps, f.owner.id, f.org.id, machineId, "claude_code");
  expect(login).toMatchObject({ kind: "claude_code", url: "https://claude.ai/oauth/authorize?code=true" });
  expect(login.publicKey).toBeString();
  expect(Date.parse(login.expiresAt)).toBeGreaterThanOrEqual(before + ACCOUNT_LOGIN_TTL_MS - 1000);
  expect(calls[0]).toEqual({ op: "account", action: "begin", kind: "claude_code", loginId: login.loginId });
  // Bound now: the row is there, the starter's, and no account yet.
  expect(await accountRow(login.loginId)).toMatchObject({ status: "signing_in", createdBy: f.owner.id });
  expect(await listMachineAccounts({ db: f.db }, f.org.id, machineId, f.owner.id)).toEqual([]);
  expect(await accountLoginStatus(deps, f.owner.id, f.org.id, machineId, login.loginId)).toEqual({ state: "waiting" });

  // The browser seals the code to the computer's key, bound to this sign-in and organization.
  const box = await sealSecret(login.publicKey ?? "", "abc#123", accountCodeAad(login.loginId, f.org.id));
  expect(
    await sendAccountLoginCode(deps, f.owner.id, f.org.id, machineId, login.loginId, { v: 9 }).catch((e) => e),
  ).toBeInstanceOf(ValidationError);
  await sendAccountLoginCode(deps, f.owner.id, f.org.id, machineId, login.loginId, box);
  expect(runner.codes.get(login.loginId)).toBe("abc#123");

  const done = await accountLoginStatus(deps, f.owner.id, f.org.id, machineId, login.loginId);
  expect(done).toEqual({
    state: "done",
    account: {
      id: login.loginId,
      kind: "claude_code",
      label: "Claude",
      email: "ana@example.com",
      plan: "max",
      status: "active",
      statusKnown: true,
      ownerId: f.owner.id,
      ownerName: "ana",
      mine: true,
      usedBy: [],
      usedByIds: [],
      usage: null,
      provider: null,
      keyHint: null,
      shared: false,
      providerOrgId: null,
    },
  });
  // Polled again: the same account, added once.
  await accountLoginStatus(deps, f.owner.id, f.org.id, machineId, login.loginId);
  const rows = await accountRows(machineId);
  expect(rows.map((r) => [r.id, r.createdBy])).toEqual([[login.loginId, f.owner.id]]);
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "account.added"));
  expect(audit.length).toBe(1);
  expect(audit[0]).toMatchObject({ actorType: "person", actorId: f.owner.id });
  expect(JSON.stringify(audit[0]?.details)).not.toContain("abc#123");

  await cancelAccountLogin(deps, f.owner.id, f.org.id, machineId, login.loginId);
  expect(calls.at(-1)).toEqual({ op: "account", action: "cancel", loginId: login.loginId });

  // The admin sees the accounts (never the email) but can't manage them.
  const seen = await getMachineAccounts({ db: f.db }, admin.id, f.org.id, machineId);
  expect(seen).toMatchObject({ canManage: false, supported: true });
  expect(seen.accounts.map((a) => [a.email, a.mine, a.ownerName])).toEqual([[null, false, "ana"]]);
  expect((await getMachineAccounts({ db: f.db }, f.owner.id, f.org.id, machineId)).canManage).toBe(true);
  const member = await addMember(f.db, f.org.id, "member", "caio");
  expect(await getMachineAccounts({ db: f.db }, member.id, f.org.id, machineId).catch((e) => e)).toBeInstanceOf(
    ForbiddenError,
  );
});

/** A runner that keeps plans' keys: a key pair per sign-in, `done` once the key arrived (its last 4 said). */
function keyRunner(machineId: string, protocol = PLAN_KEYS_PROTOCOL) {
  const keys = new Map<string, string>();
  const got = new Map<string, string>();
  return {
    got,
    ...fakeHub(
      machineId,
      async (req) => {
        if (req.action === "begin") {
          const pair = await generateSecretKeyPair();
          keys.set(req.loginId, pair.privateKey);
          return { publicKey: pair.publicKey };
        }
        if (req.action === "code") {
          got.set(req.loginId, await openSecret(keys.get(req.loginId) ?? "", req.box, req.aad));
          return {};
        }
        if (req.action === "status") {
          const key = got.get(req.loginId);
          return key
            ? {
                state: "done",
                account: {
                  id: req.loginId,
                  kind: "claude_code",
                  loggedIn: true,
                  provider: "zai",
                  keyHint: key.slice(-4),
                },
              }
            : { state: "waiting" };
        }
        return {};
      },
      { protocol },
    ),
  };
}

/** A GLM Coding key the whole way, as the fixture's owner: begin, the sealed key, the poll that finds it done. */
async function signInKey(runner: ReturnType<typeof keyRunner>, machineId: string, key: string) {
  const login = await beginAccountLogin(
    runner.deps,
    f.owner.id,
    f.org.id,
    machineId,
    "claude_code",
    undefined,
    undefined,
    "zai",
  );
  const box = await sealSecret(login.publicKey ?? "", key, accountCodeAad(login.loginId, f.org.id));
  await sendAccountLoginCode(runner.deps, f.owner.id, f.org.id, machineId, login.loginId, box);
  return { login, status: await accountLoginStatus(runner.deps, f.owner.id, f.org.id, machineId, login.loginId) };
}

const KEY = "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp";

test("a coding plan's key: no sign-in page but the plan's key page, the key sealed to the computer, its last 4 only to its owner", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(PLAN_KEYS_PROTOCOL);
  const runner = keyRunner(machineId);
  const add = (key: string) => signInKey(runner, machineId, key);
  const { login, status } = await add(KEY);
  expect(login).toMatchObject({ kind: "claude_code", provider: "zai", url: "https://z.ai/manage-apikey/apikey-list" });
  expect(runner.calls[0]).toEqual({
    op: "account",
    action: "begin",
    kind: "claude_code",
    loginId: login.loginId,
    provider: "zai",
  });
  // The runner got the key; the server keeps only its name, plan and last 4.
  expect(runner.got.get(login.loginId)).toBe(KEY);
  expect(status.account).toMatchObject({ label: "GLM Coding", provider: "zai", keyHint: "MnOp", status: "active" });
  const row = await accountRow(login.loginId);
  expect(row).toMatchObject({ provider: "zai", keyHint: "MnOp", email: null });
  expect(JSON.stringify(row)).not.toContain("0123456789abcdef");

  // The same key again: another login of that account (one per agent), under its name. Another key is another.
  const again = await add(KEY);
  expect(again.status).toMatchObject({ state: "done", account: { label: "GLM Coding", keyHint: "MnOp" } });
  expect(again.status.account?.id).not.toBe(login.loginId);
  const second = await add(`${KEY.slice(0, -4)}WxYz`);
  expect(second.status.account).toMatchObject({ label: "GLM Coding 2", keyHint: "WxYz" });

  // Others see the plan, never its key's last 4.
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const seen = await listMachineAccounts({ db: f.db }, f.org.id, machineId, bia.id);
  expect(seen.map((a) => [a.provider, a.keyHint])).toEqual([
    ["zai", null],
    ["zai", null],
    ["zai", null],
  ]);
  // The AI accounts page: the caller's own, with where each is; the computers they can add to.
  const page = await listAiAccounts({ db: f.db }, f.owner.id, f.org.id);
  expect(page.accounts.map((a) => [a.label, a.computer, a.keyHint])).toEqual([
    ["GLM Coding", "mac", "MnOp"],
    ["GLM Coding", "mac", "MnOp"],
    ["GLM Coding 2", "mac", "WxYz"],
  ]);
  expect(page.computers).toEqual([
    {
      machineId,
      name: "mac",
      online: expect.any(Boolean),
      mine: true,
      canAdd: true,
      keys: true,
      // A runner before protocol 29: a sign-in thinks for one agent.
      shares: {
        claude_code: false,
        codex: false,
        cursor: false,
        opencode: false,
        grok: false,
        antigravity: false,
        key: false,
      },
      off: expect.any(Object),
      brains: {
        claude_code: expect.any(Boolean),
        codex: expect.any(Boolean),
        cursor: expect.any(Boolean),
        opencode: expect.any(Boolean),
        grok: expect.any(Boolean),
        antigravity: expect.any(Boolean),
      },
      // Its Claude Code is signed in on its own, with no plan or usage known yet.
      own: { claude_code: {} },
    },
  ]);
  expect((await listAiAccounts({ db: f.db }, bia.id, f.org.id)).accounts).toEqual([]);

  // "Conta deste computador": the CLI's own sign-in, with its plan and usage, for whoever connected the computer.
  const [before] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
  const usage = {
    windows: [{ kind: "five_hour" as const, usedPercent: 40 }],
    source: "turn" as const,
    at: new Date().toISOString(),
  };
  await f.db
    .update(schema.machines)
    .set({
      execAllowed: true,
      executors: {
        claude: { version: "2.1.0", loggedIn: true, plan: "max" },
        ownUsage: { claude_code: usage },
        detectedAt: new Date().toISOString(),
      },
    })
    .where(eq(schema.machines.id, machineId));
  expect((await listAiAccounts({ db: f.db }, f.owner.id, f.org.id)).computers[0]?.own).toEqual({
    claude_code: { plan: "max", usage },
  });
  // Someone else in the workspace: not theirs.
  expect((await listAiAccounts({ db: f.db }, bia.id, f.org.id)).computers[0]?.own).toEqual({});
  // Claude Code saying it's signed out there wins over a usage read with that sign-in before.
  await f.db
    .update(schema.machines)
    .set({
      executors: {
        claude: { version: "2.1.0", loggedIn: false },
        ownUsage: { claude_code: usage },
        detectedAt: new Date().toISOString(),
      },
    })
    .where(eq(schema.machines.id, machineId));
  expect((await listAiAccounts({ db: f.db }, f.owner.id, f.org.id)).computers[0]?.own).toEqual({});
  await f.db
    .update(schema.machines)
    .set({ execAllowed: before?.execAllowed ?? false, executors: before?.executors ?? {} })
    .where(eq(schema.machines.id, machineId));

  // Only plans we know; a runner that doesn't keep keys is too old for one.
  const unknown = await beginAccountLogin(
    runner.deps,
    f.owner.id,
    f.org.id,
    machineId,
    "claude_code",
    undefined,
    undefined,
    "nope",
  ).catch((e) => e);
  expect(unknown).toBeInstanceOf(ValidationError);
  const old = keyRunner(machineId, PLAN_USAGE_PROTOCOL);
  const refused = await beginAccountLogin(
    old.deps,
    f.owner.id,
    f.org.id,
    machineId,
    "claude_code",
    undefined,
    undefined,
    "zai",
  ).catch((e) => e);
  expect(refused).toMatchObject({ code: "account.runner_old" });
  expect(old.calls).toEqual([]);
});

test("a sign-in needs the computer online, a runner that knows accounts and a provider page on https", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  const offline = fakeHub(machineId, () => ({}), { online: false });
  expect(
    await beginAccountLogin(offline.deps, f.owner.id, f.org.id, machineId, "codex").catch((e) => e),
  ).toBeInstanceOf(MachineOfflineError);
  expect(await accountRows(machineId)).toEqual([]);

  const bad = fakeHub(machineId, (req) => (req.action === "begin" ? { url: "javascript:alert(1)" } : {}));
  const refused = await beginAccountLogin(bad.deps, f.owner.id, f.org.id, machineId, "codex").catch((e) => e);
  expect(refused).toBeInstanceOf(ConflictError);
  expect(refused.code).toBe("account.begin_failed");
  // The half-started sign-in is stopped on the computer, and its row goes.
  expect(bad.calls.map((c) => c.action)).toEqual(["begin", "cancel"]);
  expect(await accountRows(machineId)).toEqual([]);

  const codex = fakeHub(machineId, () => ({ url: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" }));
  expect(await beginAccountLogin(codex.deps, f.owner.id, f.org.id, machineId, "codex")).toMatchObject({
    kind: "codex",
    url: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  });

  await f.db
    .update(schema.machines)
    .set({ protocol: ACCOUNTS_PROTOCOL - 1 })
    .where(eq(schema.machines.id, machineId));
  const old = await beginAccountLogin(codex.deps, f.owner.id, f.org.id, machineId, "codex").catch((e) => e);
  expect(old).toBeInstanceOf(ConflictError);
  expect(old.code).toBe("account.runner_old");
});

test("the email that names the account: a plain address only, never one a shell would read", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  const { deps, calls } = signingRunner(machineId, () => ({ loggedIn: true }));
  const begin = (kind: string, email: string) =>
    beginAccountLogin(deps, f.owner.id, f.org.id, machineId, kind, undefined, email).catch((e) => e);
  // Codex takes no hint either.
  for (const [kind, email] of [
    ["claude_code", "a&calc&x@y.z"],
    ["claude_code", 'a"b@y.z'],
    ["claude_code", "a%PATH%@y.z"],
    ["claude_code", "(a)@y.z"],
    ["claude_code", "-x@y.z"],
    ["claude_code", "a b@y.z"],
    ["claude_code", "a@y"],
    ["codex", "ana@example.com"],
  ] as const) {
    const refused = await begin(kind, email);
    expect(refused).toBeInstanceOf(ValidationError);
    expect(refused.code).toBe("account.invalid_email");
  }
  expect(calls).toEqual([]);
  expect(await accountRows(machineId)).toEqual([]);
  const login = await begin("claude_code", "ana.silva+work@acme-corp.com.br");
  expect(calls[0]).toEqual({
    op: "account",
    action: "begin",
    kind: "claude_code",
    loginId: login.loginId,
    email: "ana.silva+work@acme-corp.com.br",
  });
});

test("ownership is bound when the sign-in starts: a member's account on a computer nobody connected stays theirs", async () => {
  f = await setup();
  const { machineId } = await sharedMachine();
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const runner = signingRunner(machineId, () => ({ loggedIn: true, email: "caio@example.com", plan: "team" }));

  const login = await beginAccountLogin(runner.deps, caio.id, f.org.id, machineId, "claude_code");
  // The runner lists the accounts before the sign-in finished: the sign-in in progress stays.
  await syncMachineAccounts({ db: f.db, pubsub: f.pubsub }, f.org.id, machineId, []);
  expect(await accountRow(login.loginId)).toMatchObject({ status: "signing_in", createdBy: caio.id });
  // Nobody else follows it, sends its code or stops it.
  const box = await sealSecret(login.publicKey ?? "", "abc#123", accountCodeAad(login.loginId, f.org.id));
  for (const attempt of [
    accountLoginStatus(runner.deps, bia.id, f.org.id, machineId, login.loginId),
    sendAccountLoginCode(runner.deps, bia.id, f.org.id, machineId, login.loginId, box),
    cancelAccountLogin(runner.deps, f.owner.id, f.org.id, machineId, login.loginId),
  ]) {
    const refused = await attempt.catch((e) => e);
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect(refused.code).toBe("account.not_owner");
  }
  expect(runner.calls.map((c) => c.action)).toEqual(["begin"]);

  // Caio's tab closes; the runner reports the finished sign-in: still Caio's, never re-owned.
  await syncMachineAccounts({ db: f.db, pubsub: f.pubsub }, f.org.id, machineId, [
    { id: login.loginId, kind: "claude_code", loggedIn: true, email: "caio@example.com", plan: "team" },
  ]);
  expect(await accountRow(login.loginId)).toMatchObject({
    status: "active",
    createdBy: caio.id,
    label: "Claude",
    email: "caio@example.com",
  });
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "account.added"));
  expect(audit.map((a) => a.actorId)).toEqual([caio.id]);

  // Only Caio sees the email; everyone sees whose it is.
  const asBia = await getMachineAccounts({ db: f.db }, bia.id, f.org.id, machineId);
  expect(asBia.canManage).toBe(true);
  expect(asBia.accounts).toMatchObject([
    { id: login.loginId, email: null, mine: false, ownerId: caio.id, ownerName: "caio" },
  ]);
  const asCaio = await getMachineAccounts({ db: f.db }, caio.id, f.org.id, machineId);
  expect(asCaio.accounts).toMatchObject([{ email: "caio@example.com", mine: true }]);
  const asAdmin = await getMachineAccounts({ db: f.db }, f.owner.id, f.org.id, machineId);
  expect(asAdmin.accounts[0]?.email).toBeNull();

  // His second seat is "Claude 2"; Bia's first is "Claude": the plan is never in the name.
  const second = signingRunner(machineId, () => ({ loggedIn: true, email: "caio2@example.com", plan: "team" }));
  expect((await signIn(second, caio.id, machineId)).status.account?.label).toBe("Claude 2");
  const hers = signingRunner(machineId, () => ({ loggedIn: true, email: "bia@example.com", plan: "team" }));
  expect((await signIn(hers, bia.id, machineId)).status.account?.label).toBe("Claude");

  // Only the owner renames; the others can't.
  expect(
    await renameMachineAccount({ db: f.db }, bia.id, f.org.id, machineId, login.loginId, "Meu").catch((e) => e),
  ).toBeInstanceOf(ForbiddenError);
  expect(
    await renameMachineAccount({ db: f.db }, caio.id, f.org.id, machineId, login.loginId, "Startup"),
  ).toMatchObject({ label: "Startup", mine: true });
});

test("ChatGPT: the same account again signs in as a login of its own, under the account's name, like Claude's", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  await addAccount(machineId, CODEX_ID, "codex", { label: "Trabalho", email: "Ana@Example.com", plan: "plus" });
  const signInChatGpt = async (email: string) => {
    const runner = codexRunner(machineId, email);
    const login = await beginAccountLogin(runner.deps, f.owner.id, f.org.id, machineId, "codex");
    const status = await accountLoginStatus(runner.deps, f.owner.id, f.org.id, machineId, login.loginId);
    return { runner, login, status };
  };
  const { runner, login, status } = await signInChatGpt("ana@example.com");
  expect(status).toMatchObject({
    state: "done",
    account: { id: login.loginId, label: "Trabalho", email: "ana@example.com", status: "active", usedBy: [] },
  });
  expect(status.duplicate).toBeUndefined();
  expect(runner.calls.filter((c) => c.action === "remove")).toEqual([]);
  expect((await accountRows(machineId)).map((r) => r.id).sort()).toEqual([CODEX_ID, login.loginId].sort());

  // Another email is another account.
  expect((await signInChatGpt("ana.pessoal@example.com")).status).toMatchObject({
    state: "done",
    account: { label: "ChatGPT" },
  });
});

test("ChatGPT's sign-in is made for all of its owner's agents from runner protocol 38 on, never before", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(SHARED_CODEX_PROTOCOL);
  const begun = async (protocol: number) => {
    const runner = fakeHub(
      machineId,
      (req) => (req.action === "begin" ? { url: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" } : {}),
      { protocol },
    );
    await beginAccountLogin(runner.deps, f.owner.id, f.org.id, machineId, "codex");
    return (runner.calls.find((c) => c.action === "begin") as { shared?: boolean } | undefined)?.shared;
  };
  expect(await begun(SHARED_CODEX_PROTOCOL)).toBe(true);
  expect(await begun(SHARED_CODEX_PROTOCOL - 1)).toBeUndefined();
});

test("Claude: an account another agent thinks with signs in again as a login of its own, under the account's name", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  await addAccount(machineId, CLAUDE_ID, "claude_code", { label: "Trabalho", email: "Ana@Example.com", plan: "max" });
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainAccountId: CLAUDE_ID })
    .where(eq(schema.agents.id, f.agent.id));
  const runner = signingRunner(machineId, () => ({ loggedIn: true, email: "ana@example.com", plan: "max" }));
  const { login, status } = await signIn(runner, f.owner.id, machineId);
  // Never refused as one already there: its own login, the account's name, nothing removed on the computer.
  expect(status).toMatchObject({
    state: "done",
    account: { id: login.loginId, label: "Trabalho", email: "ana@example.com", status: "active", usedBy: [] },
  });
  expect(status.duplicate).toBeUndefined();
  expect(runner.calls.filter((c) => c.action === "remove")).toEqual([]);

  // A second agent thinks with it; the first keeps its own login.
  const [theo] = await f.db
    .insert(schema.agents)
    .values({
      orgId: f.org.id,
      name: "Theo",
      handle: "theo",
      model: "claude-sonnet-5-5",
      ownerUserId: f.owner.id,
      machineId,
      brain: "claude_code",
    })
    .returning();
  if (!theo) throw new Error("no agent");
  await setAgentBrain({ db: f.db }, f.owner.id, f.org.id, theo.id, { account: login.loginId });
  const listed = await listMachineAccounts({ db: f.db }, f.org.id, machineId, f.owner.id);
  expect(listed.map((a) => [a.id, a.label, a.usedBy])).toEqual([
    [CLAUDE_ID, "Trabalho", ["Dev"]],
    [login.loginId, "Trabalho", ["Theo"]],
  ]);

  // Renamed from either login, both take the name; removing one leaves the other thinking for its agent.
  await renameMachineAccount(runner.deps, f.owner.id, f.org.id, machineId, login.loginId, "Empresa");
  expect((await accountRows(machineId)).map((r) => r.label)).toEqual(["Empresa", "Empresa"]);
  await removeMachineAccount(runner.deps, f.owner.id, f.org.id, machineId, login.loginId);
  expect((await accountRows(machineId)).map((r) => r.id)).toEqual([CLAUDE_ID]);
  expect((await agentRow(theo.id)).brainAccountId).toBeNull();
  expect((await agentRow()).brainAccountId).toBe(CLAUDE_ID);
});

test("signing in again as another account: it stays signed out with its agents, and the answer says who came back", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  const PESSOAL_ID = "0193dddd-0000-4000-8000-000000000003";
  await addAccount(machineId, CLAUDE_ID, "claude_code", { status: "signed_out", plan: "max" });
  await addAccount(machineId, PESSOAL_ID, "claude_code", { label: "Pessoal", email: "walt@gmail.com", plan: "max" });
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainAccountId: CLAUDE_ID })
    .where(eq(schema.agents.id, f.agent.id));
  let as = "walt@gmail.com";
  const runner = signingRunner(machineId, () => ({ loggedIn: true, email: as, plan: "max" }));
  const again = async () => {
    const { deps } = runner;
    const login = await beginAccountLogin(
      deps,
      f.owner.id,
      f.org.id,
      machineId,
      "claude_code",
      CLAUDE_ID,
      "ana@example.com",
    );
    const box = await sealSecret(login.publicKey ?? "", "abc#123", accountCodeAad(login.loginId, f.org.id));
    await sendAccountLoginCode(deps, f.owner.id, f.org.id, machineId, login.loginId, box);
    return accountLoginStatus(deps, f.owner.id, f.org.id, machineId, login.loginId);
  };
  const reported = (email: string) =>
    syncMachineAccounts({ db: f.db, pubsub: f.pubsub }, f.org.id, machineId, [
      { id: CLAUDE_ID, kind: "claude_code", loggedIn: true, email, plan: "max" },
      { id: PESSOAL_ID, kind: "claude_code", loggedIn: true, email: "walt@gmail.com", plan: "max" },
    ]);
  const asItWas = { status: "signed_out", email: "ana@example.com", label: "Trabalho" };

  // Claude's page came back as an account already connected: that one, named, and nothing removed.
  expect(await again()).toMatchObject({
    state: "failed",
    signedInAs: "walt@gmail.com",
    duplicate: { label: "Pessoal", account: { id: PESSOAL_ID, email: "walt@gmail.com", status: "active", usedBy: [] } },
  });
  expect(runner.calls.filter((c) => c.action === "remove")).toEqual([]);
  expect(await accountRow(CLAUDE_ID)).toMatchObject(asItWas);
  expect((await agentRow()).brainAccountId).toBe(CLAUDE_ID);
  // The runner reports the new login at once, before or after that answer: the same.
  await reported("walt@gmail.com");
  expect(await accountRow(CLAUDE_ID)).toMatchObject(asItWas);

  // An email of its own, not connected: said, and the account stays as it was.
  as = "bob@other.com";
  const other = await again();
  expect(other).toMatchObject({ state: "failed", signedInAs: "bob@other.com" });
  expect(other.duplicate).toBeUndefined();
  expect(await accountRow(CLAUDE_ID)).toMatchObject(asItWas);
  expect((await agentRow()).brainAccountId).toBe(CLAUDE_ID);

  // Its own: signed in, the same account for the same agent.
  as = "ana@example.com";
  expect(await again()).toMatchObject({
    state: "done",
    account: { id: CLAUDE_ID, label: "Trabalho", status: "active", usedBy: ["Dev"] },
  });
  // Signed in there as someone else afterwards: it reads as signed out, as itself.
  await reported("bob@other.com");
  expect(await accountRow(CLAUDE_ID)).toMatchObject(asItWas);
  expect((await agentRow()).brainAccountId).toBe(CLAUDE_ID);
});

/** A runner where ChatGPT signs in with a device code at once, as `email`. */
function codexRunner(machineId: string, email: string) {
  return fakeHub(machineId, (req) => {
    if (req.action === "begin") return { url: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" };
    if (req.action === "status") {
      return { state: "done", account: { id: req.loginId, kind: "codex", loggedIn: true, email, plan: "plus" } };
    }
    return {};
  });
}

test("one login per agent where the account allows it: a key's logins share its name, each thinks for one agent, and a rename renames them all, never another account named alike", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(PLAN_KEYS_PROTOCOL);
  const runner = keyRunner(machineId);
  const signedIn = async (key: string) => {
    const { account } = (await signInKey(runner, machineId, key)).status;
    if (!account) throw new Error("not signed in");
    return account;
  };
  const ada = await signedIn(KEY);
  const theo = await signedIn(KEY);
  const other = await signedIn(`${KEY.slice(0, -4)}WxYz`);
  expect([ada.label, theo.label, other.label]).toEqual(["GLM Coding", "GLM Coding", "GLM Coding 2"]);
  expect([ada.keyHint, theo.keyHint]).toEqual(["MnOp", "MnOp"]);

  // Each login thinks for one agent.
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", name: "Ada" })
    .where(eq(schema.agents.id, f.agent.id));
  const [theoAgent] = await f.db
    .insert(schema.agents)
    .values({
      orgId: f.org.id,
      name: "Theo",
      handle: "theo",
      model: "claude-sonnet-5-5",
      ownerUserId: f.owner.id,
      machineId,
      brain: "claude_code",
    })
    .returning();
  if (!theoAgent) throw new Error("no agent");
  await setAgentBrain({ db: f.db }, f.owner.id, f.org.id, f.agent.id, { account: ada.id });
  await setAgentBrain({ db: f.db }, f.owner.id, f.org.id, theoAgent.id, { account: theo.id });
  const listed = await listMachineAccounts({ db: f.db }, f.org.id, machineId, f.owner.id);
  expect(listed.map((a) => [a.id, a.usedBy])).toEqual([
    [ada.id, ["Ada"]],
    [theo.id, ["Theo"]],
    [other.id, []],
  ]);

  // The other key named alike, then the account renamed from one of its logins: both of its logins, and only them.
  await renameMachineAccount(runner.deps, f.owner.id, f.org.id, machineId, other.id, "Equipe");
  await renameMachineAccount(runner.deps, f.owner.id, f.org.id, machineId, theo.id, "Equipe");
  await renameMachineAccount(runner.deps, f.owner.id, f.org.id, machineId, ada.id, "Time");
  const labels = async () => Object.fromEntries((await accountRows(machineId)).map((r) => [r.id, r.label]));
  expect(await labels()).toEqual({ [ada.id]: "Time", [theo.id]: "Time", [other.id]: "Equipe" });
  // One audit entry per login renamed.
  const renamed = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "account.renamed"));
  const entry = (id: string, from: string, to: string) => `${id} on ${machineId}: ${from} > ${to}`;
  const entries = renamed.map((a) => {
    const d = a.details as Record<string, string>;
    return `${a.targetId} on ${d.machineId}: ${d.from} > ${d.to}`;
  });
  expect(entries.sort()).toEqual(
    [
      entry(other.id, "GLM Coding 2", "Equipe"),
      entry(ada.id, "GLM Coding", "Equipe"),
      entry(theo.id, "GLM Coding", "Equipe"),
      entry(ada.id, "Equipe", "Time"),
      entry(theo.id, "Equipe", "Time"),
    ].sort(),
  );

  // The computer signed the same key in by itself (the desktop app): one more login, under the account's name.
  const DESKTOP_ID = "0193dddd-0000-4000-8000-000000000010";
  const report = (id: string, keyHint: string) => ({
    id,
    kind: "claude_code" as const,
    loggedIn: true,
    provider: "zai",
    keyHint,
  });
  const remove = await syncMachineAccounts({ db: f.db, pubsub: f.pubsub }, f.org.id, machineId, [
    report(ada.id, "MnOp"),
    report(theo.id, "MnOp"),
    report(other.id, "WxYz"),
    report(DESKTOP_ID, "MnOp"),
  ]);
  expect(remove).toEqual([]);
  expect(await accountRow(DESKTOP_ID)).toMatchObject({ label: "Time", createdBy: f.owner.id, status: "active" });

  // ChatGPT's like Claude's: the same ChatGPT account again is one more login, under its name.
  const chatgpt = codexRunner(machineId, "ana@example.com");
  const signInChatGpt = async () => {
    const login = await beginAccountLogin(chatgpt.deps, f.owner.id, f.org.id, machineId, "codex");
    return accountLoginStatus(chatgpt.deps, f.owner.id, f.org.id, machineId, login.loginId);
  };
  expect(await signInChatGpt()).toMatchObject({ state: "done", account: { label: "ChatGPT" } });
  const again = await signInChatGpt();
  expect(again).toMatchObject({ state: "done", account: { label: "ChatGPT" } });
  expect(again.duplicate).toBeUndefined();
});

test("rename and remove: the owner renames; the owner or the pairer removes; offline, a tombstone until the next hello", async () => {
  f = await setup();
  const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  hubs.push(hub);
  const { machineId, token } = await ownedMachine();
  await addAccount(machineId, CLAUDE_ID, "claude_code");
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainAccountId: CLAUDE_ID })
    .where(eq(schema.agents.id, f.agent.id));
  const admin = await addMember(f.db, f.org.id, "admin", "bia");
  const online = fakeHub(machineId, () => ({}));

  expect(
    await renameMachineAccount(online.deps, admin.id, f.org.id, machineId, CLAUDE_ID, "Meu").catch((e) => e),
  ).toBeInstanceOf(ForbiddenError);
  expect(
    await renameMachineAccount(online.deps, f.owner.id, f.org.id, machineId, CLAUDE_ID, "  ").catch((e) => e),
  ).toBeInstanceOf(ValidationError);
  expect(
    await renameMachineAccount(online.deps, f.owner.id, f.org.id, machineId, CLAUDE_ID, "x".repeat(41)).catch((e) => e),
  ).toBeInstanceOf(ValidationError);
  const renamed = await renameMachineAccount(online.deps, f.owner.id, f.org.id, machineId, CLAUDE_ID, " Empresa ");
  expect(renamed).toMatchObject({ id: CLAUDE_ID, label: "Empresa", usedBy: ["Dev"] });
  expect(
    await renameMachineAccount(online.deps, f.owner.id, f.org.id, machineId, CODEX_ID, "Outro").catch((e) => e),
  ).toBeInstanceOf(NotFoundError);

  // An admin removes only where the computer or the account has no person.
  expect(
    await removeMachineAccount(online.deps, admin.id, f.org.id, machineId, CLAUDE_ID).catch((e) => e),
  ).toBeInstanceOf(ForbiddenError);

  // The computer is off: the agent is released now, the account waits for it as a tombstone.
  const off = fakeHub(machineId, () => ({}), { online: false });
  await removeMachineAccount(off.deps, f.owner.id, f.org.id, machineId, CLAUDE_ID);
  expect(await accountRow(CLAUDE_ID)).toMatchObject({ status: "removing" });
  expect((await agentRow()).brainAccountId).toBeNull();
  expect(await listMachineAccounts({ db: f.db }, f.org.id, machineId, f.owner.id)).toEqual([]);
  const actions = (await f.db.select().from(schema.auditLog)).map((a) => a.action);
  expect(actions).toContain("account.renamed");
  expect(actions).toContain("account.removed");

  // Back: its hello still lists the account, which stays removed, and the runner is told to remove it.
  const runner = connectedRunner(hub, token);
  await runner.hello([{ id: CLAUDE_ID, kind: "claude_code", loggedIn: true, email: "ana@example.com" }]);
  await settle();
  expect(runner.removals()).toMatchObject([{ action: "remove", kind: "claude_code", accountId: CLAUDE_ID }]);
  expect(await accountRow(CLAUDE_ID)).toBeNull();

  // Online, the pairer removes someone's account at once (here an old one nobody owns).
  await addAccount(machineId, CODEX_ID, "codex", { createdBy: null });
  await removeMachineAccount(online.deps, f.owner.id, f.org.id, machineId, CODEX_ID);
  expect(online.calls.at(-1)).toEqual({ op: "account", action: "remove", kind: "codex", accountId: CODEX_ID });
  expect(await accountRow(CODEX_ID)).toBeNull();
});

test('the label migration: a ChatGPT account that kept its default name "Codex" is called "ChatGPT"; chosen names stay', async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  const id = (n: number) => `0193dddd-0000-4000-8000-00000000010${n}`;
  await addAccount(machineId, id(1), "codex");
  await addAccount(machineId, id(2), "codex", { label: "Codex Plus", plan: "plus" });
  await addAccount(machineId, id(3), "codex", { label: "Codex do Rui", plan: "plus" });
  await addAccount(machineId, id(4), "claude_code", { label: "Codex" });
  // Its owner already has a "ChatGPT Pro": the old name stays, so the two still read apart.
  await addAccount(machineId, id(5), "codex", { label: "Codex Pro", plan: "pro" });
  await addAccount(machineId, id(6), "codex", { label: "ChatGPT Pro", plan: "pro" });
  await runMigration(f.db, "claude_chatgpt_labels");
  await runMigration(f.db, "claude_chatgpt_labels");
  expect(Object.fromEntries((await accountRows(machineId)).map((r) => [r.id, r.label]))).toEqual({
    [id(1)]: "ChatGPT",
    [id(2)]: "ChatGPT Plus",
    [id(3)]: "Codex do Rui",
    [id(4)]: "Codex",
    [id(5)]: "Codex Pro",
    [id(6)]: "ChatGPT Pro",
  });
});

test('the Claude names migration: an account named after its plan ("Claude Max") is "Claude", numbered per owner; chosen names stay', async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const id = (n: number) => `0193dddd-0000-4000-8000-00000000020${n}`;
  const at = (n: number) => ({ createdAt: new Date(Date.UTC(2026, 9, 30, 12, n)) });
  await addAccount(machineId, id(1), "claude_code", { label: "Claude Max", plan: "max", ...at(1) });
  // Another login of that account (one per agent): one name for both.
  await addAccount(machineId, id(2), "claude_code", {
    label: "Claude Max",
    plan: "max",
    email: "Ana@Example.com",
    ...at(2),
  });
  await addAccount(machineId, id(3), "claude_code", {
    label: "Claude Team",
    plan: "team",
    email: "ana@acme.com",
    ...at(3),
  });
  await addAccount(machineId, id(4), "claude_code", {
    label: "Claude Max 2",
    plan: "ultra",
    email: "ana2@x.com",
    ...at(4),
  });
  await addAccount(machineId, id(5), "claude_code", {
    label: "Claude Max pessoal",
    plan: "max",
    email: "a3@x.com",
    ...at(5),
  });
  await addAccount(machineId, id(6), "claude_code", { label: "Claude Max", plan: "max", createdBy: bia.id, ...at(6) });
  await addAccount(machineId, id(7), "claude_code", { label: "GLM Coding", provider: "zai", email: null, ...at(7) });
  await addAccount(machineId, id(8), "codex", { label: "ChatGPT", ...at(8) });
  await runMigration(f.db, "claude_account_names");
  await runMigration(f.db, "claude_account_names");
  expect(Object.fromEntries((await accountRows(machineId)).map((r) => [r.id, r.label]))).toEqual({
    [id(1)]: "Claude",
    [id(2)]: "Claude",
    [id(3)]: "Claude 2",
    [id(4)]: "Claude 3",
    [id(5)]: "Claude Max pessoal",
    [id(6)]: "Claude",
    [id(7)]: "GLM Coding",
    [id(8)]: "ChatGPT",
  });
});

test("on a computer nobody connected, an admin removes any account; a member only their own", async () => {
  f = await setup();
  const { machineId } = await sharedMachine();
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addAccount(machineId, CLAUDE_ID, "claude_code", { createdBy: caio.id });
  await addAccount(machineId, CODEX_ID, "codex", { createdBy: caio.id });
  const { deps, calls } = fakeHub(machineId, () => ({}));
  expect(await removeMachineAccount(deps, bia.id, f.org.id, machineId, CLAUDE_ID).catch((e) => e)).toBeInstanceOf(
    ForbiddenError,
  );
  await removeMachineAccount(deps, f.owner.id, f.org.id, machineId, CLAUDE_ID);
  await removeMachineAccount(deps, caio.id, f.org.id, machineId, CODEX_ID);
  expect(calls.map((c) => (c.action === "remove" ? c.accountId : c.action))).toEqual([CLAUDE_ID, CODEX_ID]);
  expect(await accountRows(machineId)).toEqual([]);
});

test("a person who leaves or deletes their account: their accounts are signed out everywhere, never inherited", async () => {
  f = await setup();
  const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  hubs.push(hub);
  const { machineId, token } = await sharedMachine();
  const runner = connectedRunner(hub, token);
  await runner.hello([]);
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const bia = await addMember(f.db, f.org.id, "admin", "bia");
  await addAccount(machineId, CLAUDE_ID, "claude_code", { createdBy: caio.id });
  await addAccount(machineId, CODEX_ID, "codex", { createdBy: bia.id });
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainAccountId: CLAUDE_ID })
    .where(eq(schema.agents.id, f.agent.id));

  // Caio is removed: his account goes on the computer at once, his agent is released.
  await removeMember(f.db, f.owner.id, f.org.id, caio.id, { pubsub: f.pubsub });
  expect((await agentRow()).brainAccountId).toBeNull();
  await settle();
  expect(runner.removals()).toMatchObject([{ kind: "claude_code", accountId: CLAUDE_ID }]);
  expect(await accountRow(CLAUDE_ID)).toBeNull();

  // Bia deletes her account: a tombstone first, so the row never turns into nobody's account.
  await deleteAccount(f.db, bia.id, { pubsub: f.pubsub });
  await settle();
  expect(runner.removals().map((r) => (r.op === "account" && r.action === "remove" ? r.accountId : ""))).toEqual([
    CLAUDE_ID,
    CODEX_ID,
  ]);
  expect(await accountRow(CODEX_ID)).toBeNull();
  expect(await listMachineAccounts({ db: f.db }, f.org.id, machineId, f.owner.id)).toEqual([]);
});

test("the agent's account: its owner's own only, on its computer, of its brain's kind, one agent each", async () => {
  f = await setup();
  const { machineId } = await ownedMachine();
  await setAgentComputerTarget({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id, machineId);
  await addAccount(machineId, CLAUDE_ID, "claude_code");
  await addAccount(machineId, CODEX_ID, "codex");
  const admin = await addMember(f.db, f.org.id, "admin", "bia");
  const deps = { db: f.db };

  const chosen = await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, {
    brain: "claude_code",
    account: CLAUDE_ID,
    effort: "high",
  });
  expect(chosen).toMatchObject({
    brain: "claude_code",
    account: CLAUDE_ID,
    effort: "high",
    canManageAccounts: true,
    accountsSupported: true,
    canUsePlans: true,
    ownSignIn: true,
  });
  expect(chosen.accounts.map((a) => [a.id, a.kind, a.usedBy, a.mine])).toEqual([
    [CLAUDE_ID, "claude_code", ["Dev"], true],
    [CODEX_ID, "codex", [], true],
  ]);
  expect(await agentRow()).toMatchObject({ brainAccountId: CLAUDE_ID, brainEffort: "high" });
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "agent.brain"));
  expect(audit.at(-1)?.details).toMatchObject({ to: { account: CLAUDE_ID, effort: "high" } });

  // Another kind's account, one that isn't there, a bad effort: refused.
  const wrongKind = await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, { account: CODEX_ID }).catch((e) => e);
  expect(wrongKind).toBeInstanceOf(ValidationError);
  expect(wrongKind.code).toBe("account.invalid");
  const missing = await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, {
    account: "0193dddd-0000-4000-8000-000000000009",
  }).catch((e) => e);
  expect(missing.code).toBe("account.invalid");
  const effort = await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, { effort: "turbo" }).catch((e) => e);
  expect(effort.code).toBe("brain.invalid_effort");
  // "Automático": the model and the effort take auto, and read back as such.
  const auto = await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, { model: "auto", effort: "auto" });
  expect(auto).toMatchObject({ model: "auto", effectiveModel: "auto", effort: "auto", account: CLAUDE_ID });
  expect(await agentRow()).toMatchObject({ brainModel: "auto", brainEffort: "auto" });

  // An admin sees the owner's accounts, no emails, and picks among them as the owner does: the computer's own sign-in
  // (the owner connected it) and back. Signing in stays the owner's.
  const seen = await getAgentBrain(deps, admin.id, f.org.id, f.agent.id);
  expect(seen).toMatchObject({ account: CLAUDE_ID, canManageAccounts: false, canUsePlans: false });
  expect(seen.accounts.map((a) => [a.email, a.mine])).toEqual([
    [null, false],
    [null, false],
  ]);
  expect((await setAgentBrain(deps, admin.id, f.org.id, f.agent.id, { account: null })).account).toBeNull();
  expect((await setAgentBrain(deps, admin.id, f.org.id, f.agent.id, { account: CLAUDE_ID })).account).toBe(CLAUDE_ID);
  expect(await setAgentBrain(deps, admin.id, f.org.id, f.agent.id, { effort: "low" })).toMatchObject({
    account: CLAUDE_ID,
    effort: "low",
  });
  // Sending the same account back is no change (allowed for anyone who edits the brain).
  expect((await setAgentBrain(deps, admin.id, f.org.id, f.agent.id, { account: CLAUDE_ID })).account).toBe(CLAUDE_ID);

  // A login made for one agent thinks for one: another agent of the owner's can't take it.
  const [theo] = await f.db
    .insert(schema.agents)
    .values({
      orgId: f.org.id,
      name: "Theo",
      handle: "theo",
      model: "claude-sonnet-5-5",
      ownerUserId: f.owner.id,
      machineId,
      brain: "claude_code",
    })
    .returning();
  if (!theo) throw new Error("no agent");
  const taken = await setAgentBrain(deps, f.owner.id, f.org.id, theo.id, { account: CLAUDE_ID }).catch((e) => e);
  expect(taken).toBeInstanceOf(ConflictError);
  expect(taken.code).toBe("account.in_use");
  // An archived agent doesn't count.
  await f.db
    .update(schema.agents)
    .set({ archivedAt: new Date(), brainAccountId: CLAUDE_ID })
    .where(eq(schema.agents.id, theo.id));

  // Someone else's account thinks for the owner's agent only when given by who may use other people's plans (owners
  // and admins, ADR 0059 §3), and its owner's giving it to someone else's agent tells nobody.
  await addAccount(machineId, "0193dddd-0000-4000-8000-000000000003", "claude_code", {
    createdBy: admin.id,
    email: "bia@example.com",
  });
  const lent = await setAgentBrain(deps, admin.id, f.org.id, f.agent.id, {
    account: "0193dddd-0000-4000-8000-000000000003",
  });
  expect(lent.account).toBe("0193dddd-0000-4000-8000-000000000003");
  expect((await agentRow()).brainAccountLentBy).toBe(admin.id);
  expect(await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent.plan_lent"))).toHaveLength(0);

  // Another brain kind: back to the computer's own sign-in, whoever changes it.
  const codex = await setAgentBrain(deps, admin.id, f.org.id, f.agent.id, { brain: "codex" });
  expect(codex).toMatchObject({ brain: "codex", account: null, effort: "low" });
  expect((await agentRow()).brainAccountId).toBeNull();

  // The owner picks the Codex one; moving the agent to another computer clears it.
  await setAgentBrain(deps, f.owner.id, f.org.id, f.agent.id, { account: CODEX_ID });
  expect((await agentRow()).brainAccountId).toBe(CODEX_ID);
  await setAgentComputerTarget({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id, null);
  expect((await agentRow()).brainAccountId).toBeNull();
  expect(await getAgentBrain(deps, f.owner.id, f.org.id, f.agent.id)).toMatchObject({
    account: null,
    accounts: [],
    canManageAccounts: false,
    accountsSupported: false,
    ownSignIn: false,
  });
});

test("a runner older than accounts: the page says accounts aren't supported", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(BRAIN_PROTOCOL);
  await setAgentComputerTarget({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id, machineId);
  expect(await getAgentBrain({ db: f.db }, f.owner.id, f.org.id, f.agent.id)).toMatchObject({
    accounts: [],
    canManageAccounts: false,
    accountsSupported: false,
    ownSignIn: true,
  });
});

// ── Plan usage (protocol 19) ────────────────────────────────────────────────

const usage = (used: number, at = "2030-01-01T10:00:00.000Z"): PlanUsage => ({
  windows: [{ kind: "five_hour", usedPercent: used, resetsAt: "2030-01-01T15:00:00.000Z" }],
  source: "turn",
  at,
});

/** The `machine.updated` events with `accounts` the org's pages hear from now on. */
function accountEvents() {
  const events: Record<string, unknown>[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
    const event = (e as { event?: Record<string, unknown> }).event;
    if (event?.type === "machine.updated" && event.accounts) events.push(event);
  });
  return events;
}

test("plan usage: stored with the account, kept when the runner doesn't know it yet, published only when it shows", async () => {
  f = await setup();
  const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  hubs.push(hub);
  const { machineId, token } = await ownedMachine(PLAN_USAGE_PROTOCOL);
  const runner = connectedRunner(hub, token);
  const account = (u?: PlanUsage): RunnerAccountInfo => ({
    id: CLAUDE_ID,
    kind: "claude_code",
    loggedIn: true,
    email: "ana@example.com",
    plan: "max",
    ...(u ? { usage: u } : {}),
  });
  await runner.hello([account(usage(40))], PLAN_USAGE_PROTOCOL);
  expect((await accountRow(CLAUDE_ID))?.usage).toEqual(usage(40));
  const events = accountEvents();

  // The same numbers, newer: stored (the page says how old they are), nobody told.
  await runner.changed([account(usage(40, "2030-01-01T10:05:00.000Z"))]);
  expect((await accountRow(CLAUDE_ID))?.usage?.at).toBe("2030-01-01T10:05:00.000Z");
  expect(events).toHaveLength(0);
  // A point more: the pages refetch, once.
  await runner.changed([account(usage(41, "2030-01-01T10:06:00.000Z"))]);
  expect(events).toEqual([{ type: "machine.updated", machineId, accounts: true }]);
  // A runner that started again knows nothing yet: the last stays.
  await runner.hello([account()], PLAN_USAGE_PROTOCOL);
  const [view] = await listMachineAccounts({ db: f.db }, f.org.id, machineId, f.owner.id);
  expect(view?.usage).toEqual(usage(41, "2030-01-01T10:06:00.000Z"));
});

test("an OpenCode Go reading keeps the models at their own limits, and a refusal with no window full isn't the account's", async () => {
  f = await setup();
  const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  hubs.push(hub);
  const { token } = await ownedMachine(PLAN_USAGE_PROTOCOL);
  const runner = connectedRunner(hub, token);
  const account = (u: PlanUsage): RunnerAccountInfo => ({
    id: CLAUDE_ID,
    kind: "claude_code",
    loggedIn: true,
    provider: "opencode",
    keyHint: "oc_sk_…f4ke",
    usage: u,
  });
  await runner.hello([account(usage(40))], PLAN_USAGE_PROTOCOL);
  const until = new Date(Date.now() + 86_400_000).toISOString();
  await noteModelLimit(f.db, f.org.id, CLAUDE_ID, "deepseek-v4.1-flash", { until });
  await runner.changed([account({ ...usage(41, "2030-01-01T10:06:00.000Z"), limited: true })]);
  const kept = (await accountRow(CLAUDE_ID))?.usage;
  expect(kept?.limited).toBeUndefined();
  expect(kept?.windows[0]?.usedPercent).toBe(41);
  expect(kept?.models?.["deepseek-v4.1-flash"]?.until).toBe(until);
  // A full window is the account's limit, whatever model refused.
  await runner.changed([account({ ...usage(100, "2030-01-01T10:07:00.000Z"), limited: true })]);
  expect((await accountRow(CLAUDE_ID))?.usage?.limited).toBe(true);
});

test("the computer's own sign-ins' usage: by brain, kept across hello, in the agent's brain view", async () => {
  f = await setup();
  const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  hubs.push(hub);
  const { machineId, token } = await ownedMachine(PLAN_USAGE_PROTOCOL);
  await setAgentComputerTarget({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id, machineId);
  const runner = connectedRunner(hub, token);
  const executors = { claude: { version: "2.1.310", loggedIn: true } };
  await runner.hello([], PLAN_USAGE_PROTOCOL, { executors, ownUsage: { claude_code: usage(10) } });
  const events = accountEvents();
  await runner.changed([], { codex: usage(5) });
  expect(events).toHaveLength(1);
  // Nothing moved: nobody told.
  await runner.changed([], { codex: usage(5, "2030-01-01T10:01:00.000Z") });
  expect(events).toHaveLength(1);
  // The runner came back knowing nothing: what it said before stays, with what hello says now.
  await runner.hello([], PLAN_USAGE_PROTOCOL, { executors });
  const [m] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
  expect(m?.executors.claude?.version).toBe("2.1.310");
  expect(m?.executors.ownUsage).toEqual({ claude_code: usage(10), codex: usage(5, "2030-01-01T10:01:00.000Z") });
  const brain = await getAgentBrain({ db: f.db }, f.owner.id, f.org.id, f.agent.id);
  expect(brain.ownUsage.claude_code).toEqual(usage(10));
});

test("refreshing usage: the caller's own accounts, and their computers' own sign-ins, on online runners that know it", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(PLAN_USAGE_PROTOCOL);
  const member = await addMember(f.db, f.org.id, "member", "bea");
  await addAccount(machineId, CLAUDE_ID, "claude_code");
  await addAccount(machineId, CODEX_ID, "codex", { createdBy: member.id });
  const live = fakeHub(machineId, () => ({ accounts: [] }), { protocol: PLAN_USAGE_PROTOCOL });
  await refreshAiAccounts(live.deps, f.owner.id, f.org.id);
  // The person who connected it: their account and the computer's own sign-ins.
  expect(live.calls).toEqual([{ op: "account", action: "list", fresh: [CLAUDE_ID, "own:claude_code", "own:codex"] }]);
  await refreshAiAccounts(live.deps, member.id, f.org.id);
  expect(live.calls.at(-1)).toEqual({ op: "account", action: "list", fresh: [CODEX_ID] });
  // Nothing goes to a runner that doesn't know usage, nor to one that's offline.
  const old = fakeHub(machineId, () => ({ accounts: [] }));
  await refreshAiAccounts(old.deps, f.owner.id, f.org.id);
  const off = fakeHub(machineId, () => ({ accounts: [] }), { protocol: PLAN_USAGE_PROTOCOL, online: false });
  await refreshAiAccounts(off.deps, f.owner.id, f.org.id);
  expect([...old.calls, ...off.calls]).toEqual([]);
  // Only members ask.
  const stranger = await addUser(f.db, "zed");
  expect(await refreshAiAccounts(live.deps, stranger.id, f.org.id).catch((e) => e)).toBeInstanceOf(ForbiddenError);
});

test("one sign-in for all agents (protocol 29): asked for, it thinks for two agents, once; out and gone for both", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(SHARED_ACCOUNTS_PROTOCOL);
  const runner = signingRunner(
    machineId,
    () => ({ loggedIn: true, email: "ana@example.com", plan: "max", shared: true }),
    { protocol: SHARED_ACCOUNTS_PROTOCOL },
  );
  const { login, status } = await signIn(runner, f.owner.id, machineId);
  expect(runner.calls[0]).toEqual({
    op: "account",
    action: "begin",
    kind: "claude_code",
    loginId: login.loginId,
    shared: true,
  });
  expect(status).toMatchObject({ state: "done", account: { id: login.loginId, label: "Claude", shared: true } });
  // The computer shares every new sign-in: each of the person's agents there is one click away.
  expect((await listAiAccounts({ db: f.db }, f.owner.id, f.org.id)).computers[0]?.shares).toEqual({
    claude_code: true,
    codex: true,
    cursor: true,
    opencode: true,
    grok: true,
    antigravity: true,
    key: true,
  });

  // Two agents think with it, with no move and no sign-in.
  const [theo] = await f.db
    .insert(schema.agents)
    .values({
      orgId: f.org.id,
      name: "Theo",
      handle: "theo",
      model: "claude-sonnet-5-5",
      ownerUserId: f.owner.id,
      machineId,
      brain: "claude_code",
    })
    .returning();
  if (!theo) throw new Error("no agent");
  await setAgentComputerTarget({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id, machineId);
  await setAgentBrain({ db: f.db }, f.owner.id, f.org.id, f.agent.id, { brain: "claude_code", account: login.loginId });
  await setAgentBrain({ db: f.db }, f.owner.id, f.org.id, theo.id, { account: login.loginId });
  expect((await agentRow()).brainAccountId).toBe(login.loginId);
  expect((await agentRow(theo.id)).brainAccountId).toBe(login.loginId);
  const [listed] = await listMachineAccounts({ db: f.db }, f.org.id, machineId, f.owner.id);
  expect(listed).toMatchObject({ usedBy: ["Dev", "Theo"], usedByIds: [f.agent.id, theo.id], shared: true });
  expect(await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "account.moved"))).toEqual([]);

  // The same account signed in again here is the one already there.
  const again = await signIn(runner, f.owner.id, machineId);
  expect(again.status).toMatchObject({ state: "failed", duplicate: { account: { id: login.loginId } } });
  expect(runner.calls.at(-1)).toEqual({
    op: "account",
    action: "remove",
    kind: "claude_code",
    accountId: again.login.loginId,
  });

  // Signed out on the computer: for both agents at once (they stay on it, for one sign-in again).
  const sync = (accounts: RunnerAccountInfo[]) =>
    syncMachineAccounts({ db: f.db, pubsub: f.pubsub }, f.org.id, machineId, accounts);
  await sync([{ id: login.loginId, kind: "claude_code", loggedIn: false, shared: true }]);
  expect(await accountRow(login.loginId)).toMatchObject({ status: "signed_out", shared: true });
  expect([(await agentRow()).brainAccountId, (await agentRow(theo.id)).brainAccountId]).toEqual([
    login.loginId,
    login.loginId,
  ]);
  await sync([{ id: login.loginId, kind: "claude_code", loggedIn: true, shared: true }]);

  // Disconnected: both let it go.
  await removeMachineAccount(runner.deps, f.owner.id, f.org.id, machineId, login.loginId);
  expect([(await agentRow()).brainAccountId, (await agentRow(theo.id)).brainAccountId]).toEqual([null, null]);
});

test("a person with no agent signs a plan in for all agents, and the first agent they create thinks with it", async () => {
  f = await setup();
  const { machineId } = await sharedMachine();
  // The workspace's own computer (the Cloud's): any member adds accounts there and gives it to their agents.
  await f.db
    .update(schema.machines)
    .set({ protocol: SHARED_ACCOUNTS_PROTOCOL, kind: "managed" })
    .where(eq(schema.machines.id, machineId));
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  expect(await f.db.select().from(schema.agents).where(eq(schema.agents.ownerUserId, caio.id))).toEqual([]);
  const runner = signingRunner(
    machineId,
    () => ({ loggedIn: true, email: "caio@example.com", plan: "pro", shared: true }),
    { protocol: SHARED_ACCOUNTS_PROTOCOL },
  );
  const { login, status } = await signIn(runner, caio.id, machineId);
  expect(status).toMatchObject({ state: "done", account: { id: login.loginId, shared: true, usedBy: [] } });
  expect((await listAiAccounts({ db: f.db }, caio.id, f.org.id)).accounts).toMatchObject([
    { id: login.loginId, mine: true, status: "active", usedBy: [] },
  ]);

  const [lia] = await f.db
    .insert(schema.agents)
    .values({ orgId: f.org.id, name: "Lia", handle: "lia", model: "auto", ownerUserId: caio.id })
    .returning();
  if (!lia) throw new Error("no agent");
  await setAgentComputerTarget({ db: f.db, pubsub: f.pubsub }, caio.id, f.org.id, lia.id, machineId);
  await setAgentBrain({ db: f.db }, caio.id, f.org.id, lia.id, { brain: "claude_code", account: login.loginId });
  expect((await agentRow(lia.id)).brainAccountId).toBe(login.loginId);
});

test("an account the runner no longer says is for all agents: the two agents on it let it go, then it thinks for one", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(SHARED_ACCOUNTS_PROTOCOL);
  const ONE_ID = "0193dddd-0000-4000-8000-000000000005";
  await addAccount(machineId, CLAUDE_ID, "claude_code", { shared: true });
  await addAccount(machineId, ONE_ID, "claude_code", { shared: true, email: "ana.two@example.com" });
  const [theo] = await f.db
    .insert(schema.agents)
    .values({
      orgId: f.org.id,
      name: "Theo",
      handle: "theo",
      model: "claude-sonnet-5-5",
      ownerUserId: f.owner.id,
      machineId,
      brain: "claude_code",
      brainAccountId: CLAUDE_ID,
    })
    .returning();
  if (!theo) throw new Error("no agent");
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainAccountId: CLAUDE_ID })
    .where(eq(schema.agents.id, f.agent.id));
  // One login can't think for two: both agents go back to picking (an older runner, or signed in again for one).
  await syncMachineAccounts({ db: f.db, pubsub: f.pubsub }, f.org.id, machineId, [
    { id: CLAUDE_ID, kind: "claude_code", loggedIn: true },
    { id: ONE_ID, kind: "claude_code", loggedIn: true },
  ]);
  expect(await accountRow(CLAUDE_ID)).toMatchObject({ shared: false });
  expect([(await agentRow()).brainAccountId, (await agentRow(theo.id)).brainAccountId]).toEqual([null, null]);
  // Made for one agent again, it thinks for one: a second agent is refused.
  await setAgentBrain({ db: f.db }, f.owner.id, f.org.id, f.agent.id, { account: ONE_ID });
  const taken = await setAgentBrain({ db: f.db }, f.owner.id, f.org.id, theo.id, { account: ONE_ID }).catch((e) => e);
  expect(taken).toMatchObject({ code: "account.in_use" });
});

test("where each agent is its own OS user, the switch decides: Claude's and ChatGPT's sign-ins and plans' keys for all", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(SHARED_CODEX_PROTOCOL);
  const [m] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
  await f.db
    .update(schema.machines)
    .set({ executors: { ...m?.executors, mode: "system" } })
    .where(eq(schema.machines.id, machineId));
  expect((await listAiAccounts({ db: f.db }, f.owner.id, f.org.id)).computers[0]?.shares).toEqual({
    claude_code: true,
    codex: true,
    cursor: false,
    opencode: false,
    grok: false,
    antigravity: false,
    key: true,
  });
  // A runner before protocol 38 shares Claude's and keys only, and an older one nothing.
  await f.db
    .update(schema.machines)
    .set({ protocol: SHARED_CODEX_PROTOCOL - 1 })
    .where(eq(schema.machines.id, machineId));
  expect((await listAiAccounts({ db: f.db }, f.owner.id, f.org.id)).computers[0]?.shares).toEqual({
    claude_code: true,
    codex: false,
    cursor: false,
    opencode: false,
    grok: false,
    antigravity: false,
    key: true,
  });
  await f.db
    .update(schema.machines)
    .set({ protocol: SHARED_ACCOUNTS_PROTOCOL - 1 })
    .where(eq(schema.machines.id, machineId));
  expect((await listAiAccounts({ db: f.db }, f.owner.id, f.org.id)).computers[0]?.shares).toEqual({
    claude_code: false,
    codex: false,
    cursor: false,
    opencode: false,
    grok: false,
    antigravity: false,
    key: false,
  });
});

/** A runner on protocol 29 where every login thinks for all of its owner's agents: a plan's key, or Claude's sign-in. */
function sharingRunner(machineId: string) {
  const runner = signingRunner(
    machineId,
    (loginId) => {
      const secret = runner.codes.get(loginId) ?? "";
      return secret === KEY || secret.startsWith(KEY.slice(0, -4))
        ? { loggedIn: true, provider: "zai", keyHint: secret.slice(-4), shared: true }
        : { loggedIn: true, email: "ana@example.com", plan: "max", shared: true };
    },
    { protocol: SHARED_ACCOUNTS_PROTOCOL },
  );
  return runner;
}

/** A sign-in on the computer as the fixture's owner, new (`accountId` absent) or again, the whole way. */
async function signInWith(
  runner: ReturnType<typeof signingRunner>,
  machineId: string,
  secret: string,
  options: { accountId?: string; provider?: string } = {},
) {
  const login = await beginAccountLogin(
    runner.deps,
    f.owner.id,
    f.org.id,
    machineId,
    "claude_code",
    options.accountId,
    undefined,
    options.provider,
  );
  const box = await sealSecret(login.publicKey ?? "", secret, accountCodeAad(login.loginId, f.org.id));
  await sendAccountLoginCode(runner.deps, f.owner.id, f.org.id, machineId, login.loginId, box);
  return accountLoginStatus(runner.deps, f.owner.id, f.org.id, machineId, login.loginId);
}

const newAgent = async (name: string, machineId: string, brainAccountId: string | null = null) => {
  const [agent] = await f.db
    .insert(schema.agents)
    .values({
      orgId: f.org.id,
      name,
      handle: name.toLowerCase(),
      model: "claude-sonnet-5-5",
      ownerUserId: f.owner.id,
      machineId,
      brain: "claude_code",
      brainAccountId,
    })
    .returning();
  if (!agent) throw new Error("no agent");
  return agent;
};

test("logins made one per agent keep their agents when signed in again on a runner that says every login is for all agents", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(SHARED_ACCOUNTS_PROTOCOL);
  const KEY_1 = "0193dddd-0000-4000-8000-000000000011";
  const KEY_2 = "0193dddd-0000-4000-8000-000000000012";
  const CLAUDE_1 = "0193dddd-0000-4000-8000-000000000013";
  const CLAUDE_2 = "0193dddd-0000-4000-8000-000000000014";
  // One GLM Coding key signed in once per agent, and one Claude account the same way, as before protocol 29.
  const key = { provider: "zai", email: null, keyHint: "MnOp", label: "GLM Coding" };
  await addAccount(machineId, KEY_1, "claude_code", key);
  await addAccount(machineId, KEY_2, "claude_code", key);
  await addAccount(machineId, CLAUDE_1, "claude_code", { plan: "max", label: "Claude Max" });
  await addAccount(machineId, CLAUDE_2, "claude_code", { plan: "max", label: "Claude Max", status: "signed_out" });
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainAccountId: KEY_1 })
    .where(eq(schema.agents.id, f.agent.id));
  const theo = await newAgent("Theo", machineId, KEY_2);
  const ada = await newAgent("Ada", machineId, CLAUDE_1);
  const mila = await newAgent("Mila", machineId, CLAUDE_2);
  const report = (keyHint: string, claude2: boolean): RunnerAccountInfo[] => [
    { id: KEY_1, kind: "claude_code", loggedIn: true, provider: "zai", keyHint, shared: true },
    { id: KEY_2, kind: "claude_code", loggedIn: true, provider: "zai", keyHint, shared: true },
    { id: CLAUDE_1, kind: "claude_code", loggedIn: true, email: "ana@example.com", plan: "max", shared: true },
    { id: CLAUDE_2, kind: "claude_code", loggedIn: claude2, email: "ana@example.com", plan: "max", shared: true },
  ];
  // Every agent is the runner's own user here: the runner says each of them thinks for all agents.
  await syncMachineAccounts({ db: f.db, pubsub: f.pubsub }, f.org.id, machineId, report("MnOp", false));
  const runner = sharingRunner(machineId);
  const NEW_KEY = `${KEY.slice(0, -4)}WxYz`;

  // New key, given to each of its logins in turn: each takes it and keeps its agent.
  for (const accountId of [KEY_1, KEY_2]) {
    expect(await signInWith(runner, machineId, NEW_KEY, { accountId, provider: "zai" })).toMatchObject({
      state: "done",
      account: { id: accountId, keyHint: "WxYz" },
    });
  }
  // The same key once more is still that login, never a duplicate of the other.
  expect(await signInWith(runner, machineId, NEW_KEY, { accountId: KEY_1, provider: "zai" })).toMatchObject({
    state: "done",
    account: { id: KEY_1 },
  });
  // Signed in again where the other login of the account is: that login, its agent with it.
  expect(await signInWith(runner, machineId, "abc#123", { accountId: CLAUDE_2 })).toMatchObject({
    state: "done",
    account: { id: CLAUDE_2, status: "active" },
  });
  // The next report changes none of it.
  await syncMachineAccounts({ db: f.db, pubsub: f.pubsub }, f.org.id, machineId, report("WxYz", true));
  expect((await accountRows(machineId)).map((r) => [r.id, r.status, r.keyHint])).toEqual([
    [KEY_1, "active", "WxYz"],
    [KEY_2, "active", "WxYz"],
    [CLAUDE_1, "active", null],
    [CLAUDE_2, "active", null],
  ]);
  const thinking = async () =>
    Promise.all([f.agent.id, theo.id, ada.id, mila.id].map(async (id) => (await agentRow(id)).brainAccountId));
  expect(await thinking()).toEqual([KEY_1, KEY_2, CLAUDE_1, CLAUDE_2]);
});

test("where each agent is its own OS user, a key's login made for one agent leaves room for a new one for all agents", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(SHARED_ACCOUNTS_PROTOCOL);
  const [m] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
  await f.db
    .update(schema.machines)
    .set({ executors: { ...m?.executors, mode: "system" } })
    .where(eq(schema.machines.id, machineId));
  const OLD = "0193dddd-0000-4000-8000-000000000015";
  // Made for Dev alone, lent to its user: it can't think for anyone else.
  await addAccount(machineId, OLD, "claude_code", {
    provider: "zai",
    email: null,
    keyHint: "MnOp",
    label: "GLM Coding",
  });
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainAccountId: OLD })
    .where(eq(schema.agents.id, f.agent.id));
  const theo = await newAgent("Theo", machineId);
  const mila = await newAgent("Mila", machineId);
  const status = await signInWith(sharingRunner(machineId), machineId, KEY, { provider: "zai" });
  expect(status).toMatchObject({ state: "done", account: { keyHint: "MnOp", shared: true, label: "GLM Coding" } });
  const id = status.account?.id ?? "";
  expect(id).not.toBe(OLD);
  // The new one thinks for the others with nothing more to sign in; the old one keeps Dev.
  await setAgentBrain({ db: f.db }, f.owner.id, f.org.id, theo.id, { account: id });
  await setAgentBrain({ db: f.db }, f.owner.id, f.org.id, mila.id, { account: id });
  expect([(await agentRow()).brainAccountId, (await agentRow(theo.id)).brainAccountId]).toEqual([OLD, id]);
  expect((await agentRow(mila.id)).brainAccountId).toBe(id);

  // A second sign-in for all agents of that key is the one already there.
  expect(await signInWith(sharingRunner(machineId), machineId, KEY, { provider: "zai" })).toMatchObject({
    state: "failed",
    duplicate: { account: { id } },
  });
});

// ── How each connection signs in (protocol 50, ADR 0150) ────────────────────

/** A computer where each agent is its own OS user, on `protocol`, its runner saying `methods` (protocol 50). */
async function systemMachine(protocol = CLAUDE_AUTH_PROTOCOL, methods?: ("cli_login" | "setup_token")[]) {
  const paired = await ownedMachine(protocol);
  const [m] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, paired.machineId));
  await f.db
    .update(schema.machines)
    .set({ executors: { ...m?.executors, mode: "system", ...(methods ? { claudeLoginMethods: methods } : {}) } })
    .where(eq(schema.machines.id, paired.machineId));
  return paired;
}

test("the Claude sign-in policy: no row is setup-token for the listed workspaces; set once, unknown workspaces refused", async () => {
  f = await setup();
  expect(await claudeAuthPolicy(f.db)).toEqual({
    method: "setup_token",
    rollout: "selected",
    orgIds: [],
    changedAt: null,
  });
  const at = new Date("2026-03-02T10:00:00Z");
  const set = await setClaudeAuthPolicy(
    f.db,
    { method: "cli_login", rollout: "selected", orgIds: [f.org.id.toUpperCase(), f.org.id] },
    at,
  );
  expect(set).toEqual({ method: "cli_login", rollout: "selected", orgIds: [f.org.id], changedAt: at });
  // The same again changes nothing, its time included.
  const again = await setClaudeAuthPolicy(f.db, { method: "cli_login", rollout: "selected", orgIds: [f.org.id] });
  expect(again.changedAt).toEqual(at);
  await expect(
    setClaudeAuthPolicy(f.db, {
      method: "cli_login",
      rollout: "all",
      orgIds: ["0193dddd-0000-4000-8000-0000000000ff"],
    }),
  ).rejects.toMatchObject({ code: "claude_auth.unknown_org" });
  await expect(setClaudeAuthPolicy(f.db, { method: "api_key", rollout: "all", orgIds: [] })).rejects.toBeInstanceOf(
    ValidationError,
  );
  expect((await claudeAuthPolicy(f.db)).changedAt).toEqual(at);

  // A listed workspace deleted since drops out of the next change; a new id still must exist.
  const [gone] = await f.db.insert(schema.organizations).values({ name: "Beta" }).returning();
  const [added] = await f.db.insert(schema.organizations).values({ name: "Gama" }).returning();
  const goneId = gone?.id ?? "";
  const addedId = added?.id ?? "";
  await setClaudeAuthPolicy(f.db, { method: "cli_login", rollout: "selected", orgIds: [f.org.id, goneId] });
  await f.db.delete(schema.organizations).where(eq(schema.organizations.id, goneId));
  const kept = await setClaudeAuthPolicy(f.db, {
    method: "cli_login",
    rollout: "selected",
    orgIds: [f.org.id, goneId, addedId],
  });
  expect(kept.orgIds).toEqual([f.org.id, addedId].sort());
  await expect(
    setClaudeAuthPolicy(f.db, { method: "cli_login", rollout: "selected", orgIds: [f.org.id, goneId] }),
  ).rejects.toMatchObject({ code: "claude_auth.unknown_org" });

  const other = "0193dddd-0000-4000-8000-0000000000fe";
  const listed = { method: "cli_login" as const, rollout: "selected" as const, orgIds: [f.org.id] };
  expect(claudeAuthMethodFor(listed, f.org.id, true)).toBe("cli_login");
  expect(claudeAuthMethodFor(listed, other, true)).toBe("setup_token");
  expect(claudeAuthMethodFor({ ...listed, rollout: "all" }, other, true)).toBe("cli_login");
  expect(claudeAuthMethodFor({ ...listed, method: "setup_token", rollout: "all" }, f.org.id, true)).toBe("setup_token");
  // Where the agents are the runner's own user, always Claude's own login.
  expect(claudeAuthMethodFor({ ...listed, method: "setup_token" }, f.org.id, false)).toBe("cli_login");
});

test("a new Claude sign-in for all agents takes the policy's method once; signing in again keeps the row's", async () => {
  f = await setup();
  const { machineId } = await systemMachine(CLAUDE_AUTH_PROTOCOL, ["setup_token"]);
  const over = { protocol: CLAUDE_AUTH_PROTOCOL };
  const runner = signingRunner(machineId, () => ({ loggedIn: true, email: "ana@example.com", shared: true }), over);
  const { login, status } = await signIn(runner, f.owner.id, machineId);
  expect(runner.calls[0]).toMatchObject({ action: "begin", shared: true, method: "setup_token" });
  expect(status).toMatchObject({ state: "done" });
  expect(await accountRow(login.loginId)).toMatchObject({ authMethod: "setup_token", status: "active" });

  // The policy moves this workspace to Claude's own login: a runner that can't is refused, with nothing left behind.
  await setClaudeAuthPolicy(f.db, { method: "cli_login", rollout: "selected", orgIds: [f.org.id] });
  const before = (await accountRows(machineId)).length;
  const refused = fakeHub(machineId, () => ({ url: "https://claude.ai/x" }), over);
  const error = await beginAccountLogin(refused.deps, f.owner.id, f.org.id, machineId, "claude_code").catch((e) => e);
  expect(error).toBeInstanceOf(ConflictError);
  expect(error).toMatchObject({ code: "account.method_unsupported" });
  expect(refused.calls).toEqual([]);
  expect((await accountRows(machineId)).length).toBe(before);

  // Signing in again keeps the account's own method, whatever the policy says now.
  await f.db
    .update(schema.machineAccounts)
    .set({ status: "signed_out" })
    .where(eq(schema.machineAccounts.id, login.loginId));
  const again = signingRunner(machineId, () => ({ loggedIn: true, email: "ana@example.com", shared: true }), over);
  await beginAccountLogin(again.deps, f.owner.id, f.org.id, machineId, "claude_code", login.loginId);
  expect(again.calls[0]).toMatchObject({ action: "begin", again: true, method: "setup_token" });

  // One whose method nobody knows signs in again as the runner always did.
  await f.db
    .update(schema.machineAccounts)
    .set({ authMethod: null })
    .where(eq(schema.machineAccounts.id, login.loginId));
  const legacy = signingRunner(machineId, () => ({ loggedIn: true, shared: true }), over);
  await beginAccountLogin(legacy.deps, f.owner.id, f.org.id, machineId, "claude_code", login.loginId);
  expect(legacy.calls[0]).not.toHaveProperty("method");
});

test("a runner that can use Claude's own login for all agents gets it; an older one gets no method, as before", async () => {
  f = await setup();
  await setClaudeAuthPolicy(f.db, { method: "cli_login", rollout: "all", orgIds: [] });
  const { machineId } = await systemMachine(CLAUDE_AUTH_PROTOCOL, ["cli_login", "setup_token"]);
  const over = { protocol: CLAUDE_AUTH_PROTOCOL };
  const runner = signingRunner(machineId, () => ({ loggedIn: true, shared: true }), over);
  const login = await beginAccountLogin(runner.deps, f.owner.id, f.org.id, machineId, "claude_code");
  expect(runner.calls[0]).toMatchObject({ shared: true, method: "cli_login" });
  expect(await accountRow(login.loginId)).toMatchObject({ authMethod: "cli_login", status: "signing_in" });

  // Below protocol 50 in system mode: setup-token is all it does, so the policy's own login is refused.
  const { machineId: old } = await systemMachine(SHARED_ACCOUNTS_PROTOCOL, ["cli_login"]);
  const oldRunner = fakeHub(old, () => ({ url: "https://claude.ai/x" }), { protocol: SHARED_ACCOUNTS_PROTOCOL });
  await expect(beginAccountLogin(oldRunner.deps, f.owner.id, f.org.id, old, "claude_code")).rejects.toMatchObject({
    code: "account.method_unsupported",
  });
  await setClaudeAuthPolicy(f.db, { method: "setup_token", rollout: "selected", orgIds: [] });
  const legacy = signingRunner(old, () => ({ loggedIn: true, shared: true }), { protocol: SHARED_ACCOUNTS_PROTOCOL });
  const kept = await beginAccountLogin(legacy.deps, f.owner.id, f.org.id, old, "claude_code");
  expect(legacy.calls[0]).toEqual({
    op: "account",
    action: "begin",
    kind: "claude_code",
    loginId: kept.loginId,
    shared: true,
  });
  expect(await accountRow(kept.loginId)).toMatchObject({ authMethod: "setup_token" });

  // A plan's key is a key; ChatGPT signs in with its own CLI.
  const keys = fakeHub(machineId, async () => ({ publicKey: (await generateSecretKeyPair()).publicKey }), over);
  const key = await beginAccountLogin(
    keys.deps,
    f.owner.id,
    f.org.id,
    machineId,
    "claude_code",
    undefined,
    undefined,
    "zai",
  );
  expect(keys.calls[0]).not.toHaveProperty("method");
  expect(await accountRow(key.loginId)).toMatchObject({ authMethod: "api_key" });
  const codex = fakeHub(
    machineId,
    () => ({ url: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" }),
    over,
  );
  const chatgpt = await beginAccountLogin(codex.deps, f.owner.id, f.org.id, machineId, "codex");
  expect(await accountRow(chatgpt.loginId)).toMatchObject({ authMethod: "cli_login" });
});

test("system mode: one agent's Claude login signed in again for all agents goes without its read-off method", async () => {
  f = await setup();
  const { machineId } = await systemMachine(CLAUDE_AUTH_PROTOCOL, ["setup_token"]);
  await addAccount(machineId, CLAUDE_ID, "claude_code", { status: "signed_out", authMethod: "cli_login" });
  const runner = fakeHub(machineId, () => ({ url: "https://claude.ai/x" }), { protocol: CLAUDE_AUTH_PROTOCOL });
  await beginAccountLogin(runner.deps, f.owner.id, f.org.id, machineId, "claude_code", CLAUDE_ID);
  expect(runner.calls[0]).toMatchObject({ action: "begin", again: true, shared: true });
  expect(runner.calls[0]).not.toHaveProperty("method");
});

test("a runner that says it signs in for all agents with a token alone is in system mode, whatever the hub kept", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(CLAUDE_AUTH_PROTOCOL);
  const [m] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
  await f.db
    .update(schema.machines)
    .set({ executors: { ...m?.executors, claudeLoginMethods: ["setup_token"] } })
    .where(eq(schema.machines.id, machineId));
  const runner = fakeHub(machineId, () => ({ url: "https://claude.ai/x" }), { protocol: CLAUDE_AUTH_PROTOCOL });
  const login = await beginAccountLogin(runner.deps, f.owner.id, f.org.id, machineId, "claude_code");
  expect(runner.calls[0]).toMatchObject({ action: "begin", shared: true, method: "setup_token" });
  expect(await accountRow(login.loginId)).toMatchObject({ authMethod: "setup_token" });
});

test("reports: the method and Claude's organization stay when not said; an inconclusive look keeps the status", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(CLAUDE_AUTH_PROTOCOL);
  await addAccount(machineId, CLAUDE_ID, "claude_code", { authMethod: "cli_login" });
  const sync = (accounts: RunnerAccountInfo[]) => syncMachineAccounts({ db: f.db }, f.org.id, machineId, accounts);
  const base = { id: CLAUDE_ID, kind: "claude_code" as const, email: "ana@example.com" };

  await sync([{ ...base, loggedIn: true, providerOrgId: "org-ada-1", orgName: "Ada Labs" }]);
  expect(await accountRow(CLAUDE_ID)).toMatchObject({
    authMethod: "cli_login",
    providerOrgId: "org-ada-1",
    orgName: "Ada Labs",
    statusUnknown: false,
  });
  // The CLI timed out: the runner's last known answer is "signed in", but nothing flips either way.
  await f.db
    .update(schema.machineAccounts)
    .set({ status: "signed_out" })
    .where(eq(schema.machineAccounts.id, CLAUDE_ID));
  await sync([{ ...base, loggedIn: true, statusUnknown: true }]);
  expect(await accountRow(CLAUDE_ID)).toMatchObject({
    status: "signed_out",
    statusUnknown: true,
    authMethod: "cli_login",
    providerOrgId: "org-ada-1",
  });
  expect((await listMachineAccounts({ db: f.db }, f.org.id, machineId, f.owner.id))[0]).toMatchObject({
    status: "signed_out",
    statusKnown: false,
  });
  // A conclusive answer settles it; a method the runner now says replaces the stored one.
  await sync([{ ...base, loggedIn: true, authMethod: "setup_token" }]);
  expect(await accountRow(CLAUDE_ID)).toMatchObject({
    status: "active",
    statusUnknown: false,
    authMethod: "setup_token",
  });
  await sync([{ ...base, loggedIn: false }]);
  expect(await accountRow(CLAUDE_ID)).toMatchObject({ status: "signed_out", authMethod: "setup_token" });
});

test("a finished sign-in's account is checked like a hello's: unknown method, bad org id and long names left out", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(CLAUDE_AUTH_PROTOCOL);
  const runner = signingRunner(
    machineId,
    () =>
      ({
        loggedIn: true,
        email: "ana@example.com",
        authMethod: "oauth",
        providerOrgId: "not an id!",
        orgName: `Ada${"\u0007".repeat(3)} ${"x".repeat(5000)}`,
        statusUnknown: "yes",
      }) as unknown as Omit<RunnerAccountInfo, "id" | "kind">,
    { protocol: CLAUDE_AUTH_PROTOCOL },
  );
  const { login, status } = await signIn(runner, f.owner.id, machineId);
  expect(status).toMatchObject({ state: "done" });
  const row = await accountRow(login.loginId);
  expect(row).toMatchObject({ status: "active", authMethod: "cli_login", providerOrgId: null, statusUnknown: false });
  expect(row?.orgName?.length).toBe(120);
});

test("one email in two of Claude's organizations is two accounts; a login that doesn't say its organization is either", async () => {
  f = await setup();
  const { machineId } = await ownedMachine(CLAUDE_AUTH_PROTOCOL);
  await addAccount(machineId, CLAUDE_ID, "claude_code", { label: "Pessoal", providerOrgId: "org-ana-personal" });
  const labelOf = async (providerOrgId?: string) => {
    const runner = signingRunner(machineId, () => ({
      loggedIn: true,
      email: "ana@example.com",
      plan: "team",
      ...(providerOrgId ? { providerOrgId } : {}),
    }));
    return (await signIn(runner, f.owner.id, machineId)).status.account;
  };
  // Another organization: a new account, under a name of its own; its owner sees which organization.
  expect(await labelOf("org-ana-team")).toMatchObject({ label: "Claude", providerOrgId: "org-ana-team" });
  // The same organization, or one not said: a login of the account it is, under its name.
  expect((await labelOf("org-ana-personal"))?.label).toBe("Pessoal");
  expect((await labelOf())?.label).toBe("Pessoal");
  // A rename renames that account's logins only.
  await renameMachineAccount({ db: f.db }, f.owner.id, f.org.id, machineId, CLAUDE_ID, "Casa");
  expect((await accountRows(machineId)).map((r) => r.label).sort()).toEqual(["Casa", "Casa", "Casa", "Claude"]);
  // Only its owner sees the organization.
  const bia = await addMember(f.db, f.org.id, "admin", "bia");
  const asBia = await getMachineAccounts({ db: f.db }, bia.id, f.org.id, machineId);
  expect(asBia.accounts.map((a) => a.providerOrgId)).toEqual([null, null, null, null]);
});

test("hello keeps what a new Claude sign-in for all agents can use on the computer (protocol 50)", async () => {
  f = await setup();
  const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
  hubs.push(hub);
  const { machineId, token } = await ownedMachine();
  const runner = connectedRunner(hub, token);
  const executors = async () =>
    (await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId)))[0]?.executors;
  await runner.hello([], CLAUDE_AUTH_PROTOCOL, { claudeLoginMethods: ["cli_login"] });
  expect((await executors())?.claudeLoginMethods).toEqual(["cli_login"]);
  // An older runner says nothing: nothing of a newer one's stays.
  await runner.hello([], CLAUDE_AUTH_PROTOCOL - 1, { executors: { claude: { version: "2.1.304" } } });
  expect((await executors())?.claudeLoginMethods).toBeUndefined();
});
