import {
  type BrowserHandoffInfo,
  type MachineReplies,
  type PubSub,
  SCREEN_KINDS,
  type ScreenKind,
} from "@agenteschat/adapters";
import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  schema,
  sql,
} from "@agenteschat/db";
import { getAgentCached } from "../agents";
import { recordAudit } from "../audit";
import { isChannelMember } from "../channels";
import { answersAgentsOnly } from "../consultations";
import { openPersonAgentDm } from "../dms";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "../errors";
import { publishChannelEvent, publishMessageCreated } from "../events";
import { type MachineCaller, MachineRequestError } from "../machine-hub";
import { formatDuration } from "../machine-tasks";
import {
  computerDrivers,
  drivesComputer,
  getMachine,
  mayDriveComputer,
  requireComputerDriver,
  servesDesktops,
} from "../machines";
import { appPageLink, namesOwnApp } from "../message-links";
import { insertMessage, messageView } from "../messages";
import { missionOfRun } from "../mission-context";
import {
  browserHandoffRecipient,
  humanBehindRun,
  notifyBrowserHandoff,
  notifyDesktopTaken,
  remindBrowserHandoffNotifications,
  resolveBrowserHandoffNotifications,
} from "../notification-producers";
import { can, getMembership } from "../organizations";
import { enqueue } from "../outbox";
import { resumeRunWithResult } from "../run-resume";
import { bodyCode, runWhere } from "../run-tools";
import { closedRefusal } from "../standing";
import { grantedScopeKeys, isAllowed, toolAccess } from "../tools/scopes";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import { getBrowserProfile, runBrowserProfile } from "./profiles";
import { agentBrowserStatus, browserUnavailableText } from "./status";
import {
  BROWSER_SCOPE,
  BROWSER_TOOL_INFO,
  type BrowserHandoffResult,
  type BrowserPage,
  DESKTOP_SCOPE,
  DESKTOP_TOOL_INFO,
} from "./types";

const { browserHandoffs, agentRuns, agents, channelMembers, channels, machines, messages, users } = schema;

export type BrowserHandoffRow = typeof browserHandoffs.$inferSelect;
export type BrowserHandoffStatus = BrowserHandoffRow["status"];

/**
 * How long an agent waits by default for a person to open its request, its browser held open meanwhile: a day,
 * since people often see it later and an open browser costs its computer nothing more.
 */
export const HANDOFF_TIMEOUT_DEFAULT_MINUTES = 24 * 60;
/** The longest an agent may ask to wait. */
export const HANDOFF_TIMEOUT_MAX_MINUTES = 24 * 60;
/** A request still unanswered this long after it was asked reminds the people asked, once (`remindBrowserHandoff`). */
export const HANDOFF_REMIND_AFTER_MS = 60 * 60_000;
export const HANDOFF_REMIND_JOB = "browser.handoff_remind";
/**
 * Once a person has control there is no deadline; only their live view going
 * away for this long ends it (expired): time to reconnect and carry on.
 */
export const CONTROL_GRACE_MS = 2 * 60_000;
/** While the person in control watches, their grace is pushed at most this often (one write, not one per frame). */
const CONTROL_TOUCH_EVERY_MS = 30_000;
export const ASK_PERSON_TOOL = "browser_ask_person";
export const DESKTOP_ASK_PERSON_TOOL = "desktop_ask_person";

/** What a handoff needs of each screen. */
interface Screen {
  /** What the agent reads: the screen, what it shows, and the tool that reads it again. */
  what: string;
  thing: string;
  read: string;
  /** Where a person helps: "in your browser". */
  on: string;
  /** People may drive the screen only while the agent may use this tool itself. */
  tool: { name: string; scope: string };
  /** The computer it runs on while no open handoff holds one. */
  machine(agent: { machineId: string | null; browserMachineId: string | null }): string | null;
  /** Who may take control of it, besides who may watch it (throws). */
  mayControl?(db: Database, userId: string, orgId: string, agentId: string): Promise<unknown>;
  /** The agent's request for a person: its tool, and its card (the app translates `code`). */
  ask: { tool: string; card: string; code: string };
}
const SCREENS: Record<ScreenKind, Screen> = {
  browser: {
    what: "browser",
    thing: "page",
    read: "browser_read",
    on: "in your browser",
    tool: { name: "browser_open", scope: BROWSER_SCOPE },
    // The one its browser tools last used: a mission's or its own, whichever run used it.
    machine: (agent) => agent.browserMachineId ?? agent.machineId,
    ask: { tool: ASK_PERSON_TOOL, card: "Help needed in the browser", code: "browser_handoff" },
  },
  desktop: {
    what: "desktop",
    thing: "screen",
    read: "desktop_read",
    on: "on your desktop",
    tool: { name: "desktop_do", scope: DESKTOP_SCOPE },
    machine: (agent) => agent.machineId,
    // A desktop in control has a terminal: who may run commands as its OS user (ADR 0058 §4).
    mayControl: requireComputerDriver,
    ask: { tool: DESKTOP_ASK_PERSON_TOOL, card: "Help needed on the desktop", code: "desktop_handoff" },
  },
};

/**
 * The screen showing the same window as another one: an agent whose Chrome runs on its desktop (ADR 0058 §7)
 * has one window on both. An open handoff on either then blocks a take over of the other and the agent's
 * tools on both, and hides both views.
 */
const SAME_WINDOW: Partial<Record<ScreenKind, ScreenKind>> = { browser: "desktop", desktop: "browser" };

/**
 * Server-side topic of handoff changes (never sent to clients): every
 * replica's live view hears them, so the one holding the computer's socket
 * switches the stream and keeps control even when the change came from
 * another replica.
 */
export const BROWSER_HANDOFF_TOPIC = "browser-handoffs";

const OPEN: BrowserHandoffStatus[] = ["pending", "active"];
/** Runs that can still wait on a handoff (a take over bound to any other run is free to take). */
const LIVE_RUN: (typeof agentRuns.$inferSelect)["status"][] = [
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
];

/**
 * A person's turn in an agent's browser (ADR 0040 §6), as the app shows it:
 * the chat card (`meta.browserHandoff`), the live view's header and the
 * routes. An `ask`'s id is its card message's id.
 */
