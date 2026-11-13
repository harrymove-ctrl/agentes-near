import type { PubSub } from "@agenteschat/adapters";
import { and, desc, type Executor, eq, inArray, isNull, ne, schema, sql } from "@agenteschat/db";
import { filesOfRun } from "./artifacts";
import { routineBriefOfRun } from "./background";
import { sameSentence } from "./context/items";
import { deliverNotice, publishDelivery } from "./delivery";
import { cutText, stringsOf } from "./format";
import type { Judge } from "./judge";
import type { GifMedia } from "./media";
import type { AgentGifPoster } from "./media-tools";
import { insertMessage, type Message, unreachedAgents, unreachedNote, unreachedPeople } from "./messages";
import { runReadOutsideById } from "./outside";
import type { RoutineBrief } from "./routine-brief";
import { personCanPost } from "./routine-state";
import { type AgentRun, addRunStep } from "./runs";
import { REQUEST_SECRET_TOOL } from "./secrets";
import { maskCredentials } from "./tool-detail";
import { reachesTeammates, turnMeans } from "./tools/directory";
import type { ToolContext, ToolDefinition, ToolSource } from "./tools/types";
import { neutralizeUntrusted } from "./untrusted";

export const HAND_OFF_TOOL = "hand_off";
/** A report, not a transcript: long enough for findings, why and what next. */
export const MAX_HAND_OFF = 8000;

const { agentRuns, routines, routineRuns } = schema;

/** Why a routine's report can't be delivered now (the routine run ends `skipped` with it). */
export type HandOffBlock = "deleted" | "paused" | "creator_no_access" | "handoff_blocked";

/**
 * Whether a routine may still speak where it reports (ADR 0053 §4): it exists and is active (a
 * one-off or a manual run counts as live), and its creator can still post there. Read at delivery,
 * since the routine may have changed while its run worked. Null when it may.
 */
export async function routineDeliveryBlock(tx: Executor, brief: RoutineBrief): Promise<HandOffBlock | null> {
  const [routine] = await tx
    .select({
      orgId: routines.orgId,
      active: routines.active,
      deletedAt: routines.deletedAt,
      triggerType: routines.triggerType,
      creator: routines.createdByUserId,
    })
    .from(routines)
    .where(eq(routines.id, brief.routineId));
  if (!routine || routine.deletedAt) return "deleted";
  if (!routine.active && brief.trigger !== "manual" && routine.triggerType !== "once") return "paused";
  // Its creator now (an admin or the agent's owner may have taken it over since it fired).
  if (!routine.creator) return "creator_no_access";
  if (!(await personCanPost(tx, routine.orgId, routine.creator, brief.deliverTo.channelId))) return "creator_no_access";
  return null;
}

/**
 * A routine's message reaches the conversation it reports to (`brief.deliverTo`), never its room.
 * By default it is the message itself (ADR 0053 §4, amended): the agent's ordinary message there,
 * tagged with the routine (`meta.routine`), waking nobody, so a greeting or a digest reads as one
 * message, with its `gif` under the text when it has one (ADR 0091 addendum 2026-11-09). With `wake`,
 * it is a `routine_handoff` notice for the same agent instead, which joins an unattended run of the
 * agent there or starts one that acts or decides on it (never a run working for a person). Only
 * while the routine run is still open: one stopped, replaced or given up meanwhile
 * tells nobody (null). The routine run is `reported`, with the text as its record and `code`
 * (`auto_report` when its final text was delivered for it). In the caller's transaction; publish
 * with `publishDelivery` after the commit.
 */
