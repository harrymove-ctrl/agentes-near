import { afterEach, expect, test } from "bun:test";
import { brainSessionId, drainOutbox, postPersonMessage } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

test("an agent's calls carry its conversation's session: the same in one conversation, another in the next", async () => {
  f = await setup();
  const say = async (channelId: string, body: string) => {
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, { body });
    await drainOutbox(f.db, f.handlers);
  };
  await say(f.general.id, "@dev oi");
  await say(f.general.id, "@dev e agora?");
  // The agent's own turns (calls made for the workspace, a summary or the router, belong to no conversation).
  const sessions = f.provider.calls.flatMap((c) => (c.session ? [c.session] : []));
  expect(sessions.length).toBeGreaterThanOrEqual(2);
  expect(new Set(sessions)).toEqual(new Set([brainSessionId(f.agent.id, f.general.id, "model")]));
  // Another agent's, in the same conversation, is its own: never a secret, only the agent and where it talks.
  expect(brainSessionId("another-agent", f.general.id, "model")).not.toBe(sessions[0]);
  expect(sessions[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
