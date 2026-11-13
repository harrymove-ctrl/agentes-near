import {
  channelTopic,
  createFakeS3,
  createMemoryBlobStore,
  createMemoryPubSub,
  createPostgresSearchResolver,
  type ErrorReporter,
  type GifProvider,
  type KeyWrapper,
  noPlatformCredentials,
  type PlatformCredentials,
  type RealtimeEvent,
} from "@agenteschat/adapters";
import { and, arrayContains, type Database, eq, schema, sql } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { PROVIDER_IDS } from "@agenteschat/providers";
import { createFakeEmbeddings, createFakeProvider, type FakeProvider } from "@agenteschat/providers/testing";
import {
  type AgentRun,
  type ArtifactDeps,
  addChannelMember,
  type ContextDeps,
  createAgent,
  createAgentGifPoster,
  createArtifactToolSource,
  createAskAgentToolSource,
  createAskUserToolSource,
  createBlobStoreResolver,
  createBlockToolSource,
  createCalendarToolSource,
  createChatToolSource,
  createContextToolSource,
  createCredential,
  createDefaultRoles,
  createFakeJudge,
  createFakeScheduleReader,
  createFindAgentToolSource,
  createFollowUpToolSource,
  createHandOffToolSource,
  createIssueToolSource,
  createJobHandlers,
  createLocalKeyWrapper,
  createMachineHub,
  createMediaToolSource,
  createMissionHooks,
  createMissionToolSource,
  createModelGateway,
  createOrganization,
  createPermissionToolSource,
  createReactToolSource,
  createSandboxToolSource,
  createScheduleToolSource,
  createSkillToolSource,
  createToolGateway,
  createWikiToolSource,
  createWorkToolSource,
  type FakeScheduleAnswer,
  type FakeScheduleAnswers,
  type GatewayEmbeddings,
  localDateTimeOf,
  type RunExecutorDeps,
  type SandboxDeps,
  type ServerCatalog,
  type StorageDeps,
  type ToolGateway,
  type ToolSource,
  type WorkspaceComputer,
  zonedParts,
} from "../src";
import { type LiveSteeringHooks, listenLiveSteering } from "../src/live-steer";

export const SECRET = "test-secret-".padEnd(48, "x");

