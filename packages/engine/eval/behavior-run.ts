/**
 * The behavior eval's machinery (`behavior.ts` is the command line): seeds an
 * in-memory database with a case, runs the agent through the real engine
 * path, observes what it did, and asks a judge model to grade it. The model
 * provider is passed in, so tests drive it with the fake provider (no network).
 */
import {
  createFakeGifs,
  createMemoryBlobStore,
  createMemoryPubSub,
  createPostgresSearchResolver,
  noPlatformCredentials,
} from "@agenteschat/adapters";
import { and, asc, eq, gt, gte, inArray, schema, sql } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import {
  type ContentBlock,
  costNanoUsd,
  type ModelProvider,
  type ModelRequest,
  systemText,
} from "@agenteschat/providers";
import { ptBR } from "../../i18n/src/pt-BR";
import {
  addChannelMember,
  type ContextDeps,
  createAgent,
  createAgentGifPoster,
  createAgentRuns,
  createArtifactToolSource,
  createAskAgentToolSource,
  createAskUserToolSource,
  createBlobStoreResolver,
  createBlockToolSource,
  createChannel,
  createChatToolSource,
  createContextToolSource,
  createCredential,
  createFakeJudge,
  createFakeScheduleReader,
  createFindAgentToolSource,
  createHandOffToolSource,
  createIssue,
  createIssueToolSource,
  createJevJudge,
  createJobHandlers,
  createLlmJudge,
  createLocalKeyWrapper,
  createMediaToolSource,
  createModelGateway,
  createOrganization,
  createPassToolSource,
  createReactToolSource,
  createRoutine,
  createScheduleToolSource,
  createToolGateway,
  createWebToolSource,
  createWorkspaceToolSource,
  drainOutbox,
  enqueue,
  getMessage,
  grantScopes,
  insertContextItem,
  insertMessage,
  isNoReply,
  type Judge,
  type JudgeRequest,
  openDm,
  postPersonMessage,
  type RoutineBrief,
  startRoutineRun,
  stretchCardOf,
  type ToolGateway,
  type ToolSource,
  withJudgeFallback,
} from "../src";
import {
  type CheckResult,
  deterministicChecks,
  type EvalToolCall,
  type EvalTurn,
  type Expectations,
} from "./behavior-checks";
import {
  type Canned,
  CONNECTORS,
  fakeConnectorSource,
  fakeMissionSource,
  fakeSecretRequestSource,
  fakeWebFetch,
  type WebFixture,
} from "./behavior-fakes";

// ── Cases ────────────────────────────────────────────────────────────────────

type RoleId = "dev" | "ops" | "qa" | "pm";

interface CaseMessage {
  /** A person's name, or "agent" for the agent under test. */
  author: string;
  body: string;
  meta?: Record<string, unknown>;
}

/** A person's line, or the same line per language (`--lang` picks one; the first when that one is missing). */
export type Line = string | Record<string, string>;
export const lineIn = (line: Line, lang?: string) =>
  typeof line === "string" ? line : ((lang && line[lang]) ?? Object.values(line)[0] ?? "");

/**
 * What happens after the trigger, in order: a person's line in the conversation (`say`), or other agents' runs held
 * (`hold`: they wait, queued) or let go (`release`). `expect`: checks on what the agent under test did in that step.
 */
export type CaseStep = ({ say: Line } | { hold: string[] } | { release: string[] }) & { expect?: Expectations };

export interface BehaviorCase {
  id: string;
  title: string;
  /** Where it comes from ("real failure 2026-10-17", "synthetic"). */
  source?: string;
  agent: {
    /** Role preset of "Criar agente" (name, role and instructions from pt-BR). */
    preset?: RoleId;
    name?: string;
    handle?: string;
    role?: string;
    instructions?: string;
    model?: string;
  };
  org: { name: string; context: string };
  conversation: {
    where: "channel" | "dm";
    channel?: string;
    topic?: string;
    /** Channel only: everything after the first prior message (and the trigger) is a reply in its thread. */
    thread?: boolean;
    prior?: CaseMessage[];
    trigger: Omit<CaseMessage, "body"> & { body: Line };
    /**
     * The trigger is a routine's firing (ADR 0053): its background run starts in the routine's room with
     * `trigger.body` as its instructions (written by `trigger.author`, its creator) and reports to this
     * conversation, whose `prior` messages it reads under "# Where your report goes". `access` (default
     * `read`) and `report` (default `when_new`) are the routine's settings.
     */
    routine?: { name: string; access?: "read" | "act"; report?: "always" | "when_new" };
    /**
     * The trigger is another agent's question (`ask_agent`) on behalf of the person who wrote
     * `origin` in the channel: `trigger.author` is that person, `trigger.body` the question.
     */
    consultation?: { from: string; origin: Line };
    /**
     * The trigger is another agent's hand-off (`tell_agent`, ADR 0095) on behalf of the person who wrote `origin` in
     * the channel: `trigger.author` is that person, `trigger.body` the note.
     */
    note?: { from: string; origin: Line };
    steps?: CaseStep[];
    /**
     * Nobody called the agent by name: the router picked it for the trigger (a person's message
     * without a mention). The run may pass (reply-policy.ts).
     */
    router?: boolean;
  };
  /**
   * Other agents of the org, in the channel too. Their runs are recorded, never executed, unless `runs` (the real
   * model answers for them too). `memory`: theirs, as the agent's own.
   */
  otherAgents?: {
    name: string;
    handle: string;
    role?: string;
    instructions?: string;
    runs?: boolean;
    memory?: { kind?: "note" | "fact" | "decision" | "lesson"; title?: string; content: string }[];
  }[];
  /** Routines already there: `agent` is a handle (or "self"), answering in the case's channel. */
  routines?: { agent: string; name: string; prompt: string; schedule: string }[];
  /** The scheduling tools (list_routines, update_routine…) and `ask_agent`. */
  schedule?: boolean;
  /** The server has no GIF search: agents get only `send_sticker` (ADR 0091). */
  noGifs?: boolean;
  /** Who a person's message with several mentions is for: the org's cheap model decides (real call). */
  addressees?: boolean;
  /** Fake connectors granted to the agent (all their scopes). */
  connectors?: (keyof typeof CONNECTORS)[];
  /** Built-in issue tools (list_issues, create_issue…) on the real issues table. */
  issues?: boolean;
  /** Workspace tools (add_agent_to_channel, update_thread): internal changes with undo. */
  workspace?: boolean;
  /** The real chat tools (`post_message`, `send_dm`): speaking elsewhere or for someone. */
  chat?: boolean;
  /** The real `show_block` and `start_poll` (ADR 0113), next to the Drive's tools an agent could reach for instead. */
  blocks?: boolean;
  /** A `propose_mission` with the real description and findings schema (no computer; recorded only). */
  missions?: boolean;
  /** Issues already in the workspace. */
  seedIssues?: { title: string; description?: string; labels?: string[] }[];
  /** The agent's memory (context items it can find with search_context). */
  memory?: { kind?: "note" | "fact" | "decision" | "lesson"; title?: string; content: string }[];
  /** Canned results per tool: the first entry whose `when` words all appear in the input wins. */
  fixtures?: Record<string, Canned[]>;
  /**
   * The agent reads the web (`web_search`, `web_fetch`, ADR 0109) from this fake web, and how its turns end (and a
   * routine's report) is judged as in production.
   */
  web?: WebFixture;
  /** The computer's `request_secret` (recorded only, no computer): the secure way to ask for a key. */
  secretRequest?: boolean;
  expect: Expectations & {
    /** What a good answer does, for the judge. */
    behavior: string;
    /** Extra criteria for the judge, specific to the case. */
    rubric?: string[];
    /** Standard judge criteria that don't apply here. */
    skipJudge?: string[];
  };
}

