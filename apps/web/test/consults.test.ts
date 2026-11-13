import { describe, expect, test } from "bun:test";
import type { ChannelEvent, LiveRun, Message } from "@agenteschat/client";
import {
  applyConsultEvent,
  CONSULT_ASKING_MAX_MS,
  CONSULT_BACK_MAX_MS,
  type ConsultsState,
  consultsIn,
  elapsedClock,
} from "@agenteschat/client";
import {
  type ActivityEntry,
  activitySentence,
  activityText,
  barAsking,
  barEntries,
  barFaces,
  barWords,
  listNames,
  toolActivity,
} from "@agenteschat/client/lib/activity";
import { consultationsOf, previewOf } from "@agenteschat/client/lib/consultations";
import type { TFunction } from "i18next";
import { createI18n } from "@/i18n";

const pt = createI18n("pt-BR");
const t = pt.t.bind(pt) as TFunction;
const en = createI18n("en");
const tEn = en.t.bind(en) as TFunction;

const where = { channelId: "c", threadId: "m1", runId: "r-dev", agentId: "dev" };
const ev = (e: Record<string, unknown>) => ({ ...where, ...e }) as unknown as ChannelEvent;
const names: Record<string, string> = { dev: "Dev", bento: "Bento", iris: "Iris", theo: "Theo", nina: "Nina" };
const nameOf = (id: string) => names[id] ?? "?";

describe("live consultations (agent.consulting / agent.consulted)", () => {
  test("asking → the run pauses (waiting_input) and the question stays out → answered → words drop it", () => {
    let s: ConsultsState = {};
    s = applyConsultEvent(s, ev({ type: "agent.consulting", consultedAgentId: "infra" }), 1000);
    expect(s["r-dev"]?.status).toBe("asking");
    expect(s["r-dev"]?.since).toBe(1000);
    // The asking run pauses while it waits: that is the consultation itself.
    s = applyConsultEvent(s, ev({ type: "agent.idle" }), 1100);
    s = applyConsultEvent(s, ev({ type: "run.finished", status: "waiting_input" }), 1100);
    expect(s["r-dev"]?.status).toBe("asking");
    // Its own ask_agent tool call doesn't end it either.
    s = applyConsultEvent(s, ev({ type: "agent.tool", tool: "ask_agent" }), 1200);
    expect(s["r-dev"]?.status).toBe("asking");
    s = applyConsultEvent(s, ev({ type: "agent.consulted", consultedAgentId: "infra", status: "answered" }), 41_000);
    expect(s["r-dev"]).toMatchObject({ status: "answered", since: 1000, at: 41_000 });
    // Resumed: thinking keeps the line, the first words hand over to the reply's row.
    s = applyConsultEvent(s, ev({ type: "agent.thinking" }), 41_100);
    expect(s["r-dev"]?.status).toBe("answered");
    s = applyConsultEvent(s, ev({ type: "agent.delta", seq: 0, text: "O Infra" }), 41_200);
    expect(s["r-dev"]).toBeUndefined();
  });

  test("ask_agent never waits: the asking turn's message and its ending keep the line until the answer", () => {
    const asking = applyConsultEvent({}, ev({ type: "agent.consulting", consultedAgentId: "infra" }), 0);
    expect(applyConsultEvent(asking, ev({ type: "agent.delta", seq: 0, text: "x" }), 1)["r-dev"]).toBeDefined();
    // "Perguntei pro Infra… te aviso quando ele responder."
    const created = {
      type: "message.created",
      channelId: "c",
      messageId: "m9",
      message: { agentRunId: "r-dev", channelId: "c", author: { type: "agent", id: "dev" } } as Message,
    } as ChannelEvent;
    expect(applyConsultEvent(asking, created, 2)["r-dev"]?.status).toBe("asking");
    for (const status of ["done", "failed", "canceled"])
      expect(applyConsultEvent(asking, ev({ type: "run.finished", status }), 2)["r-dev"]?.status).toBe("asking");
    expect(applyConsultEvent(asking, ev({ type: "run.canceled" }), 2)["r-dev"]?.status).toBe("asking");
    // Once back, the turn's ending drops it.
    const answered = applyConsultEvent(
      asking,
      ev({ type: "agent.consulted", consultedAgentId: "infra", status: "answered" }),
      3,
    );
    expect(applyConsultEvent(answered, ev({ type: "run.finished", status: "done" }), 4)["r-dev"]).toBeUndefined();
    // Back with an answer, then another tool: the line says that tool now.
    const back = applyConsultEvent(
      asking,
      ev({ type: "agent.consulted", consultedAgentId: "infra", status: "expired" }),
      3,
    );
    expect(applyConsultEvent(back, ev({ type: "agent.tool", tool: "create_issue" }), 4)["r-dev"]).toBeUndefined();
  });

  test("an answer we never saw asked (page opened meanwhile) still shows", () => {
    const s = applyConsultEvent({}, ev({ type: "agent.consulted", consultedAgentId: "infra", status: "answered" }), 50);
    expect(s["r-dev"]).toMatchObject({ status: "answered", since: 50, consultedAgentId: "infra" });
  });

  test("consultsIn: per channel, oldest first, stale ones (missed events) left out", () => {
    let s: ConsultsState = {};
    s = applyConsultEvent(s, ev({ type: "agent.consulting", consultedAgentId: "infra" }), 2000);
    s = applyConsultEvent(
      s,
      ev({ type: "agent.consulting", runId: "r-theo", agentId: "theo", consultedAgentId: "iris" }),
      1000,
    );
    s = applyConsultEvent(
      s,
      ev({ type: "agent.consulting", channelId: "other", runId: "r-x", consultedAgentId: "a" }),
      0,
    );
    expect(consultsIn(s, "c", 3000).map((c) => c.runId)).toEqual(["r-theo", "r-dev"]);
    expect(consultsIn(s, "c", 2000 + CONSULT_ASKING_MAX_MS).map((c) => c.runId)).toEqual([]);
    const back = applyConsultEvent(
      s,
      ev({ type: "agent.consulted", consultedAgentId: "infra", status: "answered" }),
      5000,
    );
    expect(consultsIn(back, "c", 5000 + CONSULT_BACK_MAX_MS - 1).map((c) => c.runId)).toContain("r-dev");
    expect(consultsIn(back, "c", 5000 + CONSULT_BACK_MAX_MS).map((c) => c.runId)).not.toContain("r-dev");
  });

  test("the clock", () => {
    expect(elapsedClock(0)).toBe("0:00");
    expect(elapsedClock(41_900)).toBe("0:41");
    expect(elapsedClock(15 * 60_000)).toBe("15:00");
    expect(elapsedClock(-5)).toBe("0:00");
  });
});