/** A person who reads Portuguese, as the tests' people do (a person with no language reads English). */
export async function addUser(db: Database, name: string) {
  const id = `user_${name}_${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(schema.users).values({ id, name, email: `${name}-${id.slice(-8)}@example.com`, locale: "pt-BR" });
  return { id, name, email: `${name}-${id.slice(-8)}@example.com` };
}

/** How tests name people: `admin` is a member holding the workspace's "Admin" role (ADR 0085). */
export type TestRole = "owner" | "admin" | "member";

/** The workspace's base and "Admin" roles, made when a test inserted the workspace itself. */
export async function ensureRoles(db: Database, orgId: string) {
  const [base] = await db
    .select({ id: schema.orgRoles.id })
    .from(schema.orgRoles)
    .where(and(eq(schema.orgRoles.orgId, orgId), eq(schema.orgRoles.kind, "everyone")));
  if (!base) await createDefaultRoles(db, orgId);
}

/** The workspace's role holding `administrator` (its "Admin"). */
export async function adminRoleId(db: Database, orgId: string) {
  await ensureRoles(db, orgId);
  const [role] = await db
    .select({ id: schema.orgRoles.id })
    .from(schema.orgRoles)
    .where(
      and(
        eq(schema.orgRoles.orgId, orgId),
        eq(schema.orgRoles.kind, "custom"),
        arrayContains(schema.orgRoles.permissions, ["administrator"]),
      ),
    )
    .limit(1);
  if (!role) throw new Error("no administrator role");
  return role.id;
}

/** Gives a member the workspace's "Admin" role. */
export async function makeAdmin(db: Database, orgId: string, userId: string) {
  const roleId = await adminRoleId(db, orgId);
  await db.insert(schema.organizationMemberRoles).values({ orgId, userId, roleId }).onConflictDoNothing();
}

export async function addMember(db: Database, orgId: string, role: TestRole, name: string = role) {
  const user = await addUser(db, name);
  await ensureRoles(db, orgId);
  await db
    .insert(schema.organizationMembers)
    .values({ orgId, userId: user.id, role: role === "owner" ? "owner" : "member" });
  if (role === "admin") await makeAdmin(db, orgId, user.id);
  return user;
}

const WORKDAYS = ["MO", "TU", "WE", "TH", "FR"];
/** "YYYY-MM-DDTHH:mm" `days` after today at `time`, in the question's zone (date math, not language). */
const dayAt =
  (days: number, time: string) =>
  ({ timezone, now }: { timezone: string; now: Date }): FakeScheduleAnswer => {
    const p = zonedParts(now, timezone);
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
    return { at: `${d.toISOString().slice(0, 10)}T${time}` };
  };
/** `minutes` from now, in the question's zone. */
const inMinutes =
  (minutes: number) =>
  ({ timezone, now }: { timezone: string; now: Date }): FakeScheduleAnswer => ({
    at: localDateTimeOf(new Date(now.getTime() + minutes * 60_000), timezone),
  });

/**
 * What the fake schedule reader answers for the phrases these tests write:
 * a lookup table standing in for the model, not a parser.
 */
export const TEST_SCHEDULES: FakeScheduleAnswers = {
  "todo dia às 8h": { rule: { freq: "daily", times: ["08:00"] } },
  "todo dia às 9h": { rule: { freq: "daily", times: ["09:00"] } },
  "todo dia às 18h": { rule: { freq: "daily", times: ["18:00"] } },
  "dias úteis às 9h": { rule: { freq: "weekly", byWeekday: WORKDAYS, times: ["09:00"] } },
  "toda segunda às 9h": { rule: { freq: "weekly", byWeekday: ["MO"], times: ["09:00"] } },
  "toda segunda às 10h": { rule: { freq: "weekly", byWeekday: ["MO"], times: ["10:00"] } },
  "toda sexta às 17h": { rule: { freq: "weekly", byWeekday: ["FR"], times: ["17:00"] } },
  "a cada hora": { rule: { freq: "hourly", times: ["00:00"] } },
  "amanhã às 9h": dayAt(1, "09:00"),
  "amanhã às 10h": dayAt(1, "10:00"),
  "em 2 horas": inMinutes(120),
  amanhã: { error: "time_missing" },
};

/**
 * A fresh database with one organization (owner `ana`), its `general`
 * channel, an Anthropic credential and one agent `@dev` in `general`.
 * Uses the fake provider and in-memory pub/sub: no network.
 */
export async function setup(
  options: {
    reply?: Parameters<typeof createFakeProvider>[0];
    budgetNanoUsd?: number | null;
    platform?: PlatformCredentials;
    /** Tool sources for the Tool Gateway (none = agents only chat). */
    toolSources?: ToolSource[];
    /** Add the built-in context tools (search_context, remember…) to the tool sources. */
    contextTools?: boolean;
    /** Add the built-in `ask_user` tool. */
    askUser?: boolean;
    /** Add the built-in `request_permission` tool. */
    permissionTools?: boolean;
    /** Add the built-in `ask_agent` tool. */
    askAgent?: boolean;
    /** Add the built-in `react` tool. */
    react?: boolean;
    /**
     * Add the built-in `send_gif` and `send_sticker` tools (ADR 0091), with `gifs` as the server's GIF search (also
     * `post_message`'s `gif`).
     */
    mediaTools?: boolean;
    /** Add the built-in `follow_up` and `cancel_follow_up` tools. */
    followUps?: boolean;
    /** Add the built-in `hand_off` tool (background runs: routines). */
    handOff?: boolean;
    /** Add the Drive tools (create_artifact…). Storage is always wired (memory platform store, fake S3). */
    artifactTools?: boolean;
    /** Add `show_block` and `start_poll` (ADR 0113). */
    blockTools?: boolean;
    chatTools?: boolean;
    /** Add the issue tools (create_issue, comment_issue…). */
    issueTools?: boolean;
    /** Add the calendar tools (list_events, find_free_time, propose_event). */
    calendarTools?: boolean;
    /** Add the skill tools (load_skill, read_skill_file). */
    skillTools?: boolean;
    /**
     * Embeddings (hybrid search): `true`, the fake for every kind; an object sets the provider (the fake when left
     * out), the kinds that get vectors and the query's timeout. Off: full-text only, no embedding usage rows.
     */
    embeddings?: boolean | Partial<Omit<GatewayEmbeddings, "apiKey">>;
    /** Where the gateway reports an embeddings outage. */
    errors?: ErrorReporter;
    /** Add the scheduling tools (schedule_reminder, create_routine…). */
    scheduleTools?: boolean;
    /** Keep the workspace's right hand (ADR 0137). Off: its only agent is `@dev`. */
    rightHand?: boolean;
    /** Each workspace gets its own computer (`MACHINE_PROVISIONING=external`). */
    workspaceComputer?: WorkspaceComputer;
    /** Add the wiki tools (search_wiki, read_wiki_page, create_wiki_page…). */
    wikiTools?: boolean;
    /** Add the sandbox tools with connected machines (a machine hub on this db). */
    machines?: boolean;
    /** With `machines`: the mission tools (propose_mission and, in a mission thread, its tools). The hub's mission hooks are always set. */
    missionTools?: boolean;
    /**
     * Answers of the fake judge (judge.ts): by judgment kind and question id. Default: every Noul 0, but an agent's
     * mention needs nothing (`createFakeJudge`).
     */
    judge?: Parameters<typeof createFakeJudge>[0];
    /** The fake schedule reader's table (phrase → answer), on top of `TEST_SCHEDULES`. */
    schedules?: FakeScheduleAnswers;
    /** Tools on demand (ADR 0043): the judge picks the tool groups each run lists. */
    toolsOnDemand?: boolean;
    /** The agent's browser started ahead when a run's judge chose it (ADR 0040 §11). */
    warmBrowser?: RunExecutorDeps["warmBrowser"];
    /** What the server can connect: `find_tools` names the connectors an agent lacks. None: it names none. */
    catalog?: ServerCatalog;
    /**
     * GIF search for the jobs (ADR 0091): an agent's GIF after its reply, and `send_gif` with `mediaTools`. None: its
     * own stickers only.
     */
    gifs?: GifProvider | null;
    /** How long a run started on a person's message waits for their next one (`waitForBurst`). None: no wait. */
    quietMs?: number;
    /** Add long work's tools (work_in_background, post_update, steer_work, stop_work; ADR 0121). */
    workTools?: boolean;
    /** Long work's safety net (ADR 0121 §1). None: off (no test moves by accident). */
    workAuto?: { afterMs?: number; afterCalls?: number; minMs?: number; tickMs?: number };
  } = {},
) {
  const { db, close } = await createTestDatabase();
  const keyWrapper: KeyWrapper = createLocalKeyWrapper(SECRET);
  const owner = await addUser(db, "ana");
  const { organization: org, general } = await createOrganization(db, owner.id, {
    name: "Acme",
    context: "Acme builds rockets.",
  });
  // Every workspace comes with its right hand (ADR 0137); the tests about it keep it, the others count only theirs.
  if (!options.rightHand) await db.delete(schema.agents).where(eq(schema.agents.orgId, org.id));
  const credential = await createCredential(db, keyWrapper, owner.id, org.id, {
    provider: "anthropic",
    label: "main",
    apiKey: "sk-ant-test-key-1234",
  });
  const first = await createAgent(
    db,
    owner.id,
    org.id,
    {
      name: "Dev",
      handle: "dev",
      role: "Developer",
      instructions: "Answer briefly.",
      credentialId: credential.id,
      monthlyBudgetNanoUsd: options.budgetNanoUsd ?? null,
    },
    { model: "claude-sonnet-5-5" },
  );
  const agent = first;
  // New agents get their computer and the task board by default; tests that use them grant them themselves.
  await db
    .delete(schema.agentScopes)
    .where(
      sql`${schema.agentScopes.agentId} = ${agent.id} and ${schema.agentScopes.scope} in ('sandbox:run', 'browser:use', 'desktop:use', 'issues:write')`,
    );
  await addChannelMember(db, owner.id, org.id, general.id, { agentId: agent.id });

  const provider: FakeProvider = createFakeProvider(options.reply);
  const openaiProvider: FakeProvider = createFakeProvider(options.reply);
  const pubsub = createMemoryPubSub();
  const embeddings = createFakeEmbeddings();
  const gateway = createModelGateway({
    db,
    keyWrappers: [keyWrapper],
    // Every provider but OpenAI answers through `provider`.
    providers: { ...Object.fromEntries(PROVIDER_IDS.map((id) => [id, provider])), openai: openaiProvider },
    platformCredentials: options.platform ?? noPlatformCredentials,
    embeddings: options.embeddings
      ? { provider: embeddings, apiKey: "test", ...(options.embeddings === true ? {} : options.embeddings) }
      : undefined,
    errors: options.errors,
  });
  const search = createPostgresSearchResolver(db);
  const context: ContextDeps = {
    db,
    gateway,
    search,
    summaryModel: "claude-haiku-5-5",
    pubsub,
    reflect: { everyMessages: 1000, idleMinutes: 120, maxPerThread: 5 },
    judge: createFakeJudge(options.judge),
    schedules: createFakeScheduleReader({ ...TEST_SCHEDULES, ...options.schedules }),
  };
  // Platform storage in memory; org buckets on a fake S3 server at s3.example.com (DNS faked: public IP).
  const platformBlobs = createMemoryBlobStore();
  const s3 = createFakeS3({
    host: "s3.example.com",
    region: "us-east-1",
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret-test-key-123456",
    buckets: ["acme-files", "acme-new"],
  });
  const storage: StorageDeps = {
    db,
    keyWrappers: [keyWrapper],
    platform: platformBlobs,
    fetch: s3.fetch,
    resolveHost: async (host) => (host.endsWith("example.com") ? ["93.184.216.34"] : ["10.0.0.5"]),
  };
  const artifactDeps: ArtifactDeps = { db, blobs: createBlobStoreResolver(storage), pubsub };
  const machineHub = options.machines ? createMachineHub({ db, pubsub, replicaId: "replica-a" }) : null;
  const sandboxDeps: SandboxDeps | null = machineHub
    ? { db, machines: { hub: machineHub }, publicUrl: "http://localhost:3000" }
    : null;
  const missionDeps = {
    pubsub,
    hub: machineHub,
    artifacts: artifactDeps,
    search: context,
    publicUrl: "http://localhost:3000",
    judge: context.judge,
  };
  const sources = [
    ...(options.missionTools && machineHub ? [createMissionToolSource(missionDeps)] : []),
    ...(options.askUser
      ? [createAskUserToolSource({ judge: context.judge, tools: (): ToolGateway | undefined => tools })]
      : []),
    ...(options.permissionTools ? [createPermissionToolSource()] : []),
    ...(options.askAgent
      ? [
          createAskAgentToolSource({ pubsub, ai: { gateway, machines: machineHub }, judge: context.judge }),
          createFindAgentToolSource({ machines: machineHub }),
        ]
      : []),
    ...(options.react ? [createReactToolSource({ pubsub })] : []),
    ...(options.mediaTools ? [createMediaToolSource({ pubsub, gifs: options.gifs ?? null })] : []),
    ...(options.followUps ? [createFollowUpToolSource({ pubsub })] : []),
    ...(options.workTools ? [createWorkToolSource({ pubsub })] : []),
    ...(options.handOff
      ? [
          createHandOffToolSource({
            pubsub,
            judge: context.judge,
            tools: (): ToolGateway | undefined => tools,
            gif: createAgentGifPoster(options.gifs),
          }),
        ]
      : []),
    ...(options.artifactTools ? [createArtifactToolSource(artifactDeps)] : []),
    ...(options.blockTools ? [createBlockToolSource(artifactDeps)] : []),
    ...(options.chatTools
      ? [createChatToolSource({ pubsub, artifacts: artifactDeps, gif: createAgentGifPoster(options.gifs) })]
      : []),
    ...(options.issueTools ? [createIssueToolSource(artifactDeps)] : []),
    ...(options.calendarTools ? [createCalendarToolSource({ db, pubsub })] : []),
    ...(options.skillTools
      ? [
          createSkillToolSource({
            db,
            blobs: artifactDeps.blobs,
            pubsub,
            judge: context.judge,
            ...(sandboxDeps ? { computer: sandboxDeps } : {}),
          }),
        ]
      : []),
    ...(options.contextTools ? [createContextToolSource(context)] : []),
    ...(options.scheduleTools ? [createScheduleToolSource({ pubsub, context })] : []),
    ...(options.wikiTools ? [createWikiToolSource({ pubsub, search: context })] : []),
    ...(sandboxDeps
      ? [
          createSandboxToolSource({
            ...sandboxDeps,
            artifacts: artifactDeps,
            skills: { blobs: artifactDeps.blobs },
            pubsub,
          }),
        ]
      : []),
    ...(options.toolSources ?? []),
  ];
  const tools: ToolGateway | undefined =
    sources.length > 0 ? createToolGateway({ sources, catalog: options.catalog }) : undefined;
  machineHub?.setMissionHooks(createMissionHooks({ db, ...missionDeps, tools }));
  const jobDeps = {
    db,
    gateway,
    pubsub,
    maxOutputTokens: 1000,
    contextMessages: 30,
    workspaceComputer: options.workspaceComputer,
    maxHops: 100,
    tools,
    context,
    search,
    storage,
    artifacts: artifactDeps,
    sandbox: sandboxDeps,
    toolsOnDemand: options.toolsOnDemand ?? false,
    ...(options.warmBrowser ? { warmBrowser: options.warmBrowser } : {}),
    ...(options.gifs ? { gifs: options.gifs } : {}),
    ...(options.quietMs ? { quietMs: options.quietMs } : {}),
    workAutoAfterMs: options.workAuto?.afterMs ?? 24 * 3600_000,
    workAutoAfterCalls: options.workAuto?.afterCalls ?? 100_000,
    workAutoMinMs: options.workAuto?.minMs,
    workTickMs: options.workAuto?.tickMs ?? 60_000,
  };
  const handlers = createJobHandlers(jobDeps);

  /** Records every event published to a channel. */
  const listen = (channelId: string) => {
    const events: RealtimeEvent[] = [];
    pubsub.subscribe(channelTopic(channelId), (e) => events.push(e));
    return events;
  };

  return {
    db,
    close,
    keyWrapper,
    owner,
    org,
    general,
    credential,
    agent,
    provider,
    openaiProvider,
    pubsub,
    gateway,
    tools,
    context,
    search,
    embeddings,
    handlers,
    jobDeps,
    listen,
    platformBlobs,
    s3,
    storage,
    artifactDeps,
    sandboxDeps,
    machineHub,
    missionDeps: { db, ...missionDeps },
  };
}

export type Fixture = Awaited<ReturnType<typeof setup>>;

/**
 * What the executor of a run set to `running` by hand would do: answer a message steered into the run at once
 * (no turn takes it here, so it stays in the run's inbox). Unanswered, posting that message waits out
 * `LIVE_STEER_WAIT_MS`, 3 s of real time. `hooks`: the executor's own (its inbox, its background work), for a test
 * that hands it a turn.
 */
export const answerSteering = (f: Fixture, run: AgentRun, hooks: Partial<LiveSteeringHooks> = {}) =>
  listenLiveSteering(f, run, null, { take: async () => [], onRead: () => {}, ...hooks });
