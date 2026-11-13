import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AiStatus,
  applyReceiptEvent,
  type DecidedBy,
  type ReceiptsState,
  receiptView,
  seedReceipt,
} from "@agenteschat/client";
import { deciderOf } from "@agenteschat/client/lib/routing";
import {
  keepsLine,
  keptLine,
  markLabel,
  markOf,
  phaseKey,
  type ReceiptMarkView,
  receiptLine,
  receiptMessageId,
  receiptRows,
  receiptShows,
  turnHeadId,
} from "../../src/features/chat/agent-receipts";
import { endsOnNoAiCard, noAiBanner } from "../../src/features/chat/no-ai-banner";
import { message, translator } from "./fixtures";

const routed = (
  state: ReceiptsState,
  over: { seenBy?: string[]; pickedBy?: string[]; reason?: string; decidedBy?: DecidedBy } = {},
) =>
  applyReceiptEvent(state, {
    type: "message.routed",
    channelId: "c1",
    messageId: "m1",
    seenBy: over.seenBy ?? ["ada", "theo"],
    pickedBy: over.pickedBy ?? ["ada"],
    ...(over.reason ? { reason: over.reason } : {}),
    ...(over.decidedBy ? { decidedBy: over.decidedBy } : {}),
  });
const picking = (state: ReceiptsState) =>
  applyReceiptEvent(state, { type: "message.routing", channelId: "c1", messageId: "m1", step: "plan" });
const handled = (state: ReceiptsState, agentId: string, status?: "done" | "failed" | "waiting_approval") =>
  applyReceiptEvent(state, {
    type: "message.handled",
    channelId: "c1",
    messageId: "m1",
    agentId,
    ...(status ? { status } : {}),
  });

