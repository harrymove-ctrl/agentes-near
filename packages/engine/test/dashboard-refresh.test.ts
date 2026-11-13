import { afterEach, describe, expect, test } from "bun:test";
import type { PubSub } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import { WIDGET_SCHEDULE_CRON, type WidgetSpec } from "@agenteschat/ui/widgets/spec";
import {
  applyWidgetUpdate,
  askWidgetChange,
  bridgeToolsFor,
  closeRoutineRun,
  createDashboard,
  createDashboardToolSource,
  createWidget,
  type DashboardDeps,
  deleteRoutine,
  drainOutbox,
  dropWidgetRoutine,
  executeRoutineRun,
  ForbiddenError,
  getWidget,
  insertWidget,
  listRoutines,
  queueRoutineRun,
  refreshWidgetNow,
  routineSlots,
  setRoutineActive,
  syncWidgetRoutine,
  testWidget,
  toolPolicy,
  updateRoutine,
  updateWidget,
  WIDGET_UP_FRONT_MAX,
  widgetUpFront,
} from "../src";
import { widgetFailureCode } from "../src/dashboards/refresh-ledger";
import { addMember, type Fixture, setup } from "./fixtures";
import {
  agentRunRow,
  channelRoutine,
  notificationsOf,
  routineDeps,
  routineRow,
  routineRunRow,
} from "./routine-fixtures";

/** ADR 0135 §4–§7: a widget is redone by a routine of its own, speaking only through `update_widget`. */

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

/** The dashboard tools, wired before the fixture exists (the fixture fills `db` and `pubsub` in). */
function lazyDashboardTools() {
  const deps = { db: undefined as unknown as Database, pubsub: undefined as unknown as PubSub } as DashboardDeps;
  return { deps, source: createDashboardToolSource(deps) };
}

/** A fixture whose agent answers widget runs with `widgetReply` (and any other run with "Ok."). */
async function setupWidgets(widgetReply: (req: ModelRequest, call: number) => FakeReply) {
  const tools = lazyDashboardTools();
  let calls = 0;
  f = await setup({
    toolSources: [tools.source],
    reply: (req) => {
      if (!(req.tools ?? []).some((t) => t.name === "update_widget")) return { chunks: ["Ok."] };
      return widgetReply(req, calls++);
    },
  });
  tools.deps.db = f.db;
  tools.deps.pubsub = f.pubsub;
  return f;
}

const dash = (): DashboardDeps => ({ db: f.db, pubsub: f.pubsub, context: f.context });
const seen = (req: ModelRequest) => JSON.stringify(req.messages);

async function board(title = "Vendas", owner = f.owner.id) {
  return createDashboard(dash(), owner, f.org.id, { title, audience: "private", editPolicy: "owner" });
}

async function widgetOf(id: string) {
  const [row] = await f.db.select().from(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.id, id));
  if (!row) throw new Error("no widget");
  return row;
}

const historyOf = (widgetId: string) =>
  f.db
    .select()
    .from(schema.dashboardWidgetUpdates)
    .where(eq(schema.dashboardWidgetUpdates.widgetId, widgetId))
    .orderBy(schema.dashboardWidgetUpdates.createdAt);

/** A widget that already shows data (no build run queued), on `dashboardId`. */
function shownWidget(dashboardId: string, input: Partial<Parameters<typeof insertWidget>[1]> = {}) {
  return insertWidget(dash(), {
    orgId: f.org.id,
    dashboardId,
    agentId: f.agent.id,
    title: "Vendas hoje",
    prompt: "Vendas de hoje contra ontem.",
    format: "kpi",
    schedule: "manual",
    spec: { kind: "kpi", value: 100, prefix: "R$" },
    createdByUserId: f.owner.id,
    ...input,
  });
}

/** One manual run of a widget's routine, started but not executed (its agent run stays queued). */
async function fireWidget(routineId: string) {
  const queued = await queueRoutineRun({ db: f.db }, await routineRow(f, routineId), new Date(), "manual");
  if (!queued) throw new Error("slot taken");
  await executeRoutineRun(routineDeps(f), queued.id);
  return routineRunRow(f, queued.id);
}

/** Messages the agent wrote anywhere but its routine rooms (what people could read). */
async function agentMessagesPeopleSee() {
  const rows = await f.db
    .select({ body: schema.messages.body, dmKey: schema.channels.dmKey })
    .from(schema.messages)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId))
    .where(eq(schema.messages.authorType, "agent"));
  return rows.filter((r) => !r.dmKey?.startsWith("routine|"));
}

