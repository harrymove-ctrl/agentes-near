import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({
    reply: (req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: [] };
      if (last.includes("valeu")) return { chunks: [], toolUses: [{ name: "react", input: { emoji: "🙌" } }] };
      return { chunks: ["pronto"] };
    },
  });
});
afterEach(() => t.close());

test("an agent reacts to a thanks instead of replying: no message, its reaction in the list and the reactions API", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const thanks = (await (await api(`/channels/${channelId}/messages`, { json: { body: "@dev valeu" } })).json()) as {
    id: string;
  };
  await t.drain();

  type Msg = {
    id: string;
    author: { type: string };
    reactions?: { reaction: string; count: number; userIds: string[]; agentIds: string[] }[];
  };
  // Asked in the channel: a reply would be in the main timeline; there is none.
  const timeline = (await (await api(`/channels/${channelId}/messages`)).json()) as {
    messages: Msg[];
  };
  expect(timeline.messages.filter((m) => m.author.type === "agent")).toEqual([]);
  const reactions = timeline.messages.find((m) => m.id === thanks.id)?.reactions;
  expect(reactions).toHaveLength(1);
  expect(reactions?.[0]).toMatchObject({ reaction: "🙌", count: 1, userIds: [] });
  expect(reactions?.[0]?.agentIds).toHaveLength(1);

  const listed = (await (await api(`/messages/${thanks.id}/reactions`)).json()) as { reactions: Msg["reactions"] };
  expect(listed.reactions).toEqual(reactions);
});