describe("the agents' receipt line under a person's message", () => {
  test("nothing before any agent saw it", () => {
    expect(receiptLine(undefined)).toBeNull();
    expect(receiptLine({ routed: true, agents: [] })).toBeNull();
  });

  test("seen only, nothing decided yet: the faces, the clock and who saw it, in words", () => {
    const line = receiptLine({ routed: false, agents: [["ada", "seen"]] });
    expect(line?.faces).toEqual(["ada"]);
    expect(line?.mark).toBe("clock");
    expect(line?.words).toEqual({ key: "receipts.seenBy", agents: ["ada"] });
    expect(line?.action).toBeNull();
  });

  test("picked, then answering: the clock until Ada is on it, then one tick; words for screen readers", () => {
    const picked = receiptLine(routed({}).m1);
    expect(picked?.faces).toEqual(["ada"]);
    expect(picked?.mark).toBe("clock");
    expect(picked?.words).toBeNull();
    expect(picked?.label).toEqual({ key: "receipts.picked", agents: ["ada"] });
    const claimed = receiptLine(
      applyReceiptEvent(routed({}), { type: "message.claimed", channelId: "c1", messageId: "m1", agentId: "ada" }).m1,
    );
    expect(claimed?.label.key).toBe("receipts.claimed");
    expect(claimed?.mark).toBe("check");
  });

  test("answered: the faces of who answered and two ticks, no words", () => {
    const line = receiptLine(handled(routed({}), "ada", "done").m1);
    expect(line?.faces).toEqual(["ada"]);
    expect(line?.mark).toBe("checks");
    expect(line?.words).toBeNull();
    expect(line?.label.key).toBe("receipts.handled");
  });

  test("the agent the router picked passed: two ticks that say no one replied, never that it answered", async () => {
    const passed = applyReceiptEvent(routed({}), {
      type: "message.handled",
      channelId: "c1",
      messageId: "m1",
      agentId: "ada",
      status: "done",
      passed: true,
    }).m1;
    const line = receiptLine(passed);
    expect(line?.mark).toBe("checks");
    expect(line?.words).toBeNull();
    expect(line?.label).toEqual({ key: "receipts.passed", agents: ["ada"] });
    expect(markOf(null, null, passed)).toMatchObject({ kind: "agents", agentId: "ada", mark: "checks" });
    expect(receiptRows(passed)).toContainEqual({ agentId: "ada", phase: "passed" });
    const [en, pt] = await Promise.all([translator("en"), translator("pt-BR")]);
    expect(pt("receipts.passed", { count: 1 })).toBe("Ninguém respondeu");
    expect(en("receipts.passed", { count: 1 })).toBe("No one replied");
    expect(pt(phaseKey("passed"))).toBe("Não respondeu");
    expect(en(phaseKey("passed"))).toBe("Didn't reply");
  });

  test("a reaction that ended its run reads 'reacted' on its row, not 'answered'", () => {
    const answered = handled(routed({}), "ada", "done").m1;
    expect(receiptRows(answered, ["ada"])).toContainEqual({ agentId: "ada", phase: "reacted" });
  });

  test("waiting for an approval: one tick (Ada is on it), and says so", () => {
    const line = receiptLine(handled(routed({}), "ada", "waiting_approval").m1);
    expect(line?.mark).toBe("check");
    expect(line?.words?.key).toBe("receipts.waiting");
  });

  test("a run parked because its AI provider is down says so on its own line, never that it asks you", async () => {
    const parked = applyReceiptEvent(routed({}), {
      type: "message.handled",
      channelId: "c1",
      messageId: "m1",
      agentId: "ada",
      status: "waiting_input",
      outage: true,
    });
    const line = receiptLine(parked.m1);
    expect(line?.words).toEqual({ key: "receipts.outage", agents: ["ada"] });
    expect(line && keepsLine(line)).toBe(true);
    expect(line?.alert).toBe(false);
    const asking = applyReceiptEvent(routed({}), {
      type: "message.handled",
      channelId: "c1",
      messageId: "m1",
      agentId: "ada",
      status: "waiting_input",
    });
    expect(receiptLine(asking.m1)?.words?.key).toBe("receipts.asking");
    const pt = await translator("pt-BR");
    expect(pt("receipts.outage", { count: 1, names: "Ada" })).toBe(
      "Ada: o provedor de IA está fora do ar · tenta de novo sozinho",
    );
    const en = await translator("en");
    expect(en("receipts.outage", { count: 1, names: "Ada" })).toBe("Ada: the AI provider is down · retries by itself");
  });

  test("a run waiting for its computer: in line, or until it is back, on its own line", async () => {
    const waiting = (computer: "queued" | "away") =>
      receiptLine(
        applyReceiptEvent(routed({}), {
          type: "message.handled",
          channelId: "c1",
          messageId: "m1",
          agentId: "ada",
          status: "waiting_input",
          computer,
        }).m1,
      );
    expect(waiting("queued")?.words).toEqual({ key: "receipts.queued", agents: ["ada"] });
    expect(waiting("away")?.words).toEqual({ key: "receipts.away", agents: ["ada"] });
    expect(waiting("queued")?.alert).toBe(false);
    const pt = await translator("pt-BR");
    expect(pt("receipts.queued", { count: 1, names: "Ada" })).toBe("Ada está na fila do computador");
    const en = await translator("en");
    expect(en("receipts.away", { count: 2, names: "Ada and Theo" })).toBe("Ada and Theo are waiting for the computer");
  });

  test("a failure is the danger tone with Retry", () => {
    const line = receiptLine(handled(routed({}), "ada", "failed").m1);
    expect(line?.words).toEqual({ key: "receipts.failed", agents: ["ada"] });
    expect(line?.action).toBe("retry");
    expect(line?.alert).toBe(true);
  });

  test("Retry says it is trying while it is out, and the new run's claim takes the line off the failure at once", async () => {
    const failed = applyReceiptEvent(routed({}), {
      type: "message.handled",
      channelId: "c1",
      messageId: "m1",
      agentId: "ada",
      runId: "r1",
      status: "failed",
    });
    expect(receiptLine(failed.m1)?.action).toBe("retry");
    // What the server sends as it starts the run again, before any worker claims it.
    const again = applyReceiptEvent(failed, {
      type: "message.claimed",
      channelId: "c1",
      messageId: "m1",
      agentId: "ada",
      runId: "r2",
    });
    expect(receiptLine(again.m1)?.action).not.toBe("retry");
    expect(receiptLine(again.m1)?.alert).not.toBe(true);
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "features/chat/AgentReceipts.tsx"), "utf8");
    expect(src).toContain('loading={action === "retry" && retrying}');
    expect((await translator("pt-BR"))("receipts.retrying")).toBe("Tentando de novo…");
    expect((await translator("en"))("receipts.retrying")).toBe("Trying again…");
  });

  test("routed to nobody: two ticks, no line; 'No agent will answer' is its label (the sheet says it)", () => {
    const line = receiptLine(routed({}, { pickedBy: [] }).m1);
    expect(line?.faces).toEqual([]);
    expect(line?.mark).toBe("checks");
    expect(line?.words).toBeNull();
    expect(line?.label.key).toBe("receipts.nobody");
    expect(line?.action).toBeNull();
    expect(line && keepsLine(line)).toBe(false);
  });

  test("past the workspace's platform AI nobody is asked: to mention an agent, nothing to tap", () => {
    const line = receiptLine(routed({}, { seenBy: [], pickedBy: [], reason: "platform_cap" }).m1);
    expect(line).toMatchObject({ faces: [], mark: "none", words: { key: "receipts.platformCap" }, action: null });
  });

  test("nothing could pick: 'without an @', muted, and a tap opens the agents it reached, also after a reload", () => {
    const live = routed({}, { pickedBy: [], reason: "mention_needed" }).m1;
    const line = receiptLine(live);
    expect(line?.label).toEqual({ key: "receipts.mentionNeeded", agents: [] });
    expect(line?.alert).toBe(false);
    expect(line?.action).toBeNull();
    expect(receiptRows(live)).toHaveLength(2);
    const listed = {
      ...message({ id: "m1" }),
      receipts: { seenBy: ["ada", "theo"], pickedBy: [], handled: [], reason: "mention_needed" as const },
    };
    expect(receiptLine(seedReceipt({}, listed).m1)?.label.key).toBe("receipts.mentionNeeded");
  });

  test("the author's own plan picking: the clock and 'Picking who answers', until the decision", () => {
    const seeded = seedReceipt({}, message({ id: "m1" }));
    const line = receiptLine(picking(seeded).m1);
    expect(line).toMatchObject({ faces: [], mark: "clock", action: null, alert: false });
    expect(line?.words).toEqual({ key: "receipts.picking", agents: [] });
    expect(receiptRows(picking(seeded).m1)).toEqual([]);
    const decided = routed(picking(seeded), { decidedBy: { step: "plan", brand: "claude", ownerId: "u1" } });
    expect(receiptLine(decided.m1)?.label.key).toBe("receipts.picked");
    // A late `message.routing` doesn't bring it back.
    expect(receiptLine(picking(decided).m1)?.label.key).toBe("receipts.picked");
  });

  test("the sheet's last line: the rule that picked; nothing for an AI's pick, nobody or a decision from before", async () => {
    const en = await translator("en");
    const names = { agent: (id: string) => (id === "ada" ? "Ada" : "Theo") };
    const by = (decidedBy: DecidedBy, pickedBy = ["ada"]) =>
      deciderOf(en, receiptView(routed({}, { pickedBy, decidedBy }).m1), names);
    expect(by({ step: "jev" })).toBeNull();
    expect(by({ step: "model", model: "claude-haiku-5-5", provider: "anthropic" })).toBeNull();
    expect(by({ step: "plan", brand: "claude", ownerId: "u1" })).toBeNull();
    expect(by({ step: "rule", rule: "only_agent" })).toEqual({
      rule: "only_agent",
      text: "Only Ada answers here without a mention",
    });
    expect(by({ step: "rule", rule: "reply" }, [])).toBeNull();
    // Alone with the team: the reason says nothing new to the person, so no line (the decision stays stored).
    expect(by({ step: "rule", rule: "alone" })).toBeNull();
    expect(deciderOf(en, receiptView(routed({}).m1), names)).toBeNull();
    const pt = await translator("pt-BR");
    const reply = receiptView(routed({}, { decidedBy: { step: "rule", rule: "reply" } }).m1);
    expect(deciderOf(pt, reply, names)?.text).toBe("Uma resposta para a Ada");
    // A decision stored before the team's coordinator was retired (ADR 0137) reads as the default rule's line.
    const coordinated = receiptView(
      routed({}, { pickedBy: ["theo"], decidedBy: { step: "rule", rule: "coordinator" } }).m1,
    );
    expect(deciderOf(pt, coordinated, names)).toEqual({
      rule: "default",
      text: "Ninguém foi chamado, então o Theo respondeu",
    });
  });

  test("waiting on its plan: a line under the message that says so, never 'waiting for your answer'; canceled: two ticks", async () => {
    const waiting = applyReceiptEvent(routed({}), {
      type: "message.handled",
      channelId: "c1",
      messageId: "m1",
      agentId: "ada",
      status: "waiting_input",
      usage: "plan",
    });
    const line = receiptLine(waiting.m1);
    expect(line).toMatchObject({ mark: "none", words: { key: "receipts.plan", agents: ["ada"] }, action: null });
    expect(line && keepsLine(line)).toBe(true);
    expect(receiptRows(waiting.m1)).toContainEqual({ agentId: "ada", phase: "plan" });
    const pt = await translator("pt-BR");
    expect(pt(phaseKey("plan"))).toBe("Esperando o plano");
    expect(pt("receipts.plan", { count: 1, names: "Ada" })).toBe("Ada está esperando o plano");
    const canceled = applyReceiptEvent(waiting, {
      type: "message.handled",
      channelId: "c1",
      messageId: "m1",
      agentId: "ada",
      status: "canceled",
    });
    expect(receiptLine(canceled.m1)).toMatchObject({
      mark: "checks",
      words: null,
      label: { key: "receipts.canceled" },
    });
    expect(pt(phaseKey("canceled"))).toBe("Cancelado");
  });

  test("no AI: the receipt's words and Connect, even when nobody was asked", () => {
    const line = receiptLine(routed({}, { seenBy: [], pickedBy: [], reason: "no_ai" }).m1);
    expect(line?.words?.key).toBe("noAi.receipt");
    expect(line?.action).toBe("connect");
    const agent = receiptLine(
      applyReceiptEvent(routed({}), {
        type: "message.handled",
        channelId: "c1",
        messageId: "m1",
        agentId: "ada",
        reason: "no_ai",
      }).m1,
    );
    expect(agent?.faces).toEqual(["ada"]);
    expect(agent?.action).toBe("connect");
  });

  test("at most three faces, and how many more", () => {
    const many = { routed: false, agents: ["a", "b", "c", "d", "e"].map((id) => [id, "seen"] as [string, "seen"]) };
    const line = receiptLine(many);
    expect(line?.faces).toEqual(["a", "b", "c"]);
    expect(line?.more).toBe(2);
  });

  test("a message that went into a task gives way to the steer mark, unless there is something to tap", () => {
    const outage = receiptLine(
      applyReceiptEvent(routed({}), {
        type: "message.handled",
        channelId: "c1",
        messageId: "m1",
        agentId: "ada",
        status: "waiting_input",
        outage: true,
      }).m1,
    );
    expect(receiptShows(outage, false)).toBe(true);
    expect(receiptShows(outage, true)).toBe(false);
    expect(receiptShows(receiptLine(handled(routed({}), "ada", "failed").m1), true)).toBe(true);
    expect(receiptShows(null, false)).toBe(false);
  });

  test("a receipt is a mark beside the message, never a line, unless it asks something of you", () => {
    const answered = handled(routed({}), "ada", "done").m1;
    const plan = picking(seedReceipt({}, message({ id: "m1" }))).m1;
    const marks = {
      seen: { routed: false, agents: [["ada", "seen"]] as [string, "seen"][] },
      answering: routed({}).m1,
      answered,
      approval: handled(routed({}), "ada", "waiting_approval").m1,
      // It lasts as long as the plan's call: a line would come and go under the message.
      picking: plan,
      // Nobody will answer: never a line (an agent's reaction beside it read as wrong), the sheet says it.
      nobody: routed({}, { pickedBy: [] }).m1,
      mentionNeeded: routed({}, { pickedBy: [], reason: "mention_needed" }).m1,
    };
    for (const receipt of Object.values(marks)) {
      expect(receiptShows(receiptLine(receipt), false)).toBe(false);
      expect(markOf(null, null, receipt)?.kind).toBe("agents");
    }
    expect(markOf(null, null, answered)).toEqual({
      kind: "agents",
      agentId: "ada",
      mark: "checks",
      label: { key: "receipts.handled", agents: ["ada"] },
    });
    // No agent yet: the clock alone, and a tap says its words (no sheet of agents to list).
    expect(markOf(null, null, plan)).toEqual({
      kind: "agents",
      agentId: null,
      mark: "clock",
      label: { key: "receipts.picking", agents: [] },
    });
    expect(receiptRows(plan)).toEqual([]);
    const lines = {
      failed: handled(routed({}), "ada", "failed").m1,
      noAi: routed({}, { seenBy: [], pickedBy: [], reason: "no_ai" }).m1,
      platformCap: routed({}, { seenBy: [], pickedBy: [], reason: "platform_cap" }).m1,
    };
    for (const receipt of Object.values(lines)) {
      expect(receiptShows(receiptLine(receipt), false)).toBe(true);
      expect(markOf(null, null, receipt)).toBeNull();
    }
  });

  test("my message sent into a task at work wears that first; in a DM between people, who read it", () => {
    const read = { runId: "r1", agentId: "ada", state: "read" as const };
    expect(markOf(read, null, routed({}).m1)).toEqual({ kind: "steer", agentId: "ada", state: "read", words: "read" });
    const line: MessageReceipt = { routed: true, agents: [["ada", "queued"]] };
    expect(markOf({ ...read, state: "waiting" }, null, line)).toMatchObject({ state: "waiting", words: "computer" });
    expect(markOf(null, "u2", undefined)).toEqual({ kind: "seen", personId: "u2" });
    expect(markOf(null, null, undefined)).toBeNull();
  });

  test("the mark's words, its label and what a tap says, in both languages", async () => {
    const [en, pt] = await Promise.all([translator("en"), translator("pt-BR")]);
    const names = { agent: (id: string) => (id === "ada" ? "Ada" : "Theo"), person: () => "João" };
    const steer = (state: "waiting" | "now" | "held" | "read"): ReceiptMarkView => ({
      kind: "steer",
      agentId: "ada",
      state,
      words: state,
    });
    expect(markLabel(en, steer("waiting"), names)).toBe("Ada reads it at the next pause");
    expect(markLabel(en, { kind: "steer", agentId: "ada", state: "waiting", words: "computer" }, names)).toBe(
      "Ada reads it when it gets the computer",
    );
    expect(markLabel(en, steer("held"), names)).toBe("Ada reads it after your decision");
    expect(markLabel(pt, steer("now"), names)).toBe("Ada parou para ler");
    expect(markLabel(pt, steer("read"), names)).toBe("Ada leu");
    expect(markLabel(en, { kind: "seen", personId: "u2" }, names)).toBe("Seen by João");
    expect(markLabel(pt, { kind: "seen", personId: "u2" }, names)).toBe("Vista por João");
    const two = handled(handled(routed({}, { pickedBy: ["ada", "theo"] }), "ada", "done"), "theo", "done").m1;
    expect(markLabel(en, markOf(null, null, two) as ReceiptMarkView, names)).toBe("Ada and Theo answered");
    const approval = markOf(null, null, handled(routed({}), "ada", "waiting_approval").m1) as ReceiptMarkView;
    expect(markLabel(pt, approval, names)).toBe("Ada está esperando aprovação");
    const plan = markOf(null, null, picking(seedReceipt({}, message({ id: "m1" }))).m1) as ReceiptMarkView;
    expect(markLabel(en, plan, names)).toBe("Picking who answers");
    expect(markLabel(pt, plan, names)).toBe("Escolhendo quem responde");
  });

  test("someone else's mark goes at the end of their turn's name line: a grouped row has none", () => {
    const rows = [
      { kind: "day" },
      { kind: "message", message: message({ id: "a" }), grouped: false },
      { kind: "message", message: message({ id: "b" }), grouped: true },
      { kind: "message", message: message({ id: "c" }), grouped: true },
      { kind: "message", message: message({ id: "d", author: { type: "person", id: "u2" } }), grouped: false },
    ];
    expect(turnHeadId(rows, "c")).toBe("a");
    expect(turnHeadId(rows, "a")).toBe("a");
    expect(turnHeadId(rows, "d")).toBe("d");
    expect(turnHeadId(rows, "x")).toBeNull();
  });

  test("the sheet: each agent with its phase; one the message only names says so", () => {
    const asked = {
      ...message({ id: "m1", mentionedAgentIds: ["theo"] }),
      receipts: { seenBy: ["ada", "theo"], pickedBy: ["ada"], handled: [], referenced: ["theo"] },
    };
    const state = seedReceipt({}, asked);
    expect(receiptRows(state.m1)).toEqual([
      { agentId: "ada", phase: "picked" },
      { agentId: "theo", phase: "referenced" },
    ]);
    expect(phaseKey("referenced")).toBe("receipts.status.referenced");
    expect(phaseKey("no_ai")).toBe("noAi.chip");
    expect(phaseKey("claimed")).toBe("receipts.status.claimed");
  });

  test("the sheet: an agent whose reaction was its answer says it reacted", async () => {
    const nobody = routed({}, { pickedBy: [] }).m1;
    expect(receiptRows(nobody, ["ada"])).toEqual([
      { agentId: "ada", phase: "reacted" },
      { agentId: "theo", phase: "seen" },
    ]);
    expect(phaseKey("reacted")).toBe("receipts.status.reacted");
    const [en, pt] = await Promise.all([translator("en"), translator("pt-BR")]);
    expect(en(phaseKey("reacted"))).toBe("Reacted");
    expect(pt(phaseKey("reacted"))).toBe("Reagiu");
  });

  test("seeded from the list: a person's message starts its receipt, an agent's only when it mentions agents", () => {
    const listed = {
      ...message({ id: "m1" }),
      receipts: { seenBy: ["ada"], pickedBy: [], handled: [{ agentId: "ada", status: "done" as const }] },
    };
    const seeded = seedReceipt({}, listed);
    expect(receiptLine(seeded.m1)?.mark).toBe("checks");
    const agent = seedReceipt({}, message({ id: "m2", author: { type: "agent", id: "ada" } }));
    expect(agent.m2).toBeUndefined();
    // Theo thanked Ada, read as no hand-off (ADR 0089): she is only mentioned, and that asks nothing of you.
    const thanks = seedReceipt(
      {},
      {
        ...message({ id: "m3", author: { type: "agent", id: "theo" }, mentionedAgentIds: ["ada"] }),
        receipts: { seenBy: ["ada"], pickedBy: [], handled: [], blocked: [], referenced: ["ada"] },
      },
    );
    expect(receiptRows(thanks.m3)).toEqual([{ agentId: "ada", phase: "referenced" }]);
    expect(receiptLine(thanks.m3)?.mark).toBe("checks");
  });
});

