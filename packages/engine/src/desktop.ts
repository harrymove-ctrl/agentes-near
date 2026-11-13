import {
  DESKTOP_PROTOCOL,
  DESKTOP_SWITCH_PROTOCOL,
  type DesktopMode,
  type PubSub,
  type RateLimiter,
  STREAM_CLOSE,
  STREAM_LIMITS,
  type StreamRequest,
} from "@agenteschat/adapters";
import { and, type Database, eq, gt, inArray, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import {
  agentUsesScreen,
  BROWSER_HANDOFF_TOPIC,
  type BrowserHandoffView,
  browserOnDesktop,
  CONTROL_GRACE_MS,
  handoffView,
  noteComputerTaken,
  openHandoffOn,
  requireBrowserAccess,
  screenAccess,
  setControlDeadline,
  touchControl,
} from "./browser/handoff";
import { HANDOFF_KEEPALIVE_MS } from "./browser/live";
import { TtlCache } from "./cache";
import { auditPhoneStream, authorizePhoneStream, recheckPhoneStream } from "./devices";
import { ForbiddenError, NotFoundError } from "./errors";
import type { MachineCaller, MachineHub } from "./machine-hub";
import {
  computerDriving,
  type DriveRefusal,
  getMachine,
  machineOnline,
  mayDriveComputer,
  requireComputerDriver,
} from "./machines";
import { closedRefusal, OrgDeletingError, orgStanding, standingRefusal } from "./standing";
import type { Stream, StreamBroker, StreamInput, StreamTarget } from "./streams";

const { agents, browserHandoffs, sessions } = schema;

const refused = (code: number, reason: string) => ({ refused: code, reason });

/**
 * Who may watch an agent's desktop (ADR 0058 §4): the browser's rule on the `desktop` screen, and whoever
 * may drive its computer (`requireBrowserAccess`).
 */
export const requireDesktopAccess = (db: Database, userId: string, orgId: string, agentId: string) =>
  requireBrowserAccess(db, userId, orgId, agentId, undefined, "desktop");

/**
 * The computer a person's stream of an agent goes to, or why it can't: the
 * agent's own computer, with its socket on this server (streams don't cross
 * servers), on protocol 18 or later, its switch for that kind on and the
 * runner able to serve it; for a desktop, an agent that may use one.
 */
export async function desktopTarget(
  db: Database,
  hub: Pick<MachineHub, "isLocal">,
  orgId: string,
  agentId: string,
  kind: Exclude<StreamRequest["kind"], "phone">,
): Promise<StreamTarget> {
  const [agent] = await db
    .select({ handle: agents.handle, name: agents.name, machineId: agents.machineId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) return refused(STREAM_CLOSE.notFound, "no_agent");
  if (kind === "desktop" && !(await agentUsesScreen(db, orgId, agentId, "desktop"))) {
    return refused(STREAM_CLOSE.notFound, "no_desktop");
  }
  const machine = agent.machineId ? await getMachine(db, orgId, agent.machineId) : null;
  if (!machine) return refused(STREAM_CLOSE.notFound, "no_computer");
  if (!hub.isLocal(machine.id)) {
    return refused(STREAM_CLOSE.unreachable, machineOnline(machine) ? "other_server" : "offline");
  }
  if (machine.protocol < DESKTOP_PROTOCOL) return refused(STREAM_CLOSE.refused, "runner_outdated");
  if (!machine.access?.tools[kind]) return refused(STREAM_CLOSE.refused, "not_allowed");
  if (!machine.executors?.[kind]?.available) return refused(STREAM_CLOSE.refused, `${kind}_unavailable`);
  return {
    machineId: machine.id,
    agent: { id: agentId, handle: agent.handle, name: agent.name },
    ...(kind === "desktop" && machine.protocol >= DESKTOP_SWITCH_PROTOCOL ? { switches: true } : {}),
  };
}

/**
 * Whether the person may have this stream now, as `authorizeStream` decides and the broker checks again
 * every 30 s while it is open: watching follows the desktop's rule, control and the terminal its computer's
 * driver. While someone controls the desktop, or the browser showing the same window, nobody else sees it;
 * control is only theirs, on the desktop's own handoff (`control`: its id). Nobody has one in a closed
 * workspace (suspended, or being deleted: `closedRefusal`).
 */
async function streamAccess(
  db: Database,
  input: Pick<StreamInput, "userId" | "orgId" | "agentId" | "request">,
): Promise<{ refused: number; reason: string } | { driven: string | null; control: string | null }> {
  const { userId, orgId, agentId, request } = input;
  const closed = closedRefusal(await orgStanding(db, orgId));
  if (closed) return refused(STREAM_CLOSE.forbidden, closed instanceof OrgDeletingError ? "deleting" : "suspended");
  let driven: string | null = null;
  try {
    if (request.kind === "terminal" || request.mode === "control") {
      driven = (await requireComputerDriver(db, userId, orgId, agentId)).id;
    } else await requireDesktopAccess(db, userId, orgId, agentId);
  } catch (error) {
    if (error instanceof ForbiddenError) return refused(STREAM_CLOSE.forbidden, "forbidden");
    if (error instanceof NotFoundError) return refused(STREAM_CLOSE.notFound, "not_found");
    throw error;
  }
  if (request.kind !== "desktop") return { driven, control: null };
  const open = await openHandoffOn(db, orgId, agentId, "desktop");
  const controller = open?.status === "active" ? open.controllerUserId : null;
  if (controller && controller !== userId) return refused(STREAM_CLOSE.hidden, "someone_in_control");
  if (request.mode === "watch") return { driven, control: null };
  // The browser's handoff too, its window on this screen: who may drive the computer (checked above) helps there.
  if (!open || controller !== userId) return refused(STREAM_CLOSE.controlEnded, "not_in_control");
  return { driven, control: open.id };
}

export interface StreamPolicyDeps {
  db: Database;
  hub: Pick<MachineHub, "isLocal">;
  rateLimiter?: RateLimiter;
  pubsub?: PubSub;
}

/**
 * Whether a person's stream may open, and where (the broker's `authorize`):
 * at most `opensPerMinute` opens a minute per person, `streamAccess`, then the
 * computer (`desktopTarget`). A control stream opening is its holder back: the
 * grace of their control starts again. A held agent's desktop (or one in a
 * workspace on hold) may be watched while it runs; starting it is new work. A phone's screen goes by its own rule
 * (`authorizePhoneStream`).
 */
export async function authorizeStream(deps: StreamPolicyDeps, input: StreamInput): Promise<StreamTarget> {
  if (input.request.kind === "phone") return authorizePhoneStream(deps, input);
  const rate = await deps.rateLimiter?.consume(`stream-open:${input.userId}`, {
    limit: STREAM_LIMITS.opensPerMinute,
    windowMs: 60_000,
  });
  if (rate && !rate.allowed) return refused(STREAM_CLOSE.tooMany, "rate_limited");
  const access = await streamAccess(deps.db, input);
  if ("refused" in access) return access;
  const target = await desktopTarget(deps.db, deps.hub, input.orgId, input.agentId, input.request.kind);
  if (!("machineId" in target)) return target;
  // The agent moved to another computer meanwhile: who drives that one wasn't checked.
  if (access.driven && target.machineId !== access.driven) return refused(STREAM_CLOSE.forbidden, "forbidden");
  if (access.control) await touchControl(deps.db, access.control, input.userId, new Date(), true).catch(() => {});
  // A shell as the agent's user reaches what its screen does (the owner's sign-in): its owner hears it the same way.
  if (input.request.kind === "terminal") {
    await noteComputerTaken(deps, { orgId: input.orgId, agentId: input.agentId, actorId: input.userId }).catch(
      () => {},
    );
  }
  if (input.request.kind === "desktop" && (await standingRefusal(deps.db, input.orgId, input.agentId))) {
    return { ...target, held: true };
  }
  return target;
}

/**
 * The broker's `reauthorize`, as its handoff changed: whether a desktop stream may go on in `mode` on the same
 * sockets (ADR 0058 §17), as `authorizeStream` decides for one that opens in it, on the computer it runs on. Control
 * is new work, not for a held agent, and its holder is back: the grace of their control starts again.
 */
export async function reauthorizeStream(db: Database, stream: Stream, mode: DesktopMode) {
  const access = await streamAccess(db, { ...stream, request: { kind: "desktop", mode } });
  if ("refused" in access) return access;
  if (access.driven && access.driven !== stream.machineId) return refused(STREAM_CLOSE.forbidden, "forbidden");
  if (mode === "control") {
    if (await standingRefusal(db, stream.orgId, stream.agentId)) return refused(STREAM_CLOSE.refused, "held");
    if (access.control) await touchControl(db, access.control, stream.userId, new Date(), true).catch(() => {});
  }
  return null;
}

/**
 * The broker's `recheck`: the stream's close when its person lost it (`streamAccess`) or signed out (the
 * session it was opened with is gone or expired, read from the database); a control stream still open keeps
 * its holder's control alive (`touchControl`).
 */
export async function recheckStream(db: Database, stream: Stream) {
  if (stream.sessionToken) {
    const [alive] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.token, stream.sessionToken), gt(sessions.expiresAt, new Date())));
    if (!alive) return refused(STREAM_CLOSE.forbidden, "signed_out");
  }
  if (stream.request.kind === "phone") return recheckPhoneStream(db, stream);
  const access = await streamAccess(db, stream);
  if ("refused" in access) return access;
  if (access.control) await touchControl(db, access.control, stream.userId).catch(() => {});
  return null;
}

