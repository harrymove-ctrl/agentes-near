import { AGENT_FOLDERS_PROTOCOL, type PubSub, type SandboxProvider } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { getAgent, getAgentCached } from "./agents";
import { recordAudit } from "./audit";
import type { WorkspaceComputer } from "./context";
import { checkDeviceUse, noteDeviceInUse, pickDevice, seenAgo, waitHint, workspaceDevices } from "./device-resolve";
import { ForbiddenError, NotFoundError } from "./errors";
import { cutText, cutTextEnd } from "./format";
import { computerBackSoon, type MachineCaller } from "./machine-hub";
import { createMachineSandboxProvider } from "./machine-provider";
import { computerPreparing } from "./machine-provisioning";
import {
  type ComputerTarget,
  computerTarget,
  MachineOfflineError,
  MachinePausedError,
  REMOVED_COMPUTER_MESSAGE,
} from "./machines";
import { missionOfRun } from "./mission-context";
import { can, requirePermission } from "./organizations";
import { runnerUpdateWay } from "./runner-update";
import type { ToolContext } from "./tools/types";

const { orgSandboxSettings } = schema;

/** The scope of the sandbox tools: on by default, and not covered by "all tools" (ADR 0021). */
export const SANDBOX_SCOPE = "sandbox:run";

export const SANDBOX_LIMITS = {
  /** The most an organization's default command timeout (`execTimeoutSeconds`) can be. */
  maxTimeoutSeconds: 600,
  /** The most one command may take: connected computers run long jobs (e.g. Claude Code). */
  machineMaxTimeoutSeconds: 3600,
  stdoutChars: 20_000,
  stderrChars: 8_000,
  fileReadChars: 40_000,
  maxFileBytes: 5 * 1024 * 1024,
  codeChars: 100_000,
};

export interface SandboxDeps {
  db: Database;
  /** Connected machines (ADR 0025): the provider over the hub, and the hub for names and online state. */
  machines?: { hub: MachineCaller } | null;
  now?: () => Date;
  /**
   * The git proxy (ADR 0024 addendum): `git.sync` hands a connected computer our credential for
   * `{publicUrl}/api/git/…`, so its clones and pushes go through us and it never holds a GitHub token.
   */
  git?: { publicUrl: string; secret: string } | null;
  /** Our public base URL: computers send files (`pushFile`) to `{publicUrl}/api/machines/uploads/{id}`. */
  publicUrl?: string;
  /** Each workspace gets its own computer here: an agent with none waits for it (`computerPreparing`). */
  workspaceComputer?: WorkspaceComputer;
  /** Tells a device's owner when someone else's agent uses it (`device.in_use`). */
  pubsub?: PubSub;
}

/** Told when the agent has no computer. */
export const NO_COMPUTER_MESSAGE =
  "You have no computer: no connected computer was chosen for you. Ask an admin or your owner to connect one (Settings › Devices).";

/** Told instead while the workspace's own computer is still being prepared (ADR 0056 §10). */
export const PREPARING_COMPUTER_MESSAGE =
  "Your workspace's computer is still being prepared: commands, files and the browser work once it is ready, and the workspace's owners are told then. Tell the person it isn't ready yet; nothing is lost meanwhile.";

/** The computer a tool acts on (ADR 0025): a connected machine and the channel to it. */
export interface ComputerHandle {
  /** The machine's id (what the channel calls it). */
  id: string;
  provider: SandboxProvider;
  /** Our name for it, recorded with uploads: `machine:<machine id>`. */
  ref: string;
  /** The connected machine: only it may complete its uploads. */
  machineId: string;
}

/** The organization's Run code settings: they apply on every agent's computer. */
export interface SandboxSettings {
  enabled: boolean;
  /** Default timeout of one command, in seconds. */
  execTimeoutSeconds: number;
  /** Every `run_code` / `run_skill_script` waits for a person's approval. */
  requireApproval: boolean;
}

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  enabled: true,
  execTimeoutSeconds: 60,
  requireApproval: false,
};