export async function deliverRoutineReport(
  tx: Executor,
  input: {
    run: Pick<AgentRun, "id" | "orgId" | "agentId">;
    brief: RoutineBrief;
    text: string;
    code?: string | null;
    wake?: boolean;
    /** Found before the transaction (`hand_off`'s `gif`); only with the message itself, never with `wake`. */
    gif?: GifMedia | null;
  },
): Promise<{ message: Message; runs: AgentRun[] } | null> {
  const { run, brief } = input;
  // Its final text delivered for it (`auto_report`) never went through the Tool Gateway: no credential in it.
  const text = maskCredentials(input.text);
  const [open] = await tx
    .update(routineRuns)
    .set({ status: "reported", summary: text.slice(0, 4000), code: input.code ?? null })
    .where(
      and(
        eq(routineRuns.id, brief.routineRunId),
        eq(routineRuns.orgId, run.orgId),
        inArray(routineRuns.status, ["queued", "starting", "started"]),
        isNull(routineRuns.finishedAt),
      ),
    )
    .returning({ id: routineRuns.id });
  if (!open) return null;
  const relays = await runReadOutsideById(tx, run.orgId, run.id);
  if (!input.wake) {
    // Agents and people it names outside that conversation: its mention reaches nobody, and the tool's result says so.
    const unreached = await unreachedAgents(tx, {
      orgId: run.orgId,
      channelId: brief.deliverTo.channelId,
      authorAgentId: run.agentId,
      body: text,
      handedTo: run.id,
    });
    const missed = await unreachedPeople(tx, { orgId: run.orgId, channelId: brief.deliverTo.channelId, body: text });
    // Its saved files come with it, as a reply's do: no other card of the run reaches the people.
    const files = await filesOfRun(tx, run.orgId, run.id, brief.deliverTo.channelId);
    const message = await insertMessage(tx, {
      orgId: run.orgId,
      channelId: brief.deliverTo.channelId,
      threadId: brief.deliverTo.threadId ?? undefined,
      // Nobody is behind it (authority.ts) and it wakes nobody: a root at hop 0, like a reminder.
      author: { type: "agent", agentId: run.agentId, runId: null, hop: 0, stretchId: null },
      body: text,
      meta: {
        routine: { id: brief.routineId, name: brief.name, runId: brief.routineRunId },
        // Kept as `send_gif` keeps it: no URL, and its title never reaches the model (ADR 0091 §6).
        ...(input.gif ? { media: input.gif } : {}),
        ...(files.length > 0 ? { artifacts: files } : {}),
        ...(unreached.length > 0 ? { unreachedAgents: unreached } : {}),
        ...(missed.length > 0 ? { unreachedPeople: missed } : {}),
        ...(relays ? { readOutside: true } : {}),
      },
    });
    await tx.update(routineRuns).set({ messageId: message.id }).where(eq(routineRuns.id, brief.routineRunId));
    return { message, runs: [] };
  }
  return deliverNotice(tx, {
    orgId: run.orgId,
    agentId: run.agentId,
    channelId: brief.deliverTo.channelId,
    threadId: brief.deliverTo.threadId,
    // Nobody is behind it (authority.ts): the run it wakes answers at hop 1, in a stretch of its own.
    hop: 0,
    stretchId: null,
    readOutside: relays,
    notice: {
      kind: "routine_handoff",
      text,
      from: brief.name ? `Routine «${brief.name}»` : "Routine",
      refs: {
        runId: run.id,
        routineId: brief.routineId,
        routineRunId: brief.routineRunId,
        routineName: brief.name,
        report: brief.report,
      },
    },
  });
}

/** Ends the routine run `skipped` with why its report couldn't be delivered (while still open). */
async function blockRoutineRun(tx: Executor, brief: RoutineBrief, orgId: string, code: HandOffBlock) {
  await tx
    .update(routineRuns)
    .set({ status: "skipped", code, finishedAt: new Date() })
    .where(
      and(
        eq(routineRuns.id, brief.routineRunId),
        eq(routineRuns.orgId, orgId),
        inArray(routineRuns.status, ["queued", "starting", "started"]),
      ),
    );
}

const BLOCKED: Record<HandOffBlock | "stopped", string> = {
  deleted: "the routine was deleted",
  paused: "the routine was paused",
  creator_no_access: "the routine's creator can no longer post where it reports",
  handoff_blocked: "this run has no routine to report to",
  stopped: "this run was stopped or replaced, and nobody hears it",
};

/** What the resourcefulness checks need (ADR 0109): a routine's report and a question to a person. */
export interface ResourcefulDeps {
  /** Judges the call before it goes out; none: every call goes. */
  judge?: Judge | null;
  /** The run's tools as it sees them (the gateway's `list`), for the means a held call is reminded of. */
  tools?: () => { list(ctx: ToolContext): Promise<ToolDefinition[]> } | undefined;
}

