import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, schema } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { type BrowserHandoffRow, finishHandoff } from "./browser/handoff";
import type { AgentConsultationRow } from "./consultations";
import { endDeviceWaitCards, isDeviceWaitId } from "./device-waits";
import { cutText } from "./format";
import type { Judge } from "./judge";
import type { Message } from "./messages";
import { enqueue } from "./outbox";
import type { DetachedWait, StoredTranscript } from "./run-resume";
import type { AgentRun } from "./runs";

const { agentConsultations, agentRuns, agents, browserHandoffs } = schema;

/** What a person's message did to the wait of the run it reached (`agent.run.wait_message`). */
export interface WaitMessageOutcome {
  /** `browser_handoff`, `consultation`, `approval`, `question`, `secret`, `mission`… */
  waitKind: string;
  outcome: "resolved" | "woke" | "held";
}

export type WaitKind =
  | "browser_handoff"
  | "consultation"
  | "approval"
  | "question"
  | "secret"
  | "mission"
  | "machine"
  /** `wait_for_device`: a device to be back, free or allowed (`device-waits.ts`). */
  | "device";

/** One thing a waiting run waits on: a pending tool call of its transcript, or its computer. */
export interface RunWait {
  kind: WaitKind;
  /** The call's own id: its `waitId`, `approvalId`, `questionId` or `secretRequestId` (the computer's: its wait id). */
  id: string;
  /** The tool call that waits (none for the computer). */
  toolName?: string;
  /** Made by a computer brain through the runner bridge. */
  bridged?: boolean;
  /** `browser_handoff`: the handoff (an asked help or a person's take over). */
  handoff?: BrowserHandoffRow;
  /** `consultation`: the question and the handle of the agent asked. */
  consultation?: AgentConsultationRow & { handle: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a run waits on now, from its transcript's pending calls (both brains:
 * a computer brain's bridged calls are kept there too) and its computer. A
 * call's `waitId` is a browser handoff's id, an `ask_agent` consultation's
 * wait, or else a mission's own wait (a blocking decision, a review).
 */
export async function currentWaits(
  db: Executor,
  run: Pick<AgentRun, "id" | "orgId" | "transcript">,
): Promise<RunWait[]> {
  const t = run.transcript as StoredTranscript | null;
  const out: RunWait[] = [];
  if (t?.waitingForBrain) out.push({ kind: "machine", id: t.waitingForBrain.waitId ?? t.waitingForBrain.machineId });
  const calls = (t?.pending?.calls ?? []).filter((c) => !c.result);
  const waitIds = calls.flatMap((c) => (c.waitId ? [c.waitId] : []));
  const handoffIds = waitIds.filter((id) => UUID.test(id));
  const [handoffs, consultations] = await Promise.all([
    handoffIds.length > 0
      ? db
          .select()
          .from(browserHandoffs)
          .where(and(eq(browserHandoffs.orgId, run.orgId), inArray(browserHandoffs.id, handoffIds)))
      : Promise.resolve([] as BrowserHandoffRow[]),
    waitIds.length > 0
      ? db
          .select({ row: agentConsultations, handle: agents.handle })
          .from(agentConsultations)
          .innerJoin(agents, eq(agents.id, agentConsultations.targetAgentId))
          .where(
            and(
              eq(agentConsultations.orgId, run.orgId),
              eq(agentConsultations.askerRunId, run.id),
              inArray(agentConsultations.waitId, waitIds),
            ),
          )
      : Promise.resolve([]),
  ]);
  for (const c of calls) {
    const base = { toolName: c.name, ...(c.bridged ? { bridged: true } : {}) };
    if (c.approvalId) out.push({ kind: "approval", id: c.approvalId, ...base });
    else if (c.secretRequestId) out.push({ kind: "secret", id: c.secretRequestId, ...base });
    else if (c.questionId) out.push({ kind: "question", id: c.questionId, ...base });
    else if (c.waitId && isDeviceWaitId(c.waitId)) out.push({ kind: "device", id: c.waitId, ...base });
    else if (c.waitId) {
      const waitId = c.waitId;
      const handoff = handoffs.find((h) => h.id === waitId);
      const consulted = consultations.find((x) => x.row.waitId === waitId);
      if (handoff) out.push({ kind: "browser_handoff", id: waitId, ...base, handoff });
      else if (consulted)
        out.push({
          kind: "consultation",
          id: waitId,
          ...base,
          consultation: { ...consulted.row, handle: consulted.handle },
        });
      else out.push({ kind: "mission", id: waitId, ...base });
    }
  }
  return out;
}

/** A wait to stop waiting on: what the run reads now, and who its late notice is from. */
export interface Detach {
  waitId: string;
  kind: WaitKind;
  /** The interim result the waiting call gets now. */
  text: string;
  /** Who the late notice is from, as the agent reads it. */
  from: string;
}

/**
 * The run stops waiting on these (a person wrote meanwhile): each waiting
 * call gets an interim result ("still open…"), the waits are recorded on the
 * transcript (`detachedWaits`: their real results come later as notices,
 * `resumeRunWithResult`), and the run is queued once; it resumes and reads
 * the queued message at its loop top. The wait itself stays open (the card,
 * the consultation). False: the run doesn't wait on any of them (anymore).
 */
export async function detachWaits(db: Database, runId: string, waits: Detach[]): Promise<boolean> {
  if (waits.length === 0) return false;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ orgId: agentRuns.orgId, status: agentRuns.status, transcript: agentRuns.transcript })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .for("update");
    if (!row || (row.status !== "waiting_input" && row.status !== "waiting_approval")) return false;
    const t = row.transcript as StoredTranscript | null;
    if (!t?.pending) return false;
    const at = new Date().toISOString();
    const detached: DetachedWait[] = [];
    for (const w of waits) {
      const call = t.pending.calls.find((c) => c.waitId === w.waitId && !c.result);
      if (!call) continue;
      call.result = { content: w.text, isError: false };
      detached.push({ waitId: w.waitId, kind: w.kind, from: w.from, at });
    }
    if (detached.length === 0) return false;
    t.detachedWaits = [
      ...(t.detachedWaits ?? []).filter((d) => !detached.some((x) => x.waitId === d.waitId)),
      ...detached,
    ];
    await tx
      .update(agentRuns)
      .set({ transcript: t as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(agentRuns.id, runId));
    // Once per detach (a fresh key: the same wait may be waited on, and detached, again later).
    await enqueue(tx, {
      orgId: row.orgId,
      kind: "agent_run.execute",
      payload: { runId },
      dedupeKey: `agent_run.execute:${runId}:detach:${Bun.randomUUIDv7()}`,
      maxAttempts: 4,
    });
    return true;
  });
}

