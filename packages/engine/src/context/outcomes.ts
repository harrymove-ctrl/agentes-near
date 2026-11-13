import { and, type Database, desc, type Executor, eq, gte, inArray, or, schema } from "@agenteschat/db";

const { outcomes } = schema;

export type Outcome = typeof outcomes.$inferSelect;

/**
 * Kinds of ground truth we record about agent actions. Positive and negative
 * outcomes are the strongest evidence for lessons (docs/adr/0017).
 */
export const OUTCOME_KINDS = {
  tests_passed: "positive",
  tests_failed: "negative",
  ci_passed: "positive",
  ci_failed: "negative",
  pr_merged: "positive",
  pr_reverted: "negative",
  hotfix_after_merge: "negative",
  deploy_succeeded: "positive",
  deploy_rolled_back: "negative",
  error_spike: "negative",
  issue_closed: "positive",
  issue_reopened: "negative",
  approval_refused: "negative",
} as const;

export type OutcomeKind = keyof typeof OUTCOME_KINDS;

export interface OutcomeInput {
  orgId: string;
  kind: OutcomeKind;
  agentId?: string | null;
  runId?: string | null;
  stepSeq?: number | null;
  subject?: string;
  summary?: string;
  details?: Record<string, unknown>;
  source: "tool" | "approval" | "webhook";
  channelId?: string | null;
  threadRootId?: string | null;
}

export async function recordOutcome(db: Executor, input: OutcomeInput): Promise<Outcome> {
  const [row] = await db
    .insert(outcomes)
    .values({
      orgId: input.orgId,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      stepSeq: input.stepSeq ?? null,
      kind: input.kind,
      polarity: OUTCOME_KINDS[input.kind],
      subject: input.subject ?? "",
      summary: (input.summary ?? "").slice(0, 1000),
      details: input.details ?? {},
      source: input.source,
      channelId: input.channelId ?? null,
      threadRootId: input.threadRootId ?? null,
    })
    .returning();
  if (!row) throw new Error("outcome insert returned nothing");
  return row;
}

/**
 * The agent behind a subject (e.g. who merged `acme/app#42`), from earlier
 * outcomes: lets a webhook about a revert or an error spike be tied back to
 * the agent and run that caused it.
 */
export async function attributeSubject(db: Database, orgId: string, subject: string) {
  if (!subject) return null;
  const [row] = await db
    .select()
    .from(outcomes)
    .where(and(eq(outcomes.orgId, orgId), eq(outcomes.subject, subject)))
    .orderBy(desc(outcomes.createdAt))
    .limit(1);
  return row ?? null;
}

/** Outcomes relevant to a thread: recorded in it, or by its agents since `since`. */
export async function outcomesForThread(
  db: Database,
  orgId: string,
  input: { threadRootId: string; agentIds: string[]; since: Date; limit?: number },
) {
  return db
    .select()
    .from(outcomes)
    .where(
      and(
        eq(outcomes.orgId, orgId),
        or(
          eq(outcomes.threadRootId, input.threadRootId),
          input.agentIds.length > 0
            ? and(inArray(outcomes.agentId, input.agentIds), gte(outcomes.createdAt, input.since))
            : undefined,
        ),
      ),
    )
    .orderBy(desc(outcomes.createdAt))
    .limit(input.limit ?? 20);
}