export interface HandOffDeps extends ResourcefulDeps {
  pubsub?: PubSub;
  /** `hand_off`'s GIF (`createAgentGifPoster`); absent: it has no `gif`. */
  gif?: AgentGifPoster;
}

/** `hand_off`'s GIF (ADR 0091 addendum 2026-11-09), listed only when the agent may send one. */
const GIF_PROPERTY = {
  type: "string",
  maxLength: 100,
  description: 'What the GIF shows, in English, 1 to 6 words (e.g. "good morning coffee").',
} as const;
const GIF_HELP =
  ' `gif` posts a GIF in the same message, under the text: when the routine asks for one, or the message is a light one (a greeting, a celebration); never with a report of work. Say what it shows as a short search in English (1 to 6 words, e.g. "good morning coffee"), whatever language the message is in. Never paste a link to a GIF site instead. Not with `wake_me`.';

/**
 * The GIF a routine's message goes with, or what to tell the model when none goes: found the way `send_gif` finds
 * one, past the GIFs posted lately where the routine reports (a daily greeting's GIF isn't yesterday's), before
 * anything is posted, so a failed search posts nothing. Null: the run has no routine (the delivery says so).
 */
async function handOffGif(
  poster: AgentGifPoster | undefined,
  ctx: ToolContext,
  search: unknown,
): Promise<{ gif: GifMedia | null } | { error: string }> {
  const brief = await routineBriefOfRun(ctx.db, ctx);
  if (!brief) return { gif: null };
  const found = poster
    ? await poster.find(ctx, search, `${ctx.runId}:${HAND_OFF_TOOL}`, brief.deliverTo)
    : { none: "off" as const };
  if ("gif" in found) return found;
  switch (found.none) {
    case "off":
      return { error: "GIFs are off here: hand off the message alone, without `gif`." };
    case "empty":
      return { error: 'Say what the GIF shows in a few English words, e.g. "good morning".' };
    case "down":
      return { error: "GIF search isn't answering right now: try again, or hand off without `gif`." };
    case "not_found":
      return { error: `No GIF found for "${found.query}". Try other words in English, or hand off without \`gif\`.` };
  }
}

/** The rules of this run's calls of `tool` held so far (its `continuation` steps with `held`). */
async function heldRules(db: Executor, run: { id: string; orgId: string }, tool: string) {
  const rows = await db
    .select({ rule: sql<string | null>`${schema.agentRunSteps.data}->'continuation'->>'rule'` })
    .from(schema.agentRunSteps)
    .where(
      and(
        eq(schema.agentRunSteps.orgId, run.orgId),
        eq(schema.agentRunSteps.runId, run.id),
        eq(schema.agentRunSteps.kind, "context"),
        sql`${schema.agentRunSteps.data}->'continuation'->>'held' = ${tool}`,
      ),
    );
  return rows.map((r) => r.rule ?? "");
}

/** How many times this run's report was held as untried (its `continuation` steps with `held`). */
export async function handOffHolds(db: Executor, run: { id: string; orgId: string }) {
  return (await heldRules(db, run, HAND_OFF_TOOL)).length;
}

type RunRow = typeof agentRuns.$inferSelect;
type RunTranscript = { continuation?: { count?: number }; request?: string; harnessTried?: string[] };

/**
 * What the resourcefulness judge reads of a run (ADR 0109): the task (Continuar's request, else the message or the
 * routine's instructions that started it), its general means and every call it tried.
 */
