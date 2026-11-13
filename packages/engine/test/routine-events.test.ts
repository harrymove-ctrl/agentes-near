import { afterEach, describe, expect, test } from "bun:test";
import type { MailSummary } from "@agenteschat/adapters";
import { asc, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  closeRoutineRun,
  createAgentRuns,
  createChannel,
  createIssue,
  createRoutine,
  executeRoutineRun,
  fireRoutineEvent,
  ingestMail,
  insertMessage,
  type RoutineDeps,
  stopRoutineRun,
  webhookEvent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { giveMail, imapAccount, type MailFixture, mailSetup } from "./mail-fixtures";
import { agentRunRow, channelRoutine, fire, routineDeps } from "./routine-fixtures";

let f: Fixture;
let m: MailFixture | undefined;
afterEach(async () => {
  // The mail fixture wraps the engine one: close it once.
  await (m?.f ?? f)?.close();
  f = undefined as unknown as Fixture;
  m = undefined;
});

const runsOf = (routineId: string) =>
  f.db
    .select()
    .from(schema.routineRuns)
    .where(eq(schema.routineRuns.routineId, routineId))
    .orderBy(asc(schema.routineRuns.createdAt));
const jobOf = async (routineRunId: string) =>
  (
    await f.db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.dedupeKey, `routine.run:${routineRunId}`))
  )[0];

describe("events", () => {
  test("webhooks carry their identity: GitHub's delivery id, Sentry's issue id and action", () => {
    const gh = webhookEvent(
      "github",
      new Headers({ "x-github-event": "pull_request", "x-github-delivery": "72d3162e-cc78" }),
      {
        action: "opened",
        repository: { full_name: "acme/app" },
        pull_request: { number: 7, title: "Fix login", html_url: "https://github.com/acme/app/pull/7" },
      },
    );
    expect(gh).toMatchObject({ event: "github.pr_opened", dedupeKey: "github:72d3162e-cc78" });
    const sentry = webhookEvent("sentry", new Headers({ "sentry-hook-resource": "issue" }), {
      action: "created",
      data: { issue: { id: "4242", title: "TypeError: x is undefined", web_url: "https://sentry.io/i/4242" } },
    });
    expect(sentry).toMatchObject({
      event: "sentry.issue_created",
      dedupeKey: "sentry:4242:created",
      data: { issueId: "4242" },
    });
  });

  test("the same event never fires twice; events join the queued run, then gather behind the one working", async () => {
    f = await setup();
    const routine = await createRoutine(routineDeps(f), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Revise os PRs novos.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "event", event: "github.pr_opened" },
    });
    const send = (key: string, n: number) =>
      fireRoutineEvent(
        { db: f.db },
        f.org.id,
        "github.pr_opened",
        { summary: `PR #${n} opened`, number: n },
        { dedupeKey: key },
      );
    expect(await send("github:d1", 1)).toBe(1);
    expect(await send("github:d1", 1)).toBe(0);
    expect(await send("github:d2", 2)).toBe(1);
    const [queued] = await runsOf(routine.id);
    expect(await runsOf(routine.id)).toHaveLength(1);
    expect(queued?.event).toMatchObject({
      type: "github.pr_opened",
      events: [
        { summary: "PR #1 opened", number: 1 },
        { summary: "PR #2 opened", number: 2 },
      ],
      dedupeKeys: ["github:d1", "github:d2"],
    });
    expect(String(queued?.event?.summary)).toContain("2 events since the last run");

    // It starts: what arrives now waits for it, in one run without a job yet.
    await executeRoutineRun(routineDeps(f), queued?.id ?? "");
    expect(await send("github:d3", 3)).toBe(1);
    expect(await send("github:d4", 4)).toBe(1);
    expect(await send("github:d2", 2)).toBe(0);
    const [, gathered] = await runsOf(routine.id);
    expect(await runsOf(routine.id)).toHaveLength(2);
    expect(gathered).toMatchObject({ status: "queued", dedupeKey: "github:d3" });
    expect(gathered?.event).toMatchObject({ gathered: true, dedupeKeys: ["github:d3", "github:d4"] });
    expect(await jobOf(gathered?.id ?? "")).toBeUndefined();

    // The working one ends: the gathered run starts.
    const [first] = await runsOf(routine.id);
    await closeRoutineRun({ db: f.db, pubsub: f.pubsub }, await agentRunRow(f, first?.agentRunId ?? null), {
      status: "done",
      text: "Revisado.",
    });
    const [, started] = await runsOf(routine.id);
    expect(started?.event).not.toHaveProperty("gathered");
    expect(await jobOf(started?.id ?? "")).toMatchObject({ status: "pending" });
    await executeRoutineRun(routineDeps(f), started?.id ?? "");
    expect((await runsOf(routine.id))[1]).toMatchObject({ status: "started" });
  });
});