// ── One case ─────────────────────────────────────────────────────────────────

const ROLE_PRESETS = ptBR.newAgent.roles as Record<string, { name: string; agent?: string; instructions: string }>;

export function agentOf(c: BehaviorCase, modelOverride?: string) {
  const preset = c.agent.preset ? ROLE_PRESETS[c.agent.preset] : undefined;
  if (c.agent.preset && !preset) throw new Error(`${c.id}: unknown preset ${c.agent.preset}`);
  const name = c.agent.name ?? preset?.agent ?? "Agente";
  return {
    name,
    handle: (c.agent.handle ?? name).toLowerCase(),
    role: c.agent.role ?? preset?.name ?? "",
    instructions: c.agent.instructions ?? preset?.instructions ?? "",
    model: modelOverride ?? c.agent.model ?? "claude-sonnet-5-5",
  };
}

export interface CaseRun {
  turns: EvalTurn[];
  calls: EvalToolCall[];
  reply: string;
  /** A routine run that handed nothing off (nothing posted); other runs: the reply was the NO_REPLY word. */
  noReply: boolean;
  /** The run passed (nobody called it by name and it had nothing to add): nothing posted. */
  passed?: boolean;
  approvals: string[];
  /** The reason each approval request carries, as its card shows it. */
  approvalReasons?: { tool: string; why: string }[];
  status: string[];
  /** Routine cases: how the routine's run ended in its ledger (`reported`, `silent`, `failed` with a code…). */
  routineRun?: { status: string; code: string | null };
  system: string;
  costNanoUsd: number;
  /** Handles of the other agents the trigger started. */
  triggered: string[];
  /** Receipt kinds on the run's messages (act with undo). */
  receipts?: string[];
  /** What the person sees besides the reply: the cards the run posted (a mission proposal's findings and plan). */
  cards?: string;
  /** The tools the agent had (names). */
  tools?: string[];
  /** The agent's model calls and their tokens (`input`: uncached; the prompt is input + cacheRead + cacheWrite). */
  tokens?: { calls: number; input: number; cacheRead: number; cacheWrite: number; output: number };
  /** Tools on demand: the run's choice (`context` step). */
  toolGroups?: unknown;
  /** The cheap model's structured answers during the run (addressees), for the report. */
  classifier?: string[];
  /** What the agent under test did in each step with an `expect`, checked (`step2:…`). */
  stepChecks?: CheckResult[];
  /** With steps or colleagues that run: the conversation after the trigger, as the person saw it (for the judge). */
  transcript?: string;
  /** Work handed off with `tell_agent`, by `"from>to"` handles. */
  handOffs?: Record<string, number>;
  /** In the case's conversation: the agents' messages (notices aside) and the "Nota de…" lines. */
  personSaw?: { agentMessages: number; noteLines: number };
  /** Agent runs in the case, by handle and `all` (a scripted asker's run aside). */
  agentRuns?: Record<string, number>;
  /** A `conversation.note` case: what came of the note went back to its sender as a notice. */
  reported?: boolean;
  error?: string;
}

/** Records the model's turns of a run (what it wrote and called), passing everything through. */
function recording(provider: ModelProvider) {
  const turns: (EvalTurn & { request: ModelRequest })[] = [];
  /** Structured answers (the addressee classifier), for the report. */
  const structured: string[] = [];
  const wrapped: ModelProvider = {
    id: provider.id,
    async stream(request, options) {
      const result = await provider.stream(request, options);
      // Structured calls (the addressee classifier) are not the agent's turns.
      if (request.outputSchema) {
        structured.push(`${JSON.stringify(request.messages).slice(0, 1500)} → ${result.text}`);
        return result;
      }
      turns.push({
        request,
        text: result.text,
        toolCalls: result.content
          .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
          .map((b) => ({ name: b.name, input: b.input })),
      });
      return result;
    },
    ...(provider.countTokens ? { countTokens: provider.countTokens.bind(provider) } : {}),
  };
  return { provider: wrapped, turns, structured };
}