const KPI = { kind: "kpi", value: 18420, prefix: "R$", delta: { text: "+12%", up: true }, note: "vs. ontem" };

describe("scheduling", () => {
  test("a scheduled widget gets one routine on its cron, 30 minutes apart at the least; manual has none to show", async () => {
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const b = await board();
    const w = await shownWidget(b.id, { schedule: "half" });
    expect(w.routineId).not.toBeNull();
    const routine = await routineRow(f, w.routineId ?? "");
    expect(routine).toMatchObject({
      agentId: f.agent.id,
      name: "Vendas hoje",
      prompt: "Vendas de hoje contra ontem.",
      triggerType: "schedule",
      cron: WIDGET_SCHEDULE_CRON.half,
      active: true,
      createdByUserId: f.owner.id,
      target: { type: "widget", widgetId: w.id, dashboardId: b.id },
    });
    expect(routine.nextRunAt).not.toBeNull();
    // The floor: no two slots closer than 30 minutes, over a day.
    const slots = routineSlots(routine, new Date(), new Date(Date.now() + 86_400_000));
    for (let i = 1; i < slots.length; i++) {
      expect((slots[i] as Date).getTime() - (slots[i - 1] as Date).getTime()).toBeGreaterThanOrEqual(30 * 60_000);
    }
    // Routines shows it with its widget while it updates on a schedule.
    const listed = (await listRoutines(f.db, f.owner.id, f.org.id)).find((r) => r.id === routine.id);
    expect(listed?.widget).toEqual({ id: w.id, dashboardId: b.id, title: "Vendas hoje" });

    // Only when asked: the routine stays, with no next run, and Routines leaves it out.
    await updateWidget(dash(), f.owner.id, f.org.id, w.id, { schedule: "manual" });
    expect(await routineRow(f, routine.id)).toMatchObject({ cron: null, nextRunAt: null, active: true });
    expect((await listRoutines(f.db, f.owner.id, f.org.id)).some((r) => r.id === routine.id)).toBe(false);
  });

  test("a manual widget gets no routine until a run is asked; a schedule off the list reads as manual", async () => {
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const b = await board();
    const w = await shownWidget(b.id);
    expect(w.routineId).toBeNull();
    expect(await syncWidgetRoutine(dash(), f.org.id, w.id)).toBeNull();
    await f.db
      .update(schema.dashboardWidgets)
      .set({ schedule: "every_5_minutes" })
      .where(eq(schema.dashboardWidgets.id, w.id));
    const id = await syncWidgetRoutine(dash(), f.org.id, w.id, { ensure: true });
    expect(await routineRow(f, id ?? "")).toMatchObject({ cron: null, nextRunAt: null });
    expect((await widgetOf(w.id)).routineId).toBe(id);
  });

  test("widget routines don't count in an agent's 20 active routines; the workspace's cap of scheduled widgets holds", async () => {
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const b = await board();
    for (let i = 0; i < 20; i++) await shownWidget(b.id, { title: `W${i}`, schedule: "hour" });
    // A 21st routine of the same agent is still fine.
    await channelRoutine(f);

    // Fill the workspace's 60 scheduled widgets (24 a board at most).
    const more = [await board("B2"), await board("B3")];
    for (const extra of more) {
      for (let i = 0; i < 20; i++) {
        await f.db.insert(schema.dashboardWidgets).values({
          orgId: f.org.id,
          dashboardId: extra.id,
          agentId: f.agent.id,
          title: `X${i}`,
          schedule: "day",
          status: "ok",
        });
      }
    }
    const refused = createWidget(dash(), f.owner.id, f.org.id, b.id, {
      agentId: f.agent.id,
      prompt: "Pedidos abertos",
      format: "auto",
      schedule: "hour",
    });
    await expect(refused).rejects.toMatchObject({ code: "widget.scheduled_cap", params: { max: 60 } });
    // Only when asked: it never counts.
    const manual = await createWidget(dash(), f.owner.id, f.org.id, b.id, {
      agentId: f.agent.id,
      prompt: "Pedidos abertos",
      format: "auto",
      schedule: "manual",
    });
    expect(manual.status).toBe("building");
  });
});

