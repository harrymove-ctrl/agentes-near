// A fake `codex` for route and task tests. Each start appends its argv, $CODEX_HOME, its folder, $OPENAI_API_KEY
// and which of the containers service's variables it got to $FAKE_CODEX_LOG (one JSON line).
// `debug models` prints a catalog with several Luna models. `exec … --output-schema <file> -o <file>` reads
// the prompt on stdin, writes an answer in the schema's shape (its first handle 0.9) to the `-o` file and
// prints Codex's `--json` events. "SLOW_ROUTE" never answers.
// `exec` without `--output-schema` is a background task (`task.start`): signed in only with a key or a
// sign-in in $CODEX_HOME (an `auth.json` there), it answers in `-o` and its events; otherwise its turn fails
// "Not logged in" (exit 1). "CURL401" ends at once on a command's "401 Unauthorized" (exit 1).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const log = process.env.FAKE_CODEX_LOG;
if (log) {
  appendFileSync(
    log,
    `${JSON.stringify({
      pid: process.pid,
      args,
      codexHome: process.env.CODEX_HOME ?? null,
      cwd: process.cwd(),
      apiKey: process.env.OPENAI_API_KEY ?? null,
      containers: ["CONTAINER_HOST", "DOCKER_HOST", "XDG_RUNTIME_DIR"].filter((k) => k in process.env),
    })}\n`,
  );
}
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === "debug" && args[1] === "models") {
  const slugs = ["gpt-5.6-sol", "gpt-5.4-luna", "gpt-5.10-luna", "gpt-5.6-luna", "gpt-5.4-mini", "codex-auto-review"];
  process.stdout.write(JSON.stringify({ models: slugs.map((slug) => ({ slug, visibility: "list" })) }));
  process.exit(0);
}

if (args[0] === "exec" && flag("--output-schema") === undefined) {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  const event = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  event({ type: "thread.started", thread_id: "01a17ab8-bb80-7d22-b98e-b2ad4ec03ce8" });
  const home = process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "/nonexistent", ".codex");
  if (!process.env.OPENAI_API_KEY && !existsSync(path.join(home, "auth.json"))) {
    event({ type: "turn.failed", error: { message: "Not logged in" } });
    process.exit(1);
  }
  if (prompt.includes("CURL401")) {
    event({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "curl said 401 Unauthorized" },
    });
    process.exit(1);
  }
  writeFileSync(flag("-o"), `done: ${prompt.trim()}`);
  event({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: `done: ${prompt.trim()}` } });
  process.exit(0);
}

if (args[0] === "exec") {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, route: true, prompt })}\n`);
  if (prompt.includes("SLOW_ROUTE")) await new Promise((resolve) => setTimeout(resolve, 120_000));
  const schema = JSON.parse(readFileSync(flag("--output-schema"), "utf8"));
  const handle = schema.properties?.scores?.items?.properties?.handle?.enum?.[0];
  const answer = { needs_agent: 0.9, scores: handle ? [{ handle, score: 0.9 }] : [], reason: "a fake route" };
  writeFileSync(flag("-o"), JSON.stringify(answer));
  const event = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  event({ type: "thread.started", thread_id: "01a17ab8-bb80-7d22-b98e-b2ad4ec03ce7" });
  event({ type: "turn.started" });
  event({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: JSON.stringify(answer) } });
  event({
    type: "turn.completed",
    usage: { input_tokens: 18003, cached_input_tokens: 17000, output_tokens: 100, reasoning_output_tokens: 0 },
  });
  process.exit(0);
}

process.stderr.write(`fake codex: unknown command ${args.join(" ")}\n`);
process.exit(2);