describe("which message carries the line", () => {
  test("the latest person's message the server has, skipping agents, ones still sending and event lines", () => {
    const list = [
      message({ id: "a" }),
      message({ id: "b", author: { type: "person", id: "u2" } }),
      message({ id: "c", author: { type: "agent", id: "ada" } }),
      message({ id: "d", local: "pending" }),
    ];
    expect(receiptMessageId(list)).toBe("b");
    expect(receiptMessageId([message({ id: "x", author: { type: "agent", id: "ada" } })])).toBeNull();
    expect(receiptMessageId([])).toBeNull();
    // An agent's message that mentions another agent carries it too (ADR 0089).
    const handedOff = message({ id: "e", author: { type: "agent", id: "theo" }, mentionedAgentIds: ["ada"] });
    expect(receiptMessageId([...list, handedOff])).toBe("e");
  });

  test("a later hand-off between agents never takes the line of a person's message that asks something of you", () => {
    const list = [
      message({ id: "b", author: { type: "person", id: "u2" } }),
      message({ id: "e", author: { type: "agent", id: "theo" }, mentionedAgentIds: ["ada"] }),
    ];
    const asks = {
      failed: handled(routed({}), "ada", "failed").m1,
      noAi: routed({}, { seenBy: [], pickedBy: [], reason: "no_ai" }).m1,
      platformCap: routed({}, { seenBy: [], pickedBy: [], reason: "platform_cap" }).m1,
    };
    for (const receipt of Object.values(asks)) expect(receiptMessageId(list, { b: receipt })).toBe("b");
    // Answered, or still nothing to say: the hand-off carries it.
    expect(receiptMessageId(list, { b: handled(routed({}), "ada", "done").m1 })).toBe("e");
    expect(receiptMessageId(list, { b: routed({}, { pickedBy: [] }).m1 })).toBe("e");
    expect(receiptMessageId(list)).toBe("e");
  });
});

