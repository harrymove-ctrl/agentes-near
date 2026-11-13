import { describe, expect, test } from "bun:test";
import type { LiveRun, SecretRequest } from "@agenteschat/client";
import { firstChange } from "@agenteschat/client/lib/proposals";
import {
  APPROVAL_TTL_MS,
  AskStore,
  approvalMayWait,
  askEndedAt,
  cardShows,
  lastDecidedAt,
  MAX_TIMER_MS,
  type Measurable,
  mayAsk,
  type PendingAsk,
  SHOWN_MIN_PX,
  secretRequestOf,
  timerDelay,
} from "../../src/features/chat/ask-store";
import { lineStops, workingEntries } from "../../src/features/chat/logic";

const ask = (id: string, order: number, over: Partial<PendingAsk> = {}): PendingAsk => ({
  id,
  kind: "approval",
  agentId: "dev",
  what: `Enviar o relatório ${id}`,
  messageId: `m-${id}`,
  order,
  ...over,
});

const card = (): Measurable => ({ measureInWindow: () => {} });

describe("the requests waiting in a conversation", () => {
  test("nothing is out of view until the screen has looked once, so the line never flashes on open", () => {
    const store = new AskStore();
    store.put(ask("a", 3));
    expect(store.getAway()).toBeNull();
    store.setHidden(["a"]);
    expect(store.getAway()).toEqual({ ask: ask("a", 3), more: 0 });
  });

  test("a request the screen hasn't looked at yet counts as in view", () => {
    const store = new AskStore();
    store.setHidden([]);
    store.put(ask("a", 1));
    expect(store.getAway()).toBeNull();
  });

  test("the first out of view in the conversation's order, and how many more", () => {
    const store = new AskStore();
    store.put(ask("late", 9));
    store.put(ask("early", 2));
    store.put(ask("seen", 5));
    store.setHidden(["late", "early"]);
    expect(store.getAway()?.ask.id).toBe("early");
    expect(store.getAway()?.more).toBe(1);
  });

  test("out of view, back in view, out again", () => {
    const store = new AskStore();
    store.put(ask("a", 1));
    store.put(ask("b", 2));
    store.setHidden(["a", "b"]);
    expect(store.getAway()).toEqual({ ask: ask("a", 1), more: 1 });
    store.setHidden(["b"]);
    expect(store.getAway()).toEqual({ ask: ask("b", 2), more: 0 });
    store.setHidden([]);
    expect(store.getAway()).toBeNull();
    store.setHidden(["a"]);
    expect(store.getAway()?.ask.id).toBe("a");
  });

  test("a request that stops waiting leaves the line, and the next one takes it", () => {
    const store = new AskStore();
    store.put(ask("a", 1));
    store.put(ask("b", 2));
    store.setHidden(["a", "b"]);
    store.drop("a");
    expect(store.getAway()).toEqual({ ask: ask("b", 2), more: 0 });
  });

  test("answered here: gone at once, and a late report can't bring it back", () => {
    const store = new AskStore();
    store.put(ask("a", 1));
    store.setHidden(["a"]);
    store.settle("a");
    expect(store.getAway()).toBeNull();
    expect(store.hasWaiting()).toBe(false);
    store.put(ask("a", 1));
    expect(store.hasWaiting()).toBe(false);
    expect(store.getAway()).toBeNull();
  });

  test("the line hears only when what it shows changes", () => {
    const store = new AskStore();
    let heard = 0;
    const off = store.subscribe(() => {
      heard += 1;
    });
    store.put(ask("a", 1));
    expect(heard).toBe(0);
    store.setHidden(["a"]);
    expect(heard).toBe(1);
    store.setHidden(["a"]);
    store.put(ask("a", 1));
    store.put(ask("b", 4));
    expect(heard).toBe(1);
    store.setHidden(["a", "b"]);
    expect(heard).toBe(2);
    store.put(ask("a", 1, { what: "Enviar o relatório de outubro" }));
    expect(heard).toBe(3);
    off();
    store.setHidden([]);
    expect(heard).toBe(3);
  });

  test("the screen is asked to look when a request comes, or its card is drawn or goes", () => {
    const store = new AskStore();
    let looks = 0;
    store.watch(() => {
      looks += 1;
    });
    store.put(ask("a", 1));
    expect(looks).toBe(1);
    store.put(ask("a", 1));
    expect(looks).toBe(1);
    const drawn = card();
    const gone = store.register("a", drawn);
    expect(store.cardOf("a")).toBe(drawn);
    expect(looks).toBe(2);
    gone();
    expect(store.cardOf("a")).toBeUndefined();
    expect(looks).toBe(3);
  });

  test("a card drawn again keeps its place when the old one leaves after it", () => {
    const store = new AskStore();
    const old = card();
    const fresh = card();
    const oldGone = store.register("a", old);
    store.register("a", fresh);
    oldGone();
    expect(store.cardOf("a")).toBe(fresh);
  });
});

