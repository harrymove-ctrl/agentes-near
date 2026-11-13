import { afterEach, expect, test } from "bun:test";
import { laidOut, type ModelRequest } from "@agenteschat/providers";
import { drainOutbox, grantScopes, postPersonMessage } from "../src";
import { type Fixture, setup } from "./fixtures";

/**
 * The words an API-brain run sends, pinned: the prompt cache (ordering, breakpoints, TTL) must never change them.
 * Tools compare by name (their order is the cache's), system blocks and messages as sent. Ids and times are masked.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const mask = (text: string) =>
  text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<iso>")
    // No \b before the weekday: after a line break the JSON text reads `\nMon`, with no word boundary.
    .replace(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2}/g, "<now>");

/** What the model reads from a request: the system text, the messages and the tools, without cache metadata. */
function words(asked: ModelRequest) {
  // As the adapters send it: the per-turn notes after the trigger's text (token-trim B8).
  const request = laidOut(asked);
  const system =
    typeof request.system === "string" ? request.system : request.system.map((b: { text: string }) => b.text);
  const tools = [...(request.tools ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  return JSON.parse(mask(JSON.stringify({ system, messages: request.messages, tools })));
}

test("an API-brain run's words: the same system text, messages and tools as before the prompt cache", async () => {
  f = await setup({ toolsOnDemand: true, issueTools: true, contextTools: true, reply: () => ({ chunks: ["ok"] }) });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:read" }]);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  await drainOutbox(f.db, f.handlers);
  const [request] = f.provider.calls.map((c) => c.request);
  if (!request) throw new Error("no call");
  expect(words(request)).toMatchSnapshot();
});
