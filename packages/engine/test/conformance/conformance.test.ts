import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { agentRuns, BRAINS, createHarness, type Harness } from "./harness";
import { SCENARIOS } from "./scenarios";

/**
 * ADR 0053 §12: the same scenarios on every brain (the API model, Claude Code, Codex), through the real
 * executor, asserting only the end state. A scenario that passes on one brain and fails on another is a
 * place where the engine's shared base has split.
 */

// PGlite setup on a slow machine.
setDefaultTimeout(30_000);

let h: Harness | undefined;
afterEach(async () => {
  const current = h;
  h = undefined;
  await current?.f.close();
});

const ENDED = new Set(["done", "failed", "canceled"]);

/** What holds after every scenario on every brain: the one base the brains share. */
async function sharedBase(harness: Harness) {
  const runs = await agentRuns(harness);
  expect(runs.length).toBeGreaterThan(0);
  // Every run records the brain that really thought for it (shared code reads it, not the agent's).
  expect(runs.map((r) => r.brain)).toEqual(runs.map(() => harness.kind));
  // Nothing is left working once the queue is drained.
  expect(runs.filter((r) => r.status === "queued" || r.status === "running")).toEqual([]);
  // A routine's ledger closes on every ending of its run.
  const ended = new Set(runs.filter((r) => ENDED.has(r.status)).map((r) => r.id));
  const ledger = await harness.f.db.select().from(schema.routineRuns);
  for (const rr of ledger) {
    if (rr.agentRunId && ended.has(rr.agentRunId)) expect(rr.finishedAt).not.toBeNull();
  }
  // A computer brain never stands in on the API: no model usage on any run.
  if (harness.kind !== "model") {
    const usage = await harness.f.db.select().from(schema.usageRecords);
    expect(usage.filter((u) => u.runId && (u.provider === "anthropic" || u.provider === "openai"))).toEqual([]);
  }
}

describe.each(BRAINS)("on the %s brain", (kind) => {
  for (const scenario of SCENARIOS) {
    test.skipIf(Boolean(scenario.skip?.[kind]))(scenario.name, async () => {
      h = await createHarness(kind, scenario);
      await scenario.start(h);
      await scenario.end(h);
      await sharedBase(h);
    });
  }
});