describe("the refresh run", () => {
  test("a new widget's first run builds it through update_widget only: ok, history, reported, nothing posted", async () => {
    await setupWidgets((req) => {
      if (seen(req).includes("Updated:")) return { chunks: ["Conferi as vendas no Stripe."] };
      return {
        chunks: [],
        toolUses: [
          {
            name: "update_widget",
            input: { data: KPI, summary: "R$ 18.420 hoje", sources: ["Stripe"], title: "Vendas de hoje" },
          },
        ],
      };
    });
    const b = await board();
    const w = await createWidget(dash(), f.owner.id, f.org.id, b.id, {
      agentId: f.agent.id,
      prompt: "Quanto vendemos hoje, contra ontem",
      format: "auto",
      schedule: "day",
    });
    expect(w.status).toBe("building");
    await drainOutbox(f.db, f.handlers);

    const req = f.provider.calls[0]?.request;
    const listed = (req?.tools ?? []).map((t) => t.name);
    expect(listed).toContain("update_widget");
    for (const other of ["hand_off", "create_widget", "list_dashboards"]) expect(listed).not.toContain(other);
    const prompt = systemText(req?.system ?? "");
    expect(prompt).toContain("This is a widget update");
    expect(prompt).toContain("Quanto vendemos hoje, contra ontem");
    expect(prompt).toContain("This is its first build");
    // Quick by instruction: arithmetic never in a shell, no sleeping on an asynchronous query, answer at once.
    expect(prompt).toContain("in your head or inside one query, never in a shell");
    expect(prompt).toContain("Never sleep or wait in a shell");
    expect(prompt).toContain("call its status once more instead");
    expect(prompt).toContain("Call update_widget as soon as the numbers are in hand");

    const row = await widgetOf(w.id);
    expect(row).toMatchObject({
      status: "ok",
      kind: "kpi",
      title: "Vendas de hoje",
      sources: ["Stripe"],
      failureCode: null,
    });
    expect(row.spec).toMatchObject({ kind: "kpi", value: 18420 });
    expect(row.refreshedAt).not.toBeNull();
    const history = await historyOf(w.id);
    expect(history.map((h) => [h.status, h.summary])).toEqual([["ok", "R$ 18.420 hoje"]]);
    const [rr] = await f.db.select().from(schema.routineRuns);
    expect(rr).toMatchObject({ status: "reported", routineId: row.routineId });
    expect(rr?.finishedAt).not.toBeNull();
    // Its routine is named after the widget's new title.
    expect((await routineRow(f, row.routineId ?? "")).name).toBe("Vendas de hoje");
    // Nothing reached a conversation people read, and no routine notification went out.
    expect(await agentMessagesPeopleSee()).toEqual([]);
    expect(await notificationsOf(f, "routine_finished")).toEqual([]);
  });

  test("invalid data gets a tool error the agent can fix, then the update applies", async () => {
    const results: string[] = [];
    await setupWidgets((req, call) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("Updated:")) return { chunks: ["Feito."] };
      if (call > 0) results.push(last);
      const data = call === 0 ? { kind: "kpi", value: "muito" } : KPI;
      // A first build names the widget (ADR 0135 §17).
      return { chunks: [], toolUses: [{ name: "update_widget", input: { data, summary: "Vendas", title: "Vendas" } }] };
    });
    const b = await board();
    const w = await createWidget(dash(), f.owner.id, f.org.id, b.id, {
      agentId: f.agent.id,
      prompt: "Vendas de hoje",
      format: "kpi",
      schedule: "manual",
    });
    await drainOutbox(f.db, f.handlers);
    expect(results[0]).toContain("numeric `value`");
    expect(results[0]).toContain("call update_widget again");
    expect(await widgetOf(w.id)).toMatchObject({ status: "ok", kind: "kpi" });
    expect((await f.db.select().from(schema.routineRuns))[0]).toMatchObject({ status: "reported", code: null });
  });

  test("a run that never sends valid data fails the widget (invalid_data) and tells its creator once", async () => {
    await setupWidgets((req) => {
      if (seen(req).includes("isn't valid")) return { chunks: ["Não consegui."] };
      return {
        chunks: [],
        toolUses: [{ name: "update_widget", input: { data: { kind: "bars", labels: ["a"] }, summary: "x" } }],
      };
    });
    const b = await board();
    const w = await createWidget(dash(), f.owner.id, f.org.id, b.id, {
      agentId: f.agent.id,
      prompt: "Pedidos por canal",
      format: "auto",
      schedule: "manual",
    });
    await drainOutbox(f.db, f.handlers);
    expect(await widgetOf(w.id)).toMatchObject({ status: "failed", failureCode: "invalid_data" });
    expect((await f.db.select().from(schema.routineRuns))[0]).toMatchObject({ status: "failed", code: "invalid_data" });
    const failed = await notificationsOf(f, "widget_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      userId: f.owner.id,
      source: { widgetId: w.id, dashboardId: b.id, agentId: f.agent.id },
    });
    expect(failed[0]?.latest).toMatchObject({ reason: "invalid_data" });
    // The routine's own failure notice is replaced by the widget's.
    expect(await notificationsOf(f, "routine_failed")).toEqual([]);
  });

  test("the agent says why it couldn't: the widget shows its words, once per streak; a good update ends it", async () => {
    let fail = true;
    await setupWidgets((req) => {
      if (seen(req).includes("Recorded:") || seen(req).includes("Updated:")) return { chunks: ["Ok."] };
      const input = fail
        ? { failed: "O Stripe não está conectado para mim: conecte em Configurações › Conectores." }
        : { data: KPI, summary: "Voltou" };
      return { chunks: [], toolUses: [{ name: "update_widget", input }] };
    });
    const b = await board();
    const w = await shownWidget(b.id);
    await refreshWidgetNow(dash(), f.owner.id, f.org.id, w.id);
    await drainOutbox(f.db, f.handlers);
    const failedRow = await widgetOf(w.id);
    expect(failedRow).toMatchObject({ status: "failed", failureCode: "agent_reported" });
    expect(failedRow.failureDetail).toContain("Stripe não está conectado");
    // Its last data stays.
    expect(failedRow.spec).toMatchObject({ kind: "kpi", value: 100 });
    const [first] = await notificationsOf(f, "widget_failed");
    expect(first?.latest).toMatchObject({ reason: "agent_reported" });
    expect(String(first?.latest.text)).toContain("Stripe");

    // Resolve: a second failure in the same streak tells nobody again.
    await refreshWidgetNow(dash(), f.owner.id, f.org.id, w.id);
    await drainOutbox(f.db, f.handlers);
    expect(await notificationsOf(f, "widget_failed")).toHaveLength(1);
    expect((await routineRow(f, failedRow.routineId ?? "")).failuresInRow).toBe(2);

    fail = false;
    await refreshWidgetNow(dash(), f.owner.id, f.org.id, w.id);
    await drainOutbox(f.db, f.handlers);
    expect(await widgetOf(w.id)).toMatchObject({ status: "ok", failureCode: null, failureDetail: null });
    expect((await notificationsOf(f, "widget_failed"))[0]?.doneAt).not.toBeNull();
    expect((await routineRow(f, failedRow.routineId ?? "")).failuresInRow).toBe(0);
    expect((await historyOf(w.id)).map((h) => h.status)).toEqual(["failed", "failed", "ok"]);
  });

  test("a failed run says its coded reason in the widget's words", async () => {
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const b = await board();
    const w = await shownWidget(b.id);
    const routineId = (await syncWidgetRoutine(dash(), f.org.id, w.id, { ensure: true })) ?? "";
    const rr = await fireWidget(routineId);
    expect(await widgetOf(w.id)).toMatchObject({ status: "updating" });
    const run = await agentRunRow(f, rr.agentRunId);
    await closeRoutineRun({ db: f.db, pubsub: f.pubsub }, run, { status: "failed", code: "missing_credential" });
    expect(await widgetOf(w.id)).toMatchObject({ status: "failed", failureCode: "missing_credential" });
    expect((await historyOf(w.id))[0]).toMatchObject({ status: "failed", failureCode: "missing_credential" });

    expect(widgetFailureCode("budget_exceeded")).toBe("budget_exceeded");
    expect(widgetFailureCode("computer_timeout")).toBe("timeout");
    expect(widgetFailureCode("no_ai")).toBe("missing_credential");
    expect(widgetFailureCode("stale")).toBe("waiting_computer");
    expect(widgetFailureCode("provider_error")).toBe("error");
    expect(widgetFailureCode(null)).toBe("error");
  });

  test("a run ended without update_widget fails as no_update; one stopped leaves the widget as it was", async () => {
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const b = await board();
    const w = await shownWidget(b.id);
    const routineId = (await syncWidgetRoutine(dash(), f.org.id, w.id, { ensure: true })) ?? "";
    const ledger = { db: f.db, pubsub: f.pubsub };

    const stopped = await fireWidget(routineId);
    await closeRoutineRun(ledger, await agentRunRow(f, stopped.agentRunId), {
      status: "canceled",
      code: "stopped",
      byUserId: f.owner.id,
    });
    await f.db
      .update(schema.agentRuns)
      .set({ status: "canceled" })
      .where(eq(schema.agentRuns.id, stopped.agentRunId ?? ""));
    expect(await widgetOf(w.id)).toMatchObject({ status: "ok", failureCode: null });

    const silent = await fireWidget(routineId);
    await closeRoutineRun(ledger, await agentRunRow(f, silent.agentRunId), { status: "done", text: "Nada mudou." });
    expect(await widgetOf(w.id)).toMatchObject({ status: "failed", failureCode: "no_update" });
    expect(await routineRunRow(f, silent.id)).toMatchObject({ status: "failed", code: "no_update" });
    expect((await routineRow(f, routineId)).failuresInRow).toBe(1);
  });

  test("update_widget is applied once per run and only by its own run", async () => {
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const b = await board();
    const w = await shownWidget(b.id);
    const routineId = (await syncWidgetRoutine(dash(), f.org.id, w.id, { ensure: true })) ?? "";
    const rr = await fireWidget(routineId);
    const update = { spec: KPI as WidgetSpec, summary: "ok" };
    const input = { orgId: f.org.id, widgetId: w.id, routineRunId: rr.id, agentRunId: rr.agentRunId ?? "", update };
    await applyWidgetUpdate(dash(), input);
    await expect(applyWidgetUpdate(dash(), input)).rejects.toMatchObject({ code: "widget.already_updated" });
    // Another widget's run can't write this one.
    const other = await shownWidget(b.id, { title: "Outro" });
    await expect(applyWidgetUpdate(dash(), { ...input, widgetId: other.id })).rejects.toMatchObject({
      code: "widget.not_this_run",
    });
    // The kind holds: a kpi widget refuses bars without a person's change request.
    await f.db
      .update(schema.agentRuns)
      .set({ status: "done" })
      .where(eq(schema.agentRuns.id, rr.agentRunId ?? ""));
    const next = await fireWidget(routineId);
    await expect(
      applyWidgetUpdate(dash(), {
        ...input,
        routineRunId: next.id,
        update: { spec: { kind: "bars", labels: ["a"], values: [1] }, summary: "x" },
      }),
    ).rejects.toMatchObject({ code: "widget.invalid_data" });
  });
});

