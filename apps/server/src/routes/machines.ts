import { isIP } from "node:net";
import { limitIp } from "@agenteschat/adapters";
import {
  ARTIFACT_LIMITS,
  authenticateMachine,
  computerQueue,
  computerSetup,
  confirmDeviceCode,
  currentOrgLogo,
  DeviceCodeLimitError,
  deleteMachine,
  denyDeviceCode,
  getDeviceCode,
  hostComputerState,
  hostKey,
  listMachineOutages,
  listMachines,
  moveAgentsFromMachine,
  NotFoundError,
  openFilePull,
  PROVISIONING_REASONS,
  PROVISIONING_STATES,
  PROVISIONING_STEPS,
  pollDeviceToken,
  receiveMachineUpload,
  reduceMachineAccess,
  renameMachine,
  restoreHostComputer,
  safeEqual,
  setAgentComputerTarget,
  setMachinePause,
  startDeviceCode,
  startLinkedDeviceCode,
  syncHostComputer,
  UUID,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { installScript } from "../../runner/install-script";
import { requestIp, requestLimitIp } from "../http/client-ip";
import { apiError, domainErrorResponse, errorResponse } from "../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./app/context";

const tags = ["Connected computers"];

/** Headers and framing around a pushed file: the body may be a little over the file limit. */
const UPLOAD_SLACK_BYTES = 64 * 1024;

const MachinePause = z
  .object({
    until: z.string().nullable(),
    by: z
      .object({ id: z.string(), name: z.string() })
      .nullable()
      .openapi({ description: "Who paused it from the apps; null: paused on the computer itself." }),
  })
  .openapi("MachinePause");

export const MachineAccess = z
  .object({
    folders: z.array(
      z.object({
        path: z.string().openapi({ description: "Absolute path on the machine." }),
        agents: z.array(z.string()).openapi({ description: "Agent ids that may use it (empty: none yet)." }),
      }),
    ),
    tools: z.object({
      claude: z.boolean(),
      codex: z.boolean(),
      cursor: z
        .boolean()
        .optional()
        .openapi({ description: "Cursor's CLI (protocol 36, ADR 0114); absent = follows `codex`." }),
      opencode: z
        .boolean()
        .optional()
        .openapi({ description: "OpenCode's CLI (protocol 39, ADR 0132); absent = follows `codex`." }),
      grok: z
        .boolean()
        .optional()
        .openapi({ description: "Grok Build, xAI's CLI (protocol 43, ADR 0142); absent = follows `codex`." }),
      antigravity: z
        .boolean()
        .optional()
        .openapi({ description: "Google's Antigravity CLI (protocol 44, ADR 0143); absent = follows `codex`." }),
      commands: z.boolean(),
      browser: z
        .boolean()
        .optional()
        .openapi({ description: "The agent browser (protocol 12, ADR 0040); absent = off." }),
      desktop: z
        .boolean()
        .optional()
        .openapi({ description: "The agents' desktops (protocol 18, ADR 0058); absent = off." }),
      terminal: z
        .boolean()
        .optional()
        .openapi({ description: "Terminals people open as an agent (protocol 18, ADR 0058); absent = off." }),
    }),
  })
  .openapi("MachineAccess");

export const Machine = z
  .object({
    id: z.uuid(),
    name: z.string(),
    kind: z.enum(["connected", "host", "managed"]).openapi({
      description:
        "`connected`: a person paired it; `host`: this server's own computer (`HOST_COMPUTER_TOKEN`); `managed`: the workspace's own computer (ADR 0056 §10), which people can't remove and whose hostname, OS and arch aren't shown.",
    }),
    online: z.boolean().openapi({ description: "Runner connected now. Changes come as `machine.status` events." }),
    standby: z.boolean().openapi({
      description:
        "The workspace's own computer is asleep in standby (ADR 0161): offline by design, it wakes when something wants it. A change comes as `machine.updated`.",
    }),
    lastSeenAt: z.string().nullable(),
    hostname: z.string(),
    os: z.string().openapi({ description: "`linux`, `darwin`, `windows` or `other`." }),
    arch: z.string(),
    mode: z.enum(["system", "single"]).openapi({
      description:
        "`system`: each agent works as its own OS user, in its own folder (ADR 0057); `single`: every agent as the runner's user.",
    }),
    runnerVersion: z.string(),
    protocol: z.number().int().openapi({ description: "The runner's machine protocol (9+: pause; 10+: access)." }),
    browserProfiles: z.boolean().openapi({
      description:
        "Its runner can hold browser profiles (protocol 34, ADR 0110); `false`: update the computer. A system-mode computer has none at all (`mode`): the apps hide them there.",
    }),
    execAllowed: z.boolean().openapi({ description: "`false`: started with `--no-exec` (files and uploads only)." }),
    paused: MachinePause.nullable().openapi({
      description: "The owner paused it (no new work); `until` null: until resumed (`machine.updated`).",
    }),
    remotePause: z.boolean().openapi({
      description:
        "Its app takes a pause from here (`POST …/pause`); `false`: update the app on it. Never the workspace's own computer.",
    }),
    pairedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    agents: z.array(z.object({ id: z.uuid(), name: z.string(), handle: z.string() })),
    workspace: z
      .string()
      .nullable()
      .openapi({ description: "Workspace folder on the machine; null unless admin or the person who paired it." }),
    access: MachineAccess.nullable().openapi({
      description:
        "Folders and tools allowed on the machine (protocol 10); null unless admin or the person who paired it, or when the runner doesn't report it.",
    }),
    browser: z
      .object({
        available: z.boolean(),
        version: z.string().nullable(),
        chrome: z.string().nullable(),
        reason: z.string().nullable().openapi({ description: "Why it can't run yet, from the runner (English)." }),
        code: z.string().nullable().openapi({
          description: "That reason as a code the apps word (`browser_download`…); null from older runners.",
        }),
      })
      .nullable()
      .openapi({
        description:
          "Whether the agent browser can run there (protocol 12, ADR 0040); null when its runner doesn't report it. Turned on by the person at the computer (`access.tools.browser`).",
      }),
    desktopUse: z
      .object({
        available: z.boolean(),
        reason: z.string().nullable().openapi({ description: "Why it can't, from the runner (what to install)." }),
        code: z.string().nullable().openapi({
          description: "That reason as a code the apps word (`desktop_use_install`…); null from older runners.",
        }),
      })
      .nullable()
      .openapi({
        description:
          "Whether agents can use their own desktops there (protocol 21, ADR 0062): only where each agent works as its own OS user. Null when its runner doesn't report it.",
      }),
    networkTransition: z
      .object({ state: z.enum(["draining", "restart_required"]), deadline: z.string(), agents: z.array(z.string()) })
      .nullable()
      .optional(),
    egress: z.object({ ip: z.string(), country: z.string().optional(), at: z.string() }).nullable().optional(),
    egressWaiting: z.boolean().optional().openapi({
      description:
        "The workspace's own computer, online, has its agents waiting for their way out: its network sends them only through a proxy and none works now, so their connections are refused for a while. A change comes as `machine.updated`.",
    }),

    disk: z
      .object({
        freeGb: z.number().openapi({ description: "Free GB on the workspace's disk." }),
        use: z.number().nullable().openapi({ description: "Share of that disk in use, 0 to 1." }),
        sharedGb: z.number().nullable().openapi({ description: "The shared folder's size in GB (measured hourly)." }),
      })
      .nullable()
      .openapi({
        description:
          "Its disk and shared folder (ADR 0115), as its runner last measured them; null unless admin or the person who paired it, or when the runner doesn't say. The shared folder is the `access` folder granted to every agent (`*`).",
      }),
    canManage: z.boolean().openapi({ description: "This person may rename, delete or reduce its access." }),
    createdAt: z.string(),
  })
  .openapi("Machine");

export const ComputerTarget = z
  .union([
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("machine"), machineId: z.uuid(), name: z.string(), online: z.boolean() }),
  ])
  .openapi("ComputerTarget");

