import { createHash } from "node:crypto";
import type { PubSub } from "@agenteschat/adapters";
import { PERMISSION_TOOL } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, gt, inArray, isNull, or, schema, sql } from "@agenteschat/db";
import { accountablePerson, messageRoot, type RunAuthority } from "./authority";
import {
  AUTONOMY_DEFAULTS,
  type AutonomySettings,
  autonomySettings,
  COST_KINDS,
  type CostKind,
  inLine,
  LONG_STEPS,
  mayCall,
} from "./autonomy-settings";
import { crowdedAgents } from "./computer-queue";
import { publishDelivery } from "./delivery";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishMessageCreated } from "./events";
import { cutText } from "./format";
import type { Judge } from "./judge";
import { insertMessage, type Message, messageView } from "./messages";
import { can, requireActiveMembership } from "./organizations";
import { enqueue } from "./outbox";
import { ACTIVE_RUN_STATUSES } from "./run-inbox";
import { deliverNoticeToRun } from "./run-resume";
import { type AgentRun, replyThreadOf } from "./runs";

export { AUTONOMY_DEFAULTS, type AutonomySettings, autonomySettings, COST_KINDS, type CostKind, LONG_STEPS, mayCall };

const { agents, agentRuns, autonomySignals, messages, organizationMembers } = schema;

/**
 * Autonomy brakes (ADR 0131): agents stay proactive, but work nobody asked for directly is bounded. Asking waits for
 * the answer (`endsAsking`), costly unrequested steps get a person's go first (`costlyGate`), one item is worked once
 * (`brakeWakes`: open work is linked, noise goes to a digest, repeats stop), parallel unrequested work has caps, and an
 * agent calls only the agents its settings allow (`callableAgents`). What a person asked is never held by these.
 */

// --- 1. Asking means waiting -------------------------------------------------------------------------------

/**
 * The reply ends asking something (its last line is a question): the person decides, so the run waits for them. Code
 * blocks and trailing marks, quotes and emoji don't count.
 */
export function endsAsking(text: string): boolean {
  const lines = text
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last) return false;
  return /\?[\s"'»”’)*_~\p{Extended_Pictographic}]*$/u.test(last.replace(/\uFE0F/g, ""));
}

// --- 3. Costly unrequested work needs a go ------------------------------------------------------------------

const PR_COMMAND = /\b(?:gh\s+pr\s+create|glab\s+mr\s+create|hub\s+pull-request)\b/;
const INSTALL_COMMAND =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)|pipx?\s+install|pip3\s+install|uv\s+(?:add|pip\s+install)|poetry\s+add|(?:apt|apt-get|brew|cargo|gem|go)\s+install)\b/;
const PR_TOOL = /(?:create|open)_?(?:a_)?(?:pull_?request|merge_?request)|(?:pull_?request|merge_?request)_?create/i;

const commandOf = (input: Record<string, unknown>) => (typeof input.command === "string" ? input.command : "");

/**
 * What a tool call costs, if it is a costly step (`CostKind`): a computer command (asked through the permission
 * prompt, or run directly) that opens a PR or installs packages, or a connector's tool that opens a PR.
 */
export function costlyKind(name: string, input: Record<string, unknown>): CostKind | null {
  if (name === PERMISSION_TOOL) {
    const inner = input.input;
    return inner && typeof inner === "object" && !Array.isArray(inner)
      ? costlyKind(typeof input.tool_name === "string" ? input.tool_name : "", inner as Record<string, unknown>)
      : null;
  }
  if (PR_TOOL.test(name)) return "pr";
  const command = commandOf(input);
  if (PR_COMMAND.test(command)) return "pr";
  if (INSTALL_COMMAND.test(command)) return "install";
  return null;
}

/**
 * Who is behind a run decides whether the brakes apply: a person's request never meets them, nor a routine's own run
 * (its brief, which every routine may act on, is its creator's go). What the brakes hold is the rest: work a routine's
 * report, a webhook or an agent's own chain started (`unattended`).
 */
export const unrequested = (authority: RunAuthority | null) => authority?.kind === "unattended";

/**
 * Work an agent started on its own, which nobody set up (§3's proposal): its chain roots in an agent's own work. What
 * a source the workspace pointed at the agent sends (a routine's report or work, a webhook, a connector's trigger) is
 * work a person asked for: it goes ahead on real items, bounded by §4–7 and the hourly PR cap only.
 */