describe("the working line's sentence", () => {
  const agent = (id: string): ActivityEntry => ({
    id,
    type: "agent",
    name: nameOf(id),
    activity: { kind: "thinking" },
  });
  const person = (name: string): ActivityEntry => ({ id: name, type: "person", name, activity: { kind: "typing" } });
  const run = (agentId: string, runId = `r-${agentId}`): LiveRun => ({
    runId,
    agentId,
    channelId: "c",
    threadId: "m1",
    status: "thinking",
  });

  test("one, two, three or more agents working (pt-BR and en)", () => {
    expect(activityText(t, [agent("theo")])).toBe("Theo está trabalhando…");
    expect(activityText(t, [agent("theo"), agent("iris")])).toBe("Theo e Iris estão trabalhando…");
    expect(activityText(t, ["theo", "iris", "nina", "dev"].map(agent))).toBe("Theo e mais 3 estão trabalhando…");
    expect(activityText(tEn, ["theo", "iris", "nina"].map(agent))).toBe("Theo and 2 more are working…");
    expect(listNames(t, ["A", "B", "C"])).toBe("A e mais 2");
  });

  test("a crowd is one short line: several agents just work, whatever each does; people type after them", () => {
    const busy = [{ ...agent("theo"), activity: toolActivity("github_list_prs") }, agent("iris"), agent("nina")];
    expect(activityText(t, busy.slice(0, 2))).toBe("Theo e Iris estão trabalhando…");
    expect(activityText(tEn, [...busy, person("Ana")])).toBe("Theo and 2 more are working · Ana is typing…");
    expect(activityText(t, [...busy, person("Ana"), person("Bia"), person("Caio")])).toBe(
      "Theo e mais 2 estão trabalhando · Ana e mais 2 estão digitando…",
    );
    // One agent still says what it does, beside people typing.
    expect(activityText(t, [busy[0] as ActivityEntry, person("Ana"), person("Bia")])).toBe(
      "Theo está consultando o GitHub · Ana e Bia estão digitando…",
    );
    expect(activityText(tEn, [person("Ana")])).toBe("Ana is typing…");
  });

  test("the stack shows three faces at most: agents first, and someone typing when someone is", () => {
    const ids = (list: ActivityEntry[]) => barFaces(list).map((e) => e.id);
    const four = ["theo", "iris", "nina", "dev"].map(agent);
    expect(ids(four)).toEqual(["theo", "iris", "nina"]);
    expect(ids([...four, person("Ana"), person("Bia")])).toEqual(["theo", "iris", "Ana"]);
    expect(ids([agent("theo"), person("Ana"), person("Bia"), person("Caio")])).toEqual(["theo", "Ana", "Bia"]);
    expect(ids(["Ana", "Bia", "Caio", "Dario"].map(person))).toEqual(["Ana", "Bia", "Caio"]);
  });

  test("the bar's words come in pieces that give way in turn: the agents', then who types, never what they do", () => {
    const words = (tf: TFunction, list: ActivityEntry[]) => barWords(tf, list);
    const busy = [agent("theo"), agent("iris")];
    expect(words(t, [...busy, person("Ana")])).toEqual([
      "Theo e Iris estão trabalhando",
      " · ",
      "Ana",
      " está digitando…",
    ]);
    expect(words(tEn, [...busy, person("Ana"), person("Bia"), person("Caio")])).toEqual([
      "Theo and Iris are working",
      " · ",
      "Ana and 2 more",
      " are typing…",
    ]);
    expect(words(t, [person("Ana"), person("Bia")])).toEqual(["", "", "Ana e Bia", " estão digitando…"]);
    // Nobody typing: the agents' phrase alone (one on its own is just its name).
    expect(words(t, busy)).toEqual(["Theo e Iris estão trabalhando…", "", "", ""]);
    // Joined, the pieces are the sentence, names marked the same.
    const mark = (n: string) => `[${n}]`;
    const list = [agent("theo"), person("Ana")];
    expect(barWords(t, list, mark).join("")).toBe(activitySentence(t, list, mark));
  });

  test("names can be marked (bold in the bar) without changing the words", () => {
    const marked = activitySentence(t, [agent("theo"), agent("iris")], (n) => `[${n}]`);
    expect(marked).toBe("[Theo] e [Iris] estão trabalhando…");
  });

  test("a consultation has its own phrase: asking, answered, without an answer", () => {
    // Names ending in "a" read as feminine in pt-BR ("à Iris"), others masculine ("ao Bento").
    const asking = {
      runId: "r-dev",
      agentId: "dev",
      consultedAgentId: "bento",
      channelId: "c",
      threadId: "m1",
      since: 0,
      at: 0,
    };
    const entries = (status: "asking" | "answered" | "expired" | "failed", runs: LiveRun[] = []) =>
      barEntries(runs, [], nameOf, () => undefined, [{ ...asking, status }]);
    expect(activityText(t, entries("asking"))).toBe("Dev está perguntando para Bento…");
    expect(activityText(tEn, entries("asking"))).toBe("Dev is asking Bento…");
    expect(activityText(t, entries("answered"))).toBe("Bento respondeu. Dev está escrevendo…");
    expect(activityText(t, entries("expired"))).toBe("Dev está escrevendo…");
    expect(activityText(t, entries("failed"))).toBe("Dev está escrevendo…");
    // Feminine names take "à".
    const toNina = barEntries([], [], nameOf, () => undefined, [
      { ...asking, consultedAgentId: "nina", status: "asking" as const },
    ]);
    expect(activityText(t, toNina)).toBe("Dev está perguntando para Nina…");
    // Its resumed run doesn't add a second Dev; with others at work the line just says who works (its reply tells the rest).
    expect(activityText(t, entries("answered", [run("dev", "r-dev"), run("theo"), run("nina")]))).toBe(
      "Dev e mais 2 estão trabalhando…",
    );
    // It writes now: the bar says so, its words wait for its reply.
    expect(activityText(t, entries("answered", [{ ...run("dev", "r-dev"), status: "running" }]))).toBe(
      "Bento respondeu. Dev está escrevendo…",
    );
    // The line times the question of an agent on its own; beside others it tells (and times) none.
    expect(barAsking(entries("asking"))).toMatchObject({ to: "bento", status: "asking" });
    expect(barAsking(entries("answered"))).toBeUndefined();
    expect(barAsking(entries("asking", [run("theo")]))).toBeUndefined();
  });
});

