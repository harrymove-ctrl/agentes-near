import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import {
  channelCardFacts,
  channelOptions,
  channelQuery,
  channelRefsOf,
  insertChannelRef,
  resolveChannelRef,
  splitChannelRefs,
} from "../src/lib/channel-refs";

const eng = { id: "c-eng", name: "eng", isMember: true };
const general = { id: "c-gen", name: "general", isMember: true };
const vendas = { id: "c-ven", name: "vendas", isMember: false };

test("splits #names out of a text, keeping what was typed; never a#b, &#39; or ##", () => {
  expect(splitChannelRefs("veja #Eng.")).toEqual([{ text: "veja " }, { text: "#Eng", name: "eng" }, { text: "." }]);
  expect(splitChannelRefs("a#b &#39; ##dois")).toEqual([{ text: "a#b &#39; ##dois" }]);
  expect(splitChannelRefs("(#infra)")).toEqual([{ text: "(" }, { text: "#infra", name: "infra" }, { text: ")" }]);
  expect(splitChannelRefs("PR #2025, #42")).toEqual([{ text: "PR #2025, #42" }]);
  expect(splitChannelRefs("#2025-plan").map((p) => p.name)).toEqual(["2025-plan"]);
});

test("the stored channel wins over the current names; else by name, ignoring case; unknown is null", () => {
  expect(resolveChannelRef("engenharia", { engenharia: "c-eng" }, [eng])).toEqual({ id: "c-eng", known: eng });
  expect(resolveChannelRef("ENG", {}, [eng])).toEqual({ id: "c-eng", known: eng });
  expect(resolveChannelRef("antigo", { antigo: "c-old" }, [eng])).toEqual({ id: "c-old", known: null });
  expect(resolveChannelRef("nada", undefined, [eng])).toBeNull();
});

test("meta.channelRefs: only a map of strings, the same object each time", () => {
  const meta = { channelRefs: { eng: "c-eng" } };
  expect(channelRefsOf(meta)).toBe(meta.channelRefs);
  expect(channelRefsOf({ channelRefs: ["x"] })).toEqual({});
  expect(channelRefsOf({ channelRefs: { eng: 1 } })).toEqual({});
  expect(channelRefsOf(undefined)).toBe(channelRefsOf({}));
});

test("the # picker: query at the caret, names starting with it first, then mine; insert #name + space", () => {
  expect(channelQuery("veja #en", 8)).toEqual({ start: 5, query: "en" });
  expect(channelQuery("a#b", 3)).toBeNull();
  expect(channelOptions("en", [vendas, general, eng]).map((c) => c.name)).toEqual(["eng", "general", "vendas"]);
  expect(channelOptions("", [vendas, general, eng]).map((c) => c.name)).toEqual(["eng", "general", "vendas"]);
  expect(channelOptions("20", [{ id: "c-y", name: "2025", isMember: true }, vendas])).toEqual([]);
  expect(channelOptions("ven", [vendas, general, eng]).map((c) => c.name)).toEqual(["vendas"]);
  expect(insertChannelRef("veja #en agora", { start: 5, query: "en" }, "eng")).toEqual({
    text: "veja #eng agora",
    caret: 10,
  });
});

test("one rule for the composers, the renderer and the server", async () => {
  // The UI kit's composer and the engine read the same module through `@agenteschat/ui/channel-refs`.
  const shared = await import("@agenteschat/tokens/channel-refs");
  const lib = await import("../src/lib/channel-refs");
  expect(lib.CHANNEL_REF).toBe(shared.CHANNEL_REF);
  expect([lib.channelQuery, lib.insertChannelRef]).toEqual([shared.channelQuery, shared.insertChannelRef]);
});

test("a channel card's facts: people, agents, and whether I'm in it (web card and phone sheet)", () => {
  const t = ((key: string, v?: { count?: number }) => (v ? `${key}=${v.count}` : key)) as unknown as TFunction;
  expect(channelCardFacts(t, { people: 2, agents: 1, isMember: false })).toBe(
    "channelRefs.people=2 · channelRefs.agents=1 · channelRefs.notMember",
  );
});
