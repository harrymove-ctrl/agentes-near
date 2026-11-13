import { afterEach, expect, test } from "bun:test";
import { createAnthropicProvider, type ModelRequest, systemText } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import { AUTONOMY_PHRASES, placeOf, type ScriptedTurn, TURNS, type TurnsWorld, turnsWorld } from "../eval/turns";
import { drainOutbox, postPersonMessage } from "../src";

/**
 * The token-trim eval on the fake provider (no model, no network): for each scripted turn the agent is still offered
 * what it needs (listed, or found with one `find_tools` search), on its first request and after a tool result, and
 * the prompt still holds every autonomy rule word for word. Plus the size of a DM "oi" and the cached start of the
 * tool list. The same turns against a real model: `bun run eval:turns` (eval/README.md).
 */

let w: TurnsWorld | undefined;
afterEach(async () => {
  const current = w;
  w = undefined;
  await current?.close();
});

const isAgentCall = (r: ModelRequest) => (r.tools?.length ?? 0) > 0 && systemText(r.system).includes("(@dev)");
const names = (r: ModelRequest) => new Set((r.tools ?? []).map((t) => t.name));
const results = (r: ModelRequest) =>
  r.messages
    .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
    .flatMap((b) => (b.type === "tool_result" ? [b.content] : []))
    .join("\n");

/** The fake model: the turn's first move, one `find_tools` per tool it must reach and doesn't list, then "ok". */
function scripted(turn: ScriptedTurn) {
  let queue: FakeReply[] | null = null;
  return (request: ModelRequest): FakeReply => {
    if (!isAgentCall(request)) return { chunks: ["{}"] };
    if (!queue) {
      const listed = names(request);
      const show = request.tools?.find((t) => t.name === "show_block");
      queue = [
        ...(turn.first ? [turn.first] : []),
        ...(turn.reachable ?? [])
          .filter((r) => !listed.has(r.tool))
          .map((r) => ({ chunks: [], toolUses: [{ name: "find_tools", input: { query: r.query } }] })),
        // The blocks' manual: in show_block's description, or what a call without html answers.
        ...(show && !show.description.includes("<ac-slider")
          ? [{ chunks: [], toolUses: [{ name: "show_block", input: { title: "Planos" } }] }]
          : []),
      ];
    }
    return queue.shift() ?? { chunks: ["ok"] };
  };
}

async function play(turn: ScriptedTurn, workspaceComputer?: { billing: boolean }) {
  const reply = scripted(turn);
  const world = await turnsWorld({ reply: (r) => reply(r), workspaceComputer });
  w = world;
  const { channelId, body } = placeOf(world, turn);
  await postPersonMessage({ db: world.db, pubsub: world.pubsub }, world.owner.id, world.org.id, channelId, { body });
  await drainOutbox(world.db, world.handlers);
  return world.provider.calls.map((c) => c.request).filter(isAgentCall);
}

for (const turn of TURNS) {
  test(`${turn.title}: offered what it needs, every autonomy rule word for word`, async () => {
    const requests = await play(turn);
    expect(requests.length).toBeGreaterThan(0);
    if (turn.first) expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      const listed = names(request);
      for (const tool of turn.listed) expect(listed.has(tool), `${turn.id}: ${tool} listed`).toBe(true);
      const system = systemText(request.system);
      for (const phrase of AUTONOMY_PHRASES) expect(system, `${turn.id}: autonomy rule`).toContain(phrase);
    }
    const last = requests.at(-1) as ModelRequest;
    for (const { tool } of turn.reachable ?? []) {
      const found = names(last).has(tool) || results(last).includes(tool);
      expect(found, `${turn.id}: ${tool} reachable in one search`).toBe(true);
    }
    if (turn.id === "approval") expect(results(last)).toContain("deploy_service (asks a person's approval");
    if (turn.id === "block") {
      const show = last.tools?.find((t) => t.name === "show_block");
      expect(show?.description).toContain("Use it on your own whenever using something beats reading about it");
      expect(`${show?.description}\n${results(last)}`).toContain('"type":"slider"');
    }
  }, 60_000);
}