async function addPerson(db: Awaited<ReturnType<typeof createTestDatabase>>["db"], name: string) {
  const id = `user_${name.toLowerCase().replace(/\W+/g, "")}_${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(schema.users).values({ id, name, email: `${id}@example.com` });
  return { id, name };
}

export interface RunOptions {
  /** The provider key the agent's credential holds (any string with the fake provider). */
  apiKey: string;
  /** The real Anthropic provider, or the fake one in tests. */
  provider: ModelProvider;
  maxToolTurns: number;
  /** Overrides every case's agent model. */
  agentModel?: string;
  /** TypeSafe key: the addressee classification uses Jev like production (the cheap model only without it). */
  jevKey?: string;
  /**
   * Tools on demand (ADR 0043) as in production: the run lists the core tools and the groups Jev expects
   * (only that judgment is Jev's; the others stay fake). Without `jevKey` the run gets the core tools.
   */
  toolsOnDemand?: boolean;
  /** The language of the people's lines given per language (`Line`). */
  lang?: string;
  /** Tests: the judge for how agents work together, instead of Jev or the cheap model. */
  judge?: Judge;
}

/** The judgments of agents working together that a case where they do asks of production's judge. */
const TOGETHER = new Set(["note_reply", "follow_through", "mention_needs_nothing", "ask_check"]);

/** A case's conversation with every person's line in one language. */
function inLanguage(
  conv: BehaviorCase["conversation"],
  lang?: string,
): Omit<BehaviorCase["conversation"], "trigger" | "consultation" | "note"> & {
  trigger: CaseMessage;
  consultation?: { from: string; origin: string };
  note?: { from: string; origin: string };
} {
  return {
    ...conv,
    trigger: { ...conv.trigger, body: lineIn(conv.trigger.body, lang) },
    consultation: conv.consultation && { ...conv.consultation, origin: lineIn(conv.consultation.origin, lang) },
    note: conv.note && { ...conv.note, origin: lineIn(conv.note.origin, lang) },
  };
}

/** Runs one case through the engine on a fresh in-memory database. */
export async function runCase(c: BehaviorCase, options: RunOptions): Promise<CaseRun> {
  const { apiKey, maxToolTurns } = options;
  const { db, close } = await createTestDatabase();
  try {
    const keyWrapper = createLocalKeyWrapper(crypto.randomUUID().repeat(2));
    const conv = inLanguage(c.conversation, options.lang);
    const personNames = [
      ...new Set([conv.trigger, ...(conv.prior ?? [])].map((m) => m.author).filter((a) => a !== "agent")),
    ];
    const ownerName = conv.trigger.author !== "agent" ? conv.trigger.author : (personNames[0] ?? "Marina");
    const owner = await addPerson(db, ownerName);
    const { organization: org } = await createOrganization(db, owner.id, c.org);
    const people = new Map([[ownerName, owner]]);
    for (const name of personNames.filter((n) => n !== ownerName)) {
      const p = await addPerson(db, name);
      await db.insert(schema.organizationMembers).values({ orgId: org.id, userId: p.id, role: "member" });
      people.set(name, p);
    }
    const credential = await createCredential(db, keyWrapper, owner.id, org.id, {
      provider: "anthropic",
      label: "eval",
      apiKey,
      makeDefault: true,
    });
    const a = agentOf(c, options.agentModel);
    const agent = await createAgent(
      db,
      owner.id,
      org.id,
      { name: a.name, handle: a.handle, role: a.role, instructions: a.instructions, credentialId: credential.id },
      { model: a.model },
    );

    // Tools: the fake connectors, the real built-ins (memory and search, issues, ask_user, react).
    const fakes: { source: ToolSource; executed: { name: string }[] }[] = (c.connectors ?? []).map((id) =>
      fakeConnectorSource(id, c.fixtures ?? {}),
    );
    await grantScopes(
      db,
      org.id,
      agent.id,
      [
        ...(c.connectors ?? []).flatMap((id) => [...new Set(CONNECTORS[id].map((t) => t.scope))]),
        ...(c.issues ? ["issues:read", "issues:write"] : []),
        ...(c.blocks ? ["drive:read", "drive:write"] : []),
        ...(c.secretRequest ? ["sandbox:run"] : []),
      ].map((scope) => ({ connectionId: null, scope })),
    );

    // Colleagues run, or another agent's note is the trigger: agents work together here.
    const together = Boolean(conv.note || c.otherAgents?.some((o) => o.runs));
    const recorder = recording(options.provider);
    const pubsub = createMemoryPubSub();
    const gateway = createModelGateway({
      db,
      keyWrappers: [keyWrapper],
      providers: { anthropic: recorder.provider },
      platformCredentials: noPlatformCredentials,
    });
    const search = createPostgresSearchResolver(db);
    const context: ContextDeps = {
      db,
      gateway,
      search,
      summaryModel: "claude-haiku-5-5",
      pubsub,
      // No reflection or summaries during the eval: only the agent's own calls cost.
      reflect: { everyMessages: 100_000, idleMinutes: 100_000, maxPerThread: 1 },
      judge: createFakeJudge(),
      // Schedule phrases of the seeded routines (a table, not a model).
      schedules: createFakeScheduleReader({
        "a cada hora": { rule: { freq: "hourly", times: ["00:00"] } },
        "dias úteis às 9h": { rule: { freq: "weekly", byWeekday: ["MO", "TU", "WE", "TH", "FR"], times: ["09:00"] } },
      }),
    };
    // With a web, a give-up report and a question to a person are judged first (ADR 0109).
    const resourceful = c.web ? { name: "eval", ask: (r: JudgeRequest) => (context.judge as Judge).ask(r) } : null;
    const sources: ToolSource[] = [
      createAskUserToolSource({ judge: resourceful, tools: () => tools }),
      ...(c.schedule ? [createAskAgentToolSource({ pubsub }), createScheduleToolSource({ pubsub, context })] : []),
      // Colleagues that really run: who they are, and ask_agent and tell_agent to reach them.
      ...(together ? [createFindAgentToolSource()] : []),
      ...(together && !c.schedule ? [createAskAgentToolSource({ pubsub })] : []),
      createReactToolSource({ pubsub }),
      createMediaToolSource({ pubsub, gifs: c.noGifs ? null : createFakeGifs() }),
      // Routine cases run in the background and speak through it, with a GIF as in production.
      createHandOffToolSource({
        pubsub,
        judge: resourceful,
        tools: () => tools,
        gif: createAgentGifPoster(c.noGifs ? null : createFakeGifs()),
      }),
      ...(c.web
        ? [createWebToolSource({ fetch: fakeWebFetch(c.web), resolveHost: async () => ["93.184.216.34"] })]
        : []),
      // Runs nobody called by name may pass (offered only to them, as in production).
      createPassToolSource(),
      createContextToolSource(context),
      ...(c.issues
        ? [
            createIssueToolSource({
              db,
              blobs: createBlobStoreResolver({ db, keyWrappers: [keyWrapper], platform: createMemoryBlobStore() }),
              pubsub,
            }),
          ]
        : []),
      ...(c.workspace ? [createWorkspaceToolSource({ pubsub })] : []),
      ...(c.chat
        ? [
            createChatToolSource({
              pubsub,
              gif: createAgentGifPoster(c.noGifs ? null : createFakeGifs()),
              artifacts: {
                db,
                blobs: createBlobStoreResolver({ db, keyWrappers: [keyWrapper], platform: createMemoryBlobStore() }),
                pubsub,
              },
            }),
          ]
        : []),
      ...(c.blocks
        ? (() => {
            const blobs = createBlobStoreResolver({
              db,
              keyWrappers: [keyWrapper],
              platform: createMemoryBlobStore(),
            });
            const deps = { db, blobs, pubsub };
            return [createArtifactToolSource(deps), createBlockToolSource(deps)];
          })()
        : []),
      ...(c.missions ? [fakeMissionSource().source] : []),
      ...(c.secretRequest ? [fakeSecretRequestSource()] : []),
      ...fakes.map((f) => f.source),
    ];
    const tools: ToolGateway = createToolGateway({ sources });
    if (together || c.web) {
      // How agents work together is judged as in production (ADR 0089, ADR 0095): Jev, the cheap model as fallback.
      const llmJudge = createLlmJudge({ gateway, resolveModel: async () => "claude-haiku-5-5" });
      const real =
        options.judge ??
        (options.jevKey
          ? withJudgeFallback(createJevJudge({ key: options.jevKey, gateway, timeoutMs: 5000 }), llmJudge)
          : llmJudge);
      const fake = context.judge as Judge;
      context.judge = { name: "eval", ask: (r) => (TOGETHER.has(r.kind) ? real : fake).ask(r) };
    }
    if (options.toolsOnDemand && options.jevKey) {
      const jev = createJevJudge({ key: options.jevKey, gateway, timeoutMs: 5000 });
      const fake = context.judge as Judge;
      context.judge = { name: "eval", ask: (r) => (r.kind === "tool_groups" ? jev : fake).ask(r) };
    }
    const handlers = createJobHandlers({
      db,
      gateway,
      pubsub,
      maxOutputTokens: 16_000,
      contextMessages: 30,
      // Production's depth backstop (`AGENT_MAX_HOPS`): the stretch limits bound agents that run on their own.
      maxHops: 100,
      maxToolTurns,
      tools,
      context,
      search,
      toolsOnDemand: options.toolsOnDemand ?? false,
    });
    // Other agents' runs (an `ask_agent` question, a mention) are recorded, never executed, unless they run; a held
    // agent's wait until a step lets them go.
    const execute = handlers["agent_run.execute"];
    const held = new Set<string>();
    const waiting = new Set<string>();
    handlers["agent_run.execute"] = async (job, ctx) => {
      const runId = String(job.payload.runId ?? "");
      const [row] = await db
        .select({ agentId: schema.agentRuns.agentId })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, runId));
      if (row && held.has(row.agentId)) {
        waiting.add(runId);
        return;
      }
      if (row && others.has(row.agentId) && !running.has(row.agentId)) return;
      await execute?.(job, ctx);
    };

    // The conversation.
    let channelId: string;
    if (conv.where === "dm") {
      channelId = (await openDm(db, owner.id, org.id, { agentId: agent.id })).id;
    } else {
      const channel = await createChannel(db, owner.id, org.id, { name: conv.channel ?? "geral", topic: conv.topic });
      channelId = channel.id;
      await addChannelMember(db, owner.id, org.id, channelId, { agentId: agent.id });
      for (const [name, p] of people)
        if (name !== ownerName) await addChannelMember(db, owner.id, org.id, channelId, { userId: p.id });
    }
    const others = new Map<string, string>();
    const running = new Set<string>();
    for (const o of c.otherAgents ?? []) {
      const other = await createAgent(
        db,
        owner.id,
        org.id,
        {
          name: o.name,
          handle: o.handle,
          role: o.role ?? "",
          instructions: o.instructions ?? "",
          credentialId: credential.id,
        },
        { model: a.model },
      );
      others.set(other.id, o.handle);
      if (o.runs) running.add(other.id);
      for (const m of o.memory ?? []) {
        await insertContextItem(db, {
          orgId: org.id,
          kind: m.kind ?? "note",
          scopeType: "agent",
          scopeId: other.id,
          agentId: other.id,
          title: m.title,
          content: m.content,
          channelIds: [],
          createdByKind: "agent",
          createdById: other.id,
        });
      }
      if (conv.where === "channel") await addChannelMember(db, owner.id, org.id, channelId, { agentId: other.id });
    }
    const agentIdOf = (handle: string) =>
      handle === "self" ? agent.id : [...others].find(([, h]) => h === handle.replace(/^@/, ""))?.[0];
    for (const r of c.routines ?? []) {
      const agentId = agentIdOf(r.agent);
      if (!agentId) throw new Error(`${c.id}: no agent ${r.agent} for routine "${r.name}"`);
      await createRoutine({ db, pubsub, context }, owner.id, org.id, {
        name: r.name,
        agentId,
        prompt: r.prompt,
        target: { type: "channel", channelId },
        trigger: { type: "schedule", phrase: r.schedule, timezone: "America/Sao_Paulo" },
      });
    }
    for (const m of c.memory ?? []) {
      await insertContextItem(db, {
        orgId: org.id,
        kind: m.kind ?? "note",
        scopeType: "agent",
        scopeId: agent.id,
        agentId: agent.id,
        title: m.title,
        content: m.content,
        channelIds: [channelId],
        createdByKind: "agent",
        createdById: agent.id,
      });
    }
    for (const issue of c.seedIssues ?? []) {
      await createIssue({ db, pubsub }, { type: "person", userId: owner.id }, org.id, { ...issue, channelId });
    }
    // `agent` is the case's agent; `@handle` another agent of the case; anything else a person.
    const author = (m: CaseMessage) => {
      if (m.author === "agent")
        return { type: "agent", agentId: agent.id, runId: null, hop: 0, stretchId: null } as const;
      const other = m.author.startsWith("@") ? agentIdOf(m.author.slice(1)) : undefined;
      if (other) return { type: "agent", agentId: other, runId: null, hop: 1, stretchId: null } as const;
      return { type: "person", userId: (people.get(m.author) ?? owner).id } as const;
    };
    let threadId: string | null = null;
    for (const m of conv.prior ?? []) {
      const msg = await insertMessage(db, {
        orgId: org.id,
        channelId,
        threadId,
        author: author(m),
        body: m.body,
        meta: m.meta,
      });
      if (conv.thread && conv.where === "channel" && !threadId) threadId = msg.id;
    }
    // History only: earlier messages start no runs (their routing jobs go), but they are indexed for search.
    await db.delete(schema.outbox).where(eq(schema.outbox.kind, "message.posted"));
    await drainOutbox(db, handlers);
    recorder.turns.length = 0;

    const triggerAuthor = people.get(conv.trigger.author) ?? owner;
    const routine = conv.routine
      ? { routine: { id: crypto.randomUUID(), name: conv.routine.name, runId: crypto.randomUUID() } }
      : undefined;
    let askerRunId: string | null = null;
    /** A `note` case: the row of the note the agent under test answers. */
    let noteId: string | null = null;
    const asking = conv.consultation ?? conv.note;
    if (asking) {
      // Another agent asks this one, or hands it work, on the person's behalf: the person's message, the other
      // agent's run on it, and its `ask_agent` or `tell_agent` call (the real tool: DM, message, row).
      const askerId = agentIdOf(asking.from);
      if (!askerId) throw new Error(`${c.id}: no agent ${asking.from} to ask`);
      const origin = await insertMessage(db, {
        orgId: org.id,
        channelId,
        threadId,
        author: { type: "person", userId: triggerAuthor.id },
        body: asking.origin,
      });
      const [asker] = await db
        .insert(schema.agentRuns)
        .values({
          orgId: org.id,
          agentId: askerId,
          channelId,
          threadRootId: threadId ?? origin.id,
          triggerMessageId: origin.id,
          trigger: "mention",
          hop: 1,
          status: "running",
        })
        .returning();
      if (!asker) throw new Error(`${c.id}: could not start the asking run`);
      askerRunId = asker.id;
      const [ask, tell] = await createAskAgentToolSource({ pubsub }).tools({} as never);
      const ctx = {
        db,
        orgId: org.id,
        agentId: askerId,
        runId: asker.id,
        channelId,
        threadRootId: asker.threadRootId,
        triggerMessageId: origin.id,
      };
      const asked = conv.note
        ? await tell?.execute({ agent: `@${agent.handle}`, message: conv.trigger.body }, ctx)
        : await ask?.execute({ agent: `@${agent.handle}`, question: conv.trigger.body }, ctx);
      if (asked?.isError)
        throw new Error(`${c.id}: ${conv.note ? "tell_agent" : "ask_agent"} refused: ${asked.content}`);
      noteId = conv.note ? ((asked?.data?.consultation as { id?: string } | undefined)?.id ?? null) : null;
      // It handed the work off and ended its turn: what comes of it reaches its conversation.
      if (conv.note) await db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, asker.id));
    } else {
      // Same judge as production (apps/server/src/engine.ts): Jev, the cheap model as fallback.
      const llmJudge = createLlmJudge({ gateway, resolveModel: async () => "claude-haiku-5-5" });
      const judge = c.addressees
        ? options.jevKey
          ? withJudgeFallback(createJevJudge({ key: options.jevKey, gateway, timeoutMs: 5000 }), llmJudge)
          : llmJudge
        : undefined;
      if (routine && conv.routine) {
        // As production fires it (routines.ts, routine-room.ts): the routine's row, its firing claimed, and
        // its background run started in the routine's own room; it reports to this conversation.
        const access = conv.routine.access ?? "read";
        const report = conv.routine.report ?? "when_new";
        await db.insert(schema.routines).values({
          id: routine.routine.id,
          orgId: org.id,
          agentId: agent.id,
          name: conv.routine.name,
          prompt: conv.trigger.body,
          target:
            conv.where === "dm"
              ? { type: "dm" }
              : threadId
                ? { type: "conversation", channelId, threadId }
                : { type: "channel", channelId },
          triggerType: "schedule",
          phrase: "a cada hora",
          access,
          report,
          createdByUserId: triggerAuthor.id,
        });
        const at = new Date();
        await db.insert(schema.routineRuns).values({
          id: routine.routine.runId,
          orgId: org.id,
          routineId: routine.routine.id,
          at,
          trigger: "schedule",
          status: "starting",
        });
        const brief: RoutineBrief = {
          routineId: routine.routine.id,
          routineRunId: routine.routine.runId,
          name: conv.routine.name,
          creatorUserId: triggerAuthor.id,
          deliverTo: { channelId, threadId: threadId ?? null },
          access,
          report,
          trigger: "schedule",
          dueAt: at.toISOString(),
        };
        const started = await startRoutineRun(
          { db, pubsub },
          { orgId: org.id, agentId: agent.id, brief, body: conv.trigger.body, brain: "model" },
        );
        if (!started) throw new Error(`${c.id}: the routine's run did not start`);
      } else {
        const sent = await postPersonMessage({ db, pubsub, judge }, triggerAuthor.id, org.id, channelId, {
          body: conv.trigger.body,
          threadId,
        });
        if (conv.router) {
          // As the router's pick (router.ts): nobody named the agent; no routing job of its own here.
          await db.delete(schema.outbox).where(eq(schema.outbox.kind, "message.posted"));
          const message = await getMessage(db, org.id, sent.id);
          if (!message) throw new Error(`${c.id}: the trigger was not written`);
          await db.transaction((tx) => createAgentRuns(tx, message, [agent.id], "router"));
        }
      }
    }
    // Other agents' runs: recorded (who the trigger started), executed only for those that run.
    const otherRuns = others.size
      ? await db
          .select({ id: schema.agentRuns.id, agentId: schema.agentRuns.agentId })
          .from(schema.agentRuns)
          .where(and(eq(schema.agentRuns.orgId, org.id), inArray(schema.agentRuns.agentId, [...others.keys()])))
      : [];
    const triggered = [
      ...new Set(otherRuns.filter((r) => r.id !== askerRunId).map((r) => others.get(r.agentId) ?? "")),
    ].filter(Boolean);
    for (const r of otherRuns.filter((r) => !running.has(r.agentId))) {
      await db
        .delete(schema.outbox)
        .where(and(eq(schema.outbox.kind, "agent_run.execute"), sql`${schema.outbox.payload}->>'runId' = ${r.id}`));
    }
    /** Runs what is queued, retrying a transient model failure now (production retries it after a backoff). */
    const settle = async () => {
      await drainOutbox(db, handlers, { maxBatches: 500 });
      for (let retry = 0; retry < 3; retry++) {
        const retried = await db
          .update(schema.outbox)
          .set({ nextAttemptAt: new Date() })
          .where(
            and(
              eq(schema.outbox.status, "pending"),
              eq(schema.outbox.kind, "agent_run.execute"),
              gt(schema.outbox.attempts, 0),
            ),
          )
          .returning({ id: schema.outbox.id });
        if (retried.length === 0) break;
        await drainOutbox(db, handlers, { maxBatches: 500 });
      }
    };
    /** Whose model call it is: the agent under test's prompt says so. */
    const ownTurn = (t: { request: ModelRequest }) =>
      systemText(t.request.system).includes(`You are ${agent.name} (@${agent.handle})`);

    /** What the agent under test did in its runs started since `since` (all of them without), and its turns from `fromTurn`. */
    const observe = async (since: Date | null, fromTurn = 0) => {
      const runs = await db
        .select()
        .from(schema.agentRuns)
        .where(
          and(
            eq(schema.agentRuns.orgId, org.id),
            eq(schema.agentRuns.agentId, agent.id),
            since ? gte(schema.agentRuns.createdAt, since) : undefined,
          ),
        )
        .orderBy(asc(schema.agentRuns.createdAt));
      const runIds = runs.map((r) => r.id);
      const steps = runIds.length
        ? await db
            .select()
            .from(schema.agentRunSteps)
            .where(inArray(schema.agentRunSteps.runId, runIds))
            .orderBy(asc(schema.agentRunSteps.createdAt), asc(schema.agentRunSteps.seq))
        : [];
      const results = new Map(
        steps.filter((s) => s.kind === "tool_result").map((s) => [String(s.data.toolUseId), s.data] as const),
      );
      const calls: EvalToolCall[] = steps
        .filter((s) => s.kind === "tool_call")
        .map((s) => {
          const r = results.get(String(s.data.toolUseId)) as { isError?: boolean; content?: string } | undefined;
          const refused = r?.isError && /^(Not allowed|Invalid input|Unknown tool)/.test(r.content ?? "");
          return {
            name: String(s.data.name),
            input: (s.data.input ?? {}) as Record<string, unknown>,
            executed: Boolean(r) && !refused,
            isError: r?.isError === true,
            result: r?.content,
          };
        });
      const approvalRows = runIds.length
        ? await db
            .select({
              tool: schema.approvals.tool,
              title: schema.approvals.title,
              detail: schema.approvals.detail,
              why: schema.approvals.why,
            })
            .from(schema.approvals)
            .where(inArray(schema.approvals.runId, runIds))
            .orderBy(asc(schema.approvals.createdAt))
        : [];
      const posted = runIds.length
        ? await db
            .select({ body: schema.messages.body })
            .from(schema.messages)
            .innerJoin(schema.agentRuns, eq(schema.agentRuns.id, schema.messages.agentRunId))
            .where(
              and(
                eq(schema.messages.orgId, org.id),
                // Where each run answers: not a question or a note it sent another agent (a DM).
                eq(schema.messages.channelId, schema.agentRuns.channelId),
                inArray(schema.messages.agentRunId, runIds),
              ),
            )
            .orderBy(asc(schema.messages.createdAt))
        : [];
      const turns = recorder.turns
        .slice(fromTurn)
        .filter(ownTurn)
        .map(({ text, toolCalls }) => ({ text, toolCalls }));
      return { runs, runIds, steps, calls, approvalRows, posted, turns };
    };

    // Holds before anything else happens apply to the trigger already: those agents wait from the start.
    const stepList = conv.steps ?? [];
    const leading = stepList.findIndex((step) => !("hold" in step) || step.expect);
    const begin = leading < 0 ? stepList.length : leading;
    for (const step of stepList.slice(0, begin))
      if ("hold" in step) for (const h of step.hold) held.add(agentIdOf(h) ?? h);
    await settle();
    // The steps after the trigger, each checked on what the agent under test did in it.
    const stepChecks: CheckResult[] = [];
    for (const [i, step] of stepList.entries()) {
      if (i < begin) continue;
      const since = new Date();
      const fromTurn = recorder.turns.length;
      if ("hold" in step) for (const h of step.hold) held.add(agentIdOf(h) ?? h);
      if ("release" in step) {
        for (const h of step.release) held.delete(agentIdOf(h) ?? h);
        for (const runId of [...waiting]) {
          waiting.delete(runId);
          await enqueue(db, {
            orgId: org.id,
            kind: "agent_run.execute",
            payload: { runId },
            dedupeKey: `eval:release:${runId}`,
          });
        }
      }
      if ("say" in step) {
        await postPersonMessage({ db, pubsub }, triggerAuthor.id, org.id, channelId, {
          body: lineIn(step.say, options.lang),
          threadId,
        });
      }
      await settle();
      if (!step.expect) continue;
      const seen = await observe(since, fromTurn);
      const reply = seen.posted.map((m) => m.body).join("\n\n");
      for (const k of deterministicChecks(step.expect, {
        turns: seen.turns,
        calls: seen.calls,
        reply,
        noReply: false,
        approvals: seen.approvalRows.map((r) => r.tool),
      }))
        stepChecks.push({ ...k, id: `step${i + 1}:${k.id}` });
    }

    // What happened.
    const { runs, runIds, steps, calls, approvalRows, posted, turns } = await observe(null);
    const approvals = approvalRows.map((r) => r.tool);
    // A routine's ledger row: a report every time (`always`) can arrive without a hand_off (`auto_report`).
    const [ledger] = routine
      ? await db
          .select({
            status: schema.routineRuns.status,
            code: schema.routineRuns.code,
            messageId: schema.routineRuns.messageId,
          })
          .from(schema.routineRuns)
          .where(eq(schema.routineRuns.id, routine.routine.runId))
      : [];
    const routineRun = ledger ? { status: ledger.status, code: ledger.code } : undefined;
    // The routine's own message where it reports (its hand_off, or its final text delivered for it): it carries no
    // run's id (nobody is behind it), so `posted` misses it, yet it is what the people read.
    const [delivered] = ledger?.messageId
      ? await db
          .select({ body: schema.messages.body })
          .from(schema.messages)
          .where(and(eq(schema.messages.orgId, org.id), eq(schema.messages.id, ledger.messageId)))
      : [];
    const u = schema.usageRecords;
    const [usage] = await db
      .select({ cost: sql<number>`coalesce(sum(${u.costNanoUsd}), 0)::bigint` })
      .from(u)
      .where(eq(u.orgId, org.id));
    // The agents' model calls (tools on demand: what each call carries).
    const [tokens] = await db
      .select({
        calls: sql<number>`count(*)::int`,
        input: sql<number>`coalesce(sum(${u.inputTokens}), 0)::int`,
        cacheRead: sql<number>`coalesce(sum(${u.cacheReadTokens}), 0)::int`,
        cacheWrite: sql<number>`coalesce(sum(${u.cacheWriteTokens}), 0)::int`,
        output: sql<number>`coalesce(sum(${u.outputTokens}), 0)::int`,
      })
      .from(u)
      .where(and(eq(u.orgId, org.id), eq(u.kind, "agent")));
    const contextStep = steps.find((s) => s.kind === "context");
    // Act with undo: the receipts the run's messages carry.
    const receipts = runIds.length
      ? (
          await db
            .select({ kind: schema.agentActions.kind })
            .from(schema.agentActions)
            .where(and(inArray(schema.agentActions.runId, runIds), sql`${schema.agentActions.messageId} is not null`))
        ).map((r) => r.kind)
      : [];
    const cards = [
      ...calls.filter((t) => t.name === "propose_mission" && t.executed && !t.isError).map((t) => missionCard(t.input)),
      // An approval's card: the action, its parameters and the agent's reason (ADR 0053 §8).
      ...approvalRows.map(
        (r) => `Approval card (waits for a person): ${r.title}${r.detail ? ` (${r.detail})` : ""}\nWhy: ${r.why}`,
      ),
    ].join("\n\n");
    const handleOf = (id: string) => (id === agent.id ? agent.handle : (others.get(id) ?? "?"));
    // Hand-offs, what the person saw where the case happens, and every agent's runs (ADR 0095).
    const handOffs: Record<string, number> = {};
    for (const n of await db
      .select()
      .from(schema.agentConsultations)
      .where(and(eq(schema.agentConsultations.orgId, org.id), eq(schema.agentConsultations.kind, "note")))) {
      const pair = `${handleOf(n.askerAgentId)}>${handleOf(n.targetAgentId)}`;
      handOffs[pair] = (handOffs[pair] ?? 0) + 1;
    }
    const here = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.orgId, org.id), eq(schema.messages.channelId, channelId)))
      .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id));
    const notice = (m: { meta: Record<string, unknown> }) =>
      m.meta.notice as { kind?: string; refs?: Record<string, string> } | undefined;
    const agentRuns: Record<string, number> = { all: 0 };
    for (const r of await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.orgId, org.id))) {
      if (r.id === askerRunId) continue;
      agentRuns.all = (agentRuns.all ?? 0) + 1;
      agentRuns[handleOf(r.agentId)] = (agentRuns[handleOf(r.agentId)] ?? 0) + 1;
    }
    const triggerAt = here.findIndex((m) => m.authorType === "person" && m.body === conv.trigger.body);
    const transcript =
      conv.steps?.length || running.size
        ? here
            .slice(Math.max(0, triggerAt))
            .map((m) => {
              const who = m.authorUserId
                ? ([...people].find(([, p]) => p.id === m.authorUserId)?.[0] ?? "someone")
                : m.authorAgentId
                  ? handleOf(m.authorAgentId)
                  : "?";
              const n = notice(m);
              return n
                ? `[notice for @${who}: ${n.kind}${n.refs?.kind ? ` (${n.refs.kind})` : ""}]`
                : `[${m.authorUserId ? who : `@${who}`}]: ${m.body}`;
            })
            .join("\n")
        : undefined;
    const last = turns.at(-1);
    const first = recorder.turns.find(ownTurn);
    return {
      turns,
      calls,
      reply: [...(delivered ? [delivered.body] : []), ...posted.map((m) => m.body)].join("\n\n"),
      // A routine is silent unless it reported (a hand_off, or its final text when it reports every time);
      // the conversation run then posts the report.
      noReply: routine
        ? !calls.some((t) => t.name === "hand_off" && t.executed && !t.isError) && routineRun?.status !== "reported"
        : Boolean(last && isNoReply(last.text)),
      // Ended quietly on purpose (reply-policy.ts records how on a context step).
      passed: steps.some((s) => s.kind === "context" && (s.data as { passed?: unknown }).passed !== undefined),
      approvals,
      approvalReasons: approvalRows.map((r) => ({ tool: r.tool, why: r.why })),
      status: runs.map((r) => (r.error ? `${r.status} (${r.error})` : r.status)),
      ...(routineRun ? { routineRun } : {}),
      system: first ? systemText(first.request.system) : "",
      costNanoUsd: Number(usage?.cost ?? 0),
      triggered,
      receipts,
      ...(cards ? { cards } : {}),
      tools: (first?.request.tools ?? []).map((t) => t.name),
      tokens: {
        calls: Number(tokens?.calls ?? 0),
        input: Number(tokens?.input ?? 0),
        cacheRead: Number(tokens?.cacheRead ?? 0),
        cacheWrite: Number(tokens?.cacheWrite ?? 0),
        output: Number(tokens?.output ?? 0),
      },
      ...(contextStep?.data.toolGroups ? { toolGroups: contextStep.data.toolGroups } : {}),
      ...(recorder.structured.length ? { classifier: [...recorder.structured] } : {}),
      ...(stepChecks.length ? { stepChecks } : {}),
      ...(transcript ? { transcript } : {}),
      handOffs,
      personSaw: {
        agentMessages: here.filter((m) => m.authorType === "agent" && !notice(m) && !stretchCardOf(m.meta)).length,
        noteLines: here.filter((m) => notice(m)?.kind === "agent_note").length,
      },
      agentRuns,
      ...(noteId
        ? {
            reported: here.some(
              (m) => notice(m)?.kind === "consult_reply" && notice(m)?.refs?.consultationId === noteId,
            ),
          }
        : {}),
    };
  } finally {
    await close();
  }
}

