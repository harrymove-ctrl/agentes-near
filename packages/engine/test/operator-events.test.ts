import { afterEach, expect, test } from "bun:test";
import { asc, type Database, eq, rowsOf, schema, sql } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import {
  ACCOUNT_FAILURE_EVERY_MS,
  adoptRestoredOperatorEvents,
  applyTaskDone,
  createInvitation,
  createOrganization,
  deleteAccount,
  drainOutbox,
  enableOperatorEvents,
  grantScopes,
  inviteLink,
  listOperatorEvents,
  type OperatorEvent,
  postPersonMessage,
  pruneOperatorEvents,
  recordAccountFailure,
  recordOperatorEvent,
  recordSession,
  recordSignUp,
  resendInvitation,
  resetAccountFailures,
  type ToolSource,
  ValidationError,
} from "../src";
import { addUser, type Fixture, SECRET, setup } from "./fixtures";
import { giveMail, imapAccount, mailSetup, runContext } from "./mail-fixtures";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  enableOperatorEvents(false);
  await close?.();
  close = undefined;
});

const API_KEY = "sk-ant-test-key-1234";

const lookup: ToolSource = {
  name: "test-lookup",
  tools: async () => [
    {
      name: "lookup",
      description: "Looks something up",
      scope: "test:read",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      describe: (input) => ({ title: `Look up ${input.q}` }),
      execute: async () => ({ content: "Launch is on Friday." }),
    },
  ],
};

/** The fixture with the lookup tool: the agent calls it once, then answers. */
async function fixture() {
  const f = await setup({
    toolSources: [lookup],
    reply: (request) =>
      JSON.stringify(request.messages.at(-1)?.content).includes("Launch is on Friday")
        ? { chunks: ["It launches on Friday."] }
        : { chunks: [], toolUses: [{ name: "lookup", input: { q: "launch date" } }] },
  });
  close = f.close;
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "test:read" }]);
  return f;
}

const allEvents = (db: Database) =>
  db.select().from(schema.operatorEvents).orderBy(asc(schema.operatorEvents.xactId), asc(schema.operatorEvents.id));

/** One person with an organization only they are in, and its invitations, a run and a task: every emitter once. */
async function everyEmitter(f: Fixture) {
  const invited = await createInvitation(f.db, f.owner.id, f.org.id, { email: "Bea@Partner.Example", role: "member" });
  const resent = await resendInvitation(f.db, f.owner.id, f.org.id, invited.invitation.id);
  const link = await inviteLink(f.db, SECRET, f.owner.id, f.org.id);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev when is the launch?",
  });
  await drainOutbox(f.db, f.handlers);

  const [machine] = await f.db.insert(schema.machines).values({ orgId: f.org.id, name: "Mac" }).returning();
  if (!machine) throw new Error("no machine");
  const [task] = await f.db
    .insert(schema.machineTasks)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      machineId: machine.id,
      channelId: f.general.id,
      title: "Build",
      executor: "shell",
      command: "make build",
      status: "running",
      startedAt: new Date(),
    })
    .returning();
  if (!task) throw new Error("no task");
  await applyTaskDone({ db: f.db, pubsub: f.pubsub }, machine.id, {
    type: "task.done",
    taskId: task.id,
    exitCode: 0,
    seconds: 4,
    result: "built",
  });

  const solo = await addUser(f.db, "bia");
  const { organization: soloOrg } = await createOrganization(f.db, solo.id, { name: "Bia's" });
  await f.db.insert(schema.accounts).values({
    id: `acct-${solo.id}`,
    userId: solo.id,
    providerId: "credential",
    accountId: solo.id,
    password: "hashed-password-value",
  });
  await recordSignUp(f.db, { userId: solo.id, providerId: "credential" });
  await recordSession(f.db, { userId: solo.id, ipAddress: "198.51.100.7", userAgent: "Mozilla/5.0" });
  await deleteAccount(f.db, solo.id);
  return { tokens: [invited.token, resent.token, link.token], solo, soloOrg, task, machine };
}

test("off by default: nothing is recorded", async () => {
  const f = await fixture();
  await everyEmitter(f);
  expect(await allEvents(f.db)).toEqual([]);
});