export interface BrowserHandoffView {
  id: string;
  agentId: string;
  runId: string | null;
  machineId: string;
  screen: ScreenKind;
  kind: "ask" | "takeover";
  instructions: string;
  status: BrowserHandoffStatus;
  requestedForUserId: string | null;
  controllerUserId: string | null;
  note: string | null;
  /** Pending: the agent's deadline. Null once a person has control (no deadline then). */
  expiresAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export function handoffView(h: BrowserHandoffRow): BrowserHandoffView {
  return {
    id: h.id,
    agentId: h.agentId,
    runId: h.runId,
    machineId: h.machineId,
    screen: h.screen,
    kind: h.kind,
    instructions: h.instructions,
    status: h.status,
    requestedForUserId: h.requestedForUserId,
    controllerUserId: h.controllerUserId,
    note: h.note,
    expiresAt: h.status === "pending" ? h.expiresAt.toISOString() : null,
    createdAt: h.createdAt.toISOString(),
    resolvedAt: h.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * The live view's side of a handoff (`live.ts`): told when control changes
 * hands, so the stream switches between watching and control. Optional: the
 * handoff works without anyone watching.
 */
export interface HandoffLiveHooks {
  changed(row: BrowserHandoffRow): void;
  /** The page the agent's browser shows now, best effort (the live view's latest frame, else the computer's answer). */
  page?(row: BrowserHandoffRow): Promise<BrowserPage | null>;
}

export interface HandoffDeps {
  db: Database;
  pubsub?: PubSub;
  live?: HandoffLiveHooks;
}

/** A person's turn in the agent's browser as the agent is told it: who, how long, the pages. */
export interface HandoffFacts {
  person?: string | null;
  forMs?: number | null;
  /** The page when they took control, and when it ended. */
  taken?: BrowserPage | null;
  returned?: BrowserPage | null;
}

/** What the agent reads when its run resumes. */
export function handoffResultText(
  result: BrowserHandoffResult,
  kind: "ask" | "takeover" = "ask",
  facts?: HandoffFacts,
  screen: ScreenKind = "browser",
): string {
  return `${outcomeText(result, kind, screen)}${factsText(result, facts, screen)}`;
}

function outcomeText(result: BrowserHandoffResult, kind: "ask" | "takeover", screen: ScreenKind): string {
  const { what, thing, read } = SCREENS[screen];
  if (kind === "takeover") {
    if (result.result === "expired") {
      return `A person took control of your ${what} and left without handing it back. The ${thing} may be anywhere now: read it again (${read}) and check where things are before assuming anything.`;
    }
    if (result.result !== "done") {
      return `A person had control of your ${what} and ended it without handing it back as done. Read the ${thing} again (${read}) and check where things are before assuming anything.`;
    }
    return `A person used your ${what} and handed it back. The ${thing} may have changed: read it again (${read}) before acting.`;
  }
  if (result.result === "done") {
    return `The person says it's done. Read the ${thing} again (${read}) and check it worked before going on; if it didn't, say so instead of carrying on.`;
  }
  if (result.result === "failed") {
    return `The person couldn't do it. Read the ${thing} again and decide what to do; if you are stuck, say what you need in your reply.`;
  }
  if (result.result === "withdrawn") return "You withdrew this request: nobody will do it.";
  if (result.result === "cancelled") {
    return `A person canceled the request. Read the ${thing} again and decide what to do; if you are stuck, say what you need in your reply.`;
  }
  return `No one did it in time. Read the ${thing} again; if it still needs a person, say so in your reply instead of asking again right away.`;
}

/** A page as the agent reads it: the title (the site's words, quoted) and the address. */
const pageText = (p: BrowserPage) => (p.title ? `${JSON.stringify(p.title.slice(0, 120))} at ${p.url}` : p.url);

/** The facts of a person's turn, on their own line; their note quoted as their own words. */
function factsText(result: BrowserHandoffResult, facts?: HandoffFacts, screen: ScreenKind = "browser"): string {
  const said: string[] = [];
  const who = facts?.person?.trim() || "The person";
  if (typeof facts?.forMs === "number") {
    said.push(`${who} had control for ${formatDuration(Math.round(facts.forMs / 1000))}.`);
  } else if (facts?.person?.trim()) {
    // When they took control isn't known here (they answered from the card, or on another server).
    said.push(`${who} answered.`);
  }
  if (facts?.taken) said.push(`When they took it, the ${SCREENS[screen].thing} was ${pageText(facts.taken)}.`);
  if (facts?.returned) {
    said.push(
      `${result.result === "done" ? "When they handed it back" : "When their control ended"}, it was ${pageText(facts.returned)}.`,
    );
  }
  if (result.note) said.push(`Their note, in their own words: ${JSON.stringify(result.note)}`);
  return said.length > 0 ? `\n${said.join(" ")}` : "";
}

/**
 * What this process saw of a person's turn, for the agent's text: when they
 * took control and the page then and at the end. In memory only, like the
 * frames: after a restart or on another replica the text says less.
 */
interface ControlFacts {
  since?: number;
  taken?: BrowserPage | null;
  returned?: BrowserPage | null;
}
// ponytail: per process, capped at CONTROL_FACTS_MAX (oldest dropped); a shared store once there are several replicas.
const controlFacts = new Map<string, ControlFacts>();
const CONTROL_FACTS_MAX = 500;

function keepFacts(handoffId: string, facts: ControlFacts) {
  controlFacts.delete(handoffId);
  controlFacts.set(handoffId, facts);
  for (const oldest of controlFacts.keys()) {
    if (controlFacts.size <= CONTROL_FACTS_MAX) break;
    controlFacts.delete(oldest);
  }
  return facts;
}

/** A person took control: when, and (in the background, best effort) the page they took it on. */
function noteControl(deps: HandoffDeps, row: BrowserHandoffRow) {
  const facts = keepFacts(row.id, { since: Date.now() });
  void deps.live?.page?.(row).then(
    (page) => {
      facts.taken = page;
    },
    () => {},
  );
}

/**
 * Someone other than the agent's owner took control of its desktop (ADR 0059 §8: an admin may, even while the agent
 * thinks with the owner's plan, so could read that sign-in there): audited (who, which agent, when), and the owner
 * hears it quietly.
 */
async function noteDesktopTaken(deps: HandoffDeps, row: BrowserHandoffRow) {
  if (!row.controllerUserId) return;
  // The browser's handoff puts who may drive the computer on the whole screen its window is on (`streamAccess`).
  if (
    row.screen !== "desktop" &&
    !(
      (await browserOnDesktop(deps.db, row.orgId, row.agentId, row.machineId)) &&
      (await mayDriveComputer(deps.db, row.controllerUserId, row.orgId, row.agentId))
    )
  ) {
    return;
  }
  await noteComputerTaken(deps, {
    orgId: row.orgId,
    agentId: row.agentId,
    actorId: row.controllerUserId,
    audit: { machineId: row.machineId, handoffId: row.id },
  });
}

/**
 * Someone other than the agent's owner got its screen or a shell as its OS user: the owner's quiet notice and, with
 * `audit`, the `desktop.control_taken` row. A terminal passes none: its stream is audited when it closes
 * (`terminal.session`).
 */
export async function noteComputerTaken(
  deps: HandoffDeps,
  input: { orgId: string; agentId: string; actorId: string; audit?: Record<string, unknown> },
) {
  const [agent] = await deps.db
    .select({ owner: agents.ownerUserId, name: agents.name, handle: agents.handle })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.orgId, input.orgId)));
  if (!agent || agent.owner === input.actorId) return;
  if (input.audit) {
    await recordAudit(deps.db, {
      orgId: input.orgId,
      actor: { type: "person", id: input.actorId },
      action: "desktop.control_taken",
      target: { type: "agent", id: input.agentId },
      details: input.audit,
    });
  }
  if (!agent.owner) return;
  await notifyDesktopTaken(deps, {
    orgId: input.orgId,
    agentId: input.agentId,
    agentName: agent.name || agent.handle,
    ownerUserId: agent.owner,
    actorId: input.actorId,
    at: new Date(),
  }).catch(() => {});
}

/** Control ended: the page it ended on (best effort). */
async function noteControlEnded(deps: HandoffDeps, row: BrowserHandoffRow) {
  if (!row.controllerUserId || !deps.live?.page) return;
  const page = await deps.live.page(row).catch(() => null);
  const facts = controlFacts.get(row.id);
  if (facts) facts.returned = page;
  else if (page) keepFacts(row.id, { returned: page });
}

/**
 * Who had the agent's browser and for how long (from the record), with the pages this process saw. `answeredBy`:
 * who answered without ever taking control (only their name).
 */
async function handoffFacts(
  db: Executor,
  row: BrowserHandoffRow,
  answeredBy?: string,
): Promise<HandoffFacts | undefined> {
  const who = row.controllerUserId ?? answeredBy;
  if (!who) return undefined;
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, who));
  if (!row.controllerUserId) return { person: person?.name ?? null };
  const kept = controlFacts.get(row.id);
  // A take over starts in control; when a person took an asked one is only known here.
  const since = kept?.since ?? (row.kind === "takeover" ? row.createdAt.getTime() : undefined);
  const end = row.resolvedAt?.getTime();
  return {
    person: person?.name ?? null,
    forMs: since !== undefined && end !== undefined ? Math.max(0, end - since) : null,
    taken: kept?.taken ?? null,
    returned: kept?.returned ?? null,
  };
}

// ── Access ────────────────────────────────────────────────────────────────────

/**
 * Who may watch an agent's screen, and see its handoffs (driving it: `requireBrowserControl`): org admins of that
 * screen (`control_browsers`; the desktop `control_computers`), and, with the same screen's `own_*` key, the agent's
 * responsible person, the person a handoff was asked of, and the person behind the work (who asked for the run
 * waiting on it, or for one of the agent's runs going on now). Not everyone who can read a channel: the screen shows
 * all of the agent's work, DMs included. A desktop also to whoever may drive its computer (`drivesComputer`): they
 * can see all of it anyway. `level`: refused only for the key (`screenAccess`).
 */
export async function requireBrowserAccess(
  db: Database,
  userId: string,
  orgId: string,
  agentId: string,
  handoff?: BrowserHandoffRow | null,
  screen: ScreenKind = "browser",
) {
  const { access, refusal } = await screenAccess(db, userId, orgId, agentId, handoff, screen);
  if (refusal === "level") {
    throw new ForbiddenError(
      screen === "desktop"
        ? "Your roles give you the agents' browsers, not their whole computer"
        : "Your roles don't give you the agents' computers",
    );
  }
  if (refusal) throw new ForbiddenError(`You can't use this agent's ${SCREENS[screen].what}`);
  return access;
}

/**
 * `requireBrowserAccess` without throwing on a refusal: `level` when the person would see this screen but their
 * roles don't give them it (no `own_*` key; an admin of browsers on a desktop), `none` otherwise.
 */
