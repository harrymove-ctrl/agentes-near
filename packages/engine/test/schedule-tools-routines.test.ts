import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  createAgent,
  createScheduleToolSource,
  createWebhookEndpoint,
  getRoutineView,
  insertMessage,
  type ToolContext,
  type ToolDefinition,
  undoAgentAction,
} from "../src";
import { addMember, type Fixture, SECRET, setup } from "./fixtures";

/** A webhook of `provider` in the fixture's workspace, made in the app and not called yet. */
const hook = (f: Fixture, provider: "github" | "sentry") =>
  createWebhookEndpoint(
    { db: f.db, keyWrappers: [f.keyWrapper] },
    f.owner.id,
    f.org.id,
    provider,
    "http://localhost:3000",
  );

/** The service called it with its secret: its events can start routines. */
const delivered = (f: Fixture, id: string) =>
  f.db.update(schema.webhookEndpoints).set({ lastDeliveryAt: new Date() }).where(eq(schema.webhookEndpoints.id, id));

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/**
 * A real run of the agent in #general whose trigger is `author`'s message: the tools read who is
 * behind it from the run (authority.ts), so the run row must exist.
 */
async function runContext(
  fx: Fixture,
  author: "person" | "agent" = "person",
  userId = fx.owner.id,
): Promise<ToolContext> {
  const trigger = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author:
      author === "person"
        ? { type: "person", userId }
        : { type: "agent", agentId: fx.agent.id, runId: null, hop: 0, stretchId: null },
    body: "rotinas, por favor",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 0,
      status: "running",
    })
    .returning();
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run?.id ?? "",
    channelId: fx.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

async function tools(fx: Fixture, ctx: ToolContext) {
  const all: ToolDefinition[] = await createScheduleToolSource({
    pubsub: fx.pubsub,
    context: fx.context,
    hooks: HOOKS,
  }).tools(ctx);
  return (name: string, input: Record<string, unknown>) => {
    const tool = all.find((t) => t.name === name);
    if (!tool) throw new Error(`no ${name}`);
    return tool.execute(input, ctx);
  };
}

const HOOKS = { publicUrl: "https://agentes.test", secret: SECRET };

type RoutineRow = typeof schema.routines.$inferSelect;
const routineOf = async (id: string) =>
  (await f.db.select().from(schema.routines).where(eq(schema.routines.id, id)))[0] as RoutineRow;
const receipts = (runId: string) => f.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, runId));