describe("whether a card shows", () => {
  const band = { top: 100, bottom: 700 };

  test(`${SHOWN_MIN_PX} points between the header and the composer is on screen`, () => {
    expect(cardShows(660, 200, band)).toBe(true);
    expect(cardShows(661, 200, band)).toBe(false);
    expect(cardShows(-100, 240, band)).toBe(true);
    expect(cardShows(-100, 239, band)).toBe(false);
    expect(cardShows(300, 200, band)).toBe(true);
  });

  test("under the floating header or behind the composer is out of view", () => {
    expect(cardShows(0, 80, band)).toBe(false);
    expect(cardShows(720, 300, band)).toBe(false);
  });

  test("a smaller card shows when all of it does; one not laid out yet counts as shown", () => {
    expect(cardShows(300, 30, band)).toBe(true);
    expect(cardShows(690, 30, band)).toBe(false);
    expect(cardShows(5000, 0, band)).toBe(true);
  });
});

describe("which messages may ask something", () => {
  const agent = { type: "agent" as const, id: "dev" };

  test("an agent's message with a request's key", () => {
    expect(mayAsk({ author: agent, meta: { approvalId: "a1" } })).toBe(true);
    expect(mayAsk({ author: agent, meta: { secretRequest: { id: "s1" } } })).toBe(true);
    expect(mayAsk({ author: agent, meta: { proposalId: "p1" } })).toBe(true);
  });

  test("no such key, or a person's message", () => {
    expect(mayAsk({ author: agent, meta: { consulted: [] } })).toBe(false);
    expect(mayAsk({ author: agent })).toBe(false);
    expect(mayAsk({ author: { type: "person", id: "u1" }, meta: { approvalId: "a1" } })).toBe(false);
  });
});

describe("a secret request in a message", () => {
  const request: SecretRequest = {
    id: "s1",
    agentId: "dev",
    channelId: "c1",
    threadId: null,
    messageId: "m1",
    requestedForUserId: "u1",
    name: "API_TOKEN",
    purpose: "Para publicar o pacote da Acme",
    target: { kind: "env" },
    site: null,
    machineId: "mac1",
    publicKey: "key",
    status: "pending",
    expiresAt: "2026-10-31T12:10:00.000Z",
    deliveredAt: null,
    removed: false,
  };

  test("is read when it is one", () => {
    expect(secretRequestOf({ secretRequest: request })).toEqual(request);
  });

  test("anything else is none", () => {
    expect(secretRequestOf(undefined)).toBeNull();
    expect(secretRequestOf({})).toBeNull();
    expect(secretRequestOf({ secretRequest: "s1" })).toBeNull();
    expect(secretRequestOf({ secretRequest: { ...request, id: 1 } })).toBeNull();
    expect(secretRequestOf({ secretRequest: { ...request, status: undefined } })).toBeNull();
    expect(secretRequestOf({ secretRequest: { ...request, target: null } })).toBeNull();
  });
});