/** One wait: `detachWaits` with the interim result `interimText`. */
export function detachWait(
  db: Database,
  run: Pick<AgentRun, "id">,
  waitId: string,
  interimText: string,
  info: { kind: WaitKind; from: string },
) {
  return detachWaits(db, run.id, [{ waitId, text: interimText, ...info }]);
}

const MEANWHILE = "Meanwhile the person wrote; their message follows.";

/** What the run reads now for a wait it stops waiting on, and who its late notice will be from. */
export function detachOf(wait: RunWait): Detach | null {
  if (wait.kind === "browser_handoff" && wait.handoff) {
    const h = wait.handoff;
    if (h.kind === "takeover") {
      return {
        waitId: wait.id,
        kind: wait.kind,
        from: "The person using your browser",
        text: `Still open: a person has control of your browser. ${MEANWHILE} You'll get a notice when they hand it back; until then your browser tools wait for them.`,
      };
    }
    return {
      waitId: wait.id,
      kind: wait.kind,
      from: "Your request for help in the browser",
      text: `Still open: your request for a person's help in your browser ("${cutText(h.instructions, 300)}"). ${MEANWHILE} Its result will reach you as a notice later; until then your browser stays with the person (your browser tools wait for it). If their message means you no longer need it (they chose another way), withdraw it at once with withdraw_request (id ${h.id}).`,
    };
  }
  if (wait.kind === "device") {
    return {
      waitId: wait.id,
      kind: wait.kind,
      from: "The device you waited for",
      text: `You stopped waiting for the device. ${MEANWHILE} Do what it asks; if the device is still needed, call wait_for_device again.`,
    };
  }
  if (wait.kind === "consultation" && wait.consultation) {
    const handle = `@${wait.consultation.handle}`;
    return {
      waitId: wait.id,
      kind: wait.kind,
      from: handle,
      text: `Still open: your question to ${handle}. ${MEANWHILE} Its answer will reach you as a notice later: don't ask again.`,
    };
  }
  return null;
}

/** Only a short message can only say "done" or "I couldn't" (anything longer is something else to read). */
const HANDOFF_REPLY_MAX_LENGTH = 280;

/**
 * A person wrote while the agent waits for their help in its browser: does
 * the message say they did it ("pronto, loguei", "done"), that they couldn't
 * ("não consegui", "it asks for a code I don't have"), or something else?
 * Any language. "other" when unsure, or the message is long.
 */
