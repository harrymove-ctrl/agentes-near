import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { UsageQueue, UsageQueueRow } from "../src/api/types";
import { agentStatusShort, agentStatusText } from "../src/lib/presence";
import {
  usageQueueMeta,
  usageQueueResuming,
  usageQueueShared,
  usageQueueSkipReason,
  usageQueueStoppable,
  usageQueueTitle,
  usageQueueWhere,
  usageQueueWho,
} from "../src/lib/usage-queue";
import { receiptView } from "../src/realtime/receipts";

const tFor = (lng: string) => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as TFunction;
};
const pt = tFor("pt-BR");
const now = new Date("2026-11-03T12:00:00Z");

const row = (over: Partial<UsageQueueRow> = {}): UsageQueueRow => ({
  runId: "r1",
  kind: "conversation",
  channelId: "c1",
  threadId: null,
  channelKind: "channel",
  channelName: "suporte",
  messageId: "m1",
  askers: ["ana", "bruno"],
  since: new Date(now.getTime() - 3 * 24 * 3600_000).toISOString(),
  after: { count: 12, names: ["Nina", "Ada"] },
  state: "queued",
  title: null,
  mayStop: true,
  ...over,
});
const queue = (over: Partial<UsageQueue> = {}): UsageQueue => ({
  agentId: "theo",
  reason: "plan",
  plan: "Claude",
  resetsAt: "2026-11-03T15:00:00Z",
  sharedWith: [],
  closed: [],
  rows: [row()],
  hidden: 0,
  mayStopAll: true,
  ...over,
});
const person = (id: string) => ({ ana: "Ana", bruno: "Bruno", me: "você" })[id] ?? id;

test("the queue's words: one title per phase, short rows, why one was skipped", () => {
  // Before the reset: when it is back. Once it answers the first one: picking up.
  expect(usageQueueTitle(pt, "pt-BR", "Theo", queue(), now)).toMatch(/^Theo volta às \d\d:00$/);
  expect(usageQueueTitle(pt, "pt-BR", "Theo", queue({ resetsAt: null }), now)).toBe(
    "Theo volta quando o plano renovar",
  );
  expect(usageQueueTitle(pt, "pt-BR", "Theo", queue({ reason: "budget", resetsAt: null }), now)).toBe(
    "Theo volta quando o orçamento renovar",
  );
  const draining = queue({ rows: [row({ state: "answering" }), row({ runId: "r2" })] });
  expect(usageQueueResuming(draining)).toBe(true);
  expect(usageQueueTitle(pt, "pt-BR", "Theo", draining, now)).toBe("Theo está retomando");
  expect(usageQueueTitle(pt, "pt-BR", "Theo", queue({ reason: null, rows: [] }), now)).toBe("Theo");
  // Behind the ⓘ: the other agents on the plan.
  expect(usageQueueShared(pt, "Claude", ["Ada"])).toBe(
    "Ada usa o mesmo plano do Claude. As conversas dos dois entram na mesma fila.",
  );
  expect(usageQueueShared(pt, "Claude", ["Ada", "Nina"])).toBe(
    "Ada e Nina usam o mesmo plano do Claude. As conversas de todos entram na mesma fila.",
  );
  expect(usageQueueShared(pt, "Claude", [])).toBeNull();
  expect(usageQueueWhere(pt, row(), "me", person)).toBe("#suporte");
  expect(usageQueueWhere(pt, row({ threadId: "t1" }), "me", person)).toBe("Conversa em #suporte");
  expect(usageQueueWhere(pt, row({ channelKind: "dm", channelName: null, askers: ["bruno"] }), "me", person)).toBe(
    "DM com Bruno",
  );
  expect(usageQueueWhere(pt, row({ channelKind: "dm", askers: ["me"] }), "me", person)).toBe("Sua DM");
  expect(usageQueueWhere(pt, row({ kind: "routine", title: "Resumo diário", askers: [] }), "me", person)).toBe(
    "Rotina Resumo diário",
  );
  // Who and when, on the row's one line: a DM already names its person, so only when.
  const recent = { since: new Date(now.getTime() - 40 * 60_000).toISOString() };
  // The time never breaks across lines.
  expect(usageQueueWho(pt, "pt-BR", row(recent), person, now)).toBe("Ana e Bruno · há\u00a040\u00a0min");
  expect(usageQueueWho(pt, "pt-BR", row({ ...recent, askers: ["me", "ana"] }), person, now)).toBe(
    "você e Ana · há\u00a040\u00a0min",
  );
  expect(usageQueueWho(pt, "pt-BR", row({ ...recent, channelKind: "dm", askers: ["me"] }), person, now)).toBe(
    "há\u00a040\u00a0min",
  );
  expect(usageQueueMeta(pt, "pt-BR", row(), person, now)).toMatch(/^Pedido por Ana e Bruno · /);
  // The dialog's voice, not the agent's ("Não respondi:" stays in its note).
  const at = now.toISOString();
  expect(usageQueueSkipReason(pt, { reason: "solved", who: { name: "Nina" }, askers: [], at })).toBe(
    "Nina já cuidou disso",
  );
  expect(usageQueueSkipReason(pt, { reason: "withdrawn", who: { name: "Ana" }, askers: [], at })).toBe(
    "Ana disse que não precisa mais",
  );
  expect(usageQueueSkipReason(pt, { reason: "mixed", askers: [], at })).toBe("Já estava resolvido");
  // "Não rodar nenhuma" counts what is still in line, the hidden ones too, never the one answering.
  expect(usageQueueStoppable({ ...draining, hidden: 1 })).toBe(2);
  expect(pt("usageQueue.confirmAll", { count: 2 })).toBe("Não rodar as 2?");
  expect(pt("usageQueue.hidden", { count: 1 })).toBe("+1 que você não vê");
});

