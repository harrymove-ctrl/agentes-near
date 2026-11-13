import { afterEach, describe, expect, test } from "bun:test";
import { orgTopic, type PubSub, type RealtimeEvent, userTopic } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import { WIDGET_SCHEDULE_CRON } from "@agenteschat/ui/widgets/spec";
import {
  askWidgetChange,
  confirmWidget,
  createDashboard,
  createDashboardToolSource,
  type DashboardDeps,
  drainOutbox,
  getDashboard,
  getOrCreateHome,
  getWidget,
  insertWidget,
  listDashboards,
  listRoutines,
  refreshWidgetNow,
  removeWidget,
  sweepWidgetDrafts,
  testWidget,
  updateWidget,
  WIDGET_DRAFTS_MAX,
  widgetView,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { notificationsOf, routineRow } from "./routine-fixtures";

/** ADR 0135 §16 (test a widget before creating it) and §17 (who names a widget, notes never cut). */

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const KPI = { kind: "kpi", value: 1284, delta: { text: "+8%", up: true }, note: "vs. yesterday" };

/** A fixture whose agent answers widget runs with `widgetReply` (and any other run with "Ok."). */
async function setupWidgets(widgetReply: (req: ModelRequest, call: number) => FakeReply) {
  const deps = { db: undefined as unknown as Database, pubsub: undefined as unknown as PubSub } as DashboardDeps;
  const source = createDashboardToolSource(deps);
  let calls = 0;
  f = await setup({
    toolSources: [source],
    reply: (req) => {
      if (!(req.tools ?? []).some((t) => t.name === "update_widget")) return { chunks: ["Ok."] };
      return widgetReply(req, calls++);
    },
  });
  deps.db = f.db;
  deps.pubsub = f.pubsub;
  return f;
}

/** The agent builds the widget with `input` once, then finishes. */
const builds =
  (input: Record<string, unknown>) =>
  (req: ModelRequest): FakeReply => {
    const seen = JSON.stringify(req.messages);
    if (seen.includes("Updated:") || seen.includes("Recorded:")) return { chunks: ["Ok."] };
    return { chunks: [], toolUses: [{ name: "update_widget", input }] };
  };

const dash = (): DashboardDeps => ({ db: f.db, pubsub: f.pubsub, context: f.context });

const board = (title = "Sales", owner = f.owner.id, audience: "workspace" | "private" = "workspace") =>
  createDashboard(dash(), owner, f.org.id, { title, audience, editPolicy: "viewers" });

const ask = (over: Partial<Parameters<typeof testWidget>[4]> = {}) => ({
  agentId: f.agent.id,
  prompt: "ultimas visitas no site",
  format: "auto" as const,
  schedule: "hour" as const,
  ...over,
});

async function widgetOf(id: string) {
  const [row] = await f.db.select().from(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.id, id));
  return row ?? null;
}

const routineRunsOf = (routineId: string) =>
  f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routineId));