/** The computer can't be used now (turned off for the organization, no computer): the tool says why. */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/** The organization's settings (no row: the defaults). */
export async function getSandboxSettings(db: Database, orgId: string): Promise<SandboxSettings> {
  const [row] = await db.select().from(orgSandboxSettings).where(eq(orgSandboxSettings.orgId, orgId));
  if (!row) return { ...DEFAULT_SANDBOX_SETTINGS };
  return { enabled: row.enabled, execTimeoutSeconds: row.execTimeoutSeconds, requireApproval: row.requireApproval };
}

/**
 * Org settings (admins, `configure`). The default timeout is clamped between 5 s and
 * `SANDBOX_LIMITS.maxTimeoutSeconds`.
 */
export async function updateSandboxSettings(
  db: Database,
  actorId: string,
  orgId: string,
  patch: Partial<SandboxSettings>,
): Promise<SandboxSettings> {
  await requirePermission(db, actorId, orgId, "configure");
  const current = await getSandboxSettings(db, orgId);
  const next: SandboxSettings = {
    enabled: patch.enabled ?? current.enabled,
    execTimeoutSeconds: Math.min(
      SANDBOX_LIMITS.maxTimeoutSeconds,
      Math.max(5, patch.execTimeoutSeconds ?? current.execTimeoutSeconds),
    ),
    requireApproval: patch.requireApproval ?? current.requireApproval,
  };
  await db
    .insert(orgSandboxSettings)
    .values({ orgId, ...next })
    .onConflictDoUpdate({ target: orgSandboxSettings.orgId, set: { ...next, updatedAt: new Date() } });
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "sandbox.settings_updated",
    target: { type: "organization", id: orgId },
    details: { ...next },
  });
  return next;
}

/**
 * Runs `fn` on the agent's computer: in a mission's thread the mission's computer (ADR 0029), else the agent's
 * connected machine (ADR 0025); with neither, a clear refusal.
 */
export async function withSandbox<T>(
  deps: SandboxDeps,
  ctx: ToolContext,
  fn: (computer: ComputerHandle) => Promise<T>,
  options: { allowPaused?: boolean; computer?: string; label?: string } = {},
): Promise<T> {
  const [agent, mission] = await Promise.all([getAgentCached(deps.db, ctx.orgId, ctx.agentId), missionOfRun(ctx)]);
  const asked = options.computer?.trim();
  if (asked) {
    if (mission) {
      const own = mission.machineId ? await deps.machines?.hub.status(mission.machineId) : null;
      if (!own || (own.id !== asked && own.name.toLowerCase() !== asked.toLowerCase()))
        throw new SandboxUnavailableError(
          "In a mission's thread the work runs on the mission's computer: leave `computer` out.",
        );
    } else return withTargetComputer(deps, ctx, asked, agent, fn, options);
  }
  // In a mission's thread the work runs on the mission's computer (ADR 0029), never on another one.
  if (mission) {
    if (!mission.machineId) {
      throw new SandboxUnavailableError("This mission has no computer yet: its owner chooses one first.");
    }
    return withMachine(
      deps,
      ctx,
      { machineId: mission.machineId, handle: agent?.handle ?? "agent", name: agent?.name },
      fn,
      options,
    );
  }
  if (agent?.machineId) {
    return withMachine(deps, ctx, { machineId: agent.machineId, handle: agent.handle, name: agent.name }, fn, options);
  }
  const preparing = await computerPreparing(deps, ctx.orgId);
  throw new SandboxUnavailableError(preparing ? PREPARING_COMPUTER_MESSAGE : NO_COMPUTER_MESSAGE);
}

/**
 * A device the agent named (`computer`, bring your own devices): resolved by name, checked against its rule for the
 * person the agent works for (its own computer always passes), then used like the agent's own. Its `access` stays the
 * ceiling; an offline one says how to wait for it.
 */
