import { and, type Database, eq, schema } from "@agenteschat/db";
import { fileRefOf } from "./artifacts";
import { UUID } from "./authority";
import { NotFoundError } from "./errors";
import { canSee } from "./issues";
import { type MessageCard, messageCard } from "./message-links";
import { requirePermission } from "./organizations";

const { issues, agentRuns, agentWorks } = schema;

/** An internal id written in a text, as its pill names it for who reads it (`idRef`). */
export type IdRef =
  | ({ kind: "file" } & NonNullable<Awaited<ReturnType<typeof fileRefOf>>>)
  | { kind: "task"; id: string; number: number; title: string }
  | { kind: "message"; message: MessageCard };

/**
 * What an internal id written in a text names (an agent's, a pasted one), so people read a pill instead of the id: a
 * file, a task, a message, a run (its reply) or a background work (its card, else where it started), each only for a
 * person who may see it. Anything else is not found, and the text shows as written.
 */
export async function idRef(db: Database, userId: string, orgId: string, id: string): Promise<IdRef> {
  await requirePermission(db, userId, orgId, "read");
  const none = new NotFoundError("Nothing here has this id");
  if (!UUID.test(id)) throw none;
  const file = await fileRefOf(db, userId, orgId, id);
  if (file) return { kind: "file", ...file };
  const taskRef = async (taskId: string): Promise<IdRef | null> => {
    const [task] = await db
      .select({
        id: issues.id,
        number: issues.number,
        title: issues.title,
        channelId: issues.channelId,
        restricted: issues.restricted,
        audienceUserIds: issues.audienceUserIds,
      })
      .from(issues)
      .where(and(eq(issues.orgId, orgId), eq(issues.id, taskId)));
    if (!task || !(await canSee(db, { type: "person", userId }, orgId, task))) return null;
    return { kind: "task", id: task.id, number: task.number, title: task.title };
  };
  const task = await taskRef(id);
  if (task) return task;
  const [work] = await db
    .select({ issueId: agentWorks.issueId, anchor: agentWorks.anchorMessageId })
    .from(agentWorks)
    .where(and(eq(agentWorks.orgId, orgId), eq(agentWorks.id, id)));
  const card = work?.issueId ? await taskRef(work.issueId) : null;
  if (card) return card;
  const [run] = await db
    .select({ reply: agentRuns.replyMessageId })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, id)));
  const message = await messageCard(db, userId, orgId, run?.reply ?? work?.anchor ?? id).catch(() => null);
  if (message) return { kind: "message", message };
  throw none;
}