export const selfStarted = (authority: RunAuthority | null) =>
  authority?.kind === "unattended" && authority.reason === "agent";

/** A proposal card's meta (`meta.actionCard`). The card keeps its state; the signal row is the source of truth. */
export interface ProposalCard {
  kind: "autonomy_proposal";
  signalId: string;
  agentId: string;
  cost: CostKind;
  /** What it wants to do, in its words (the command or the tool, cut). */
  what: string;
  forUserId: string | null;
  state: "open" | "go" | "not_now" | "never" | "always";
  decidedByUserId: string | null;
}

export interface GateRun {
  orgId: string;
  agentId: string;
  runId: string;
  channelId: string;
  threadRootId: string;
}

export type GateRefusal = { message: string; code: string };

const PR_WINDOW_MS = 3600_000;

/**
 * The gate a costly step of unrequested work meets (ADR 0131 §3), on every brain (the Tool Gateway sees API calls,
 * bridged tools and a computer brain's permission prompts). Null: go (work a source the workspace set up sent, a person
 * said go for this run, "always", or the agent's setting is `go`; PRs within the hourly cap). Otherwise the refusal the
 * agent reads; the first one posts the proposal card for the agent's owner.
 */
export async function costlyGate(
  deps: { db: Database; pubsub?: PubSub },
  run: GateRun,
  authority: RunAuthority | null,
  cost: CostKind,
  what: string,
): Promise<GateRefusal | null> {
  if (!unrequested(authority)) return null;
  const { db } = deps;
  const [agent] = await db
    .select({ autonomy: agents.autonomyBrakes, ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.orgId, run.orgId), eq(agents.id, run.agentId)));
  const settings = autonomySettings(agent?.autonomy);
  const own = selfStarted(authority);
  if (own && settings.never.includes(cost))
    return {
      code: "autonomy.never",
      message: `A person said never to ${COST_WORDS[cost]} for work nobody asked for. Don't do it; say in one line what you would have done, and stop.`,
    };
  const signals = await db
    .select({ id: autonomySignals.id, kind: autonomySignals.kind, state: autonomySignals.state })
    .from(autonomySignals)
    .where(
      and(
        eq(autonomySignals.orgId, run.orgId),
        eq(autonomySignals.runId, run.runId),
        eq(autonomySignals.kind, "proposal"),
        eq(autonomySignals.signature, cost),
      ),
    );
  const said = signals.find((s) => s.state !== "open")?.state;
  if (said === "not_now" || said === "never")
    return {
      code: "autonomy.declined",
      message: `A person said no to ${COST_WORDS[cost]} for this. Don't do it; finish without it and say what is left.`,
    };
  const go = !own || settings.costly === "go" || settings.go.includes(cost) || said === "go" || said === "always";
  if (go) {
    if (cost !== "pr") return null;
    const [opened] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(autonomySignals)
      .where(
        and(
          eq(autonomySignals.orgId, run.orgId),
          eq(autonomySignals.agentId, run.agentId),
          eq(autonomySignals.kind, "pr"),
          gt(autonomySignals.createdAt, new Date(Date.now() - PR_WINDOW_MS)),
        ),
      );
    if (Number(opened?.n ?? 0) >= settings.maxPrsPerHour)
      return {
        code: "autonomy.pr_limit",
        message: `You already opened ${settings.maxPrsPerHour} PRs in the last hour for work nobody asked for (the limit in your settings). Don't open another now: list what is left in your reply and stop.`,
      };
    await db.insert(autonomySignals).values({
      orgId: run.orgId,
      agentId: run.agentId,
      kind: "pr",
      runId: run.runId,
      channelId: run.channelId,
      title: cutText(what, 200),
    });
    return null;
  }
  if (signals.some((s) => s.state === "open")) return waitingRefusal(cost);
  await proposeCostly(
    deps,
    run,
    (authority ? accountablePerson(authority) : null) ?? agent?.ownerUserId ?? null,
    cost,
    what,
  );
  return waitingRefusal(cost);
}

const COST_WORDS: Record<CostKind, string> = {
  pr: "opening a pull request",
  install: "installing packages",
  long: `going on past ${LONG_STEPS} steps`,
};

const waitingRefusal = (cost: CostKind): GateRefusal => ({
  code: "autonomy.needs_go",
  message: `Nobody asked for this directly, and ${COST_WORDS[cost]} is costly: a card now asks the person responsible whether to go ahead. Don't try it another way. End your turn with one short line of what you found and what you'd do; you'll be told their answer.`,
});

