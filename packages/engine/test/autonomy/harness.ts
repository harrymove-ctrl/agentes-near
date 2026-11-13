import { and, asc, eq, gt, inArray, lte, schema } from "@agenteschat/db";
import { type ModelRequest, systemText, textOf } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import {
  type Agent,
  addChannelMember,
  createAgent,
  createChannel,
  createJobHandlers,
  createPassToolSource,
  drainOutbox,
  grantScopes,
  insertMessage,
  type JudgeQuestion,
  openDm,
  postPersonMessage,
  type RouterStrategy,
  type RoutingResult,
} from "../../src";
import { addMember, type Fixture, setup } from "../fixtures";

/**
 * The autonomy scenarios' world (ops design "autonomy as invariants", §4.1): one workspace on PGlite with several
 * agents and people, every agent answering from its own script through the fake provider, the router's step and
 * every judgment answered from the scenario's tables, and the outbox drained to quiescence. Everything else is the
 * real engine: routing, mention wakes, authority, follow-through, consultations, routines.
 */

/** One model call of an agent: what it writes, the tools it calls, or a provider error it throws. */
export interface Turn {
  text?: string;
  calls?: { name: string; input: Record<string, unknown> }[];
  error?: Error;
  hold?: Promise<unknown>;
}

export interface TurnContext {
  /** This agent's model calls so far, this one included (1-based). */
  n: number;
  /** The text of the request's last message (a person's message, a tool result, a nudge). */
  last: string;
  system: string;
  request: ModelRequest;
}

/** An agent's script: its calls in order, or a function of each call (undefined: unscripted). */
export type Script = Turn[] | ((ctx: TurnContext) => Turn | undefined);

/** What the router's step answers for a message (by its body): scores by handle, as Jev would. */
export interface Route {
  needs: number;
  scores?: Record<string, number>;
  everyone?: number;
  alreadyAnswered?: number;
  /** The handle the message speaks to (router-continuity's `addressee`). */
  addressee?: string;
  /** Jev's tie-break Choice: handle and confidence. */
  best?: [string, number];
  /** The router's step fails on it (an outage). */
  fail?: true;
}

/** How the follow-through (or continuation) judgment reads a turn's end, in the controller's words. */
export type Verdict = "done" | "continue" | "ask" | "untried" | "secret";

export interface JudgeTable {
  /**
   * The end-of-turn judgment. A verdict is mapped onto main's question (`continue` → `unkept`, `ask` → `waiting`);
   * `{ main, controller }` when the two questions read the same turn differently (main counts an offer as done).
   */
  followThrough?: (state: Record<string, unknown>) => Verdict | { main: Verdict; controller: Verdict };
  /**
   * An agent's @mention of `handle`: main asks "is it a hand-off?" (`handoff`), wake-by-default asks "does it need
   * nothing?" (`needsNothing`). Default: a plain hand-off (0.9 / 0.05). `"fail"`: the judge errors.
   */
  mention?: Record<string, { handoff: number; needsNothing: number } | "fail">;
  /** `stuck_run`: probability the run goes in circles. */
  stuck?: number;
  /** `note_reply`: whether a note's reply matters to its sender (default 0.9). */
  noteReply?: number;
  /** `ask_check`: what an `ask_user` question asks for (default: something only a person can give); "fail" errors. */
  ask?: (state: Record<string, unknown>) => "findable" | "secret" | "person" | "none" | "fail";
  /** `alert_triage` (ADR 0131 §5): whether an unrequested item is work now or noise for the digest (default work). */
  triage?: (state: Record<string, unknown>) => "work" | "noise";
  /** `held_reply`: what goes out after a reply held back as untried (default: the new words alone). */
  heldReply?: (state: Record<string, unknown>) => "reply" | "both" | "held";
}

/** Judgments the engine asks along the way that the scenarios leave at the fake's defaults. */
const INCIDENTAL = new Set([
  "tool_groups",
  "stop_request",
  "agent_status",
  "context_budget",
  "ai_intent",
  "status_fits",
  "memory_relation",
  "mention_addressees",
  "auto_model",
  "handoff_reply",
  "permission_change",
  "connector_tool_level",
  "agent_media",
]);