/**
 * The broker's `onClosed`: the audit, and a control stream's holder keeps control `CONTROL_GRACE_MS` from
 * now to come back (another stream of theirs keeps it longer).
 */
export async function streamClosed(db: Database, s: Stream) {
  if (s.request.kind === "desktop" && s.request.mode === "control") {
    const open = await openHandoffOn(db, s.orgId, s.agentId, "desktop");
    if (open?.status === "active" && open.controllerUserId === s.userId) {
      await setControlDeadline(db, open.id, s.userId, new Date(Date.now() + CONTROL_GRACE_MS)).catch(() => {});
    }
  }
  await auditStream(db, s);
}

/** A stream that ran, in the org's audit log (ADR 0058 §12): who, which agent and computer, how long, how many bytes. */
export async function auditStream(db: Database, s: Stream) {
  if (s.request.kind === "phone") return auditPhoneStream(db, s);
  const action =
    s.request.kind === "terminal"
      ? "terminal.session"
      : s.request.mode === "control"
        ? "desktop.controlled"
        : "desktop.watched";
  await recordAudit(db, {
    orgId: s.orgId,
    actor: { type: "person", id: s.userId },
    action,
    target: { type: "agent", id: s.agentId },
    details: {
      machineId: s.machineId,
      seconds: Math.round((Date.now() - (s.readyAt ?? s.openedAt)) / 1000),
      bytesIn: s.bytesIn,
      bytesOut: s.bytesOut,
      // A browser card's view of this screen (ADR 0058 §7): watch only.
      ...(s.preview ? { preview: true } : {}),
    },
  });
}