/** Posts the proposal card where the run answers, for `forUserId` (notified as the card's person). */
async function proposeCostly(
  deps: { db: Database; pubsub?: PubSub },
  run: GateRun,
  forUserId: string | null,
  cost: CostKind,
  what: string,
) {
  const message = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, run.orgId), eq(agentRuns.id, run.runId)));
    if (!row) return null;
    const [signal] = await tx
      .insert(autonomySignals)
      .values({
        orgId: run.orgId,
        agentId: run.agentId,
        kind: "proposal",
        signature: cost,
        title: cutText(what, 300),
        channelId: run.channelId,
        runId: run.runId,
        state: "open",
      })
      .returning();
    if (!signal) return null;
    const card: ProposalCard = {
      kind: "autonomy_proposal",
      signalId: signal.id,
      agentId: run.agentId,
      cost,
      what: signal.title,
      forUserId,
      state: "open",
      decidedByUserId: null,
    };
    const posted = await insertMessage(tx, {
      orgId: run.orgId,
      channelId: run.channelId,
      threadId: replyThreadOf(row),
      author: { type: "agent", agentId: run.agentId, runId: run.runId, hop: row.hop },
      body: `Nobody asked for this directly: may I go ahead with ${COST_WORDS[cost]}? ${signal.title}`,
      meta: { actionCard: card, bodyCode: "autonomy_proposal", bodyParams: { cost } },
    });
    await tx.update(autonomySignals).set({ messageId: posted.id }).where(eq(autonomySignals.id, signal.id));
    await enqueue(tx, {
      orgId: run.orgId,
      kind: "notifications.message",
      payload: { messageId: posted.id },
      dedupeKey: `notifications.message:${posted.id}`,
      maxAttempts: 4,
    });
    return posted;
  });
  if (message && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
}

/** A message's proposal card, or null. */
export function proposalCardOf(meta: Record<string, unknown> | null | undefined): ProposalCard | null {
  const c = meta?.actionCard as Partial<ProposalCard> | undefined;
  return c?.kind === "autonomy_proposal" && typeof c.signalId === "string" ? (c as ProposalCard) : null;
}

export type ProposalDecision = "go" | "not_now" | "never" | "always";
export const PROPOSAL_DECISIONS: readonly ProposalDecision[] = ["go", "not_now", "never", "always"];

/**
 * A person decides a proposal card: the person it is for (`go`, `not_now`), the agent's owner or an admin (also
 * `always` and `never`). `always` and `never` are remembered on the agent (`autonomy.go` / `autonomy.never`) for that kind; every decision reaches the run that asked
 * as a notice, which wakes it.
 */
