import type { Agent } from "@agenteschat/client";
import {
  browserOnlyWhy,
  controlledBy,
  handoffTimeLeft,
  isWaitingHandoff,
  useBrowserHandoffMutations,
  useMachineOutages,
} from "@agenteschat/client";
import {
  asksMe,
  type ComputerSurface,
  cantShow,
  entryLine,
  entryState,
  liveSubLine,
  surfaceOf,
} from "@agenteschat/client/lib/agent-computer";
import { computerName, READY_FLASH_MS, WORKSPACE_COMPUTER_KIND } from "@agenteschat/client/lib/computer";
import { clockAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { computerKind, isPaused } from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { Button, ComputerPortrait, cx, Dialog, gradientOf, Icon, SkyStrip } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { type EntrySignal, QueueButton, useAgentMachineId } from "@/components/ComputerQueue";
import { useDirectory } from "@/hooks/useDirectory";
import { useKeyboardLock } from "@/hooks/useKeyboardLock";
import { useNow } from "@/hooks/useNow";
import { lookOf } from "@/lib/look";
import { useSaid, useToast } from "@/lib/toast";
import { BrowserCard, Cover, stepText } from "../browser/BrowserCard";
import { DesktopView } from "../desktop/DesktopView";
import { SwitchComputerDialog } from "../MachineOutages";
import { useOrg } from "../org-context";
import { colorOf } from "../Sky";
import { SetupWait, useWaitReader } from "../WorkspaceComputer";
import { CantShowCover, ScreenNotice, Stage } from "./covers";
import { type AgentComputerView, useAgentComputer } from "./facts";
import { DialogHead, DialogHeadContext, type DialogHeadSlots, type KeptPicture } from "./head";
import { OpenComputerContext, OpenedComputerContext, useOpenComputer } from "./open";
import "./computer.css";

/**
 * The agent's computer in one dialog (web): watch it live, take control, hand back, full screen, close. A
 * computer with screens shows the agent's screen, its browser a window on it; one without (a Mac) the
 * agent's page; a person helping with a browser request gets the page, never the whole screen.
 */

/** How often the screen's state is asked while the dialog shows no live screen (the screen asks its own). */
const POLL_MS = 5_000;
/** While the page shows: it has a stream of its own; the screen may come on meanwhile. */
const PAGE_POLL_MS = 30_000;
/** How long the full-screen bar stays once nothing asks for it. */
const BAR_MS = 2_500;
/**
 * In control the pointer is the computer's: the bar comes back only once it rests this long at the display's top
 * edge, where it also stops on its way to the computer's own top bar.
 */
const BAR_EDGE_PX = 8;
const BAR_EDGE_MS = 500;

/**
 * Full screen fills the screen with the dialog. The page itself goes full screen, not the dialog: noVNC's
 * mouse-capture layer lives on the page's body, and outside the full-screen element it would swallow the
 * first click after leaving it (Hand back would take two clicks).
 */
function useFullScreen(full: boolean, setFull: (full: boolean) => void) {
  useEffect(() => {
    if (!full) return;
    const root = document.documentElement;
    const left = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener("fullscreenchange", left);
    if (typeof root.requestFullscreen === "function" && !document.fullscreenElement) {
      root.requestFullscreen().catch(() => {});
    }
    return () => {
      document.removeEventListener("fullscreenchange", left);
      if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
    };
  }, [full, setFull]);
}

/** What of the full-screen bar shows: all of it, the head alone, or nothing. */
type BarShown = "all" | "head" | "none";

/**
 * Full screen on the agent's screen: what shows of the dialog's head, a bar over the screen, and what floats under
 * it. All of it as full screen starts, on any pointer move or tap while watching, and on a tap in control (a phone
 * has no pointer to bring to the edge); in control, the head alone once the pointer rests at the top edge, which
 * leaves the computer's own top bar as clear as it can. It stays while the pointer is on it and hides 2.5 s after
 * the last ask. A banner, or keyboard focus in it, keeps it (computer.css).
 */
function useBar(on: boolean, control: boolean): BarShown {
  const [shown, setShown] = useState<BarShown>("all");
  useEffect(() => {
    setShown("all");
    if (!on) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let edge: ReturnType<typeof setTimeout> | undefined;
    let now: BarShown = "all";
    const show = (next: BarShown) => {
      now = next;
      setShown(next);
    };
    const hideLater = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        show("none");
      }, BAR_MS);
    };
    const moved = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.(".ac-dialog__head")) {
        clearTimeout(timer);
        timer = undefined;
        if (now === "none") show("head");
      } else if (!control || e.pointerType === "touch") {
        show("all");
        hideLater();
      } else if (e.clientY > BAR_EDGE_PX) {
        clearTimeout(edge);
        edge = undefined;
        if (now !== "none" && timer === undefined) hideLater();
      } else if (edge === undefined) {
        edge = setTimeout(() => {
          edge = undefined;
          if (now === "none") show("head");
          hideLater();
        }, BAR_EDGE_MS);
      }
    };
    hideLater();
    const opts = { capture: true, passive: true };
    document.addEventListener("pointermove", moved, opts);
    document.addEventListener("pointerdown", moved, opts);
    return () => {
      clearTimeout(timer);
      clearTimeout(edge);
      document.removeEventListener("pointermove", moved, opts);
      document.removeEventListener("pointerdown", moved, opts);
    };
  }, [on, control]);
  return on ? shown : "all";
}

