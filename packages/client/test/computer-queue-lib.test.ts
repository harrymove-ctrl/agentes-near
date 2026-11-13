import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { ComputerQueue } from "../src/api/types";
import {
  awayText,
  conversationWaits,
  durationText,
  fanChipText,
  fanOutOf,
  fanOutText,
  fanShows,
  nthText,
  queueAllStartedText,
  queueButtonText,
  queuedNextText,
  queueFillText,
  queueLeftText,
  queueLiveText,
  queuePurposeText,
  queueStartText,
  queueStatusText,
  queueView,
  queueWhereText,
  waitingFor,
} from "../src/lib/computer-queue";
import { talkerStatusText } from "../src/lib/long-work";
import type { MessageReceipt } from "../src/realtime/receipts";

const tFor = (lng: string) => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as TFunction;
};
const en = tFor("en");
const pt = tFor("pt-BR");

const NOW = Date.parse("2026-11-02T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const NAMES: Record<string, string> = { ada: "Ada", kai: "Kai", rio: "Rio", nova: "Nova", theo: "Theo" };
const agentName = (id: string) => NAMES[id];
const where = { channelId: "c1", threadId: null };

const queue: ComputerQueue = {
  machineId: "m1",
  name: "Studio",
  working: [
    {
      runId: "w1",
      agentId: "ada",
      purpose: { kind: "agent", agentId: "kai" },
      where,
      startedAt: at(-6),
      estimatedEndAt: at(1),
    },
  ],
  waiting: [
    {
      runId: "q1",
      agentId: "theo",
      purpose: { kind: "person", userId: "me" },
      where,
      people: true,
      position: 1,
      estimatedStartAt: at(1),
      after: ["ada"],
    },
    {
      runId: "q2",
      agentId: "kai",
      purpose: { kind: "agent", agentId: "ada" },
      where,
      people: false,
      position: 2,
      estimatedStartAt: at(3),
      after: ["theo"],
    },
    {
      runId: "q3",
      agentId: "rio",
      purpose: { kind: "routine" },
      where,
      people: false,
      position: 3,
      estimatedStartAt: null,
      after: ["theo", "kai"],
    },
    {
      runId: "q4",
      agentId: "nova",
      purpose: { kind: "work" },
      where,
      people: false,
      position: 4,
      estimatedStartAt: null,
      after: ["theo", "kai", "rio"],
    },
  ],
};

test("the view: the viewer's own request is marked, the computer full, the next start known, the last one not", () => {
  const view = queueView(queue, "me");
  expect(view.waiting.map((w) => w.mine)).toEqual([true, false, false, false]);
  expect(view.full).toBe(true);
  expect(queueStatusText(en, view, NOW)).toBe("Full · next starts in about 1 min");
  expect(queueAllStartedText(en, view, NOW)).toBeNull();
  expect(queueButtonText(en, queue)).toBe("Computer · 4 waiting");
  expect(queueButtonText(pt, { ...queue, waiting: [] })).toBe("Computador");
  expect(queueStatusText(en, queueView({ ...queue, waiting: [] }, "me"), NOW)).toBe("Nobody in line");
  const known = queueView({ ...queue, waiting: queue.waiting.slice(0, 2) }, "me");
  expect(queueAllStartedText(pt, known, NOW)).toBe("todos começam em ~3 min");
  // One in line: its row already says when it starts.
  expect(queueAllStartedText(en, queueView({ ...queue, waiting: queue.waiting.slice(0, 1) }, "me"), NOW)).toBeNull();
});

test("an agent's turn for a message: the run its receipt follows, else its one turn waiting in that conversation", () => {
  expect(waitingFor(queue, { runOf: { theo: "q1" } }, "theo", "elsewhere")?.runId).toBe("q1");
  expect(waitingFor(queue, undefined, "kai", "c1")?.runId).toBe("q2");
  expect(waitingFor(queue, undefined, "kai", "c2")).toBeNull();
  expect(waitingFor(null, undefined, "theo", "c1")).toBeNull();
});

test("the agent's live row: next with an estimate, next alone without one, further back after the ones ahead", () => {
  expect(queueLiveText(en, "en", queue, "q1", agentName, NOW)).toBe(
    "Waiting for the computer. Next up, in about 1 min",
  );
  const noEta = { ...queue, waiting: queue.waiting.map((w) => ({ ...w, estimatedStartAt: null })) };
  expect(queueLiveText(en, "en", noEta, "q1", agentName, NOW)).toBe("Waiting for the computer. Next up");
  expect(queueLiveText(pt, "pt-BR", noEta, "q1", agentName, NOW)).toBe("Aguardando o computador. É o próximo");
  expect(queueLiveText(en, "en", queue, "q4", agentName, NOW)).toBe("In line, 4th. After Theo, Kai, and Rio");
  expect(queueLiveText(pt, "pt-BR", queue, "q2", agentName, NOW)).toBe("Na fila, 2º. Depois de Theo");
  expect(queueLiveText(en, "en", queue, "elsewhere", agentName, NOW)).toBeNull();
  expect(queuedNextText(pt, "Ada")).toBe("Ada está na fila do computador · é a próxima");
  expect(queuedNextText(en, "Theo")).toBe("Theo is in line for the computer · next");
});

test("rows: what each turn is for, never its content, where, and its estimate", () => {
  const names = { viewerId: "me", agent: agentName, person: (id: string) => (id === "u2" ? "Bia" : undefined) };
  expect(queuePurposeText(en, { kind: "person", userId: "me" }, names)).toBe("answering you");
  expect(queuePurposeText(en, { kind: "person", userId: "u2" }, names)).toBe("answering Bia");
  expect(queuePurposeText(en, { kind: "person", userId: null }, names)).toBe("answering a person");
  expect(queuePurposeText(pt, { kind: "agent", agentId: "kai" }, names)).toBe("a pedido de Kai");
  expect(queuePurposeText(en, { kind: "routine" }, names)).toBe("a routine");
  expect(queueWhereText(en, { kind: "channel", name: "dev", thread: false })).toBe("#dev");
  expect(queueWhereText(en, { kind: "dm", mine: true })).toBe("your DM");
  expect(queueWhereText(en, { kind: "dm", mine: false, withName: "Theo" })).toBe("DM with Theo");
  expect(queueWhereText(en, { kind: "hidden" })).toBe("a private conversation");
  expect(queueWhereText(pt, { kind: "agents" })).toBe("uma conversa entre agentes");
  const turn = queue.working[0] as NonNullable<(typeof queue.working)[0]>;
  expect(queueLeftText(en, turn, NOW)).toBe("~1 min left");
  // Past its typical length no estimate is honest, however it reads.
  expect(queueLeftText(pt, { ...turn, estimatedEndAt: null, overdue: true }, NOW)).toBe("passou do normal");
  expect(queueLeftText(en, { ...turn, estimatedEndAt: null }, NOW)).toBeNull();
  // An estimate that passed while the dialog stayed open: nobody asked the line again.
  expect(queueLeftText(pt, { ...turn, estimatedEndAt: new Date(NOW - 1).toISOString() }, NOW)).toBe("passou do normal");
  expect(queueStartText(en, queue.waiting[1] as never, agentName, NOW)).toBe("starts ~3 min");
  expect(queueStartText(pt, { ...queue.waiting[0], estimatedStartAt: null } as never, agentName, NOW)).toBe(
    "começa quando a Ada terminar",
  );
  expect(queueStartText(en, queue.waiting[3] as never, agentName, NOW)).toBeNull();
  expect(awayText(en, at(-3), NOW)).toBe("Away 3 min");
});

test("how long something has gone on: seconds, minutes, hours, then days past two of them", () => {
  const hour = 3_600_000;
  expect(durationText(pt, 40_000)).toBe("40 s");
  expect(durationText(pt, 25 * 60_000)).toBe("25 min");
  expect(durationText(pt, 47 * hour)).toBe("47 h");
  expect(durationText(pt, 82 * hour)).toBe("3 dias");
  expect(durationText(en, 82 * hour)).toBe("3 days");
});

test("what fills the computer, by what each turn is for", () => {
  const of = (...kinds: ("agent" | "routine" | "work")[]) =>
    kinds.map((kind) => ({ purpose: kind === "agent" ? { kind, agentId: "ada" } : { kind } }));
  expect(queueFillText(pt, of("agent", "agent", "routine"))).toBe("2 pedidas por agentes e 1 rotina");
  expect(queueFillText(en, of("work"))).toBe("1 long job");
  expect(queueFillText(en, [])).toBeNull();
});

test("ordinals by the language's own rule", () => {
  expect([1, 2, 3, 4, 11, 21, 22].map((n) => nthText(en, "en", n))).toEqual([
    "1st",
    "2nd",
    "3rd",
    "4th",
    "11th",
    "21st",
    "22nd",
  ]);
  expect(nthText(pt, "pt-BR", 3)).toBe("3º");
});

test("fan-out: each called agent answered, working or its place in line, from receipts and the computer's line", () => {
  const receipt: MessageReceipt = {
    routed: true,
    byAgent: true,
    mentioned: ["ada", "kai", "theo", "rio", "nova", "gone"],
    referenced: ["gone"],
    agents: [
      ["ada", "handled"],
      ["kai", "queued"],
      ["theo", "claimed"],
      ["rio", "queued"],
    ],
    runOf: { kai: "q2", rio: "q3", theo: "w9" },
  };
  const fan = fanOutOf(receipt, queue);
  expect(fan).toMatchObject({ called: 5, answered: 1, working: 1, inLine: 3, failed: 0 });
  expect(fan?.agents).toEqual([
    { agentId: "ada", state: "answered", position: null },
    { agentId: "theo", state: "working", position: null },
    { agentId: "kai", state: "inLine", position: 2 },
    { agentId: "rio", state: "inLine", position: 3 },
    // Not started yet (paced): in line, place not known.
    { agentId: "nova", state: "inLine", position: null },
  ]);
  expect(fanOutText(en, fan as never)).toBe("5 agents called · 1 answered · 1 working · 3 in line");
  expect(fanOutText(pt, fan as never)).toBe("5 agentes chamados · 1 respondeu · 1 trabalhando · 3 na fila");
  expect(fan?.agents.map((a) => fanChipText(en, "en", a))).toEqual(["answered", "working", "2nd", "3rd", "in line"]);
  // One agent called is no fan-out.
  expect(fanOutOf({ routed: true, agents: [["ada", "handled"]], mentioned: ["ada"] })).toBeNull();
  // One that passed didn't answer: never "answered".
  const passed = fanOutOf({
    routed: true,
    byAgent: true,
    mentioned: ["ada", "kai"],
    agents: [
      ["ada", "passed"],
      ["kai", "claimed"],
    ],
  });
  expect(passed?.agents.map((a) => fanChipText(en, "en", a))).toEqual(["working", "didn't answer"]);
  expect(fanOutText(en, passed as never)).toBe("2 agents called · 1 working · 1 didn't answer");
});

test("the fan-out strip: under an agent's message, once two called agents started, while one works or waits", () => {
  const agent = { author: { type: "agent" } } as never;
  const person = { author: { type: "person" } } as never;
  const receipt = (phases: [string, "handled" | "claimed" | "picked"][], runOf: Record<string, string>) =>
    ({ routed: true, agents: phases, mentioned: phases.map(([id]) => id), runOf }) as MessageReceipt;
  const both = receipt(
    [
      ["ada", "handled"],
      ["rio", "claimed"],
    ],
    { ada: "r1", rio: "r2" },
  );
  expect(fanShows(agent, fanOutOf(both, queue), both)).toBe(true);
  expect(fanShows(person, fanOutOf(both, queue), both)).toBe(false);
  // One started: the receipt says it.
  const one = receipt(
    [
      ["ada", "claimed"],
      ["rio", "picked"],
    ],
    { ada: "r1" },
  );
  expect(fanShows(agent, fanOutOf(one, queue), one)).toBe(false);
  // All answered: each reply says it.
  const done = receipt(
    [
      ["ada", "handled"],
      ["rio", "handled"],
    ],
    { ada: "r1", rio: "r2" },
  );
  expect(fanShows(agent, fanOutOf(done, queue), done)).toBe(false);
});

test("a conversation shows one wait per run, from the receipts alone, leaving a fan-out to its strip", () => {
  const person = { type: "person", id: "u1" } as const;
  const none = () => false;
  const inLine = (runId: string, agentId = "ada"): MessageReceipt => ({
    routed: true,
    agents: [[agentId, "queued"]],
    runs: [runId],
    runOf: { [agentId]: runId },
  });
  const messages = [
    { id: "m1", author: person },
    { id: "m2", author: person },
    { id: "m3", author: person },
  ];
  // Two messages went into one run; a third started a run of its own.
  expect(conversationWaits(messages, { m1: inLine("r1"), m2: inLine("r1"), m3: inLine("r2", "kai") }, none)).toEqual([
    { agentId: "ada", runId: "r1" },
    { agentId: "kai", runId: "r2" },
  ]);
  // Started, or heard of with no run yet.
  expect(conversationWaits(messages, { m1: { ...inLine("r1"), agents: [["ada", "claimed"]] } }, none)).toEqual([]);
  expect(conversationWaits(messages, { m1: { routed: true, agents: [["ada", "queued"]] } }, none)).toEqual([
    { agentId: "ada", runId: null },
  ]);
  const fan: MessageReceipt = {
    routed: true,
    agents: [
      ["ada", "queued"],
      ["kai", "queued"],
    ],
    runOf: { ada: "r1", kai: "r2" },
  };
  expect(conversationWaits([{ id: "m1", author: { type: "agent", id: "rio" } }], { m1: fan }, none)).toEqual([]);
  // A live row says the run works: a receipt that missed it leaving the line is no second row.
  expect(conversationWaits(messages, { m1: inLine("r1"), m2: inLine("r1") }, (id) => id === "r1")).toEqual([]);
});

test("the status note of an agent waiting for its computer says that, never that it works", () => {
  const pt = tFor("pt-BR");
  expect(talkerStatusText(pt, { minutes: "11", steps: "0", wait: "queued" })).toBe(
    "Aguardando o computador (11 min). Leio sua mensagem quando chegar minha vez.",
  );
  expect(talkerStatusText(pt, { minutes: "0", steps: "0", wait: "away" })).toBe(
    "Aguardando meu computador voltar. Leio sua mensagem assim que ele voltar.",
  );
  expect(talkerStatusText(en, { minutes: "11", steps: "3" })).toBe(
    "I'm in the middle of a task (11 min) and can't answer yet. Your message is queued and I'll read it at my next step.",
  );
});

test("the status note of an agent parked on its plan or budget says that wait and when it is back", () => {
  const until = new Date(Date.now() + 2 * 24 * 3600_000).toISOString();
  const day = new Intl.DateTimeFormat("pt-BR", { weekday: "long" }).format(new Date(until)).replace(/-feira$/, "");
  const text = talkerStatusText(pt, { minutes: "0", steps: "0", wait: "plan", until }, "pt-BR");
  expect(text).toStartWith(`Estou esperando o plano voltar (${day} às `);
  expect(text).toEndWith("). Leio sua mensagem quando ele voltar.");
  expect(talkerStatusText(pt, { minutes: "0", steps: "0", wait: "plan" }, "pt-BR")).toBe(
    "Estou esperando o plano voltar. Leio sua mensagem assim que ele voltar.",
  );
  expect(talkerStatusText(en, { minutes: "0", steps: "0", wait: "budget" }, "en")).toBe(
    "I'm waiting for my monthly budget to renew. I'll read your message then, or sooner if an admin raises the limit.",
  );
});

test("a working agent's status note says when it really reads the message: its next step, or when its turn ends", () => {
  const pt = tFor("pt-BR");
  expect(talkerStatusText(pt, { minutes: "7", steps: "0", reads: "turn", kind: "browsing" })).toBe(
    "Estou no meio de uma tarefa (7 min) e ainda não consigo responder. Sua mensagem está na fila e eu leio quando esta rodada de trabalho terminar. Agora: navegando na web.",
  );
  expect(talkerStatusText(pt, { minutes: "7", steps: "0" })).toBe(
    "Estou no meio de uma tarefa (7 min) e ainda não consigo responder. Sua mensagem está na fila e eu leio no próximo passo.",
  );
});