export async function screenAccess(
  db: Database,
  userId: string,
  orgId: string,
  agentId: string,
  handoff?: BrowserHandoffRow | null,
  screen: ScreenKind = "browser",
) {
  const membership = await getMembership(db, userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  const closed = closedRefusal(membership.standing);
  if (closed) throw closed;
  const [agent] = await db
    .select({ owner: agents.ownerUserId, machineId: agents.machineId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) throw new NotFoundError("Agent not found");
  const full = screen === "desktop";
  const admin = can(membership, full ? "control_computers" : "control_browsers");
  const access = { ...agent, admin };
  if (admin) return { access, refusal: null };
  const theirs = await seesScreenAsTheirs(db, userId, orgId, agentId, agent, handoff, screen);
  if (theirs && can(membership, full ? "own_computers" : "own_browsers")) return { access, refusal: null };
  return { access, refusal: theirs || (full && can(membership, "control_browsers")) ? "level" : "none" } as const;
}

/** Whether the agent's screen is this person's to see, keys aside (`requireBrowserAccess`). */
async function seesScreenAsTheirs(
  db: Database,
  userId: string,
  orgId: string,
  agentId: string,
  agent: { owner: string | null; machineId: string | null },
  handoff: BrowserHandoffRow | null | undefined,
  screen: ScreenKind,
) {
  if (agent.owner === userId) return true;
  const open = handoff === undefined ? await openHandoffOf(db, orgId, agentId, screen) : handoff;
  if (open?.requestedForUserId === userId) return true;
  const runs = open?.runId
    ? [open.runId]
    : (
        await db
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.orgId, orgId),
              eq(agentRuns.agentId, agentId),
              inArray(agentRuns.status, ["queued", "running", "waiting_input", "waiting_approval"]),
            ),
          )
          .orderBy(desc(agentRuns.createdAt))
          .limit(5)
      ).map((r) => r.id);
  for (const runId of runs) {
    // A run consulted for someone outside the agent's audience has nobody behind it for its screen.
    if ((await humanBehindRun({ db }, orgId, runId)) === userId && !(await answersAgentsOnly(db, orgId, runId))) {
      return true;
    }
  }
  if (screen === "desktop" && agent.machineId) {
    const machine = await getMachine(db, orgId, agent.machineId);
    if (machine && drivesComputer(machine, { userId, admin: false, own: true, owner: false })) return true;
  }
  return false;
}

/**
 * Who may drive an agent's screen (take over, take an asked handoff, type, click, open a page): org admins,
 * the agent's responsible person, and the person an open handoff was asked of, only while it stays open. The
 * person behind a live run only watches (`requireBrowserAccess`): the agent's browser keeps one profile with
 * everyone's logins, so talking to the agent must not lend them (ADR 0040 §6). A desktop also to who may
 * drive its computer (it needs that anyway: `mayControl`).
 */
export async function requireBrowserControl(
  db: Database,
  userId: string,
  orgId: string,
  agentId: string,
  handoff?: BrowserHandoffRow | null,
  screen: ScreenKind = "browser",
) {
  const open = handoff === undefined ? await openHandoffOf(db, orgId, agentId, screen) : handoff;
  const access = await requireBrowserAccess(db, userId, orgId, agentId, open, screen);
  if (access.admin || access.owner === userId) return access;
  if (open && OPEN.includes(open.status) && open.requestedForUserId === userId) return access;
  if (screen === "desktop" && access.machineId) {
    const machine = await getMachine(db, orgId, access.machineId);
    // `requireBrowserAccess` checked the desktop's key.
    if (machine && drivesComputer(machine, { userId, admin: false, own: true, owner: false })) return access;
  }
  throw new ForbiddenError(
    `Only an admin, the agent's owner or the person it asked can control its ${SCREENS[screen].what}`,
  );
}

/**
 * Whether the agent's Chrome runs on its desktop (ADR 0058 §7), so both screens show one window: it may use
 * its desktop, its browser runs on its own computer (`machineId`: the one it is about to run on; by default
 * the one its browser last used), and that computer serves desktops. Its browser requests say so (`desktop`).
 */
export async function browserOnDesktop(db: Executor, orgId: string, agentId: string, machineId?: string) {
  const [row] = await db
    .select({ agent: agents, machine: machines })
    .from(agents)
    .innerJoin(machines, and(eq(machines.id, agents.machineId), isNull(machines.deletedAt)))
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!row || (machineId ?? row.agent.browserMachineId ?? row.machine.id) !== row.machine.id) return false;
  return servesDesktops(row.machine) && (await agentUsesScreen(db, orgId, agentId, "desktop"));
}

/** The open handoff of the agent's other screen that shows the same window as `screen`, if any. */
export async function openElsewhere(db: Executor, orgId: string, agentId: string, screen: ScreenKind) {
  const other = SAME_WINDOW[screen];
  const open = other ? await openHandoffOf(db, orgId, agentId, other) : null;
  return open && (await browserOnDesktop(db, orgId, agentId)) ? open : null;
}

/** The handoff that holds `screen`: its own, else the one of the screen showing the same window. */
export async function openHandoffOn(db: Executor, orgId: string, agentId: string, screen: ScreenKind) {
  return (await openHandoffOf(db, orgId, agentId, screen)) ?? (await openElsewhere(db, orgId, agentId, screen));
}

/**
 * Inside the transaction that opens a handoff of one of the agent's screens: one opens at a time per agent
 * (a lock), and none while the screen showing the same window has one.
 */
async function claimScreens(tx: Executor, orgId: string, agentId: string, screen: ScreenKind) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-screens:${agentId}`}))`);
  const open = await openElsewhere(tx, orgId, agentId, screen);
  if (open) throw new SameWindowError(open);
}

/** It ended meanwhile: the apps read it again, and its card settles. Someone else in control has no code. */
const handoffOver = () => new ConflictError("This is already over", "browser.handoff_over");

/** The screen showing the same window has an open handoff: this one can't start. */
class SameWindowError extends ConflictError {
  constructor(readonly open: BrowserHandoffRow) {
    super(
      open.status === "active"
        ? `Someone is using the agent's ${SCREENS[open.screen].what}, which shows the same window: wait for them to hand it back`
        : `The agent is waiting for help with its ${SCREENS[open.screen].what}, which shows the same window: answer it there`,
      "handoff.same_window",
    );
  }
}

/**
 * The computer an agent's screen runs on now: an open handoff's, else the
 * screen's own choice (for the browser `agents.browser_machine_id`, else the
 * agent's own computer).
 */
