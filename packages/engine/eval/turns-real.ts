/**
 * The token-trim eval's scripted turns (`turns.ts`) against a real model, to compare an agent's behavior before and
 * after a prompt change: run it on both commits and read the two reports side by side. Manual, never in CI (it calls
 * the real model and costs a few cents).
 *
 *   bun run eval:turns [--model claude-opus-5-5] [--only greet-dm,block] [--repeat 3]
 *
 * Each turn runs on a fresh in-memory database through the real engine path (prompt, Tool Gateway, tool loop) with
 * every production tool source and tools on demand; the judge is the fake one (no tool group is loaded up front, as
 * for a greeting). Prints, per turn, the tools the agent called against what a good answer calls, its reply and the
 * tokens; the JSON report goes to `eval/out/` (ignored by git). Needs `ANTHROPIC_API_KEY`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, schema } from "@agenteschat/db";
import { createAnthropicProvider, type ModelResult } from "@agenteschat/providers";
import { drainOutbox, postPersonMessage } from "../src";
import { placeOf, TURNS, turnsWorld } from "./turns";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const model = arg("model") ?? process.env.EVAL_AGENT_MODEL ?? "claude-sonnet-5-5";
const only = arg("only")?.split(",");
const repeat = Math.max(1, Number(arg("repeat") ?? 1));
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is missing (put it in .env; the eval calls the real model).");
  process.exit(1);
}
const real = createAnthropicProvider();

const report: Record<string, unknown>[] = [];
for (const turn of TURNS.filter((t) => !only || only.includes(t.id))) {
  for (let n = 0; n < repeat; n++) {
    const w = await turnsWorld();
    await w.db.update(schema.agents).set({ model }).where(eq(schema.agents.id, w.agent.id));
    const results: ModelResult[] = [];
    w.provider.stream = async (request, options) => {
      const result = await real.stream(request, { ...options, apiKey });
      if ((request.tools?.length ?? 0) > 0) results.push(result);
      return result;
    };
    const { channelId, body } = placeOf(w, turn);
    await postPersonMessage({ db: w.db, pubsub: w.pubsub }, w.owner.id, w.org.id, channelId, { body });
    await drainOutbox(w.db, w.handlers);
    const called = results.flatMap((r) =>
      r.content.flatMap((b) => (b.type === "tool_use" ? [b.name === "use_tool" ? String(b.input.tool) : b.name] : [])),
    );
    const usage = results.reduce(
      (s, r) => ({
        input: s.input + r.usage.inputTokens,
        cacheRead: s.cacheRead + r.usage.cacheReadTokens,
        cacheWrite: s.cacheWrite + r.usage.cacheWriteTokens,
        output: s.output + r.usage.outputTokens,
      }),
      { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    );
    const reply = results.at(-1)?.text ?? "";
    const hit = !turn.wants || turn.wants.some((t) => called.includes(t));
    console.log(
      `${hit ? "OK  " : "MISS"} ${turn.id}${repeat > 1 ? ` #${n + 1}` : ""}: called ${called.join(", ") || "nothing"}${
        turn.wants ? ` (wants any of ${turn.wants.join(", ")})` : ""
      } · ${results.length} calls, input ${usage.input} + read ${usage.cacheRead} + write ${usage.cacheWrite}, output ${usage.output}\n     ${reply.replace(/\s+/g, " ").slice(0, 200)}`,
    );
    report.push({ turn: turn.id, run: n + 1, called, hit, usage, reply });
    await w.close();
  }
}
const out = join(import.meta.dir, "out");
mkdirSync(out, { recursive: true });
const file = join(out, `turns-${model}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`report: ${file}`);
