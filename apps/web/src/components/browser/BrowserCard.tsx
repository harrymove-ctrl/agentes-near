import type {
  BrowserFrame,
  BrowserHandoff,
  BrowserInputEvent,
  BrowserProfileWait,
  BrowserStep,
  DesktopViewState,
  LiveRun,
  PageTarget,
  ScreenKind,
} from "@agenteschat/client";
import {
  browserFrameDataUrl,
  browserSiteUrl,
  browserSteps,
  controlledBy,
  createTouchInput,
  dragEvent,
  frameMetadata,
  HELD_STALE_MS,
  handoffWantsWords,
  inputProblem,
  isHeldTakeover,
  isOpenHandoff,
  keyboardEvents,
  keyEvents,
  modifiersOf,
  pagePoint,
  pasteEvents,
  pressEvents,
  profileLiveKey,
  releaseEvent,
  rememberHeldPlace,
  runProfile,
  useAgentBrowserHandoff,
  useAgentBrowserSettings,
  useAgentScreenControl,
  useBrowserHandoffMutations,
  useBrowserProfileMutations,
  useBrowserProfiles,
  useBrowserScreen,
  useBrowserStuck,
  useMachines,
  wheelEvent,
} from "@agenteschat/client";
import { formatTime, lowerFirst } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can as canDo } from "@agenteschat/client/lib/permissions";
import { isBlankPage } from "@agenteschat/client/lib/sites";
import {
  agentGradient,
  Button,
  Chip,
  FilterToggle,
  Icon,
  type IconName,
  isApple,
  Locked,
  onScreenNow,
  PixelSpinner,
  SkyStrip,
  shortcut,
  Textarea,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { withAgentFace } from "@/components/AgentAvatar";
import { useDirectory } from "@/hooks/useDirectory";
import { TOUCH, useMatchMedia } from "@/hooks/useMatchMedia";
import { usePageVisible } from "@/hooks/useWindowActive";
import { pastes } from "@/lib/keys";
import { useToast } from "@/lib/toast";
import { useBrowserLive, useConnectionStatus, useStreams } from "@/realtime/context";
import { AgentWho } from "../AgentAvatar";
import { AskActions, HandBackFoot, useAskControl } from "../computer/control";
import { DialogHead, FullButton, FullScreenButton, useDialogHead, useSayFailed } from "../computer/head";
import { useOpenComputer, useOpenedComputer } from "../computer/open";
import { DesktopView } from "../desktop/DesktopView";
import { PASTE_MAX_BYTES, pasteBytes } from "../desktop/paste";
import { useOrg } from "../org-context";
import { colorOf } from "../Sky";
import { useComputerEdition } from "../WorkspaceComputer";
import { AddressBar } from "./AddressBar";
import { Cover } from "./Cover";
import { LivePicture } from "./LivePicture";
import { requestBrowserCard, useBrowserCardRequest } from "./open";
import { SiteIcon, siteName } from "./SiteIcon";
import "./browser.css";

// The computer dialog takes it from here too.
export { Cover } from "./Cover";

const FAIL_REASONS = ["code", "password", "blocked"] as const;
/** The reason goes before it, in the 1000 the server takes. */
const FAIL_NOTE_MAX = 900;
/** The scroll hint goes this long after the wheel's last tick. */
const SCROLL_HINT_IDLE_MS = 1200;
const KEYS = ["Tab", "Enter", "Backspace", "Escape"] as const;
/** The keycaps of the keys popover (symbols; the key names are their labels). */
const KEYCAP: Record<(typeof KEYS)[number], string> = { Tab: "⇥", Enter: "↵", Backspace: "⌫", Escape: "esc" };

const STEP_ICON = {
  browser_do: "bolt",
  browser_open: "globe",
  browser_back: "chevronLeft",
  browser_tabs: "layers",
  browser_read: "document",
  browser_click: "arrowRight",
  browser_fill: "edit",
  browser_select: "list",
  browser_check: "check",
  browser_press: "arrowRight",
  browser_scroll: "chevronDown",
  browser_upload: "upload",
  browser_type_secret: "key",
  browser_make_password: "key",
  browser_wait: "clock",
  browser_screenshot: "image",
  browser_ask_person: "person",
  browser_close: "close",
} satisfies Record<string, IconName>;

type StepTool = keyof typeof STEP_ICON;
const isStepTool = (tool: string): tool is StepTool => Object.hasOwn(STEP_ICON, tool);
export const iconOf = (tool: string): IconName => (isStepTool(tool) ? STEP_ICON[tool] : "globe");

/** The desktop's steps on its trail (`meta.desktop.steps`) with words of their own. */
const DESKTOP_STEPS = [
  "desktop_open_file",
  "desktop_read",
  "desktop_click",
  "desktop_double_click",
  "desktop_right_click",
  "desktop_focus",
  "desktop_fill",
  "desktop_type",
  "desktop_select",
  "desktop_check",
  "desktop_press",
  "desktop_scroll",
  "desktop_drag",
  "desktop_wait",
  "desktop_screenshot",
  "desktop_ask_person",
] as const;
const isDesktopStep = (tool: string): tool is (typeof DESKTOP_STEPS)[number] =>
  (DESKTOP_STEPS as readonly string[]).includes(tool);

/** One line of the log, in the person's words ("Abriu loja.exemplo", "Preencheu um campo"); the desktop's too. */
export function stepText(t: TFunction, s: BrowserStep, screen: ScreenKind = "browser"): string {
  if (screen === "desktop") {
    if (s.tool === "desktop_open")
      return s.detail
        ? t("desktop.watch.step.desktop_open", { detail: s.detail })
        : t("desktop.watch.step.desktop_open_plain");
    return isDesktopStep(s.tool) ? t(`desktop.watch.step.${s.tool}`) : t("desktop.watch.step.other");
  }
  if (s.tool === "browser_open")
    return s.detail
      ? t("browser.watch.step.browser_open", { detail: s.detail })
      : t("browser.watch.step.browser_open_plain");
  return isStepTool(s.tool) ? t(`browser.watch.step.${s.tool}`) : t("browser.watch.step.other");
}

const RANK: Record<BrowserHandoff["status"], number> = {
  pending: 0,
  active: 1,
  done: 2,
  failed: 2,
  expired: 2,
  cancelled: 2,
  withdrawn: 2,
};

/** Two views of the same request (the socket's, the cache's): the one further along wins; another request, the first. */
function newest(a: BrowserHandoff | null, b: BrowserHandoff | null): BrowserHandoff | null {
  if (!a || !b) return a ?? b;
  if (a.id !== b.id) return a;
  return RANK[b.status] > RANK[a.status] ? b : a;
}

/** "https://dashboard.stripe.com/login?x=1" → ["dashboard.stripe.com", "/login"]. */
export function hostAndPath(url: string | null | undefined): [string, string] {
  if (!url) return ["", ""];
  const m = /^[a-z]+:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  return m ? [m[1] ?? "", (m[2] ?? "").replace(/\/$/, "")] : [url, ""];
}

/**
 * What the card's title shows: the request while the person is in control of it, else the
 * site, "opening" only until the first frame, and the agent's browser when no site is known.
 */
export function titleKind(v: {
  inControl: boolean;
  ask: string | null;
  host: string;
  opening: boolean;
}): "ask" | "host" | "opening" | "agent" {
  if (v.inControl && v.ask) return "ask";
  if (v.host) return "host";
  return v.opening ? "opening" : "agent";
}

/**
 * The browser card on an agent's live row, while (and after) it used its browser in this run. A
 * take over bound to this run keeps it even without steps (a reload); a run that failed or was
 * stopped keeps it only for the person still in control (they hand back from it).
 */
export function RunBrowserCard({ run, name }: { run: LiveRun; name: string }) {
  const { org, me } = useOrg();
  const steps = browserSteps(run.work);
  // In a shared profile (ADR 0110) the card shows the profile, to those who may watch it.
  const settings = useAgentBrowserSettings(org.id, run.agentId, steps.length > 0);
  const profiles = useBrowserProfiles(org.id, steps.length > 0);
  const inProfile = runProfile(steps, settings.data?.profileId ?? null, profiles.data);
  const ended = run.status === "failed";
  const ask = !run.provisional && (ended || steps.length === 0);
  const open = useAgentBrowserHandoff(org.id, run.agentId, ask, HELD_STALE_MS);
  const held = isHeldTakeover(open.data, run.runId);
  if (ended ? !(held && controlledBy(open.data, me.user.id)) : steps.length === 0 && !held) return null;
  return (
    <BrowserCard
      agentId={run.agentId}
      name={name}
      steps={steps}
      runId={run.runId}
      place={{ channelId: run.channelId, threadId: run.threadId }}
      handoff={held ? (open.data ?? null) : null}
      profileWait={run.browserWait ?? null}
      {...(inProfile
        ? {
            profile: {
              id: inProfile.id,
              name: inProfile.name,
              agentIds: inProfile.agentIds,
              canDrive: canDo(org, "manage_connectors") && canDo(org, "control_browsers"),
            },
          }
        : {})}
    />
  );
}

/**
 * A take over held after its run's live block went (the run paused for the person, or ended): the
 * same card, on the run's last saved message or at the end of its conversation, until the browser
 * is handed back.
 * Nothing while the run's live block is there (it draws the card) or when no take over holds it.
 */
export function HeldBrowserCard({
  agentId,
  runId,
  name,
  enabled = true,
}: {
  agentId: string;
  runId: string;
  name: string;
  /** Ask the server (a recent message); otherwise only what the realtime events said. */
  enabled?: boolean;
}) {
  const held = useHeldTakeover(agentId, runId, enabled);
  if (!held) return null;
  return <BrowserCard agentId={agentId} name={name} runId={runId} handoff={held} />;
}

/** The agent's open take over bound to this run, while the run has no live block here (`HeldBrowserCard`). */
export function useHeldTakeover(agentId: string, runId: string, enabled = true): BrowserHandoff | null {
  const { org } = useOrg();
  const open = useAgentBrowserHandoff(org.id, agentId, enabled, HELD_STALE_MS);
  const liveHere = useStreams((s) => Boolean(s.runs[runId]));
  return !liveHere && open.data && isHeldTakeover(open.data, runId) ? open.data : null;
}

/**
 * An agent's browser in its card (ADR 0040 §6–7): in the conversation and on its computer's page; in the
 * computer dialog (`surface`), its page.
 * In the conversation the live page is always in view, in a frame of the agent's color whose top says the
 * site and what it does now. On a computer's page a line with the agent's sky edge says it over the page and
 * its steps. Full screen on request. In control (Assumir, or a help request opened here) the same card takes
 * the person's clicks, the app's own text field and an address bar; Pronto (a request) or Devolver (a take
 * over) hands back. While someone else is in control the page is hidden from everyone else.
 */
export function BrowserCard({
  agentId,
  name,
  steps = [],
  handoff: given = null,
  surface = false,
  canTakeOver = true,
  onFold,
  onSettled,
  runId,
  place,
  profile,
  profileWait = null,
}: {
  agentId: string;
  name: string;
  /**
   * A shared browser profile (ADR 0110) instead of the agent's browser: its live view (`profile:<id>`), "Fazer
   * login" as the person's control of it, Devolver hands it back to its agents. `name` is the profile's.
   */
  profile?: { id: string; name: string; agentIds: string[]; canDrive: boolean };
  /** Its run's browser command waits for a profile someone else has (the waiting box). */
  profileWait?: BrowserProfileWait | null;
  /** What the agent did in its browser in this run (the log); none outside a run. */
  steps?: BrowserStep[];
  /** The run whose card this is: Assumir binds the take over to it (the card stays in its conversation). */
  runId?: string;
  /** Where that run answers (the held card's place once its live block goes). */
  place?: { channelId: string; threadId: string | null };
  /** The help request this card answers (opened from it). */
  handoff?: BrowserHandoff | null;
  /**
   * The computer dialog's page: always open, its sub-line and actions in the dialog's head (which also holds
   * full screen), the site above the page, and no log or Parar (the dialog shows the steps).
   */
  surface?: boolean;
  /** Take control may show (the dialog says no while the agent is held or a request waits). */
  canTakeOver?: boolean;
  /** A computer's page: folding takes the card away (its place shows its own line again). */
  onFold?: () => void;
  /** The person handed back or said it couldn't be done: the holder can fold the card away. */
  onSettled?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const head = useDialogHead();
  const sayFailed = useSayFailed();
  const openComputer = useOpenComputer();
  // The dialog over this card shows the same screen ("Ver a tela inteira"), and a hidden tab shows nothing: the card's
  // own view of it closes (one stream per person, none for nobody).
  const dialogOpen = useOpenedComputer() === agentId;
  const pageVisible = usePageVisible();
  // The workspace's own computer is never off and nobody connects one: its words say so.
  const edition = useComputerEdition(org.id);
  const cloud = edition === "cloud";
  const agent = dir.agentById.get(agentId);
  const g = agentGrammar(name);
  const color = colorOf(agent);
  // In the conversation (not the dialog, not a computer's page that folds it away) the page is always in
  // view, framed in the agent's color.
  const chat = !surface && !onFold;
  const root = useRef<HTMLDivElement>(null);
  // In the conversation the card never closes (its page stays in view): folding there only leaves full screen.
  const fold = () => {
    if (surface) return;
    if (onFold) onFold();
    else setFull(false);
  };
  // In the conversation the page streams only while the card is on screen; off screen it keeps the last frame.
  // Except for the person in control: their watching is what keeps their control (2 min without it ends it).
  const [visible, setVisible] = useState(false);
  const [holding, setHolding] = useState(() => controlledBy(given, me.user.id));
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setVisible(onScreenNow(entries) === true));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const [full, setFull] = useState(false);
  const openQ = useAgentBrowserHandoff(org.id, agentId, !profile);
  // The agent's browser runs on its screen (ADR 0058 §7): for whoever may watch that screen, the card shows all of it,
  // and watches no frames meanwhile (nobody keeps the computer's screencast running for nothing). Whoever holds the
  // browser drives it on its frames, whose watch keeps their control alive.
  const quiet = newest(openQ.data ?? null, given && isOpenHandoff(given) ? given : null);
  const screen = useBrowserScreen(org.id, agentId, {
    enabled: !surface && !profile,
    userId: me.user.id,
    shown: (!chat || visible || full) && !dialogOpen && pageVisible,
    holdsBrowser: holding || controlledBy(quiet, me.user.id),
  });
  const shows = screen.desktop;
  // What the card's screen shows: Take over and Stop go over it once it is live.
  const [screenState, setScreenState] = useState<DesktopViewState>("connecting");
  const { report } = screen;
  const onScreenView = useCallback(
    (state: DesktopViewState) => {
      setScreenState(state);
      report(state);
    },
    [report],
  );
  useEffect(() => {
    if (!screen.connect) setScreenState("connecting");
  }, [screen.connect]);
  // Parar here: the card says so until a new page comes, which only its frames tell (the browser is closed, so none
  // stream meanwhile), then it shows the screen again.
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);
  // The frames wait for the screen's status: a card that shows the screen never opens them first.
  const watching = (!chat || visible || holding) && (holding || stoppedAt !== null || (screen.settled && !shows));
  // The page shown here is how people follow the agent's work: it gets the stream's own rate everywhere (only the
  // phone's small thumbnails ask for less, ADR 0040 §7.1).
  const live = useBrowserLive(profile ? profileLiveKey(profile.id) : agentId, watching);
  const profileActions = useBrowserProfileMutations(org.id);
  // After Devolver on a profile: who may use it now, in place of the page.
  const [handedProfile, setHandedProfile] = useState(false);
  // The last page that came, kept while a view that starts again has none yet. Read while rendering (not set in an
  // effect), so each frame renders the card once, not twice.
  const lastFrame = useRef<BrowserFrame | null>(null);
  if (live.frame) lastFrame.current = live.frame;
  const still = lastFrame.current;
  useEffect(() => {
    // A new page after Parar: the browser is open again (the agent, or a person opening a site).
    if (live.frame) setStoppedAt(null);
  }, [live.frame]);
  // Watching is for everyone behind its work; driving it only for admins, its owner and who it asked (ADR 0040).
  const control = useAgentScreenControl(org.id, agentId, !given && !profile);
  const mayDrive = canTakeOver && (profile ? profile.canDrive : given !== null || control.data !== false);
  const actions = useBrowserHandoffMutations(org.id);
  const machines = useMachines(org.id);
  const imgRef = useRef<HTMLImageElement>(null);
  // The agent's desktop runs (its Chrome shows there): "Ver a tela inteira" opens it in the computer dialog.
  const desktop = screen.status.data;
  const onDesktop = desktop?.available === true && desktop.running;

  const handoff = newest(live.status?.handoff ?? null, quiet);
  const controller = handoff?.status === "active" ? handoff.controllerUserId : null;
  const inControl = controller === me.user.id;
  const otherInControl = Boolean(controller) && !inControl;
  useEffect(() => setHolding(inControl), [inControl]);
  const problem = inControl ? inputProblem(live.error) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: said each time, also when a try that failed fails again
  useEffect(() => {
    if (problem) sayFailed(t(problem));
  }, [live.errors]);
  const controllerName = controller ? (dir.memberById.get(controller)?.name ?? t("channel.unknownPerson")) : "";
  // The computer the browser runs on: the request's, else the one this agent works on.
  const machine = (machines.data ?? []).find((m) =>
    handoff?.machineId ? m.id === handoff.machineId : m.agents.some((a) => a.id === agentId),
  );
  const remoteIsMac = machine?.os === "darwin";

  const [secure, setSecure] = useState(false);
  const [text, setText] = useState("");
  const [mark, setMark] = useState<{ x: number; y: number; key: number } | null>(null);
  const [failing, setFailing] = useState(false);
  const [reason, setReason] = useState<(typeof FAIL_REASONS)[number] | null>(null);
  const [note, setNote] = useState("");
  const [backNote, setBackNote] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  // On touch the text bar types into the page; a mouse and keyboard type into it directly (`onPageKey`).
  const touch = useMatchMedia(TOUCH);
  // The wheel scrolls the conversation; a click into the page (in control) hands it to the page until Esc.
  const [capturing, setCapturing] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  // Where the person's paste keys put the focus for a moment: only an editable element gets a paste in every browser.
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  // The wheel is scrolling the page right now: only then the hint says how to give the wheel back.
  const [scrolling, setScrolling] = useState(false);
  const scrollIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopScrolling = () => {
    if (scrollIdle.current) clearTimeout(scrollIdle.current);
    scrollIdle.current = null;
    setScrolling(false);
  };

  // The browser is closed (the server says so, or its stream ended), or a site the person typed is opening:
  // only a new frame ends either. Every retry's status clears the server's "closed" for a moment, so the
  // card would otherwise flash "opening" in between.
  const [wait, setWait] = useState<{ frame: BrowserFrame | null; why: "closed" | "opening"; site?: string } | null>(
    null,
  );
  // In the computer dialog a browser someone stopped is just closed: Assumir opens it again.
  const closedNow =
    live.unavailable?.reason === "closed" || (live.ended && (surface || live.endedBy?.reason !== "stopped"));
  useEffect(() => {
    if (closedNow) setWait({ frame: live.frame, why: "closed" });
  }, [closedNow, live.frame]);
  const waitingFor = wait && live.frame === wait.frame ? wait : null;
  // The frames' own states say nothing while the card shows the screen.
  const closed = !shows && waitingFor?.why === "closed";
  const opening = !shows && waitingFor?.why === "opening";
  // Someone else is in control: the server sends this view no frames until it's handed back.
  const hidden = !shows && live.status?.hidden === true;

  // The bar or a notification asked for this card: bring it into view.
  const asked = useBrowserCardRequest({ agentId, ...(given ? { handoffId: given.id } : {}) });
  useEffect(() => {
    if (asked === null) return;
    root.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [asked]);

  // Full screen: the browser's own when it allows it (above everything, Esc leaves it); either way the
  // card fills the window.
  useEffect(() => {
    const el = root.current;
    if (!full || !el) return;
    const left = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener("fullscreenchange", left);
    if (typeof el.requestFullscreen === "function") el.requestFullscreen().catch(() => {});
    return () => {
      document.removeEventListener("fullscreenchange", left);
      if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
    };
  }, [full]);
  // Esc leaves full screen (a scroll's hint on screen goes first), before a dialog or the page hears it.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      const hinted = scrollIdle.current !== null;
      setCapturing(false);
      if (!hinted) setFull(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [full]);

  const send = (events: BrowserInputEvent[] | null) => {
    if (!inControl || !events?.length) return;
    live.sendInput(events);
  };

  // Where a point of the window lands on the page as shown now: null off it, its nearest edge with `clamp`.
  const meta = useMemo(() => (live.frame ? frameMetadata(live.frame) : undefined), [live.frame]);
  const toPage = (p: { x: number; y: number }, clamp = false) => {
    const img = imgRef.current;
    return img && meta ? pagePoint(p, img.getBoundingClientRect(), meta, "contain", clamp) : null;
  };
  const toPageNow = useRef(toPage);
  toPageNow.current = toPage;
  // A mouse or a pen presses at once and drags while held, as on a computer; fingers go through
  // `createTouchInput` (a tap clicks, one moving finger drags, two scroll).
  const press = useRef<{ id: number; at: { x: number; y: number } } | null>(null);
  const [fingers] = useState(() => createTouchInput((p, clamp) => toPageNow.current(p, clamp)));
  const landed = useRef({ x: 0, y: 0 });
  // A finger drags or scrolls: the hint says how to scroll.
  const [sliding, setSliding] = useState(false);
  const markAt = (p: { x: number; y: number }) => {
    const box = imgRef.current?.getBoundingClientRect();
    if (box) setMark({ x: p.x - box.left, y: p.y - box.top, key: Date.now() });
  };
  const onFingers = (events: BrowserInputEvent[]) => {
    send(events);
    setSliding(fingers.mode === "drag" || fingers.mode === "scroll");
  };

  const onPagePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!inControl) return;
    const p = { x: e.clientX, y: e.clientY };
    if (e.pointerType === "touch") {
      // The first finger of a touch: no other is down, whatever the fingers before it missed.
      const stale = e.isPrimary ? fingers.cancel() : [];
      onFingers([...stale, ...fingers.down(e.pointerId, p)]);
      if (fingers.mode === "pending") landed.current = p;
      return;
    }
    if (e.button !== 0) return;
    const at = toPage(p);
    if (!at) return;
    // The moves and the release outside the page still come here: a drag past its edge stays at the edge.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    press.current = { id: e.pointerId, at };
    stopScrolling();
    setCapturing(true);
    markAt(p);
    send(pressEvents(at, modifiersOf(e, remoteIsMac)));
  };
  const onPagePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = { x: e.clientX, y: e.clientY };
    if (e.pointerType === "touch") return onFingers(fingers.move(e.pointerId, p));
    const held = press.current;
    const at = held?.id === e.pointerId ? toPage(p, true) : null;
    if (held && at && (e.buttons & 1) === 0) {
      // Its release went elsewhere (another window took it): this move is the release.
      press.current = null;
      send([releaseEvent(at)]);
      return;
    }
    if (!held || !at || (at.x === held.at.x && at.y === held.at.y)) return;
    held.at = at;
    send([dragEvent(at, modifiersOf(e, remoteIsMac))]);
  };
  const onPagePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const p = { x: e.clientX, y: e.clientY };
    if (e.pointerType === "touch") {
      const tap = fingers.mode === "pending";
      const events = fingers.up(e.pointerId, p);
      if (tap && events.length > 0) markAt(landed.current);
      return onFingers(events);
    }
    const held = press.current;
    if (!held || held.id !== e.pointerId) return;
    press.current = null;
    const at = toPage(p, true) ?? held.at;
    const mods = modifiersOf(e, remoteIsMac);
    const moved = at.x !== held.at.x || at.y !== held.at.y;
    send(moved ? [dragEvent(at, mods), releaseEvent(at, mods)] : [releaseEvent(at, mods)]);
  };
  // The system took the pointer away (a gesture, a lost capture): what was held is let go where it was.
  const onPagePointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") {
      // Each finger's capture also ends as it lifts: only a cancel ends the fingers' gesture.
      if (e.type === "pointercancel") onFingers(fingers.cancel());
      return;
    }
    const held = press.current;
    if (!held || held.id !== e.pointerId) return;
    press.current = null;
    send([releaseEvent(held.at)]);
  };

  // What is shown of the page: nothing while it is closed, opening or hidden (only a stale frame is held).
  const frame = closed || opening || hidden ? null : live.frame;
  // Only a page that was clicked into takes the wheel (a native listener: the conversation's scroll is
  // stopped only then); anywhere else the wheel scrolls the conversation.
  const wheelTo = useRef<(e: globalThis.WheelEvent) => void>(() => {});
  wheelTo.current = (e) => {
    if (!capturing || !inControl || !imgRef.current || !live.frame) return;
    e.preventDefault();
    const at = toPage({ x: e.clientX, y: e.clientY });
    if (!at) return;
    send([wheelEvent(at, e.deltaX, e.deltaY)]);
    setScrolling(true);
    if (scrollIdle.current) clearTimeout(scrollIdle.current);
    scrollIdle.current = setTimeout(stopScrolling, SCROLL_HINT_IDLE_MS);
  };
  useEffect(() => () => void (scrollIdle.current && clearTimeout(scrollIdle.current)), []);
  // The mouse leaving the page gives the wheel back to the conversation.
  const onPagePointerLeave = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    stopScrolling();
    setCapturing(false);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the page element mounts with the first frame
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const on = (e: globalThis.WheelEvent) => wheelTo.current(e);
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, [Boolean(frame)]);
  useEffect(() => {
    if (!capturing) {
      if (scrollIdle.current) clearTimeout(scrollIdle.current);
      scrollIdle.current = null;
      setScrolling(false);
      return;
    }
    const out = (e: globalThis.PointerEvent) => {
      if (!pageRef.current?.contains(e.target as Node)) setCapturing(false);
    };
    // Esc gives the wheel back wherever the focus is. It is the hint's own key only while the hint shows;
    // otherwise it still reaches the page.
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || full) return;
      if (scrollIdle.current) {
        e.preventDefault();
        e.stopPropagation();
      }
      setCapturing(false);
    };
    document.addEventListener("pointerdown", out, true);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", out, true);
      document.removeEventListener("keydown", esc, true);
    };
  }, [capturing, full]);
  useEffect(() => {
    if (inControl) return;
    setCapturing(false);
    setFailing(false);
  }, [inControl]);
  // Control ending, or the page going (closed, opening, someone else's) before its pointers lifted, lets go of them:
  // the next press starts fresh.
  const pointing = inControl && Boolean(frame);
  useEffect(() => {
    if (pointing) return;
    press.current = null;
    fingers.cancel();
    setSliding(false);
  }, [pointing, fingers]);
  // The button that opened the page leaves with the focus: keys typed at once, at a field the page shows, go there.
  useEffect(() => {
    if (pointing && document.activeElement === document.body) pageRef.current?.focus({ preventScroll: true });
  }, [pointing]);
  // The screen's last picture, when the dialog switches from it to this page (or back), shows dimmed until the page's
  // first frame: the layout effects of the view going and of the one coming run before anything paints
  // (`DialogHeadSlots.picture`).
  const kept = head?.picture;
  const [keptSrc, setKeptSrc] = useState<string | null>(null);
  const leaving = useRef({ still, inControl });
  leaving.current = { still, inControl };
  useLayoutEffect(() => {
    if (!kept) return;
    if (kept.current && kept.current.control !== leaving.current.inControl) setKeptSrc(kept.current.src);
    kept.current = null;
    return () => {
      const { still: last, inControl: control } = leaving.current;
      // As a `data:` URL: the view that takes it may hold it as long as it likes, and nothing has to free it.
      const src = last ? browserFrameDataUrl(last) : null;
      kept.current = src ? { src, control } : null;
    };
  }, [kept]);
  useEffect(() => {
    if (live.frame) setKeptSrc(null);
  }, [live.frame]);

  const onPageKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!inControl) return;
    // The browser's own paste, into the field nobody sees: its paste event brings the person's text (`pasteText`).
    if (pastes(e.nativeEvent, isApple())) {
      pasteRef.current?.focus({ preventScroll: true });
      return;
    }
    const events = keyboardEvents(e, remoteIsMac);
    if (!events) return;
    e.preventDefault();
    send(events);
  };

  /** What the person pasted, typed into the page's focused field as text (CDP `Input.insertText`). */
  const pasteText = (pasted: string) => {
    if (!pasted) return sayFailed(t("desktop.clipboard.textOnly", g));
    if (pasteBytes(pasted) > PASTE_MAX_BYTES) return sayFailed(t("desktop.clipboard.tooLong", g));
    send(pasteEvents(pasted));
  };
  /** Colar: the person's clipboard, where their browser lets the page read it (it may ask first). */
  const pasteClipboard = async () => {
    try {
      pasteText(await navigator.clipboard.readText());
    } catch {
      sayFailed(t("browser.inCard.pasteBlocked", { keys: shortcut("V") }));
    }
    pageRef.current?.focus({ preventScroll: true });
  };

  const sendText = () => {
    if (!text) return;
    send(pasteEvents(text));
    setText("");
  };

  const didntWork = () => sayFailed(t("browser.live.actionFailed"));

  /** Pronto (a request) or Devolver (a take over), with what the person wants the agent to know. */
  const finish = () => {
    if (!handoff) return;
    if (profile) {
      profileActions.handback.mutate(profile.id, {
        onSuccess: () => {
          setHandedProfile(true);
          onSettled?.();
        },
        onError: didntWork,
      });
      return;
    }
    const words = backNote.trim();
    actions.done.mutate(words ? { handoffId: handoff.id, note: words } : handoff.id, {
      onSuccess: () => {
        setBackNote("");
        fold();
        onSettled?.();
      },
      onError: didntWork,
    });
  };

  const fail = () => {
    if (!handoff) return;
    const words = [reason ? t(`browser.live.failReasons.${reason}`) : "", note.trim()].filter(Boolean).join(". ");
    actions.failed.mutate(
      { handoffId: handoff.id, ...(words ? { note: words } : {}) },
      {
        onSuccess: () => {
          setFailing(false);
          setBackNote("");
          fold();
          onSettled?.();
        },
        onError: didntWork,
      },
    );
  };

  const takeover = () => {
    if (profile) {
      profileActions.takeover.mutate(profile.id, {
        onSuccess: () => setHandedProfile(false),
        onError: (err) =>
          sayFailed(
            (err as { status?: number }).status === 409 ? t("browser.profiles.busy") : t("browser.live.actionFailed"),
          ),
      });
      return;
    }
    actions.takeover.mutate(runId ? { agentId, runId } : agentId, {
      onSuccess: (h) => {
        setStoppedAt(null);
        // It claimed the agent's own request: that request's card is the control (one card, not two).
        if (h.kind === "ask") requestBrowserCard({ agentId, handoffId: h.id });
        else if (h.runId && place) rememberHeldPlace({ runId: h.runId, agentId, ...place });
      },
      onError: (err) =>
        sayFailed(
          (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.live.actionFailed"),
        ),
    });
  };

  const stop = () =>
    actions.stop.mutate(agentId, {
      onSuccess: () => {
        setConfirmStop(false);
        setStoppedAt(new Date().toISOString());
        // Folded away, the card can't say it: the toast does.
        if (onFold) toast.show(t("browser.machine.stopped", g));
        fold();
      },
      onError: didntWork,
    });

  /** A site typed in the address bar (the card waits for its first frame), or its arrows and reload. */
  const openSite = (url: PageTarget) => {
    const before = live.frame;
    const opened = profile
      ? profileActions.open.mutateAsync({ profileId: profile.id, url })
      : actions.open.mutateAsync({ agentId, url });
    return opened.then(() => {
      if (typeof url === "string") setWait({ frame: before, why: "opening", site: hostAndPath(url)[0] || url });
    });
  };

  const unavailable = shows ? null : live.unavailable;
  const reconnecting = unavailable?.reason === "reconnecting";
  // What can't change by waiting is said plainly; everything else is "opening" while it retries.
  const blocker = shows
    ? null
    : unavailable?.reason === "offline"
      ? t(cloud ? "browser.inCard.offlineCloud" : "browser.inCard.offline", g)
      : unavailable?.reason === "no_computer"
        ? t(cloud ? "browser.inCard.noComputerCloud" : "browser.inCard.noComputer", g)
        : unavailable?.reason === "forbidden" || live.error === "forbidden" || live.error === "not_found"
          ? t(canDo(org, "own_browsers") ? "browser.inCard.forbidden" : "browser.inCard.noRole")
          : live.error === "too_many_browsers"
            ? t("browser.inCard.tooMany")
            : null;
  const starting = !shows && !frame && !blocker && !reconnecting && !closed && !opening && !hidden;
  // Opening or reconnecting for too long says so, with Try again: who may drive it restarts the browser, the
  // others watch again. Only while this view watches on an open socket: off screen or offline no page can come.
  const online = useConnectionStatus() === "open";
  const [attempt, setAttempt] = useState(0);
  // Never on the screen: the card watches no frames there (`watching`).
  const stuck = useBrowserStuck(watching && online && !hidden && (starting || reconnecting || opening), attempt);
  const retry = () => {
    setAttempt((n) => n + 1);
    // Watching again after the restart too: this view's own watch may be what the server refused.
    if (mayDrive && !profile) actions.restart.mutate(agentId, { onError: didntWork, onSettled: () => live.retry() });
    else live.retry();
  };

  // Handing back or taking, the last picture stays in sight, dimmed under what is happening: never a cold cover.
  const switchingTo =
    actions.takeover.isPending || profileActions.takeover.isPending
      ? t("desktop.taking")
      : actions.done.isPending
        ? t("desktop.returning", g)
        : keptSrc && starting && !stuck
          ? inControl
            ? t("desktop.taking")
            : t("desktop.returning", g)
          : null;
  // Watching in the dialog, a click, a key or a paste on the page asks before control (`useAskControl`).
  const asking = useAskControl(
    surface && canTakeOver && !inControl && !otherInControl && Boolean(frame) && !blocker && !switchingTo,
  );

  // The agent's own request is open and mine: its card (under the request) is the control, not this one.
  if (!given && handoff?.kind === "ask" && inControl) return null;

  const handBackLabel = handoff?.kind === "takeover" ? t("browser.inCard.handBack") : t("browser.inCard.done");

  if (profile && handedProfile && !inControl) {
    return (
      <div className="brw-ac" ref={root}>
        <p className="cmp-status is-done ac-iconline">
          <Icon name="check" size={14} />
          <span>
            <ProfileDone agentIds={profile.agentIds} />
          </span>
        </p>
      </div>
    );
  }

  // Parar (here, or by someone else: everyone watching hears it).
  const stopped = stoppedAt
    ? { at: stoppedAt, by: me.user.id }
    : live.endedBy?.reason === "stopped"
      ? { at: live.endedBy.at ?? null, by: live.endedBy.userId ?? null }
      : null;
  if (stopped && !surface) {
    const byName = stopped.by && stopped.by !== me.user.id ? dir.memberById.get(stopped.by)?.name : undefined;
    const time = stopped.at ? formatTime(i18n.language, stopped.at) : "";
    return (
      <div className="brw-ac" ref={root}>
        <div className="brw-ac__head">
          <span className="brw-stile brw-stile--lg" aria-hidden="true">
            <Icon name="stop" size={14} />
          </span>
          <span className="brw-ac__tx">
            <b>{t("browser.watch.stopped")}</b>
            {(stopped.by === me.user.id || byName || time) && (
              <small>
                <span>
                  {stopped.by === me.user.id
                    ? t("browser.watch.stoppedBy", { time })
                    : byName
                      ? t("browser.watch.stoppedByOther", { person: byName, time })
                      : t("browser.watch.stoppedAt", { time })}
                </span>
              </small>
            )}
          </span>
          {((inControl && handoff) || onFold) && (
            <span className="brw-ac__acts">
              {inControl && handoff && (
                <Button size="sm" variant="primary" icon="check" loading={actions.done.isPending} onClick={finish}>
                  {handBackLabel}
                </Button>
              )}
              {onFold && (
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="chevronDown"
                  className="brw-ac__chev"
                  aria-label={t("browser.inCard.collapse")}
                  title={t("browser.inCard.collapse")}
                  onClick={onFold}
                />
              )}
            </span>
          )}
        </div>
      </div>
    );
  }

  const lastStep = steps.at(-1);
  // The page as last seen, for the title: none while closed, opening or hidden.
  const pic = closed || opening || hidden ? null : (frame ?? still);
  const [host, path] = hostAndPath(closed || hidden ? null : browserSiteUrl(pic?.metadata.url, steps));
  const ask = handoff?.kind === "ask" ? handoff.instructions : null;
  const working = !inControl && !otherInControl;
  // The frame (the conversation, not full screen): the steps are its history on hover, not a column.
  const framed = chat && !full;
  const showLog = working && !starting && steps.length > 0 && !surface && !framed;
  // A blank page or a closed browser: the address bar takes the person's typing at once.
  const goFocus = closed || (Boolean(frame) && isBlankPage(frame?.metadata.url));
  const pageUrl = pic?.metadata.url ?? null;

  const asTitle = titleKind({ inControl, ask, host, opening: starting && !stuck });
  const title =
    asTitle === "ask"
      ? (ask ?? "")
      : asTitle === "host"
        ? siteName(host)
        : asTitle === "opening"
          ? t("browser.inCard.opening")
          : t("browser.inCard.group", g);
  // On the screen (ADR 0058 §7) no frame says the page: what the agent does now, or watching.
  const sub = inControl
    ? profile
      ? t("browser.profiles.controlSub")
      : ask
        ? host
          ? t("browser.inCard.subControl", { site: host, ...g })
          : t("browser.inCard.subControlAsked", g)
        : t("browser.inCard.subTakeover", g)
    : otherInControl
      ? hidden
        ? t("browser.inCard.subHidden", { person: controllerName })
        : t("browser.inCard.subOther", { person: controllerName })
      : closed
        ? t("browser.inCard.subClosed")
        : stuck
          ? t("browser.inCard.subStuck")
          : reconnecting
            ? t("browser.inCard.subReconnect", g)
            : starting || (!lastStep && !pic && !shows)
              ? t("browser.inCard.subStarting", g)
              : lastStep
                ? t("browser.inCard.subWorking", { name, now: lowerFirst(stepText(t, lastStep), i18n.language) })
                : t("browser.live.watchOnly");
  const live_ = working && !blocker && !closed && !stuck;
  const spinning = live_ || (reconnecting && !stuck);
  // The dialog's sub-line: the same, but live and watching is what the dialog knows (a request, a hold). Over a cover
  // it says nothing the cover says (opening, reconnecting): only who holds the page.
  const surfaceSub = inControl
    ? sub
    : otherInControl
      ? hidden
        ? t("desktop.sub.hidden", { person: controllerName })
        : sub
      : blocker || reconnecting || starting || opening
        ? ""
        : closed
          ? t("browser.watch.live")
          : (head?.watching ?? sub);
  const [frameTop, frameBottom] = agentGradient(color);
  const frameStyle = { "--mf-a": frameTop, "--mf-b": frameBottom } as CSSProperties;

  // Watching: Assumir (a labelled, tactile button) and Parar (quiet, with a confirmation), never a lone red square.
  // A closed browser has nothing to stop: it opens straight into the person's control.
  const watchActs = surface ? (
    // The dialog's page: Assumir alone (the dialog holds full screen), also to open a closed browser and sign in.
    !otherInControl &&
    !blocker &&
    mayDrive && (
      <Button size="sm" icon="person" className="cmp-take" loading={actions.takeover.isPending} onClick={takeover}>
        <span className="cmp-act-label">{t("desktop.takeover")}</span>
      </Button>
    )
  ) : confirmStop ? (
    <>
      <span className="brw-stopask small muted">{t("browser.watch.stopAsk", g)}</span>
      <Button size="sm" variant="ghost" onClick={() => setConfirmStop(false)}>
        {t("browser.watch.no")}
      </Button>
      <Button size="sm" variant="primary" loading={actions.stop.isPending} onClick={stop}>
        {t("browser.inCard.stop")}
      </Button>
    </>
  ) : (
    !otherInControl &&
    !blocker &&
    (closed ? (
      mayDrive && (
        <Button size="sm" icon="globe" loading={actions.takeover.isPending} onClick={takeover}>
          {t("browser.inCard.openBrowser")}
        </Button>
      )
    ) : (
      <>
        {mayDrive && (
          <Button size="sm" icon="person" loading={actions.takeover.isPending} onClick={takeover}>
            {t("browser.inCard.takeover")}
          </Button>
        )}
        {!profile && (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="stop"
            aria-label={t("browser.inCard.stop")}
            title={t("browser.inCard.stop")}
            onClick={() => setConfirmStop(true)}
          />
        )}
      </>
    ))
  );
  const seeWhole = onDesktop && !full && (
    <Button
      size="sm"
      variant="ghost"
      icon="computer"
      iconOnly={framed}
      aria-label={framed ? t("desktop.seeWhole") : undefined}
      title={framed ? t("desktop.seeWhole") : undefined}
      onClick={() => openComputer(agentId)}
    >
      {t("desktop.seeWhole")}
    </Button>
  );
  const titleText = (
    <b className={asTitle === "ask" ? "is-ask" : undefined} title={asTitle === "ask" ? title : undefined}>
      {title}
      {asTitle === "host" && path && <span className="brw-ac__path">{path}</span>}
    </b>
  );
  const subText = (
    <small>
      {spinning && <PixelSpinner size={14} color={color} />}
      <span>{withAgentFace(sub, name, agentId)}</span>
    </small>
  );
  const cover =
    switchingTo && (frame || keptSrc) ? (
      <Cover clear color={color} spinner text={switchingTo} />
    ) : asking.asking ? (
      <Cover
        className="dsk-ask"
        clear
        color={color}
        icon={mayDrive ? "person" : "eye"}
        text={t(mayDrive ? "desktop.ask.title" : "desktop.ask.watching")}
        action={
          <AskActions
            onCancel={asking.cancel}
            take={
              mayDrive && (
                <Button
                  size="sm"
                  variant="primary"
                  icon="person"
                  loading={actions.takeover.isPending}
                  onClick={takeover}
                >
                  {t("desktop.takeover")}
                </Button>
              )
            }
          />
        }
      />
    ) : profileWait ? (
      <ProfileWaitCover wait={profileWait} waiter={{ agentId, name }} />
    ) : blocker ? (
      <Cover color={color} text={blocker} />
    ) : hidden ? (
      // Its head says who is in control.
      <Cover color={color} icon="eyeOff" text={t("browser.inCard.hiddenHelp", g)} />
    ) : closed ? (
      <Cover
        color={color}
        sky
        icon="globe"
        text={t("browser.inCard.closed", g)}
        help={inControl ? t("browser.inCard.closedControl") : t("browser.inCard.closedHelp", g)}
      />
    ) : stuck ? (
      <Cover
        color={color}
        icon="alert"
        text={t("browser.inCard.stuck", g)}
        help={mayDrive ? t("browser.inCard.stuckHelp") : undefined}
        action={
          <Button size="sm" icon="refresh" loading={actions.restart.isPending} onClick={retry}>
            {t("common.retry")}
          </Button>
        }
      />
    ) : opening ? (
      <Cover color={color} spinner text={t("browser.inCard.goOpening", { site: waitingFor?.site ?? "" })} />
    ) : reconnecting ? (
      <Cover color={color} spinner text={t("browser.live.reconnecting")} help={t("browser.inCard.reconnectHelp", g)} />
    ) : starting ? (
      <Cover color={color} spinner text={t("browser.inCard.openingLong", g)} help={t("browser.inCard.openingHelp")} />
    ) : null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div
      ref={root}
      className={[
        "brw-ac is-open",
        inControl && "is-control",
        full && "is-full",
        surface && "is-surface",
        closed && "is-closed",
        framed && "brw-mf",
        framed && live_ && "is-working",
      ]
        .filter(Boolean)
        .join(" ")}
      style={framed ? frameStyle : undefined}
      role="group"
      data-esc-layer={full ? "" : undefined}
      aria-label={t("browser.inCard.group", g)}
    >
      {!surface && !framed && <SkyStrip color={color} muted={inControl} moving={live_} />}
      {framed ? (
        // The frame's top: where it is, and what it does now (its steps on hover), or the person's controls.
        <div className="brw-mf__top ac-on-dark">
          <span className="brw-mf__site">
            {profile && <Chip>{profile.name}</Chip>}
            {asTitle === "host" ? <SiteIcon host={host} /> : <Icon name="globe" size={14} />}
            {titleText}
          </span>
          <span className="brw-grow" />
          {inControl ? (
            // The page takes the person's clicks: full screen sits here, not over it.
            <span className="brw-mf__acts">
              {seeWhole}
              {!blocker && <FullScreenButton full={full} onToggle={() => setFull(true)} />}
            </span>
          ) : (
            // Focusable so the steps also open from the keyboard.
            <span className="brw-mf__now" tabIndex={steps.length > 0 ? 0 : -1}>
              {spinning && <PixelSpinner size={14} color={color} />}
              <span>{withAgentFace(sub, name, agentId)}</span>
              {steps.length > 0 && (
                <span className="brw-mf__hist" role="tooltip">
                  <ol>
                    {[...steps].reverse().map((s, i) => {
                      const now = i === 0 && s.running;
                      return (
                        <li key={s.id} className={now ? "ac-iconline is-now" : "ac-iconline"}>
                          {now ? <PixelSpinner size={14} color={color} /> : <Icon name={iconOf(s.tool)} size={14} />}
                          <span>{stepText(t, s)}</span>
                          {s.since && <small>{formatTime(i18n.language, new Date(s.since).toISOString())}</small>}
                        </li>
                      );
                    })}
                  </ol>
                </span>
              )}
            </span>
          )}
        </div>
      ) : surface ? (
        // The dialog's head says it; above the page, the site it is on.
        <>
          <DialogHead
            sub={withAgentFace(surfaceSub, name, agentId)}
            actions={
              <>
                {!inControl && watchActs}
                {!blocker && <FullButton />}
              </>
            }
          />
          {asTitle === "ask" && <p className="cmp-asked">“{title}”</p>}
        </>
      ) : (
        <div className="brw-ac__head">
          <button type="button" className="brw-ac__tt" aria-expanded onClick={fold}>
            <span className="brw-ac__tx">
              {titleText}
              {subText}
            </span>
          </button>
          <span className="brw-ac__acts">
            {!inControl && watchActs}
            {seeWhole}
            {!blocker && <FullScreenButton full={full} onToggle={() => setFull((v) => !v)} />}
            {!full && (
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon="chevronDown"
                className="brw-ac__chev"
                aria-label={t("browser.inCard.collapse")}
                title={t("browser.inCard.collapse")}
                aria-expanded
                onClick={fold}
              />
            )}
          </span>
        </div>
      )}

      {(inControl || (surface && pic)) && (
        // Watching in the dialog, the address alone; in control, the person's to type in, like a browser's own.
        <AddressBar
          grammar={g}
          url={pageUrl}
          host={host}
          readOnly={!inControl}
          focus={inControl && goFocus}
          onOpen={openSite}
          cloud={cloud}
          end={
            inControl &&
            !touch && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                title={t("browser.inCard.pasteHint")}
                onClick={() => void pasteClipboard()}
              >
                {t("browser.inCard.paste")}
              </Button>
            )
          }
        />
      )}
      <div className={showLog ? "brw-ac__body brw-ac__body--split" : "brw-ac__body"}>
        <div className="brw-ac__stage" {...asking.stage}>
          {shows ? (
            // The agent's whole screen, scaled into the card: its browser is a window there (ADR 0058 §7). Off screen
            // its place keeps the screen's shape, so the conversation never jumps.
            screen.connect ? (
              <DesktopView
                preview
                agentId={agentId}
                name={name}
                computer={machine?.name ?? ""}
                // Only its covers read it, and the card leaves those for its frames at once.
                edition={edition ?? "selfhost"}
                machine={machine ?? null}
                canTakeOver={false}
                onView={onScreenView}
              />
            ) : (
              <div className="dsk dsk--card" aria-hidden="true">
                <div className="dsk-stage">
                  <div className="dsk-screen" />
                </div>
              </div>
            )
          ) : frame ? (
            // biome-ignore lint/a11y/noStaticElementInteractions: the page takes the person's keys while in control
            <div
              ref={pageRef}
              className={[
                "brw-ac__page",
                inControl && "is-control",
                capturing && "is-capturing",
                frame.metadata.emulated && "is-emulated",
              ]
                .filter(Boolean)
                .join(" ")}
              tabIndex={inControl ? 0 : -1}
              onKeyDown={onPageKey}
              onPointerDown={onPagePointerDown}
              onPointerMove={onPagePointerMove}
              onPointerUp={onPagePointerUp}
              onPointerCancel={onPagePointerCancel}
              onPointerLeave={onPagePointerLeave}
              onLostPointerCapture={onPagePointerCancel}
              onPaste={(e) => {
                if (!inControl) return;
                e.preventDefault();
                pasteText(e.clipboardData.getData("text/plain"));
                if (e.target === pasteRef.current) pageRef.current?.focus({ preventScroll: true });
              }}
            >
              {inControl && <textarea ref={pasteRef} className="brw-paste" tabIndex={-1} aria-hidden="true" />}
              <LivePicture frame={frame} alt={t("browser.live.page", g)} imgRef={imgRef} />
              {mark && <span key={mark.key} className="brw-mark" style={{ left: mark.x, top: mark.y }} />}
              {(sliding || scrolling) && (
                <span className="brw-ac__capture" role="status" data-esc-layer="">
                  {sliding ? t("browser.inCard.touchHint") : t("browser.inCard.scrollHint")}
                </span>
              )}
            </div>
          ) : keptSrc ? (
            <div className="brw-ac__page" aria-hidden="true">
              <img src={keptSrc} alt="" draggable={false} />
            </div>
          ) : (
            <div className="brw-ac__page brw-ac__page--blank" aria-hidden="true">
              {(starting || reconnecting || opening) && (
                <span className="brw-skel">
                  <i style={{ width: "40%" }} />
                  <i style={{ width: "70%" }} />
                  <i style={{ width: "55%" }} />
                  <i className="brw-skel__field" />
                  <i className="brw-skel__field" />
                </span>
              )}
            </div>
          )}
          {!shows && frame?.metadata.emulated && (
            <span className="brw-emu">
              {t(`browser.live.emulated.${frame.metadata.emulated}`, {
                size: `${frame.metadata.deviceWidth}×${frame.metadata.deviceHeight}`,
              })}
              {inControl && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={profile ? profileActions.open.isPending : actions.open.isPending}
                  onClick={() => void openSite({ go: "normalSize" }).catch(didntWork)}
                >
                  {t("browser.live.normalSize")}
                </Button>
              )}
            </span>
          )}
          {!shows && cover}
          {framed && !inControl && !otherInControl && (!shows || screenState === "live") && (
            <span className={confirmStop ? "brw-mf__over is-pinned" : "brw-mf__over"}>
              {watchActs}
              {seeWhole}
              {!blocker && <FullScreenButton full={full} onToggle={() => setFull(true)} />}
            </span>
          )}
        </div>
        {showLog && (
          <ol className="brw-log">
            {steps.slice(-5).map((s, i, all) => {
              const now = i === all.length - 1 && s.running;
              return (
                <li key={s.id} className={now ? "ac-iconline is-now" : "ac-iconline"}>
                  {now ? <PixelSpinner size={14} color={color} /> : <Icon name={iconOf(s.tool)} size={14} />}
                  <span>{stepText(t, s)}</span>
                  {s.since && <small>{formatTime(i18n.language, new Date(s.since).toISOString())}</small>}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {inControl &&
        (failing ? (
          <div className="brw-ac__foot brw-ac__fail">
            <Locked when={actions.failed.isPending}>
              <b>{t("browser.live.failTitle")}</b>
              <span className="small muted">{t("browser.live.failHelp", g)}</span>
              <div className="brw-reasons">
                {FAIL_REASONS.map((r) => (
                  <FilterToggle key={r} pressed={reason === r} onPressedChange={(on) => setReason(on ? r : null)}>
                    {t(`browser.live.failReasons.${r}`)}
                  </FilterToggle>
                ))}
              </div>
              <Textarea
                rows={1}
                autoGrow
                className="brw-ac__note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("browser.live.failPlaceholder")}
                maxLength={FAIL_NOTE_MAX}
              />
              <div className="brw-ac__row">
                <span className="brw-grow" />
                <Button size="sm" variant="ghost" onClick={() => setFailing(false)}>
                  {t("browser.live.back")}
                </Button>
                <Button size="sm" variant="primary" loading={actions.failed.isPending} onClick={fail}>
                  {t("browser.live.failSend", g)}
                </Button>
              </div>
            </Locked>
          </div>
        ) : touch ? (
          // One quiet field like the message composer: where the text goes, the field, Senha, Teclas, a site, send.
          <div className="brw-ac__foot brw-type">
            {keysOpen && (
              // biome-ignore lint/a11y/useSemanticElements: a small row of keys, not a form fieldset
              <div className="brw-keycaps" role="group" aria-label={t("browser.inCard.keysLabel")}>
                {KEYS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className="brw-kc"
                    aria-label={t(`browser.live.keys.${key}`)}
                    title={t(`browser.live.keys.${key}`)}
                    onClick={() => send(keyEvents(key))}
                  >
                    {KEYCAP[key]}
                  </button>
                ))}
              </div>
            )}
            <label className="brw-tfield">
              <span className={mark ? "brw-tfield__to is-marked" : "brw-tfield__to"}>
                <Icon name="pointer" size={14} />
                {mark && t("browser.inCard.targetMarked")}
              </span>
              <input
                type={secure ? "password" : "text"}
                placeholder={
                  !mark
                    ? t("browser.inCard.typePlaceholderTouch")
                    : secure
                      ? t("browser.inCard.typePlaceholderSecret")
                      : t("browser.inCard.typePlaceholder")
                }
                aria-label={t("browser.live.typeLabel")}
                autoComplete={secure ? "current-password" : "off"}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    sendText();
                  }
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon="lock"
                className="brw-tfield__tool"
                aria-pressed={secure}
                aria-label={secure ? t("browser.inCard.secureOn") : t("browser.inCard.secureOff")}
                title={secure ? t("browser.inCard.secureOn") : t("browser.inCard.secureOff")}
                onClick={() => setSecure((v) => !v)}
              />
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon="keyboard"
                className="brw-tfield__tool"
                aria-pressed={keysOpen}
                aria-label={t("browser.inCard.keysLabel")}
                title={t("browser.inCard.keysLabel")}
                onClick={() => setKeysOpen((v) => !v)}
              />
              <Button
                variant="primary"
                size="sm"
                iconOnly
                icon="send"
                className="brw-tfield__send"
                aria-label={t("browser.live.send")}
                title={t("browser.live.send")}
                disabled={!text}
                onClick={sendText}
              />
            </label>
          </div>
        ) : null)}
      {inControl && !failing && (
        <HandBackFoot
          title={profile ? t("browser.profiles.backTitle", { name: profile.name }) : t("browser.inCard.backTitle", g)}
          label={handBackLabel}
          grammar={g}
          {...(profile ? {} : { note: backNote, onNote: setBackNote })}
          noteFirst={handoffWantsWords(handoff)}
          pending={profile ? profileActions.handback.isPending : actions.done.isPending}
          onBack={finish}
          other={
            ask && (
              <Button
                size="sm"
                variant="ghost"
                disabled={actions.done.isPending}
                onClick={() => {
                  setNote((words) => words || backNote.slice(0, FAIL_NOTE_MAX));
                  setFailing(true);
                }}
              >
                {surface ? t("browser.inCard.couldnt") : t("browser.inCard.giveUp")}
              </Button>
            )
          }
        />
      )}
      {otherInControl && !hidden && (
        <div className="brw-ac__foot">
          <span className="small muted">{t("browser.inCard.otherHelp", { person: controllerName })}</span>
        </div>
      )}
    </div>
  );
}

/** Names with their faces, joined as people say them ("Ada, Bia e Atlas"). */
function FacesList({ agentIds }: { agentIds: string[] }) {
  const { i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const names = agentIds.map((id) => ({ id, name: dir.agentById.get(id)?.name ?? "" })).filter((a) => a.name);
  let next = 0;
  return (
    <>
      {new Intl.ListFormat(i18n.language).formatToParts(names.map((a) => a.name)).map((p, k) => {
        const a = p.type === "element" ? names[next++] : undefined;
        return a ? (
          <AgentWho key={a.id} agentId={a.id} name={a.name} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity of their own
          <Fragment key={k}>{p.value}</Fragment>
        );
      })}
    </>
  );
}

/** After Devolver on a profile: who may use it now. */
function ProfileDone({ agentIds }: { agentIds: string[] }) {
  const { t } = useTranslation();
  if (agentIds.length === 0) return <>{t("browser.profiles.doneNone")}</>;
  return (
    <Trans
      i18nKey={agentIds.length === 1 ? "browser.profiles.doneOne" : "browser.profiles.done"}
      components={{ names: <FacesList agentIds={agentIds} /> }}
    />
  );
}

/** The waiting box: who has the profile, and that this agent goes on by itself once they're done (2 short lines). */
function ProfileWaitCover({ wait, waiter }: { wait: BrowserProfileWait; waiter: { agentId: string; name: string } }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const holder = wait.holder;
  const holderName =
    holder.type === "agent"
      ? (dir.agentById.get(holder.agentId)?.name ?? "")
      : (dir.memberById.get(holder.userId)?.name ?? t("channel.unknownPerson"));
  const w = agentGrammar(waiter.name);
  return (
    <div className="brw-dim">
      <span className="brw-dim__box" role="status">
        <span className="brw-dim__lines">
          <span className="brw-dim__l1">
            {holder.type === "agent" ? (
              <Trans
                i18nKey="browser.profiles.waiting"
                values={{ profile: wait.name }}
                components={{ who: <AgentWho agentId={holder.agentId} name={holderName} /> }}
              />
            ) : (
              t("browser.profiles.waitingPerson", { person: holderName, profile: wait.name })
            )}
          </span>
          <small>
            <Trans
              i18nKey="browser.profiles.waitingNext"
              context={w.context}
              values={{ holder: holderName }}
              components={{ who: <AgentWho agentId={waiter.agentId} name={waiter.name} /> }}
            />
          </small>
        </span>
      </span>
    </div>
  );
}
