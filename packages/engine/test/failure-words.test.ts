import { afterEach, expect, test } from "bun:test";
import type { ModelRequest } from "@agenteschat/providers";
import { drainOutbox, postPersonMessage } from "../src";
import { CAPABILITIES_LIMIT, COMPUTER_TOOLS_NOTE } from "../src/capabilities";
import { HOW_YOU_WORK } from "../src/context";
import { RIGHT_HAND_TOOLS } from "../src/right-hand-prompt";
import { type Fixture, setup } from "./fixtures";

/** Words that send people to a support team: there is none, so no prompt may point to one. */
const SUPPORT = /\b(support|suporte|help ?desk)\b/i;

let f: Fixture | undefined;
afterEach(async () => {
  const current = f;
  f = undefined;
  await current?.close();
});

const systemOf = (request: ModelRequest) =>
  typeof request.system === "string" ? request.system : request.system.map((b) => b.text).join("\n");

test("an agent is told to say what failed and what to do, and never sent to support", async () => {
  const w = await setup({ toolsOnDemand: true, contextTools: true, reply: () => ({ chunks: ["ok"] }) });
  f = w;
  await postPersonMessage({ db: w.db, pubsub: w.pubsub }, w.owner.id, w.org.id, w.general.id, { body: "@dev oi" });
  await drainOutbox(w.db, w.handlers);
  const [request] = w.provider.calls.map((c) => c.request);
  if (!request) throw new Error("no call");
  const system = systemOf(request);
  expect(system).toContain("When a tool or the platform fails, say plainly what failed and what the person can do");
  expect(system).toContain("never paste a raw error or send anyone to support.");
  // The rule is the only mention of support, and it forbids it.
  expect(system.replace("send anyone to support", "")).not.toMatch(SUPPORT);
  for (const line of [
    HOW_YOU_WORK.replace("send anyone to support", ""),
    CAPABILITIES_LIMIT,
    COMPUTER_TOOLS_NOTE,
    RIGHT_HAND_TOOLS,
  ])
    expect(line).not.toMatch(SUPPORT);
});