async function runEvidence(deps: ResourcefulDeps, ctx: ToolContext, run: RunRow) {
  // Loaded here: the controller and the team pull in most of the engine, which imports this file.
  const [{ triedCalls }, { teammateMeans }] = await Promise.all([import("./continuation"), import("./team")]);
  const t = (run.transcript ?? {}) as RunTranscript;
  const listed = await deps
    .tools?.()
    ?.list(ctx)
    .catch(() => []);
  const names = new Set((listed ?? []).map((x) => x.name));
  const own = ctx.bridge ? ["your computer's own tools: shell and files"] : [];
  const teammates = reachesTeammates(names) ? await teammateMeans(ctx).catch(() => []) : [];
  const means = [...turnMeans(names, teammates), ...own];
  const tried = await triedCalls(ctx.db, run, t.harnessTried);
  const [trigger] = t.request
    ? []
    : await ctx.db
        .select({ body: schema.messages.body })
        .from(schema.messages)
        .where(and(eq(schema.messages.orgId, run.orgId), eq(schema.messages.id, run.triggerMessageId)));
  return { request: t.request || (trigger?.body ?? ""), means, tried, names };
}

/**
 * A routine's report that says it couldn't while the run still had ways to try (ADR 0109): held once, before
 * anything posts (never inside the delivery's transaction), and the nudge is the tool's answer. It uses the run's one
 * extra turn (`CONTINUE.routineMaxPerRun`, shared with the turn-end controller), so the next report always posts.
 * Null: post it.
 */
async function holdUntried(deps: HandOffDeps, ctx: ToolContext, text: string): Promise<string | null> {
  if (!deps.judge) return null;
  const { CONTINUE, continuationVerdict, untriedNudge } = await import("./continuation");
  const [run] = await ctx.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId)));
  if (!run?.background || run.status !== "running") return null;
  const t = (run.transcript ?? {}) as RunTranscript;
  const used = Math.max(t.continuation?.count ?? 0, await handOffHolds(ctx.db, run));
  if (used >= CONTINUE.routineMaxPerRun) return null;
  const { request, means, tried } = await runEvidence(deps, ctx, run);
  const verdict = await continuationVerdict(deps.judge, {
    orgId: ctx.orgId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    request,
    reply: text,
    means,
    tried,
    runKind: "routine",
  }).catch(() => "done" as const);
  if (verdict !== "untried") return null;
  await addRunStep(ctx.db, run, "context", {
    continuation: { outcome: "continue", rule: "untried", verdict, held: HAND_OFF_TOOL, count: used + 1 },
    nudged: "untried",
  });
  return `Not posted yet. ${untriedNudge(means, tried)} Then call hand_off again: that one posts.`;
}

/**
 * What a question to a person asks for (`askVerdict`): something the run could find, a secret, a person's own, or
 * nothing it needs to go on (`none`: a status note or an optional offer).
 */
export type AskVerdict = "findable" | "secret" | "person" | "none";

/**
 * Says it needs nothing, with no question and no "nothing but your ok" in it: a card over this keeps a person from
 * nothing. The judge reads that in any language; this list holds when it fails, when there is none, and when it calls
 * the note a person's to answer.
 * ponytail: the common wordings of pt, en, es, fr, de and it; other languages rest on the judge alone.
 */