test("each emitter writes one row, metadata only", async () => {
  enableOperatorEvents();
  const f = await fixture();
  const { tokens, solo, soloOrg, task } = await everyEmitter(f);
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const rows = await allEvents(f.db);
  const owner = f.owner.id;
  const org = f.org.id;
  expect(rows.map(({ type, orgId, userId, data }) => ({ type, orgId, userId, data }))).toEqual([
    { type: "organization.created", orgId: org, userId: owner, data: { name: "Acme", mode: "team" } },
    { type: "agent.created", orgId: org, userId: owner, data: { agentId: f.agent.id } },
    {
      type: "invitation.created",
      orgId: org,
      userId: owner,
      data: { emailDomain: "partner.example", role: "member" },
    },
    {
      type: "invitation.created",
      orgId: org,
      userId: owner,
      data: { emailDomain: "partner.example", role: "member", resent: true },
    },
    { type: "invitation.created", orgId: org, userId: owner, data: { link: true } },
    {
      type: "run.finished",
      orgId: org,
      userId: null,
      data: { runId: run.id, agentId: f.agent.id, brain: "model", status: "done", toolCalls: 1 },
    },
    {
      type: "task.finished",
      orgId: org,
      userId: null,
      data: { taskId: task.id, agentId: f.agent.id, executor: "shell", status: "done" },
    },
    { type: "organization.created", orgId: soloOrg.id, userId: solo.id, data: { name: "Bia's", mode: "team" } },
    { type: "user.signed_up", orgId: null, userId: solo.id, data: { email: solo.email, method: "email" } },
    {
      type: "session.created",
      orgId: null,
      userId: solo.id,
      data: { ip: "198.51.100.7", userAgent: "Mozilla/5.0" },
    },
    {
      type: "organization.deletion_requested",
      orgId: soloOrg.id,
      userId: solo.id,
      data: { dueAt: expect.any(String), via: "account" },
    },
    { type: "user.deleted", orgId: null, userId: solo.id, data: {} },
  ]);
  // The rows outlive what they name.
  expect(await f.db.select().from(schema.users).where(sql`${schema.users.id} = ${solo.id}`)).toEqual([]);

  const text = JSON.stringify(rows);
  for (const secret of [...tokens, API_KEY, "hashed-password-value", "when is the launch", "Launch is on Friday"]) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toMatch(/"[^"]*(token|password|secret|hash|key)[^"]*":/i);
});

test("a sign-up is the first sign-in method only; a session's user agent is capped", async () => {
  enableOperatorEvents();
  const { db, close: done } = await createTestDatabase();
  close = done;
  const user = await addUser(db, "cris");
  const account = (providerId: string) =>
    db.insert(schema.accounts).values({ id: `${providerId}-${user.id}`, userId: user.id, providerId, accountId: "x" });
  await account("github");
  await recordSignUp(db, { userId: user.id, providerId: "github" });
  await account("google");
  await recordSignUp(db, { userId: user.id, providerId: "google" });
  await recordSignUp(db, { userId: "nobody", providerId: "google" });
  await recordSession(db, { userId: user.id, ipAddress: null, userAgent: "x".repeat(5000) });
  const rows = await allEvents(db);
  expect(rows.map((r) => [r.type, r.data])).toEqual([
    ["user.signed_up", { email: user.email, method: "github" }],
    ["session.created", { ip: null, userAgent: "x".repeat(512) }],
  ]);
});

test("mail sent: the agent, how many recipients and their domains; never addresses, subject or body", async () => {
  enableOperatorEvents();
  const m = await mailSetup();
  close = m.f.close;
  const account = await imapAccount(m);
  await giveMail(m, account.id, "read_write");
  const ctx = await runContext(m.f);
  const r = await m.tools.invoke(ctx, {
    toolUseId: "tu_send",
    name: "mail_support_send",
    input: {
      to: ["Ana@Acme.com"],
      cc: ["boss@acme.com", "x@other.example"],
      subject: "Quarterly numbers",
      body: "The secret plan",
      why: "Ana asked for the numbers today; sending them answers her request.",
    },
  });
  if (r.type !== "approval") throw new Error("expected an approval");
  await m.tools.executeApproved(ctx, { ...r.approval, status: "approved" });
  const rows = (await allEvents(m.f.db)).filter((e) => e.type === "mail.sent");
  expect(rows.map((e) => ({ orgId: e.orgId, data: e.data }))).toEqual([
    {
      orgId: m.f.org.id,
      data: {
        agentId: m.f.agent.id,
        runId: ctx.runId,
        kind: "send",
        recipients: 3,
        domains: ["acme.com", "other.example"],
      },
    },
  ]);
  expect(JSON.stringify(rows)).not.toMatch(/ana@|boss@|Quarterly|secret plan/i);
});

test("the feed serves rows in commit order and never skips one still being written", async () => {
  enableOperatorEvents();
  const { db, close: done } = await createTestDatabase();
  close = done;
  /** The commit horizon: every transaction below it has ended. */
  const horizon = async () =>
    BigInt(
      rowsOf<{ x: string }>(await db.execute(sql`select pg_snapshot_xmin(pg_current_snapshot())::text as x`))[0]?.x ??
        "0",
    );
  const event = (n: number): OperatorEvent => ({ type: "agent.created", data: { n } });

  // A row of a transaction still running when the feed is read: its id is older than the next rows'
  // (ordered by id it would come first, before the cursor, and be skipped).
  const pending = Bun.randomUUIDv7();
  await db
    .insert(schema.operatorEvents)
    .values({ id: pending, type: "agent.created", data: { n: 0 }, xactId: String((await horizon()) + 1_000_000n) });
  await recordOperatorEvent(db, event(1));
  await recordOperatorEvent(db, event(2));

  const atFirstRead = await horizon();
  const first = await listOperatorEvents(db, { limit: 100 });
  expect(first.events.map((e) => e.data.n)).toEqual([1, 2]);
  expect(first.events.every((e) => e.id > pending)).toBe(true);
  // Nothing new yet: the caller keeps its place.
  expect(await listOperatorEvents(db, { after: first.next ?? undefined, limit: 100 })).toEqual({
    events: [],
    next: first.next,
  });

  // Its transaction commits. It was running at the first read, so its transaction id is at or above
  // that read's horizon: the row comes after the cursor, not before it.
  await db
    .update(schema.operatorEvents)
    .set({ xactId: String(atFirstRead) })
    .where(eq(schema.operatorEvents.id, pending));
  await recordOperatorEvent(db, event(3));
  const later = await listOperatorEvents(db, { after: first.next ?? undefined, limit: 100 });
  expect(later.events.map((e) => e.data.n)).toEqual([0, 3]);

  // Paged one at a time from the start: every row exactly once, in the same order.
  const seen: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await listOperatorEvents(db, { after, limit: 1 });
    if (page.events.length === 0) break;
    seen.push(...page.events.map((e) => e.id));
    after = page.next ?? undefined;
  }
  expect(seen).toEqual([...first.events, ...later.events].map((e) => e.id));
  expect(new Set(seen).size).toBe(4);

  await expect(listOperatorEvents(db, { after: "nope", limit: 10 })).rejects.toBeInstanceOf(ValidationError);
});