export async function decideCostlyProposal(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  signalId: string,
  decision: ProposalDecision,
) {
  if (!PROPOSAL_DECISIONS.includes(decision)) throw new ValidationError("Unknown decision");
  const { db } = deps;
  const [signal] = await db
    .select()
    .from(autonomySignals)
    .where(
      and(eq(autonomySignals.orgId, orgId), eq(autonomySignals.id, signalId), eq(autonomySignals.kind, "proposal")),
    );
  if (!signal?.messageId) throw new NotFoundError("Proposal not found");
  const [message] = await db
    .select({ meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, signal.messageId)));
  const card = proposalCardOf(message?.meta);
  const [agent] = await db
    .select({ ownerUserId: agents.ownerUserId, autonomy: agents.autonomyBrakes, handle: agents.handle })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, signal.agentId)));
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [member] = await db
    .select({ handle: organizationMembers.handle })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, actorId)));
  if (!card || !agent || !member) throw new NotFoundError("Proposal not found");
  const manages = actorId === agent.ownerUserId || can(membership, "manage_agents");
  if (actorId !== card.forUserId && !manages) throw new NotFoundError("Proposal not found");
  // "Always" and "never" change the agent for everyone's work: only who may change the agent.
  if ((decision === "always" || decision === "never") && !manages)
    throw new ForbiddenError("Only the agent's owner or an admin can decide this for every time");
  const cost = signal.signature as CostKind;
  const out = await db.transaction(async (tx) => {
    const [decided] = await tx
      .update(autonomySignals)
      .set({ state: decision, decidedByUserId: actorId, doneAt: new Date() })
      .where(and(eq(autonomySignals.id, signalId), eq(autonomySignals.state, "open")))
      .returning();
    if (!decided) return null;
    const next: ProposalCard = { ...card, state: decision, decidedByUserId: actorId };
    const [updated] = await tx
      .update(messages)
      .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard}', ${JSON.stringify(next)}::jsonb)` })
      .where(and(eq(messages.orgId, orgId), eq(messages.id, signal.messageId as string)))
      .returning();
    if (decision === "always" || decision === "never") {
      const s = autonomySettings(agent.autonomy);
      const add = (list: CostKind[]) => [...new Set([...list, cost])];
      const remember =
        decision === "always"
          ? { go: add(s.go), never: s.never.filter((k) => k !== cost) }
          : { never: add(s.never), go: s.go.filter((k) => k !== cost) };
      await tx
        .update(agents)
        .set({
          autonomyBrakes: sql`${agents.autonomyBrakes} || ${JSON.stringify(remember)}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(eq(agents.orgId, orgId), eq(agents.id, signal.agentId)));
    }
    const [run] = signal.runId
      ? await tx
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, signal.runId)))
      : [];
    const go = decision === "go" || decision === "always";
    const who = member.handle ? `@${member.handle}` : "The person";
    const delivered = run
      ? await deliverNoticeToRun(tx, run, {
          kind: "proposal_result",
          text: go
            ? `${who} said go: you may go ahead with ${COST_WORDS[cost]} (${signal.title}). Do it now and report what came of it.`
            : `${who} said ${decision === "never" ? "never" : "not now"} to ${COST_WORDS[cost]} (${signal.title}). Don't do it; finish without it in one short line.`,
          refs: { runId: run.id, signalId },
        })
      : null;
    // The asking run usually ended before anyone clicked: the notice wakes a run of its own, which carries the
    // decision, so its retry finds it instead of posting another card.
    const woken = (delivered?.runs ?? []).filter((r) => r.id !== signal.runId);
    if (woken.length > 0)
      await tx.insert(autonomySignals).values(
        woken.map((r) => ({
          orgId,
          agentId: signal.agentId,
          kind: "proposal",
          signature: cost,
          title: signal.title,
          channelId: r.channelId,
          runId: r.id,
          state: decision,
          decidedByUserId: actorId,
          doneAt: new Date(),
        })),
      );
    return { updated, delivered };
  });
  if (!out) throw new ConflictError("This proposal was already decided");
  if (out.updated && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(out.updated));
  if (out.delivered) await publishDelivery(deps.pubsub, out.delivered);
  return { state: decision };
}

// --- 4–7. One item is worked once, noise waits for a digest, repeats stop, caps -----------------------------

/** A first line that reports a failure: an error, an exception, a crash, a timeout, a freeze. */
const FAILURE_LINE =
  /error|exception|traceback|panic|fatal|crash|timeout|timed out|\bANR\b|freeze|\bfail|\bfalh|\berro\b|travou/i;
/** A link to one item (an issue, an event, a run, a PR): some segment of its path carries a number. */
const ITEM_PATH = /\/[^/]*\d[^/]*(?:\/|$)/;

/**
 * The item a message is about, as a stable fingerprint: its first link to one item (an issue's or an error's page,
 * without the query), else its first line with numbers, ids and hashes taken out. `alert`: it reports one item (that
 * link, or a failure line), the only kind duplicates and repeats are counted for (§4, §6); a hand-off, a question or a
 * recurring report with a dashboard's link is not one. Null when there is nothing to key on.
 */