export async function browserMachineOf(
  db: Database,
  orgId: string,
  agentId: string,
  screen: ScreenKind = "browser",
): Promise<string | null> {
  const open = await openHandoffOf(db, orgId, agentId, screen);
  if (open) return open.machineId;
  const [agent] = await db
    .select({ machineId: agents.machineId, browserMachineId: agents.browserMachineId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  return agent ? SCREENS[screen].machine(agent) : null;
}

async function loadHandoff(db: Executor, orgId: string, handoffId: string) {
  const [row] = await db
    .select()
    .from(browserHandoffs)
    .where(and(eq(browserHandoffs.id, handoffId), eq(browserHandoffs.orgId, orgId)));
  if (!row) throw new NotFoundError("Not found");
  return row;
}

/** The handoff open on one of an agent's screens (a person in control, or asked to be), if any. */
export async function openHandoffOf(db: Executor, orgId: string, agentId: string, screen: ScreenKind = "browser") {
  const [row] = await db
    .select()
    .from(browserHandoffs)
    .where(
      and(
        eq(browserHandoffs.orgId, orgId),
        eq(browserHandoffs.agentId, agentId),
        eq(browserHandoffs.screen, screen),
        inArray(browserHandoffs.status, OPEN),
      ),
    )
    .orderBy(desc(browserHandoffs.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getHandoff(db: Database, userId: string, orgId: string, handoffId: string) {
  const row = await loadHandoff(db, orgId, handoffId);
  await requireBrowserAccess(db, userId, orgId, row.agentId, row, row.screen);
  return handoffView(row);
}

// ── Card, events, notifications ───────────────────────────────────────────────

/**
 * The handoff as everyone in its conversation gets it (the card, its events): the note only on
 * "Não consegui", which the card shows. The agent reads every note (`handoffResultText`).
 */
const cardView = (row: BrowserHandoffRow): BrowserHandoffView => ({
  ...handoffView(row),
  note: row.status === "failed" ? row.note : null,
});

/** Writes the handoff's state into its chat card (`meta.browserHandoff`); takeovers have no card of their own. */
async function syncCard(db: Executor, row: BrowserHandoffRow) {
  if (row.kind !== "ask") return;
  await db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{browserHandoff}', ${JSON.stringify(cardView(row))}::jsonb)` })
    .where(and(eq(messages.id, row.id), eq(messages.orgId, row.orgId)));
}

/** Where a handoff lives in the conversation: an ask's card message. */
async function cardWhere(db: Executor, row: BrowserHandoffRow) {
  if (row.kind !== "ask") return null;
  const [m] = await db
    .select({ channelId: messages.channelId, threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.id, row.id), eq(messages.orgId, row.orgId)));
  return m ?? null;
}

/** Where a run's replies go (its card in the conversation follows it), when the run exists. */
async function runPlace(db: Executor, orgId: string, runId: string | null) {
  if (!runId) return null;
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  if (!run) return null;
  const where = runWhere(run);
  return { channelId: where.channelId, threadId: where.threadId };
}

/**
 * Where a handoff shows in the conversation: an ask's card, a take over's run (its browser card
 * stays on that run's live block or reply while the person holds control). Null: nowhere (a take
 * over started from the agent's or the computer's page, before any run waits on it).
 */
export async function handoffPlace(db: Executor, row: BrowserHandoffRow) {
  return row.kind === "ask" ? cardWhere(db, row) : runPlace(db, row.orgId, row.runId);
}

/** The open handoffs on a computer (sent to it again when it reconnects). */
export function openHandoffsOfMachine(db: Executor, machineId: string) {
  return db
    .select()
    .from(browserHandoffs)
    .where(and(eq(browserHandoffs.machineId, machineId), inArray(browserHandoffs.status, OPEN)));
}

/** The agent's page with its computer open (`?computer=1`; older links' `?browser=1` and `?desktop=1` open it too). */
export const agentBrowserLink = (orgId: string, agentId: string) => `/org/${orgId}/agents/${agentId}?computer=1`;

/**
 * An open handoff as the computer's desktop app shows it (`browser.handoff`):
 * waiting or in control, who is in control, what was asked, where its card is.
 */
export async function handoffInfo(db: Executor, row: BrowserHandoffRow): Promise<BrowserHandoffInfo | null> {
  if (!OPEN.includes(row.status)) return null;
  const [person] = row.controllerUserId
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, row.controllerUserId))
    : [];
  const where = await handoffPlace(db, row);
  // A DM has no channel page of its own (`/c/<id>` says it doesn't exist): the web opens it by the agent.
  const [conversation] =
    where && !where.threadId
      ? await db.select({ kind: channels.kind }).from(channels).where(eq(channels.id, where.channelId))
      : [];
  // The conversation holding its card (an ask's message, a take over's run), else the agent's page with its browser open.
  const link = where
    ? where.threadId
      ? `/org/${row.orgId}/threads/${where.threadId}`
      : conversation?.kind === "dm"
        ? `/org/${row.orgId}/dm/agent/${row.agentId}`
        : row.kind === "ask"
          ? `/org/${row.orgId}/c/${where.channelId}?m=${row.id}`
          : `/org/${row.orgId}/c/${where.channelId}`
    : agentBrowserLink(row.orgId, row.agentId);
  return {
    status: row.status === "active" && row.controllerUserId ? "active" : "pending",
    ...(person?.name ? { controller: person.name } : {}),
    ...(row.instructions ? { request: row.instructions.slice(0, 300) } : {}),
    link,
  };
}

/**
 * Tells the conversation (card state) and the live view (who is in control) after a change
 * committed. `movedFrom`: the run the take over was bound to before (its conversation hears too,
 * so the card there goes).
 */
async function afterChange(deps: HandoffDeps, row: BrowserHandoffRow, movedFrom?: string | null) {
  deps.live?.changed(row);
  // The replica holding the computer's socket may be another one: it hears it here.
  await deps.pubsub
    ?.publish(BROWSER_HANDOFF_TOPIC, {
      type: "browser.handoff.changed",
      orgId: row.orgId,
      agentId: row.agentId,
      handoffId: row.id,
      machineId: row.machineId,
      screen: row.screen,
    })
    .catch(() => {});
  const places = [await handoffPlace(deps.db, row)];
  if (movedFrom && movedFrom !== row.runId) places.push(await runPlace(deps.db, row.orgId, movedFrom));
  const seen = new Set<string>();
  for (const where of places) {
    if (!where) continue;
    const key = `${where.channelId}:${where.threadId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await publishChannelEvent(deps.pubsub, {
      type: "browser.handoff.updated",
      channelId: where.channelId,
      threadId: where.threadId,
      handoff: cardView(row),
    });
  }
  if (!OPEN.includes(row.status)) {
    await resolveBrowserHandoffNotifications(deps, row.orgId, row.id).catch(() => {});
  }
}

// ── The tool ──────────────────────────────────────────────────────────────────

/**
 * `browser_ask_person` (scope `browser:use`): the agent asks a person to do
 * something in its browser (sign in, a code, a captcha). A card goes to the
 * conversation, the person who asked for the work (else the agent's owner)
 * hears it in "Waiting for you" and on the phone, and the run waits
 * (`data.pause`) until they press Done or Couldn't, or it expires. The
 * agent then reads the page again and checks.
 */
/**
 * Why a hand-off to our own app is refused (ADR 0137 amendment): the agent already works inside it, so a person
 * never signs it in on its computer. What it changes goes through its tools and cards, else a link to the page.
 */
export const ownAppRefusal = (orgId: string) =>
  `Nothing was asked: that is agentes.chat itself, the app you work in. Never sign in to it on your computer, nor ask a person to. Change the workspace with your own tools, which post cards a person applies as themselves (propose_remove_agents archives or deletes agents, propose_agent creates them, propose_settings_change, offer_invites, offer_connect_app; find_tools finds them). When no tool does it, send the person the link to the page instead: the team ${appPageLink(orgId, "/team")}, settings ${appPageLink(orgId, "/settings/members")} (or /settings/roles, /settings/connectors, /settings/computers, /settings/usage).`;

/** The address the agent's browser shows, as its computer says (short: it runs before a person is asked). */
async function browserUrl(hub: MachineCaller, machineId: string, agent: { id: string; handle: string }) {
  try {
    const reply = await hub.call<"browser.act">(
      machineId,
      { op: "browser.act", agent, command: "get", args: ["url"], timeoutSeconds: 3 },
      { timeoutMs: 4000 },
    );
    const data = reply.success ? (reply.data as { url?: unknown } | null) : null;
    return typeof data?.url === "string" ? data.url : null;
  } catch {
    return null;
  }
}

export function createBrowserHandoffToolSource(
  deps: { pubsub?: PubSub; machines?: { hub: MachineCaller } } = {},
): ToolSource {
  const hub = deps.machines?.hub;
  /** The computer a request goes to, or why it can't be asked there. */
  type Place = { machineId: string; name: string; online: boolean } | { unavailable: string };
  const places: Record<ScreenKind, (ctx: ToolContext) => Promise<Place>> = {
    // The same computer and checks as the other browser tools: the mission's in a mission thread, else the agent's.
    async browser(ctx) {
      const missionMachine = (await missionOfRun(ctx))?.machineId ?? null;
      const s = await agentBrowserStatus(ctx.db, hub, ctx.orgId, ctx.agentId, missionMachine);
      return s.available
        ? { machineId: s.machineId, name: s.machineName, online: s.online }
        : { unavailable: browserUnavailableText(s) };
    },
    async desktop(ctx) {
      const agent = await getAgentCached(ctx.db, ctx.orgId, ctx.agentId);
      const s = agent?.machineId && hub ? await hub.status(agent.machineId) : null;
      if (!s || s.orgId !== ctx.orgId) {
        return { unavailable: "Your desktop only runs on a connected computer, and you don't use one. Say so." };
      }
      if (!servesDesktops(s)) {
        return {
          unavailable: `The desktop isn't on or ready on the computer ${s.name}. Only the person at that computer can turn it on; tell the people.`,
        };
      }
      return { machineId: s.id, name: s.name, online: s.online };
    },
  };

  async function ask(screen: ScreenKind, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    const s = SCREENS[screen];
    const instructions = String(input.instructions ?? "").trim();
    if (!instructions) return { content: "Say what the person should do.", isError: true };
    if (namesOwnApp(instructions)) return { content: ownAppRefusal(ctx.orgId), isError: true };
    const minutes =
      typeof input.timeout_minutes === "number"
        ? Math.min(HANDOFF_TIMEOUT_MAX_MINUTES, Math.max(1, Math.floor(input.timeout_minutes)))
        : HANDOFF_TIMEOUT_DEFAULT_MINUTES;
    // A profile is a whole shared account: only its drivers sign in to it, never the person who asked for the work.
    const profileId = screen === "browser" ? await runBrowserProfile(ctx.db, ctx) : null;
    if (profileId) {
      const name = (await getBrowserProfile(ctx.db, ctx.orgId, profileId))?.name ?? "?";
      return {
        content: `You are in the shared browser profile "${name}": a person can't be asked to act in it from here. Tell the people what it needs; someone who manages apps and computers uses Fazer login on "${name}".`,
        isError: true,
      };
    }
    const place = await places[screen](ctx);
    if ("unavailable" in place) return { content: place.unavailable, isError: true };
    if (!place.online) {
      return {
        content: `Your computer ${place.name} is offline, so no one can use your ${s.what} now. Say so in your reply.`,
        isError: true,
      };
    }
    if (screen === "browser" && hub) {
      const agent = await getAgentCached(ctx.db, ctx.orgId, ctx.agentId);
      const url = agent && (await browserUrl(hub, place.machineId, { id: agent.id, handle: agent.handle }));
      if (url && namesOwnApp(url)) return { content: ownAppRefusal(ctx.orgId), isError: true };
    }
    const [run] = await ctx.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId)));
    if (!run) return { content: "This call can't wait for a person here.", isError: true };
    const open = await openHandoffOn(ctx.db, ctx.orgId, ctx.agentId, screen);
    if (open) {
      return {
        content:
          open.kind === "takeover"
            ? `A person is using your ${SCREENS[open.screen].what} right now. Wait for them to hand it back before asking.`
            : `You already asked a person for help ${SCREENS[open.screen].on}; wait for that answer.`,
        isError: true,
      };
    }
    // A desktop goes only to who may drive its computer (ADR 0058 §4); a browser to who asked for the work.
    const drivers = screen === "desktop" ? await computerDrivers(ctx.db, ctx.orgId, ctx.agentId) : null;
    if (drivers?.length === 0) {
      return {
        content: "No one in this workspace may take control of your desktop. Say what you need in your reply instead.",
        isError: true,
      };
    }
    const agentsOnly = await answersAgentsOnly(ctx.db, ctx.orgId, ctx.runId);
    const recipient = drivers
      ? drivers.length === 1
        ? (drivers[0] ?? null)
        : null
      : await browserHandoffRecipient(
          { db: ctx.db },
          ctx.orgId,
          // Consulted for someone outside its audience: its owner helps, never that person.
          agentsOnly ? null : ctx.runId,
          ctx.agentId,
        );
    // The card goes where the person asked can act on it: the run's conversation when they're in it, else their DM
    // with the agent (a run in a room between agents, or one they aren't in, would leave the request unreachable).
    // Several drivers: one in the conversation keeps it there, else whoever asked for the work's DM; else it stays
    // in the conversation and every driver gets it on the computer (a DM with an arbitrary one would be a stranger's).
    const runAt = runWhere(run);
    let asked = recipient;
    if (!asked && drivers) {
      const [member] = await ctx.db
        .select({ userId: channelMembers.userId })
        .from(channelMembers)
        .where(
          and(
            eq(channelMembers.orgId, run.orgId),
            eq(channelMembers.channelId, runAt.channelId),
            inArray(channelMembers.userId, drivers),
          ),
        )
        .limit(1);
      const requester =
        member?.userId || agentsOnly
          ? null
          : await browserHandoffRecipient({ db: ctx.db }, ctx.orgId, ctx.runId, ctx.agentId);
      asked = member?.userId ?? (requester && drivers.includes(requester) ? requester : null);
    }
    const where =
      asked && !(await isChannelMember(ctx.db, run.orgId, runAt.channelId, asked))
        ? { channelId: (await openPersonAgentDm(ctx.db, run.orgId, asked, run.agentId)).id, threadId: null }
        : runAt;
    const busy = {
      content: `A person is using your ${s.what}, or was just asked to; wait for that before asking.`,
      isError: true,
    };
    let created: { card: Awaited<ReturnType<typeof insertMessage>>; row: BrowserHandoffRow };
    try {
      created = await ctx.db.transaction(async (tx) => {
        await claimScreens(tx, run.orgId, run.agentId, screen);
        const card = await insertMessage(tx, {
          orgId: run.orgId,
          channelId: where.channelId,
          threadId: where.threadId,
          author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
          body: `${s.ask.card}: ${instructions}`,
          meta: bodyCode(s.ask.code, { instructions }),
        });
        // The card's id is the handoff's: the card is found and kept in sync by it.
        const [row] = await tx
          .insert(browserHandoffs)
          .values({
            id: card.id,
            orgId: run.orgId,
            agentId: run.agentId,
            runId: run.id,
            machineId: place.machineId,
            screen,
            kind: "ask",
            instructions,
            requestedForUserId: recipient,
            expiresAt: new Date(Date.now() + minutes * 60_000),
          })
          .returning();
        if (!row) throw new Error("handoff not created");
        if (minutes * 60_000 > HANDOFF_REMIND_AFTER_MS) {
          await enqueue(tx, {
            orgId: run.orgId,
            kind: HANDOFF_REMIND_JOB,
            payload: { handoffId: row.id },
            dedupeKey: `${HANDOFF_REMIND_JOB}:${row.id}`,
            runAt: new Date(Date.now() + HANDOFF_REMIND_AFTER_MS),
          });
        }
        await syncCard(tx, row);
        card.meta = { ...card.meta, browserHandoff: handoffView(row) };
        return { card, row };
      });
    } catch (error) {
      // Someone took over (or another run asked) between the check and the insert: one open handoff per screen.
      if (isUniqueViolation(error) || error instanceof SameWindowError) return busy;
      throw error;
    }
    if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(created.card));
    await notifyBrowserHandoff(
      { db: ctx.db, pubsub: deps.pubsub },
      created.row,
      { channelId: where.channelId, threadId: where.threadId },
      drivers ?? undefined,
    ).catch(() => {});
    return {
      content: `Asked for help (if nobody opens it within ${formatDuration(minutes * 60)} you'll be told). End your turn now; you'll be woken with the result.`,
      // The run waits on this handoff and resumes with the result (`resumeRunWithResult`).
      data: { pause: { kind: "input", id: created.row.id }, handoffId: created.row.id },
    };
  }

  const tool = (screen: ScreenKind, scope: string, label: string, description: string): ToolDefinition => ({
    name: SCREENS[screen].ask.tool,
    description,
    scope,
    inputSchema: {
      type: "object",
      properties: {
        instructions: { type: "string", minLength: 1, maxLength: 500 },
        timeout_minutes: {
          type: "integer",
          minimum: 1,
          maximum: HANDOFF_TIMEOUT_MAX_MINUTES,
          description: `How long to wait for someone to open it (default ${HANDOFF_TIMEOUT_DEFAULT_MINUTES}).`,
        },
      },
      required: ["instructions"],
      additionalProperties: false,
    },
    describe: (input) => ({
      title: label,
      detail: typeof input.instructions === "string" ? input.instructions : undefined,
    }),
    execute: (input, ctx) => ask(screen, input, ctx),
  });
  const tools: Record<ScreenKind, ToolDefinition> = {
    browser: tool(
      "browser",
      BROWSER_SCOPE,
      BROWSER_TOOL_INFO.browser_ask_person.label,
      "Hand a person the step only they can do in your browser (sign in, scan a QR code with their phone, type a code sent to them, solve a captcha, confirm on their phone) and wait until they're done. Open the page and get to that step first, so it is ready for them, and call it as soon as the task reaches it: it is never a reason to stop or to say you can't. Write what to do in one short sentence in the language the people use. Before asking, try what you can yourself (a password you were given through request_secret goes in with browser_type_secret). End your turn after calling it: you are woken with the result, then read the page again and check.",
    ),
    desktop: tool(
      "desktop",
      DESKTOP_SCOPE,
      DESKTOP_TOOL_INFO.desktop_ask_person.label,
      "Hand a person the step only they can do on your desktop (sign in to an app, scan a QR code with their phone, type a code sent to them, answer a prompt only a person should) and wait until they're done. Open the app and get to that step first, and call it as soon as the task reaches it: it is never a reason to stop or to say you can't. Only people who may use your computer as you are asked. Write what to do in one short sentence in the language the people use. End your turn after calling it: you are woken with the result, then look at the screen again and check.",
    ),
  };
  return {
    name: "browser-handoff",
    // Offered with the screen's other tools: only when the agent may use it and its computer serves it.
    async tools(ctx) {
      if (!hub) return [];
      const granted = await grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId);
      const offered: ToolDefinition[] = [];
      for (const screen of SCREEN_KINDS) {
        const t = tools[screen];
        if (isAllowed(toolAccess(granted, t)) && !("unavailable" in (await places[screen](ctx)))) offered.push(t);
      }
      return offered;
    },
  };
}