describe("test before creating (ADR 0135 §16)", () => {
  test("Test makes a draft only its creator sees, on no board, built at once by a normal refresh run", async () => {
    await setupWidgets(builds({ data: KPI, summary: "1.284 visitas", title: "Visitas no site" }));
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const b = await board();
    const draft = await testWidget(dash(), f.owner.id, f.org.id, b.id, ask());
    expect(draft).toMatchObject({ draft: true, status: "building", dashboardId: b.id, title: "", schedule: "manual" });

    // On no board, in no list, in no count.
    const seen = await getDashboard(dash(), nina.id, f.org.id, b.id);
    expect(seen.widgets).toEqual([]);
    expect(seen.widgetCount).toBe(0);
    expect((await listDashboards(dash(), f.owner.id, f.org.id)).dashboards[0]?.thumbs).toEqual([]);
    // Its creator reads it by id; anyone else, even who edits the board, doesn't know it exists.
    expect((await getWidget(dash(), f.owner.id, f.org.id, draft.id)).draft).toBe(true);
    await expect(getWidget(dash(), nina.id, f.org.id, draft.id)).rejects.toMatchObject({ code: "widget.not_found" });
    await expect(removeWidget(dash(), nina.id, f.org.id, draft.id)).rejects.toMatchObject({ code: "widget.not_found" });

    // Its routine never runs on a schedule and Routines never lists it.
    const routineId = draft.routineId ?? "";
    expect(await routineRow(f, routineId)).toMatchObject({ cron: null, nextRunAt: null });
    expect((await listRoutines(f.db, f.owner.id, f.org.id)).some((r) => r.id === routineId)).toBe(false);

    await drainOutbox(f.db, f.handlers);
    const built = await getWidget(dash(), f.owner.id, f.org.id, draft.id);
    expect(built).toMatchObject({ draft: true, status: "ok", kind: "kpi", title: "Visitas no site" });
    expect(built.history.map((h) => [h.status, h.summary])).toEqual([["ok", "1.284 visitas"]]);
    expect((await routineRunsOf(routineId)).map((r) => r.status)).toEqual(["reported"]);
    // Still on no board.
    expect((await getDashboard(dash(), f.owner.id, f.org.id, b.id)).widgets).toEqual([]);
  });

  test("a draft's events go to its creator alone, even on a board the whole workspace sees", async () => {
    await setupWidgets(builds({ data: KPI, summary: "ok", title: "Visitas" }));
    const b = await board();
    const org: RealtimeEvent[] = [];
    const mine: RealtimeEvent[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => org.push(e));
    f.pubsub.subscribe(userTopic(f.org.id, f.owner.id), (e) => mine.push(e));
    const draft = await testWidget(dash(), f.owner.id, f.org.id, b.id, ask());
    await drainOutbox(f.db, f.handlers);
    const aboutDraft = (e: unknown) => JSON.stringify(e).includes(draft.id);
    expect(org.filter(aboutDraft)).toEqual([]);
    const statuses = mine.filter(aboutDraft).map((e) => (e as { status?: string }).status);
    expect(statuses).toContain("building");
    expect(statuses).toContain("ok");
    expect(mine.filter(aboutDraft).every((e) => (e as { type: string }).type === "dashboard.widget")).toBe(true);
  });

  test("Create widget confirms a tested draft: first on the board, scheduled, its data and history kept", async () => {
    await setupWidgets(builds({ data: KPI, summary: "1.284 visitas", title: "Visitas no site" }));
    const sales = await board("Sales");
    const other = await board("Marketing");
    await insertWidget(dash(), {
      orgId: f.org.id,
      dashboardId: other.id,
      agentId: f.agent.id,
      title: "Leads",
      prompt: "Leads",
      format: "kpi",
      schedule: "manual",
      spec: { kind: "kpi", value: 3 },
      createdByUserId: f.owner.id,
    });
    const draft = await testWidget(dash(), f.owner.id, f.org.id, sales.id, ask());
    const confirm = {
      dashboardId: other.id,
      size: "s" as const,
      schedule: "hour" as const,
      alert: { enabled: true, condition: "drops 20%" },
    };
    // Not built yet: there is nothing tested to create.
    await expect(confirmWidget(dash(), f.owner.id, f.org.id, draft.id, confirm)).rejects.toMatchObject({
      code: "widget.not_tested",
    });
    await drainOutbox(f.db, f.handlers);
    const updatesBefore = (await getWidget(dash(), f.owner.id, f.org.id, draft.id)).history;

    const made = await confirmWidget(dash(), f.owner.id, f.org.id, draft.id, confirm);
    expect(made).toMatchObject({
      draft: false,
      dashboardId: other.id,
      status: "ok",
      title: "Visitas no site",
      schedule: "hour",
      alert: { enabled: true, condition: "drops 20%" },
      layout: { w: 1, h: 1 },
    });
    const onBoard = await getDashboard(dash(), f.owner.id, f.org.id, other.id);
    expect(onBoard.widgets.map((w) => w.id)).toEqual([draft.id, expect.any(String)]);
    expect((await getWidget(dash(), f.owner.id, f.org.id, draft.id)).history).toEqual(updatesBefore);
    // Its routine now updates on the schedule, on its new board, and Routines lists it.
    const routine = await routineRow(f, made.routineId ?? "");
    expect(routine).toMatchObject({
      cron: WIDGET_SCHEDULE_CRON.hour,
      createdByUserId: f.owner.id,
      target: { type: "widget", widgetId: draft.id, dashboardId: other.id },
    });
    expect(routine.nextRunAt).not.toBeNull();
    expect((await listRoutines(f.db, f.owner.id, f.org.id)).some((r) => r.id === routine.id)).toBe(true);
    // No rebuild: the one run of the test.
    expect(await routineRunsOf(routine.id)).toHaveLength(1);
    // The agent's title was kept as is: it is still the agent's to rename on a change.
    expect((await widgetOf(draft.id))?.titleSetByUser).toBe(false);
    // A draft is confirmed once.
    await expect(confirmWidget(dash(), f.owner.id, f.org.id, draft.id, confirm)).rejects.toMatchObject({
      code: "widget.not_found",
    });
  });

  test("confirm: only its creator, a title of their own is kept, the board's room and edit rights hold", async () => {
    await setupWidgets(builds({ data: KPI, summary: "ok", title: "Visitas" }));
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const b = await board();
    const closed = await createDashboard(dash(), f.owner.id, f.org.id, {
      title: "Closed",
      audience: "workspace",
      editPolicy: "owner",
    });
    const draft = await testWidget(dash(), nina.id, f.org.id, b.id, ask());
    await drainOutbox(f.db, f.handlers);
    const input = { size: "m" as const, schedule: "manual" as const, alert: { enabled: false, condition: "" } };
    await expect(
      confirmWidget(dash(), f.owner.id, f.org.id, draft.id, { ...input, dashboardId: b.id }),
    ).rejects.toMatchObject({ code: "widget.not_found" });
    await expect(
      confirmWidget(dash(), nina.id, f.org.id, draft.id, { ...input, dashboardId: closed.id }),
    ).rejects.toMatchObject({ code: "dashboard.forbidden" });
    const made = await confirmWidget(dash(), nina.id, f.org.id, draft.id, {
      ...input,
      dashboardId: b.id,
      title: "Visitas de hoje",
    });
    expect(made).toMatchObject({ title: "Visitas de hoje", draft: false, schedule: "manual", nextRunAt: null });
    expect((await widgetOf(draft.id))?.titleSetByUser).toBe(true);
  });

  test("a person keeps at most WIDGET_DRAFTS_MAX drafts; the oldest go with their routines", async () => {
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const b = await board();
    const made: string[] = [];
    for (let i = 0; i <= WIDGET_DRAFTS_MAX; i++) {
      made.push((await testWidget(dash(), f.owner.id, f.org.id, b.id, ask({ prompt: `ask ${i}` }))).id);
    }
    const drafts = await f.db.select().from(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.draft, true));
    expect(drafts).toHaveLength(WIDGET_DRAFTS_MAX);
    expect(drafts.map((d) => d.id)).not.toContain(made[0]);
    const routines = await f.db.select().from(schema.routines);
    const live = routines.filter((r) => (r.target as { type?: string } | null)?.type === "widget" && !r.deletedAt);
    expect(live).toHaveLength(WIDGET_DRAFTS_MAX);
  });

  test("cancelling a test deletes the draft, its routine, and stops its run", async () => {
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const b = await board();
    const draft = await testWidget(dash(), f.owner.id, f.org.id, b.id, ask());
    const routineId = draft.routineId ?? "";
    expect((await routineRunsOf(routineId)).map((r) => r.status)).toEqual(["queued"]);
    await removeWidget(dash(), f.owner.id, f.org.id, draft.id);
    expect(await widgetOf(draft.id)).toBeNull();
    expect((await routineRow(f, routineId)).deletedAt).not.toBeNull();
    expect((await routineRunsOf(routineId)).map((r) => [r.status, r.code])).toEqual([["canceled", "deleted"]]);
  });

  test("drafts nobody confirmed are swept after a day", async () => {
    await setupWidgets(() => ({ chunks: ["Ok."] }));
    const b = await board();
    const old = await testWidget(dash(), f.owner.id, f.org.id, b.id, ask());
    const fresh = await testWidget(dash(), f.owner.id, f.org.id, b.id, ask());
    await f.db
      .update(schema.dashboardWidgets)
      .set({ createdAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(schema.dashboardWidgets.id, old.id));
    expect(await sweepWidgetDrafts(dash())).toBe(1);
    expect(await widgetOf(old.id)).toBeNull();
    expect(await widgetOf(fresh.id)).not.toBeNull();
    expect((await routineRow(f, old.routineId ?? "")).deletedAt).not.toBeNull();
    expect(await sweepWidgetDrafts(dash())).toBe(0);
  });

  test("a failed test tells nobody; drafts hold no place under the board's or the workspace's caps", async () => {
    await setupWidgets(builds({ failed: "O site não está conectado para mim." }));
    const b = await board("Sales", f.owner.id, "private");
    const draft = await testWidget(dash(), f.owner.id, f.org.id, b.id, ask({ schedule: "half" }));
    await drainOutbox(f.db, f.handlers);
    const failed = await getWidget(dash(), f.owner.id, f.org.id, draft.id);
    expect(failed).toMatchObject({ status: "failed", failure: { code: "agent_reported" } });
    expect(failed.failure?.detail).toContain("não está conectado");
    expect(await notificationsOf(f, "widget_failed")).toEqual([]);
    expect(await notificationsOf(f, "routine_failed")).toEqual([]);
    await expect(
      confirmWidget(dash(), f.owner.id, f.org.id, draft.id, {
        dashboardId: b.id,
        size: "m",
        schedule: "manual",
        alert: { enabled: false, condition: "" },
      }),
    ).rejects.toMatchObject({ code: "widget.not_tested" });
    // A draft is never moved or changed but by confirming it.
    await expect(updateWidget(dash(), f.owner.id, f.org.id, draft.id, { title: "X" })).rejects.toMatchObject({
      code: "widget.not_found",
    });
    // Its home stays empty.
    expect((await getOrCreateHome(dash(), f.owner.id, f.org.id)).widgets).toEqual([]);
  });

  test("a draft raises no alert, and its view says what its latest update cost", async () => {
    await setupWidgets(builds({ data: KPI, summary: "ok", title: "Visitas", alert: "Caiu 30%." }));
    const b = await board();
    const draft = await testWidget(dash(), f.owner.id, f.org.id, b.id, ask());
    await f.db
      .update(schema.dashboardWidgets)
      .set({ alertEnabled: true, alertUserId: f.owner.id })
      .where(eq(schema.dashboardWidgets.id, draft.id));
    await drainOutbox(f.db, f.handlers);
    expect(await notificationsOf(f, "widget_alert")).toEqual([]);
    await f.db
      .update(schema.dashboardWidgetUpdates)
      .set({ costNanoUsd: 12_000_000 })
      .where(eq(schema.dashboardWidgetUpdates.widgetId, draft.id));
    const row = await widgetOf(draft.id);
    if (!row) throw new Error("no draft");
    expect((await widgetView(f.db, row)).lastCostUsd).toBeCloseTo(0.012, 6);
  });
});

