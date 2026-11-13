import { and, type Executor, eq, inArray, schema } from "@agenteschat/db";
import { isDeviceWaitId } from "./device-waits";
import type { StoredTranscript } from "./run-resume";
import type { AgentRun } from "./runs";

const { agentConsultations, agentQuestions, agentRuns, browserHandoffs } = schema;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a run waits on something a new message can't move: an approval, a secret, a mission's own
 * wait (a blocking decision, a review). Such a run takes no new messages: the decision may take hours and
 * the agent stays responsive meanwhile, so whatever arrives (another agent's question, a notice, a
 * person's message) gets a run of its own. A run waiting on a question to people, another agent's answer,
 * help in its browser or its computer still takes them (the message answers, wakes or resumes it), unless the
 * question is for one person and `from`, the person writing, is someone else: their message answers nothing here.
 * `transcript` left out: read here when it matters (only for `waiting_input`).
 */
export async function holdsMessages(
  db: Executor,
  run: Pick<AgentRun, "id" | "orgId" | "status"> & { transcript?: AgentRun["transcript"] },
  from?: string | null,
): Promise<boolean> {
  if (run.status === "waiting_approval") return true;
  if (run.status !== "waiting_input") return false;
  let transcript = run.transcript;
  if (transcript === undefined) {
    const [row] = await db
      .select({ transcript: agentRuns.transcript })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, run.id), eq(agentRuns.orgId, run.orgId)));
    transcript = row?.transcript ?? null;
  }
  const t = transcript as StoredTranscript | null;
  // Long work paused near a limit (ADR 0118): a person's message gets a quick run of its own, so the reserve left
  // goes to replies, not to the long job.
  if (t?.waitingForBrain?.code === "usage_pause") return true;
  // Parked waiting for its computer: a message makes it look again (`steering.ts`).
  if (t?.waitingForBrain) return false;
  const calls = (t?.pending?.calls ?? []).filter((c) => !c.result);
  if (calls.some((c) => c.approvalId || c.secretRequestId)) return true;
  const asked = from ? calls.flatMap((c) => (c.questionId ? [c.questionId] : [])) : [];
  if (asked.length > 0) {
    const open = await db
      .select({ forUserId: agentQuestions.requestedForUserId })
      .from(agentQuestions)
      .where(
        and(eq(agentQuestions.orgId, run.orgId), inArray(agentQuestions.id, asked), eq(agentQuestions.status, "open")),
      );
    if (open.length > 0 && open.every((q) => q.forUserId && q.forUserId !== from)) return true;
  }
  // A call's `waitId` (not a question's): a browser handoff, an `ask_agent` consultation, else a mission's own wait. A
  // wait for a device takes messages: "use the other phone" moves it on (`onMessageWhileWaiting`).
  const waitIds = calls.flatMap((c) => (!c.questionId && c.waitId && !isDeviceWaitId(c.waitId) ? [c.waitId] : []));
  if (waitIds.length === 0) return false;
  const handoffIds = waitIds.filter((id) => UUID.test(id));
  const [consulted, handoffs] = await Promise.all([
    db
      .select({ waitId: agentConsultations.waitId })
      .from(agentConsultations)
      .where(
        and(
          eq(agentConsultations.orgId, run.orgId),
          eq(agentConsultations.askerRunId, run.id),
          inArray(agentConsultations.waitId, waitIds),
        ),
      ),
    handoffIds.length > 0
      ? db
          .select({ id: browserHandoffs.id })
          .from(browserHandoffs)
          .where(and(eq(browserHandoffs.orgId, run.orgId), inArray(browserHandoffs.id, handoffIds)))
      : Promise.resolve([] as { id: string }[]),
  ]);
  const known = new Set([...consulted.map((c) => c.waitId), ...handoffs.map((h) => h.id)]);
  return waitIds.some((id) => !known.has(id));
}