test("after a restore from a dump: a cursor from before is refused, and the rows it brought come first", async () => {
  enableOperatorEvents();
  const { db, close: done } = await createTestDatabase();
  close = done;
  const next = async () =>
    BigInt(
      rowsOf<{ x: string }>(await db.execute(sql`select pg_snapshot_xmax(pg_current_snapshot())::text as x`))[0]?.x ??
        "0",
    );
  // The dumped database had given out far more transaction ids than this one has.
  const restored = Bun.randomUUIDv7();
  const theirs = String((await next()) + 5_000_000n);
  await db.insert(schema.operatorEvents).values({ id: restored, type: "user.deleted", xactId: theirs });
  await recordOperatorEvent(db, { type: "agent.created", data: { n: 1 } });

  // The caller's cursor from before the restore would never see a new event: refused, not left waiting.
  const before = Buffer.from(JSON.stringify([theirs, restored])).toString("base64url");
  await expect(listOperatorEvents(db, { after: before, limit: 10 })).rejects.toMatchObject({ code: "stale_cursor" });
  // Until they are adopted, the restored rows sit past the horizon.
  expect((await listOperatorEvents(db, { limit: 10 })).events.map((e) => e.type)).toEqual(["agent.created"]);

  expect(await adoptRestoredOperatorEvents(db)).toBe(1);
  expect(await adoptRestoredOperatorEvents(db)).toBe(0);
  const fresh = await listOperatorEvents(db, { limit: 10 });
  expect(fresh.events.map((e) => e.id)[0]).toBe(restored);
  expect(fresh.events.map((e) => e.type)).toEqual(["user.deleted", "agent.created"]);
  // A cursor of this database is never taken for a stale one.
  expect(await listOperatorEvents(db, { after: fresh.next ?? undefined, limit: 10 })).toEqual({
    events: [],
    next: fresh.next,
  });
});

test("prune drops events older than 90 days", async () => {
  const { db, close: done } = await createTestDatabase();
  close = done;
  await db.insert(schema.operatorEvents).values([
    { type: "user.deleted", createdAt: new Date(Date.now() - 91 * 86_400_000) },
    { type: "user.deleted", createdAt: new Date(Date.now() - 89 * 86_400_000) },
  ]);
  expect(await pruneOperatorEvents(db)).toBe(1);
  expect(await allEvents(db)).toHaveLength(1);
});

test("account failures: one per account and cause every 10 minutes, none while events are off", async () => {
  const { db, close: done } = await createTestDatabase();
  close = done;
  resetAccountFailures();
  const failure = {
    orgId: "0193eeee-0000-4000-8000-000000000001",
    accountId: "0193eeee-0000-4000-8000-000000000002",
    machineId: "0193eeee-0000-4000-8000-000000000003",
    kind: "claude_code",
    authMethod: null,
    cause: "auth_rejected",
    code: "not_logged_in",
  };
  const t = Date.now();
  await recordAccountFailure(db, failure, t);
  expect(await allEvents(db)).toEqual([]);
  enableOperatorEvents();
  await recordAccountFailure(db, failure, t);
  await recordAccountFailure(db, failure, t + ACCOUNT_FAILURE_EVERY_MS - 1);
  await recordAccountFailure(db, { ...failure, cause: "quota", code: "plan_limit" }, t);
  await recordAccountFailure(db, failure, t + ACCOUNT_FAILURE_EVERY_MS);
  const rows = await allEvents(db);
  expect(rows.map((r) => [r.type, (r.data as { cause: string }).cause])).toEqual([
    ["account.failure", "auth_rejected"],
    ["account.failure", "quota"],
    ["account.failure", "auth_rejected"],
  ]);
  // An unknown computer: no runner version or protocol, nothing else made up.
  expect(rows[0]?.data).toEqual({
    accountId: failure.accountId,
    machineId: failure.machineId,
    kind: "claude_code",
    authMethod: null,
    cause: "auth_rejected",
    code: "not_logged_in",
  });
});
