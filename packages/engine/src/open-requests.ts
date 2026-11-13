import { and, type Executor, eq, gt, rowsOf, schema, sql } from "@agenteschat/db";
import { UUID } from "./authority";
import { cutText } from "./format";

const { agentQuestions, browserHandoffs, channels, messages, secretRequests } = schema;

/** A request for a person an agent made and nobody answered yet: help on one of its screens, a secret, a question. */
export interface OpenRequest {
  id: string;
  kind: "browser" | "desktop" | "secret" | "question";
  /** What it asked, in its words. */
  what: string;
  runId: string | null;
  channelName: string;
  channelKind: string;
  createdAt: Date;
}

/**
 * The agent's open requests in one conversation: asked help counts only while nobody took control (then it is the
 * person's turn, not the agent's to take back). Scoped to the run's channel, like its other blocks: another
 * conversation's requests are neither listed nor withdrawable from here (people there may not see this one).
 */
function openRequestQueries(db: Executor, orgId: string, agentId: string, channelId: string) {
  const now = new Date();
  const place = { channelName: channels.name, channelKind: channels.kind };
  return {
    handoffs: db
      .select({
        id: browserHandoffs.id,
        kind: sql<OpenRequest["kind"]>`${browserHandoffs.screen}::text`.as("kind"),
        what: sql<string>`${browserHandoffs.instructions}`.as("what"),
        runId: sql<string | null>`${browserHandoffs.runId}`.as("run_id"),
        createdAt: browserHandoffs.createdAt,
        ...place,
      })
      .from(browserHandoffs)
      .innerJoin(messages, and(eq(messages.orgId, browserHandoffs.orgId), eq(messages.id, browserHandoffs.id)))
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(
        and(
          eq(browserHandoffs.orgId, orgId),
          eq(browserHandoffs.agentId, agentId),
          eq(messages.channelId, channelId),
          eq(browserHandoffs.kind, "ask"),
          sql`(${browserHandoffs.status} = 'pending' or (${browserHandoffs.status} = 'active' and ${browserHandoffs.controllerUserId} is null))`,
          gt(browserHandoffs.expiresAt, now),
        ),
      ),
    secrets: db
      .select({
        id: secretRequests.id,
        kind: sql<OpenRequest["kind"]>`'secret'`.as("kind"),
        what: sql<string>`${secretRequests.name} || ': ' || ${secretRequests.purpose}`.as("what"),
        runId: sql<string | null>`${secretRequests.runId}`.as("run_id"),
        createdAt: secretRequests.createdAt,
        ...place,
      })
      .from(secretRequests)
      .innerJoin(channels, eq(channels.id, secretRequests.channelId))
      .where(
        and(
          eq(secretRequests.orgId, orgId),
          eq(secretRequests.agentId, agentId),
          eq(secretRequests.channelId, channelId),
          eq(secretRequests.status, "pending"),
          gt(secretRequests.expiresAt, now),
        ),
      ),
    questions: db
      .select({
        id: agentQuestions.id,
        kind: sql<OpenRequest["kind"]>`'question'`.as("kind"),
        what: sql<string>`${agentQuestions.text}`.as("what"),
        runId: sql<string | null>`${agentQuestions.runId}`.as("run_id"),
        createdAt: agentQuestions.createdAt,
        ...place,
      })
      .from(agentQuestions)
      .innerJoin(channels, eq(channels.id, agentQuestions.channelId))
      .where(
        and(
          eq(agentQuestions.orgId, orgId),
          eq(agentQuestions.agentId, agentId),
          eq(agentQuestions.channelId, channelId),
          eq(agentQuestions.status, "open"),
          gt(agentQuestions.expiresAt, now),
        ),
      ),
  };
}

/** Whether the agent has any open request in this conversation: one query, asked on every tool listing. */
export async function hasOpenRequest(db: Executor, orgId: string, agentId: string, channelId: string) {
  const q = openRequestQueries(db, orgId, agentId, channelId);
  const [row] = rowsOf<{ open: boolean }>(
    await db.execute(sql`select (exists(${q.handoffs}) or exists(${q.secrets}) or exists(${q.questions})) as open`),
  );
  return row?.open === true;
}

/** The agent's open requests in this conversation (`openRequestQueries`), oldest first. */
export async function openRequestsOf(
  db: Executor,
  orgId: string,
  agentId: string,
  channelId: string,
): Promise<OpenRequest[]> {
  // One statement: it is read before the model call on every turn with tools (packages/engine/test/budget-queries).
  const q = openRequestQueries(db, orgId, agentId, channelId);
  const rows = await q.handoffs.unionAll(q.secrets).unionAll(q.questions);
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

const KIND_TEXT: Record<OpenRequest["kind"], string> = {
  browser: "help in your browser",
  desktop: "help on your desktop",
  secret: "a secret",
  question: "a question",
};

/** One request as the agent reads it: id, what, where. */
export const openRequestLine = (r: OpenRequest) =>
  `- ${r.id}: ${KIND_TEXT[r.kind]}, "${cutText(r.what, 200)}", ${r.channelKind === "dm" ? "in a DM" : `in #${r.channelName}`}`;

export const WITHDRAW_REQUEST_TOOL = "withdraw_request";

export const WITHDRAW_RULE =
  "When the person picks another way, the need goes away, or you got what you needed another way, withdraw the request at once with `withdraw_request`: people stop waiting on it.";

/** "# Your open requests", read every turn; null with none. */
export function openRequestsBlock(rows: OpenRequest[]): string | null {
  if (rows.length === 0) return null;
  return [
    "# Your open requests",
    "What you asked people for and nobody answered yet:",
    ...rows.map(openRequestLine),
    WITHDRAW_RULE,
  ].join("\n");
}

/**
 * What a run reads, once, when it reached its answer with requests it made and stopped waiting on still open (a
 * person wrote meanwhile and it went on): it withdraws what it no longer needs, deterministically, without a judge.
 * "" with none.
 */
export function openRequestNudge(rows: OpenRequest[]): string {
  if (rows.length === 0) return "";
  return [
    "Your answer was posted. These requests of yours are still open, and people still see them waiting:",
    ...rows.map(openRequestLine),
    "If you no longer need one (the person chose another way, or you got it done otherwise), withdraw it now with `withdraw_request`. Either way, then end your turn without writing anything.",
  ].join("\n");
}

/** A wait that is help the agent withdrew: no result comes back for it. */
export async function isWithdrawnHandoff(db: Executor, orgId: string, waitId: string) {
  if (!UUID.test(waitId)) return false;
  const [row] = await db
    .select({ id: browserHandoffs.id })
    .from(browserHandoffs)
    .where(
      and(eq(browserHandoffs.orgId, orgId), eq(browserHandoffs.id, waitId), eq(browserHandoffs.status, "withdrawn")),
    );
  return Boolean(row);
}
