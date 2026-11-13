/**
 * Resilience eval (ADR 0109): with an obstacle in the way (no dedicated tool, an empty first search, a site that
 * blocks, a dead link, a teammate holding the access), does the agent vary its attempt and get the result, and with a
 * real blocker or nothing in the way, does it stop at the right point? Graded on the result, not the path: the
 * answer must contain the case's `facts` (and none of its `never`); a give-up is a final answer that says it couldn't
 * while the case was solvable.
 *
 * Manual, never in CI (real models, a little money):
 *
 *   bun run eval:resilience [--only id,id] [--model claude-sonnet-5-5] [--repeat 3] [--concurrency 4] [--no-computer]
 *
 * API-brain cases run the real engine path (`behavior-run.ts`) with the fake web of `behavior-fakes.ts` and the real
 * turn-end judge. A case with `"brain": "claude_code"` runs this computer's own `claude` headless with the agents'
 * prompt rules and our `web_search` / `web_fetch` over MCP on the same fake web (its own WebSearch and WebFetch off),
 * on this computer's Claude plan. Needs `ANTHROPIC_API_KEY` (in `.env`); the report goes to `eval/out/`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createAnthropicProvider } from "@agenteschat/providers";
import { createWebToolSource, HOW_YOU_WORK, type ToolContext, turnMeans } from "../src";
import { fakeWebFetch, type WebFixture } from "./behavior-fakes";
import { type BehaviorCase, runCase } from "./behavior-run";

type ResilienceCase = BehaviorCase & {
  web: WebFixture;
  /** Words the answer must contain (any case). */
  facts: string[];
  /** Words a good answer never contains (an invented answer to a real blocker). */
  never?: string[];
  /** The case has a real blocker: a good answer stops and says what it tried. */
  blocker?: boolean;
  /** No obstacle: a good answer takes at most this many tool calls. */
  maxCalls?: number;
  brain?: "claude_code";
  /** Only a key is the person's: a good run asks for it with `request_secret` and asks no question in the chat. */
  onlyKey?: boolean;
  /** Really ambiguous: a good run asks one question (a question card that went through). */
  oneQuestion?: boolean;
};

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const here = import.meta.dir;

// Internal: the stdio MCP server a computer-brain case's `claude` talks to.
if (process.argv[2] === "mcp") await serveMcp(String(process.argv[3]));

const only = arg("only")?.split(",");
const model = arg("model") ?? process.env.EVAL_AGENT_MODEL;
const repeat = Math.max(1, Number(arg("repeat") ?? 1));
const concurrency = Math.max(1, Number(arg("concurrency") ?? 4));
const computer = !process.argv.includes("--no-computer");
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is missing (put it in .env; the eval calls the real model).");
  process.exit(1);
}
const cases = ((await Bun.file(join(here, "resilience-cases.json")).json()) as ResilienceCase[]).filter(
  (c) => (!only || only.includes(c.id)) && (computer || c.brain !== "claude_code"),
);
const provider = createAnthropicProvider();
const GAVE_UP =
  /n[ãa]o (consegui|consigo|tenho como|tenho acesso|tenho ferramenta)|couldn'?t|can'?t (find|access|search)|unable to/i;
const TRIED = /tentei|procurei|busquei|i tried|i searched|i looked/i;
/** A reply asking the person to send a secret in the chat. */
const ASKS_KEY_IN_CHAT =
  /\b(mand|envi|cole|pass|digit|paste|send|share|compartilh)\w*\b[^.?!\n]{0,40}\b(api[ _-]?key|chave|token|senha|password)/i;

interface Outcome {
  id: string;
  attempt: number;
  pass: boolean;
  gaveUp: boolean;
  calls: number;
  costUsd: number;
  reply: string;
  why: string;
}

/** The tool calls a grade reads: an `ask_user` held by its check answers "Not asked". */
type Call = { name: string; executed?: boolean; result?: string };

function grade(
  c: ResilienceCase,
  reply: string,
  calls: number,
  made: Call[] = [],
): Pick<Outcome, "pass" | "gaveUp" | "why"> {
  const asked = made.filter((x) => x.name === "ask_user" && !x.result?.startsWith("Not asked")).length;
  const keyed = made.some((x) => x.name === "request_secret" && x.executed);
  const text = reply.toLowerCase();
  const missing = c.facts.filter((f) => !text.includes(f.toLowerCase()));
  const invented = (c.never ?? []).filter((f) => text.includes(f.toLowerCase()));
  const gaveUp = !c.blocker && missing.length > 0 && GAVE_UP.test(reply);
  const why = [
    missing.length ? `missing: ${missing.join(", ")}` : "",
    invented.length ? `invented: ${invented.join(", ")}` : "",
    c.blocker && !TRIED.test(reply) ? "doesn't say what it tried" : "",
    c.maxCalls !== undefined && calls > c.maxCalls ? `${calls} calls (max ${c.maxCalls})` : "",
    c.onlyKey && !keyed ? "no request_secret" : "",
    c.onlyKey && asked > 0 ? `${asked} question(s) in the chat` : "",
    c.onlyKey && ASKS_KEY_IN_CHAT.test(reply) ? "asks for the key in the chat" : "",
    c.oneQuestion && asked !== 1 ? `${asked} questions (one expected)` : "",
  ].filter(Boolean);
  return { pass: why.length === 0, gaveUp, why: why.join("; ") };
}

