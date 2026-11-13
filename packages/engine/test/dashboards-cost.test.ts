import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { costNanoUsd } from "@agenteschat/providers";
import {
  agentSourceNames,
  createAgent,
  type DashboardDeps,
  estimateWidgetCost,
  parseWidgetSuggestions,
  widgetSuggestions,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
let deps: DashboardDeps;
beforeEach(async () => {
  f = await setup();
  deps = { db: f.db, pubsub: f.pubsub, context: f.context };
});
afterEach(() => f.close());

const TYPICAL = { inputTokens: 8000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 };
/** What a typical refresh costs on the fixture agent's model, in US$. */
const typical = () => costNanoUsd("claude-sonnet-5-5", TYPICAL) / 1e9;

/** A routine of the agent that ran `costs.length` times, each run spending what `costs` says (nano-USD). */
async function routineRuns(costs: number[][], agentId = f.agent.id) {
  const [routine] = await f.db
    .insert(schema.routines)
    .values({
      orgId: f.org.id,
      agentId,
      name: "Daily sales",
      prompt: "Sales",
      target: { type: "dm" },
      triggerType: "schedule",
      createdByUserId: f.owner.id,
    })
    .returning();
  if (!routine) throw new Error("no routine");
  const runIds: string[] = [];
  for (const [i, calls] of costs.entries()) {
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId,
        channelId: f.general.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
        trigger: "mention",
        hop: 1,
        background: true,
      })
      .returning();
    if (!run) throw new Error("no run");
    runIds.push(run.id);
    await f.db.insert(schema.routineRuns).values({
      orgId: f.org.id,
      routineId: routine.id,
      at: new Date(Date.now() - (i + 1) * 3600_000),
      trigger: "schedule",
      agentRunId: run.id,
      status: "reported",
    });
    for (const cost of calls) await usage(run.id, cost, agentId);
  }
  return runIds;
}

/** A run that answered in a conversation (no routine). */
async function chatRun() {
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
      trigger: "mention",
      hop: 1,
    })
    .returning();
  if (!run) throw new Error("no run");
  return run.id;
}

async function usage(runId: string | null, cost: number, agentId = f.agent.id, billedTo = "org") {
  await f.db.insert(schema.usageRecords).values({
    orgId: f.org.id,
    agentId,
    runId,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    requestedModel: "claude-sonnet-5-5",
    inputTokens: 100,
    outputTokens: 10,
    costNanoUsd: cost,
    billedTo,
  });
}

describe("what a widget costs (ADR 0135 §7)", () => {
  test("without a history: its model's price for a typical refresh, times the runs of its schedule", async () => {
    const hourly = await estimateWidgetCost(deps, f.owner.id, f.org.id, f.agent.id, "hour");
    expect(hourly).toMatchObject({
      agentId: f.agent.id,
      schedule: "hour",
      runsPerDay: 24,
      basis: "model",
      billedTo: "api",
    });
    expect(hourly.perRunUsd).toBeCloseTo(typical(), 12);
    expect(hourly.perDayUsd).toBeCloseTo(typical() * 24, 12);
    expect(hourly.perWeekUsd).toBeCloseTo(typical() * 24 * 7, 12);
    const weekly = await estimateWidgetCost(deps, f.owner.id, f.org.id, f.agent.id, "week");
    expect(weekly.perWeekUsd).toBeCloseTo(typical(), 12);
    const manual = await estimateWidgetCost(deps, f.owner.id, f.org.id, f.agent.id, "manual");
    expect(manual).toMatchObject({ runsPerDay: 0, perDayUsd: 0 });
  });

  test("with three routine runs or more in 30 days: their average", async () => {
    // Two calls in the first run; another agent's, a chat run's and a platform-paid call don't count.
    const [first] = await routineRuns([[1_000_000, 1_000_000], [2_000_000], [3_000_000]]);
    await usage(first ?? null, 40_000_000, f.agent.id, "platform");
    await usage(await chatRun(), 50_000_000);
    await usage(null, 50_000_000);
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Operations", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await routineRuns([[90_000_000], [90_000_000], [90_000_000]], other.id);
    const daily = await estimateWidgetCost(deps, f.owner.id, f.org.id, f.agent.id, "day");
    expect(daily).toMatchObject({ basis: "history", runsPerDay: 1, billedTo: "api" });
    expect(daily.perRunUsd).toBeCloseTo(7_000_000 / 3 / 1e9, 12);
    expect(daily.perDayUsd).toBeCloseTo(7_000_000 / 3 / 1e9, 12);
  });

  test("fewer than three runs say too little: the model's price", async () => {
    await routineRuns([[5_000_000], [5_000_000]]);
    expect((await estimateWidgetCost(deps, f.owner.id, f.org.id, f.agent.id, "hour")).basis).toBe("model");
  });

  test("an agent on a computer's plan: the plan pays, no money shown", async () => {
    await f.db.update(schema.agents).set({ brain: "claude_code" }).where(eq(schema.agents.id, f.agent.id));
    expect(await estimateWidgetCost(deps, f.owner.id, f.org.id, f.agent.id, "hour")).toEqual({
      agentId: f.agent.id,
      schedule: "hour",
      runsPerDay: 24,
      perRunUsd: null,
      perDayUsd: null,
      perWeekUsd: null,
      basis: "none",
      billedTo: "plan",
    });
  });

  test("only for an agent the person can talk to", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    await f.db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, f.agent.id));
    await expect(estimateWidgetCost(deps, nina.id, f.org.id, f.agent.id, "hour")).rejects.toMatchObject({
      code: "widget.agent_unreachable",
    });
  });
});

