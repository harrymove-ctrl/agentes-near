import {
  type Adapters,
  type BrainTurnRequest,
  type ErrorReporter,
  type S3Fetch,
  type SpeechFetch,
  STREAM_CLOSE,
} from "@agenteschat/adapters";
import { type Config, connectorOAuthApps, githubAppConfig } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import {
  AntigravityBrain,
  APP_FAULT_HINT,
  type ArtifactDeps,
  agentScopeFromDb,
  authorizeStream,
  type BrainTurn,
  blockSpecAt,
  CodexBrain,
  type ContextDeps,
  CursorBrain,
  composioConnectorsOf,
  connectOverHttp,
  createAgentGifPoster,
  createAgentStyleToolSource,
  createApprovalRequestToolSource,
  createArtifactToolSource,
  createAskAgentToolSource,
  createAskUserToolSource,
  createBlobStoreResolver,
  createBlockToolSource,
  createBrowserHandoffToolSource,
  createBrowserLive,
  createBrowserToolSource,
  createCalendarToolSource,
  createChatToolSource,
  createClaudeCodeBrain,
  createConnectorToolSource,
  createContextToolSource,
  createDashboardToolSource,
  createDatabaseToolSource,
  createDesktopControl,
  createDesktopToolSource,
  createDeviceToolSource,
  createFeedbackToolSource,
  createFindAgentToolSource,
  createFollowUpToolSource,
  createGitHubAppSettings,
  createGitToolSource,
  createHandOffToolSource,
  createIssueToolSource,
  createJevJudge,
  createJevKey,
  createJobHandlers,
  createLlmJudge,
  createMachineHub,
  createMailToolSource,
  createMediaToolSource,
  createMissionHooks,
  createMissionRunToolSource,
  createMissionToolSource,
  createModelGateway,
  createPassToolSource,
  createPermissionToolSource,
  createReactToolSource,
  createReleaseAsksToolSource,
  createSandboxToolSource,
  createScheduleToolSource,
  createSessionScreening,
  createSetStatusToolSource,
  createSetupToolSource,
  createSkillToolSource,
  createSpeechSettings,
  createStreamBroker,
  createTalker,
  createTeamStatusToolSource,
  createToolGateway,
  createUsageToolSource,
  createVaultToolSource,
  createWebToolSource,
  createWikiToolSource,
  createWithdrawRequestToolSource,
  createWorkspaceToolSource,
  createWorkToolSource,
  deviceWaitHooks,
  type EmailArt,
  emailArtAt,
  envSpeechEngines,
  type GatewayEmbeddings,
  type GitProxyDeps,
  GrokBrain,
  getAgentCached,
  hubBrainLink,
  isAgentesCloud,
  isRightHand,
  type JobDeps,
  type Judge,
  type MailDeps,
  type McpConnect,
  messageRouter,
  missionTurnPermissions,
  notifyOwnerOnBudget,
  OpencodeBrain,
  platformCapJudge,
  prepareAgentCode,
  queueBudgetEmail,
  type ResolveHost,
  RIGHT_HAND_TURN,
  ROUTER_QUIET_MS,
  type RunExecutorDeps,
  reauthorizeStream,
  recheckStream,
  releaseRunPhones,
  resolveSummaryModel,
  type SandboxDeps,
  type ScheduleReader,
  type SkillDeps,
  type StorageDeps,
  setWorkOrgCap,
  smallModelFor,
  standingJudge,
  streamClosed,
  type ToolSource,
  type VaultDeps,
  type VoiceDeps,
  warmAgentBrowser,
  withComposio,
  withJudgeFallback,
} from "@agenteschat/engine";
import { createOpenAIEmbeddings, createVoyageEmbeddings, type ModelProvider } from "@agenteschat/providers";
import { type AppleTokenRevoker, appleTokenRevoker } from "./auth";
import { hookConfig } from "./routes/app/context";
import { version } from "./version";

/** Why `/api/terminal` closes (with 4404) where sessions are screened (ADR 0076 §7). */
export const NO_TERMINAL = "no_terminal";