// ── A person's side ───────────────────────────────────────────────────────────

/**
 * Resumes the run waiting on a handoff (if any) with what the agent should
 * read; a run that stopped waiting on it (a person wrote meanwhile,
 * `waits.ts`) hears it as a notice instead. Idempotent.
 */
async function resumeWaitingRun(
  deps: HandoffDeps,
  row: BrowserHandoffRow,
  result: BrowserHandoffResult,
  answeredBy?: string,
  waitingOnly?: boolean,
) {
  if (!row.runId) return;
  await resumeRunWithResult(deps.db, {
    runId: row.runId,
    waitId: row.id,
    result: {
      content: handoffResultText(result, row.kind, await handoffFacts(deps.db, row, answeredBy), row.screen),
    },
    pubsub: deps.pubsub,
    waitingOnly,
  });
}

/** What an ended handoff tells the agent. */
function endedResult(row: BrowserHandoffRow): BrowserHandoffResult {
  const note = row.note ? { note: row.note } : {};
  if (row.status === "done") return { result: "done", ...note };
  if (row.status === "cancelled") return { result: "cancelled" };
  if (row.status === "withdrawn") return { result: "withdrawn" };
  if (row.status === "failed") return { result: "failed", ...note };
  return { result: "expired" };
}

/**
 * After a handoff ended (committed): the run goes on and everyone hears.
 * Failures don't undo the end: the sweep (`expireBrowserHandoffs`) resumes
 * runs still waiting on ended handoffs.
 */
async function settle(deps: HandoffDeps, row: BrowserHandoffRow, answeredBy?: string) {
  await noteControlEnded(deps, row).catch(() => {});
  await resumeWaitingRun(deps, row, endedResult(row), answeredBy).catch(() => {});
  await afterChange(deps, row).catch(() => {});
}

/**
 * A person takes control of an asked handoff (opens the live view and starts
 * driving). Idempotent for the person already in control; another person in
 * control → `ConflictError`.
 */
