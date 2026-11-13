import { and, type Executor, eq, schema } from "@agenteschat/db";
import { appLocale } from "@agenteschat/i18n/locale";
import {
  accountablePerson,
  fedByRoutine,
  personOfMessage,
  type RunAuthority,
  runAuthority,
  runAuthorityById,
} from "./authority";
import type { Audience } from "./task-access";
import type { ToolContext } from "./tools/types";
import type { WikiActor } from "./wiki";

const { agentRuns, users } = schema;

/**
 * The person a tool call acts for (ADR 0053): the person behind its run (`authority.ts`), or null when
 * nobody is (a routine's run, an unattended one). A call without a run (a mission task's) acts for the
 * person behind the message it was given, if any. It never grants anything: the tool still checks
 * that person's permissions and the agent's own scopes.
 */
export async function personBehindCall(
  ctx: Pick<ToolContext, "orgId" | "runId" | "triggerMessageId"> & { db: Executor },
): Promise<string | null> {
  const [run] = ctx.runId
    ? await ctx.db
        .select({
          id: agentRuns.id,
          orgId: agentRuns.orgId,
          triggerMessageId: agentRuns.triggerMessageId,
          background: agentRuns.background,
          transcript: agentRuns.transcript,
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.orgId, ctx.orgId), eq(agentRuns.id, ctx.runId)))
    : [];
  if (run) return (await runAuthority(ctx.db, run)).personId;
  return ctx.triggerMessageId ? personOfMessage(ctx.db, ctx.orgId, ctx.triggerMessageId) : null;
}

/** The person's language for the lines written for them (a template's text, the weekly check's name). */
export async function personLocale(db: Executor, userId: string | null, preferred?: string | null) {
  const [row] = userId ? await db.select({ locale: users.locale }).from(users).where(eq(users.id, userId)) : [];
  return appLocale([preferred, row?.locale], true) ?? "en";
}

/**
 * The language of a line the server writes in a chat as an agent (a device wait, a task's end, a long work's update):
 * the person it works for, else the one behind its run (who asked, or a routine's creator), else English.
 */
export async function lineLocale(db: Executor, orgId: string, person: string | null, runId: string | null) {
  if (person || !runId) return personLocale(db, person);
  return personLocale(db, accountablePerson(await runAuthorityById(db, orgId, runId)));
}

/** `visible_to` of the tools that make something people read (ADR 0151). */
export const visibleToField = {
  enum: ["conversation", "requester", "everyone"],
  description:
    "Who sees it. Default conversation: the workspace from a public channel, the people here from a DM or private channel. requester: only who asked. everyone: when they want the whole team to see it.",
};

/**
 * `visible_to` as the tool's write takes it; undefined leaves it to the conversation. With nobody behind the run,
 * nobody asked for it to reach further than where it was made. A routine's creator may only narrow it: a run its report
 * woke sits in a conversation whose private text is no routine's to publish.
 */
export async function chosenAudience(
  ctx: Pick<ToolContext, "orgId" | "runId" | "triggerMessageId"> & { db: Executor },
  choice: unknown,
): Promise<Audience | undefined> {
  if (choice !== "requester" && choice !== "everyone") return undefined;
  const person = (await personBehindCall(ctx)) ?? (choice === "requester" ? await routineCreatorOfCall(ctx) : null);
  if (!person) return undefined;
  return choice === "everyone" ? { mode: "everyone" } : { mode: "people", userIds: [person] };
}

/** The person behind a message (`personOfMessage`): its author, or the person behind the run that wrote it. */
export const personBehindRun = (db: Executor, orgId: string, triggerMessageId: string): Promise<string | null> =>
  personOfMessage(db, orgId, triggerMessageId);

/**
 * Whose rooms and agents a routine reaches (ADR 0053 §2, amended 2026-10-31): its creator's. It posts
 * only where they can post and wakes only agents they can talk to, and still never acts as them (no files of
 * theirs, nothing in their name). The same for a run its work or report woke (`fedByRoutine`: a tell_agent's
 * run in the agents' DM, the run its report wakes), so one hop never reaches further. Null for any other run.
 */
export const routineCreatorOf = (authority: RunAuthority): string | null =>
  actingRoutineOf(authority)?.creatorUserId ?? null;

/** The brief of a routine whose creator is still there (whose reach it has); null otherwise. */
const actingRoutineOf = (authority: RunAuthority) => {
  const brief = authority.kind !== "person" && fedByRoutine(authority) ? (authority.brief ?? null) : null;
  return brief?.creatorUserId ? brief : null;
};

/** `actingRoutineOf` for a call's run. */
export async function actingRoutineOfCall(ctx: Pick<ToolContext, "orgId" | "runId"> & { db: Executor }) {
  return ctx.runId ? actingRoutineOf(await runAuthorityById(ctx.db, ctx.orgId, ctx.runId)) : null;
}

/** `routineCreatorOf` for a call's run. */
export async function routineCreatorOfCall(ctx: Pick<ToolContext, "orgId" | "runId"> & { db: Executor }) {
  return (await actingRoutineOfCall(ctx))?.creatorUserId ?? null;
}

/**
 * Whose wiki a run reads with (ADR 0023 addendum): the person behind it, or a routine's creator, whose reach it has.
 * Nobody for the rest, and then no page limited to people.
 */
export const wikiPersonOf = (authority: RunAuthority): string | null =>
  authority.personId ?? routineCreatorOf(authority);

/** The agent of a tool call, as the wiki sees it (see `WikiActor`). */
export async function wikiActorOfCall(
  ctx: Pick<ToolContext, "orgId" | "runId" | "triggerMessageId" | "agentId" | "channelId"> & { db: Executor },
): Promise<WikiActor> {
  const person = await personBehindCall(ctx);
  const requestedByUserId = person ?? (await routineCreatorOfCall(ctx));
  return { type: "agent", agentId: ctx.agentId, requestedByUserId, channelId: ctx.channelId };
}