test("an agent out of office with conversations waiting says how many", () => {
  const line = {
    by: "auto" as const,
    text: null,
    kind: "out_of_plan" as const,
    subject: null,
    emoji: null,
    until: null,
    count: 7,
  };
  expect(agentStatusText(pt, line, "pt-BR", now)?.text).toBe("Sem limite no plano · 7 conversas esperando");
  expect(agentStatusText(pt, { ...line, count: undefined }, "pt-BR", now)?.text).toBe("Sem limite no plano");
});

test("the members column says an agent out of office in one short line, no emoji, no count", () => {
  const line = {
    by: "auto" as const,
    text: null,
    kind: "out_of_plan" as const,
    subject: null,
    emoji: null,
    until: null,
    count: 4,
  };
  expect(agentStatusShort(pt, line, "pt-BR", now)).toEqual({ emoji: null, text: "Sem limite" });
  const until = new Date(now.getTime() + 60 * 60_000).toISOString();
  const back = agentStatusShort(pt, { ...line, until }, "pt-BR", now)?.text ?? "";
  expect(back).toMatch(/^Sem limite · volta às \d{1,2}:\d{2}$/);
  expect(agentStatusShort(pt, { ...line, kind: "out_of_budget" }, "pt-BR", now)?.text).toBe("Sem orçamento");
  // Any other line reads as its full words.
  expect(agentStatusShort(pt, { ...line, kind: "work", subject: "x" }, "pt-BR", now)).toEqual(
    agentStatusText(pt, { ...line, kind: "work", subject: "x" }, "pt-BR", now),
  );
});

test("long work in the agent's line of work reads as in line, not as waiting for your answer", () => {
  const view = receiptView({ routed: true, server: undefined, agents: [["ada", "line"]] } as never);
  expect(view.status).toEqual({ kind: "line", agents: ["ada"] });
  expect(pt("receipts.line", { count: 1, names: "Ada" })).toBe("Ada começa quando terminar outro trabalho");
});

test("a limit leads with our pause icon, never an emoji; any other line keeps its emoji", () => {
  const line = { by: "auto" as const, text: null, subject: null, emoji: null, until: null };
  for (const kind of ["out_of_plan", "out_of_budget", "waiting_plan", "waiting_budget"] as const)
    expect(agentStatusText(pt, { ...line, kind }, "pt-BR", now)).toMatchObject({ emoji: null, icon: "pause" });
  expect(agentStatusText(pt, { ...line, kind: "waiting_approval" }, "pt-BR", now)).toMatchObject({ emoji: "⏳" });
  expect(agentStatusText(pt, { ...line, kind: "waiting_approval" }, "pt-BR", now)?.icon).toBeUndefined();
  // An emoji someone chose stays theirs.
  expect(agentStatusText(pt, { ...line, kind: "out_of_plan", emoji: "🌴" }, "pt-BR", now)).toMatchObject({
    emoji: "🌴",
  });
});
