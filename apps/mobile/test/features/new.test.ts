import { describe, expect, test } from "bun:test";
import type { DirectMessage } from "@agenteschat/client";
import { buildConversations } from "../../src/features/chats/logic";
import { AGENT_NAMES, askTargets, chatMatches, createItems, suggestAgentName } from "../../src/features/new/logic";
import { agent, at } from "./fixtures";

const dm = (channelId: string, who: { type: "agent" | "person"; id: string }, minutesAgo: number | null) =>
  ({
    channelId,
    with: { ...who, name: who.id, handle: who.id },
    lastMessage:
      minutesAgo === null
        ? null
        : { id: `m-${channelId}`, body: "oi", createdAt: at(minutesAgo), authorType: "person" },
    unread: 0,
  }) satisfies DirectMessage;

const rows = (dms: DirectMessage[]) => buildConversations({ channels: [], dms, threads: [] });

describe("New: the agents in its row", () => {
  const theo = agent({ id: "theo", name: "Theo" });
  const nina = agent({ id: "nina", name: "Nina" });
  const ada = agent({ id: "ada", name: "Ada" });
  const iris = agent({ id: "iris", name: "Iris" });

  test("the agent you talked to last comes first, then by recency, then the rest by name", () => {
    const list = askTargets(
      [theo, nina, ada, iris],
      rows([
        dm("d1", { type: "agent", id: "nina" }, 120),
        dm("d2", { type: "agent", id: "theo" }, 5),
        dm("d3", { type: "person", id: "theo" }, 1),
        dm("d4", { type: "agent", id: "iris" }, null),
      ]),
    );
    expect(list.map((a) => a.id)).toEqual(["theo", "nina", "ada", "iris"]);
  });

  test("agents that don't talk to you are left out; nobody talked to means by name", () => {
    const list = askTargets([theo, { ...nina, canTalk: false }, ada], []);
    expect(list.map((a) => a.id)).toEqual(["ada", "theo"]);
  });
});

describe("New: the search for a person or an agent", () => {
  const theo = agent({ id: "theo", name: "Theo", role: "Vendas" });
  const ada = agent({ id: "ada", name: "Ada", role: "Dev", handle: "ada-dev" });
  const quiet = agent({ id: "quiet", name: "Bia", canTalk: false });
  const people = [
    { userId: "me", name: "Ana Lima" },
    { userId: "u2", name: "Carla Souza" },
    { userId: "u3", name: "Bruno Reis" },
  ];

  test("no words: every agent that talks to you and every other person, each by name", () => {
    const found = chatMatches("", [theo, quiet, ada], people, "me");
    expect(found.agents.map((a) => a.id)).toEqual(["ada", "theo"]);
    expect(found.people.map((p) => p.userId)).toEqual(["u3", "u2"]);
  });

  test("agents match by name, role or handle; people by name, ignoring case and accents", () => {
    expect(chatMatches("vendas", [theo, ada], people, "me").agents.map((a) => a.id)).toEqual(["theo"]);
    expect(chatMatches("ADA-D", [theo, ada], people, "me").agents.map((a) => a.id)).toEqual(["ada"]);
    expect(chatMatches("sóuza", [theo, ada], people, "me").people.map((p) => p.userId)).toEqual(["u2"]);
    expect(chatMatches("lima", [theo, ada], people, "me").people).toEqual([]);
  });
});

describe("New: what its Create list offers", () => {
  const all = ["create_agents", "create_channels", "post", "manage_routines", "edit_wiki", "invite_people"] as const;

  test("everything, in order, for who may do it all", () => {
    expect(createItems({ permissions: all }, { ownsAgent: false })).toEqual([
      "agent",
      "channel",
      "task",
      "routine",
      "wiki",
      "invite",
    ]);
  });

  test("nothing without its permission (a conversation starts from the search, not from this list)", () => {
    expect(createItems({ permissions: [] }, { ownsAgent: false })).toEqual([]);
    expect(createItems(null, { ownsAgent: false })).toEqual([]);
  });

  test("a routine also for the owner of an agent", () => {
    expect(createItems({ permissions: ["post"] }, { ownsAgent: true })).toEqual(["task", "routine"]);
  });

  test("no new agent in a workspace being deleted, as on the web", () => {
    const deletion = { dueAt: null, requestedAt: null, requestedBy: null };
    expect(createItems({ permissions: all, deletion }, { ownsAgent: false })).not.toContain("agent");
  });
});

describe("New agent: the suggested name", () => {
  test("the first name nobody uses, ignoring case and accents", () => {
    expect(suggestAgentName([])).toBe(AGENT_NAMES[0]);
    expect(suggestAgentName(["lu", "NÍNA"])).toBe("Theo");
  });

  test("all taken: the first name with a number", () => {
    expect(suggestAgentName(["Lu", "Ana"], ["Lu", "Ana"])).toBe("Lu 2");
    expect(suggestAgentName(["Lu", "Lu 2"], ["Lu"])).toBe("Lu 3");
  });
});