describe("alerts", () => {
  test("a met condition goes to Waiting on you, never to a chat; with the alert off, nothing", async () => {
    await setupWidgets((req) => {
      if (seen(req).includes("Updated:")) return { chunks: ["Ok."] };
      return {
        chunks: [],
        toolUses: [
          {
            name: "update_widget",
            input: { data: KPI, summary: "Caiu", alert: "As vendas caíram 25% abaixo de ontem às 14h." },
          },
        ],
      };
    });
    const b = await board();
    const on = await shownWidget(b.id, {
      alert: { enabled: true, condition: "cair 20% abaixo de ontem", userId: f.owner.id },
    });
    await refreshWidgetNow(dash(), f.owner.id, f.org.id, on.id);
    await drainOutbox(f.db, f.handlers);
    const prompt = systemText(f.provider.calls[0]?.request.system ?? "");
    expect(prompt).toContain("cair 20% abaixo de ontem");
    const alerts = await notificationsOf(f, "widget_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      userId: f.owner.id,
      waiting: true,
      source: { widgetId: on.id, dashboardId: b.id, agentId: f.agent.id, label: "Vendas hoje" },
    });
    expect(String(alerts[0]?.latest.text)).toContain("caíram 25%");
    expect((await historyOf(on.id))[0]?.alert).toContain("caíram 25%");
    expect((await widgetOf(on.id)).lastAlertAt).not.toBeNull();
    expect(await agentMessagesPeopleSee()).toEqual([]);

    const off = await shownWidget(b.id, { title: "Sem alerta" });
    await refreshWidgetNow(dash(), f.owner.id, f.org.id, off.id);
    await drainOutbox(f.db, f.handlers);
    const after = await notificationsOf(f, "widget_alert");
    expect(after.map((n) => [n.source.widgetId, n.count])).toEqual([[on.id, 1]]);
    expect((await historyOf(off.id))[0]?.alert).toBeNull();
  });
});