const SAYS_NEEDS_NOTHING =
  /(?:n[ãa]o preciso de (?:mais )?nada|i (?:don'?t|do not) need anything|i need nothing|no necesito (?:nada|más nada)|je n'ai besoin de rien|ich brauche (?:gerade |jetzt |momentan )?nichts|non ho bisogno di nulla)(?![^.!\n]*[\s,](?:al[ée]m|exceto|salvo|s[óo]|apenas|but|except|besides|other than|just|only|excepto|s[óo]lo|m[áa]s|sauf|seulement|d'autre|au(?:ß|ss)er|nur|tranne|oltre)[\s,])/i;

export const saysNeedsNothing = (text: string) => !/[?？]/.test(text) && SAYS_NEEDS_NOTHING.test(text);

/**
 * One judge call on an `ask_user` question (kind `ask_check`, recorded like every judgment): `secret` at p ≥ 0.5
 * and at least the others, then `none` and `findable` the same way, otherwise `person`. A needless hold costs
 * one more call of the agent; a findable question asked, or one that asks nothing, costs the person a wait.
 */
export async function askVerdict(
  judge: Judge,
  input: {
    orgId: string;
    agentId: string;
    runId: string;
    question: string;
    request: string;
    means: string[];
    tried: string[];
    /** What the agent already wrote in this turn, before asking. */
    reply?: string;
  },
): Promise<AskVerdict> {
  const answers = await judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    runId: input.runId,
    kind: "ask_check",
    state: {
      question: cutText(input.question, 1000),
      request: cutText(input.request, 2000),
      ...(input.reply ? { reply: cutText(input.reply, 2000) } : {}),
      means: input.means,
      tried: input.tried.slice(-20).map(neutralizeUntrusted),
    },
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "An AI agent in a team chat was asked `request` and now wants to ask a person `question`, then wait for the answer. `reply`, when given: what it already wrote to them in this turn. `means`: the general ways it has (web search, browser, terminal, tool directory, teammates). `tried`: each tool call it made in this run, with its argument and outcome. What does the question ask for?",
        criteria: {
          findable:
            "Information the agent could find itself with `means` and hasn't really looked for in `tried`: an API's address or endpoints, a product's or a service's docs, what a name or a term the person used refers to (search the workspace and the web first), a public fact, something written in the workspace's messages or files.",
          secret: "A secret typed into the chat: a password, an API key, a token, a code, a private key.",
          person:
            "Something only a person can give that the agent needs to go on: a decision, a preference or a priority, an approval, a payment, an access or a sign-in, a test only they can run; or a request so ambiguous that what they meant can't be found anywhere; or `tried` already shows it searched where the answer would be.",
          none: "Nothing the agent needs to go on: `question` is a status note or an update that needs no answer, says it needs nothing from them, or only offers optional extra work the request doesn't need ('only if you want…', 'I can also…'); or `reply` already settles the request and `question` merely offers more. A way to do the request itself, or the step it needs from them (a sign-in, a QR code, their consent to their own account), is never this, however it is worded. A note that describes something it still needs from them to finish the request (an access, a decision, a test) is not this, even when it asks no question.",
        },
      },
    },
  });
  const a = answers.verdict;
  const p = (k: AskVerdict) => a?.probabilities?.[k] ?? (a?.choice === k ? 1 : 0);
  const wins = (k: AskVerdict) =>
    p(k) >= 0.5 && (["secret", "none", "findable", "person"] as const).every((o) => p(k) >= p(o));
  if (wins("secret")) return "secret";
  if (wins("none")) return "none";
  if (wins("findable")) return "findable";
  return saysNeedsNothing(input.question) ? "none" : "person";
}

/** A question naming a secret, read when the judge fails: a missed one would be typed into the chat in plain text. */
const NAMES_SECRET =
  /\b(api[ _-]?keys?|chaves?|tokens?|senhas?|passwords?|secrets?|segredos?|credenciais|credentials?)\b/i;

/** What the run reads when its question asks the person for nothing it needs (`none`). */
export const ASKS_NOTHING =
  "Not asked: this asks the person for nothing you need to go on. Say it in your reply instead, as a plain offer if it is one, and end your turn: nobody waits on it.";

/** How many of a run's last questions a new one is compared with. */
const RECENT_QUESTIONS = 5;

/**
 * What the run reads when a question is the same as, or nearly the same as, one it already asked (a withdrawn one may
 * come back): what came of the first, instead of a second card. Null: not asked yet.
 */
export async function repeatedAsk(db: Executor, run: { id: string; orgId: string }, text: string) {
  const asked = await db
    .select()
    .from(schema.agentQuestions)
    .where(
      and(
        eq(schema.agentQuestions.orgId, run.orgId),
        eq(schema.agentQuestions.runId, run.id),
        ne(schema.agentQuestions.status, "canceled"),
      ),
    )
    .orderBy(desc(schema.agentQuestions.createdAt))
    .limit(RECENT_QUESTIONS);
  const same = asked.find((q) => sameSentence(q.text, text));
  if (!same) return null;
  if (same.status === "open") return "Not asked: you already asked this and it is still open. Wait for the answer.";
  // Loaded here, as `questions.ts` loads this file.
  const { questionResult } = await import("./questions");
  return `Not asked: you already asked this in this run. ${questionResult(same).content}`;
}

/**
 * What a model brain wrote in this turn before its tool calls: its `model_call` step is saved before they run. A
 * computer brain's turn saves that step only when it ends, so the latest one is an earlier turn's.
 */