describe("suggestions per agent (ADR 0135 §3)", () => {
  async function connection(label: string, prefix: string) {
    const [row] = await f.db
      .insert(schema.connectorConnections)
      .values({
        orgId: f.org.id,
        connector: prefix,
        label,
        serverUrl: `https://${prefix}.example.com/mcp`,
        authType: "none",
        toolPrefix: prefix,
      })
      .returning();
    if (!row) throw new Error("no connection");
    return row;
  }

  test("what the agent reads: the connections it holds a grant on, or all of them with every tool", async () => {
    const stripe = await connection("Stripe", "stripe");
    await connection("Linear", "linear");
    expect(await agentSourceNames(f.db, f.org.id, f.agent.id)).toEqual([]);
    await f.db
      .insert(schema.agentScopes)
      .values({ orgId: f.org.id, agentId: f.agent.id, connectionId: stripe.id, scope: "connector:*" });
    expect(await agentSourceNames(f.db, f.org.id, f.agent.id)).toEqual(["Stripe"]);
    await f.db
      .insert(schema.agentScopes)
      .values({ orgId: f.org.id, agentId: f.agent.id, connectionId: null, scope: "*" });
    expect(await agentSourceNames(f.db, f.org.id, f.agent.id)).toEqual(["Linear", "Stripe"]);
    await f.db
      .update(schema.connectorConnections)
      .set({ revokedAt: new Date() })
      .where(eq(schema.connectorConnections.id, stripe.id));
    expect(await agentSourceNames(f.db, f.org.id, f.agent.id)).toEqual(["Linear"]);
  });

  test("no cheap model at hand: no suggestions, never an error", async () => {
    const view = await widgetSuggestions({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id);
    expect(view).toEqual({ agentId: f.agent.id, sources: [], suggestions: [] });
  });

  test("three suggestions from the cheap model, in the person's language, recorded with the agent", async () => {
    const answer = {
      suggestions: [
        { title: "Vendas de hoje", prompt: "Vendas de hoje vs. ontem", kind: "kpi", alert: "cair 20% abaixo de ontem" },
        { title: "Tickets abertos", prompt: "Tickets abertos por fila", kind: "bars", alert: "passar de 30" },
        { title: "Meta do mês", prompt: "Quanto falta para a meta", kind: "goal", alert: "" },
        { title: "Extra", prompt: "Not shown", kind: "text", alert: "" },
      ],
    };
    const g = await setup({ reply: () => ({ chunks: [JSON.stringify(answer)] }) });
    try {
      const view = await widgetSuggestions(
        { db: g.db, pubsub: g.pubsub, context: g.context },
        g.owner.id,
        g.org.id,
        g.agent.id,
      );
      expect(view.suggestions).toEqual([
        { title: "Vendas de hoje", prompt: "Vendas de hoje vs. ontem", kind: "kpi", alert: "cair 20% abaixo de ontem" },
        { title: "Tickets abertos", prompt: "Tickets abertos por fila", kind: "bars", alert: "passar de 30" },
        { title: "Meta do mês", prompt: "Quanto falta para a meta", kind: "goal", alert: "" },
      ]);
      const call = g.provider.calls.at(-1);
      expect(call?.request.outputSchema).toBeDefined();
      expect(JSON.stringify(call?.request.messages)).toContain("pt-BR");
      const [record] = await g.db
        .select()
        .from(schema.usageRecords)
        .where(and(eq(schema.usageRecords.orgId, g.org.id), eq(schema.usageRecords.kind, "summary")));
      expect(record?.agentId).toBe(g.agent.id);
    } finally {
      await g.close();
    }
  });

  test("a model that fails or answers badly: no suggestions", async () => {
    const g = await setup({ reply: () => new Error("provider down") });
    try {
      const view = await widgetSuggestions(
        { db: g.db, pubsub: g.pubsub, context: g.context },
        g.owner.id,
        g.org.id,
        g.agent.id,
      );
      expect(view.suggestions).toEqual([]);
    } finally {
      await g.close();
    }
    expect(parseWidgetSuggestions("not json")).toEqual([]);
    expect(
      parseWidgetSuggestions(
        JSON.stringify({
          suggestions: [
            { title: "No kind", prompt: "x", kind: "pie", alert: "" },
            { title: "", prompt: "x", kind: "kpi", alert: "" },
            { title: "  Open\n PRs ", prompt: " Pull requests waiting ", kind: "list", alert: 3 },
          ],
        }),
      ),
    ).toEqual([{ title: "Open PRs", prompt: "Pull requests waiting", kind: "list", alert: "" }]);
  });
});