export async function claimHandoff(deps: HandoffDeps, actorId: string, orgId: string, handoffId: string) {
  const current = await loadHandoff(deps.db, orgId, handoffId);
  await requireBrowserControl(deps.db, actorId, orgId, current.agentId, current, current.screen);
  await SCREENS[current.screen].mayControl?.(deps.db, actorId, orgId, current.agentId);
  if (!OPEN.includes(current.status)) throw handoffOver();
  if (current.status === "active" && current.controllerUserId === actorId) return handoffView(current);
  const now = Date.now();
  const [row] = await deps.db
    .update(browserHandoffs)
    .set({
      status: "active",
      controllerUserId: actorId,
      // No deadline while in control: only their live view going away for the grace ends it.
      expiresAt: new Date(now + CONTROL_GRACE_MS),
    })
    .where(
      and(
        eq(browserHandoffs.id, handoffId),
        sql`(${browserHandoffs.status} = 'pending' or (${browserHandoffs.status} = 'active' and ${browserHandoffs.controllerUserId} is null))`,
        sql`${browserHandoffs.expiresAt} > now()`,
      ),
    )
    .returning();
  if (!row) throw new ConflictError("Someone else is in control");
  await syncCard(deps.db, row);
  noteControl(deps, row);
  await afterChange(deps, row);
  await noteDesktopTaken(deps, row);
  return handoffView(row);
}

/**
 * Done or Couldn't on an asked handoff, or the hand back of a take over: it
 * ends, and the run waiting on it resumes, told the person's note (either
 * result) in their own words. Only the person in control, or anyone allowed
 * while nobody took control.
 */
export async function finishHandoff(
  deps: HandoffDeps,
  actorId: string,
  orgId: string,
  handoffId: string,
  input: { result: "done" | "failed"; note?: string },
) {
  const current = await loadHandoff(deps.db, orgId, handoffId);
  await requireBrowserAccess(deps.db, actorId, orgId, current.agentId, current, current.screen);
  if (current.controllerUserId && current.controllerUserId !== actorId && current.status === "active") {
    throw new ConflictError("Someone else is in control");
  }
  const note = input.note?.trim().slice(0, 1000) || null;
  const ended = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(browserHandoffs)
      .set({
        status: input.result,
        note,
        // "Couldn't" from someone who never took control changed nothing on the page: nobody is recorded in
        // control, so the agent isn't made to read the page first (its browser may not even be open).
        controllerUserId: current.controllerUserId ?? (input.result === "done" ? actorId : null),
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(browserHandoffs.id, handoffId),
          inArray(browserHandoffs.status, OPEN),
          // Someone else took control since it was read: not theirs to finish.
          sql`(${browserHandoffs.status} <> 'active' or ${browserHandoffs.controllerUserId} is null or ${browserHandoffs.controllerUserId} = ${actorId})`,
        ),
      )
      .returning();
    if (!row) return null;
    await syncCard(tx, row);
    return row;
  });
  if (!ended) {
    const now = await loadHandoff(deps.db, orgId, handoffId);
    throw OPEN.includes(now.status) ? new ConflictError("Someone else is in control") : handoffOver();
  }
  await settle(deps, ended, actorId);
  return handoffView(ended);
}

/** A person cancels a handoff (the agent no longer needs it, or they won't do it): the run resumes as failed. */
export async function cancelHandoff(deps: HandoffDeps, actorId: string, orgId: string, handoffId: string) {
  const current = await loadHandoff(deps.db, orgId, handoffId);
  const access = await requireBrowserAccess(deps.db, actorId, orgId, current.agentId, current, current.screen);
  // Only the person in control, the one it was asked of, the agent's owner or an admin.
  const mayCancel =
    access.admin ||
    access.owner === actorId ||
    current.requestedForUserId === actorId ||
    (current.status === "active" && current.controllerUserId === actorId);
  if (!mayCancel) throw new ForbiddenError("Only the person in control or the agent's owner can cancel this");
  const [row] = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(browserHandoffs)
      .set({ status: "cancelled", resolvedAt: new Date() })
      .where(and(eq(browserHandoffs.id, handoffId), inArray(browserHandoffs.status, OPEN)))
      .returning();
    if (rows[0]) await syncCard(tx, rows[0]);
    return rows;
  });
  if (!row) throw handoffOver();
  await settle(deps, row);
  return handoffView(row);
}

/**
 * The agent withdraws its own asked help (`withdraw_request`) while nobody took control: the card says it no
 * longer needs it, the people asked stop waiting. A run still waiting on it resumes; the run withdrawing it
 * (`byRunId`), or one that stopped waiting on it and ended, is told nothing more (no late notice, no new run). Null: not open anymore, or a person is in control.
 */
export async function withdrawHandoff(deps: HandoffDeps, handoffId: string, byRunId: string, reason: string | null) {
  const [row] = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(browserHandoffs)
      .set({ status: "withdrawn", note: reason, resolvedAt: new Date() })
      .where(
        and(
          eq(browserHandoffs.id, handoffId),
          eq(browserHandoffs.kind, "ask"),
          sql`(${browserHandoffs.status} = 'pending' or (${browserHandoffs.status} = 'active' and ${browserHandoffs.controllerUserId} is null))`,
        ),
      )
      .returning();
    if (rows[0]) await syncCard(tx, rows[0]);
    return rows;
  });
  if (!row) return null;
  if (row.runId !== byRunId) await resumeWaitingRun(deps, row, endedResult(row), undefined, true).catch(() => {});
  await afterChange(deps, row).catch(() => {});
  return row;
}

/**
 * A person watching takes over one of the agent's screens (a desktop: only who
 * may drive its computer). An open handoff of that screen is claimed instead
 * (one person in control at a time); otherwise a `takeover` starts, unless the
 * screen showing the same window has one open (`ConflictError`), and the
 * agent's tools of both wait until it is handed back (`waitIfPersonInControl`).
 * `runId`: the run whose card it was taken from (the agent's, still going): the
 * take over is bound to it at once, so its card keeps a place in that
 * conversation. A run that already ended binds nothing (the next run that
 * needs the screen waits on it).
 */