async function turnNarration(ctx: ToolContext) {
  if (ctx.bridge) return "";
  const [step] = await ctx.db
    .select({ narration: sql<string | null>`${schema.agentRunSteps.data}->>'narration'` })
    .from(schema.agentRunSteps)
    .where(
      and(
        eq(schema.agentRunSteps.orgId, ctx.orgId),
        eq(schema.agentRunSteps.runId, ctx.runId),
        eq(schema.agentRunSteps.kind, "model_call"),
      ),
    )
    .orderBy(sql`${schema.agentRunSteps.seq} desc`)
    .limit(1);
  return step?.narration ?? "";
}

/** What the run reads when it asked a person for a secret in a chat question. */
const SECRET_IN_CHAT = "Not asked: a secret typed in the chat stays in the conversation in plain text.";

/**
 * An `ask_user` question goes through the same resourcefulness check as giving up (ADR 0109 addendum): a question for
 * something the run could find with its means is held once (the tool answers with its means and what it tried, and
 * the next findable question is asked), a secret asked as a chat question is refused every time and turned to
 * `request_secret` (on a judge error, a question naming a secret is refused too), and one that asks the person for
 * nothing the run needs (a status note, an optional offer) is refused every time, so the run never waits on it (on a
 * judge error it is asked, unless it says so itself). One it already asked is refused before any of this. Null: ask it.
 */
export async function holdAsk(deps: ResourcefulDeps, ctx: ToolContext, question: string): Promise<string | null> {
  const repeated = await repeatedAsk(ctx.db, { id: ctx.runId, orgId: ctx.orgId }, question);
  if (repeated) return repeated;
  if (!deps.judge) return saysNeedsNothing(question) ? ASKS_NOTHING : null;
  const { findableNudge } = await import("./continuation");
  const [run] = await ctx.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId)));
  if (run?.status !== "running") return null;
  const held = await heldRules(ctx.db, run, "ask_user");
  const [{ request, means, tried, names }, reply] = await Promise.all([
    runEvidence(deps, ctx, run),
    turnNarration(ctx),
  ]);
  const verdict = await askVerdict(deps.judge, {
    orgId: ctx.orgId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    question,
    request,
    means,
    tried,
    reply,
  }).catch((): AskVerdict => (NAMES_SECRET.test(question) ? "secret" : saysNeedsNothing(question) ? "none" : "person"));
  if (verdict === "person" || (verdict === "findable" && held.includes("findable"))) return null;
  await addRunStep(ctx.db, run, "context", {
    continuation: { outcome: "continue", rule: verdict, held: "ask_user", count: held.length + 1 },
    ...(verdict === "findable" ? { nudged: "untried" } : {}),
  });
  if (verdict === "findable") return findableNudge(means, tried);
  if (verdict === "none") return ASKS_NOTHING;
  return names.has(REQUEST_SECRET_TOOL)
    ? `${SECRET_IN_CHAT} Ask for it with request_secret: the person types it into a secure card. Find everything else yourself first.`
    : `${SECRET_IN_CHAT} You have no secure way to receive it here: say which key you need and where it is set up, without asking for it in the chat.`;
}

/**
 * The built-in `hand_off`, offered only to background runs (a routine's, `ctx.background`): the
 * one way such a run speaks. Its message is posted where the routine reports, or with `wake_me`
 * becomes a `routine_handoff` notice there (`deliverRoutineReport`), at once and once per run (a second call is refused),
 * after checking the routine may still speak there (`routineDeliveryBlock`); when it can't, the
 * routine run is skipped with the reason and the model is told to finish. Where the agent may send GIFs
 * (`AgentGifPoster.offered`), it takes `gif`: the message goes with a GIF (ADR 0091 addendum 2026-11-09).
 */