export function signatureOf(body: string): { key: string; title: string; alert: boolean } | null {
  const text = body.replace(/```[\s\S]*?```/g, " ");
  const url = /https?:\/\/[^\s)>\]]+/i.exec(text)?.[0];
  const first =
    text
      .split("\n")
      .map((l) =>
        l
          .replace(/https?:\/\/\S+/g, "")
          .replace(/@[\w-]+/g, "")
          .replace(/[*_`#>]/g, "")
          .trim(),
      )
      .find((l) => l.length >= 4) ?? "";
  const normalized = first
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "#")
    .replace(/\b[0-9a-f]{7,}\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const link = url?.split(/[?#]/)[0]?.replace(/\/+$/, "").toLowerCase();
  const item = link ? ITEM_PATH.test(link.replace(/^https?:\/\/[^/]+/, "")) : false;
  const basis = item ? link : normalized || link;
  if (!basis) return null;
  return {
    key: createHash("sha256").update(basis).digest("hex").slice(0, 32),
    title: cutText(unmention(first || url || ""), 200),
    alert: item || FAILURE_LINE.test(first),
  };
}

/** Text quoted back into the chat never wakes anyone: its @handles lose the @. */
const unmention = (text: string) => text.replace(/@(?=[\w-])/g, "");

/** Runs of an agent on one item within this window are attempts at it; past `LOOP_MAX` it stops and asks. */
export const LOOP_WINDOW_MS = 24 * 3600_000;
export const LOOP_MAX = 3;
/**
 * A deferred wake looks again this often for an hour (`LATER_LOOKS`), then every `LATER_SLOW_LOOK_MS`; after a day
 * (`LATER_MAX_LOOKS`) it starts anyway. Work held only for room is never dropped, nor told apart as noise; a note
 * another agent waits on ends sooner, with why (`CONSULTATION_HUNG_MS`).
 */
export const LATER_LOOK_MS = 2 * 60_000;
export const LATER_LOOKS = 30;
export const LATER_SLOW_LOOK_MS = 15 * 60_000;
export const LATER_MAX_LOOKS = LATER_LOOKS + 23 * 4;
export const LATER_JOB = "autonomy.later";

export type BrakeOutcome = "linked" | "digest" | "loop" | "later";

/**
 * Where people hear about a held item (the digest, the loop stop): the message's own conversation, or for a note into
 * agents' private DM, the conversation of the run that sent it.
 */
export interface BrakeReport {
  channelId: string;
  threadId: string | null;
}

/** The cheap triage a wake on an unrequested item meets (ADR 0131 §5): work on it now, or noise for the digest. */
export async function triageItem(judge: Judge, input: { orgId: string; agentId: string | null; body: string }) {
  const answers = await judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    kind: "alert_triage",
    state: { message: cutText(input.body, 2000) },
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "A routine, a webhook or an agent posted `message` to wake an AI agent nobody asked directly. Should the agent start work on it now?",
        criteria: {
          work: "A request, a question, a hand-off, or a problem that is new, growing or high impact (many users, data loss, an outage, a security issue, a regression just shipped).",
          noise:
            "An alert or error report that is known, old, recurring at a low rate, benign or expected (a known freeze, a timeout that retries, a third-party blip, a client-side error from old versions): nothing to do now beyond a summary for a person.",
        },
      },
    },
  });
  const p = answers.verdict?.probabilities?.noise ?? (answers.verdict?.choice === "noise" ? 1 : 0);
  return p >= 0.6 ? ("noise" as const) : ("work" as const);
}

/**
 * The brakes on agents' wakes from a message nobody asked for directly (its chain roots in a routine, a webhook or an
 * agent's own work): per agent, open work on the same item takes it (`linked`, a note to that run), an item it already
 * tried `LOOP_MAX` times in a day stops (`loop`, one summary to a person), noise waits for the digest (`digest`), and
 * an agent at its cap of unrequested runs, or (for a routine's or a webhook's item) whose computer has turns waiting for
 * room, looks again later (`later`).
 * Returns the agents to wake now; every outcome is recorded (`autonomy_signals`).
 */
export async function brakeWakes(
  deps: { db: Database; pubsub?: PubSub; judge?: Judge | null },
  message: Message,
  agentIds: string[],
  options: { look?: number; reportIn?: BrakeReport } = {},
): Promise<{ wake: string[]; held: Map<string, BrakeOutcome> }> {
  const held = new Map<string, BrakeOutcome>();
  if (agentIds.length === 0) return { wake: [], held };
  const { db } = deps;
  const root = await messageRoot(db, message.orgId, message.id);
  if (root.kind === "person") return { wake: agentIds, held };
  const sig = signatureOf(message.body);
  let triage: "work" | "noise" | null = null;
  // A full computer defers new work that a routine or a webhook started; agents' own chains already wait in calm
  // wakes' inbox and ranks (ADR 0032).
  const crowded =
    root.kind === "routine" || root.kind === "routine_report"
      ? await crowdedAgents(db, message.orgId, agentIds)
      : new Set<string>();
  for (const agentId of agentIds) {
    const outcome = await brakeOne(
      deps,
      message,
      agentId,
      sig,
      crowded.has(agentId),
      async () => {
        if (triage === null)
          triage = deps.judge
            ? await triageItem(deps.judge, { orgId: message.orgId, agentId, body: message.body }).catch(
                () => "work" as const,
              )
            : "work";
        return triage;
      },
      options.look ?? 0,
      options.reportIn ?? { channelId: message.channelId, threadId: message.threadId ?? message.id },
    );
    if (outcome) held.set(agentId, outcome);
  }
  return { wake: agentIds.filter((id) => !held.has(id)), held };
}

/** A wake recorded this recently whose run doesn't exist yet counts as open work on its item (it is starting). */
const STARTING_MS = 5 * 60_000;

async function brakeOne(
  deps: { db: Database; pubsub?: PubSub },
  message: Message,
  agentId: string,
  sig: { key: string; title: string; alert: boolean } | null,
  crowded: boolean,
  triage: () => Promise<"work" | "noise">,
  look: number,
  at: BrakeReport,
): Promise<BrakeOutcome | null> {
  const { db } = deps;
  const orgId = message.orgId;
  const record = (tx: Executor, kind: string, extra: { runId?: string | null; doneAt?: Date } = {}) =>
    tx
      .insert(autonomySignals)
      .values({
        orgId,
        agentId,
        kind,
        signature: sig?.key ?? null,
        title: sig?.title ?? cutText(unmention(message.body), 200),
        channelId: at.channelId,
        messageId: message.id,
        runId: extra.runId ?? null,
        ...(extra.doneAt ? { doneAt: extra.doneAt } : {}),
      })
      .returning({ id: autonomySignals.id });
  // The item's wake, claimed under a lock with the checks so two reports of one item at once start one run; it
  // becomes what the rest decides.
  let claim: string | null = null;
  if (sig?.alert) {
    const key = sig.key;
    const checked = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`autonomy:${agentId}:${key}`}))`);
      // §4: open work on the same item (a run still at it, or one just starting) takes the new report.
      const [open] = await tx
        .select({ run: agentRuns })
        .from(autonomySignals)
        .leftJoin(
          agentRuns,
          and(
            eq(agentRuns.triggerMessageId, autonomySignals.messageId),
            eq(agentRuns.agentId, autonomySignals.agentId),
          ),
        )
        .where(
          and(
            eq(autonomySignals.orgId, orgId),
            eq(autonomySignals.agentId, agentId),
            eq(autonomySignals.signature, key),
            eq(autonomySignals.kind, "wake"),
            or(
              inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
              and(isNull(agentRuns.id), gt(autonomySignals.createdAt, new Date(Date.now() - STARTING_MS))),
            ),
          ),
        )
        .orderBy(desc(autonomySignals.createdAt))
        .limit(1);
      if (open) {
        await record(tx, "linked", { runId: open.run?.id ?? null, doneAt: new Date() });
        return { linked: open.run };
      }
      // §6: tried too often lately: stop, and tell a person once per window.
      const [tries] = await tx
        .select({
          n: sql<number>`count(*)::int`,
          stopped: sql<number>`count(*) filter (where ${autonomySignals.kind} = 'loop')::int`,
        })
        .from(autonomySignals)
        .where(
          and(
            eq(autonomySignals.orgId, orgId),
            eq(autonomySignals.agentId, agentId),
            eq(autonomySignals.signature, key),
            inArray(autonomySignals.kind, ["wake", "loop"]),
            gt(autonomySignals.createdAt, new Date(Date.now() - LOOP_WINDOW_MS)),
          ),
        );
      if (Number(tries?.n ?? 0) - Number(tries?.stopped ?? 0) >= LOOP_MAX) {
        await record(tx, "loop", { doneAt: new Date() });
        return { loop: Number(tries?.stopped ?? 0) === 0 };
      }
      const [row] = await record(tx, "wake");
      return { claim: row?.id ?? null };
    });
    if ("linked" in checked) {
      const run = checked.linked;
      if (run) {
        const delivered = await db.transaction((tx) =>
          deliverNoticeToRun(tx, run, {
            kind: "agent_note",
            text: `The same item was reported again (${sig.title}). You are already on it in this run: don't start it over; include it in your report.`,
            refs: { runId: run.id, messageId: message.id },
          }),
        );
        await publishDelivery(deps.pubsub, delivered);
      }
      return "linked";
    }
    if ("loop" in checked) {
      if (checked.loop) await postLoopStop(deps, message, at, agentId, sig.title);
      return "loop";
    }
    claim = checked.claim;
  }
  const unclaim = async (kind: string | null) => {
    if (!claim) return;
    if (kind) await db.update(autonomySignals).set({ kind }).where(eq(autonomySignals.id, claim));
    else await db.delete(autonomySignals).where(eq(autonomySignals.id, claim));
    claim = null;
  };
  // §5: noise goes to the next digest, not to work.
  if ((await triage().catch(() => "work" as const)) === "noise") {
    if (claim) await unclaim("digest");
    else await record(db, "digest");
    return "digest";
  }
  // §7: at its cap of unrequested runs, or its computer already has turns waiting: later.
  if (look < LATER_MAX_LOOKS && (crowded || (await unrequestedAtCap(db, orgId, agentId)))) {
    await unclaim(null);
    await enqueue(db, {
      orgId,
      kind: LATER_JOB,
      payload: { messageId: message.id, agentId, look: look + 1, reportIn: at },
      dedupeKey: `${LATER_JOB}:${message.id}:${agentId}:${look + 1}`,
      runAt: new Date(Date.now() + (look < LATER_LOOKS ? LATER_LOOK_MS : LATER_SLOW_LOOK_MS)),
    });
    if (look === 0) await record(db, "later", { doneAt: new Date() });
    return "later";
  }
  if (!claim) await record(db, "wake");
  return null;
}