/** A mission proposal as its card shows it (goal, findings, plan). */
function missionCard(input: Record<string, unknown>) {
  const findings = Array.isArray(input.findings) ? (input.findings as { kind?: unknown; text?: unknown }[]) : [];
  const plan = Array.isArray(input.plan) ? input.plan.map(String) : [];
  return [
    `Mission card: ${String(input.title ?? "")}`,
    `Goal: ${String(input.goal ?? "")}`,
    ...findings.map((f) => `- [${String(f.kind ?? "")}] ${String(f.text ?? "")}`),
    ...(plan.length ? ["Plan:", ...plan.map((x, i) => `${i + 1}. ${x}`)] : []),
  ].join("\n");
}

// ── The judge ────────────────────────────────────────────────────────────────

const STANDARD_CRITERIA: Record<string, string> = {
  looked_first:
    "Before answering, the agent looked at the real sources with its tools (code, errors, analytics, issues, memory) instead of answering from assumptions or replying with a plan made without looking.",
  grounded:
    "What it says about code, data or errors is backed by what the tools returned (file and line, numbers, ids, links). Nothing is invented or contradicts the tool results, and it never says it lacks access to something a tool returned.",
  next_step:
    "It ends with a concrete next step it takes or offers (e.g. 'abro um PR que muda X no arquivo Y', an issue created or to create, a specific action), not a vague 'let me know' or a list of generic ideas.",
  talks_like_a_colleague:
    "The reply reads like a colleague writing in the team chat: plain sentences in short paragraphs (no headings or bold; a list only for several items of the same kind), the people, places, times and versions in the data named as they are (not 'a user'), news put against what came before (new, same pattern, how many so far), and no ritual opening or closing ('I remain available', 'let me know if you need anything', 'hope this helps').",
  asks_well:
    "It does not ask permission to look and does not ask for information its tools could find. It asks only for decisions that are really the person's (product choice, priority) or before a sensitive action, and then one focused question. Internal changes it can undo (issues, priority, assignee, routines, memory) are expected without asking (ADR 0037): doing them is not a fault.",
};