const HostComputer = z
  .object({ machineId: z.uuid(), on: z.boolean().openapi({ description: "false: an admin stopped it here." }) })
  .openapi("HostComputer");

const MachineParams = OrgParams.extend({ machineId: z.uuid() });

const ComputerSetup = z
  .object({
    mode: z.enum(["external", "pair"]).openapi({
      description:
        "`pair`: people connect their own computers (the other fields are null). `external`: the workspace gets its own computer, being prepared until `state` is `ready`.",
    }),
    state: z.enum(PROVISIONING_STATES).nullable().openapi({
      description:
        "With `external`, null while the workspace is on hold and its computer isn't ready: it waits for none, so nothing of a wait is said either.",
    }),
    step: z
      .enum(PROVISIONING_STEPS)
      .nullable()
      .openapi({ description: "While `preparing`: reserving, starting, installing or connecting." }),
    stage: z.string().nullable().openapi({
      description:
        "While `preparing`, when the provisioner says: what it is doing within its step (`updating`, `restarting`, `apps`…). One the app has no words for reads as its step.",
    }),
    reason: z
      .enum(PROVISIONING_REASONS)
      .nullable()
      .openapi({ description: "While `waiting`: `capacity` (no computer on its way yet)." }),
    since: z.string().nullable().openapi({ description: "When this state (and step or reason) began." }),
    requestedAt: z.string().nullable().openapi({
      description: "When its people started waiting: the computer's last removal, else the workspace's creation.",
    }),
    expectedReadyAt: z.string().nullable().openapi({
      description:
        "While `preparing`, when known: the earliest time this wait was told it would be ready, never moved later (already past: it runs over).",
    }),
    secondsLeft: z.number().int().nullable().openapi({
      description:
        "`expectedReadyAt` minus this server's clock when it answered (negative once past), so the device's clock doesn't matter.",
    }),
    secondsWaited: z.number().int().nullable().openapi({
      description: "This server's clock when it answered minus `requestedAt`, for the same reason.",
    }),
    specs: z.object({ cpus: z.number().int(), memoryGb: z.number(), diskGb: z.number() }).nullable(),
    notifyByEmail: z.boolean().openapi({
      description: "The server sends email: after a wait over a minute, the owners get one once it's ready.",
    }),
    machineId: z.uuid().nullable().openapi({ description: "The workspace's computer, once it has one." }),
  })
  .openapi("ComputerSetup");