/** Whether an agent already has as many unrequested runs going as its settings allow. */
async function unrequestedAtCap(db: Executor, orgId: string, agentId: string) {
  const [agent] = await db
    .select({ autonomy: agents.autonomyBrakes })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  const max = autonomySettings(agent?.autonomy).maxUnrequested;
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${agentRuns.id})::int` })
    .from(autonomySignals)
    .innerJoin(
      agentRuns,
      and(eq(agentRuns.triggerMessageId, autonomySignals.messageId), eq(agentRuns.agentId, autonomySignals.agentId)),
    )
    .where(
      and(
        eq(autonomySignals.orgId, orgId),
        eq(autonomySignals.agentId, agentId),
        eq(autonomySignals.kind, "wake"),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
      ),
    );
  return Number(row?.n ?? 0) >= max;
}

/** The person who hears about an agent's unrequested work: its owner. */
async function ownerOfAgent(db: Executor, orgId: string, agentId: string) {
  const [a] = await db
    .select({ ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  return a?.ownerUserId ?? null;
}

/** One line where the item came in: the agent stopped after repeated attempts and asks a person (§6). */
async function postLoopStop(
  deps: { db: Database; pubsub?: PubSub },
  message: Message,
  at: BrakeReport,
  agentId: string,
  title: string,
) {
  const forUserId = await ownerOfAgent(deps.db, message.orgId, agentId);
  const posted = await deps.db.transaction(async (tx) => {
    const m = await insertMessage(tx, {
      orgId: message.orgId,
      channelId: at.channelId,
      threadId: at.threadId,
      author: { type: "agent", agentId, runId: null, hop: message.hop + 1, stretchId: message.stretchId },
      body: `I stopped working on this on my own: it came back ${LOOP_MAX} times in a day (${title}). Tell me how you want it handled.`,
      meta: {
        autonomyNote: { kind: "loop", forUserId },
        bodyCode: "autonomy_loop",
        bodyParams: { count: String(LOOP_MAX), title },
      },
    });
    await enqueue(tx, {
      orgId: message.orgId,
      kind: "notifications.message",
      payload: { messageId: m.id },
      dedupeKey: `notifications.message:${m.id}`,
      maxAttempts: 4,
    });
    return m;
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(posted));
}

/** A digest goes out once its oldest item waited this long. */
export const DIGEST_AFTER_MS = 3600_000;

/**
 * The noise digest (§5): per agent and conversation, the items held as noise for at least `DIGEST_AFTER_MS` go out as
 * one summary line, for the agent's owner. Returns how many digests were posted.
 */
export async function postAutonomyDigests(deps: { db: Database; pubsub?: PubSub }, now = new Date()) {
  const { db } = deps;
  const due = await db
    .select({
      orgId: autonomySignals.orgId,
      agentId: autonomySignals.agentId,
      channelId: autonomySignals.channelId,
    })
    .from(autonomySignals)
    .where(and(eq(autonomySignals.kind, "digest"), isNull(autonomySignals.doneAt)))
    .groupBy(autonomySignals.orgId, autonomySignals.agentId, autonomySignals.channelId)
    .having(
      sql`min(${autonomySignals.createdAt}) <= ${new Date(now.getTime() - DIGEST_AFTER_MS).toISOString()}::timestamptz`,
    );
  let posted = 0;
  for (const d of due) {
    if (!d.channelId) continue;
    const forUserId = await ownerOfAgent(db, d.orgId, d.agentId);
    const message = await db.transaction(async (tx) => {
      const items = await tx
        .update(autonomySignals)
        .set({ doneAt: now })
        .where(
          and(
            eq(autonomySignals.orgId, d.orgId),
            eq(autonomySignals.agentId, d.agentId),
            eq(autonomySignals.channelId, d.channelId as string),
            eq(autonomySignals.kind, "digest"),
            isNull(autonomySignals.doneAt),
          ),
        )
        .returning({ title: autonomySignals.title, signature: autonomySignals.signature });
      if (items.length === 0) return null;
      const grouped = new Map<string, { title: string; n: number }>();
      for (const i of items) {
        const key = i.signature ?? i.title;
        const g = grouped.get(key);
        if (g) g.n++;
        else grouped.set(key, { title: i.title, n: 1 });
      }
      const lines = [...grouped.values()]
        .slice(0, 15)
        .map((g) => `• ${g.title}${g.n > 1 ? ` ×${g.n}` : ""}`)
        .join("\n");
      const m = await insertMessage(tx, {
        orgId: d.orgId,
        channelId: d.channelId as string,
        author: { type: "agent", agentId: d.agentId, runId: null, hop: 1, stretchId: null },
        body: `${items.length} alerts looked known or harmless, so I didn't work on them:\n${lines}`,
        meta: {
          autonomyNote: { kind: "digest", forUserId },
          bodyCode: "autonomy_digest",
          bodyParams: { count: String(items.length), lines },
        },
      });
      await enqueue(tx, {
        orgId: d.orgId,
        kind: "notifications.message",
        payload: { messageId: m.id },
        dedupeKey: `notifications.message:${m.id}`,
        maxAttempts: 4,
      });
      return m;
    });
    if (message) {
      posted++;
      if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
    }
  }
  return posted;
}