interface JudgeVerdict {
  criteria: { id: string; pass: boolean; reason: string }[];
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface JudgeOptions {
  apiKey: string;
  provider: ModelProvider;
  model: string;
  agentModel?: string;
  /** The language of the people's lines given per language. */
  lang?: string;
  /** Grade with Jev (TypeSafe): a calibrated probability per criterion, no written reason. */
  jev?: { apiKey: string; fetch?: typeof fetch };
}

/** Jev says a criterion holds at this probability or above. */
export const JEV_PASS = 0.5;

/** Grades a run against the standard criteria and the case's rubric (one structured-output call). */
export async function judge(c: BehaviorCase, run: CaseRun, options: JudgeOptions) {
  const { apiKey, provider, model: judgeModel } = options;
  const criteria = Object.entries(STANDARD_CRITERIA)
    .filter(([id]) => !(c.expect.skipJudge ?? []).includes(id))
    .filter(([id]) => id !== "looked_first" || c.expect.investigate)
    .filter(([id]) => id !== "talks_like_a_colleague" || c.expect.noReply !== true)
    // Expected to pass: nothing posted is right; the deterministic check grades it.
    .filter(() => c.expect.pass !== true)
    .map(([id, text]) => ({ id, text }));
  for (const [i, text] of (c.expect.rubric ?? []).entries()) criteria.push({ id: `case_${i + 1}`, text });
  if (criteria.length === 0) return { checks: [] as CheckResult[], costNanoUsd: 0 };
  const a = agentOf(c, options.agentModel);
  const conv = inLanguage(c.conversation, options.lang);
  const line = (m: CaseMessage) => `[${m.author === "agent" ? a.name : m.author}]: ${m.body}`;
  // Another agent's question or hand-off for that person, in the two agents' private DM.
  const asking = conv.consultation ?? conv.note;
  const triggerLine = asking
    ? `[${asking.from}, another agent, ${conv.note ? "handing work" : "asking"} for ${conv.trigger.author}, who wrote it: "${asking.origin}"]: ${conv.trigger.body}`
    : line(conv.trigger);
  // A routine run starts from its instructions in its own room; the conversation is where its report goes.
  const prior = (conv.prior ?? []).map(line);
  const conversation = conv.routine
    ? [
        `# What was said lately where the routine reports (the run read it)\n${prior.join("\n") || "(nothing yet)"}`,
        `# The routine's instructions (set up by ${conv.trigger.author}; this run started from them)\n${conv.trigger.body}`,
      ].join("\n\n")
    : `# Conversation (last line is the message the agent answered)\n${[...prior, triggerLine].join("\n")}`;
  const routineSettings = conv.routine
    ? ` (routine run: "${conv.routine.name}"; ${
        conv.routine.access === "act" ? "it may act" : "it may only look and report"
      }; ${conv.routine.report === "always" ? "it reports every run" : "it reports only when there is news"})`
    : "";
  const toolLines = run.calls.length
    ? run.calls
        .map(
          (t, i) =>
            `${i + 1}. ${t.name}(${clip(JSON.stringify(t.input), 1500)}) → ${
              t.executed
                ? // Whole files: the judge checks line citations against what the agent read.
                  clip(t.result ?? "(no output)", 6000)
                : run.approvals.includes(t.name)
                  ? "held for a person's approval"
                  : t.result
                    ? `refused: ${clip(t.result, 300)}`
                    : "not run"
            }`,
        )
        .join("\n")
    : "(no tool calls)";
  const prompt = [
    `# Case: ${c.title}`,
    `Agent: ${a.name}, ${a.role}. Where: ${conv.where === "dm" ? "a DM" : `#${conv.channel ?? "geral"}`}${routineSettings}.`,
    conversation,
    `# What the agent already had in its prompt\nOrganization context: ${c.org.context}${
      c.memory?.length
        ? `\nIts memory:\n${c.memory.map((m) => `- [${m.kind ?? "note"}] ${m.title ? `${m.title}: ` : ""}${m.content}`).join("\n")}`
        : ""
    }`,
    `# The agent's tools\n${run.tools?.length ? run.tools.join(", ") : "(unknown)"} (it can't read what none of these covers)`,
    `# What a good answer does\n${c.expect.behavior}`,
    `# The agent's tool calls, in order\n${toolLines}`,
    `# The agent's reply in the chat\n${run.noReply ? "(stayed silent: nothing handed off, nothing posted)" : run.reply.trim() || "(nothing posted)"}`,
    ...(run.transcript
      ? [
          `# The conversation after it, as the person saw it (their later lines, every agent's messages, and notices that reached an agent there)\n${run.transcript}`,
        ]
      : []),
    ...(run.cards ? [`# Cards posted with the reply (the person sees them under it)\n${run.cards}`] : []),
  ];
  if (options.jev) return judgeWithJev(c, criteria, prompt.join("\n\n"), options.jev);
  prompt.push(`# Criteria\n${criteria.map((k) => `- ${k.id}: ${k.text}`).join("\n")}`);
  const result = await provider.stream(
    {
      model: judgeModel,
      system:
        "You grade how an AI agent behaved in a team chat (agentes.chat), where agents have tools and are expected to investigate before answering. Grade each criterion strictly against the transcript: pass only if the reply clearly meets it. When a criterion does not apply to this case (e.g. nothing needed asking), it passes. Give a one-sentence reason quoting the reply when useful.",
      messages: [{ role: "user", content: prompt.join("\n\n") }],
      maxTokens: 1500,
      outputSchema: {
        type: "object",
        properties: {
          criteria: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", enum: criteria.map((k) => k.id) },
                // Reason first, then the verdict (it follows the reasoning).
                reason: { type: "string" },
                pass: { type: "boolean" },
              },
              required: ["id", "reason", "pass"],
              additionalProperties: false,
            },
          },
        },
        required: ["criteria"],
        additionalProperties: false,
      },
    },
    { apiKey, onDelta: () => {} },
  );
  const verdict = JSON.parse(result.text) as JudgeVerdict;
  const checks = criteria.map((k): CheckResult => {
    const v = verdict.criteria.find((x) => x.id === k.id);
    return {
      id: `judge:${k.id}`,
      pass: v?.pass === true,
      detail: v ? v.reason : "the judge gave no verdict",
    };
  });
  return { checks, costNanoUsd: costNanoUsd(judgeModel, result.usage) };
}