describe("schedule tools: routines", () => {
  test("create_routine with an event trigger and report, every routine acting; the receipt carries no English schedule", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const call = await tools(f, ctx);
    await delivered(f, (await hook(f, "sentry")).id);
    const out = await call("create_routine", {
      prompt: "Investigue o erro novo e diga o que fazer.",
      trigger: { type: "event", event: "sentry.issue_created" },
      report: "always",
    });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("when a new error comes in from Sentry");
    expect(out.content).toContain("reports every run");
    const id = (out.data?.routine as { id: string } | undefined)?.id ?? "";
    expect(await routineOf(id)).toMatchObject({
      triggerType: "event",
      event: "sentry.issue_created",
      access: "act",
      report: "always",
    });
    const [created] = await receipts(ctx.runId);
    expect(created).toMatchObject({
      kind: "routine.created",
      params: { trigger: "event", event: "sentry.issue_created", access: "act", report: "always" },
    });

    // A schedule's receipt carries its rule: the app words it in the person's language.
    const weekly = await call("create_routine", { prompt: "Resumo da semana.", schedule: "toda segunda às 9h" });
    const weeklyId = (weekly.data?.routine as { id: string } | undefined)?.id ?? "";
    const receipt = (await receipts(ctx.runId)).find((r) => r.targetId === weeklyId);
    expect(receipt?.params).toMatchObject({
      trigger: "schedule",
      timezone: "UTC",
      rule: { freq: "weekly", byWeekday: ["MO"], times: ["09:00"] },
      access: "act",
      report: "when_new",
    });
    expect(receipt?.params).not.toHaveProperty("schedule");
  });

  test("create_routine with a webhook trigger: the routine gets an address the agent never sees or writes", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const call = await tools(f, ctx);
    const out = await call("create_routine", { prompt: "Confira o pedido que chegou.", trigger: { type: "webhook" } });
    expect(out.isError).toBeFalsy();
    const id = (out.data?.routine as { id: string } | undefined)?.id ?? "";
    expect(await routineOf(id)).toMatchObject({ triggerType: "event", event: "webhook.received" });
    const [hook] = await f.db.select().from(schema.routineHooks).where(eq(schema.routineHooks.routineId, id));
    expect(hook).toBeDefined();
    expect(out.content).toContain("when its webhook address is called");
    expect(out.content).toContain("never write an address in the chat");
    const listed = await call("list_routines", { id });
    const receipt = (await receipts(ctx.runId))[0];
    expect(receipt?.params).toMatchObject({ trigger: "webhook" });
    for (const text of [out.content, listed.content, JSON.stringify(out.data), JSON.stringify(receipt)]) {
      expect(text).not.toContain("/api/hooks/");
    }
  });

  test("asked for a routine another agent should do, it is that agent's own, not a relay; who can't manage it is told", async () => {
    f = await setup();
    const theo = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Theo", handle: "theo", role: "Ops", instructions: "Post updates.", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const ctx = await runContext(f);
    const call = await tools(f, ctx);
    const out = await call("create_routine", {
      agent: "@theo",
      prompt: 'Poste "works" no #general.',
      trigger: { type: "webhook", methods: ["GET", "POST"] },
    });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("on @theo (it does the work itself, each run)");
    expect(out.content).toContain("with GET or POST");
    expect(out.content).toContain("copy it with the button on the routine's line under your reply");
    const id = (out.data?.routine as { id: string } | undefined)?.id ?? "";
    // Theo isn't in this conversation: it reports to the person directly.
    expect(await routineOf(id)).toMatchObject({
      agentId: theo.id,
      target: { type: "dm" },
      createdByUserId: f.owner.id,
    });
    const [stored] = await f.db.select().from(schema.routineHooks).where(eq(schema.routineHooks.routineId, id));
    expect(stored?.methods).toEqual(["GET", "POST"]);
    expect((await receipts(ctx.runId))[0]?.params).toMatchObject({ trigger: "webhook", methods: ["GET", "POST"] });

    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const asked = await tools(f, await runContext(f, "person", bia.id));
    const refused = await asked("create_routine", {
      agent: "@theo",
      prompt: "Poste works.",
      schedule: "toda segunda às 9h",
    });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("can't manage @theo's routines");
    expect(refused.content).toContain("offer another way");
    expect(
      await call("create_routine", { agent: "@nobody", prompt: "x", schedule: "toda segunda às 9h" }),
    ).toMatchObject({
      isError: true,
    });
  });

  test("update_routine edits a routine the person manages, another agent's too: title, prompt, webhook methods, active", async () => {
    f = await setup();
    await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Theo", handle: "theo", role: "Ops", instructions: "Post updates.", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const ctx = await runContext(f);
    const call = await tools(f, ctx);
    const made = await call("create_routine", { agent: "@theo", prompt: "Poste works.", trigger: { type: "webhook" } });
    const id = (made.data?.routine as { id: string } | undefined)?.id ?? "";
    const out = await call("update_routine", {
      id,
      title: "Avisar no general",
      prompt: "Poste works no #general.",
      trigger: { type: "webhook", methods: ["GET"] },
      active: false,
    });
    expect(out.isError).toBeFalsy();
    expect(await routineOf(id)).toMatchObject({
      name: "Avisar no general",
      prompt: "Poste works no #general.",
      active: false,
    });
    const [stored] = await f.db.select().from(schema.routineHooks).where(eq(schema.routineHooks.routineId, id));
    expect(stored?.methods).toEqual(["GET"]);
    // Handed back to the agent the person is talking to.
    expect((await call("update_routine", { id, agent: "@dev" })).isError).toBeFalsy();
    expect((await routineOf(id)).agentId).toBe(f.agent.id);

    // A member who didn't create it and doesn't manage the agent: told, nothing changed.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const asked = await tools(f, await runContext(f, "person", bia.id));
    const refused = await asked("update_routine", { id, title: "Outro nome" });
    expect(refused.isError).toBe(true);
    expect((await routineOf(id)).name).toBe("Avisar no general");
  });

  test("asked twice for another agent's routine that reports by DM, the first one is found, not a second made", async () => {
    f = await setup();
    await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Theo", handle: "theo", role: "Ops", instructions: "Post updates.", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const call = await tools(f, await runContext(f));
    const ask = { agent: "@theo", prompt: 'Poste "works" no #general.', trigger: { type: "webhook" } };
    const made = await call("create_routine", ask);
    const again = await call("create_routine", ask);
    expect(again.content).toContain("already exists");
    expect(again.data).toMatchObject({
      existing: true,
      routine: { id: (made.data?.routine as { id: string } | undefined)?.id },
    });
    expect(await f.db.select().from(schema.routines).where(eq(schema.routines.prompt, ask.prompt))).toHaveLength(1);
  });

  test("changing only the methods a webhook answers leaves a receipt with the copy button's data, and Undo brings them back", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const call = await tools(f, ctx);
    const made = await call("create_routine", { prompt: "Poste works.", trigger: { type: "webhook" } });
    const id = (made.data?.routine as { id: string } | undefined)?.id ?? "";
    const out = await call("update_routine", { id, trigger: { type: "webhook", methods: ["GET", "POST"] } });
    expect(out.content).toContain("copy it with the button");
    const receipt = (await receipts(ctx.runId)).find((r) => r.kind === "routine.updated");
    expect(receipt?.params).toMatchObject({ fields: ["schedule"], trigger: "webhook", methods: ["GET", "POST"] });
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    const [stored] = await f.db.select().from(schema.routineHooks).where(eq(schema.routineHooks.routineId, id));
    expect(stored?.methods).toEqual(["POST"]);
    // Nothing changed: no receipt, so no word about a button.
    const same = await call("update_routine", { id, trigger: { type: "webhook", methods: ["POST"] } });
    expect(same.content).not.toContain("copy it with the button");
  });

  test("an admin changing what another agent's routine someone else created does is told to take it over, not that they can't manage it", async () => {
    f = await setup();
    await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Theo", handle: "theo", role: "Ops", instructions: "Post updates.", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const made = await (await tools(f, await runContext(f)))("create_routine", {
      agent: "@theo",
      prompt: "Veja os PRs abertos.",
      schedule: "toda segunda às 9h",
    });
    const id = (made.data?.routine as { id: string } | undefined)?.id ?? "";
    expect(id).not.toBe("");
    const ana = await addMember(f.db, f.org.id, "admin", "ana");
    const out = await (await tools(f, await runContext(f, "person", ana.id)))("update_routine", {
      id,
      prompt: "Outra coisa.",
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Take the routine over");
    expect(out.content).not.toContain("can't manage");
  });

  test("list_routines doesn't tell the agent it changes only its own routines", async () => {
    f = await setup();
    const all = await createScheduleToolSource({ pubsub: f.pubsub, context: f.context, hooks: HOOKS }).tools(
      await runContext(f),
    );
    const list = all.find((t) => t.name === "list_routines")?.description ?? "";
    expect(list).not.toContain("you change only your own");
    expect(list).toContain("update_routine");
  });

  test("an event no webhook brings here is refused with the setup step; one whose webhook goes away says it can't run", async () => {
    f = await setup();
    const call = await tools(f, await runContext(f));
    const event = { type: "event", event: "github.pr_opened" };
    const refused = await call("create_routine", { prompt: "Revise o PR novo e mande o resumo.", trigger: event });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("Not created: nothing would ever start it. No GitHub webhook");
    // In the person's words: our private app API is nothing they can call.
    expect(refused.content).toContain("someone who manages connectors picks the GitHub event in Rotinas");
    expect(refused.content).toContain("offer a schedule that checks instead");
    expect(refused.content).not.toContain("/api/");
    expect(await f.db.select().from(schema.routines)).toEqual([]);
    // Sentry's events need Sentry's webhook; a task made here needs none.
    const sentry = await call("create_routine", {
      prompt: "Investigue o erro.",
      trigger: { type: "event", event: "sentry.issue_created" },
    });
    expect(sentry.content).toContain("No Sentry webhook");
    const issues = await call("create_routine", {
      prompt: "Triagem.",
      trigger: { type: "event", event: "issue.created" },
    });
    expect(issues.isError).toBeFalsy();
    expect(issues.content).not.toContain("can't run yet");
    // Nor can one be moved onto such an event.
    const issuesId = (issues.data?.routine as { id: string } | undefined)?.id ?? "";
    const moved = await call("update_routine", { id: issuesId, trigger: event });
    expect(moved.isError).toBe(true);
    expect(moved.content).toContain("Not changed: nothing would ever start it.");

    // A GitHub webhook made but never called from GitHub starts nothing yet; once GitHub calls it, the routine is made.
    const endpoint = await hook(f, "github");
    expect((await call("create_routine", { prompt: "Revise o PR novo.", trigger: event })).isError).toBe(true);
    await delivered(f, endpoint.id);
    const out = await call("create_routine", { prompt: "Revise o PR novo e mande o resumo.", trigger: event });
    expect(out.isError).toBeFalsy();
    const id = (out.data?.routine as { id: string } | undefined)?.id ?? "";
    expect((await getRoutineView(f.db, f.owner.id, f.org.id, id)).state).toBe("active");
    // The webhook removed later: the routine says it can't run yet, until one is back.
    await f.db
      .update(schema.webhookEndpoints)
      .set({ revokedAt: new Date() })
      .where(eq(schema.webhookEndpoints.id, endpoint.id));
    expect((await getRoutineView(f.db, f.owner.id, f.org.id, id)).state).toBe("needs_webhook");
    expect((await call("list_routines", {})).content).toContain(
      "can't run yet: no GitHub webhook sends its event here",
    );
    // Its edit tells the agent where the person sets the webhook up: the routine's own GitHub webhook card.
    expect((await call("update_routine", { id, prompt: "Revise o PR novo." })).content).toContain(
      "opens this routine in Rotinas and follows the GitHub webhook steps shown there",
    );
    // Paused, it says so first.
    const paused = await call("update_routine", { id, active: false });
    expect(paused.content).not.toContain("can't run yet");
    expect((await getRoutineView(f.db, f.owner.id, f.org.id, id)).state).toBe("paused");
  });

  test("create_routine needs a schedule or a trigger, not both; an email trigger needs a mailbox the agent reads", async () => {
    f = await setup();
    const call = await tools(f, await runContext(f));
    const both = await call("create_routine", {
      prompt: "x",
      schedule: "todo dia às 9h",
      trigger: { type: "event", event: "issue.created" },
    });
    expect(both).toMatchObject({ isError: true });
    expect((await call("create_routine", { prompt: "x" })).isError).toBe(true);
    const mail = await call("create_routine", {
      prompt: "Leia os emails de clientes.",
      trigger: { type: "email", from: ["@cliente.com"] },
    });
    expect(mail).toMatchObject({ isError: true });
    expect(mail.content).toContain("can't read any mailbox");
    // Where a person connects one, in both languages.
    expect(mail.content).toContain("Settings › Connectors and MCPs › Add connector › Email");
    expect(mail.content).toContain("Configurações › Conectores e MCPs › Adicionar conector › Email");
    expect(mail.content).not.toContain("MillionSend");
    const unknown = await call("create_routine", { prompt: "x", trigger: { type: "event", event: "email.received" } });
    expect(unknown.content).toContain("Say which event");
  });

  test("update_routine changes report and access; delete_routine has Undo; run_routine_now queues a run", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const call = await tools(f, ctx);
    const created = await call("create_routine", { prompt: "Veja os PRs abertos.", schedule: "todo dia às 9h" });
    const id = (created.data?.routine as { id: string } | undefined)?.id ?? "";

    const updated = await call("update_routine", { id, report: "always", access: "act" });
    expect(updated.isError).toBeFalsy();
    expect(await routineOf(id)).toMatchObject({ report: "always", access: "act" });

    const ran = await call("run_routine_now", { id });
    expect(ran.isError).toBeFalsy();
    expect(ran.content).toContain("works in the background");
    expect(await f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, id))).toMatchObject([
      { trigger: "manual", status: "queued" },
    ]);

    const deleted = await call("delete_routine", { id });
    expect(deleted.isError).toBeFalsy();
    expect((await routineOf(id)).deletedAt).not.toBeNull();
    const receipt = (await receipts(ctx.runId)).find((r) => r.kind === "routine.deleted");
    expect(receipt).toMatchObject({ targetId: id, params: { name: "Veja os PRs abertos." } });
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    const back = await routineOf(id);
    expect(back.deletedAt).toBeNull();
    expect(back.active).toBe(true);
    // Gone again: nothing to change.
    expect((await call("delete_routine", { id: crypto.randomUUID() })).isError).toBe(true);
  });

  test("list_routines shows state, next run and the last runs with their coded reasons", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const call = await tools(f, ctx);
    const created = await call("create_routine", { prompt: "Olhe o Sentry.", schedule: "todo dia às 9h" });
    const id = (created.data?.routine as { id: string } | undefined)?.id ?? "";
    const run = (hoursAgo: number, values: Partial<typeof schema.routineRuns.$inferInsert>) => {
      const at = new Date(Date.now() - hoursAgo * 3600_000);
      return { orgId: f.org.id, routineId: id, at, createdAt: at, trigger: "schedule", ...values };
    };
    await f.db
      .insert(schema.routineRuns)
      .values([
        run(1, { status: "failed", code: "provider_error" }),
        run(2, { status: "skipped", code: "previous_running" }),
        run(3, { status: "reported", summary: "3 erros novos." }),
      ]);
    await f.db
      .update(schema.routines)
      .set({ active: false, nextRunAt: null, pausedReason: "failing", failuresInRow: 5 })
      .where(eq(schema.routines.id, id));
    const listed = await call("list_routines", {});
    expect(listed.content).toContain("(paused: failing)");
    expect(listed.content).toContain("next: none");
    expect(listed.content).toContain("failed (provider_error)");
    expect(listed.content).toContain("skipped (previous_running)");
    expect(listed.content).toContain("reported");
    expect(listed.content).toContain("Olhe o Sentry.");
  });

  test("nobody behind the run (an agent's own message): nothing is scheduled", async () => {
    f = await setup();
    const call = await tools(f, await runContext(f, "agent"));
    const out = await call("create_routine", { prompt: "x", schedule: "todo dia às 9h" });
    expect(out).toMatchObject({ isError: true });
    expect(out.content).toContain("no person is behind this run");
    expect(await f.db.select().from(schema.routines)).toEqual([]);
  });
});