/**
 * "Pronto" for a moment when the computer it was waiting for gets ready, then it opens by itself. A hold also
 * ends the wait's stage, and the computer isn't ready then.
 */
function useReadyFlash(surface: ComputerSurface | null) {
  const [flashing, setFlashing] = useState(false);
  const was = useRef(surface);
  useEffect(() => {
    if (was.current === "preparing" && surface && surface !== "preparing" && surface !== "held") setFlashing(true);
    was.current = surface;
  }, [surface]);
  useEffect(() => {
    if (!flashing) return;
    const id = setTimeout(() => setFlashing(false), READY_FLASH_MS);
    return () => clearTimeout(id);
  }, [flashing]);
  return flashing;
}

/**
 * The dialog. Closing it in control of a take over hands it back at once; the agent's own request keeps its
 * 2 minutes of grace, and says so. Full screen on the agent's screen shows that screen alone, the head a bar over
 * it. Esc: in control it goes to the computer; in full screen it leaves full screen, except in control on Chromium,
 * where holding it does; otherwise it closes.
 */
export function ComputerDialog({ agent, open, onClose }: { agent: Agent; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const actions = useBrowserHandoffMutations(org.id);
  const [poll, setPoll] = useState<number | false>(POLL_MS);
  const view = useAgentComputer(agent, { poll: open ? poll : false, runs: true });
  const surface = view.facts ? surfaceOf(view.facts) : null;
  useEffect(() => setPoll(surface === "screen" ? false : surface === "page" ? PAGE_POLL_MS : POLL_MS), [surface]);
  const [sub, setSub] = useState<HTMLElement | null>(null);
  const [acts, setActs] = useState<HTMLElement | null>(null);
  const [full, setFull] = useState(false);
  const [dismissAsk, setDismissAsk] = useState<(() => void) | null>(null);
  const setAsk = useCallback((dismiss: (() => void) | null) => setDismissAsk(() => dismiss), []);
  const picture = useRef<KeptPicture | null>(null);
  useFullScreen(full, setFull);
  const g = agentGrammar(agent.name);
  const who = { name: agent.name, appearance: lookOf(agent) };
  const handoff = view.facts?.handoff ?? null;
  const mine = controlledBy(handoff, me.user.id);
  const screenOnly = full && surface === "screen";
  const bar = useBar(screenOnly, mine);
  const locked = useKeyboardLock(screenOnly && mine);
  const color = colorOf(agent);
  // An action that failed, in place of the sub-line for a moment (`useSayFailed`).
  const { said, say } = useSaid();
  const close = () => {
    setFull(false);
    onClose();
    if (!mine || !handoff) return;
    // The dialog is gone by the time the answer comes: a promise, not the mutation's own callbacks.
    if (handoff.kind === "takeover") {
      actions.done.mutateAsync(handoff.id).then(
        () => toast.show({ text: t("browser.now.handedBack", g), who }),
        () => toast.show(t("browser.live.actionFailed"), "error"),
      );
    } else toast.show({ text: t("agentComputer.closeAsk", g), who });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && close()}
      title={t("agentComputer.title", g)}
      leading={<AgentAvatar agentId={agent.id} name={agent.name} size="sm" />}
      subtitle={
        <>
          {said && (
            <span key={said.at} className="cmp-said ac-iconline" role="alert">
              <Icon name="alert" size={14} />
              <span>{said.text}</span>
            </span>
          )}
          <span ref={setSub} className="cmp-sub" hidden={said !== null} />
        </>
      }
      actions={<span ref={setActs} className="cmp-acts ac-acts" />}
      closeLabel={t("common.close")}
      width={1280}
      className={cx(
        "cmp-dialog",
        full && "is-full",
        screenOnly && "is-screen-only",
        bar === "none" && "is-bar-hidden",
        bar !== "all" && "is-line-hidden",
      )}
      onEscapeKeyDown={(e) => {
        // Keyboard Lock in control: Esc is the computer's; holding it leaves full screen, as the browser says.
        if (locked.current && document.fullscreenElement) e.preventDefault();
        else if (full) {
          e.preventDefault();
          setFull(false);
        } else if (dismissAsk) {
          e.preventDefault();
          dismissAsk();
        } else if (mine) e.preventDefault();
      }}
    >
      <SkyStrip color={color} muted={mine} moving={Boolean(view.facts?.working) && !mine} />
      <ComputerStage
        agent={agent}
        view={view}
        surface={surface}
        slots={{ sub, actions: acts, full, setFull, setAsk, say: (text) => say(text, true), picture }}
        onLeave={close}
      />
    </Dialog>
  );
}