/**
 * The grading on Jev: one yes/no question per criterion over the transcript, answered
 * with a calibrated probability (no written reason: the detail shows it).
 */
async function judgeWithJev(
  c: BehaviorCase,
  criteria: { id: string; text: string }[],
  transcript: string,
  jev: { apiKey: string; fetch?: typeof fetch },
) {
  let costNanoUsd = 0;
  const judge = createJevJudge({
    key: jev.apiKey,
    timeoutMs: 30_000,
    ...(jev.fetch ? { fetch: jev.fetch } : {}),
    gateway: {
      async recordExternalUsage(u) {
        costNanoUsd += u.costNanoUsd;
        return null;
      },
    },
  });
  const answers = await judge.ask({
    orgId: "eval",
    kind: "behavior_eval",
    state: { case: c.title, transcript },
    questions: Object.fromEntries(
      criteria.map((k) => [
        k.id,
        {
          type: "noul" as const,
          instructions: `You grade how an AI agent behaved in a team chat, from \`transcript\` (its tool calls with results, and its reply). Does the agent's behavior meet this criterion? ${k.text} Grade strictly: it holds only if the reply and tool calls clearly meet it. A criterion that does not apply to this case holds.`,
          criteria: { true: "The agent meets the criterion.", false: "The agent does not meet the criterion." },
        },
      ]),
    ),
  });
  const checks = criteria.map((k): CheckResult => {
    const p = answers[k.id]?.noul ?? 0;
    return { id: `judge:${k.id}`, pass: p >= JEV_PASS, detail: `Jev p=${p.toFixed(2)}` };
  });
  return { checks, costNanoUsd };
}