describe("the no-AI banner above the box", () => {
  const status = (any: boolean, states: Record<string, "ready" | "no_ai" | "waiting"> = {}): AiStatus => ({
    any,
    agents: Object.entries(states).map(([agentId, state]) => ({ agentId, state })),
  });
  const where = (over: Partial<{ agentIds: string[]; dmAgentId: string | null; cardShown: boolean }> = {}) => ({
    agentIds: ["ada", "theo"],
    dmAgentId: null,
    cardShown: false,
    ...over,
  });

  test("nothing while the status loads, or with an AI somewhere", () => {
    expect(noAiBanner(undefined, where())).toBeNull();
    expect(noAiBanner(status(true), where())).toBeNull();
  });

  test("a workspace without any AI, in a conversation with agents", () => {
    expect(noAiBanner(status(false), where())).toEqual({ kind: "org" });
    expect(noAiBanner(status(false), where({ agentIds: ["ada"] }))).toEqual({ kind: "org", agentId: "ada" });
    expect(noAiBanner(status(false), where({ agentIds: [] }))).toBeNull();
  });

  test("'ask in the chat' only where Jev reads the message", () => {
    const routing = (by: "jev" | "rules"): AiStatus => ({
      ...status(false),
      routing: { by, mine: by, model: null, noSmallModel: null },
    });
    expect(noAiBanner(routing("jev"), where())).toEqual({ kind: "org", askInChat: true });
    expect(noAiBanner(routing("rules"), where())).toEqual({ kind: "org" });
  });

  test("an agent's DM: only that agent's state counts", () => {
    expect(noAiBanner(status(true, { ada: "no_ai" }), where({ dmAgentId: "ada" }))).toEqual({
      kind: "agent",
      agentId: "ada",
    });
    expect(noAiBanner(status(false, { ada: "waiting" }), where({ dmAgentId: "ada" }))).toBeNull();
    expect(noAiBanner(status(false, { ada: "ready" }), where({ dmAgentId: "ada" }))).toBeNull();
  });

  test("not right under the agent's own no-AI card", () => {
    expect(noAiBanner(status(false), where({ cardShown: true }))).toBeNull();
    const card = message({ id: "n", author: { type: "agent", id: "ada" }, meta: { noAi: { agentId: "ada" } } });
    expect(endsOnNoAiCard([message({ id: "m" }), card])).toBe(true);
    expect(endsOnNoAiCard([card, message({ id: "m" })])).toBe(false);
    expect(endsOnNoAiCard([])).toBe(false);
  });
});