/** Characters of the system prompt and the tools' definitions as sent. */
const size = (r: ModelRequest) =>
  systemText(r.system).length +
  JSON.stringify(
    (r.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
  ).length;

/**
 * A DM "oi" with every production tool source: 51,124 characters before the token trim (B1–B11), 37,694 after, 40,756
 * with `ask_choices`, `request_approval` and the plain-words line that came next, 44,076 with the rule that a step
 * needing the person is handed over, never a blocker (ADR 0097 addendum), 44,466 with skills that update from their
 * links (`offer_install_skill` and `update_skill_from_source` load on demand), 44,789 with the right hand's cards named in
 * the setup group's label (ADR 0137 §4), 44,982 with the plain-words rule that leads with what the person must do and
 * `set_reply_style` named in the rarer tools' label (ADR 0147), 44,969 with `react` reaching an older message by its
 * author and a key used before an app connection, once two rules stopped repeating each other, 44,966 with rules people
 * gave (`remember` kind rule, ADR 0120), the private card for passwords and codes and @todos, once two more rules
 * stopped repeating others, and 45,669 with a send to someone else settled from the conversation before it goes
 * (no assumption on what can't be undone), nothing offered or promised beyond the list and files on `send_dm`, 45,475
 * with `request_permission` down to one reason (`why`) and the task board on by default, 45,803 with `ask_user`'s
 * `person` and the rule that what is said in a DM stays there, 45,216 with the `ask_user` rule leaving to its
 * description what that says already, 45,437 with each choice question's written answer (`ask_choices`, its
 * other words tightened for it), 45,482 with feedback named in the rarer tools' label (ADR 0160 §11), about 46,450
 * with an approval asked by the action itself, a question answered directly, numbers computed with code, a chart for
 * compared numbers, earlier messages linked, mentions only to ask, an ok answered by a reaction alone and a question
 * card's question never written twice (ADR 0089 addendum 2026-11-10), and about 46,770 with team memory (`remember`'s
 * `for: "team"`) and a result claimed only when a call made it (ADR 0167), and about 46,970 with an agent asking for
 * its own settings on its card (`request_settings_change` named, its definition on demand: up front it would add 3,800,
 * ADR 0137). Where each workspace gets its own computer, `workspaceComputerText` adds 447 to that (about 47,410); the
 * ceiling leaves a little room above both.
 */
const OI_CEILING_CHARS = 47_500;

test("a DM 'oi' stays under the size ceiling", async () => {
  const [request] = await play(TURNS.find((t) => t.id === "greet-dm") as ScriptedTurn);
  if (!request) throw new Error("no call");
  const chars = size(request);
  console.log(`DM 'oi': ${chars} chars (system ${systemText(request.system).length}, ${request.tools?.length} tools)`);
  expect(chars).toBeLessThan(OI_CEILING_CHARS);
}, 60_000);

test("a DM 'oi' on the Cloud, with what it says about the workspace's computer, stays under it too", async () => {
  const [request] = await play(TURNS.find((t) => t.id === "greet-dm") as ScriptedTurn, { billing: true });
  if (!request) throw new Error("no call");
  expect(systemText(request.system)).toContain("# The computer");
  console.log(`DM 'oi' on the Cloud: ${size(request)} chars`);
  expect(size(request)).toBeLessThan(OI_CEILING_CHARS);
}, 60_000);

/** The Anthropic request body a captured request becomes (the transport refuses after reading it: no network). */
async function anthropicBody(request: ModelRequest): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    throw new Error("captured");
  }) as unknown as typeof fetch;
  await createAnthropicProvider({ fetch: fetcher, maxRetries: 0 })
    .stream(request, { apiKey: "k", onDelta: () => {} })
    .catch(() => {});
  return body;
}

test("two runs with different tool groups send the same bytes up to the core tools' cache point", async () => {
  let issues = 0;
  w = await turnsWorld({
    judge: (kind, _id, _state, q) =>
      kind === "tool_groups" && JSON.stringify(q.instructions).includes("Issues") ? issues : 0,
    reply: () => ({ chunks: ["ok"] }),
  });
  const world = w;
  const say = (body: string) =>
    postPersonMessage({ db: world.db, pubsub: world.pubsub }, world.owner.id, world.org.id, world.general.id, { body });
  await say("@dev oi");
  await drainOutbox(world.db, world.handlers);
  issues = 0.9;
  await say("@dev quais issues estão abertas?");
  await drainOutbox(world.db, world.handlers);
  const [a, b] = world.provider.calls.map((c) => c.request).filter(isAgentCall);
  if (!a || !b) throw new Error("two calls expected");
  expect(names(b).has("list_issues")).toBe(true);
  expect(names(a).has("list_issues")).toBe(false);
  const [one, two] = await Promise.all([anthropicBody(a), anthropicBody(b)]);
  const upTo = (body: Record<string, unknown>) => {
    const tools = body.tools as Record<string, unknown>[];
    const at = tools.findIndex((t) => t.cache_control);
    expect(at).toBeGreaterThan(0);
    return JSON.stringify(tools.slice(0, at + 1));
  };
  expect(upTo(two)).toBe(upTo(one));
}, 60_000);