const UserCode = z.string().min(6).max(16).openapi({ example: "K7Q4ZP" });
const UserCodeParams = z.object({ userCode: UserCode });

const DeviceCode = z
  .object({
    userCode: z.string().openapi({ example: "K7Q4ZP", description: "Shown as `K7Q·4ZP`." }),
    name: z.string(),
    os: z.string(),
    arch: z.string(),
    hostname: z.string(),
    version: z.string(),
    approxLocation: z.string().nullable().openapi({ description: "Roughly where the request came from, when known." }),
    createdAt: z.string(),
    expiresAt: z.string(),
    reconnect: z
      .object({ machineId: z.uuid(), name: z.string(), orgId: z.uuid(), orgName: z.string() })
      .optional()
      .openapi({
        description:
          "The code brings back this machine (same name, permissions and agents); only for people who may manage it.",
      }),
  })
  .openapi("MachineDeviceCode");

const AgentParams = OrgParams.extend({ agentId: z.uuid() });

const ComputerBrain = z.enum(["claude_code", "codex", "cursor", "opencode", "grok", "antigravity"]);
const Platform = z.string().openapi({
  description: "`mac`, `windows`, `linux`, `other` (the workspace's own computer), or the runner's `os` as reported.",
});

const MachineOutage = z
  .object({
    machineId: z.uuid(),
    name: z.string(),
    platform: Platform,
    managed: z
      .boolean()
      .openapi({ description: "The workspace's own computer (ADR 0056 §10): its platform is `other`." }),
    offlineSince: z.string().openapi({ description: "ISO time of its last sign of life." }),
    agents: z.array(
      z.object({
        agentId: z.uuid(),
        name: z.string(),
        brain: ComputerBrain,
        waiting: z.object({
          routines: z.number().int().openapi({ description: "Routine runs waiting for this computer." }),
          conversations: z.number().int().openapi({ description: "Other runs (messages) waiting for it." }),
        }),
      }),
    ),
    waitingRuns: z.number().int().openapi({ description: "Runs of these agents waiting for this computer." }),
  })
  .openapi("MachineOutage");

const OutageTarget = z
  .object({
    kind: z.literal("machine"),
    machineId: z.uuid(),
    name: z.string(),
    platform: Platform,
    managed: z
      .boolean()
      .openapi({ description: "The workspace's own computer (ADR 0056 §10): its platform is `other`." }),
    online: z.boolean(),
    brains: z.array(ComputerBrain).openapi({ description: "Computer brains it can run (`brainOptions`)." }),
    reasonOff: z
      .string()
      .nullable()
      .openapi({ description: "Why it can't take agents now: `offline`, `paused`; null when it can." }),
  })
  .openapi("OutageTarget");

const QueuePurpose = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("person"), userId: z.string().nullable() }),
    z.object({ kind: z.literal("agent"), agentId: z.uuid().nullable() }),
    z.object({ kind: z.literal("routine") }),
    z.object({ kind: z.literal("work") }),
  ])
  .openapi("QueuePurpose", {
    description:
      "What the turn is for, never its content: answering a person, asked by another agent, a routine, or long work. Ids are null when the author is gone.",
  });

const QueueWhere = z.object({
  channelId: z.uuid(),
  threadId: z.uuid().nullable(),
  agents: z.boolean().openapi({ description: "Two agents' private conversation, said only to who may see that work." }),
});
const QueueAccess = {
  canOpen: z.boolean().openapi({ description: "You see this run in the task manager: the row opens it." }),
  canStop: z.boolean().openapi({ description: "You may stop it." }),
};

const ComputerQueue = z
  .object({
    machineId: z.uuid(),
    name: z.string(),
    working: z.array(
      z.object({
        runId: z.uuid(),
        agentId: z.uuid(),
        purpose: QueuePurpose,
        where: QueueWhere,
        startedAt: z.string().openapi({ description: "When this turn asked the computer." }),
        estimatedEndAt: z.string().nullable().openapi({
          description:
            "Start plus the agent's median computer turn (else the workspace's), never sooner than 30 s from now; null with no basis, or past it.",
        }),
        overdue: z.boolean().openapi({ description: "Past its typical turn: there is no honest end to give." }),
        ...QueueAccess,
      }),
    ),
    waiting: z.array(
      z.object({
        runId: z.uuid(),
        agentId: z.uuid(),
        purpose: QueuePurpose,
        where: QueueWhere,
        people: z.boolean().openapi({ description: "A person waits on it: it goes first." }),
        position: z.number().int().openapi({ description: "1 = next." }),
        estimatedStartAt: z.string().nullable(),
        after: z.array(z.uuid()).openapi({
          description:
            "Who it waits for: for the head, the running turn expected to end first; behind it, the agents ahead in line.",
        }),
        ...QueueAccess,
      }),
    ),
  })
  .openapi("ComputerQueue");