async function withTargetComputer<T>(
  deps: SandboxDeps,
  ctx: ToolContext,
  asked: string,
  agent: { handle: string; name: string; machineId?: string | null } | null,
  fn: (computer: ComputerHandle) => Promise<T>,
  options: { allowPaused?: boolean; label?: string },
): Promise<T> {
  const settings = await getSandboxSettings(deps.db, ctx.orgId);
  if (!settings.enabled)
    throw new SandboxUnavailableError("The agents' computers are turned off for this organization.");
  const hub = deps.machines?.hub;
  if (!hub) throw new SandboxUnavailableError("Connected computers are not available on this server.");
  const picked = pickDevice((await workspaceDevices(ctx.db, ctx.orgId)).computers, asked, "computer");
  if (!picked.ok) throw new SandboxUnavailableError(picked.message);
  const computer = picked.item;
  const target = { kind: "computer" as const, computer };
  const check = await checkDeviceUse(deps, ctx, target, options.label);
  if (!check.ok) throw new SandboxUnavailableError(check.message);
  let entered = false;
  try {
    return await withConnectedMachine(
      hub,
      ctx,
      {
        machineId: computer.id,
        handle: agent?.handle ?? "agent",
        ...(agent?.name ? { name: agent.name } : {}),
        device: computer.id !== agent?.machineId,
      },
      async (handle) => {
        entered = true;
        await noteDeviceInUse(deps, ctx, target, check.requester, options.label);
        return fn(handle);
      },
      options,
    );
  } catch (error) {
    // Away before anything was sent (a drop midway may have run, and says so itself).
    if (!entered && error instanceof MachineOfflineError)
      throw new SandboxUnavailableError(
        `${computer.name} is offline (${seenAgo(computer.lastSeenAt)}). ${waitHint(computer.name)}`,
      );
    throw error;
  }
}

/**
 * The agent's connected machine (ADR 0025): online or a clear refusal, and only while the organization runs
 * code on its agents' computers (`enabled`).
 */
async function withMachine<T>(
  deps: SandboxDeps,
  ctx: ToolContext,
  { machineId, handle, name }: { machineId: string; handle: string; name?: string },
  fn: (computer: ComputerHandle) => Promise<T>,
  options: { allowPaused?: boolean } = {},
): Promise<T> {
  const settings = await getSandboxSettings(deps.db, ctx.orgId);
  if (!settings.enabled)
    throw new SandboxUnavailableError("The agents' computers are turned off for this organization.");
  const machines = deps.machines;
  if (!machines) throw new SandboxUnavailableError("Connected computers are not available on this server.");
  return withConnectedMachine(machines.hub, ctx, { machineId, handle, ...(name ? { name } : {}) }, fn, options);
}

/**
 * One connected machine as a computer handle, without the org's computer
 * switch: the agent browser (ADR 0040) works on a connected machine whether
 * or not the org runs code there, and its site-bound secrets go to that machine.
 * `device`: a person's computer the agent named, not its own, whose refusals point to that person.
 */
