import { expect } from "bun:test";
import { and, eq, inArray, lte, schema } from "@agenteschat/db";
import { REFUSALS, runAuthority } from "../../src";
import type { World } from "./harness";

/**
 * The invariants every scenario must keep at its end, whatever it is about (ops design "autonomy as invariants",
 * §1): a predicate over the rows. A path that breaks one fails some existing scenario even if nobody wrote a test
 * for it. Each check returns the violations it found; `assertInvariants` fails on any.
 */

/**
 * Refusals that mean a conversation turn couldn't do what its agent is allowed to do (I4). Looked up by name
 * because work-by-default removes the unattended ones; a routine's own background run has its own guards.
 */
const refusal = REFUSALS as Partial<Record<string, string>>;
const CANT_ACT = ["unattendedElsewhere", "unattendedInternal", "missionOnly", "unknownTool"].flatMap(
  (k) => refusal[k] ?? [],
);

export async function violations(w: World): Promise<string[]> {
  const out: string[] = [];
  const now = new Date();
  const runs = await w.runs();
  const ids = runs.map((r) => r.id);
  const steps = await w.steps(ids);
  const who = (agentId: string) => `@${w.handleOf(agentId)}`;

  // Quiescence: nothing left running or due (every scenario drains to the end).
  for (const r of runs)
    if (r.status === "queued" || r.status === "running") out.push(`I2: ${who(r.agentId)}'s run is still ${r.status}`);
  const due = await w.db
    .select({ kind: schema.outbox.kind })
    .from(schema.outbox)
    .where(
      and(
        eq(schema.outbox.orgId, w.org.id),
        eq(schema.outbox.status, "pending"),
        lte(schema.outbox.nextAttemptAt, now),
      ),
    );
  for (const j of due) out.push(`I2: job ${j.kind} is due and was never run`);

  // I2: a run that waits shows what it waits on, where someone sees it.
  const questions = ids.length
    ? await w.db.select().from(schema.agentQuestions).where(inArray(schema.agentQuestions.runId, ids))
    : [];
  const approvals = ids.length
    ? await w.db.select().from(schema.approvals).where(inArray(schema.approvals.runId, ids))
    : [];
  for (const r of runs) {
    // A run parked on a provider outage waits on its resume job, not on a person.
    const parked = (r.transcript as { outage?: unknown } | null)?.outage !== undefined;
    if (r.status === "waiting_input" && !parked && !questions.some((x) => x.runId === r.id && x.status === "open"))
      out.push(`I2: ${who(r.agentId)} waits for input with no open question`);
    if (r.status === "waiting_approval" && !approvals.some((x) => x.runId === r.id && x.status === "pending"))
      out.push(`I2: ${who(r.agentId)} waits for approval with no pending card`);
  }
  // The continuation controller records each turn's end on a step (`data.continuation`).
  for (const r of runs.filter((r) => r.status === "done" && !r.background))
    if (!steps.some((s) => s.runId === r.id && s.data.continuation !== undefined))
      out.push(`I2: ${who(r.agentId)}'s run ended with no recorded continuation outcome`);

  // I3: every hand-off between agents is closed and reported back.
  const consultations = await w.db
    .select()
    .from(schema.agentConsultations)
    .where(eq(schema.agentConsultations.orgId, w.org.id));
  const notices = (
    await w.db.select({ meta: schema.messages.meta }).from(schema.messages).where(eq(schema.messages.orgId, w.org.id))
  ).map((m) => (m.meta.notice ?? {}) as { kind?: string; refs?: Record<string, unknown> });
  for (const c of consultations) {
    const pair = `${who(c.askerAgentId)} → ${who(c.targetAgentId)}`;
    const target = runs.find((r) => r.id === c.targetRunId);
    const targetWaitsOnPerson = target?.status === "waiting_input" || target?.status === "waiting_approval";
    if (c.status === "open" && !targetWaitsOnPerson) out.push(`I3: hand-off ${pair} is still open`);
    if (c.status !== "open" && c.waitId.startsWith("async:")) {
      // Reported on its own notice, or rolled up into the answer of the run that handed it on (`reportedAt`).
      const reported =
        c.reportedAt !== null ||
        notices.some(
          (n) =>
            n.kind === "consult_reply" &&
            n.refs?.askerAgentId === c.askerAgentId &&
            n.refs?.agentId === c.targetAgentId,
        );
      if (!reported) out.push(`I3: hand-off ${pair} closed ${c.status} and was never reported back`);
    }
  }

  // I4: no turn was refused what its agent may do, outside a routine set to only look.
  for (const s of steps.filter((s) => s.kind === "tool_result" && s.data.isError === true)) {
    const r = runs.find((x) => x.id === s.runId);
    const content = String(s.data.content ?? "");
    if (!r?.background && CANT_ACT.some((c) => content.startsWith(c.slice(0, 40))))
      out.push(`I4: ${who(r?.agentId ?? "")} was refused: ${content.slice(0, 80)}`);
  }

  // I5: a failed run reaches someone who can act (a notification naming it or its agent), or waits to resume.
  // A hand-off's run reaches the agent that handed it the work: its consultation failed and the asker ran again.
  const notifications = await w.db.select().from(schema.notifications).where(eq(schema.notifications.orgId, w.org.id));
  const handOffs = await w.db.select().from(schema.agentConsultations);
  for (const r of runs.filter((r) => r.status === "failed" && !r.background)) {
    const relayed = handOffs.some(
      (c) =>
        c.targetRunId === r.id &&
        c.status === "failed" &&
        runs.some((a) => a.agentId === c.askerAgentId && a.id !== c.askerRunId && a.createdAt >= r.createdAt),
    );
    const told =
      relayed ||
      notifications.some((n) => {
        const text = JSON.stringify([n.source, n.latest]);
        return /fail|error|stopp/i.test(n.kind) && (text.includes(r.id) || text.includes(r.agentId));
      });
    if (!told) out.push(`I5: ${who(r.agentId)}'s run failed (${r.error}) and nobody was told`);
  }

  // I4: every scenario starts from a person or a routine, so a run whose chain lost its root (nobody behind it, no
  // routine either) is the read-only class whether or not its script happens to call a refused tool.
  for (const r of runs.filter((r) => !r.background)) {
    const a = await runAuthority(w.db, r);
    if (a.kind === "unattended" && !a.reason.startsWith("routine"))
      out.push(`I4: ${who(r.agentId)}'s run has nobody behind it (${a.reason})`);
  }

  // I6: nothing worked that nobody scripted, and no run was nudged past the bound.
  for (const u of w.unscripted)
    out.push(`I6: @${u.handle} made an unscripted model call after "${u.last.slice(0, 80)}"`);
  for (const r of runs) {
    const own = steps.filter((s) => s.runId === r.id);
    const nudges = own.filter((s) => s.data.nudged !== undefined).length;
    if (nudges > 3) out.push(`I6: ${who(r.agentId)}'s run was nudged ${nudges} times`);
    // Whatever names the continuation steps get: the worst bounded case (answer nudge, 2 continues, ask nudge) is 5
    // model calls in a row that execute nothing.
    let idle = 0;
    for (const s of own) {
      if (s.kind === "tool_call") idle = 0;
      else if (s.kind === "model_call" && ++idle === 6) out.push(`I6: ${who(r.agentId)} took 6 turns doing nothing`);
    }
  }
  // Thanks loops: agents waking each other back and forth. One hand-off and its answer is two wakes; a third
  // between the same pair is a loop (thanks, "de nada", 👍…) unless the scenario scripts a longer exchange.
  const authors = new Map(
    (
      await w.db
        .select({ id: schema.messages.id, agentId: schema.messages.authorAgentId })
        .from(schema.messages)
        .where(eq(schema.messages.orgId, w.org.id))
    ).map((m) => [m.id, m.agentId]),
  );
  const pairs = new Map<string, number>();
  for (const r of runs) {
    const from = authors.get(r.triggerMessageId);
    if (!from || from === r.agentId) continue;
    const key = [from, r.agentId].sort().join(" ↔ ");
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  for (const [key, n] of pairs)
    if (n > 2) out.push(`I6: ${key.split(" ↔ ").map(who).join(" ↔ ")} woke each other ${n} times`);

  // The harness itself: a judgment no table answers would pass silently.
  for (const k of new Set(w.unknownJudgments)) out.push(`harness: unknown judgment kind ${k}`);
  for (const body of w.unrouted) out.push(`harness: no route for "${body.slice(0, 80)}"`);
  return out;
}

export async function assertInvariants(w: World) {
  expect(await violations(w)).toEqual([]);
}
