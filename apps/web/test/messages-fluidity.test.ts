import { describe, expect, test } from "bun:test";
import type { ChannelEvent, Message } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import type { TimelineItem } from "@agenteschat/client/lib/timeline";
import type { TFunction } from "i18next";
import { failedOffline } from "@/chat/offline";
import { dividerIsFar, earlierKey, firstNewKey, landedKey, pillParts, unseenOf } from "@/chat/unseen";
import { createI18n } from "@/i18n";
import { createStreamsStore } from "@/realtime/context";

const i18n = createI18n("pt-BR");
const t = i18n.t.bind(i18n) as TFunction;

const msg = (id: string, author: Message["author"], body = ""): TimelineItem => ({
  kind: "message",
  key: id,
  grouped: false,
  message: {
    id,
    channelId: "c",
    threadId: null,
    author,
    body,
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date(0).toISOString(),
  } as Message,
});
const me = { type: "person" as const, id: "u-me" };
const marina = { type: "person" as const, id: "u-marina" };
const ada = { type: "agent" as const, id: "ada" };

describe("the round button's count and the 'Novas' divider", () => {
  const items = [msg("a", me), msg("b", marina), msg("c", ada), msg("d", me), msg("e", marina)];

  test("the divider goes before the first row after the one that was last", () => {
    expect(firstNewKey(items, "b")).toBe("c");
    expect(firstNewKey(items, "e")).toBeNull();
    expect(firstNewKey(items, undefined)).toBeNull();
  });

  test("from the divider on: how many others wrote, and who, in order (my own don't count)", () => {
    expect(unseenOf(items, "b", "u-me")).toEqual({ count: 3, authors: [marina, ada], mentionsMe: false });
    expect(unseenOf(items, null, "u-me")).toEqual({ count: 0, authors: [], mentionsMe: false });
  });

  test("a new message by someone else that @mentions me turns the count red; my own never does", () => {
    const said = [msg("a", marina), msg("b", me, "@Helena olha"), msg("c", ada, "pronto @helena")];
    expect(unseenOf(said, "b", "u-me", "helena").mentionsMe).toBe(true);
    expect(unseenOf(said.slice(0, 2), "b", "u-me", "helena").mentionsMe).toBe(false);
    expect(unseenOf(said, "b", "u-me").mentionsMe).toBe(false);
  });

  test("'2 novas · Marina e Ada · Theo escrevendo'; more than two names", () => {
    expect(pillParts(t, 2, ["Marina", "Ada"], ["Theo"])).toEqual(["2 novas", "Marina e Ada", "Theo escrevendo"]);
    expect(pillParts(t, 1, ["Marina"], [])).toEqual(["1 nova", "Marina"]);
    expect(pillParts(t, 4, ["Marina", "Ada", "João", "Ana"], [])).toEqual(["4 novas", "Marina, Ada e mais 2"]);
    expect(pillParts(t, 0, [], ["Theo"])).toEqual(["Theo escrevendo"]);
    expect(pillParts(t, 1, ["Ada"], [], true)).toEqual(["1 nova", "Ada", "mencionaram você"]);
  });

  test("a reply that took its block's place above newer rows is where the divider goes; its run's older message isn't", () => {
    const shown = new Set(["a", "card", "b"]);
    const items = [msg("a", marina), msg("card", ada), msg("reply", ada), msg("b", marina)];
    expect(landedKey(items, new Map([["r1", "reply"]]), new Set(["r1"]), shown)).toBe("reply");
    expect(earlierKey(items, "b", "reply")).toBe("reply");
    expect(earlierKey(items, null, "reply")).toBe("reply");
    // Its run ended with nothing more to say: its last message is the card it posted before, read already.
    const ended = [msg("a", marina), msg("card", ada), msg("b", marina)];
    expect(landedKey(ended, new Map([["r1", "card"]]), new Set(["r1"]), shown)).toBeNull();
  });

  test("the pill lands on the divider only when it is more than 1.2 screens from the end", () => {
    expect(dividerIsFar(100, 2000, 500)).toBe(true);
    expect(dividerIsFar(1600, 2000, 500)).toBe(false);
  });
});

describe("sent while offline", () => {
  test("a network failure waits for the connection; a refusal by the server does not", () => {
    expect(failedOffline(new TypeError("Failed to fetch"))).toBe(true);
    expect(failedOffline(new ApiError(503, "unavailable", "Try again"))).toBe(false);
    // Any other error (a bug, a parse failure) is not the network: it fails, it does not wait.
    expect(failedOffline(new Error("boom"))).toBe(false);
    expect(failedOffline(new SyntaxError("Unexpected token"))).toBe(false);
  });
});

describe("'Continuar' refused: the reason in the person's language", () => {
  test("not continuable, the agent busy, not allowed", () => {
    expect(errorText(t, new ApiError(409, "run.not_continuable", "This task can't be continued"))).toBe(
      "Esta resposta não pode mais ser continuada.",
    );
    expect(errorText(t, new ApiError(409, "run.agent_busy", "busy"))).toContain("já está trabalhando");
    expect(errorText(t, new ApiError(403, "run.continue_forbidden", "no"))).toContain("dono do agente");
    const en = createI18n("en");
    expect(errorText(en.t.bind(en) as TFunction, new ApiError(409, "run.agent_busy", "busy"))).toContain(
      "already working",
    );
  });
});

describe("'Continuar' in the live store", () => {
  test("our own continue and someone else's (run.continued) hide the button", () => {
    const store = createStreamsStore();
    store.continued("r1", "r2");
    expect(store.get().continued.r1).toBe("r2");
    store.apply({
      type: "run.continued",
      channelId: "c",
      threadId: null,
      runId: "r3",
      newRunId: "r4",
      messageId: "m3",
    } as unknown as ChannelEvent);
    expect(store.get().continued.r3).toBe("r4");
  });
});
