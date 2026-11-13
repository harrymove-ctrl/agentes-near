/**
 * Claude Code's floor per step on this computer, without ("before") and with ("after") the runner's
 * savings (`alwaysLoad`, project settings only, its own built-in tools): runs
 * `claude` headless with the runner's own arguments (`claudeBrainArgs`) and a
 * fake `agentes` MCP server serving a real tool list, and reports what each
 * turn carried (prompt tokens, cache, steps, time). Uses this computer's
 * Claude plan; nothing else is called.
 *
 *   bun apps/server/scripts/brain-floor.ts --tools <tools.json> --system <system.txt> [--reps 2] [--model sonnet]
 *
 * `tools.json`: `{ core: BrainTool[] }` (what a run's MCP lists). Internal: `mcp <tools.json>` is the fake server.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { BRAIN_BUILTIN_TOOLS, claudeBrainArgs, userMessageLine } from "../runner/brain";

const self = path.resolve(import.meta.path);

// ── The fake MCP server (stdio, newline-delimited JSON-RPC) ────────────────────

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

const CANNED: Record<string, string> = {
  find_tools:
    'other tools for "issues" (call one with use_tool):\n- list_issues: List or find issues of the organization (by words, number or status).\n  input: {"type":"object","properties":{"query":{"type":"string"},"status":{"enum":["open","done"]}}}',
  use_tool:
    "#12 Login quebra no Android 14 (open, @ada)\n#15 Busca não acha cidades com acento (open)\n#18 Push duplicado (open)",
  list_issues: "#12 Login quebra no Android 14 (open, @ada)\n#15 Busca não acha cidades com acento (open)",
  remember: "Saved as 4f1c2a9e-0000-4000-8000-000000000001.",
};

async function serveMcp(file: string) {
  const { core } = (await Bun.file(file).json()) as { core: Tool[] };
  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const req = JSON.parse(line) as { id?: number | string; method: string; params?: Record<string, unknown> };
    if (req.id === undefined) continue;
    if (req.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: (req.params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "agentes", version: "eval" },
        },
      });
    } else if (req.method === "tools/list") {
      send({ jsonrpc: "2.0", id: req.id, result: { tools: core } });
    } else if (req.method === "tools/call") {
      const name = String(req.params?.name ?? "");
      const text = CANNED[name] ?? `${name}: done.`;
      send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text }] } });
    } else if (req.method === "ping") {
      send({ jsonrpc: "2.0", id: req.id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } });
    }
  }
}

if (process.argv[2] === "mcp") {
  await serveMcp(process.argv[3] as string);
  process.exit(0);
}

// ── The measurement ──────────────────────────────────────────────────────────

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const toolsFile = path.resolve(arg("tools") ?? "");
const systemFile = path.resolve(arg("system") ?? "");
const reps = Number(arg("reps") ?? 2);
const model = arg("model") ?? "sonnet";

/** What people ask agents, from a greeting to work in its folder. */
const PROMPTS = [
  { id: "greeting", text: "bom dia! tudo certo por aí?" },
  { id: "issues", text: "quais issues estão abertas agora?" },
  { id: "remember", text: "lembra que o deploy do app é sempre às sextas, depois das 14h" },
  { id: "file", text: "lê o notas.md da sua pasta e me diz o que ainda falta fazer" },
];

type Variant = "before" | "after";

interface Turn {
  variant: Variant;
  prompt: string;
  ok: boolean;
  steps: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  ms: number;
  tools: string[];
  builtins: number;
  builtinNames: string[];
  mcpTools: number;
  reply: string;
}

const root = mkdtempSync(path.join(tmpdir(), "brain-floor-"));
const work = path.join(root, "work");
mkdirSync(work);
writeFileSync(
  path.join(work, "notas.md"),
  "# Notas\n\n- [x] Corrigir login no Android\n- [ ] Acentos na busca de cidades\n- [ ] Push duplicado no iOS\n- [x] Página de preços\n",
);