// ── The desktop's REST (`routes/app/desktop.ts`) ──────────────────────────────

export interface DesktopDeps {
  db: Database;
  hub?: MachineCaller;
  streams?: Pick<StreamBroker, "count">;
}

/** The REST reaches a computer through whichever server holds its socket (`hub.call`), unlike a stream. */
const ANYWHERE = { isLocal: () => true };
const NO_SCREEN = ["no_agent", "no_desktop", "no_computer", "not_allowed"];

/**
 * An agent's desktop as one person sees it: whether it can be shown and runs, who controls it, what they may
 * do. Not running is not "off": opening a stream starts it, and then it stays on (ADR 0058 §1).
 */
export interface DesktopStatus {
  /** Whether it can be shown now, else why (a stream's refusal reason: `not_allowed`, `offline`…). */
  available: boolean;
  reason: string | null;
  /** What the computer says it lacks (what to install). */
  detail: string | null;
  running: boolean;
  startedAt: string | null;
  /** Who is in control (of the desktop, or of the browser showing the same window), and that handoff. */
  controllerUserId: string | null;
  handoff: BrowserHandoffView | null;
  /** People watching it through this server. */
  viewers: number;
  /** This person may take control. */
  canControl: boolean;
  /** Why not (`driveRefusal`), so the apps can say it; null when they may. */
  controlRefusal: DriveRefusal | null;
  /** The agent is held, or its workspace on hold: people may watch, nobody takes control. */
  held: boolean;
  /** The agent's browser runs on this desktop (ADR 0058 §7): its browser card shows this screen. */
  browserOnDesktop: boolean;
}