describe("changes, Resolve and the routine's life", () => {
  test("a change request reaches the run, which may change the kind, title and instructions", async () => {
    await setupWidgets((req) => {
      if (seen(req).includes("Updated:")) return { chunks: ["Ok."] };
      return {
        chunks: [],
        toolUses: [
          {
            name: "update_widget",
            input: {
              data: { kind: "bars", labels: ["Loja", "App"], values: [12000, 6420] },
              summary: "Por canal",
              title: "Vendas por canal",
              prompt: "Vendas de hoje por canal.",
            },
          },
        ],
      };
    });
    const b = await board();
    const w = await shownWidget(b.id);
    const view = await askWidgetChange(dash(), f.owner.id, f.org.id, w.id, "Separa por canal, em barras");
    expect(view.status).toBe("updating");
    await drainOutbox(f.db, f.handlers);
    expect(systemText(f.provider.calls[0]?.request.system ?? "")).toContain("Separa por canal, em barras");
    const row = await widgetOf(w.id);
    expect(row).toMatchObject({
      status: "ok",
      kind: "bars",
      format: "bars",
      title: "Vendas por canal",
      prompt: "Vendas de hoje por canal.",
    });
    expect((await historyOf(w.id))[0]?.change).toBe("Separa por canal, em barras");
    expect(await routineRow(f, row.routineId ?? "")).toMatchObject({
      name: "Vendas por canal",
      prompt: "Vendas de hoje por canal.",
    });
  });

  test("Resolve resumes a routine paused by failures and takes over one whose creator can't run it", async () => {
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const b = await board();
    const w = await shownWidget(b.id, { schedule: "hour" });
    const routineId = w.routineId ?? "";
    await f.db
      .update(schema.routines)
      .set({ active: false, nextRunAt: null, pausedReason: "failing", failuresInRow: 5, createdByUserId: null })
      .where(eq(schema.routines.id, routineId));
    const view = await refreshWidgetNow(dash(), f.owner.id, f.org.id, w.id);
    expect(view.status).toBe("updating");
    expect(view.routineId).toBe(routineId);
    const routine = await routineRow(f, routineId);
    expect(routine).toMatchObject({ active: true, pausedReason: null, failuresInRow: 0, createdByUserId: f.owner.id });
    expect(routine.nextRunAt).not.toBeNull();
    const runs = await f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routineId));
    expect(runs.map((r) => [r.trigger, r.status])).toEqual([["manual", "queued"]]);
    // Asked again while one is queued: nothing new.
    await refreshWidgetNow(dash(), f.owner.id, f.org.id, w.id);
    expect(await f.db.select().from(schema.routineRuns)).toHaveLength(1);
  });

  test("Update now and Ask for a change run once on a routine a person paused, which stays paused", async () => {
    await setupWidgets((req) => {
      if (seen(req).includes("Updated:")) return { chunks: ["Ok."] };
      return { chunks: [], toolUses: [{ name: "update_widget", input: { data: KPI, summary: "$18,420 today" } }] };
    });
    const b = await board();
    const w = await shownWidget(b.id, { schedule: "hour" });
    const routineId = w.routineId ?? "";
    // Paused on purpose in Routines: inactive, no reason of its own.
    await setRoutineActive(routineDeps(f), f.owner.id, f.org.id, routineId, false);
    const view = await refreshWidgetNow(dash(), f.owner.id, f.org.id, w.id);
    expect(view.status).toBe("updating");
    expect(await routineRow(f, routineId)).toMatchObject({ active: false, pausedReason: null, nextRunAt: null });
    await drainOutbox(f.db, f.handlers);
    expect(await widgetOf(w.id)).toMatchObject({ status: "ok", spec: { kind: "kpi", value: 18420 } });
    expect(await routineRow(f, routineId)).toMatchObject({ active: false, nextRunAt: null });
    // A change request is a person's ask too: it runs, and the schedule still waits for Resume.
    await askWidgetChange(dash(), f.owner.id, f.org.id, w.id, "Show the week's total");
    await drainOutbox(f.db, f.handlers);
    const runs = await f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routineId));
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => [r.trigger, r.status])).toEqual(
      expect.arrayContaining([
        ["manual", "reported"],
        ["event", "reported"],
      ]),
    );
    expect(await routineRow(f, routineId)).toMatchObject({ active: false, pausedReason: null, nextRunAt: null });
  });

  test("a creator who no longer sees the board pauses the routine, and the widget says why", async () => {
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const b = await board();
    const w = await shownWidget(b.id);
    const routineId = (await syncWidgetRoutine(dash(), f.org.id, w.id, { ensure: true })) ?? "";
    // The board is now Bia's alone.
    await f.db.update(schema.dashboards).set({ ownerUserId: bia.id }).where(eq(schema.dashboards.id, b.id));
    const rr = await fireWidget(routineId);
    expect(rr).toMatchObject({ status: "skipped", code: "creator_no_access" });
    expect(await routineRow(f, routineId)).toMatchObject({ active: false, pausedReason: "creator_no_access" });
    expect(await widgetOf(w.id)).toMatchObject({ status: "failed", failureCode: "creator_no_access" });
    // The widget's notice, not the routine's.
    expect(await notificationsOf(f, "routine_paused")).toEqual([]);
  });

  test("Routines pauses a widget's routine but changes nothing else of it; deleting it leaves the widget manual", async () => {
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const b = await board();
    const w = await shownWidget(b.id, { schedule: "day" });
    const routineId = w.routineId ?? "";
    const refused = updateRoutine(routineDeps(f), f.owner.id, f.org.id, routineId, { prompt: "Outra coisa" });
    await expect(refused).rejects.toBeInstanceOf(ForbiddenError);
    await expect(refused).rejects.toMatchObject({ code: "routine.widget_fixed" });
    expect((await setRoutineActive(routineDeps(f), f.owner.id, f.org.id, routineId, false)).active).toBe(false);
    await deleteRoutine(routineDeps(f), f.owner.id, f.org.id, routineId);
    expect(await widgetOf(w.id)).toMatchObject({ routineId: null, schedule: "manual", status: "ok" });
  });

  test("removing a widget deletes its routine and stops its run quietly", async () => {
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const b = await board();
    const w = await shownWidget(b.id, { schedule: "hour" });
    const routineId = w.routineId ?? "";
    const rr = await fireWidget(routineId);
    await dropWidgetRoutine(dash(), f.org.id, w.id);
    expect((await routineRow(f, routineId)).deletedAt).not.toBeNull();
    expect(await routineRunRow(f, rr.id)).toMatchObject({ status: "canceled", code: "deleted" });
    // The ledger left the widget alone (no failure, no notice).
    expect(await widgetOf(w.id)).toMatchObject({ routineId: null, failureCode: null });
    expect(await notificationsOf(f, "widget_failed")).toEqual([]);
    // No routine: a no-op.
    await dropWidgetRoutine(dash(), f.org.id, w.id);
  });

  test("the run policy: a widget run reads and updates its widget, nothing else; update_widget is no other run's", () => {
    const brief = {
      routineId: "r",
      routineRunId: "rr",
      name: "W",
      creatorUserId: "u",
      deliverTo: { channelId: "c", threadId: null },
      access: "act" as const,
      report: "when_new" as const,
      trigger: "schedule",
      dueAt: "",
      widget: { widgetId: "w", dashboardId: "d" },
    };
    const { widget: _widget, ...plainBrief } = brief;
    const widgetRun = { kind: "routine", personId: null, brief } as const;
    const plain = { kind: "routine", personId: null, brief: plainBrief } as const;
    const person = { kind: "person", personId: "u" } as const;
    expect(toolPolicy(widgetRun, { name: "update_widget", scope: "" }).action).toBe("allow");
    expect(toolPolicy(widgetRun, { name: "web_search", scope: "web:read" }).action).toBe("allow");
    const appRead = { name: "github_get_issue", scope: "github:issues.read", connectionId: "x" };
    expect(toolPolicy(widgetRun, appRead).action).toBe("allow");
    expect(toolPolicy(widgetRun, { name: "browser_do", scope: "browser:use" }).action).toBe("allow");
    for (const name of ["hand_off", "post_message", "create_issue", "react", "create_widget"]) {
      expect(toolPolicy(widgetRun, { name, scope: name === "create_issue" ? "issues:write" : "" }).action).toBe(
        "refuse",
      );
    }
    expect(toolPolicy(plain, { name: "update_widget", scope: "" }).action).toBe("refuse");
    expect(toolPolicy(person, { name: "update_widget", scope: "" }).action).toBe("refuse");
    expect(toolPolicy(person, { name: "create_dashboard", scope: "" }).action).toBe("allow");
    expect(toolPolicy(plain, { name: "list_dashboards", scope: "" }).action).toBe("allow");
  });

  test("a widget run starts with what it reads with and update_widget in hand, nothing that writes", async () => {
    const appRead = { name: "stripe_list_subscriptions", scope: "stripe:read", connectionId: "x" };
    const appWrite = { name: "stripe_create_refund", scope: "stripe:write", connectionId: "x" };
    const appSensitiveRead = { name: "stripe_export", scope: "stripe:read", connectionId: "x", sensitive: true };
    expect(widgetUpFront({ name: "update_widget", scope: "" })).toBe(true);
    expect(widgetUpFront(appRead)).toBe(true);
    expect(widgetUpFront({ name: "web_search", scope: "web:read" })).toBe(true);
    expect(widgetUpFront({ name: "web_fetch", scope: "web:read" })).toBe(true);
    for (const held of [
      appWrite,
      appSensitiveRead,
      { name: "create_issue", scope: "issues:write" },
      // Its own reads and its browser stay a search away.
      { name: "list_issues", scope: "issues:read" },
      { name: "browser_do", scope: "browser:use" },
      { name: "post_message", scope: "" },
    ]) {
      expect(widgetUpFront(held)).toBe(false);
    }

    // Through the bridge a computer brain lists its tools from: the widget run's marks, and no other run's.
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const b = await board();
    const w = await shownWidget(b.id);
    const rr = await fireWidget((await syncWidgetRoutine(dash(), f.org.id, w.id, { ensure: true })) ?? "");
    const id = { orgId: f.org.id, agentId: f.agent.id, runId: rr.agentRunId ?? "", machineId: "" };
    const listed = await bridgeToolsFor({ db: f.db, pubsub: f.pubsub, tools: f.tools }, id);
    const upFront = listed.filter((t) => t.upFront).map((t) => t.name);
    expect(upFront).toContain("update_widget");
    expect(upFront.length).toBeLessThanOrEqual(WIDGET_UP_FRONT_MAX);
    for (const name of upFront) expect(["update_widget", "web_search", "web_fetch"]).toContain(name);
  });

  test("a widget being built says the call its run is in, only to who sees it", async () => {
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const b = await createDashboard(dash(), f.owner.id, f.org.id, {
      title: "Sales",
      audience: "workspace",
      editPolicy: "viewers",
    });
    const draft = await testWidget(dash(), f.owner.id, f.org.id, b.id, {
      agentId: f.agent.id,
      prompt: "MRR em real",
      format: "auto",
      schedule: "hour",
    });
    const stepOf = async () => (await getWidget(dash(), f.owner.id, f.org.id, draft.id)).step;
    // Queued, no run yet: nothing to say.
    expect(await stepOf()).toBeNull();
    const [queued] = await f.db
      .select()
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.routineId, draft.routineId ?? ""));
    await executeRoutineRun(routineDeps(f), queued?.id ?? "");
    const runId = (await routineRunRow(f, queued?.id ?? "")).agentRunId ?? "";
    const add = (seq: number, kind: "tool_call" | "tool_result" | "model_call", data: Record<string, unknown>) =>
      f.db.insert(schema.agentRunSteps).values({ orgId: f.org.id, runId, seq: 900 + seq, kind, data });
    await add(1, "tool_call", {
      name: "stripe_list_subscriptions",
      input: { secret: "never sent" },
      connector: "Stripe",
      service: "stripe",
    });
    const step = await stepOf();
    expect(step).toMatchObject({ tool: "stripe_list_subscriptions", connector: "Stripe", service: "stripe" });
    expect(Object.keys(step ?? {}).sort()).toEqual(["at", "connector", "service", "tool"]);
    // Whoever edits the board still doesn't know the draft exists, its step included.
    await expect(getWidget(dash(), nina.id, f.org.id, draft.id)).rejects.toMatchObject({ code: "widget.not_found" });
    // Between calls it is thinking.
    await add(2, "tool_result", { name: "stripe_list_subscriptions" });
    expect(await stepOf()).toBeNull();
    await add(3, "tool_call", { name: "update_widget", input: {} });
    expect(await stepOf()).toMatchObject({ tool: "update_widget", connector: null, service: null });
    // Built: no step any more.
    await f.db.update(schema.dashboardWidgets).set({ status: "ok" }).where(eq(schema.dashboardWidgets.id, draft.id));
    expect(await stepOf()).toBeNull();
  });
});