export async function startTakeover(
  deps: HandoffDeps,
  actorId: string,
  orgId: string,
  agentId: string,
  runId?: string | null,
  screen: ScreenKind = "browser",
) {
  await requireBrowserControl(deps.db, actorId, orgId, agentId, undefined, screen);
  await requireAgentBrowserSwitch(deps.db, orgId, agentId, screen);
  await SCREENS[screen].mayControl?.(deps.db, actorId, orgId, agentId);
  let boundRun: string | null = null;
  if (runId) {
    const [run] = await deps.db
      .select({ agentId: agentRuns.agentId, status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
    if (!run || run.agentId !== agentId) throw new ValidationError("That run isn't this agent's");
    if (LIVE_RUN.includes(run.status)) boundRun = runId;
  }
  const open = await openHandoffOf(deps.db, orgId, agentId, screen);
  if (open) return claimHandoff(deps, actorId, orgId, open.id);
  const machineId = await browserMachineOf(deps.db, orgId, agentId, screen);
  if (!machineId) throw new ValidationError("This agent has no computer");
  const now = Date.now();
  let row: BrowserHandoffRow | undefined;
  try {
    row = await deps.db.transaction(async (tx) => {
      await claimScreens(tx, orgId, agentId, screen);
      const [created] = await tx
        .insert(browserHandoffs)
        .values({
          orgId,
          agentId,
          runId: boundRun,
          machineId,
          screen,
          kind: "takeover",
          status: "active",
          controllerUserId: actorId,
          expiresAt: new Date(now + CONTROL_GRACE_MS),
        })
        .returning();
      return created;
    });
  } catch (error) {
    // Opened meanwhile (another person, or the agent asked): that one is claimed instead, or it says who has it.
    if (!isUniqueViolation(error)) throw error;
    const raced = await openHandoffOf(deps.db, orgId, agentId, screen);
    if (!raced) throw new ConflictError("Someone else just took control");
    return claimHandoff(deps, actorId, orgId, raced.id);
  }
  if (!row) throw new Error("takeover not created");
  noteControl(deps, row);
  await afterChange(deps, row);
  await noteDesktopTaken(deps, row);
  return handoffView(row);
}

/**
 * Before an agent acts on one of its screens: a person in control of it (or of
 * the screen showing the same window), or asked to take it, makes the call wait (the run pauses on that handoff and resumes when
 * it ends); another run of the agent is refused while the run the handoff
 * belongs to still goes on. A handoff whose run ended (done, failed,
 * canceled) while it stayed open (a person kept control, or the run read a
 * message instead of waiting for the help it asked, `waits.ts`) is this
 * run's to wait on: it moves here (a take over's card with it). Null: go
 * on. For the browser tools (`tools.ts`).
 */
export async function waitIfPersonInControl(
  db: Database,
  ctx: { orgId: string; agentId: string; runId: string },
  pubsub?: PubSub,
  screen: ScreenKind = "browser",
): Promise<ToolOutput | null> {
  const open = await openHandoffOn(db, ctx.orgId, ctx.agentId, screen);
  if (!open) return null;
  const busy = `A person has control of your ${SCREENS[open.screen].what}, or has been asked to take it.`;
  if (open.runId !== ctx.runId) {
    const from = open.runId;
    if (from && (await runIsLive(db, ctx.orgId, from))) {
      return { content: `${busy} Try again later, or say so in your reply.`, isError: true };
    }
    const [bound] = await db
      .update(browserHandoffs)
      .set({ runId: ctx.runId })
      .where(
        and(
          eq(browserHandoffs.id, open.id),
          inArray(browserHandoffs.status, OPEN),
          from ? eq(browserHandoffs.runId, from) : isNull(browserHandoffs.runId),
        ),
      )
      .returning();
    if (!bound) return { content: `${busy} Try again later.`, isError: true };
    // The card follows the run that waits now (and leaves the one it was on).
    await afterChange({ db, pubsub }, bound, from).catch(() => {});
  }
  return {
    content: `${busy} End your turn; you'll be woken when it's over.`,
    data: { pause: { kind: "input", id: open.id }, handoffId: open.id },
  };
}

async function runIsLive(db: Executor, orgId: string, runId: string) {
  const [run] = await db
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  return Boolean(run && LIVE_RUN.includes(run.status));
}

/**
 * After a person had control of the agent's browser, the page changed under
 * it: its browser tools other than `browser_read` refuse until it reads the
 * page again (`markPageRead`), saying who had it, for how long, the pages and
 * their note. Null: go on.
 */
export async function requirePageRead(
  db: Database,
  ctx: { orgId: string; agentId: string },
  screen: ScreenKind = "browser",
): Promise<ToolOutput | null> {
  const [changed] = await db
    .select()
    .from(browserHandoffs)
    .where(
      and(
        eq(browserHandoffs.orgId, ctx.orgId),
        eq(browserHandoffs.agentId, ctx.agentId),
        eq(browserHandoffs.screen, screen),
        isNotNull(browserHandoffs.resolvedAt),
        isNotNull(browserHandoffs.controllerUserId),
        isNull(browserHandoffs.pageReadAt),
      ),
    )
    .orderBy(desc(browserHandoffs.resolvedAt))
    .limit(1);
  if (!changed) return null;
  const { thing, read } = SCREENS[screen];
  // A browser closed meanwhile (its computer restarted) has nothing to read: opening a page counts as seeing it.
  const how = screen === "browser" ? `${read}, or browser_open if your browser closed` : read;
  return {
    content: `Read the ${thing} again first (a person changed it): call ${how}, then act on what it shows.${factsText(
      endedResult(changed),
      await handoffFacts(db, changed),
      screen,
    )}`,
    isError: true,
  };
}

/**
 * A person had the agent's screen and gave it back after `since` (a take over that began and
 * ended within one step of a plan): the page may not be what the plan's next steps expect.
 */
export async function handedBackSince(
  db: Database,
  ctx: { orgId: string; agentId: string },
  since: Date,
  screen: ScreenKind = "browser",
) {
  const [row] = await db
    .select({ id: browserHandoffs.id })
    .from(browserHandoffs)
    .where(
      and(
        eq(browserHandoffs.orgId, ctx.orgId),
        eq(browserHandoffs.agentId, ctx.agentId),
        eq(browserHandoffs.screen, screen),
        isNotNull(browserHandoffs.controllerUserId),
        gt(browserHandoffs.resolvedAt, since),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The agent read its screen: whatever a person changed before is now seen. */
export async function markPageRead(
  db: Database,
  ctx: { orgId: string; agentId: string },
  screen: ScreenKind = "browser",
) {
  const seen = await db
    .update(browserHandoffs)
    .set({ pageReadAt: new Date() })
    .where(
      and(
        eq(browserHandoffs.orgId, ctx.orgId),
        eq(browserHandoffs.agentId, ctx.agentId),
        eq(browserHandoffs.screen, screen),
        isNotNull(browserHandoffs.resolvedAt),
        isNull(browserHandoffs.pageReadAt),
      ),
    )
    .returning({ id: browserHandoffs.id });
  for (const { id } of seen) controlFacts.delete(id);
}

/**
 * The person in control left (their live view dropped and didn't come back
 * within `CONTROL_GRACE_MS`): the handoff ends as expired, and the waiting
 * run resumes. Nothing when someone else took over meanwhile or it ended.
 */
export async function expireControl(deps: HandoffDeps, handoffId: string, userId: string, now = new Date()) {
  const [row] = await deps.db
    .update(browserHandoffs)
    .set({ status: "expired", resolvedAt: now })
    .where(
      and(
        eq(browserHandoffs.id, handoffId),
        eq(browserHandoffs.status, "active"),
        eq(browserHandoffs.controllerUserId, userId),
        // Their presence is kept in the database: back on another server (or still typing there)
        // pushed the deadline, and only a deadline that passed ends it.
        lte(browserHandoffs.expiresAt, now),
      ),
    )
    .returning();
  if (!row) return null;
  await syncCard(deps.db, row).catch(() => {});
  await settle(deps, row);
  return handoffView(row);
}

/**
 * The person in control is still there (watching or typing): their grace
 * moves to `CONTROL_GRACE_MS` from now. Kept in the database so control ends
 * even when the server that saw them go restarts. Written at most every
 * `CONTROL_TOUCH_EVERY_MS`, unless `force` (they just came back: at once, so
 * a server that saw them leave doesn't end it).
 */
export async function touchControl(db: Executor, handoffId: string, userId: string, now = new Date(), force = false) {
  const until = new Date(now.getTime() + CONTROL_GRACE_MS);
  await db
    .update(browserHandoffs)
    .set({ expiresAt: until })
    .where(
      and(
        eq(browserHandoffs.id, handoffId),
        eq(browserHandoffs.status, "active"),
        eq(browserHandoffs.controllerUserId, userId),
        force ? sql`true` : lt(browserHandoffs.expiresAt, new Date(until.getTime() - CONTROL_TOUCH_EVERY_MS)),
      ),
    );
}

/**
 * The person in control left this server: their control ends at `until`
 * unless they come back here or elsewhere (`touchControl` pushes it again).
 * `extend: false`: never later than it ends already (their page never showed).
 */
export async function setControlDeadline(db: Executor, handoffId: string, userId: string, until: Date, extend = true) {
  await db
    .update(browserHandoffs)
    .set({
      expiresAt: extend ? until : sql`least(${browserHandoffs.expiresAt}, ${until.toISOString()}::timestamptz)`,
    })
    .where(
      and(
        eq(browserHandoffs.id, handoffId),
        eq(browserHandoffs.status, "active"),
        eq(browserHandoffs.controllerUserId, userId),
      ),
    );
}

/**
 * Ends handoffs past their deadline (the agent's wait while pending, the
 * person's inactivity while active) and resumes their runs (worker, every
 * minute). Then resumes runs still waiting on a handoff that ended (a resume
 * that failed earlier): resuming is idempotent, so nothing is lost.
 */
export async function expireBrowserHandoffs(deps: HandoffDeps, now = new Date()) {
  const expired = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(browserHandoffs)
      .set({ status: "expired", resolvedAt: now })
      .where(and(inArray(browserHandoffs.status, OPEN), lt(browserHandoffs.expiresAt, now)))
      .returning();
    for (const row of rows) await syncCard(tx, row);
    return rows;
  });
  for (const row of expired) await settle(deps, row);
  const stranded = await deps.db
    .select({ handoff: browserHandoffs })
    .from(browserHandoffs)
    .innerJoin(agentRuns, eq(agentRuns.id, browserHandoffs.runId))
    .where(
      and(
        isNotNull(browserHandoffs.resolvedAt),
        gt(browserHandoffs.resolvedAt, new Date(now.getTime() - 24 * 60 * 60_000)),
        inArray(agentRuns.status, ["waiting_input", "waiting_approval"]),
        // Only a run waiting on this one: a run that stopped waiting on it (`detachWaits`) got its notice when it
        // ended, or needs none (it restarted the browser itself), and must not hear it during a later wait.
        sql`${agentRuns.transcript} -> 'pending' -> 'calls' @> jsonb_build_array(jsonb_build_object('waitId', ${browserHandoffs.id}::text))`,
      ),
    )
    .limit(50);
  for (const { handoff } of stranded) {
    if (OPEN.includes(handoff.status)) continue;
    await resumeWaitingRun(deps, handoff, endedResult(handoff)).catch(() => {});
  }
  return expired.length;
}

/**
 * An hour after an agent asked (job `HANDOFF_REMIND_JOB`): while nobody answered, gave it back or took control,
 * and it hasn't expired, the people asked hear it once more.
 */
export async function remindBrowserHandoff(deps: HandoffDeps, orgId: string, handoffId: string, now = new Date()) {
  const [row] = await deps.db
    .select()
    .from(browserHandoffs)
    .where(and(eq(browserHandoffs.id, handoffId), eq(browserHandoffs.orgId, orgId)));
  if (row?.status !== "pending" || row.expiresAt <= now) return 0;
  return remindBrowserHandoffNotifications(deps, orgId, handoffId);
}

/**
 * "Parar" on the live view or the computer page: the agent's browser closes
 * now (its logins stay in its profile). Whoever may watch it may stop it; the
 * agent's next browser call opens a fresh one. Everyone watching hears it
 * (`browser.stopped` on every replica: their card says it was stopped, by
 * whom). The agent's screen has no stop: it stays on (ADR 0058 §1).
 */
export async function stopAgentBrowser(
  db: Database,
  hub: MachineCaller | undefined,
  actorId: string,
  orgId: string,
  agentId: string,
  pubsub?: PubSub,
) {
  await requireBrowserAccess(db, actorId, orgId, agentId);
  if (!hub) throw new ValidationError("Connected computers are not available on this server");
  const machineId = await browserMachineOf(db, orgId, agentId, "browser");
  if (!machineId) throw new ValidationError("This agent has no computer");
  const agent = await getAgentCached(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  const scope = { id: agentId, handle: agent.handle, ...(agent.name ? { name: agent.name } : {}) };
  await hub.call<"browser.stop">(machineId, { op: "browser.stop", agent: scope }, { timeoutMs: 30_000 });
  await pubsub
    ?.publish(BROWSER_HANDOFF_TOPIC, {
      type: "browser.stopped",
      orgId,
      agentId,
      screen: "browser",
      byUserId: actorId,
      at: new Date().toISOString(),
    })
    .catch(() => {});
}

/** What a run waiting on a person's turn in the browser reads when the agent restarted its browser meanwhile. */
const RESTARTED_TEXT =
  "Your browser was restarted (browser_close), so the person's turn in it ended. Open a page again (browser_open) and check where things are before going on.";

/**
 * The agent restarts its browser (`browser_close`, a person asked) while a person has it or was asked to take
 * it: that turn ends (cancelled), with nothing to read first (the page doesn't survive the restart), a run
 * waiting on it is told why, and the conversation hears whose control ended. Only from the run the turn is
 * bound to, or a run of the person whose turn it is: anyone else's run waits or is refused as before
 * (`waitIfPersonInControl`). Null: none was open, or not this run's to end.
 */
export async function endHandoffForRestart(deps: HandoffDeps, ctx: { orgId: string; agentId: string; runId: string }) {
  const open = await openHandoffOf(deps.db, ctx.orgId, ctx.agentId, "browser");
  if (!open) return null;
  if (open.runId !== ctx.runId) {
    const person = open.status === "active" ? open.controllerUserId : open.requestedForUserId;
    if (!person || (await humanBehindRun({ db: deps.db }, ctx.orgId, ctx.runId)) !== person) return null;
  }
  const now = new Date();
  const [row] = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(browserHandoffs)
      .set({ status: "cancelled", resolvedAt: now, pageReadAt: now })
      .where(and(eq(browserHandoffs.id, open.id), inArray(browserHandoffs.status, OPEN)))
      .returning();
    if (rows[0]) await syncCard(tx, rows[0]);
    return rows;
  });
  if (!row) return null;
  // The run restarting it knows: only another run waiting on that turn is told.
  if (row.runId && row.runId !== ctx.runId) {
    await resumeRunWithResult(deps.db, {
      runId: row.runId,
      waitId: row.id,
      result: { content: RESTARTED_TEXT },
      pubsub: deps.pubsub,
    }).catch(() => {});
  }
  await afterChange(deps, row).catch(() => {});
  const controller = open.status === "active" ? open.controllerUserId : null;
  if (controller) await postRestarted(deps, row, controller, ctx.runId).catch(() => {});
  return row;
}

/** "Ada restarted its browser. Marta's control ended.", where the turn was (else the restarting run's conversation). */
async function postRestarted(deps: HandoffDeps, row: BrowserHandoffRow, controller: string, runId: string) {
  const where = (await handoffPlace(deps.db, row)) ?? (await runPlace(deps.db, row.orgId, runId));
  const agent = await getAgentCached(deps.db, row.orgId, row.agentId);
  const [person] = await deps.db.select({ name: users.name }).from(users).where(eq(users.id, controller));
  if (!where || !agent || !person) return;
  const params = { agent: agent.name, person: person.name };
  const message = await insertMessage(deps.db, {
    orgId: row.orgId,
    channelId: where.channelId,
    threadId: where.threadId,
    author: { type: "agent", agentId: row.agentId, runId: null, hop: 0, stretchId: null },
    body: `${params.agent} restarted its browser. ${params.person}'s control ended.`,
    meta: bodyCode("browser_restarted", params),
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
}

/** A web address from what a person typed in the live view: http(s) only, a bare host gets https://. Null otherwise. */
export function webAddress(typed: string): string | null {
  const text = typed.trim();
  if (!text || text.length > 2048) return null;
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The address bar's arrows and reload, as the browser's own commands, and `normalSize`: the page at the window's own
 * size again after the agent emulated a phone or another size (`agentes:viewport`, protocol 52; the live view offers
 * it only on frames that say `emulated`, which no older runner sends).
 */
export const PAGE_MOVES = ["back", "forward", "reload", "normalSize"] as const;
export type PageMove = (typeof PAGE_MOVES)[number];

/** The browser's command for what the person typed in the address bar (400 when it's no web address), or an arrow. */
export function pageCommand(to: string | { go: PageMove }): { command: string; args: string[] } {
  if (typeof to !== "string") {
    return to.go === "normalSize" ? { command: "agentes:viewport", args: ["desktop"] } : { command: to.go, args: [] };
  }
  const url = webAddress(to);
  if (!url) throw new ValidationError("Type a web address (https://…)", "browser.bad_address");
  return { command: "open", args: [url] };
}

/** How long a person's open may take on the computer (a slow page, or Chrome starting). */
const OPEN_PAGE_SECONDS = 60;

/** Whether the agent itself may use one of its screens (`browser:use`, `desktop:use`): people see and drive it only then. */
export async function agentUsesScreen(db: Executor, orgId: string, agentId: string, screen: ScreenKind = "browser") {
  return isAllowed(toolAccess(await grantedScopeKeys(db, orgId, agentId), SCREENS[screen].tool));
}

/** People drive an agent's screen only while the agent itself may use it (`browser:use`, ADR 0040 §3). */
async function requireAgentBrowserSwitch(db: Database, orgId: string, agentId: string, screen: ScreenKind = "browser") {
  if (!(await agentUsesScreen(db, orgId, agentId, screen))) {
    throw new ForbiddenError(`This agent can't use its ${SCREENS[screen].what}`);
  }
}

/**
 * The person in control opens a site in the agent's browser (the live view's
 * address bar): only them, only web pages, only while the agent may use its
 * browser there (403 otherwise), and only the agent's sites when it has a list
 * (the runner checks: `not_allowed` → 403). A closed browser opens
 * (the runner starts it), and every live view of the agent starts its stream
 * again, so the page shows at once.
 */
export async function openPageInControl(
  deps: HandoffDeps,
  hub: MachineCaller | undefined,
  actorId: string,
  orgId: string,
  agentId: string,
  to: string | { go: PageMove },
) {
  const open = await openHandoffOf(deps.db, orgId, agentId);
  await requireBrowserControl(deps.db, actorId, orgId, agentId, open);
  if (open?.status !== "active" || open.controllerUserId !== actorId) {
    throw new ConflictError("Take control of the browser first", "browser.not_in_control");
  }
  const { command, args } = pageCommand(to);
  if (!hub) throw new ValidationError("Connected computers are not available on this server");
  // Its computer's switch too, as for its browser tools: the runner checks only the computer's.
  await requireAgentBrowserSwitch(deps.db, orgId, agentId);
  if (!(await agentBrowserStatus(deps.db, hub, orgId, agentId, open.machineId)).available) {
    throw new ForbiddenError("This agent can't use its browser");
  }
  const agent = await getAgentCached(deps.db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  const desktop = await browserOnDesktop(deps.db, orgId, agentId, open.machineId);
  let reply: MachineReplies["browser.act"];
  try {
    reply = await hub.call<"browser.act">(
      open.machineId,
      {
        op: "browser.act",
        agent: { id: agentId, handle: agent.handle, ...(agent.name ? { name: agent.name } : {}) },
        command,
        args,
        timeoutSeconds: OPEN_PAGE_SECONDS,
        ...(agent.browserAllowedDomains ? { allowedDomains: agent.browserAllowedDomains } : {}),
        link: agentBrowserLink(orgId, agentId),
        ...(desktop ? { desktop: true } : {}),
      },
      { timeoutMs: (OPEN_PAGE_SECONDS + 30) * 1000 },
    );
  } catch (error) {
    if (error instanceof MachineRequestError && error.code === "not_allowed") {
      throw new ForbiddenError(error.message, "browser.not_allowed");
    }
    throw error;
  }
  // Even a page that failed to load leaves the browser open on Chrome's error page: the views show it.
  await deps.pubsub?.publish(BROWSER_HANDOFF_TOPIC, { type: "browser.opened", orgId, agentId }).catch(() => {});
  if (!reply.success) throw new ValidationError(reply.error || "The page didn't open", "browser.open_failed");
}