describe("a receipt never adds a line to its row", () => {
  const src = (path: string) => readFileSync(join(import.meta.dir, "..", "..", "src", path), "utf8");
  const num = (text: string, pattern: RegExp) => Number(pattern.exec(text)?.[1]);

  test("the mark stands in a line the row already keeps: after the time under my turn, at the end of a name line", () => {
    const row = src("features/chat/MessageRow.tsx");
    const marks = src("features/chat/AgentReceipts.tsx");
    // The time's line holds the tallest mark, and the mark sits in it, after the time.
    expect(num(marks, /mark: \{[^}]*height: (\d+)/)).toBe(num(row, /meTime: \{[^}]*height: (\d+)/));
    const line = row.slice(row.indexOf("<View style={[styles.meTime, "));
    expect(line.indexOf("when.time(m.createdAt)")).toBeLessThan(line.indexOf("<ReceiptMark message={m} mine"));
    expect(line).toContain("<ReceiptMark message={m} mine receipt={receipt} seenBy={seenBy} />");
    // The turn's last bubble ends on the cut corner, on the side it stands.
    expect(row).toContain("solo: { borderBottomRightRadius: BUBBLE_CUT }");
    expect(row).toContain("end: { borderTopRightRadius: 6, borderBottomRightRadius: BUBBLE_CUT }");
    // Someone else's: absolutely placed in room their name line always keeps, so a mark that comes wraps nothing.
    expect(row).toContain('m.author.type === "person" && !inBubble && !compact && styles.whoRoom');
    expect(row).toMatch(/whoMark: \{ position: "absolute"/);
    expect(num(row, /whoRoom: \{ paddingRight: (\d+) \}/)).toBeGreaterThanOrEqual(16 + 4 + 12);
    // No line of its own: neither the steer line under my bubble nor "Visto" under the list's row.
    expect(row).not.toContain("SteerLine");
    expect(src("features/chat/ChatScreen.tsx")).not.toContain('t("mobile.chat.seen")');
  });
});

test("on a billing hold a no-AI line reads as kept, with no alert and nothing to connect", () => {
  const line = (faces: string[]) =>
    keptLine({
      faces,
      more: 0,
      mark: "none",
      words: { key: "noAi.receipt", agents: [] },
      label: { key: "noAi.receipt", agents: [] },
      action: "connect",
      alert: true,
    });
  expect(line(["ada"])).toMatchObject({ words: { key: "noAi.kept.receipt" }, action: null, alert: false });
  expect(line([])).toMatchObject({ words: { key: "noAi.kept.channel" } });
  expect(keptLine(null)).toBeNull();
  expect(phaseKey("no_ai", true)).toBe("noAi.kept.receipt");
});