export interface EngineOptions {
  db: Database;
  config: Config;
  adapters: Adapters;
  modelProviders: Record<string, ModelProvider>;
  /** Tests: extra tool sources, in-process MCP, fake HTTP, fake embeddings. */
  toolSources?: ToolSource[];
  mcpConnect?: McpConnect;
  /** Revokes Apple tokens at an account's deletion (ADR 0035); absent: from `config`. */
  appleRevoke?: AppleTokenRevoker;
  http?: typeof fetch;
  embeddings?: GatewayEmbeddings;
  /** Latency measurements from runs (logged by the server). */
  onTiming?(name: string, ms: number, attrs: Record<string, unknown>): void;
  /** Tests: fake TypeSafe transport. */
  jevFetch?: typeof fetch;
  /**
   * Tests: how long a person's message waits for their next one before the router decides, or before the run it
   * started makes its first model call (`ROUTER_QUIET_MS`).
   */
  routerQuietMs?: number;
  /** Tests: a fake judge (no model calls for "is this a stop?" and the like). */
  judge?: Judge;
  /** Tests: a fake schedule reader (no model calls for "toda segunda às 9h" and the like). */
  schedules?: ScheduleReader;
  /** Tests: fake S3 server and DNS for org buckets. */
  s3Fetch?: S3Fetch;
  /** Tests: fake speech providers. */
  speechFetch?: SpeechFetch;
  resolveHost?: ResolveHost;
  /** Per-run stage breakdown (debug log). */
  onRunProfile?: RunExecutorDeps["onRunProfile"];
  /** Tests: a fake GitHub (git smart HTTP and REST) for the git proxy and tools. */
  github?: { gitUrl: string; apiUrl: string; fetch: typeof fetch };
  /** Tests: this process's replica id for the machine hub (default: random). */
  replicaId?: string;
  /** Tools on demand (ADR 0043; default on). Tests turn it off: every granted tool is listed. */
  toolsOnDemand?: boolean;
  /** Where emails get their pictures (`emailArtFor` at boot); default: linked from `PUBLIC_URL`'s `/email/`. */
  emailArt?: EmailArt;
  log?: {
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
  };
  /** Error reports (ADR 0104) for failures nothing logs: learning's (`reportLearnFailure`). */
  errors?: ErrorReporter;
}

/**
 * Wires the engine the same way for the server and the tests: Model Gateway
 * (budgets, embeddings), Tool Gateway (connectors + context tools + extra
 * sources), context deps (summaries, reflection), and the job handlers.
 */