export interface WorldOptions {
  /** Agent handles; each is in the channel. Its name is the handle capitalized. */
  agents: string[];
  /** People besides the owner (`ana`), in the workspace and the channel. */
  people?: string[];
  script?: Record<string, Script>;
  judge?: JudgeTable;
  /** The router step's answer per message body; any other body: nobody needed. */
  route?: Record<string, Route>;
  /** The conversation is a DM between the owner and this agent (else the channel `#produto`). */
  dmWith?: string;
  /** Extra fixture options (tools). */
  setup?: Parameters<typeof setup>[0];
}

export type World = Awaited<ReturnType<typeof world>>;

const open: { close(): Promise<void> }[] = [];

/** Closes every world the test made (`afterEach(closeWorlds)`). */
export async function closeWorlds() {
  for (let w = open.pop(); w; w = open.pop()) await w.close();
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export async function world(options: WorldOptions) {
  const scripts = options.script ?? {};
  const counts = new Map<string, number>();
  const unscripted: { handle: string; last: string }[] = [];
  const unknownJudgments: string[] = [];
  const judgments: { kind: string; state: Record<string, unknown> }[] = [];
  const asked = new WeakSet<object>();
  const table = options.judge ?? {};

  const reply = (request: ModelRequest): FakeReply | Error => {
    // Structured calls (summaries, classifiers) are no agent's turn.
    if (request.outputSchema) return { chunks: ["{}"] };
    const system = systemText(request.system);
    const handle = /You are [^\n]*? \(@([a-z0-9_-]+)\)/.exec(system)?.[1] ?? "?";
    const n = (counts.get(handle) ?? 0) + 1;
    counts.set(handle, n);
    const lastMessage = request.messages.at(-1);
    const last = lastMessage ? textOf(lastMessage.content) : "";
    const script = scripts[handle];
    const turn = Array.isArray(script) ? script[n - 1] : script?.({ n, last, system, request });
    if (!turn) {
      unscripted.push({ handle, last: last.slice(0, 200) });
      return { chunks: ["ok"] };
    }
    if (turn.error) return turn.error;
    return {
      chunks: turn.text ? [turn.text] : [],
      ...(turn.calls?.length ? { toolUses: turn.calls } : {}),
      ...(turn.hold ? { hold: turn.hold } : {}),
    };
  };

  const judge = (
    kind: string,
    _id: string,
    state: Record<string, unknown>,
    q: JudgeQuestion,
    request: object,
  ): number | string | undefined => {
    // One judgment per call, however many questions it asks (the turn end also asks `learn`).
    if (!asked.has(request)) judgments.push({ kind, state });
    asked.add(request);
    const handleOf = () => (q.instructions as { agent?: { handle?: string } } | undefined)?.agent?.handle?.slice(1);
    switch (kind) {
      case "follow_through": {
        const choices = Object.keys((q as { criteria?: Record<string, string> }).criteria ?? {});
        const v = table.followThrough?.(state) ?? "done";
        const mainQuestion = choices.includes("unkept");
        const picked = typeof v === "string" ? v : mainQuestion ? v.main : v.controller;
        if (!mainQuestion) return choices.includes(picked) ? picked : "done";
        return picked === "continue" ? "unkept" : picked === "ask" ? "waiting" : "done";
      }
      case "mention_handoff":
      case "mention_needs_nothing": {
        const m = table.mention?.[handleOf() ?? ""];
        if (m === "fail") throw new Error("judge unavailable");
        return kind === "mention_handoff" ? (m?.handoff ?? 0.9) : (m?.needsNothing ?? 0.05);
      }
      case "stuck_run":
        return table.stuck ?? 0;
      case "ask_check": {
        const v = table.ask?.(state) ?? "person";
        if (v === "fail") throw new Error("judge unavailable");
        return v;
      }
      case "alert_triage":
        return table.triage?.(state) ?? "work";
      case "held_reply":
        return table.heldReply?.(state) ?? "reply";
      case "note_reply":
      case "note_reply_matters":
        return table.noteReply ?? 0.9;
      default:
        if (!INCIDENTAL.has(kind)) unknownJudgments.push(kind);
        return undefined;
    }
  };

  const f: Fixture = await setup({
    askAgent: true,
    askUser: true,
    followUps: true,
    handOff: true,
    chatTools: true,
    issueTools: true,
    scheduleTools: true,
    ...options.setup,
    toolSources: [createPassToolSource(), ...(options.setup?.toolSources ?? [])],
    react: true,
    reply,
    judge,
  });

  const agents: Record<string, Agent> = {};
  for (const handle of options.agents) {
    const agent = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: capitalized(handle), handle, role: "", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    agents[handle] = agent;
  }
  const people: Record<string, { id: string; name: string }> = { ana: f.owner };
  for (const name of options.people ?? []) people[name] = await addMember(f.db, f.org.id, "member", name);

  let channelId: string;
  if (options.dmWith) {
    const agent = agents[options.dmWith];
    if (!agent) throw new Error(`no agent ${options.dmWith}`);
    channelId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: agent.id })).id;
  } else {
    channelId = (await createChannel(f.db, f.owner.id, f.org.id, { name: "produto" })).id;
    for (const agent of Object.values(agents))
      await addChannelMember(f.db, f.owner.id, f.org.id, channelId, { agentId: agent.id });
    for (const [name, p] of Object.entries(people))
      if (name !== "ana") await addChannelMember(f.db, f.owner.id, f.org.id, channelId, { userId: p.id });
  }

  // The router's step, from the scenario's table (by body; a burst of messages is one body per line).
  const idOf = (handle: string) => agents[handle]?.id ?? "";
  const unrouted: string[] = [];
  const strategy: RouterStrategy = {
    name: "jev",
    async decide(input) {
      const lines = input.message.body.split("\n");
      const r = options.route?.[input.message.body] ?? options.route?.[lines.at(-1) ?? ""];
      if (!r && input.authorUserId) unrouted.push(input.message.body);
      if (r?.fail) throw new Error("router step unavailable");
      const result: RoutingResult = {
        agents: Object.entries(r?.scores ?? {}).map(([h, score]) => ({ agentId: idOf(h), score })),
        needsAgent: r?.needs ?? 0,
        forEveryone: r?.everyone ?? 0,
        alreadyAnswered: r?.alreadyAnswered ?? 0,
        reason: "scripted",
        decidedBy: { step: "jev" } as RoutingResult["decidedBy"],
      };
      if (r?.addressee) Object.assign(result, { addressee: idOf(r.addressee) });
      if (r?.best) Object.assign(result, { best: { agentId: idOf(r.best[0]), confidence: r.best[1] } });
      return result;
    },
  };
  const handlers = createJobHandlers({
    ...f.jobDeps,
    router: { enabled: true, model: "claude-haiku-5-5", strategy },
  });

  /** Runs every job that is due, retrying transient failures at once (as a worker would after its backoff). */
  async function settle() {
    for (let round = 0; round < 8; round++) {
      await drainOutbox(f.db, handlers, { maxBatches: 500 });
      const retried = await f.db
        .update(schema.outbox)
        .set({ nextAttemptAt: new Date() })
        .where(
          and(
            eq(schema.outbox.status, "pending"),
            gt(schema.outbox.attempts, 0),
            lte(schema.outbox.nextAttemptAt, new Date(Date.now() + 10 * 60_000)),
          ),
        )
        .returning({ id: schema.outbox.id });
      if (retried.length === 0) return;
    }
  }

  /** The fake clock: jobs due within `minutes` become due now, then everything settles. */
  async function advance(minutes: number) {
    await f.db
      .update(schema.outbox)
      .set({ nextAttemptAt: new Date() })
      .where(
        and(
          eq(schema.outbox.status, "pending"),
          lte(schema.outbox.nextAttemptAt, new Date(Date.now() + minutes * 60_000)),
        ),
      );
    await settle();
  }

  /** A person's message in the scenario's conversation (`ana` by default); nothing runs until `settle`. */
  async function say(body: string, options: { as?: string; threadId?: string | null } = {}) {
    const person = people[options.as ?? "ana"];
    if (!person) throw new Error(`no person ${options.as}`);
    return postPersonMessage({ db: f.db, pubsub: f.pubsub, judge: f.context.judge }, person.id, f.org.id, channelId, {
      body,
      threadId: options.threadId ?? null,
    });
  }

  /**
   * History: a message written `minutesAgo` minutes ago that starts nothing (`@handle` authors are agents,
   * anything else a person of the world).
   */
  async function past(author: string, body: string, minutesAgo: number, threadId: string | null = null) {
    const agent = author.startsWith("@") ? agents[author.slice(1)] : undefined;
    const person = people[author];
    if (!agent && !person) throw new Error(`no author ${author}`);
    const mentioned = Object.entries(agents)
      .filter(([h]) => new RegExp(`@${h}\\b`, "i").test(body))
      .map(([, a]) => a.id);
    const m = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId,
      threadId,
      author: agent
        ? { type: "agent", agentId: agent.id, runId: null, hop: 0, stretchId: null }
        : { type: "person", userId: person?.id ?? "" },
      body,
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
    });
    if (mentioned.length)
      await f.db.update(schema.messages).set({ mentionedAgentIds: mentioned }).where(eq(schema.messages.id, m.id));
    await f.db.delete(schema.outbox).where(eq(schema.outbox.kind, "message.posted"));
    return m;
  }

  /** Grants an agent workspace scopes (no connection). */
  async function grant(handle: string, scopes: string[]) {
    const agent = agents[handle];
    if (!agent) throw new Error(`no agent ${handle}`);
    await grantScopes(
      f.db,
      f.org.id,
      agent.id,
      scopes.map((scope) => ({ connectionId: null, scope })),
    );
  }

  // ── What happened ──────────────────────────────────────────────────────────

  const handleOf = (agentId: string) => Object.entries(agents).find(([, a]) => a.id === agentId)?.[0] ?? agentId;

  async function runs(handle?: string) {
    const rows = await f.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.orgId, f.org.id))
      .orderBy(asc(schema.agentRuns.createdAt));
    return handle ? rows.filter((r) => r.agentId === agents[handle]?.id) : rows;
  }

  /** Agent messages that aren't server notices, oldest first (the ones people read as an agent's words). */
  async function posts(handle?: string) {
    const rows = await f.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.orgId, f.org.id), eq(schema.messages.authorType, "agent")))
      .orderBy(asc(schema.messages.createdAt));
    return rows.filter((m) => !m.meta.notice && (!handle || m.authorAgentId === agents[handle]?.id));
  }

  async function steps(runIds: string[]) {
    if (runIds.length === 0) return [];
    return f.db
      .select()
      .from(schema.agentRunSteps)
      .where(inArray(schema.agentRunSteps.runId, runIds))
      .orderBy(asc(schema.agentRunSteps.createdAt), asc(schema.agentRunSteps.seq));
  }

  /** Tool calls of an agent's runs, with whether each was refused (its result an error) and the result text. */
  async function calls(handle: string) {
    const all = await steps((await runs(handle)).map((r) => r.id));
    const results = new Map(
      all.filter((s) => s.kind === "tool_result").map((s) => [String(s.data.toolUseId), s.data] as const),
    );
    return all
      .filter((s) => s.kind === "tool_call")
      .map((s) => {
        const r = results.get(String(s.data.toolUseId)) as { isError?: boolean; content?: string } | undefined;
        return { runId: s.runId, name: String(s.data.name), isError: r?.isError === true, result: r?.content ?? "" };
      });
  }

  /** The routing decisions of the scenario's messages, with the handles picked. */
  async function decisions() {
    const rows = await f.db
      .select()
      .from(schema.routingDecisions)
      .where(eq(schema.routingDecisions.orgId, f.org.id))
      .orderBy(asc(schema.routingDecisions.createdAt));
    return rows.map((d) => ({ ...d, picked: d.selectedAgentIds.map(handleOf) }));
  }

  const judgedAs = (kind: string) => judgments.filter((j) => j.kind === kind);

  /** The system prompts of an agent's model calls (its first call first). */
  const prompts = (handle: string) =>
    f.provider.calls
      .map((c) => systemText(c.request.system))
      .filter((s) => new RegExp(`You are [^\\n]*? \\(@${handle}\\)`).test(s));

  const w = {
    f,
    db: f.db,
    org: f.org,
    owner: f.owner,
    agents,
    people,
    channelId,
    handlers,
    unscripted,
    unrouted,
    unknownJudgments,
    judgments,
    judgedAs,
    settle,
    advance,
    say,
    past,
    grant,
    runs,
    posts,
    steps,
    calls,
    decisions,
    prompts,
    handleOf,
    close: () => f.close(),
  };
  open.push(w);
  return w;
}