export function createHandOffToolSource(deps: HandOffDeps): ToolSource {
  const tool: ToolDefinition = {
    name: HAND_OFF_TOOL,
    description:
      "Post this routine's message where it reports, once. `message` is posted as-is as your own message to the people there: write the message itself (the greeting, the digest, the reminder, what you found and what you recommend), in their language, never about this routine or its runs. An agent of that conversation it @mentions wakes and works on it; one outside it hears nothing (tell_agent reaches it). Set `wake_me` only when what you found needs you to act or decide in that conversation: then `message` is a note to you there (you'll be woken with it and tell the people yourself), not posted as-is. Without it nothing is posted.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: MAX_HAND_OFF },
        wake_me: { type: "boolean" },
      },
      required: ["message"],
      additionalProperties: false,
    },
    describe: (input) => ({
      title: input.wake_me === true ? "Hand off the report" : "Post the message",
      detail: String(input.message ?? ""),
    }),
    async execute(input, ctx) {
      const text = String(input.message ?? "").trim();
      if (!text) return { content: "Give the report to hand off.", isError: true };
      const gifAsked = typeof input.gif === "string" && input.gif.trim() !== "";
      if (gifAsked && input.wake_me === true) {
        return {
          content: "A GIF goes only with a message posted as-is: hand off without `gif`, or without `wake_me`.",
          isError: true,
        };
      }
      const held = await holdUntried(deps, ctx, text);
      if (held) return { content: held, data: { held: true } };
      // Searched outside the transaction below: the provider may take seconds, and the run's row stays locked there.
      let gif: GifMedia | null = null;
      if (gifAsked) {
        const found = await handOffGif(deps.gif, ctx, input.gif);
        if ("error" in found) return { content: found.error, isError: true };
        gif = found.gif;
      }
      const handed = await ctx.db.transaction(async (tx) => {
        // Locked: two calls in one turn hand off once.
        const [run] = await tx
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId)))
          .for("update");
        if (!run?.background) return { refused: "Only background work (a routine's run) hands off: just reply." };
        if (run.status !== "running") return { refused: `Nothing was delivered: ${BLOCKED.stopped}. Finish now.` };
        const brief = await routineBriefOfRun(tx, run);
        if (!brief) return { refused: `Nothing was delivered: ${BLOCKED.handoff_blocked}. Finish now.` };
        const [already] = await tx
          .select({ id: routineRuns.id })
          .from(routineRuns)
          .where(and(eq(routineRuns.id, brief.routineRunId), eq(routineRuns.status, "reported")));
        if (already) {
          return {
            refused:
              "You already handed off this run's message; it was delivered and can't be changed. Finish now: nothing else is posted.",
          };
        }
        const block = await routineDeliveryBlock(tx, brief);
        if (block) {
          await blockRoutineRun(tx, brief, run.orgId, block);
          return { refused: `Nothing was delivered: ${BLOCKED[block]}. Finish now: nothing else is posted.` };
        }
        const delivered = await deliverRoutineReport(tx, { run, brief, text, wake: input.wake_me === true, gif });
        if (!delivered) return { refused: `Nothing was delivered: ${BLOCKED.stopped}. Finish now.` };
        return { delivered };
      });
      if ("refused" in handed) return { content: handed.refused ?? "", isError: true };
      await publishDelivery(deps.pubsub, handed.delivered);
      const { unreachedAgents: agents, unreachedPeople: people } = handed.delivered.message.meta;
      const note = unreachedNote(stringsOf(agents), "that conversation", false, stringsOf(people), true);
      return {
        content:
          input.wake_me === true
            ? "Handed off: you will tell the people in the conversation. Finish your work now and end with a short record of what you checked: plain notes, no title or label. Nothing else is posted."
            : `Posted${gif ? " with a GIF" : ""}.${note ? ` ${note}` : ""} Finish your work now and end with a short record of what you checked (it is not posted): plain notes, no title or label. Nothing else is posted.`,
        data: { handedOff: { messageId: handed.delivered.message.id } },
      };
    },
  };
  // The same tool with `gif` where the agent may send one; the call checks again.
  const withGif: ToolDefinition = {
    ...tool,
    description: `${tool.description}${GIF_HELP}`,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...(tool.inputSchema.properties as Record<string, unknown>), gif: GIF_PROPERTY },
    },
  };
  return {
    name: "hand_off",
    tools: async (ctx) => {
      if (!ctx.background) return [];
      const gif = ctx.runId && deps.gif ? await deps.gif.offered(ctx) : false;
      return [gif ? withGif : tool];
    },
  };
}