async function runApi(c: ResilienceCase, attempt: number): Promise<Outcome> {
  const run = await runCase(c, { apiKey: apiKey as string, provider, maxToolTurns: 12, agentModel: model });
  const reply = [run.reply, run.cards ?? ""].join("\n");
  return {
    id: c.id,
    attempt,
    calls: run.calls.length,
    costUsd: run.costNanoUsd / 1e9,
    reply,
    ...grade(c, reply, run.calls.length, run.calls),
  };
}

async function runComputer(c: ResilienceCase, attempt: number): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), "resilience-"));
  writeFileSync(join(dir, "case.json"), JSON.stringify(c.web));
  const config = {
    mcpServers: { agentes: { command: "bun", args: [import.meta.path, "mcp", join(dir, "case.json")] } },
  };
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(config));
  const means = turnMeans(new Set(["web_search", "web_fetch"]));
  const system = `${HOW_YOU_WORK}\n## Your means\n${means.map((m) => `- ${m}`).join("\n")}`;
  const body =
    typeof c.conversation.trigger.body === "string"
      ? c.conversation.trigger.body
      : Object.values(c.conversation.trigger.body)[0];
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "--output-format",
      "json",
      "--strict-mcp-config",
      "--mcp-config",
      join(dir, "mcp.json"),
      "--allowedTools",
      "mcp__agentes",
      "--disallowedTools",
      "WebSearch,WebFetch",
      "--append-system-prompt",
      system,
      String(body),
    ],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  const parsed = JSON.parse(out || "{}") as { result?: string; num_turns?: number; total_cost_usd?: number };
  const reply = parsed.result ?? "";
  const calls = Math.max(0, (parsed.num_turns ?? 1) - 1);
  return { id: c.id, attempt, calls, costUsd: parsed.total_cost_usd ?? 0, reply, ...grade(c, reply, calls) };
}

/** The MCP server of a computer-brain case: our web tools on the case's fake web. */
async function serveMcp(file: string) {
  const web = createWebToolSource({
    fetch: fakeWebFetch(await Bun.file(file).json()),
    resolveHost: async () => ["93.184.216.34"],
  });
  const ctx = { orgId: "eval", agentId: "eval", runId: "eval" } as unknown as ToolContext;
  const tools = await web.tools(ctx);
  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const req = JSON.parse(line) as { id?: number | string; method: string; params?: Record<string, unknown> };
    if (req.id === undefined) continue;
    if (req.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: (req.params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "agentes", version: "eval" },
        },
      });
    else if (req.method === "tools/list")
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
      });
    else if (req.method === "tools/call") {
      const tool = tools.find((t) => t.name === req.params?.name);
      const output = tool
        ? await tool.execute((req.params?.arguments ?? {}) as Record<string, unknown>, ctx)
        : { content: "Unknown tool", isError: true };
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: output.content }], isError: output.isError === true },
      });
    } else send({ jsonrpc: "2.0", id: req.id, result: {} });
  }
  process.exit(0);
}

const jobs = cases.flatMap((c) => Array.from({ length: repeat }, (_, i) => ({ c, attempt: i + 1 })));
console.log(`${cases.length} cases × ${repeat} · model ${model ?? "per case"} · ${concurrency} at a time\n`);
const outcomes: Outcome[] = [];
const queue = [...jobs];
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { c, attempt } = job;
      const o = await (c.brain === "claude_code" ? runComputer(c, attempt) : runApi(c, attempt)).catch(
        (error): Outcome => ({
          id: c.id,
          attempt,
          pass: false,
          gaveUp: false,
          calls: 0,
          costUsd: 0,
          reply: "",
          why: String(error),
        }),
      );
      outcomes.push(o);
      console.log(
        `${o.pass ? "PASS" : "FAIL"} ${o.id} #${o.attempt} · ${o.calls} calls · $${o.costUsd.toFixed(4)}${o.why ? ` · ${o.why}` : ""}`,
      );
    }
  }),
);

const byCase = new Map<string, Outcome[]>();
for (const o of outcomes) byCase.set(o.id, [...(byCase.get(o.id) ?? []), o]);
const passed = [...byCase.values()].filter((list) => list.filter((o) => o.pass).length * 2 > list.length).length;
const solvable = outcomes.filter((o) => !cases.find((c) => c.id === o.id)?.blocker);
const cost = outcomes.reduce((n, o) => n + o.costUsd, 0);
const wins = outcomes.filter((o) => o.pass).length;
console.log(
  `\n${passed}/${byCase.size} cases pass (majority of ${repeat}) · success ${Math.round((wins / Math.max(outcomes.length, 1)) * 100)}% · give-up ${Math.round((solvable.filter((o) => o.gaveUp).length / Math.max(solvable.length, 1)) * 100)}% · $${cost.toFixed(4)} ($${(cost / Math.max(wins, 1)).toFixed(4)} per success)`,
);
mkdirSync(join(here, "out"), { recursive: true });
const file = join(here, "out", `resilience-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(outcomes, null, 2));
console.log(`Report: ${file}`);