/** Who a message's `meta.autonomyNote` is for (the digest and the loop stop): notified like an agent's answer. */
export const autonomyNoteFor = (meta: Record<string, unknown> | null | undefined): string | null => {
  const n = meta?.autonomyNote as { forUserId?: unknown } | undefined;
  return typeof n?.forUserId === "string" ? n.forUserId : null;
};

// --- 8. Who an agent may call -------------------------------------------------------------------------------

/**
 * Of `targetIds`, the agents `fromAgentId` may wake or hand work to (§8): its `callAgents` setting, and agents of
 * another project only when it allows other projects. A person's own mentions never pass through here.
 */
export async function callableAgents(
  db: Executor,
  orgId: string,
  fromAgentId: string,
  targetIds: string[],
): Promise<Set<string>> {
  if (targetIds.length === 0) return new Set();
  const rows = await db
    .select({ id: agents.id, autonomy: agents.autonomyBrakes, reportsToAgentId: agents.reportsToAgentId })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, [...new Set([fromAgentId, ...targetIds])])));
  const from = rows.find((r) => r.id === fromAgentId);
  return new Set(
    targetIds.filter((id) => {
      const to = rows.find((r) => r.id === id);
      return (!!from && !!to && inLine(from, to)) || mayCall(from?.autonomy, { id, autonomy: to?.autonomy });
    }),
  );
}

/** What an agent reads when its settings kept it from calling `handles`. */
export const notCallableText = (handles: string[]) =>
  `Your settings don't let you call ${handles.join(", ")} (another project, or not on your list of agents to call). Don't mention or hand work to ${handles.length === 1 ? "it" : "them"}; do it yourself or tell the person.`;

/** Why an agent's mention didn't wake an agent its settings don't let it call (`tellWakeSkipped`). */
export const notCallableWhy = (handle: string) =>
  `your settings don't let you call @${handle} (another project, or not on your list of agents to call), so do that part yourself`;

export type { AgentRun };

/**
 * The agent's last word in a run's conversation asks the person something, and nobody wrote since (§1): what it set
 * up to come back by itself (a follow-up) waits for their answer instead.
 */
export async function askStillOpen(
  db: Executor,
  run: Pick<AgentRun, "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId">,
) {
  const thread = replyThreadOf(run);
  const [last] = await db
    .select({ authorAgentId: messages.authorAgentId, body: messages.body })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        thread ? eq(messages.threadId, thread) : isNull(messages.threadId),
        isNull(messages.deletedAt),
        sql`${messages.meta}->'notice' is null`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return last?.authorAgentId === run.agentId && endsAsking(last.body);
}