describe("an approval's age", () => {
  const now = Date.parse("2026-10-31T12:00:00.000Z");

  test("one asked less than a day ago may still wait", () => {
    expect(approvalMayWait("2026-10-30T12:00:01.000Z", now)).toBe(true);
  });

  test("one asked a day ago or more has expired, so it isn't asked for", () => {
    expect(APPROVAL_TTL_MS).toBe(24 * 3600_000);
    expect(approvalMayWait("2026-10-30T12:00:00.000Z", now)).toBe(false);
    expect(approvalMayWait("2026-10-01T09:00:00.000Z", now)).toBe(false);
  });

  test("a time it can't read never hides a request", () => {
    expect(approvalMayWait("not a date", now)).toBe(true);
  });
});

describe("a timer to an expiry", () => {
  test("waits the time left, never less than nothing", () => {
    expect(timerDelay(1_000, 400)).toBe(600);
    expect(timerDelay(1_000, 5_000)).toBe(0);
  });

  test("a far expiry is waited for in steps a timer can take", () => {
    expect(timerDelay(40 * 86_400_000, 0)).toBe(MAX_TIMER_MS);
  });
});

describe("the line's stop while it shows a request", () => {
  const run = (over: Partial<LiveRun> & { runId: string; agentId: string }): LiveRun => ({
    channelId: "c1",
    threadId: "m1",
    status: "running",
    ...over,
  });
  const name = (id: string) => id;

  test("one agent at work: the runs of it I may stop (not a guess)", () => {
    const runs = [run({ runId: "p", agentId: "dev", provisional: true }), run({ runId: "r1", agentId: "dev" })];
    const entries = workingEntries(runs, [], name);
    expect(lineStops(entries, runs, () => true).map((r) => r.runId)).toEqual(["r1"]);
    expect(lineStops(entries, runs, () => false)).toEqual([]);
  });

  test("several agents: the line can't say whose, so the box's own stop is the one", () => {
    const runs = [run({ runId: "r1", agentId: "dev" }), run({ runId: "r2", agentId: "infra" })];
    expect(lineStops(workingEntries(runs, [], name), runs, () => true)).toEqual([]);
  });
});

describe("when a decided request ended", () => {
  const expiresAt = "2026-11-02T14:00:00.000Z";

  test("when someone decided it, or the deadline of one that ran out; a canceled one has no time", () => {
    const decidedAt = "2026-11-01T14:02:00.000Z";
    expect(askEndedAt({ status: "refused", decidedAt, expiresAt })).toBe(decidedAt);
    expect(askEndedAt({ status: "expired", decidedAt: null, expiresAt })).toBe(expiresAt);
    expect(askEndedAt({ status: "canceled", decidedAt: null, expiresAt })).toBeNull();
  });

  test("a card of proposals closes with its last decision, whatever the rows' order", () => {
    const first = { decidedAt: "2026-11-01T14:02:00.000Z" };
    const last = { decidedAt: "2026-11-01T14:09:00.000Z" };
    expect(lastDecidedAt([last, { decidedAt: null }, first])).toBe(last.decidedAt);
    expect(lastDecidedAt([first, last])).toBe(last.decidedAt);
  });

  test("a card whose rows only went stale has no time", () => {
    expect(lastDecidedAt([{ decidedAt: null }, { decidedAt: null }])).toBeNull();
    expect(lastDecidedAt([])).toBeNull();
  });
});

describe("a proposal's short form", () => {
  test("the first line it adds, past a heading; what it removes when it adds nothing", () => {
    const add = (text: string) => ({ kind: "add" as const, text });
    const del = { kind: "del" as const, text: "Responder em inglês." };
    expect(firstChange([del, add("## Aprendido"), add("- Responder em português.")])?.text).toBe(
      "Responder em português.",
    );
    expect(firstChange([add("## Aprendido")])?.text).toBe("## Aprendido");
    expect(firstChange([del])?.text).toBe("Responder em inglês.");
    expect(firstChange(undefined)).toBeUndefined();
  });
});