/**
 * `GET …/agents/{agentId}/desktop`: for whoever may watch it. Who may see the agent's browser but whose roles don't
 * give them its whole computer gets a screen that can't be shown (`browser_only`), so the apps show the browser. The
 * apps ask it while a view of the computer is open: that keeps the workspace's own computer wanted, and wakes it from
 * standby (ADR 0161).
 */
export async function desktopStatus(
  deps: DesktopDeps,
  userId: string,
  orgId: string,
  agentId: string,
): Promise<DesktopStatus> {
  const { db } = deps;
  if ((await screenAccess(db, userId, orgId, agentId, undefined, "desktop")).refusal === "level") {
    await requireBrowserAccess(db, userId, orgId, agentId);
    const served = await desktopTarget(db, ANYWHERE, orgId, agentId, "desktop");
    if ("machineId" in served) void deps.hub?.wake?.(served.machineId, "view").catch(() => {});
    // An agent with no screen to show isn't one whose browser alone they get.
    const none = "refused" in served && NO_SCREEN.includes(served.reason) ? served.reason : null;
    return {
      available: false,
      reason: none ?? "browser_only",
      detail: null,
      running: false,
      startedAt: null,
      controllerUserId: null,
      handoff: null,
      viewers: 0,
      canControl: false,
      controlRefusal: none ? null : "role",
      held: await standingRefusal(db, orgId, agentId).then((refusal) => refusal !== null),
      browserOnDesktop: false,
    };
  }
  await requireDesktopAccess(db, userId, orgId, agentId);
  const [served, open, controlRefusal, held, onDesk] = await Promise.all([
    desktopTarget(db, ANYWHERE, orgId, agentId, "desktop"),
    openHandoffOn(db, orgId, agentId, "desktop"),
    computerDriving(db, userId, orgId, agentId).then(
      (d) => d.refusal,
      (): DriveRefusal => "not_allowed",
    ),
    standingRefusal(db, orgId, agentId).then((refusal) => refusal !== null),
    browserOnDesktop(db, orgId, agentId),
  ]);
  if ("machineId" in served) void deps.hub?.wake?.(served.machineId, "view").catch(() => {});
  const online = "machineId" in served && deps.hub ? (await deps.hub.status(served.machineId))?.online === true : false;
  const desktop: StreamTarget = "refused" in served || online ? served : refused(STREAM_CLOSE.unreachable, "offline");
  let running = false;
  let startedAt: string | null = null;
  if ("machineId" in desktop && deps.hub) {
    try {
      const reply = await deps.hub.call<"desktop.session.status">(
        desktop.machineId,
        { op: "desktop.session.status", agent: desktop.agent },
        { timeoutMs: 5_000 },
      );
      running = reply.running;
      startedAt = reply.startedAt ?? null;
    } catch {
      // Not known now: a stream finds out (and starts it).
    }
  }
  const reasonOf = (t: StreamTarget) => ("refused" in t ? t.reason : null);
  let detail: string | null = null;
  if (reasonOf(desktop) === "desktop_unavailable") {
    const [agent] = await db
      .select({ machineId: agents.machineId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
    const machine = agent?.machineId ? await getMachine(db, orgId, agent.machineId) : null;
    detail = machine?.executors?.desktop?.reason?.slice(0, 500) ?? null;
  }
  return {
    available: "machineId" in desktop,
    reason: reasonOf(desktop),
    detail,
    running,
    startedAt,
    controllerUserId: open?.status === "active" ? open.controllerUserId : null,
    handoff: open ? handoffView(open) : null,
    viewers: deps.streams?.count(agentId, "desktop") ?? 0,
    canControl: controlRefusal === null,
    controlRefusal,
    held,
    browserOnDesktop: "machineId" in desktop && onDesk,
  };
}

/** How long one capture answers everyone asking: however many ask, the computer takes at most one in this time. */
const PICTURE_TTL_MS = 4_000;
/** A picture counts as watching in the audit log, once per person and agent in this time. */
const PICTURE_AUDIT_MS = 3600_000;

export interface DesktopPicture {
  /** A JPEG, base64. */
  data: string;
  width: number;
  height: number;
  capturedAt: string;
}

export interface DesktopPictureView {
  picture: DesktopPicture | null;
  /** Why none: `stopped` (its screen isn't running), `hidden` (someone else is in control), `unavailable`. */
  reason: "stopped" | "hidden" | "unavailable" | null;
}

// ponytail: the agent's screen only, through `desktop.capture` (desktop use); a computer without screens, or a person
// with its browser alone, shows the live view's button instead. `browser.capture` boxes every element, for a judge.
// Few: a picture is hundreds of KB, and an expired one stays in memory until a newer one pushes it out.
const pictures = new TtlCache<DesktopPictureView>(PICTURE_TTL_MS, 64);
const capturing = new Map<string, Promise<DesktopPictureView>>();
const pictureAudits = new TtlCache<true>(PICTURE_AUDIT_MS);

/**
 * `GET …/agents/{agentId}/desktop/picture`: a recent picture of an agent's screen, for whoever may watch it now (a
 * watching stream's own check, so someone else in control hides it too). It never starts a screen: one that isn't
 * running answers `stopped`, and a capture marks a running one used, as a viewer keeps it from being parked.
 */
export async function desktopPicture(
  deps: DesktopDeps,
  userId: string,
  orgId: string,
  agentId: string,
): Promise<DesktopPictureView> {
  const { db, hub } = deps;
  const access = await streamAccess(db, { userId, orgId, agentId, request: { kind: "desktop", mode: "watch" } });
  if ("refused" in access) {
    if (access.reason === "someone_in_control") return { picture: null, reason: "hidden" };
    if (access.refused === STREAM_CLOSE.notFound) throw new NotFoundError("Agent not found");
    throw new ForbiddenError("You may not watch this agent's computer");
  }
  const served = await desktopTarget(db, ANYWHERE, orgId, agentId, "desktop");
  if ("refused" in served || !hub) return { picture: null, reason: "unavailable" };
  const key = `${orgId}:${agentId}`;
  let view = pictures.get(key);
  if (!view) {
    // Those asking while a capture runs wait for it: the computer's queue is the agent's own too.
    let capture = capturing.get(key);
    if (!capture) {
      capture = capturePicture(hub, served)
        .then((taken) => {
          pictures.set(key, taken);
          return taken;
        })
        .finally(() => capturing.delete(key));
      capturing.set(key, capture);
    }
    view = await capture;
  }
  if (view.picture && !pictureAudits.get(`${userId}:${agentId}`)) {
    pictureAudits.set(`${userId}:${agentId}`, true);
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "desktop.watched",
      target: { type: "agent", id: agentId },
      details: { machineId: served.machineId, picture: true, seconds: 0 },
    });
  }
  return view;
}

