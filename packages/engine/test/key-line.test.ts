import { afterEach, expect, test } from "bun:test";
import { and, eq, schema, sql } from "@agenteschat/db";
import { customModelId, ProviderError } from "@agenteschat/providers";
import {
  KEY_LINE_LOOK_MS,
  KEY_LINE_PERSON_MINUTES,
  KEY_LINE_SPACING_MS,
  KEY_LINE_TRY_MS,
  keyLineGate,
  keyLineOf,
  kickKeyLine,
  rateLimited,
} from "../src";
import { closeWorlds, world } from "./autonomy/harness";

afterEach(closeWorlds);

const LINE = "default:anthropic";
const NOW = Date.now();

/** Three agents' runs parked in one line, as `parkOutage` leaves them. */
async function parked(limited: { on: boolean }, calls: string[]) {
  const reply = (name: string) => () => {
    calls.push(name);
    return limited.on ? { error: new ProviderError("rate limited by provider", true, 429) } : { text: "ok" };
  };
  const w = await world({
    agents: ["otto", "ada", "rio"],
    script: { otto: reply("otto"), ada: reply("ada"), rio: reply("rio") },
  });
  return w;
}

type World = Awaited<ReturnType<typeof parked>>;

/** Puts a run in the line by hand, its place spelled out. */
async function place(w: World, runId: string, outage: Record<string, unknown>) {
  await w.db
    .update(schema.agentRuns)
    .set({
      status: "waiting_input",
      transcript: sql`jsonb_set(coalesce(${schema.agentRuns.transcript}, '{}'::jsonb), '{outage}', ${JSON.stringify({ line: LINE, n: 1, waitId: runId, ...outage })}::jsonb)`,
    })
    .where(eq(schema.agentRuns.id, runId));
}

async function threeRuns(w: World) {
  await w.say("@otto um");
  await w.say("@ada dois");
  await w.say("@rio tres");
  await w.settle();
  const [a, b, c] = await w.runs();
  if (!a || !b || !c) throw new Error("three runs");
  return [a, b, c] as const;
}

test("what joins a line: a rate limit on a key, never an outage", () => {
  expect(rateLimited(new ProviderError("rate limited by provider", true, 429))).toBe(true);
  expect(rateLimited(new ProviderError("no prepaid credit left", false, 429))).toBe(false);
  expect(rateLimited(new ProviderError("overloaded", true, 529))).toBe(false);
  expect(keyLineOf({ credentialId: "k1", model: "claude-haiku-5-5" })).toBe("k1");
  expect(keyLineOf({ credentialId: null, model: "claude-haiku-5-5" })).toBe(LINE);
  // Two endpoints of one workspace are two keys, whatever the agent's own.
  const endpoint = "11111111-1111-4111-8111-111111111111";
  expect(keyLineOf({ credentialId: null, model: customModelId(endpoint, "m") })).toBe(endpoint);
  expect(keyLineOf({ credentialId: "k1", model: customModelId(endpoint, "m") })).toBe(endpoint);
});

test("a head that parked on something else, or has no job coming, holds nobody", async () => {
  const w = await parked({ on: false }, []);
  const [a, b, c] = await threeRuns(w);
  const org = w.f.org.id;
  // Back from the park and out of budget: it waits for a month, with its place still written down.
  await place(w, a.id, { since: 1, at: NOW, people: false });
  await w.db
    .update(schema.agentRuns)
    .set({
      transcript: sql`jsonb_set(${schema.agentRuns.transcript}, '{waitingForBrain}', '{"code":"budget"}'::jsonb)`,
    })
    .where(eq(schema.agentRuns.id, a.id));
  await place(w, b.id, { since: 2, at: NOW, people: false });
  expect(await keyLineGate(w.db, { id: b.id, orgId: org }, LINE, NOW)).toBeNull();
  // Its wake job ran out of attempts: nothing moved its `at`, so the next one doesn't wait for it.
  await place(w, b.id, { since: 2, at: NOW - KEY_LINE_TRY_MS - 1, people: false });
  await place(w, c.id, { since: 3, at: NOW, people: false });
  expect(await keyLineGate(w.db, { id: c.id, orgId: org }, LINE, NOW)).toBeNull();
});

test("every look moves a waiting run's `at`, so one that is only waiting keeps holding its place", async () => {
  const w = await parked({ on: false }, []);
  const [a, b, c] = await threeRuns(w);
  const org = w.f.org.id;
  const later = NOW + 60 * 60_000;
  await place(w, a.id, { since: 1, at: later, people: false });
  await place(w, b.id, { since: 2, at: NOW - KEY_LINE_TRY_MS - 1, people: false });
  await place(w, c.id, { since: 3, at: NOW, people: false });
  const look = await keyLineGate(w.db, { id: b.id, orgId: org }, LINE, NOW);
  expect(look).toEqual({ retryAt: later + KEY_LINE_SPACING_MS });
  await w.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, a.id));
  expect(await keyLineGate(w.db, { id: c.id, orgId: org }, LINE, later + KEY_LINE_SPACING_MS)).toEqual({
    retryAt: later + 2 * KEY_LINE_SPACING_MS,
  });
});

test("a dozen messages to one agent are all people's: while one's call is out the others wait for it", async () => {
  const w = await parked({ on: false }, []);
  const [a, b] = await threeRuns(w);
  const org = w.f.org.id;
  await place(w, a.id, { since: 1, at: NOW, people: true });
  await place(w, b.id, { since: 2, at: NOW, people: true });
  expect(await keyLineGate(w.db, { id: a.id, orgId: org }, LINE, NOW)).toBeNull();
  await w.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, a.id));
  expect(await keyLineGate(w.db, { id: b.id, orgId: org }, LINE, NOW)).toEqual({ retryAt: NOW + KEY_LINE_SPACING_MS });
});