describe("meta.consulted", () => {
  test("parsed safely: bad entries out, unknown status and empty answers told as 'couldn't answer'", () => {
    expect(consultationsOf(undefined)).toEqual([]);
    expect(consultationsOf({ consulted: "x" })).toEqual([]);
    const list = consultationsOf({
      consulted: [
        { agentId: "infra", consultationId: "k1", status: "answered", question: "Como sobe?", answer: "Pela fila." },
        { agentId: "iris", consultationId: "k2", status: "expired", question: "E o vídeo?", answer: null },
        { agentId: "nina", consultationId: "k3", status: "answered", question: "?", answer: "  " },
        { agentId: "bento", consultationId: "k4", status: "weird", question: "?" },
        { consultationId: "k5", status: "answered" },
        null,
      ],
    });
    expect(list.map((c) => [c.agentId, c.status, c.answer])).toEqual([
      ["infra", "answered", "Pela fila."],
      ["iris", "expired", null],
      ["nina", "failed", null],
      ["bento", "failed", null],
    ]);
  });

  test("the folded preview is one line of plain text", () => {
    expect(previewOf("**Staging** sobe sozinho.\n\nUse a `fila reserva` [aqui](https://x).")).toBe(
      "Staging sobe sozinho. Use a fila reserva aqui.",
    );
  });
});