async function capturePicture(
  hub: MachineCaller,
  { machineId, agent }: Extract<StreamTarget, { machineId: string }>,
): Promise<DesktopPictureView> {
  try {
    const status = await hub.call<"desktop.session.status">(
      machineId,
      { op: "desktop.session.status", agent },
      { timeoutMs: 5_000 },
    );
    if (!status.running) return { picture: null, reason: "stopped" };
    const shot = await hub.call<"desktop.capture">(machineId, { op: "desktop.capture", agent }, { timeoutMs: 10_000 });
    const picture = {
      data: shot.data,
      width: shot.width,
      height: shot.height,
      capturedAt: new Date().toISOString(),
    };
    return { picture, reason: null };
  } catch {
    // The computer went away, paused, or doesn't serve desktop use: the apps offer the live screen instead.
    return { picture: null, reason: "unavailable" };
  }
}

// ── Control on this server ────────────────────────────────────────────────────

export interface DesktopControlDeps {
  db: Database;
  pubsub?: PubSub;
  hub: Pick<MachineHub, "call" | "isLocal">;
  streams: Pick<StreamBroker, "closeWhere" | "some" | "switchWhere" | "switches">;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

/**
 * The desktops' side of handoffs on this server (ADR 0058 §5). When control
 * of an agent's desktop, or of the browser showing the same window, changes
 * hands (on any server), the streams here that may no longer show it close:
 * everyone else's while someone is in control (4409), and a control stream
 * whose holder lost control (4410). Their panels open again once it is handed
 * back. Where the viewer and the computer both can (ADR 0058 §17), the holder's
 * own streams change mode in place instead: those watching go on in control
 * when they take it, and theirs in control go on watching when it ends. It also
 * keeps the desktops of open handoffs from idling.
 */
export function createDesktopControl(deps: DesktopControlDeps) {
  /** Last keep-alive per open handoff. */
  const touched = new Map<string, number>();

  async function enforce(orgId: string, agentId: string) {
    const ofAgent = (s: Stream) => s.orgId === orgId && s.agentId === agentId && s.request.kind === "desktop";
    if (!deps.streams.some(ofAgent)) return;
    const open = await openHandoffOn(deps.db, orgId, agentId, "desktop");
    const controller = open?.status === "active" ? open.controllerUserId : null;
    // The browser's holder drives the screen too where they may drive the computer (`streamAccess`).
    const onDesktop =
      controller && (open?.screen === "desktop" || (await mayDriveComputer(deps.db, controller, orgId, agentId)))
        ? controller
        : null;
    deps.streams.closeWhere(
      (s) => ofAgent(s) && controller !== null && s.userId !== controller,
      STREAM_CLOSE.hidden,
      "someone_in_control",
    );
    const mode = (s: Stream) => (s.request.kind === "desktop" ? s.request.mode : null);
    const ended = (s: Stream) => ofAgent(s) && mode(s) === "control" && s.userId !== onDesktop;
    deps.streams.switchWhere(ended, "watch");
    deps.streams.closeWhere((s) => ended(s) && !deps.streams.switches(s), STREAM_CLOSE.controlEnded, "control_ended");
    if (onDesktop) deps.streams.switchWhere((s) => ofAgent(s) && s.userId === onDesktop, "control");
  }

  const off = deps.pubsub?.subscribe(BROWSER_HANDOFF_TOPIC, (event) => {
    if (event.type !== "browser.handoff.changed") return;
    if (typeof event.orgId !== "string" || typeof event.agentId !== "string") return;
    const { orgId, agentId } = event;
    void enforce(orgId, agentId).catch((error) =>
      deps.log?.warn("desktop control change failed", { agentId, error: String(error) }),
    );
  });

  return {
    /**
     * Keeps the desktops of open desktop handoffs running (worker, every
     * minute): a start every `HANDOFF_KEEPALIVE_MS` counts as use (and starts
     * one that stopped, after a reboot), so the runner never parks a desktop
     * a person was asked to work on (it parks only ones untouched for an hour).
     */
    async keepAlive(now = Date.now()) {
      const open = await deps.db
        .select({
          id: browserHandoffs.id,
          agentId: browserHandoffs.agentId,
          machineId: browserHandoffs.machineId,
          handle: agents.handle,
          name: agents.name,
        })
        .from(browserHandoffs)
        .innerJoin(agents, eq(agents.id, browserHandoffs.agentId))
        .where(and(eq(browserHandoffs.screen, "desktop"), inArray(browserHandoffs.status, ["pending", "active"])));
      const ids = new Set(open.map((h) => h.id));
      for (const id of touched.keys()) if (!ids.has(id)) touched.delete(id);
      // Only computers held here (each server keeps its own).
      const due = open.filter(
        (h) => deps.hub.isLocal(h.machineId) && now - (touched.get(h.id) ?? 0) >= HANDOFF_KEEPALIVE_MS,
      );
      for (const h of due) touched.set(h.id, now);
      await Promise.all(
        due.map((h) =>
          deps.hub
            .call(
              h.machineId,
              { op: "desktop.session.start", agent: { id: h.agentId, handle: h.handle, name: h.name } },
              { timeoutMs: 30_000 },
            )
            .catch(() => {}),
        ),
      );
      return due.length;
    },

    /** Stops hearing handoff changes (shutdown, tests). */
    close() {
      off?.();
    },
  };
}

export type DesktopControl = ReturnType<typeof createDesktopControl>;