export function buildEngine(o: EngineOptions) {
  const { db, config, adapters } = o;
  const keyWrappers = [adapters.keyWrapper, ...adapters.legacyKeyWrappers];
  const tuning = { kinds: config.EMBEDDINGS_KINDS, queryTimeoutMs: config.EMBEDDINGS_QUERY_TIMEOUT_MS };
  const embeddings: GatewayEmbeddings | undefined =
    o.embeddings ??
    (config.EMBEDDINGS_PROVIDER === "voyage" && config.VOYAGE_API_KEY
      ? {
          provider: createVoyageEmbeddings({ model: config.EMBEDDING_MODEL }),
          apiKey: config.VOYAGE_API_KEY,
          ...tuning,
        }
      : config.EMBEDDINGS_PROVIDER === "openai" && config.EMBEDDINGS_URL
        ? {
            provider: createOpenAIEmbeddings({ url: config.EMBEDDINGS_URL, model: config.EMBEDDING_MODEL }),
            apiKey: config.EMBEDDINGS_API_KEY ?? "",
            ...tuning,
          }
        : undefined);
  const gateway = createModelGateway({
    db,
    keyWrappers,
    providers: o.modelProviders,
    platformCredentials: adapters.platformCredentials,
    onBudgetThreshold: async (e) => {
      await notifyOwnerOnBudget(adapters.pubsub, db)(e);
      await queueBudgetEmail(db, config.PUBLIC_URL, e);
    },
    embeddings,
    errors: o.errors,
  });
  const context: ContextDeps = {
    db,
    gateway,
    search: adapters.search,
    summaryModel: config.SUMMARY_MODEL,
    cheapModels: { openai: config.OPENAI_CHEAP_MODEL },
    pubsub: adapters.pubsub,
    judge: o.judge,
    schedules: o.schedules,
    errors: o.errors,
    reflect: {
      everyMessages: config.REFLECT_EVERY_MESSAGES,
      idleMinutes: config.REFLECT_IDLE_MINUTES,
      maxPerThread: config.REFLECT_MAX_PER_THREAD,
    },
    learn: {
      maxPerAgentDay: config.LEARN_MAX_PER_AGENT_DAY,
      minToolCalls: config.LEARN_MIN_TOOL_CALLS,
      skillAfter: config.LEARN_SKILL_AFTER,
    },
  };
  // The installation's Jev key (ADR 0073): `TYPESAFE_API_KEY`, else the one its owner adds in Settings.
  const jevKey = createJevKey({
    db,
    keyWrapper: adapters.keyWrapper,
    keyWrappers,
    envKey: config.TYPESAFE_API_KEY,
    fetch: o.jevFetch,
  });
  // The small model that routes and judges on an organization's keys (ADR 0074): the deployment's own on a
  // Claude or an OpenAI key, the catalog's routing pick on the others.
  const smallModels = { anthropic: config.ROUTER_MODEL, openai: config.OPENAI_CHEAP_MODEL };
  // Semantic judgments (stop requests, hand-offs, permission changes): Jev while the installation has its key,
  // with the org's small model as fallback (also past a workspace's platform AI for the month, ADR 0079).
  if (!context.judge) {
    const llmJudge = createLlmJudge({
      gateway,
      resolveModel: (orgId) => smallModelFor({ db, gateway }, orgId, smallModels),
    });
    context.judge = withJudgeFallback(
      platformCapJudge(
        db,
        createJevJudge({
          key: jevKey,
          gateway,
          timeoutMs: config.JEV_TIMEOUT_MS,
          visionModel: config.JEV_VISION_MODEL,
          fetch: o.jevFetch,
        }),
      ),
      llmJudge,
      () => jevKey.usable(),
    );
  }
  // Screenshots go only to Jev's vision model: with a fake judge (tests) nothing looks at them.
  const vision = o.judge ? undefined : () => jevKey.usable();
  // Nothing is judged for a workspace on hold or suspended: Jev bills the server, not the workspace.
  context.judge = standingJudge(db, context.judge);
  // The agents' conversation layer: a fast reply on the org's cheap model while a task works or waits.
  const talker = createTalker({
    db,
    pubsub: adapters.pubsub,
    gateway,
    resolveModel: (orgId) => resolveSummaryModel(context, orgId),
  });
  // Services through Composio (ADR 0107) share the mailboxes' client and its per-workspace count of calls.
  const composio = composioConnectorsOf(adapters.mail);
  const connectorDeps = {
    db,
    keyWrappers,
    oauthApps: connectorOAuthApps(config),
    publicUrl: config.PUBLIC_URL,
    http: o.http,
    connect: withComposio(o.mcpConnect ?? connectOverHttp, composio),
    composio,
  };
  const storage: StorageDeps = {
    db,
    keyWrappers,
    platform: adapters.platformBlobs,
    fetch: o.s3Fetch,
    resolveHost: o.resolveHost,
  };
  const artifacts: ArtifactDeps = { db, blobs: createBlobStoreResolver(storage), pubsub: adapters.pubsub };
  // Agents' computers (ADR 0025): connected machines, through the hub that holds their sockets.
  const machineHub = createMachineHub({
    db,
    pubsub: adapters.pubsub,
    replicaId: o.replicaId,
    readyEmail: adapters.email.delivers ? { publicUrl: config.PUBLIC_URL, gateway } : null,
    errors: o.errors,
  });
  const workspaceComputer =
    config.MACHINE_PROVISIONING === "external" ? { billing: Boolean(config.BILLING_URL) } : undefined;
  const sandbox: SandboxDeps = {
    db,
    machines: { hub: machineHub },
    workspaceComputer,
    // Git through our proxy (ADR 0024): the computer never gets a GitHub token.
    git: { publicUrl: config.PUBLIC_URL, secret: config.AGENTES_SECRET },
    publicUrl: config.PUBLIC_URL,
  };
  // Missions (ADR 0029): their executors' MCP calls and reconnects come through the hub.
  const missionDeps = {
    pubsub: adapters.pubsub,
    hub: machineHub,
    artifacts,
    search: context,
    publicUrl: config.PUBLIC_URL,
    judge: context.judge,
  };
  // The server's GitHub App (ADR 0156): `GITHUB_APP_*`, else the one its owner made from Settings, read on every call
  // (through the getters below), so one made or removed there works without a restart.
  const githubApp = createGitHubAppSettings({
    db,
    keyWrapper: adapters.keyWrapper,
    keyWrappers,
    env: githubAppConfig(config),
  });
  const githubHttp = o.github ? { apiUrl: o.github.apiUrl, fetch: o.github.fetch } : undefined;
  const githubAppAccess = {
    app: () => githubApp.current(),
    http: githubHttp ?? { apiUrl: "https://api.github.com", fetch: o.http ?? fetch },
  };
  const gitProxy: GitProxyDeps = {
    db,
    secret: config.AGENTES_SECRET,
    connectors: connectorDeps,
    upstream: o.github,
    get app() {
      return githubApp.current();
    },
  };
  // Skills read from their links (installing, updating): private repositories through the workspace's GitHub.
  const skillDeps: SkillDeps = {
    db,
    blobs: artifacts.blobs,
    fetch: o.http,
    resolveHost: o.resolveHost,
    github: {
      connectors: connectorDeps,
      get app() {
        return githubApp.current();
      },
    },
    pubsub: adapters.pubsub,
  };
  // The Vault (ADR 0144): built-in items sealed with the installation's key wrapper, plus the external sources
  // (1Password, Bitwarden, a module's) the adapters bring.
  const vault: VaultDeps = {
    db,
    keyWrapper: adapters.keyWrapper,
    keyWrappers,
    sources: adapters.vaultSources ?? {},
    pubsub: adapters.pubsub,
  };
  // The agent's own browser on its connected computer (ADR 0040): `browser:use`, when the machine serves it.
  // Targets in words, checks and finds go to the judge (ADR 0054); screenshots only to Jev's vision model.
  // A saved login from the Vault is sealed for the agent's computer at the step that types it (ADR 0144).
  const browserTools = createBrowserToolSource({
    machines: { hub: machineHub },
    pubsub: adapters.pubsub,
    judge: context.judge,
    vision,
    publicUrl: config.PUBLIC_URL,
    errors: o.errors,
    vault,
  });
  // The workspace's cap of live background works (ADR 0121 §7).
  setWorkOrgCap(config.AGENT_WORK_MAX_PER_ORG);
  const tools = createToolGateway({
    sources: [
      // A question for what the agent could find, or a secret asked in the chat, is held first (ADR 0109).
      createAskUserToolSource({ judge: context.judge, tools: () => tools }),
      // Missing something a request needs: ask for it (an approval card) instead of failing.
      createPermissionToolSource(),
      // The agent browser asks a person for help (ADR 0040 §6).
      createBrowserHandoffToolSource({ pubsub: adapters.pubsub, machines: { hub: machineHub } }),
      // The agent takes back a request for a person it no longer needs (listed while it has one open).
      createWithdrawRequestToolSource({ pubsub: adapters.pubsub }),
      // An agent that handled what another waits to answer (its plan, budget or computer) lets it go.
      createReleaseAsksToolSource({ pubsub: adapters.pubsub }),
      // An agent with no AI connected is refused at once: its answer would never come.
      createAskAgentToolSource({
        pubsub: adapters.pubsub,
        ai: { gateway, machines: machineHub },
        judge: context.judge,
      }),
      createFindAgentToolSource({ machines: machineHub }),
      createUsageToolSource(),
      // What people saved for the agent in the Vault, found before it asks them (ADR 0144).
      createVaultToolSource(vault),
      // What the agent says it is doing, next to its name (ADR 0084).
      createSetStatusToolSource({ pubsub: adapters.pubsub }),
      // How the person asked agents to talk to them (ADR 0147).
      createAgentStyleToolSource(),
      // A person's feedback, sent by the agent they asked or offered by it when the app fails, where the server takes
      // feedback (ADR 0160 §11, §12).
      createFeedbackToolSource({
        to: config.FEEDBACK_EMAIL,
        version,
        rateLimiter: adapters.rateLimiter,
      }),
      createReactToolSource({ pubsub: adapters.pubsub }),
      // A GIF or the agent's sticker when asked (ADR 0091): listed by the workspace's switches and the agent's.
      createMediaToolSource({ pubsub: adapters.pubsub, gifs: adapters.gifs ?? null }),
      // Long work goes to the background and reports back by itself, on every brain (ADR 0121).
      createWorkToolSource({ pubsub: adapters.pubsub }),
      // An agent comes back to a conversation by itself (a CI run, a deploy), instead of promising to.
      createFollowUpToolSource({ pubsub: adapters.pubsub }),
      // The right hand sees what the team is doing, with no model call (ADR 0137 §13).
      createTeamStatusToolSource(),
      // Background runs (routines) speak only through it, with a GIF where the agent may send one (ADR 0091).
      createHandOffToolSource({
        pubsub: adapters.pubsub,
        judge: context.judge,
        tools: () => tools,
        gif: createAgentGifPoster(adapters.gifs),
      }),
      // Runs nobody called by name may stay quiet (reply-policy.ts): listed only for them.
      createPassToolSource(),
      createArtifactToolSource(artifacts),
      // Live blocks and votes in the agent's own conversation (ADR 0113).
      createBlockToolSource(artifacts),
      createChatToolSource({ pubsub: adapters.pubsub, artifacts, gif: createAgentGifPoster(adapters.gifs) }),
      createWorkspaceToolSource({ pubsub: adapters.pubsub }),
      // Setting up the workspace from the chat: Connect cards a person clicks, channels with Undo, new agents proposed.
      createSetupToolSource({
        pubsub: adapters.pubsub,
        ai: { gateway },
        context,
        catalog: { oauthApps: connectorDeps.oauthApps, mail: adapters.mail, composio },
        server: { publicUrl: config.PUBLIC_URL, secret: config.AGENTES_SECRET },
      }),
      createIssueToolSource(artifacts),
      // Dashboards and widgets (ADR 0135 §10): boards for the person, and a widget run's only voice (`update_widget`).
      createDashboardToolSource({ db, pubsub: adapters.pubsub, context }),
      createSkillToolSource({
        ...skillDeps,
        judge: context.judge,
        computer: sandbox,
      }),
      createCalendarToolSource({ db, pubsub: adapters.pubsub, publicUrl: config.PUBLIC_URL }),
      createScheduleToolSource({
        pubsub: adapters.pubsub,
        context,
        mail: adapters.mail,
        hooks: hookConfig(config),
        connectors: connectorDeps,
      }),
      createWikiToolSource({ pubsub: adapters.pubsub, search: context }),
      createContextToolSource(context),
      createConnectorToolSource({
        ...connectorDeps,
        artifacts,
        log: o.log,
        judge: context.judge,
        githubApp: githubAppAccess,
      }),
      // People's mailboxes (ADR 0038): only when the server has a mail path (Composio, IMAP).
      createMailToolSource({
        keyWrappers,
        mail: adapters.mail,
        publicUrl: config.PUBLIC_URL,
        resolveHost: o.resolveHost,
        artifacts,
      }),
      // People's Postgres databases (ADR 0039): read-only queries, when the server has a driver.
      createDatabaseToolSource({ keyWrappers, databases: adapters.databases, resolveHost: o.resolveHost }),
      createMissionToolSource(missionDeps),
      // Approval from the people who decide (ADR 0126): after the missions source, whose own request_approval wins
      // in a mission's thread.
      createApprovalRequestToolSource(),
      // Computer-brain runs only (calls through the runner bridge): before the sandbox tools, so these
      // win a name clash (`start_task`) there.
      createMissionRunToolSource(missionDeps),
      createSandboxToolSource({
        ...sandbox,
        artifacts,
        skills: { blobs: artifacts.blobs },
        pubsub: adapters.pubsub,
        // Saved keys for one command (`run_code` with `keys`, ADR 0144).
        vault,
      }),
      // Phones through connected computers and waiting for a device (bring your own devices).
      createDeviceToolSource({
        db,
        machines: { hub: machineHub },
        pubsub: adapters.pubsub,
        artifacts,
        publicUrl: config.PUBLIC_URL,
      }),
      browserTools,
      // Reading the web, for every agent and run (ADR 0109): a search service when configured, else the agent's
      // own browser, else DuckDuckGo's HTML page.
      createWebToolSource({
        braveKey: config.BRAVE_SEARCH_API_KEY,
        searxngUrl: config.SEARXNG_URL,
        browser: browserTools.readPage,
        resolveHost: o.resolveHost,
        usage: gateway,
      }),
      // The agent's own desktop (ADR 0062): `desktop:use` with Run code, when its computer serves desktop use.
      createDesktopToolSource({
        machines: { hub: machineHub },
        pubsub: adapters.pubsub,
        judge: context.judge,
        vision,
        publicUrl: config.PUBLIC_URL,
      }),
      // Git through our proxy (ADR 0024): connected machines clone and push through the runner's `git.sync`
      // (only our credential reaches the machine; nothing global changes there).
      createGitToolSource({
        sandbox,
        connectors: connectorDeps,
        get app() {
          return githubApp.current();
        },
        github: githubHttp,
        pubsub: adapters.pubsub,
      }),
      ...(o.toolSources ?? []),
    ],
    catalog: { oauthApps: connectorDeps.oauthApps, mail: adapters.mail, composio },
    pubsub: adapters.pubsub,
    // One of our own tools broke: where the server takes feedback, the agent may offer a report (ADR 0160 §12).
    ...(config.FEEDBACK_EMAIL ? { faultHint: APP_FAULT_HINT } : {}),
  });
  // Mission tasks' tools and computer-brain runs' tools come through the hub's MCP bridge (ADR 0032).
  // Runs waiting for a device (bring your own devices) go on when its computer is back or its phones report it free.
  const missionHooks = createMissionHooks({ db, ...missionDeps, tools });
  const deviceWaits = deviceWaitHooks({ db, pubsub: adapters.pubsub });
  const hooks = {
    ...missionHooks,
    online: async (machineId: string) => {
      await missionHooks.online?.(machineId);
      await deviceWaits.online(machineId).catch(() => undefined);
    },
    phonesChanged: deviceWaits.phonesChanged,
  };
  machineHub.setMissionHooks(hooks);
  // The agent's Chrome started ahead of its first command (ADR 0040 §11): a head start, so a refusal costs nothing.
  const warmBrowser = (at: Parameters<typeof warmAgentBrowser>[2]) =>
    void warmAgentBrowser(db, machineHub, at).catch(() => {});
  // The agent browser's live view (ADR 0040 §7): the runner's frames go to viewers in memory. Its log says how each
  // view's own socket went (§7.1).
  const browserLive = createBrowserLive({
    db,
    pubsub: adapters.pubsub,
    hub: machineHub,
    warm: warmBrowser,
    log: o.log,
  });
  machineHub.setBrowserHooks(browserLive.hubHooks);
  // agentes.chat Cloud reads the screen's text while a person is in control (ADR 0076); a self-hosted server never.
  const sessions = config.SESSION_SCREENING ? createSessionScreening({ db, hub: machineHub, log: o.log }) : null;
  // Agents' desktops and terminals (ADR 0058): each person's stream paired with the runner's data socket for it,
  // its access checked again while open; control changing hands closes the views it hides. Where sessions are
  // screened no terminal opens: a shell nobody screens would be the way around it.
  const streams = createStreamBroker({
    db,
    hub: machineHub,
    authorize: async (input) => {
      if (sessions && input.request.kind === "terminal") return { refused: STREAM_CLOSE.notFound, reason: NO_TERMINAL };
      const target = await authorizeStream(
        { db, hub: machineHub, rateLimiter: adapters.rateLimiter, pubsub: adapters.pubsub },
        input,
      );
      // Someone opened the agent's desktop: its browser gets ready for the agent's next command meanwhile. Not for
      // a browser card's view (ADR 0058 §7): a card that only looks doesn't start Chrome again after Stop.
      if (input.request.kind === "desktop" && "machineId" in target && !target.held && !input.preview) {
        warmBrowser({ orgId: input.orgId, agentId: input.agentId, machineId: target.machineId });
      }
      return target;
    },
    recheck: (stream) => recheckStream(db, stream),
    reauthorize: (stream, mode) => reauthorizeStream(db, stream, mode),
    // An agent browser's live view has a data socket of its own too (ADR 0040 §7.1).
    claim: (streamId, machineId, socket) => browserLive.claimView(streamId, machineId, socket),
    onReady: sessions ? (stream) => sessions.ready(stream) : undefined,
    onClosed: (stream) => Promise.all([streamClosed(db, stream), sessions?.closed(stream)]),
    log: o.log,
  });
  const desktops = createDesktopControl({ db, pubsub: adapters.pubsub, hub: machineHub, streams });
  // Computer brains (ADR 0032): Claude Code and Codex on the agent's computer, through the hub. Each turn's
  // run tool token (issued by the engine) goes in `brain.turn.mcp.token`, so the runner bridge maps calls to the run.
  const agentScope = agentScopeFromDb(db);
  const brainLink = hubBrainLink({ hub: machineHub, pubsub: adapters.pubsub });
  /**
   * A computer turn's permission profile (ADR 0053 §3), the same for Claude Code and Codex: a mission run
   * keeps its own (plan before Start and while a write item is live, work otherwise; ADR 0044); every other
   * run works, whoever woke it (ADR 0109: one permission model, the agent's own). Its own branches are
   * agentes/<handle>/… (what the git proxy accepts).
   */
  const turnPermissions = async (turn: BrainTurn): Promise<BrainTurnRequest["permissions"]> =>
    // The team's right hand on a plan: our tools and nothing else (ADR 0137 §4).
    isRightHand(await getAgentCached(db, turn.orgId, turn.agentId))
      ? RIGHT_HAND_TURN
      : ((await missionTurnPermissions(db, turn)) ?? {
          mode: "work",
          branchPrefix: `agentes/${(await agentScope(turn)).handle}/`,
        });
  // Before a chat turn on a connected machine: the agent's checkouts updated through the git proxy, the turn
  // started in the repository it is about, and the "# Your code" block (ADR 0024 addendum).
  const prepareCode = (turn: Parameters<typeof prepareAgentCode>[1], signal: AbortSignal) => {
    const app = githubApp.current();
    return prepareAgentCode(
      {
        db,
        hub: machineHub,
        git: { publicUrl: config.PUBLIC_URL, secret: config.AGENTES_SECRET },
        github: app ? { app, http: githubAppAccess.http } : null,
      },
      turn,
      {
        signal,
      },
    );
  };
  // A background run (a routine's) keeps no computer process alive after its turn.
  const brains: RunExecutorDeps["brains"] = {
    claude_code: (_agent, run, setup) =>
      createClaudeCodeBrain({
        hub: machineHub,
        pubsub: adapters.pubsub,
        agentScope,
        mcpToken: () => setup.mcpToken(),
        permissions: turnPermissions,
        keepAlive: !run.background,
        prepare: prepareCode,
      }),
    codex: (_agent, run, setup) =>
      new CodexBrain({
        link: brainLink,
        mcp: async () => ({ token: setup.mcpToken() }),
        agent: agentScope,
        permissions: turnPermissions,
        keepAlive: !run.background,
        prepare: prepareCode,
      }),
    // ADR 0114: Cursor's CLI, one process per turn (nothing kept alive between turns).
    cursor: (_agent, _run, setup) =>
      new CursorBrain({
        link: brainLink,
        mcp: async () => ({ token: setup.mcpToken() }),
        agent: agentScope,
        permissions: turnPermissions,
        prepare: prepareCode,
      }),
    // ADR 0132: OpenCode's CLI, one process per turn like Cursor's.
    opencode: (_agent, _run, setup) =>
      new OpencodeBrain({
        link: brainLink,
        mcp: async () => ({ token: setup.mcpToken() }),
        agent: agentScope,
        permissions: turnPermissions,
        prepare: prepareCode,
      }),
    // ADR 0142: Grok Build, one process per turn like Cursor's.
    grok: (_agent, _run, setup) =>
      new GrokBrain({
        link: brainLink,
        mcp: async () => ({ token: setup.mcpToken() }),
        agent: agentScope,
        permissions: turnPermissions,
        prepare: prepareCode,
      }),
    // ADR 0143: Google's Antigravity CLI, one process per turn like Grok's.
    antigravity: (_agent, _run, setup) =>
      new AntigravityBrain({
        link: brainLink,
        mcp: async () => ({ token: setup.mcpToken() }),
        agent: agentScope,
        permissions: turnPermissions,
        prepare: prepareCode,
      }),
  };
  // Voice messages (ADR 0100): engines from the environment, and on any other server the one its owner sets.
  const speech = createSpeechSettings({
    db,
    keyWrapper: adapters.keyWrapper,
    keyWrappers,
    envOnly: isAgentesCloud(config.PUBLIC_URL),
    fetch: o.speechFetch,
    envEngines: envSpeechEngines(
      config.SPEECH_ENGINES,
      {
        assemblyai: { apiKey: config.ASSEMBLYAI_API_KEY },
        elevenlabs: { apiKey: config.ELEVENLABS_API_KEY },
        soniox: { apiKey: config.SONIOX_API_KEY },
        groq: { apiKey: config.GROQ_API_KEY },
        openai: { apiKey: config.OPENAI_SPEECH_API_KEY },
        deepinfra: { apiKey: config.DEEPINFRA_API_KEY },
        local: {
          baseUrl: config.LOCAL_SPEECH_URL,
          model: config.LOCAL_SPEECH_MODEL,
          apiKey: config.LOCAL_SPEECH_API_KEY,
          warm: config.LOCAL_SPEECH_WARM === "on",
        },
      },
      { fetch: o.speechFetch },
    ),
  });
  const voice: VoiceDeps = {
    db,
    pubsub: adapters.pubsub,
    blobs: artifacts.blobs,
    engines: speech.chain,
    judge: context.judge,
    retentionDays: config.VOICE_RETENTION_DAYS,
    // Fair use is for what we pay for: a self-hosted server has no limit.
    limits: isAgentesCloud(config.PUBLIC_URL)
      ? {
          personMinutesPerDay: config.VOICE_LIMIT_PERSON_MINUTES_PER_DAY,
          orgMinutesPerMember: config.VOICE_LIMIT_ORG_MINUTES_PER_MEMBER,
          orgMinMinutesPerDay: config.VOICE_LIMIT_ORG_MIN_MINUTES_PER_DAY,
        }
      : null,
  };
  const jobDeps: JobDeps = {
    feedbackBlobs: adapters.platformBlobs,
    accountEmails: adapters.email.delivers ? { publicUrl: config.PUBLIC_URL, support: config.SUPPORT_EMAIL } : null,
    appleRevoke: o.appleRevoke ?? appleTokenRevoker(config),
    voice,
    db,
    gateway,
    pubsub: adapters.pubsub,
    tools,
    context,
    search: adapters.search,
    email: adapters.email,
    emailArt: o.emailArt ?? emailArtAt(config.PUBLIC_URL),
    push: adapters.push,
    // Browsers (ADR 0071): full text, encrypted to the browser.
    webPush: adapters.webPush,
    // A push not waiting on the person holds while they have the app open (ADR 0071 §7).
    presence: adapters.presence,
    // Phones signed in to several servers open the push's workspace on this one (ADR 0154).
    pushServer: new URL(config.PUBLIC_URL).origin,
    storage,
    artifacts,
    sandbox,
    skills: skillDeps,
    // A workspace's deletion revokes its grants at GitHub and Composio, and leaves a line in the log.
    connectors: connectorDeps,
    githubApp: githubAppAccess,
    // External Vault sources synced every few minutes (ADR 0144).
    vault,
    mail: adapters.mail,
    // An agent's GIF after a light reply (ADR 0091): none without the server's GIF provider.
    gifs: adapters.gifs ?? null,
    log: o.log,
    maxToolTurns: config.AGENT_MAX_TOOL_TURNS,
    // A run started on a person's message reads what they add in the next seconds with it (ADR 0112).
    quietMs: o.routerQuietMs ?? ROUTER_QUIET_MS,
    // It ends early when the person isn't typing, and Claude's API reads the prompt into its cache meanwhile.
    quietByTyping: true,
    prewarm: true,
    // Tools on demand (ADR 0043): each run lists what the judge expects it to need; the rest behind `find_tools`.
    toolsOnDemand: o.toolsOnDemand ?? true,
    warmBrowser,
    brains,
    prepareCode,
    machines: machineHub,
    workspaceComputer,
    releaseRunPhones: (run) => releaseRunPhones({ db, hub: machineHub }, run),
    maxOutputTokens: config.AGENT_MAX_OUTPUT_TOKENS,
    contextMessages: config.AGENT_CONTEXT_MESSAGES,
    blockSpec: (orgId, artifactId, version) => blockSpecAt(artifacts, orgId, artifactId, version),
    maxHops: config.AGENT_MAX_HOPS,
    onTiming: o.onTiming,
    onRunProfile: o.onRunProfile,
    router: {
      enabled: config.ROUTER_ENABLED,
      model: smallModels.anthropic,
      cheapModels: { openai: smallModels.openai },
      // The author's own plan on their computer, where the server isn't the Cloud's (ADR 0074).
      plans: { hub: machineHub, publicUrl: config.PUBLIC_URL },
      minScore: config.ROUTER_MIN_SCORE,
      mentionThreshold: config.ROUTER_MENTION_THRESHOLD,
      quietMs: o.routerQuietMs ?? ROUTER_QUIET_MS,
      quietByTyping: true,
      // Jev first whenever the installation has its key, unless ROUTER_STRATEGY=llm.
      ...((config.ROUTER_STRATEGY ?? "jev") === "jev"
        ? { jev: { key: jevKey, timeoutMs: config.JEV_TIMEOUT_MS, fetch: o.jevFetch } }
        : {}),
    },
  };
  const handlers = createJobHandlers(jobDeps);
  // Mail accounts, inbound mail and polling (routes and workers).
  const mail: MailDeps = {
    db,
    keyWrappers,
    mail: adapters.mail,
    publicUrl: config.PUBLIC_URL,
    resolveHost: o.resolveHost,
  };
  return {
    gateway,
    /** The search index's vectors (undefined: words alone), for the boot backfill (`queueEmbeddingBackfill`). */
    embeddings,
    tools,
    context,
    handlers,
    /** The same router as `message.posted`'s, for "Responder agora" (null: routing is off). */
    router: messageRouter(jobDeps),
    connectorDeps,
    storage,
    artifacts,
    sandbox,
    /** The Vault (ADR 0144), for its routes. */
    vault,
    gitProxy,
    machineHub,
    browserLive,
    streams,
    /** Screened sessions (ADR 0076), for the operator API's review door; null where nothing is screened. */
    sessions,
    desktops,
    mail,
    talker,
    /** Awaited before the server serves (`ready()`), and the owner's routes read and change it. */
    jevKey,
    /** Likewise: the server's GitHub App (ADR 0156). */
    githubApp,
    /** Likewise: the speech engines, read before the first voice message. */
    speech,
    voice,
  };
}

export type Engine = ReturnType<typeof buildEngine>;