/**
 * What the stage shows, by `surfaceOf`, with the banners over a live one. The head's sub-line says only what a cover or
 * a banner doesn't: the window says each thing once.
 */
function ComputerStage({
  agent,
  view,
  surface,
  slots,
  onLeave,
}: {
  agent: Agent;
  view: AgentComputerView;
  surface: ComputerSurface | null;
  slots: Omit<DialogHeadSlots, "watching">;
  /** Going to the agent's page from here closes the dialog. */
  onLeave: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useBrowserHandoffMutations(org.id);
  const navigate = useNavigate();
  const outages = useMachineOutages(org.id, can(org, "manage_agents"));
  const [switching, setSwitching] = useState(false);
  // The screen's own held cover says it all: no pause line over it.
  const [screenHeld, setScreenHeld] = useState(false);
  const f = view.facts;
  const g = agentGrammar(agent.name);
  const color = colorOf(agent);
  const waitingFor = f?.handoff && isWaitingHandoff(f.handoff) ? f.handoff : null;
  const now = useNow(waitingFor ? 15_000 : false);
  const flashing = useReadyFlash(surface);
  const reader = useWaitReader();
  const machine = view.machine;
  const computer = computerName(t, org.name, machine, isPersonal(org));
  const manages = can(org, "manage_agents") || agent.ownerUserId === me.user.id;
  // Whose role gives no browser here gets Fechar, never "Assumir o navegador" (ADR 0085 §12).
  const mayBrowser = can(org, agent.ownerUserId === me.user.id ? "own_browsers" : "control_browsers");
  const person = (id: string | null) => (id ? dir.memberById.get(id)?.name : undefined) ?? t("channel.unknownPerson");
  const paused = f?.edition === "selfhost" && machine && isPaused(machine, now) ? machine.paused : null;
  const waiting = waitingFor && isWaitingHandoff(waitingFor, now) ? waitingFor : null;
  const mine = controlledBy(f?.handoff, me.user.id);
  const watching = f ? liveSubLine(t, f, { name: agent.name, person, nowMs: now }) : t("agentComputer.sub.watching");
  // A picture kept for a view that doesn't come (a cover took the stage) is for none that comes later.
  const kept = slots.picture;
  useLayoutEffect(() => {
    if (surface !== "screen" && surface !== "page") kept.current = null;
  }, [surface, kept]);
  const head: DialogHeadSlots = { ...slots, watching };
  const refused = (err: unknown) =>
    slots.say((err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.card.openFailed"));
  const help = () => waiting && actions.takeControl.mutate(waiting.id, { onError: refused });
  const takeBrowser = () => actions.takeover.mutate(agent.id, { onError: refused });
  const retry = () => void view.desktopQ.refetch();
  const canTakeOver = !f?.held && !paused && !waiting;
  const goTo = (search: { tab: "access" } | { tab: "settings"; sec: "computer" }) => {
    onLeave();
    void navigate({ to: "/org/$orgId/agents/$agentId", params: { orgId: org.id, agentId: agent.id }, search });
  };
  const openTools = () => goTo({ tab: "access" });
  const choose = () => goTo({ tab: "settings", sec: "computer" });

  // Under a cover the screen opens from by itself, the screen's line: the screen opens where its cover was. The covers
  // that stay until someone acts take its room.
  const notice = <ScreenNotice name={agent.name} />;
  let body: ReactNode;
  let steps: ReactNode = null;
  if (!f || !view.ready) {
    body = (
      <>
        <DialogHead sub="" />
        <Stage>
          <Cover color={color} sky spinner text={t("agentComputer.state.opening", g)} />
        </Stage>
        {notice}
      </>
    );
  } else if (view.forbidden) {
    body = (
      <>
        <DialogHead sub="" />
        <Stage>
          <Cover
            color={color}
            icon="lock"
            text={t(can(org, "own_browsers") ? "agentComputer.state.forbidden" : "agentComputer.state.noRole")}
          />
        </Stage>
      </>
    );
  } else if (flashing) {
    body = (
      <>
        <DialogHead sub="" />
        <Stage>
          <Cover color={color} sky icon="check" text={t("agentComputer.state.ready")} />
        </Stage>
        {notice}
      </>
    );
  } else if (surface === "held") {
    body = (
      <>
        <DialogHead sub="" />
        <Stage>
          <Cover
            color={color}
            icon="pause"
            text={t("agentComputer.state.held", g)}
            help={t("agentComputer.state.heldHelp")}
          />
        </Stage>
        {notice}
      </>
    );
  } else if (surface === "preparing" && f.setup) {
    // The head names it and says where it is; the card says only the rest.
    body = (
      <>
        <DialogHead sub={t(f.setup.chipKey)} />
        <div className="cmp-prep">
          <ComputerPortrait kind={WORKSPACE_COMPUTER_KIND} state="paused" size={96} />
          <SetupWait view={f.setup} reader={reader} said />
        </div>
      </>
    );
  } else if (surface === "screen" || surface === "page") {
    body = (
      <>
        {f.held ? (
          !(surface === "screen" && screenHeld) && (
            <Banner tone="pause" text={t("agentComputer.state.held", g)} help={t("agentComputer.state.heldHelp")} />
          )
        ) : paused ? (
          <Banner
            tone="pause"
            text={
              paused.until
                ? t("agentComputer.state.paused", { computer, time: clockAt(i18n.language, paused.until) })
                : t("agentComputer.state.pausedPlain", { computer })
            }
            help={t("machines.pausedHint")}
          />
        ) : (
          waiting && (
            <Banner
              tone="warn"
              text={
                asksMe(waiting, me.user.id)
                  ? t("agentComputer.ask.banner", {
                      ...g,
                      ask: waiting.instructions,
                      time: handoffTimeLeft(t, waiting, now) ?? "",
                    })
                  : t("agentComputer.ask.bannerOther", {
                      ...g,
                      person: person(waiting.requestedForUserId),
                      ask: waiting.instructions,
                      time: handoffTimeLeft(t, waiting, now) ?? "",
                    })
              }
              action={
                (asksMe(waiting, me.user.id) || manages) && (
                  <Button size="sm" variant="primary" loading={actions.takeControl.isPending} onClick={help}>
                    {t("agentComputer.help")}
                  </Button>
                )
              }
            />
          )
        )}
        {surface === "screen" ? (
          <DesktopView
            agentId={agent.id}
            name={agent.name}
            computer={computer}
            edition={f.edition}
            machine={machine}
            canTakeOver={canTakeOver}
            working={Boolean(f.working) && !mine}
            onHeld={setScreenHeld}
            {...(manages && mayBrowser && f.browser && !view.desktop?.canControl ? { onTakeBrowser: takeBrowser } : {})}
          />
        ) : (
          <>
            {((mine && view.desktop?.available && !view.desktop.canControl) ||
              view.desktop?.reason === "browser_only") && (
              // A computer with a screen whose browser alone this person drives: the page, labeled, not the screen.
              <Banner tone="info" text={t("desktop.browserOnly.title")} help={t(browserOnlyWhy(view.desktop), g)} />
            )}
            <BrowserCard agentId={agent.id} name={agent.name} handoff={f.handoff} surface canTakeOver={canTakeOver} />
          </>
        )}
      </>
    );
    steps = f.working && !mine && view.steps.length > 0 && (
      <ol className="cmp-steps" aria-label={t("browser.watch.title")}>
        {view.steps.slice(-3).map((s) => (
          <li key={s.id}>{stepText(t, s, s.screen)}</li>
        ))}
      </ol>
    );
  } else if (machine && !machine.online && !machine.standby) {
    const since = machine.lastSeenAt ? clockAt(i18n.language, machine.lastSeenAt) : null;
    const outage = outages.data?.outages.find((o) => o.machineId === machine.id);
    body =
      f.edition === "cloud" ? (
        <>
          <DialogHead sub={t("agentComputer.sub.notAnswering")} />
          <Stage>
            <Cover
              color={color}
              art={<ComputerPortrait kind={WORKSPACE_COMPUTER_KIND} state="offline" size={96} />}
              text={t("agentComputer.state.notAnsweringHelp")}
              help={t("desktop.state.retrying")}
            />
          </Stage>
          {notice}
        </>
      ) : (
        <>
          <DialogHead sub={since ? t("agentComputer.sub.offline", { time: since }) : t("machines.offline")} />
          <Stage>
            <Cover
              color={color}
              art={<ComputerPortrait kind={computerKind(machine.os)} state="offline" size={96} />}
              text={t("agentComputer.state.offline", { computer })}
              // The head already says since when.
              help={t("agentComputer.state.offlineHelpPlain", g)}
              action={
                manages &&
                outage &&
                outages.data && (
                  <Button size="sm" onClick={() => setSwitching(true)}>
                    {t("outage.switch")}
                  </Button>
                )
              }
            />
          </Stage>
          {notice}
          {switching && outage && outages.data && (
            <SwitchComputerDialog open onOpenChange={setSwitching} outage={outage} data={outages.data} />
          )}
        </>
      );
  } else if ((!machine && f.edition === "cloud") || (machine?.standby && !machine.online)) {
    // The workspace's computer is ready and this agent gets it at its first hello, or it wakes: a moment more.
    body = (
      <>
        <DialogHead sub="" />
        <Stage>
          <Cover color={color} sky spinner text={t("agentComputer.state.opening", g)} />
        </Stage>
        {notice}
      </>
    );
  } else if (!machine) {
    body = (
      <>
        <DialogHead sub={t("agentComputer.status.noComputer")} />
        <Stage>
          <Cover
            color={color}
            icon="computer"
            text={t("agentComputer.state.noComputer", g)}
            action={
              manages && (
                <Button size="sm" variant="primary" onClick={choose}>
                  {t("agentComputer.choose")}
                </Button>
              )
            }
          />
        </Stage>
      </>
    );
  } else if (view.desktop?.reason === "no_desktop" && !f.browserGranted) {
    body = (
      <>
        <DialogHead sub="" />
        <Stage>
          <Cover
            color={color}
            icon="dash"
            text={t("agentComputer.state.noScreen", g)}
            action={
              manages && (
                <Button size="sm" onClick={openTools}>
                  {t("agentComputer.openAccess")}
                </Button>
              )
            }
          />
        </Stage>
      </>
    );
  } else if (computerKind(machine.os) === "mac" && view.browserSettings?.reason === "switched_off") {
    // A Mac shows no screen, only the agent's page: what's missing is its browser, which only the Mac turns on.
    body = (
      <>
        <DialogHead sub="" />
        <Stage>
          <Cover
            color={color}
            icon="globe"
            text={t("agentComputer.state.browserOff", { ...g, computer })}
            help={t("browser.machine.offHelp")}
          />
        </Stage>
      </>
    );
  } else {
    body = (
      <>
        <DialogHead sub="" />
        <Stage>
          <CantShowCover
            edition={f.edition}
            machine={machine}
            computer={computer}
            name={agent.name}
            reason={view.desktop?.reason ?? null}
            detail={view.desktop?.detail ?? null}
            cause={cantShow(f)}
            color={color}
            onRetry={retry}
          />
        </Stage>
      </>
    );
  }
  return (
    <DialogHeadContext.Provider value={head}>
      <div className="cmp-body">
        {body}
        {/* Under whatever holds the screen's place, kept empty too, so nothing moves when a line comes. */}
        <div className="cmp-steps-row">{steps}</div>
      </div>
    </DialogHeadContext.Provider>
  );
}

/** A line over the live stage: the agent held, its computer paused, or a request waiting for someone. */
function Banner({
  tone,
  text,
  help,
  action,
}: {
  tone: "pause" | "warn" | "info";
  text: string;
  help?: string;
  action?: ReactNode;
}) {
  return (
    <div className="cmp-banner" data-tone={tone} role="status">
      <span className="cmp-banner__t">
        <b>{text}</b>
        {help && <span>{help}</span>}
      </span>
      {action}
    </div>
  );
}

/**
 * "Computador" in the agent's DM header: while turns wait for its computer, "Computador · 4 aguardando" opening the
 * line (with a way on to the computer for whoever may watch it), else, for whoever may watch it, the same dialog in
 * place, with a dot while the agent needs someone (amber) or works on it (its color). `queueOnly`: just that line.
 */
export function ComputerButton({ agent, queueOnly }: { agent: Agent; queueOnly?: boolean }) {
  const view = useAgentComputer(agent);
  const openComputer = useOpenComputer();
  const signal = useEntrySignal(agent, view);
  const watch = view.ready && !view.forbidden && view.facts;
  return (
    <QueueButton
      machineId={useAgentMachineId(agent.id)}
      signal={watch ? signal : undefined}
      idle={watch && !queueOnly ? <WatchButton agent={agent} signal={signal} /> : null}
      onOpenComputer={watch ? () => openComputer(agent.id) : undefined}
    />
  );
}

/** What the DM header's computer button signals: its dot's state and the line a screen reader hears with it. */
function useEntrySignal(agent: Agent, view: AgentComputerView): EntrySignal {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const f = view.facts;
  if (!f) return {};
  const entry = entryState(f);
  const state =
    entry.kind === "needsYou" || entry.kind === "needsOther"
      ? "waiting"
      : entry.kind === "working" || entry.kind === "you" || entry.kind === "other"
        ? "live"
        : undefined;
  if (!state) return {};
  return {
    state,
    style: state === "live" ? ({ "--dot": gradientOf(colorOf(agent))[0] } as CSSProperties) : undefined,
    line: entryLine(t, entry, {
      edition: f.edition,
      locale: i18n.language,
      computer: computerName(t, org.name, view.machine, isPersonal(org)),
      lastSeenAt: null,
      person: (id) => dir.memberById.get(id)?.name ?? t("channel.unknownPerson"),
      step: null,
      emailPromised: false,
    }),
  };
}

function WatchButton({ agent, signal }: { agent: Agent; signal: EntrySignal }) {
  const { t } = useTranslation();
  const openComputer = useOpenComputer();
  return (
    <Button
      size="sm"
      icon="computer"
      className="brw-dm"
      data-state={signal.state}
      style={signal.style}
      onClick={() => openComputer(agent.id)}
    >
      <span className="brw-dm__label">{t("agentComputer.button")}</span>
      {signal.line && <span className="ac-visually-hidden">{signal.line}</span>}
    </Button>
  );
}

/**
 * One computer dialog for the workspace: its agent page's entry, the DM's button, a computer's page and the
 * chat's cards open an agent's computer here, in place.
 */
export function ComputerDialogProvider({ children }: { children: ReactNode }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [agentId, setAgentId] = useState<string | null>(null);
  const agent = agentId ? dir.agentById.get(agentId) : undefined;
  const close = useCallback(() => setAgentId(null), []);
  return (
    <OpenComputerContext.Provider value={setAgentId}>
      <OpenedComputerContext.Provider value={agent ? agent.id : null}>{children}</OpenedComputerContext.Provider>
      {agent && <ComputerDialog key={agent.id} agent={agent} open onClose={close} />}
    </OpenComputerContext.Provider>
  );
}