function launch(variant: Variant): string[] {
  const dir = mkdtempSync(path.join(root, `${variant}-`));
  const mcpConfigFile = path.join(dir, "mcp.json");
  writeFileSync(
    mcpConfigFile,
    JSON.stringify({
      mcpServers: {
        agentes: {
          type: "stdio",
          command: process.execPath,
          args: [self, "mcp", toolsFile],
          ...(variant === "after" ? { alwaysLoad: true } : {}),
        },
      },
    }),
  );
  return claudeBrainArgs({
    session: crypto.randomUUID(),
    resume: false,
    model,
    systemFile,
    mcpConfigFile,
    strictMcp: true,
    promptTool: false,
    permissionMode: "acceptEdits",
    ...(variant === "after" ? { settingSources: "project", builtinTools: BRAIN_BUILTIN_TOOLS } : {}),
  });
}

async function runTurn(variant: Variant, prompt: (typeof PROMPTS)[number]): Promise<Turn> {
  const started = performance.now();
  const proc = Bun.spawn(["claude", ...launch(variant)], {
    cwd: work,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const killer = setTimeout(() => proc.kill(), 240_000);
  const turn: Turn = {
    variant,
    prompt: prompt.id,
    ok: false,
    steps: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    ms: 0,
    tools: [],
    builtins: 0,
    builtinNames: [],
    mcpTools: 0,
    reply: "",
  };
  proc.stdin.write(userMessageLine(prompt.text));
  proc.stdin.flush();
  for await (const line of createInterface({ input: Readable.fromWeb(proc.stdout as never) })) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "system" && ev.subtype === "init") {
      const tools = Array.isArray(ev.tools) ? (ev.tools as string[]) : [];
      turn.builtinNames = tools.filter((t) => !t.startsWith("mcp__"));
      turn.builtins = turn.builtinNames.length;
      turn.mcpTools = tools.filter((t) => t.startsWith("mcp__")).length;
    }
    if (ev.type === "assistant") {
      const content = (ev.message as { content?: { type: string; name?: string }[] })?.content ?? [];
      for (const b of content)
        if (b.type === "tool_use" && b.name) turn.tools.push(b.name.replace("mcp__agentes__", ""));
    }
    if (ev.type === "result") {
      const u = (ev.usage ?? {}) as Record<string, number>;
      turn.ok = ev.is_error !== true;
      turn.steps = Number(ev.num_turns ?? 0);
      turn.input = u.input_tokens ?? 0;
      turn.cacheRead = u.cache_read_input_tokens ?? 0;
      turn.cacheWrite = u.cache_creation_input_tokens ?? 0;
      turn.output = u.output_tokens ?? 0;
      turn.reply = String(ev.result ?? "").slice(0, 160);
      proc.stdin.end();
    }
  }
  await proc.exited;
  clearTimeout(killer);
  turn.ms = Math.round(performance.now() - started);
  return turn;
}

const turns: Turn[] = [];
for (let r = 0; r < reps; r++) {
  for (const p of PROMPTS) {
    // Alternating which goes first, so neither always meets a warmer cache.
    const order: Variant[] = (r + PROMPTS.indexOf(p)) % 2 === 0 ? ["before", "after"] : ["after", "before"];
    for (const v of order) {
      const t = await runTurn(v, p);
      turns.push(t);
      const prompt = t.input + t.cacheRead + t.cacheWrite;
      console.log(
        `${t.variant.padEnd(6)} ${t.prompt.padEnd(9)} ${t.ok ? "ok " : "ERR"} steps ${t.steps} prompt ${prompt} (read ${t.cacheRead}, write ${t.cacheWrite}) out ${t.output} ${(t.ms / 1000).toFixed(1)}s tools [${t.tools.join(",")}] builtin ${t.builtins} mcp ${t.mcpTools}`,
      );
    }
  }
}

console.log("\nPer variant (sums over every turn):");
for (const v of ["before", "after"] as Variant[]) {
  const mine = turns.filter((t) => t.variant === v);
  const sum = (k: keyof Turn) => mine.reduce((n, t) => n + (t[k] as number), 0);
  const prompt = sum("input") + sum("cacheRead") + sum("cacheWrite");
  const steps = sum("steps");
  console.log(
    `${v.padEnd(6)} turns ${mine.length} ok ${mine.filter((t) => t.ok).length} · steps ${steps} · prompt ${prompt} (${Math.round(prompt / Math.max(steps, 1))} per step) · cache write ${sum("cacheWrite")} · output ${sum("output")} · ${(sum("ms") / mine.length / 1000).toFixed(1)}s per turn`,
  );
}
writeFileSync(path.join(root, "turns.json"), JSON.stringify(turns, null, 2));
console.log(`\nturns: ${path.join(root, "turns.json")}`);