export async function withConnectedMachine<T>(
  hub: MachineCaller,
  ctx: Pick<ToolContext, "orgId" | "agentId" | "signal">,
  { machineId, handle, name, device }: { machineId: string; handle: string; name?: string; device?: boolean },
  fn: (computer: ComputerHandle) => Promise<T>,
  options: { allowPaused?: boolean } = {},
): Promise<T> {
  let status = await hub.status(machineId);
  // A run's call (it has a `signal`) waits for a computer just gone, its runner dialing again. A person's request
  // or a job doesn't: deleting an agent whose computer just went away would wait the whole time once per secret.
  const { signal } = ctx;
  if (signal && status?.orgId === ctx.orgId && !status.online) {
    if (await computerBackSoon(hub, machineId, { signal, canceled: () => signal.aborted })) {
      status = await hub.status(machineId);
    }
  }
  if (!status || status.orgId !== ctx.orgId) {
    throw new SandboxUnavailableError(REMOVED_COMPUTER_MESSAGE);
  }
  if (!status.online) throw new MachineOfflineError(status.name, status.kind);
  // Paused by its owner (ADR 0036 §6): nothing new starts there; the agent relays why and until when.
  if (status.paused && !options.allowPaused)
    throw new MachinePausedError(status.name, status.paused.until, status.paused.timezone);
  // An old runner would ignore `agent` and put every agent in the same folder.
  if (status.protocol < AGENT_FOLDERS_PROTOCOL) {
    throw new SandboxUnavailableError(
      `The runner on the computer ${status.name} is out of date (it can't give each agent its own folder). ${runnerUpdateWay(status)}`,
    );
  }
  const provider = createMachineSandboxProvider(hub, { id: ctx.agentId, handle, ...(name ? { name } : {}) }, device);
  return fn({ id: machineId, provider, ref: `machine:${machineId}`, machineId });
}

/** Which computer the agent's tools act on, as the agent reads it (tool descriptions, `computer_status`). */
export async function agentComputerInfo(
  deps: Pick<SandboxDeps, "db" | "machines" | "workspaceComputer">,
  orgId: string,
  agentId: string,
  /** In a mission's thread: the mission's computer (ADR 0029), which may not be the agent's. */
  machineOverride?: { machineId: string | null } | null,
): Promise<
  /** `preparing`: the workspace's own computer is on its way (ADR 0056 §10). */
  | { kind: "none"; preparing: boolean }
  | {
      kind: "machine";
      machineId: string;
      name: string;
      /** The workspace's own computer (ADR 0056 §10): always on, nobody's to turn on or off. */
      managed: boolean;
      online: boolean;
      execAllowed: boolean;
      os: string;
      /** The runner's protocol (4+: background tasks; 10+: folders granted on the machine). */
      protocol: number;
      /** The owner paused it (protocol 9). */
      paused: { until: string | null; timezone: string | null } | null;
      /** The folders the machine allows this agent beyond its own folder (protocol 10; empty when none or unknown). */
      folders: string[];
    }
  | { kind: "removed" }
> {
  const agent = await getAgentCached(deps.db, orgId, agentId);
  if (machineOverride && !machineOverride.machineId) return { kind: "removed" };
  const machineId = machineOverride?.machineId ?? agent?.machineId;
  if (!machineId) return { kind: "none", preparing: await computerPreparing(deps, orgId) };
  const status = await deps.machines?.hub.status(machineId);
  if (!status || status.orgId !== orgId) return { kind: "removed" };
  return {
    kind: "machine",
    machineId: status.id,
    name: status.name,
    managed: status.kind === "managed",
    online: status.online,
    execAllowed: status.execAllowed,
    os: status.os,
    protocol: status.protocol,
    paused: status.paused ?? null,
    folders: status.access ? status.access.folders.filter((f) => f.agents.includes(agentId)).map((f) => f.path) : [],
  };
}

/** `GET …/agents/{id}/computer`: which computer the agent uses (ADR 0025). */
export interface AgentComputerView {
  target: ComputerTarget;
}

/** The agent's owner or an admin (`manage_agents`). */
export async function requireComputerManager(db: Database, actorId: string, orgId: string, agentId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (!can(membership, "manage_agents") && agent.ownerUserId !== actorId) {
    throw new ForbiddenError("Only an admin or the agent's owner can manage its computer");
  }
}

/** `GET …/agents/{id}/computer`: the agent's owner or an admin. */
export async function getAgentComputer(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
): Promise<AgentComputerView> {
  await requireComputerManager(db, actorId, orgId, agentId);
  return { target: await computerTarget(db, orgId, agentId) };
}

/** Keeps the start and end of long output, cutting the middle. */
export function truncateOutput(text: string, max: number) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${cutText(text, head)}\n[… ${text.length - max} characters cut …]\n${cutTextEnd(text, tail)}`;
}