describe("issue.created", () => {
  test("never fires for an issue a routine or an unattended run created; a person's (also through an agent) fires", async () => {
    f = await setup();
    const watcher = await createRoutine(routineDeps(f), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Faça a triagem.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "event", event: "issue.created" },
    });
    const deps = { db: f.db, pubsub: f.pubsub };
    const byAgent = (runId: string | undefined) =>
      createIssue(
        deps,
        { type: "agent", agentId: f.agent.id, channelId: f.general.id, ...(runId ? { runId } : {}) },
        f.org.id,
        { title: "Erro no checkout" },
      );

    // A routine's background run.
    const other = await channelRoutine(f);
    const background = await fire(f, other.id, new Date());
    await byAgent(background.agentRunId ?? undefined);
    // A run nobody is behind (an agent's own message started it).
    const note = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
      body: "Nota interna.",
    });
    const [unattended] = await createAgentRuns(f.db, note, [f.agent.id], "mention");
    await byAgent(unattended?.id);
    // An agent with no run at all.
    await byAgent(undefined);
    expect(await runsOf(watcher.id)).toHaveLength(0);

    // A person, directly and through the agent working for them.
    const mine = await createIssue(deps, { type: "person", userId: f.owner.id }, f.org.id, { title: "Bug A" });
    const ask = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "@dev abre uma issue",
    });
    const [personRun] = await createAgentRuns(f.db, ask, [f.agent.id], "mention");
    const theirs = await byAgent(personRun?.id);
    const runs = await runsOf(watcher.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.event).toMatchObject({
      events: [{ issueId: mine.id }, { issueId: theirs.id }],
      dedupeKeys: [`issue:${mine.id}`, `issue:${theirs.id}`],
    });
  });

  test("only routines whose creator can see the issue fire", async () => {
    f = await setup();
    // A plain member: an administrator sees every task (ADR 0151).
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    // Whoever creates a routine must be able to post where it reports.
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const event = { trigger: { type: "event" as const, event: "issue.created" as const } };
    const mine = await channelRoutine(f, event);
    await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
    const hers = await channelRoutine(f, event, bia.id);
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
    await createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Demissões",
      channelId: secret.id,
    });
    expect(await runsOf(mine.id)).toHaveLength(1);
    expect(await runsOf(hers.id)).toHaveLength(0);
  });
});

describe("email", () => {
  const mail = (id: string): MailSummary => ({
    id,
    from: { address: "cliente@acme.com" },
    to: [],
    cc: [],
    subject: `Pedido ${id}`,
    date: new Date().toISOString(),
    snippet: `snippet of ${id}`,
    unread: true,
    hasAttachments: false,
  });

  test("the emails of a run that failed or was stopped are released to the next run", async () => {
    m = await mailSetup();
    f = m.f;
    const x = m;
    const deps: RoutineDeps = { db: f.db, pubsub: f.pubsub, mail: x.mail };
    const account = await imapAccount(x);
    await giveMail(x, account.id, "read");
    const routine = await createRoutine(deps, f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Responda os pedidos novos.",
      target: { type: "dm" },
      trigger: { type: "email", accountId: account.id, folder: "INBOX", filter: {} },
    });
    const [watch] = await f.db.select().from(schema.mailWatches).where(eq(schema.mailWatches.routineId, routine.id));
    const ids = (event: unknown) => ((event as { messages?: { id: string }[] }).messages ?? []).map((e) => e.id);

    expect(await ingestMail(x.deps, watch?.id ?? "", [mail("a1")])).toEqual({ added: 1, fired: true });
    const [first] = await runsOf(routine.id);
    await executeRoutineRun(deps, first?.id ?? "");
    const [working] = await runsOf(routine.id);
    // While it works, a new email waits for it.
    expect(await ingestMail(x.deps, watch?.id ?? "", [mail("a2")])).toEqual({ added: 1, fired: false });
    // It fails: its email joins the waiting run, which starts now.
    await closeRoutineRun({ db: f.db, pubsub: f.pubsub }, await agentRunRow(f, working?.agentRunId ?? null), {
      status: "failed",
      code: "provider_error",
    });
    const [, next] = await runsOf(routine.id);
    expect(ids(next?.event).sort()).toEqual(["a1", "a2"]);
    expect(next?.event).not.toHaveProperty("gathered");
    expect(await jobOf(next?.id ?? "")).toMatchObject({ status: "pending" });

    // A person stops the next one: its emails wait for the next email, never starting a run by themselves.
    await executeRoutineRun(deps, next?.id ?? "");
    await stopRoutineRun(deps, f.owner.id, f.org.id, routine.id);
    const [, , held] = await runsOf(routine.id);
    expect(held).toMatchObject({ status: "queued" });
    expect(held?.event).toMatchObject({ held: true });
    expect(ids(held?.event).sort()).toEqual(["a1", "a2"]);
    expect(await jobOf(held?.id ?? "")).toBeUndefined();

    expect(await ingestMail(x.deps, watch?.id ?? "", [mail("a3")])).toEqual({ added: 1, fired: true });
    const [, , resumed] = await runsOf(routine.id);
    expect(ids(resumed?.event).sort()).toEqual(["a1", "a2", "a3"]);
    expect(resumed?.event).not.toHaveProperty("held");
    expect(await jobOf(resumed?.id ?? "")).toMatchObject({ status: "pending" });
    expect(await runsOf(routine.id)).toHaveLength(3);
  });
});
