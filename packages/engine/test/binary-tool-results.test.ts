import { afterEach, expect, test } from "bun:test";
import { asc, eq, schema, sql } from "@agenteschat/db";
import { drainOutbox, grantScopes, postPersonMessage, type ToolDefinition, type ToolOutput } from "../src";
import { codedErrorMessage } from "../src/errors";
import { pgSafeText, textOfBytes } from "../src/format";
import { addRunStep } from "../src/runs";
import { type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

/**
 * A run in #general whose model calls `dump_file` once with `input` (it returns `output`), then answers.
 * `before` runs on the database before the run's job is taken (a trigger, a job's attempts).
 */
async function runWithTool(
  output: ToolOutput,
  opts: { input?: Record<string, unknown>; sensitive?: boolean; before?: (fx: Fixture) => Promise<unknown> } = {},
) {
  let turn = 0;
  const dump: ToolDefinition = {
    name: "dump_file",
    description: "Dumps a file.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false },
    scope: "issues:read",
    ...(opts.sensitive ? { sensitive: true } : {}),
    execute: async () => output,
  };
  f = await setup({
    toolSources: [{ name: "dump", tools: async () => [dump] }],
    reply: () =>
      ++turn === 1
        ? { chunks: [], toolUses: [{ name: "dump_file", input: opts.input ?? {} }] }
        : { chunks: ["Pronto."] },
  });
  const fx = f;
  await grantScopes(fx.db, fx.org.id, fx.agent.id, [{ connectionId: null, scope: "issues:read" }]);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "@dev mostra o arquivo",
  });
  await opts.before?.(fx);
  await drainOutbox(fx.db, fx.handlers);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, fx.agent.id));
  if (!run) throw new Error("no run");
  const steps = await fx.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run.id))
    .orderBy(asc(schema.agentRunSteps.seq));
  const jobs = await fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
  const approvals = await fx.db.select().from(schema.approvals).where(eq(schema.approvals.runId, run.id));
  return { fx, run, steps, jobs, approvals };
}

test("Postgres-safe text: NUL and lone surrogates go, pairs (emoji) stay", () => {
  expect(pgSafeText("a\u0000b\ud800c\udc00d🐝")).toBe("abcd🐝");
});

test("a step holding NUL and lone surrogates is saved without them", async () => {
  const { fx, run } = await runWithTool({ content: "ok" });
  await addRunStep(fx.db, run, "tool_result", { content: "JFIF\u0000\u0010x\ud800y", nested: [{ raw: "a\u0000b" }] });
  const [last] = await fx.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run.id))
    .orderBy(asc(schema.agentRunSteps.seq))
    .then((rows) => rows.slice(-1));
  expect(last?.data).toEqual({ content: "JFIF\u0010xy", nested: [{ raw: "ab" }] });
});

test("a tool result with NUL bytes (a binary printed as text) is saved, the model gets it clean, and the run answers", async () => {
  const { fx, run, steps } = await runWithTool({
    content: "shot.jpg (9 bytes):\nÿØ\u0000\u0010JFIF\u0000\ud800",
    data: { raw: "a\u0000b" },
  });
  expect(run.status).toBe("done");
  const result = steps.find((s) => s.kind === "tool_result");
  expect(result?.data.content).toBe("shot.jpg (9 bytes):\nÿØ\u0010JFIF");
  expect(result?.data.data).toEqual({ raw: "ab" });
  expect(JSON.stringify(fx.provider.calls[1]?.request.messages)).not.toContain("\\u0000");
});

/** A trigger that makes Postgres refuse every `tool_result` step with this SQLSTATE and message. */
const refuseToolResults = (code: string, message: string) => (fx: Fixture) =>
  fx.db
    .execute(
      sql.raw(`create function refuse_step() returns trigger language plpgsql as $$
        begin if new.kind = 'tool_result' then raise exception '${message}' using errcode = '${code}'; end if; return new; end $$`),
    )
    .then(() =>
      fx.db.execute(
        sql`create trigger refuse_step before insert on agent_run_steps for each row execute function refuse_step()`,
      ),
    );

test("a NUL in a JSON key (third-party structured data) is saved without it, and the run answers", async () => {
  const { run, steps } = await runWithTool({ content: "ok", data: { "a\u0000": 1 } });
  expect(run.status).toBe("done");
  expect(steps.find((s) => s.kind === "tool_result")?.data.data).toEqual({ a: 1 });
});

test("a value the database refuses fails the run once and says so, not retried into a 'server restart'", async () => {
  const { run, jobs } = await runWithTool(
    { content: "ok" },
    { before: refuseToolResults("22P05", "unsupported Unicode escape sequence") },
  );
  expect(run.status).toBe("failed");
  expect(run.error).toBe("Stopped after an error: unsupported Unicode escape sequence");
  expect(jobs.map((j) => ({ status: j.status, attempts: j.attempts }))).toEqual([{ status: "done", attempts: 1 }]);
});

test("another database error on the last try fails the run with the driver's words, never the SQL and its params", async () => {
  const { run, steps } = await runWithTool(
    { content: "ok" },
    {
      before: async (fx) => {
        await refuseToolResults("23505", "duplicate key value violates unique constraint x")(fx);
        await fx.db.execute(sql`update outbox set attempts = max_attempts - 1 where kind = 'agent_run.execute'`);
      },
    },
  );
  expect(run.status).toBe("failed");
  expect(run.error).toBe("Stopped after an error: duplicate key value violates unique constraint x");
  expect(steps.find((s) => s.kind === "error" && s.data.reason === "gave_up")).toBeDefined();
});

test("an uncoded error's raw words never become the reason people read", () => {
  expect(codedErrorMessage(new TypeError("Cannot read properties of undefined"))).toBeNull();
  const wrapped = Object.assign(new Error("Failed query: insert into x\nparams: secret"), {
    cause: Object.assign(new Error("connection terminated"), { code: "08006" }),
  });
  expect(codedErrorMessage(wrapped)).toBe("connection terminated");
});

const WHY = "A pessoa pediu o arquivo inteiro no canal para revisar.";

test("a NUL in the model's arguments to an approval-gated tool: the call waits for approval, cleaned", async () => {
  const { run, approvals } = await runWithTool(
    { content: "ok" },
    { input: { text: "a\u0000b", why: WHY }, sensitive: true },
  );
  expect(run.status).toBe("waiting_approval");
  expect(approvals.map((a) => a.params)).toEqual([{ text: "ab" }]);
});

test("text that isn't UTF-8 is still text: Windows-1252 and UTF-16 with a BOM; a JPEG is binary", () => {
  const latin1 = Uint8Array.from([..."nome;a"].map((c) => c.charCodeAt(0)).concat([0xe7, 0xe3, 0x6f, 0x0a]));
  expect(textOfBytes(latin1)).toBe("nome;ação\n");
  expect(textOfBytes(Uint8Array.from([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]))).toBe("ab");
  expect(textOfBytes(Uint8Array.from([0xfe, 0xff, 0x00, 0x61]))).toBe("a");
  expect(textOfBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]))).toBeNull();
  expect(textOfBytes(Uint8Array.from([0x89, 0x01, 0x02, 0x03, 0x04, 0x05, 0x41]))).toBeNull();
});