describe("who names a widget (ADR 0135 §17)", () => {
  test("a first build must name it: no title is a tool error; too long is refused, never cut", async () => {
    const results: string[] = [];
    await setupWidgets((req, call) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("Updated:")) return { chunks: ["Ok."] };
      if (call > 0) results.push(last);
      const titles = [undefined, "Visitas de todas as páginas do site nos últimos dias", "Visitas"];
      const title = titles[Math.min(call, 2)];
      return {
        chunks: [],
        toolUses: [{ name: "update_widget", input: { data: KPI, summary: "ok", ...(title ? { title } : {}) } }],
      };
    });
    const b = await board();
    const draft = await testWidget(dash(), f.owner.id, f.org.id, b.id, ask());
    await drainOutbox(f.db, f.handlers);
    expect(results[0]).toContain("short `title`");
    expect(results[1]).toContain("at most 40 characters");
    expect(await widgetOf(draft.id)).toMatchObject({ status: "ok", title: "Visitas", titleSetByUser: false });
  });

  test("a plain refresh never renames it; a change may, unless a person named it", async () => {
    let title = "Novo nome";
    await setupWidgets((req) => builds({ data: KPI, summary: "ok", title })(req));
    const b = await board();
    const w = await insertWidget(dash(), {
      orgId: f.org.id,
      dashboardId: b.id,
      agentId: f.agent.id,
      title: "Visitas",
      prompt: "Visitas do site",
      format: "kpi",
      schedule: "manual",
      spec: { kind: "kpi", value: 1 },
      createdByUserId: f.owner.id,
    });
    await refreshWidgetNow(dash(), f.owner.id, f.org.id, w.id);
    await drainOutbox(f.db, f.handlers);
    expect((await widgetOf(w.id))?.title).toBe("Visitas");

    await askWidgetChange(dash(), f.owner.id, f.org.id, w.id, "Mostre por semana");
    await drainOutbox(f.db, f.handlers);
    expect((await widgetOf(w.id))?.title).toBe("Novo nome");

    // Rename: the person's title stays from then on.
    await updateWidget(dash(), f.owner.id, f.org.id, w.id, { title: "Minhas visitas" });
    expect(await widgetOf(w.id)).toMatchObject({ title: "Minhas visitas", titleSetByUser: true });
    title = "Outro nome";
    await askWidgetChange(dash(), f.owner.id, f.org.id, w.id, "Agora por mês");
    await drainOutbox(f.db, f.handlers);
    expect((await widgetOf(w.id))?.title).toBe("Minhas visitas");
  });

  test("a note longer than one short sentence is a tool error the agent fixes", async () => {
    const results: string[] = [];
    await setupWidgets((req, call) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("Updated:")) return { chunks: ["Ok."] };
      if (call > 0) results.push(last);
      const note = call === 0 ? `${"visitantes únicos ".repeat(10)}(1.012 visitantes)` : "1.012 visitantes";
      return {
        chunks: [],
        toolUses: [{ name: "update_widget", input: { data: { ...KPI, note }, summary: "ok", title: "Visitas" } }],
      };
    });
    const b = await board();
    const draft = await testWidget(dash(), f.owner.id, f.org.id, b.id, ask());
    await drainOutbox(f.db, f.handlers);
    expect(results[0]).toContain("at most 140 characters");
    expect((await widgetOf(draft.id))?.spec).toMatchObject({ note: "1.012 visitantes" });
  });
});