export async function handoffReplyIntent(
  judge: Judge,
  input: { orgId: string; text: string; request: string; agentName: string; agentId?: string; runId?: string },
): Promise<"done" | "failed" | "other"> {
  const text = input.text.trim();
  if (!text || text.length > HANDOFF_REPLY_MAX_LENGTH) return "other";
  const answers = await judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    runId: input.runId,
    kind: "handoff_reply",
    state: {
      agent: input.agentName,
      agent_asked_the_person_to_do_in_its_browser: input.request,
      person_wrote: text,
    },
    questions: {
      intent: {
        type: "choice",
        instructions:
          "`agent` asked a person to do something in its browser (sign in, type a code, solve a captcha) and waits. The person then wrote `person_wrote` in the chat. What does it say about that request?",
        criteria: {
          done: "They did it, or say it's done or ready ('pronto, loguei', 'done', 'feito', 'já entrei').",
          failed: "They tried and couldn't, or won't do it ('não consegui', 'it asks for a code I don't have').",
          other: "Anything else: a question, a new instruction, another topic, or unclear.",
        },
      },
    },
  });
  const a = answers.intent;
  const choice = a?.choice;
  if (choice !== "done" && choice !== "failed") return "other";
  return (a?.probabilities?.[choice] ?? 0) >= 0.6 ? choice : "other";
}

/**
 * A person's message reached a run that waits (not for its computer). Per
 * kind of wait:
 *
 * - Help in the browser it asked for: the judge reads whether the message
 *   says it's done or that they couldn't; then the help ends that way (the
 *   message is its note) and the run resumes (`resolved`). Anything else, or
 *   no judge: the run stops waiting on it (`detachWaits`) and reads the
 *   message now (`woke`); the help stays open and its result comes later as
 *   a notice. A person holding the browser (take over): `woke` the same way.
 * - Another agent's answer (`ask_agent` with `wait`): `woke`; the answer
 *   comes later as a notice.
 * - Approvals and secrets: `held`. Text never grants or decides them; the
 *   card does. Such a run takes no new messages at all (`holdsMessages`,
 *   they get a run of their own), and steering never asks here for one.
 * - A question to people: null (the message already answered it, on insert, or, for one person and from
 *   someone else, left for a run of its own: `holdsMessages`).
 * - A mission's own wait, its computer: null (read when it resumes).
 *
 * Null: nothing to do; the message stays queued, read when the run resumes.
 */
export async function onMessageWhileWaiting(
  deps: { db: Database; pubsub: PubSub; judge?: Judge },
  run: AgentRun,
  message: Message,
): Promise<WaitMessageOutcome | null> {
  const waits = await currentWaits(deps.db, run);
  if (waits.length === 0) return null;
  const held = waits.find((w) => w.kind === "approval" || w.kind === "secret");
  if (held) return { waitKind: held.kind, outcome: "held" };
  if (waits.some((w) => w.kind !== "browser_handoff" && w.kind !== "consultation" && w.kind !== "device")) return null;
  const [first] = waits;
  if (!first) return null;

  // "pronto, loguei": the help ends as done (or as couldn't), as if they pressed the card's button.
  const asked = waits.length === 1 && first.handoff?.kind === "ask" ? first.handoff : null;
  if (asked && deps.judge && message.authorType === "person" && message.authorUserId) {
    const agentName = (await getAgentCached(deps.db, run.orgId, run.agentId))?.name ?? "the agent";
    const intent = await handoffReplyIntent(deps.judge, {
      orgId: run.orgId,
      text: message.body,
      request: asked.instructions,
      agentName,
      agentId: run.agentId,
      runId: run.id,
    }).catch(() => "other" as const);
    if (intent !== "other") {
      const ended = await finishHandoff(deps, message.authorUserId, run.orgId, asked.id, {
        result: intent,
        note: message.body,
      })
        .then(() => true)
        // Not theirs to end (someone else in control, no access) or already over: it wakes instead.
        .catch(() => false);
      if (ended) return { waitKind: first.kind, outcome: "resolved" };
    }
  }

  const detach = waits.map(detachOf).filter((d): d is Detach => d !== null);
  if (detach.length !== waits.length) return null;
  const woke = await detachWaits(deps.db, run.id, detach);
  if (woke)
    await endDeviceWaitCards(
      deps,
      run,
      detach.map((d) => d.waitId),
      "moved_on",
    ).catch(() => undefined);
  return woke ? { waitKind: first.kind, outcome: "woke" } : null;
}