const MoveTarget = z.object({ kind: z.literal("machine"), machineId: z.uuid() });

const MoveAgentsResult = z
  .object({
    moved: z.array(z.uuid()),
    skipped: z.array(
      z.object({ agentId: z.string(), reason: z.enum(["brain_unavailable", "forbidden", "not_found"]) }),
    ),
    resumed: z.number().int().openapi({ description: "Waiting runs queued again on the new computer." }),
    stillWaiting: z.number().int().openapi({
      description: "Waiting runs that stay with the old computer (their cut-off turn already ran tools there).",
    }),
  })
  .openapi("MoveAgentsResult");

/**
 * Connected computers in the web app (ADR 0025, ADR 0036): list, confirm or
 * deny a computer's connection code, rename, delete, reduce its access, and
 * which computer an agent uses. Session + CSRF like the rest of `/api/app`.
 */
export function machineAppRoutes(deps: AppDeps) {
  const { db } = deps;
  const pubsub = deps.adapters.pubsub;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  app.use("/machines/*", requireSession(deps.auth));
  const hub = () => {
    const machines = deps.extras?.sandbox?.machines?.hub;
    if (!machines) throw new ValidationError("Connected computers are not available on this server");
    return machines;
  };

  /**
   * Connection codes are short (6 characters) and anyone signed in may name one, so looking one
   * up, confirming and denying share one budget per person and per address, and a code that
   * isn't pending costs `DEVICE_CODE_MISS_COST`: a few typos are fine, guessing stops fast
   * (ADR 0036 §5). Runs `fn` when the budget allows; null after answering 429.
   */
  const codeKeys = (c: { req: { raw: Request } }, userId: string) =>
    [
      [`machine-device-code:user:${userId}`, DEVICE_CODE_USER],
      [`machine-device-code:ip:${requestLimitIp(c.req.raw.headers, deps.config.TRUSTED_PROXIES)}`, DEVICE_CODE_IP],
    ] as const;
  const spend = (keys: ReturnType<typeof codeKeys>) =>
    Promise.all(keys.map(([key, rule]) => deps.adapters.rateLimiter.consume(key, rule)));
  const withCodeBudget = async <T>(keys: ReturnType<typeof codeKeys>, fn: () => Promise<T>): Promise<T | null> => {
    if ((await spend(keys)).some((t) => !t.allowed)) return null;
    try {
      return await fn();
    } catch (error) {
      if (error instanceof NotFoundError && error.code === "machine.device_not_found") {
        for (let n = 1; n < DEVICE_CODE_MISS_COST; n++) await spend(keys);
      }
      throw error;
    }
  };
  const tooManyCodes = (c: Parameters<typeof apiError>[0]) =>
    apiError(c, 429, "rate_limited", "Too many attempts. Try again in a few minutes.");

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/machines",
      tags,
      security,
      summary: "Connected computers of the organization (every member)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ machines: z.array(Machine) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ machines: await listMachines(db, c.get("user").id, orgId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/machines/device/{userCode}",
      tags,
      security,
      summary: "What asked for this connection code (the confirm page), for any signed-in person",
      request: { params: UserCodeParams },
      responses: { 200: json(DeviceCode), 429: errorResponse("Too many lookups"), ...errors },
    }),
    async (c) => {
      const userId = c.get("user").id;
      const view = await withCodeBudget(codeKeys(c, userId), () =>
        getDeviceCode({ db }, c.req.valid("param").userCode, userId),
      );
      if (!view) return tooManyCodes(c);
      return c.json(view, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/device/{userCode}/confirm",
      tags,
      security,
      summary:
        "Connect the computer that shows this code to the organization (members who can post); it gets its token on its next poll",
      request: {
        params: OrgParams.extend({ userCode: UserCode }),
        body: body(z.object({ name: z.string().max(80).optional() })),
      },
      responses: { 201: json(Machine, "Connected"), 429: errorResponse("Too many attempts"), ...errors },
    }),
    async (c) => {
      const { orgId, userCode } = c.req.valid("param");
      const userId = c.get("user").id;
      const machine = await withCodeBudget(codeKeys(c, userId), () =>
        confirmDeviceCode({ db, pubsub }, userId, orgId, userCode, c.req.valid("json")),
      );
      if (!machine) return tooManyCodes(c);
      return c.json(machine, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/machines/device/{userCode}/deny",
      tags,
      security,
      summary: '"It wasn\'t me": the computer that shows this code is refused (`access_denied`)',
      request: { params: UserCodeParams },
      responses: { 204: noContent[204], 429: errorResponse("Too many attempts"), ...errors },
    }),
    async (c) => {
      const userId = c.get("user").id;
      const denied = await withCodeBudget(codeKeys(c, userId), async () => {
        await denyDeviceCode({ db }, userId, c.req.valid("param").userCode);
        return true;
      });
      if (!denied) return tooManyCodes(c);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/{machineId}/access/reduce",
      tags,
      security,
      summary:
        "Remove a folder (for everyone or one agent) or turn a tool off on the machine (admins or the person who paired it); never widens",
      request: {
        params: MachineParams,
        body: body(
          z
            .object({
              removeFolder: z.object({ path: z.string().min(1).max(1024), agentId: z.uuid().optional() }).optional(),
              disableTool: z
                .enum([
                  "claude",
                  "codex",
                  "cursor",
                  "opencode",
                  "grok",
                  "antigravity",
                  "commands",
                  "browser",
                  "desktop",
                  "terminal",
                ])
                .optional(),
            })
            .strict(),
        ),
      },
      responses: {
        200: json(z.object({ access: MachineAccess })),
        ...errors,
        409: errorResponse("The computer is offline (`machine.offline`)"),
      },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      const access = await reduceMachineAccess(
        { db, pubsub, hub: hub() },
        c.get("user").id,
        orgId,
        machineId,
        c.req.valid("json"),
      );
      return c.json({ access }, 200);
    },
  );

  const pauseResponses = {
    200: json(z.object({ paused: MachinePause.nullable() })),
    ...errors,
    409: errorResponse("The computer is offline (`machine.offline`)"),
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/{machineId}/pause",
      tags,
      security,
      summary:
        "Pause it (admins or the person who connected it): nothing new starts there until `until`, or until resumed when null. Work already running finishes",
      request: {
        params: MachineParams,
        body: body(z.object({ until: z.iso.datetime({ offset: true }).nullable() }).strict()),
      },
      responses: pauseResponses,
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      const { until } = c.req.valid("json");
      const deps = { db, pubsub, hub: hub() };
      return c.json(await setMachinePause(deps, c.get("user").id, orgId, machineId, { paused: true, until }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/{machineId}/resume",
      tags,
      security,
      summary: "Resume it (admins or the person who connected it), however it was paused",
      request: { params: MachineParams },
      responses: pauseResponses,
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      const deps = { db, pubsub, hub: hub() };
      return c.json(await setMachinePause(deps, c.get("user").id, orgId, machineId, { paused: false }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/machines/{machineId}",
      tags,
      security,
      summary: "Rename (the person who paired it or an admin)",
      request: { params: MachineParams, body: body(z.object({ name: z.string().min(1).max(80) })) },
      responses: { 200: json(z.object({ id: z.uuid(), name: z.string() })), ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      return c.json(await renameMachine({ db, pubsub }, c.get("user").id, orgId, machineId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/machines/{machineId}",
      tags,
      security,
      summary:
        "Remove it: the token stops working and its runner is disconnected at once (never the workspace's own computer: `machine.managed`)",
      request: { params: MachineParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      await deleteMachine({ db, pubsub }, c.get("user").id, orgId, machineId);
      return c.body(null, 204);
    },
  );

  const noHost = (c: Parameters<typeof apiError>[0]) =>
    apiError(c, 404, "machine.host_none", "This server's computer doesn't work for this organization");

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/machines/host",
      tags,
      security,
      summary:
        "Whether the organization uses this server's own computer (404: the server has none, or doesn't serve this organization)",
      request: { params: OrgParams },
      responses: { 200: json(HostComputer), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const state = deps.config.HOST_COMPUTER_TOKEN ? await hostComputerState(db, c.get("user").id, orgId) : null;
      if (!state) return noHost(c);
      return c.json(state, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/host",
      tags,
      security,
      summary:
        "Use this server's computer again in the organization (admins); it connects at its next sync. Stopping is removing its row (`DELETE …/machines/{machineId}`)",
      request: { params: OrgParams },
      responses: { 200: json(HostComputer), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      if (!deps.config.HOST_COMPUTER_TOKEN) return noHost(c);
      return c.json(await restoreHostComputer({ db, pubsub }, c.get("user").id, orgId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/computer-setup",
      tags,
      security,
      summary: "Whether the workspace gets its own computer, and how far it is (every member)",
      description: "Changes come as `machine.provisioning` org events, with the same fields but `mode`.",
      request: { params: OrgParams },
      responses: { 200: json(ComputerSetup), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const emails = deps.adapters.email.delivers === true;
      return c.json(await computerSetup(db, deps.config.MACHINE_PROVISIONING, c.get("user").id, orgId, emails), 200);
    },
  );

  const outageDeps = () => ({ db, pubsub });

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/machines/outages",
      tags,
      security,
      summary:
        "Offline computers that some agents think on, with the agents this person may move, and where they could go",
      description:
        "Changes come as `machine.status` and `machine.agents_moved` org events; clients also poll while an outage is shown.",
      request: { params: OrgParams },
      responses: {
        200: json(z.object({ outages: z.array(MachineOutage), targets: z.array(OutageTarget) })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await listMachineOutages(outageDeps(), c.get("user").id, orgId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/machines/{machineId}/queue",
      tags,
      security,
      summary: "A computer's line: the turns working on it and the runs waiting for room, in order (every member)",
      description:
        "Changes come as the `computer.queue` org event (`{ machineId }`): refetch. Estimates are typical durations, never exact.",
      request: { params: MachineParams },
      responses: { 200: json(ComputerQueue), ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      return c.json(await computerQueue(db, c.get("user").id, orgId, machineId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/machines/{machineId}/move-agents",
      tags,
      security,
      summary:
        'Move agents off this computer ("Trocar computador"): admins any agent, others their own; waiting runs go on there',
      request: {
        params: MachineParams,
        body: body(z.object({ agentIds: z.array(z.uuid()).min(1).max(100), target: MoveTarget })),
      },
      responses: { 200: json(MoveAgentsResult), ...errors },
    }),
    async (c) => {
      const { orgId, machineId } = c.req.valid("param");
      const result = await moveAgentsFromMachine(outageDeps(), c.get("user").id, orgId, machineId, c.req.valid("json"));
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/computer/target",
      tags,
      security,
      summary:
        "Which computer the agent uses: a connected machine, or null for none (admins; or the owner with a machine they paired)",
      request: { params: AgentParams, body: body(z.object({ machineId: z.uuid().nullable() })) },
      responses: { 200: json(ComputerTarget), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const target = await setAgentComputerTarget(
        { db, pubsub },
        c.get("user").id,
        orgId,
        agentId,
        c.req.valid("json").machineId,
      );
      return c.json(target, 200);
    },
  );

  return app;
}

/** Reads at most `max` bytes of a body; null when it is longer. */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const DeviceBody = z.object({
  name: z.string().max(80).default(""),
  os: z.string().max(20).default("other"),
  arch: z.string().max(40).default(""),
  hostname: z.string().max(200).default(""),
  version: z.string().max(40).default(""),
  protocol: z.number().int().optional(),
  workspace: z.string().max(500).optional(),
  exec: z.boolean().optional(),
  /** A refused computer asking to come back as the machine it was (reconnect); ignored unless a uuid. */
  previousMachineId: z.string().max(64).optional(),
  /** The token it had for `previousMachineId`, its proof of being that computer: no reconnect without it. */
  previousToken: z.string().max(200).optional(),
  /** The code of the connect link it was installed with (`/i/{code}`): it asks that link's maker to join. */
  link: z.string().max(20).optional(),
});

const HostSyncBody = z.object({
  name: z.string().max(80).default(""),
  hostname: z.string().max(200).default(""),
  os: z.string().max(20).default("other"),
  arch: z.string().max(40).default(""),
  runnerVersion: z.string().max(40).default(""),
  have: z.array(z.uuid()).max(1000).default([]).openapi({ description: "Organizations it holds a token for." }),
  rotate: z
    .array(z.uuid())
    .max(1000)
    .default([])
    .openapi({ description: "Organizations whose token the server refused: they get new ones." }),
});

/** The server's computer syncs every minute; this leaves room for restarts. */
const HOST_SYNC_LIMIT = { limit: 30, windowMs: 60_000 };

/**
 * Looking up, confirming and denying connection codes, per person and per address (an office
 * may pair several computers at once), every 10 minutes; an unknown or expired code costs
 * `DEVICE_CODE_MISS_COST` tries. 6 characters over 31 letters and digits is about 887M codes.
 */
const DEVICE_CODE_USER = { limit: 30, windowMs: 10 * 60_000 };
const DEVICE_CODE_IP = { limit: 60, windowMs: 10 * 60_000 };
const DEVICE_CODE_MISS_COST = 5;

/** New codes per address per minute, and polls (every 3 s by contract: 20 a minute, with room for two computers). */
const DEVICE_START_LIMIT = { limit: 10, windowMs: 60_000 };
const DEVICE_POLL_LIMIT = { limit: 60, windowMs: 60_000 };

/**
 * What the runner calls, with no session (ADR 0025, ADR 0036): the
 * device-code connection (`POST /api/machines/device`, `…/device/token`;
 * rate limited per address), the server's own computer's sync
 * (`POST /api/machines/host/sync`, its `HOST_COMPUTER_TOKEN`), `PUT /api/machines/uploads/{uploadId}` and
 * `GET /api/machines/org-logo` (its machine token) and
 * `GET /api/machines/install.sh`. No CSRF: no cookie is
 * read here. The WebSocket `/api/machines/connect` lives in `Bun.serve`
 * (`realtime/machines.ts`).
 */
export function registerMachinePublicRoutes(api: OpenAPIHono, deps: AppDeps) {
  const { db, config, adapters } = deps;
  api.openapi(
    createRoute({
      method: "get",
      path: "/machines/ip",
      tags,
      summary: "The address this computer uses to reach the server",
      responses: {
        200: json(z.object({ ip: z.string().nullable(), country: z.string().nullable() })),
        429: errorResponse("Too many requests"),
      },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const ip = requestIp(c.req.raw.headers, config.TRUSTED_PROXIES);
      const limit = await adapters.rateLimiter.consume(`machine-ip:${limitIp(ip)}`, { limit: 120, windowMs: 60_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Try again in a minute.");
      const country = c.req.header("cf-ipcountry") ?? "";
      return c.json(
        { ip: isIP(ip) ? ip : null, country: /^[A-Z]{2}$/.test(country) && country !== "XX" ? country : null },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/machines/device",
      tags,
      summary:
        "A computer asks for a connection code (the desktop app or `agentes-runner pair`), or with `link` asks the maker of that connect link to join",
      request: { body: body(DeviceBody) },
      responses: {
        200: json(
          z
            .object({
              deviceCode: z.string().openapi({ description: "Secret: only the computer keeps it, to poll." }),
              userCode: z.string().openapi({ example: "K7Q4ZP" }),
              verificationUrl: z.string(),
              expiresIn: z.number().int(),
              interval: z.number().int(),
              maker: z
                .object({ name: z.string() })
                .optional()
                .openapi({ description: "With `link`: who lets it join (the link's maker)." }),
              org: z
                .object({ name: z.string() })
                .optional()
                .openapi({ description: "With `link`: the workspace it joins." }),
            })
            .openapi("MachineDeviceStart"),
        ),
        400: errorResponse(
          "Invalid body, runner too old, or the link is unknown, used or expired (`machine.link_invalid`)",
        ),
        429: errorResponse("Too many requests or pending codes from this address"),
      },
    }),
    async (c) => {
      const ip = requestIp(c.req.raw.headers, config.TRUSTED_PROXIES);
      const limit = await adapters.rateLimiter.consume(`machine-device:${limitIp(ip)}`, DEVICE_START_LIMIT);
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many attempts. Try again in a minute.");
      const { link, ...input } = c.req.valid("json");
      const start = { db, pubsub: adapters.pubsub, publicUrl: config.PUBLIC_URL };
      try {
        const started = link
          ? await startLinkedDeviceCode(start, link, input, { ip })
          : await startDeviceCode(start, input, { ip });
        return c.json(started, 200);
      } catch (error) {
        if (error instanceof DeviceCodeLimitError) return apiError(c, 429, "machine.device_too_many", error.message);
        if (error instanceof ValidationError) return apiError(c, 400, error.code, error.message);
        throw error;
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/machines/device/token",
      tags,
      summary: "The computer polls for its token (OAuth device flow errors until it is confirmed)",
      request: { body: body(z.object({ deviceCode: z.string().min(1).max(200) })) },
      responses: {
        200: json(
          z
            .object({
              token: z.string().openapi({ description: "The machine token (`agm_…`), returned once." }),
              machineId: z.uuid(),
              name: z.string(),
              org: z.object({ id: z.uuid(), name: z.string() }),
              audience: z
                .enum(["everyone", "people", "owner"])
                .openapi({ description: "Who may use it, as it joined (its owner, everyone, or people and roles)." }),
              owner: z.string().nullable().openapi({ description: "The name of the person who connected it." }),
              url: z.url().openapi({ description: "Its page in the web app, where who may use it changes." }),
            })
            .openapi("MachineDeviceToken"),
        ),
        400: json(
          z
            .object({ error: z.enum(["authorization_pending", "slow_down", "access_denied", "expired_token"]) })
            .openapi("MachineDeviceTokenError"),
          "Not yet, too fast, refused or expired",
        ),
        429: errorResponse("Too many polls"),
      },
    }),
    async (c) => {
      const ip = requestLimitIp(c.req.raw.headers, config.TRUSTED_PROXIES);
      const limit = await adapters.rateLimiter.consume(`machine-device-poll:${ip}`, DEVICE_POLL_LIMIT);
      if (!limit.allowed) return c.json({ error: "slow_down" as const }, 400);
      const result = await pollDeviceToken({ db, pubsub: adapters.pubsub }, c.req.valid("json").deviceCode);
      if (!result.ok) return c.json({ error: result.error }, 400);
      const { ok: _ok, ...token } = result;
      const url = `${config.PUBLIC_URL.replace(/\/+$/, "")}/org/${token.org.id}/settings/devices/${token.machineId}`;
      return c.json({ ...token, url }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/machines/host/sync",
      tags,
      summary:
        "This server's own computer (`agentes-runner host`, `Authorization: Bearer <HOST_COMPUTER_TOKEN>`): its organizations, one computer each, with a token when it needs one",
      request: { body: body(HostSyncBody) },
      responses: {
        200: json(
          z
            .object({
              orgs: z.array(
                z.object({
                  orgId: z.uuid(),
                  orgName: z.string(),
                  machineId: z.uuid(),
                  token: z
                    .string()
                    .optional()
                    .openapi({ description: "A new machine token (`agm_…`), given once; absent: keep yours." }),
                }),
              ),
            })
            .openapi("HostSync"),
        ),
        401: errorResponse("Wrong token"),
        404: errorResponse("This server has no computer of its own (`HOST_COMPUTER_TOKEN` unset)"),
        429: errorResponse("Too many syncs from this address"),
      },
    }),
    async (c) => {
      const expected = config.HOST_COMPUTER_TOKEN;
      if (!expected) return apiError(c, 404, "machine.host_off", "This server has no computer of its own");
      const ip = requestLimitIp(c.req.raw.headers, config.TRUSTED_PROXIES);
      const limit = await adapters.rateLimiter.consume(`machine-host:${ip}`, HOST_SYNC_LIMIT);
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many attempts. Try again in a minute.");
      const auth = c.req.header("authorization") ?? "";
      if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7).trim(), expected)) {
        return apiError(c, 401, "machine.unauthorized", "This server's computer token is not valid");
      }
      const result = await syncHostComputer(
        {
          db,
          pubsub: adapters.pubsub,
          hostKey: hostKey(expected),
        },
        c.req.valid("json"),
      );
      return c.json(result, 200);
    },
  );

  api.put("/machines/uploads/:uploadId", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const machine = token ? await authenticateMachine(db, token) : null;
    if (!machine) return apiError(c, 401, "machine.unauthorized", "This computer's token is not valid");
    const max = ARTIFACT_LIMITS.fileBytes + UPLOAD_SLACK_BYTES;
    const maxMb = ARTIFACT_LIMITS.fileBytes / 1024 / 1024;
    const tooLarge = () =>
      apiError(c, 413, "artifact.file_too_large", `The file is too large (max ${maxMb} MB)`, { maxMb });
    if (Number(c.req.header("content-length") ?? "0") > max) return tooLarge();
    const uploadId = c.req.param("uploadId");
    if (!UUID.test(uploadId)) return apiError(c, 404, "upload.not_found", "Upload not found");
    let name = "file";
    try {
      name = decodeURIComponent(c.req.header("x-agentes-file-name") ?? "") || "file";
    } catch {
      return apiError(c, 400, "invalid_request", "x-agentes-file-name must be URI-encoded");
    }
    const headerUpload = c.req.header("x-agentes-upload-id");
    if (headerUpload && headerUpload !== uploadId) {
      return apiError(c, 400, "invalid_request", "x-agentes-upload-id does not match the URL");
    }
    const bytes = await readCapped(c.req.raw, max);
    if (!bytes) return tooLarge();
    try {
      const { artifact } = await receiveMachineUpload(
        { db, artifacts: deps.extras?.artifacts ?? missingArtifacts(), pubsub: adapters.pubsub },
        {
          uploadId,
          machineId: machine.id,
          name: name.slice(0, 255),
          contentType: c.req.header("content-type") ?? "application/octet-stream",
          sha256: c.req.header("x-agentes-sha256") ?? "",
          body: bytes,
        },
      );
      return c.json({ ok: true, artifactId: artifact.id, version: artifact.shownVersion }, 200);
    } catch (error) {
      const mapped = domainErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  // The bytes of a file this machine was told to fetch (`pull`), straight from storage.
  api.get("/machines/pulls/:pullId", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const machine = token ? await authenticateMachine(db, token) : null;
    if (!machine) return apiError(c, 401, "machine.unauthorized", "This computer's token is not valid");
    const pullId = c.req.param("pullId");
    if (!UUID.test(pullId)) return apiError(c, 404, "pull.not_found", "This file isn't waiting for this computer");
    try {
      const file = await openFilePull(deps.extras?.artifacts ?? missingArtifacts(), pullId, machine.id);
      return new Response(file.body, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(file.size),
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      const mapped = domainErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  // The organization's logo for the desktop app (the runner fetches it; the
  // app's web view never sees the token). The file name is a content hash: the ETag.
  api.get("/machines/org-logo", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const machine = token ? await authenticateMachine(db, token) : null;
    if (!machine) return apiError(c, 401, "machine.unauthorized", "This computer's token is not valid");
    const logo = await currentOrgLogo({ db, blobs: adapters.platformBlobs }, machine.orgId);
    if (!logo) return apiError(c, 404, "org.logo_not_found", "The organization has no logo");
    const etag = `"${logo.file}"`;
    const headers = { etag, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" };
    const match = c.req.header("if-none-match") ?? "";
    if (match.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(logo.body, {
      status: 200,
      headers: { ...headers, "content-type": logo.contentType, "content-security-policy": "sandbox" },
    });
  });

  api.get("/machines/install.sh", (c) =>
    c.body(installScript(config.PUBLIC_URL), 200, {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    }),
  );
}

function missingArtifacts(): never {
  throw new Error("the Drive is not configured on this server");
}