test("a person's run on a limit is never parked past 15 minutes, so a new message doesn't wait an hour behind it", async () => {
  const w = await parked({ on: true }, []);
  await w.say("@otto um");
  await w.settle();
  for (const _ of [1, 2, 3, 4]) await w.advance(60);
  const [run] = await w.runs();
  const [row] = await w.db
    .select({ transcript: schema.agentRuns.transcript })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, run?.id ?? ""));
  const outage = (row?.transcript as unknown as { outage: { n: number; at: number } } | undefined)?.outage;
  expect(outage?.n).toBeGreaterThan(3);
  expect((outage?.at ?? Infinity) - Date.now()).toBeLessThanOrEqual(KEY_LINE_PERSON_MINUTES * 60_000);
});

test("only the oldest run tries; the others look again right after it", async () => {
  const w = await parked({ on: false }, []);
  const [a, b, c] = await threeRuns(w);
  const at = NOW + 60_000;
  await place(w, a.id, { since: 1, at, people: false });
  await place(w, b.id, { since: 2, at: at + 1, people: false });
  await place(w, c.id, { since: 3, at: at + 2, people: false });
  const org = w.f.org.id;
  expect(await keyLineGate(w.db, { id: b.id, orgId: org }, LINE, NOW)).toEqual({ retryAt: at + KEY_LINE_SPACING_MS });
  expect(await keyLineGate(w.db, { id: c.id, orgId: org }, LINE, NOW)).toEqual({ retryAt: at + KEY_LINE_SPACING_MS });
  expect(await keyLineGate(w.db, { id: a.id, orgId: org }, LINE, NOW)).toBeNull();
  // Its call is out: the next doesn't go, however long it was parked.
  await w.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, a.id));
  expect(await keyLineGate(w.db, { id: b.id, orgId: org }, LINE, NOW + 1000)).toEqual({
    retryAt: NOW + 1000 + KEY_LINE_LOOK_MS,
  });
});

test("a run a person waits on goes first, and doesn't wait on a call that is out", async () => {
  const w = await parked({ on: false }, []);
  const [a, b, c] = await threeRuns(w);
  await place(w, a.id, { since: 1, at: NOW, people: false, triedAt: NOW });
  await place(w, b.id, { since: 9, at: NOW, people: true });
  await place(w, c.id, { since: 2, at: NOW, people: false });
  const org = w.f.org.id;
  expect(await keyLineGate(w.db, { id: b.id, orgId: org }, LINE, NOW)).toBeNull();
  const held = await keyLineGate(w.db, { id: c.id, orgId: org }, LINE, NOW);
  expect(held?.retryAt).toBeGreaterThan(NOW);
});

test("another key's line is left alone, and a head gone quiet stops holding the line", async () => {
  const w = await parked({ on: false }, []);
  const [a, b] = await threeRuns(w);
  await place(w, a.id, { since: 1, at: NOW, people: false, line: "other-key", triedAt: NOW });
  await place(w, b.id, { since: 2, at: NOW, people: false });
  expect(await keyLineGate(w.db, { id: b.id, orgId: w.f.org.id }, LINE, NOW)).toBeNull();
  await place(w, a.id, { since: 1, at: NOW, people: false });
  await w.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, a.id));
  await w.db
    .update(schema.agentRuns)
    .set({
      transcript: sql`jsonb_set(${schema.agentRuns.transcript}, '{outage,triedAt}', ${String(NOW - 6 * 60_000)}::jsonb)`,
    })
    .where(eq(schema.agentRuns.id, a.id));
  await place(w, b.id, { since: 2, at: NOW, people: false });
  expect(await keyLineGate(w.db, { id: b.id, orgId: w.f.org.id }, LINE, NOW)).toBeNull();
});

test("the next in line gets its own job, spaced, once the head passes", async () => {
  const w = await parked({ on: false }, []);
  const [a, b] = await threeRuns(w);
  await place(w, a.id, { since: 2, at: NOW, people: false });
  await place(w, b.id, { since: 3, at: NOW, people: false });
  await kickKeyLine(w.db, w.f.org.id, LINE);
  const jobs = await w.db
    .select({ key: schema.outbox.dedupeKey, at: schema.outbox.nextAttemptAt })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.kind, "agent_run.execute"), sql`${schema.outbox.dedupeKey} like '%:key-line:%'`));
  expect(jobs.map((j) => j.key)).toEqual([`agent_run.execute:${a.id}:key-line:${a.id}`]);
  expect(jobs[0]?.at.getTime()).toBeGreaterThan(Date.now());
});

test("runs parked on one rate limit try one by one, none is lost, and each finishes", async () => {
  const limited = { on: true };
  const calls: string[] = [];
  const w = await parked(limited, calls);
  await w.say("@otto um");
  await w.say("@ada dois");
  await w.say("@rio tres");
  await w.settle();
  const parkedNow = (await w.runs()).filter((r) => r.status === "waiting_input");
  expect(parkedNow).toHaveLength(3);
  const before = calls.length;
  // A wake that lands while the limit holds: one call, whoever's turn it is.
  await w.advance(3);
  expect(calls.length - before).toBe(1);
  limited.on = false;
  await w.advance(60);
  await w.advance(60);
  await w.advance(60);
  expect((await w.runs()).map((r) => r.status)).toEqual(["done", "done", "done"]);
});
