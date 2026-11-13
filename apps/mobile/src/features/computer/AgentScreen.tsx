import {
  askControlWords,
  type DesktopMode,
  type DesktopViewState,
  desktopMode,
  desktopStatusState,
  desktopSwitch,
  handoffIsMine,
  handoffScreen,
  isWaitingHandoff,
  type LiveRun,
  type ScreenStep,
  screenSteps,
  useApi,
  useBrowserHandoffActions,
} from "@agenteschat/client";
import { liveSubLine } from "@agenteschat/client/lib/agent-computer";
import { computerName } from "@agenteschat/client/lib/computer";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { type AgentColorName, bodyTones } from "@agenteschat/ui/agent/engine";
import { Canvas, Fill, Shader, Skia } from "@shopify/react-native-skia";
import * as Clipboard from "expo-clipboard";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, type LayoutChangeEvent, ScrollView, StyleSheet, TextInput, View } from "react-native";
import {
  GestureDetector,
  useLongPressGesture,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from "react-native-gesture-handler";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { useServer } from "@/lib/server";
import { readValue, STORED, writeValue } from "@/lib/storage";
import { useAppActive } from "@/lib/useAppActive";
import { useOrg } from "@/providers/org";
import { rgba } from "@/sky/math";
import { TRACKPAD_SHADER } from "@/sky/shaders";
import {
  Button,
  Composer,
  Glass,
  haptics,
  Icon,
  IconButton,
  PressScale,
  type SendHow,
  Text,
  useReducedMotion,
  useTheme,
  useToast,
} from "@/ui";
import { useInfoHint } from "@/ui/InfoHint";
import { useNotNow } from "../browser/HandoffCard";
import { keyPastDraft } from "../browser/logic";
import { TypeBar } from "../browser/parts";
import { useFinishHandoff } from "../browser/useFinishHandoff";
import { AskButtons, AskCard, AskFoot, ExpiryLine } from "../chat/asks";
import { mayStopRun } from "../chat/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { successHaptic, tapHaptic } from "../shared/parts";
import { useActiveWork } from "../shared/queries";
import { Cover } from "./Cover";
import { DOCK_HANG, DockDone, DockIcon, DockRule, DockText, EdgeDock } from "./EdgeDock";
import { LiveTrail } from "./LiveTrail";
import { PixelCursor } from "./PixelCursor";
import { reportStuck, ScreenPage, type ScreenPageHandle } from "./ScreenPage";
import {
  BUTTON,
  PointerLine,
  SCREEN_ROW_KEYS,
  type ScreenKey,
  type ScreenRowKey,
  screenWaits,
  typedSince,
} from "./screen-page";
import {
  atDesktopEdge,
  boundCamera,
  clamp,
  controlScale,
  cursorGain,
  DEFAULT_DESKTOP,
  DRAG_REST,
  type DragEvent,
  dragStep,
  dragView,
  fitScale,
  followCursor,
  keepView,
  lookAt,
  MAX_SCALE,
  type Size,
  toDesktop,
  WHEEL_STEP,
  zoomCamera,
} from "./screen-view";
import { type PadLesson, padLesson } from "./trackpad";
import type { AgentComputerView } from "./useAgentComputer";
import { useSideways } from "./useSideways";

/** How long the screen may stay opening before it says it can't: a socket refused before it opens never closes with a code. */
const STUCK_MS = 30_000;
/** The trackpad's height: a thumb's reach, the rest goes to the screen. */
const PAD_HEIGHT = 224;
/** Points between the trackpad's dots. */
const DOT_GAP = 9;
/** How long a press holds before it drags. */
const HOLD_MS = 320;
/** Points a finger goes before the trackpad follows it: enough that a tap's small roll doesn't move the cursor. */
const SWIPE_START = 3;
/** The closest two ticks of the wheel come under the fingers: faster, the phone only buzzes. */
const NOTCH_HAPTIC_MS = 45;
/** How long the sideways dock stays clear after a touch, and how faint it rests over the picture. */
const DOCK_AWAKE_MS = 2600;
const DOCK_REST = 0.32;
/** Where the finger's ring grows to around a click. */
const RING_GROWTH = 3.2;
const CAMERA = { duration: 260 };

/** Everything the camera and the cursor share across the gestures, on the UI thread. */
interface Camera {
  s: SharedValue<number>;
  x: SharedValue<number>;
  y: SharedValue<number>;
  cursorX: SharedValue<number>;
  cursorY: SharedValue<number>;
  box: SharedValue<Size>;
  desk: SharedValue<Size>;
}

/** The lesson's cursor, on top of the real one. */
interface Ghost {
  x: number;
  y: number;
  scale: number;
}
const GHOST_REST: Ghost = { x: 0, y: 0, scale: 1 };

/** Compiled once; null if the device refuses it (the pad still works, plain). */
let padEffect: ReturnType<typeof Skia.RuntimeEffect.Make> | undefined;
function trackpadEffect() {
  if (padEffect === undefined) {
    try {
      padEffect = Skia.RuntimeEffect.Make(TRACKPAD_SHADER);
    } catch {
      padEffect = null;
    }
  }
  return padEffect;
}

/**
 * The agent's screen on the phone (ADR 0098), as the web's `DesktopView`: live, watched, or in this person's control.
 * The server's page draws it in a WebView as large as the desktop, moved and zoomed by the UI thread; no touch ever
 * reaches the page. In control the trackpad moves a cursor the app draws, and the view follows it; with the phone
 * sideways the picture fills it and the finger is the mouse. Leaving the app lets go of the stream and the control's 2
 * minutes run, as for any person who drops; coming back opens it again.
 */
export function AgentScreen({
  agentId,
  view,
  run,
  canTakeOver,
  banner,
  top,
}: {
  agentId: string;
  view: AgentComputerView;
  run: LiveRun | null;
  /** No hold or pause on it (the server still decides who may). */
  canTakeOver: boolean;
  /** The agent held or its computer paused. */
  banner: ReactNode;
  top: (sub: string, action: ReactNode, info?: ReactNode) => ReactNode;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { org, orgId } = useOrg();
  const dir = useDirectory();
  const toast = useToast();
  const server = useServer();
  const api = useApi();
  const actions = useBrowserHandoffActions(orgId);
  const active = useAppActive();
  const now = useNow(15_000);
  const f = view.facts;
  const status = view.desktopQ.data ?? null;
  const userId = f?.userId ?? "";
  const agent = dir.agentById.get(agentId);
  const name = agent?.name ?? "";
  const g = agentGrammar(name);

  const web = useRef<ScreenPageHandle>(null);
  const [life, setLife] = useState(0);
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState<DesktopViewState>("connecting");
  const [stuck, setStuck] = useState(false);
  // How far the page got, for the report of a screen that never opens.
  const pageNow = useRef({ ready, page, status: view.desktopQ.status });
  pageNow.current = { ready, page, status: view.desktopQ.status };
  const [taking, setTaking] = useState(false);
  // The mode of the stream's session now, as the page says it (`session`): a switch's cover waits for it.
  const [session, setSession] = useState<DesktopMode | null>(null);
  const [asking, setAsking] = useState(false);
  // Typing: straight onto the screen, or a whole password in the app's field (the system's autofill works there).
  const [typing, setTyping] = useState<"screen" | "password" | null>(null);
  const [boxSize, setBoxSize] = useState<Size>({ width: 0, height: 0 });
  const [deskSize, setDeskSize] = useState<Size>(DEFAULT_DESKTOP);

  const blocked = status ? desktopStatusState(status, userId) : "connecting";
  const mode = status ? desktopMode(status, userId) : "watch";
  const inControl = mode === "control";
  const sideways = useSideways(inControl);
  const wide = sideways.wide;
  const reduced = useReducedMotion();
  const connect = blocked === null && active;
  const shown: DesktopViewState = blocked ?? page;
  const live = shown === "live";

  const line = useRef(new PointerLine((x, y, buttons) => web.current?.call("pointer", x, y, buttons))).current;
  useEffect(() => () => line.stop(), [line]);

  useEffect(() => {
    if (ready) web.current?.call("set", { connect, mode });
  }, [ready, connect, mode]);

  const s = useSharedValue(0.25);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const cursorX = useSharedValue(DEFAULT_DESKTOP.width / 2);
  const cursorY = useSharedValue(DEFAULT_DESKTOP.height / 2);
  const box = useSharedValue<Size>({ width: 0, height: 0 });
  const desk = useSharedValue<Size>(DEFAULT_DESKTOP);
  const nudge = useSharedValue(1);
  const ghost = useSharedValue<Ghost>(GHOST_REST);
  const camera: Camera = { s, x, y, cursorX, cursorY, box, desk };

  // Typing on the screen, a tap there clicks: it picks the field the keys go to.
  const typingNow = useSharedValue(false);
  // The keyboard coming or going resizes the box under the view the person has: from then on, until the mode, the
  // phone's side or the desktop changes, a new size keeps their zoom instead of framing the screen again.
  const framed = useRef({ key: "", keep: false, typing: null as typeof typing });
  useEffect(() => {
    typingNow.value = typing !== null;
    if (typing !== framed.current.typing) framed.current = { ...framed.current, typing, keep: true };
  }, [typing, typingNow]);

  // The whole screen to watch; in control the box filled, around the cursor.
  useEffect(() => {
    if (boxSize.width === 0 || boxSize.height === 0) return;
    box.value = boxSize;
    desk.value = deskSize;
    const key = `${inControl}:${wide}:${deskSize.width}x${deskSize.height}`;
    if (key !== framed.current.key) framed.current = { ...framed.current, key, keep: false };
    const cursor = { x: cursorX.value, y: cursorY.value };
    let scale: number;
    let to: { x: number; y: number };
    if (inControl && framed.current.keep) {
      const kept = keepView({ x: x.value, y: y.value }, s.value, cursor, boxSize, deskSize);
      scale = kept.s;
      to = kept.camera;
    } else {
      scale = inControl ? controlScale(boxSize, deskSize) : fitScale(boxSize, deskSize);
      to = lookAt(cursor, scale, boxSize, deskSize);
    }
    s.value = withTiming(scale, CAMERA);
    x.value = withTiming(to.x, CAMERA);
    y.value = withTiming(to.y, CAMERA);
  }, [boxSize, deskSize, inControl, wide, box, desk, cursorX, cursorY, s, x, y]);

  const handoff = f?.handoff ?? null;
  const waiting = handoff && isWaitingHandoff(handoff, now) ? handoff : null;
  // Whose it is goes by ids, the same rule as the request's card: its owner and who controls computers may help too.
  const mine = waiting !== null && handoffIsMine(waiting, userId, agent?.ownerUserId, org);
  const ask = inControl && handoff?.kind === "ask";
  const doneLabel = ask ? t("mobile.browser.live.done") : t("mobile.browser.live.handBack");
  const { handBack, leaveNote, couldnt, finishing } = useFinishHandoff(
    inControl ? handoff : null,
    name,
    doneLabel,
    () => view.desktopQ.refetch(),
  );
  // Taking or handing back, the last picture stays under what is happening, as on the web: never a cold cover.
  const switching = desktopSwitch({
    taking,
    returning: finishing,
    mode: taking ? "control" : finishing ? "watch" : mode,
    session,
  });
  // Opening, or a switch the stream never takes: past `STUCK_MS` it says so, with Tentar de novo.
  const waitsOn = screenWaits({ active, shown, switching: switching !== null });
  useEffect(() => {
    if (!waitsOn) {
      setStuck(false);
      return;
    }
    const id = setTimeout(() => {
      setStuck(true);
      reportStuck("computer", agentId, pageNow.current);
    }, STUCK_MS);
    return () => clearTimeout(id);
  }, [waitsOn, agentId]);
  const lost = stuck && waitsOn;
  const words = askControlWords(status, Boolean(f?.browser), Boolean(run));
  // Watching, a tap on the screen asks before control and reaches nothing there; the question stays until Cancelar.
  const offer = live && !inControl && !switching && !status?.controllerUserId && !waiting && canTakeOver;
  useEffect(() => {
    if (!offer) setAsking(false);
  }, [offer]);

  // Pressed through a `Button` or the dock's `PressScale`, which give the press's haptic.
  const take = async () => {
    setTaking(true);
    try {
      if (waiting) await actions.takeControl(waiting.id);
      else if (status?.canControl) await actions.takeover(agentId, run?.runId, "desktop");
      // Whoever may take over the agent's browser but not its screen takes the browser, as on the web.
      else await actions.takeover(agentId, run?.runId);
      await view.desktopQ.refetch();
      successHaptic();
    } catch (err) {
      const busy = (err as { status?: number }).status === 409;
      toast({ title: busy ? t("browser.card.busy") : t("mobile.app.failed"), icon: "x" });
    } finally {
      setTaking(false);
    }
  };

  const person = (id: string) => dir.nameOf({ type: "person", id }) || t("channel.unknownPerson");
  const sub = inControl
    ? t(ask ? "desktop.sub.controlAsked" : "desktop.sub.control", g)
    : shown === "hidden"
      ? t("desktop.sub.hidden", { person: status?.controllerUserId ? person(status.controllerUserId) : "" })
      : live && f
        ? liveSubLine(t, f, { name, person, nowMs: now })
        : "";

  // What can be done with the screen now, on the capsule across its bottom edge (sideways, the side dock has it):
  // in control the keyboard, laying it down, a note and the way out; watching, taking control.
  const mayTake = live && !status?.controllerUserId && !waiting && canTakeOver && words.mayTake;
  // What taking control means, behind an ⓘ (ADR 0076): it leads the capsule, as on the sideways dock, and its words
  // open under the header.
  const notice = useInfoHint({
    name: t("common.about", { label: t("desktop.session.check") }),
    text: `${t("desktop.control.notice", g)}${f?.edition === "cloud" ? ` ${t("desktop.session.screening")}` : ""}`,
    variant: "footnote",
  });
  const dock = inControl ? (
    <>
      <View style={styles.dockInfo}>{notice.button}</View>
      <DockIcon icon="keyboard" label={t("desktop.keyboard.label")} onPress={() => setTyping("screen")} />
      <DockIcon icon="expand" label={t("agentComputer.phone.turn")} onPress={sideways.lieDown} />
      {ask ? <DockIcon icon="x" label={t("mobile.browser.live.couldnt")} onPress={couldnt} /> : null}
      <DockIcon icon="compose" label={t("browser.inCard.addNote")} onPress={leaveNote} />
      <DockRule />
      <DockDone label={doneLabel} loading={finishing} onPress={handBack} />
    </>
  ) : mayTake ? (
    <DockText
      icon="person"
      label={words.browserOnly ? t("desktop.takeBrowser") : t("desktop.takeover")}
      loading={taking}
      onPress={() => void take()}
    />
  ) : null;
  const docked = dock !== null && !wide;

  // A request on this screen is the chat's request card, under the screen: Ajudar and Agora não for whom it asks.
  const notNow = useNotNow(waiting);
  const askCard = waiting ? (
    <AskCard
      id={waiting.id}
      kind={handoffScreen(waiting) === "desktop" ? "desktop" : "browser"}
      agentId={agentId}
      waitsFor={
        mine
          ? "you"
          : waiting.requestedForUserId
            ? t("ask.waitingFor", { name: person(waiting.requestedForUserId) })
            : null
      }
      lead={waiting.instructions}
      expiry={waiting.expiresAt ? <ExpiryLine createdAt={waiting.createdAt} expiresAt={waiting.expiresAt} /> : null}
      foot={
        mine ? (
          <AskFoot>
            <AskButtons
              primary={
                <Button
                  variant="primary"
                  size="card"
                  wide
                  label={t("agentComputer.help")}
                  loading={taking}
                  onPress={() => void take()}
                />
              }
              secondary={<Button variant="secondary" size="card" wide label={t("approval.notNow")} onPress={notNow} />}
            />
          </AskFoot>
        ) : null
      }
    />
  ) : null;

  const retry = () => {
    setStuck(false);
    setPage("connecting");
    if (ready) web.current?.call("retry");
    else setLife((n) => n + 1);
    void view.desktopQ.refetch();
  };
  const again = <DockText label={t("desktop.retry")} onPress={retry} />;
  const { color } = agentLook(agent);
  const tones = bodyTones(color);
  const opening = <Cover fill sky spinner color={color} text={t("agentComputer.state.opening", g)} />;
  const cantShow = (
    <Cover
      fill
      icon="eyeoff"
      text={t("agentComputer.state.unavailable", g)}
      help={t("agentComputer.state.unavailableHelp")}
      action={again}
    />
  );
  const computer = computerName(t, org?.name ?? "", view.machine, isPersonal(org));
  const askCover = (
    <Cover
      fill
      clear
      color={color}
      icon={words.mayTake ? "person" : "eye"}
      text={t(words.title)}
      help={words.help ? t(words.help, g) : undefined}
      action={
        <View style={styles.askActs}>
          {words.mayTake ? (
            <Button
              variant="primary"
              size="sm"
              icon="person"
              label={words.browserOnly ? t("desktop.takeBrowser") : t("desktop.takeover")}
              loading={taking}
              onPress={() => void take()}
            />
          ) : null}
          <Button
            variant="text"
            size="sm"
            label={words.mayTake ? t("common.cancel") : t("common.close")}
            onPress={() => setAsking(false)}
          />
        </View>
      }
    />
  );
  const covers: Record<Exclude<DesktopViewState, "live">, ReactNode> = {
    connecting: stuck ? cantShow : opening,
    hidden: <Cover fill icon="eyeoff" text={t("browser.inCard.hiddenHelp", g)} />,
    offline: (
      <Cover
        fill
        sky
        spinner
        color={color}
        text={t("agentComputer.state.opening", g)}
        help={t("desktop.state.retrying")}
      />
    ),
    busy: <Cover fill spinner color={color} text={t("desktop.state.busy")} help={t("desktop.state.retrying")} />,
    noRoom: <Cover fill icon="clock" text={t("agentComputer.state.noRoom", { computer })} action={again} />,
    paused: <Cover fill icon="pause" text={t("agentComputer.state.pausedPlain", { computer })} />,
    held: <Cover fill icon="pause" text={t("agentComputer.state.held", g)} help={t("agentComputer.state.heldHelp")} />,
    forbidden: <Cover fill icon="lock" text={t("agentComputer.state.forbidden")} />,
    outdated: <Cover fill icon="eyeoff" text={t("agentComputer.state.outdated", { ...g, computer })} />,
    unavailable: cantShow,
    ended: <Cover fill icon="eyeoff" text={t("desktop.state.ended")} action={again} />,
  };

  const frame = useAnimatedStyle(() => ({
    transform: [{ scale: s.value }, { translateX: -x.value }, { translateY: -y.value }],
  }));
  const pointer = useAnimatedStyle(() => ({
    transform: [
      { translateX: (cursorX.value - x.value) * s.value + ghost.value.x },
      { translateY: (cursorY.value - y.value) * s.value + ghost.value.y },
      { scale: nudge.value * ghost.value.scale },
    ],
  }));

  const moved = (px: number, py: number) => line.move(px, py);
  const pointed = (px: number, py: number) => {
    haptics.selection();
    line.move(px, py);
  };
  const clicked = () => {
    tapHaptic();
    line.click(cursorX.value, cursorY.value);
  };
  const held = (down: boolean) => {
    if (down) haptics.medium();
    else haptics.light();
    line.press(cursorX.value, cursorY.value, down ? BUTTON.left : BUTTON.none);
  };
  /** A tap with the finger as the mouse: the cursor goes there, then clicks. */
  const touched = (px: number, py: number) => {
    tapHaptic();
    line.move(px, py);
    line.click(px, py);
  };
  const lastNotch = useRef(0);
  const wheeled = (down: boolean) => {
    const at = Date.now();
    if (at - lastNotch.current >= NOTCH_HAPTIC_MS) {
      lastNotch.current = at;
      haptics.selection();
    }
    line.click(cursorX.value, cursorY.value, down ? BUTTON.wheelDown : BUTTON.wheelUp);
  };

  const pinchFrom = useSharedValue(1);
  const pinch = usePinchGesture({
    onBegin: () => {
      "worklet";
      pinchFrom.value = s.value;
    },
    onUpdate: (e) => {
      "worklet";
      const next = clamp(pinchFrom.value * e.scale, fitScale(box.value, desk.value), MAX_SCALE);
      const to = zoomCamera(
        { x: x.value, y: y.value },
        s.value,
        next,
        { x: e.focalX, y: e.focalY },
        box.value,
        desk.value,
      );
      s.value = next;
      x.value = to.x;
      y.value = to.y;
    },
  });
  const moveCamera = (changeX: number, changeY: number) => {
    "worklet";
    const to = boundCamera(x.value - changeX / s.value, y.value - changeY / s.value, s.value, box.value, desk.value);
    x.value = to.x;
    y.value = to.y;
  };
  const panView = usePanGesture({
    enabled: !wide,
    maxPointers: 2,
    onUpdate: (e) => {
      "worklet";
      moveCamera(e.changeX, e.changeY);
    },
  });
  const askTap = useTapGesture({
    enabled: offer,
    onDeactivate: (e) => {
      "worklet";
      if (!e.canceled) scheduleOnRN(setAsking, true);
    },
  });
  // A tap on the screen brings the cursor there; the trackpad clicks. Typing, the trackpad is under the keyboard: the
  // tap clicks there too, so a field can be picked without closing it.
  const tapView = useTapGesture({
    enabled: inControl && !wide,
    onDeactivate: (e) => {
      "worklet";
      if (e.canceled) return;
      const to = toDesktop({ x: e.x, y: e.y }, { x: x.value, y: y.value }, s.value, desk.value);
      cursorX.value = to.x;
      cursorY.value = to.y;
      if (typingNow.value) scheduleOnRN(touched, to.x, to.y);
      else scheduleOnRN(pointed, to.x, to.y);
    },
  });

  // Sideways the finger is the mouse: it acts where it touches, and the cursor stays out of its way.
  const dockShown = useSharedValue(1);
  const spotX = useSharedValue(0);
  const spotY = useSharedValue(0);
  const spotOn = useSharedValue(0);
  const spotHeld = useSharedValue(0);
  const ringX = useSharedValue(0);
  const ringY = useSharedValue(0);
  const ringT = useSharedValue(1);
  const dragging = useSharedValue(false);
  const notches = useSharedValue(0);
  const wake = () => {
    "worklet";
    if (reduced) return;
    dockShown.value = withSequence(
      withTiming(1, { duration: 160 }),
      withDelay(DOCK_AWAKE_MS, withTiming(DOCK_REST, { duration: 250 })),
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dock wakes as the view lies down
  useEffect(() => {
    if (wide) wake();
  }, [wide]);
  const pointAt = (px: number, py: number) => {
    "worklet";
    const to = toDesktop({ x: px, y: py }, { x: x.value, y: y.value }, s.value, desk.value);
    cursorX.value = to.x;
    cursorY.value = to.y;
    scheduleOnRN(moved, to.x, to.y);
  };
  // A hold, or a touch soon after a tap that moves, presses where the finger is; the lift lets go (`dragStep`).
  const touchDrag = useSharedValue(DRAG_REST);
  const touchStep = (event: DragEvent) => {
    "worklet";
    const { drag, act } = dragStep(touchDrag.value, event, Date.now());
    touchDrag.value = drag;
    dragging.value = drag.touch === "down";
    if (act === "press") {
      spotHeld.value = withTiming(1, { duration: 120 });
      scheduleOnRN(held, true);
    } else if (act === "release") {
      spotHeld.value = withTiming(0, { duration: 120 });
      scheduleOnRN(held, false);
    }
    return act;
  };
  const touchTap = useTapGesture({
    enabled: wide,
    maxDuration: 260,
    maxDistance: 8,
    onDeactivate: (e) => {
      "worklet";
      if (e.canceled) return;
      // A touch that pressed already clicked by letting go.
      if (touchStep("tap") !== "click") return;
      const to = toDesktop({ x: e.x, y: e.y }, { x: x.value, y: y.value }, s.value, desk.value);
      cursorX.value = to.x;
      cursorY.value = to.y;
      ringX.value = e.x;
      ringY.value = e.y;
      ringT.value = 0;
      ringT.value = withTiming(1, { duration: 420 });
      scheduleOnRN(touched, to.x, to.y);
    },
  });
  const touchHold = useLongPressGesture({
    enabled: wide,
    minDuration: HOLD_MS,
    maxDistance: 8,
    onActivate: (e) => {
      "worklet";
      pointAt(e.x, e.y);
      touchStep("hold");
    },
  });
  // One finger rolls what it touches: the view first, then the page, wherever the finger came down.
  const touchPan = usePanGesture({
    enabled: wide,
    maxPointers: 1,
    minDistance: SWIPE_START,
    onBegin: (e) => {
      "worklet";
      wake();
      spotX.value = e.x;
      spotY.value = e.y;
      spotOn.value = withTiming(1, { duration: 80 });
      touchStep("touch");
    },
    onActivate: (e) => {
      "worklet";
      notches.value = 0;
      pointAt(e.x, e.y);
      touchStep("move");
    },
    onUpdate: (e) => {
      "worklet";
      spotX.value = e.x;
      spotY.value = e.y;
      if (dragging.value) return pointAt(e.x, e.y);
      const went = dragView({ x: x.value, y: y.value }, s.value, { x: e.changeX, y: e.changeY }, box.value, desk.value);
      x.value = went.camera.x;
      y.value = went.camera.y;
      notches.value += went.left;
      if (Math.abs(notches.value) < WHEEL_STEP) return;
      const down = notches.value > 0;
      notches.value += down ? -WHEEL_STEP : WHEEL_STEP;
      scheduleOnRN(wheeled, down);
    },
    onFinalize: () => {
      "worklet";
      spotOn.value = withTiming(0, { duration: 160 });
      touchStep("lift");
    },
  });
  const touchMove = usePanGesture({
    enabled: wide,
    minPointers: 2,
    maxPointers: 2,
    onBegin: () => {
      "worklet";
      wake();
    },
    onUpdate: (e) => {
      "worklet";
      moveCamera(e.changeX, e.changeY);
    },
  });
  const viewGestures = useSimultaneousGestures(
    pinch,
    panView,
    askTap,
    tapView,
    touchTap,
    touchHold,
    touchPan,
    touchMove,
  );
  const spot = useAnimatedStyle(() => ({
    opacity: spotOn.value,
    transform: [{ translateX: spotX.value }, { translateY: spotY.value }, { scale: 1 + 0.28 * spotHeld.value }],
  }));
  const ring = useAnimatedStyle(() => ({
    opacity: 1 - ringT.value,
    transform: [
      { translateX: ringX.value },
      { translateY: ringY.value },
      { scale: 1 + (RING_GROWTH - 1) * ringT.value },
    ],
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBoxSize({ width, height });
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.fill}>
      {wide ? null : top(sub, null)}
      {inControl && !wide ? <View style={styles.notice}>{notice.text}</View> : null}
      {wide ? null : banner}
      {/* The screen and, across its bottom edge, the capsule (it hangs past the screen into this view's margin). */}
      <View style={[inControl || wide ? styles.fill : styles.stage, docked && styles.docked]}>
        <View
          onLayout={onLayout}
          style={[
            styles.box,
            inControl ? styles.fill : { aspectRatio: deskSize.width / deskSize.height, flexGrow: 0, flexShrink: 1 },
            wide && styles.boxWide,
          ]}
          accessibilityRole="image"
          accessibilityLabel={t("agentComputer.screen", g)}
          accessibilityHint={wide ? t("agentComputer.phone.touchHint") : undefined}
        >
          <GestureDetector gesture={viewGestures}>
            <Animated.View style={StyleSheet.absoluteFill} collapsable={false}>
              <Animated.View
                pointerEvents="none"
                style={[{ width: deskSize.width, height: deskSize.height }, styles.frame, frame]}
              >
                <ScreenPage
                  key={life}
                  ref={web}
                  server={server}
                  orgId={orgId}
                  agentId={agentId}
                  onEvent={(event) => {
                    if (event.type === "ready") setReady(true);
                    else if (event.type === "view") setPage(event.state);
                    else if (event.type === "session") setSession(event.mode);
                    else if (event.type === "size") setDeskSize({ width: event.width, height: event.height });
                    else if (event.type === "changed") void view.desktopQ.refetch();
                    else toast({ title: t("desktop.clipboard.tooLong", g), icon: "x" });
                  }}
                  onGone={() => {
                    setReady(false);
                    setSession(null);
                    setLife((n) => n + 1);
                  }}
                />
              </Animated.View>
              {inControl && !wide ? (
                <Animated.View pointerEvents="none" style={[styles.cursor, pointer]}>
                  <PixelCursor />
                </Animated.View>
              ) : null}
            </Animated.View>
          </GestureDetector>
          {lost ? (
            cantShow
          ) : switching && (live || shown === "connecting") ? (
            <Cover
              fill
              clear
              spinner
              color={color}
              text={switching === "taking" ? t("desktop.taking") : t("desktop.returning", g)}
            />
          ) : live ? (
            asking && offer && askCover
          ) : (
            covers[shown]
          )}
          {wide ? (
            <>
              <Animated.View pointerEvents="none" style={[styles.spot, { borderColor: tones[3] }, spot]}>
                <View style={[styles.spotFill, { backgroundColor: tones[3] }]} />
              </Animated.View>
              <Animated.View pointerEvents="none" style={[styles.ring, { borderColor: tones[3] }, ring]} />
              {banner ? <View style={[styles.wideBanner, { left: insets.left + 10 }]}>{banner}</View> : null}
              <TouchDock
                shown={dockShown}
                right={insets.right + 10}
                notice={notice}
                onKeyboard={() => setTyping("screen")}
                onUpright={sideways.forced ? sideways.standUp : undefined}
                onCouldnt={ask ? couldnt : undefined}
                onNote={leaveNote}
                onDone={handBack}
                doneLabel={doneLabel}
              />
            </>
          ) : null}
        </View>
        {docked ? <EdgeDock>{dock}</EdgeDock> : null}
      </View>
      {inControl ? (
        typing ? (
          <ScreenKeys
            password={typing === "password"}
            label={t("desktop.keyboard.field", g)}
            bottom={insets.bottom}
            sides={wide ? Math.max(insets.left, insets.right) : 0}
            onText={(text) => web.current?.call("type", text)}
            onKey={(k) => web.current?.call("key", k)}
            onPassword={() => setTyping("password")}
            onClose={() => {
              setTyping(null);
              Keyboard.dismiss();
            }}
          />
        ) : wide ? null : (
          <View style={[styles.control, { paddingBottom: insets.bottom + 12 }]}>
            <Trackpad
              camera={camera}
              nudge={nudge}
              ghost={ghost}
              color={color}
              onMove={moved}
              onClick={clicked}
              onHold={held}
              onWheel={wheeled}
              onEdge={haptics.firm}
            />
          </View>
        )
      ) : (
        <Watching
          agentId={agentId}
          name={name}
          color={color}
          run={run}
          request={askCard}
          steps={screenSteps(run?.work)}
          api={api}
          bottom={insets.bottom}
        />
      )}
    </KeyboardAvoidingView>
  );
}

/**
 * The person's fingers as a laptop's trackpad: swipe moves, tap clicks, hold or tap and touch again drags, two fingers
 * scroll. No words: the dots answer the fingers, and until the first touch a pixel finger shows the gestures.
 */
function Trackpad({
  camera,
  nudge,
  ghost,
  color,
  onMove,
  onClick,
  onHold,
  onWheel,
  onEdge,
}: {
  camera: Camera;
  /** The cursor's scale: it answers a click or a hold. */
  nudge: SharedValue<number>;
  /** The lesson's cursor, drawn only: it never moves the real one. */
  ghost: SharedValue<Ghost>;
  color: Parameters<typeof bodyTones>[0];
  onMove: (x: number, y: number) => void;
  onClick: () => void;
  onHold: (down: boolean) => void;
  onWheel: (down: boolean) => void;
  /** The cursor just reached the desktop's edge. */
  onEdge: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  const { s, x, y, cursorX, cursorY, box, desk } = camera;
  const wheel = useSharedValue(0);
  const edge = useSharedValue(false);
  const [holding, setHolding] = useState(false);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const padSize = useSharedValue<Size>({ width: 0, height: 0 });
  const demo = useSharedValue<PadLesson | null>(null);
  const taught = useSharedValue(false);
  const spotX = useSharedValue(0);
  const spotY = useSharedValue(0);
  const tailX = useSharedValue(0);
  const tailY = useSharedValue(0);
  const spread = useSharedValue(0);
  const on = useSharedValue(0);
  const ringX = useSharedValue(0);
  const ringY = useSharedValue(0);
  const ringT = useSharedValue(-1);

  const lesson = useFrameCallback((f) => {
    if (taught.value) return;
    const l = padLesson(f.timeSinceFirstFrame / 1000, padSize.value.width, padSize.value.height);
    demo.value = l;
    ghost.value = { x: l.cursorX, y: l.cursorY, scale: l.cursorScale };
  }, false);
  const lessonOver = () => {
    lesson.setActive(false);
    void writeValue(STORED.trackpadTaught, "1");
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the lesson starts once, with the pad
  useEffect(() => {
    let alive = true;
    void readValue(STORED.trackpadTaught).then((v) => {
      if (alive && v !== "1" && !reduced) lesson.setActive(true);
    });
    return () => {
      alive = false;
      lesson.setActive(false);
      ghost.value = GHOST_REST;
    };
  }, []);

  const touch = (px: number, py: number) => {
    "worklet";
    if (!taught.value) {
      taught.value = true;
      demo.value = null;
      ghost.value = GHOST_REST;
      scheduleOnRN(lessonOver);
    }
    spotX.value = px;
    spotY.value = py;
    tailX.value = px;
    tailY.value = py;
    spread.value = 0;
    on.value = withTiming(1, { duration: 80 });
  };
  const follow = (px: number, py: number) => {
    "worklet";
    spotX.value = px;
    spotY.value = py;
    tailX.value = withTiming(px, { duration: 220 });
    tailY.value = withTiming(py, { duration: 220 });
  };
  const lift = () => {
    "worklet";
    on.value = withTiming(0, { duration: 280 });
  };
  // A hold, or a touch soon after a tap that moves, presses; the lift lets go, wherever the finger went (`dragStep`).
  const drag = useSharedValue(DRAG_REST);
  const step = (event: DragEvent) => {
    "worklet";
    const next = dragStep(drag.value, event, Date.now());
    drag.value = next.drag;
    if (next.act === "press") {
      nudge.value = withTiming(1.14, { duration: 120 });
      scheduleOnRN(setHolding, true);
      scheduleOnRN(onHold, true);
    } else if (next.act === "release") {
      nudge.value = withTiming(1, { duration: 120 });
      scheduleOnRN(setHolding, false);
      scheduleOnRN(onHold, false);
    }
    return next.act;
  };

  const swipe = usePanGesture({
    maxPointers: 1,
    minDistance: SWIPE_START,
    onBegin: (e) => {
      "worklet";
      touch(e.x, e.y);
      step("touch");
    },
    onActivate: () => {
      "worklet";
      step("move");
    },
    onUpdate: (e) => {
      "worklet";
      follow(e.x, e.y);
      const gain = cursorGain(Math.hypot(e.velocityX, e.velocityY) / 1000, s.value);
      const d = desk.value;
      cursorX.value = clamp(cursorX.value + e.changeX * gain, 0, d.width);
      cursorY.value = clamp(cursorY.value + e.changeY * gain, 0, d.height);
      const edged = atDesktopEdge({ x: cursorX.value, y: cursorY.value }, d);
      if (edged && !edge.value) scheduleOnRN(onEdge);
      edge.value = edged;
      const to = followCursor(
        { x: x.value, y: y.value },
        s.value,
        { x: cursorX.value, y: cursorY.value },
        box.value,
        d,
      );
      x.value = to.x;
      y.value = to.y;
      scheduleOnRN(onMove, cursorX.value, cursorY.value);
    },
    onFinalize: () => {
      "worklet";
      lift();
      step("lift");
    },
  });
  const hold = useLongPressGesture({
    minDuration: HOLD_MS,
    maxDistance: 8,
    onActivate: () => {
      "worklet";
      step("hold");
    },
  });
  const tap = useTapGesture({
    maxDuration: 260,
    maxDistance: 8,
    onDeactivate: (e) => {
      "worklet";
      if (e.canceled) return;
      // A touch that pressed already clicked by letting go.
      if (step("tap") !== "click") return;
      nudge.value = withSequence(withTiming(0.84, { duration: 60 }), withTiming(1, { duration: 120 }));
      ringX.value = e.x;
      ringY.value = e.y;
      ringT.value = 0;
      ringT.value = withTiming(1, { duration: 600 });
      scheduleOnRN(onClick);
    },
  });
  const scroll = usePanGesture({
    minPointers: 2,
    maxPointers: 2,
    minDistance: SWIPE_START,
    onBegin: () => {
      "worklet";
      wheel.value = 0;
    },
    onActivate: (e) => {
      "worklet";
      touch(e.x, e.y);
      spread.value = 22;
    },
    onUpdate: (e) => {
      "worklet";
      follow(e.x, e.y);
      wheel.value += e.changeY;
      if (Math.abs(wheel.value) < WHEEL_STEP) return;
      // Fingers going up bring the page's lower part in, as on a phone.
      const down = wheel.value < 0;
      wheel.value += down ? WHEEL_STEP : -WHEEL_STEP;
      scheduleOnRN(onWheel, down);
    },
    onDeactivate: () => {
      "worklet";
      lift();
    },
  });
  const gestures = useSimultaneousGestures(swipe, hold, tap, scroll);

  const source = trackpadEffect();
  const tones = bodyTones(color);
  const dotTone = rgba(c.faint);
  dotTone[3] = 0.32;
  const base = { size: [size.width, size.height], gap: DOT_GAP, dotTone, glowTone: rgba(tones[3] ?? c.ink) };
  const uniforms = useDerivedValue(() => {
    const l = demo.value;
    const px = l ? l.x : spotX.value;
    const py = l ? l.y : spotY.value;
    const ex = l ? l.tailX : tailX.value;
    const ey = l ? l.tailY : tailY.value;
    const apart = l ? l.spread : spread.value;
    return {
      ...base,
      a: [px - apart, py],
      aTail: [ex - apart, ey],
      b: [px + apart, py],
      bTail: [ex + apart, ey],
      on: l ? l.on : on.value,
      two: apart > 0 ? 1 : 0,
      ring: l ? [l.ringX, l.ringY] : [ringX.value, ringY.value],
      ringT: l ? l.ringT : ringT.value,
    };
  });

  return (
    <View style={[styles.pad, { backgroundColor: c.sunken, borderColor: holding ? tones[3] : c.line }]}>
      <GestureDetector gesture={gestures}>
        <View
          collapsable={false}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            padSize.value = { width, height };
            setSize({ width, height });
          }}
          style={StyleSheet.absoluteFill}
          accessibilityLabel={t("agentComputer.phone.trackpad")}
          accessibilityHint={t("agentComputer.phone.trackpadHint")}
        >
          {source && size.width > 0 ? (
            <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
              <Fill>
                <Shader source={source} uniforms={uniforms} />
              </Fill>
            </Canvas>
          ) : null}
        </View>
      </GestureDetector>
    </View>
  );
}

/** What stays at hand sideways, over the picture: it rests faint and wakes with every touch. */
function TouchDock({
  shown,
  right,
  notice,
  onKeyboard,
  onUpright,
  onCouldnt,
  onNote,
  onDone,
  doneLabel,
}: {
  shown: SharedValue<number>;
  right: number;
  notice: { button: ReactNode; text: ReactNode; open: boolean };
  onKeyboard: () => void;
  /** Only when the button laid the view down: otherwise turning the phone does it. */
  onUpright?: () => void;
  /** The agent asked for help and this person can't. */
  onCouldnt?: () => void;
  onNote: () => void;
  onDone: () => void;
  doneLabel: string;
}) {
  const { t } = useTranslation();
  const { colors, shadows } = useTheme();
  const rest = useAnimatedStyle(() => ({ opacity: shown.value }));
  return (
    <>
      <Animated.View style={[styles.dock, { right, boxShadow: shadows.e2 }, rest]}>
        <Glass liquid intensity={70} style={[styles.dockGlass, { borderColor: colors.line2 }]}>
          <View style={styles.dockInfo}>{notice.button}</View>
          <IconButton icon="keyboard" label={t("desktop.keyboard.label")} onPress={onKeyboard} />
          {onUpright ? <IconButton icon="expand" label={t("agentComputer.phone.upright")} onPress={onUpright} /> : null}
          {onCouldnt ? <IconButton icon="x" label={t("mobile.browser.live.couldnt")} onPress={onCouldnt} /> : null}
          <IconButton icon="compose" label={t("browser.inCard.addNote")} onPress={onNote} />
          <PressScale
            to={0.9}
            onPress={onDone}
            accessibilityRole="button"
            accessibilityLabel={doneLabel}
            hitSlop={4}
            style={[styles.dockDone, { backgroundColor: colors.ink }]}
            contentStyle={styles.dockDoneIn}
          >
            <Icon name="check" size={20} color={colors.bg} />
          </PressScale>
        </Glass>
      </Animated.View>
      <View
        pointerEvents="box-none"
        style={[
          styles.dockNotice,
          { right },
          notice.open && [styles.dockNoticeOpen, { backgroundColor: colors.raised, boxShadow: shadows.e2 }],
        ]}
      >
        {notice.text}
      </View>
    </>
  );
}

/** The row's keycaps, as the browser's key row draws its own. */
const ROW_CAP: Record<ScreenRowKey, string> = {
  Escape: "esc",
  Tab: "⇥",
  ArrowLeft: "←",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowRight: "→",
};

/**
 * Typing straight onto the agent's screen: the phone keyboard over it and each key there as it is pressed, no draft in
 * between. The keys go to a field nobody sees (as the web's `useScreenKeys`), read as what changed in it
 * (`typedSince`); the row over the keyboard holds what a phone keyboard lacks (Esc, Tab, the arrows), Paste, Password
 * and the way back. The keyboard closing by itself (Android's back) closes it too. Password opens the app's `TypeBar`
 * in its password mode instead (ADR 0098 §4): a whole text, with the system's saved passwords.
 */
function ScreenKeys({
  password,
  label,
  bottom,
  sides,
  onText,
  onKey,
  onPassword,
  onClose,
}: {
  password: boolean;
  /** The field's name for a screen reader. */
  label: string;
  bottom: number;
  /** Clear of the phone's sides, sideways. */
  sides: number;
  onText: (text: string) => void;
  onKey: (key: ScreenKey) => void;
  onPassword: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const pad = { paddingBottom: Math.max(bottom, 8), paddingHorizontal: 12 + sides };
  if (password) {
    return (
      <View style={[styles.typing, styles.typingField, pad]}>
        <View style={styles.grow}>
          <TypeBar autoFocus secret onText={onText} onKey={onKey} />
        </View>
        <IconButton icon="x" plate label={t("mobile.common.close")} onPress={onClose} />
      </View>
    );
  }
  return <DirectKeys label={label} pad={pad} onText={onText} onKey={onKey} onPassword={onPassword} onClose={onClose} />;
}

/** `ScreenKeys` straight onto the screen. */
function DirectKeys({
  label,
  pad,
  onText,
  onKey,
  onPassword,
  onClose,
}: {
  label: string;
  pad: { paddingBottom: number; paddingHorizontal: number };
  onText: (text: string) => void;
  onKey: (key: ScreenKey) => void;
  onPassword: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [text, setText] = useState("");
  // The field's text as last read: a held Backspace's repeats read it before the state catches up.
  const was = useRef("");
  const closing = useRef(onClose);
  closing.current = onClose;
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidHide", () => closing.current());
    return () => sub.remove();
  }, []);
  const edit = (next: string) => {
    const { back, typed } = typedSince(was.current, next);
    was.current = next;
    setText(next);
    for (let i = 0; i < back; i++) onKey("Backspace");
    if (typed) onText(typed);
  };
  // Return is Enter there; the field starts over, so it never grows past a line.
  const enter = () => {
    was.current = "";
    setText("");
    onKey("Enter");
  };
  // The keycaps' `PressScale` gives the press's haptic.
  const paste = async () => {
    const copied = await Clipboard.getStringAsync().catch(() => "");
    if (copied) onText(copied);
  };
  const cap = [styles.keyCap, { backgroundColor: colors.sunken }];
  return (
    <View style={[styles.typing, pad]}>
      <TextInput
        value={text}
        onChangeText={edit}
        onKeyPress={(e) => {
          // On an empty field Backspace changes nothing, so only the key says it (iOS repeats it while held).
          if (e.nativeEvent.key === "Backspace" && keyPastDraft(was.current, "Backspace")) onKey("Backspace");
        }}
        onSubmitEditing={enter}
        submitBehavior="submit"
        autoFocus
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        caretHidden
        contextMenuHidden
        accessibilityLabel={label}
        style={styles.unseen}
      />
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        style={styles.grow}
        contentContainerStyle={styles.keys}
        accessibilityLabel={t("mobile.browser.live.keys")}
      >
        {SCREEN_ROW_KEYS.map((k) => (
          <PressScale
            key={k}
            to={0.92}
            fill={false}
            onPress={() => onKey(k)}
            accessibilityRole="button"
            accessibilityLabel={t(`mobile.browser.live.key.${k}`)}
            hitSlop={4}
            style={cap}
            contentStyle={styles.keyCapIn}
          >
            <Text variant="footnote" tone="ink2" style={styles.medium}>
              {ROW_CAP[k]}
            </Text>
          </PressScale>
        ))}
        <PressScale
          to={0.92}
          fill={false}
          onPress={() => void paste()}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.browser.live.pasteHint")}
          hitSlop={4}
          style={cap}
          contentStyle={styles.keyCapIn}
        >
          <Text variant="footnote" tone="ink2" style={styles.medium}>
            {t("mobile.browser.live.paste")}
          </Text>
        </PressScale>
        <PressScale
          to={0.92}
          fill={false}
          onPress={onPassword}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.browser.live.password")}
          hitSlop={4}
          style={cap}
          contentStyle={[styles.keyCapIn, styles.keyCapIcon]}
        >
          <Icon name="lock" size={14} color={colors.ink2} />
          <Text variant="footnote" tone="ink2" style={styles.medium}>
            {t("mobile.browser.live.password")}
          </Text>
        </PressScale>
      </ScrollView>
      <IconButton icon="x" plate label={t("mobile.common.close")} onPress={onClose} />
    </View>
  );
}

/**
 * Under the screen while watching: a request on it (the chat's card), what the agent does now (`LiveTrail`, the
 * browser's trail live) and, while it works in a conversation, the chat's own composer to it there: join or stop
 * and send, and its stop for whom may stop it.
 */
function Watching({
  agentId,
  name,
  color,
  run,
  request,
  steps,
  api,
  bottom,
}: {
  agentId: string;
  name: string;
  color: AgentColorName;
  run: LiveRun | null;
  request: ReactNode;
  steps: ScreenStep[];
  api: ReturnType<typeof useApi>;
  bottom: number;
}) {
  const { t } = useTranslation();
  const { org, orgId } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const toast = useToast();
  const now = useNow(1000);
  const channelId = useActiveWork().find((w) => w.agentId === agentId)?.channelId ?? null;
  const failed = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  const send = (body: string, how: SendHow) => {
    if (!body.trim() || !channelId) return;
    const steer = how === "now" ? { steer: "now" as const } : {};
    api.chat.post(orgId, channelId, { body: body.trim(), ...steer }).catch(failed);
  };
  const atWork = run !== null && (run.status === "thinking" || run.status === "queued" || run.status === "running");
  // Who may stop it here: its owner and who manages agents (the conversation's own rule also lets its asker).
  const mayStop =
    run !== null &&
    mayStopRun(run, {
      meId,
      manageAgents: can(org, "manage_agents"),
      agentOwnerId: dir.agentById.get(agentId)?.ownerUserId,
      messages: [],
    });
  const stop = () => {
    if (!run) return;
    api.agents.cancelRun(orgId, run.runId).catch(failed);
  };
  return (
    <View style={[styles.under, { paddingBottom: bottom + 8 }]}>
      {request ? <View style={styles.request}>{request}</View> : null}
      <LiveTrail steps={steps} color={color} now={now} />
      {channelId ? (
        <View style={styles.composer}>
          {org?.deletion ? (
            // Being deleted, it reads as ever and takes no message (ADR 0088 §7).
            <Text variant="footnote" tone="muted" style={styles.readOnly}>
              {t("deleting.composer")}
            </Text>
          ) : (
            <Composer
              placeholder={t("agentComputer.phone.message", { name })}
              face={<AgentFace agentId={agentId} size={22} live={false} />}
              working={
                atWork ? (mayStop ? { stop: { label: t("mobile.chat.stopAgent", { name }), onStop: stop } } : {}) : null
              }
              onSend={send}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  notice: { paddingHorizontal: 14 },
  stage: { flexShrink: 1 },
  docked: { marginBottom: DOCK_HANG + 12 },
  box: { marginHorizontal: 12, borderRadius: 20, overflow: "hidden", backgroundColor: "#101010" },
  boxWide: { marginHorizontal: 0, borderRadius: 0 },
  frame: { position: "absolute", left: 0, top: 0, transformOrigin: "left top" },
  cursor: {
    position: "absolute",
    left: 0,
    top: 0,
    transformOrigin: "left top",
    shadowColor: "#0a0c1e",
    shadowOpacity: 0.45,
    shadowRadius: 1.5,
    shadowOffset: { width: 0, height: 1.5 },
  },
  // Take control, and Cancelar under it, as the web's stacked question (`.brw-dim__acts`).
  askActs: { alignItems: "center", gap: 4 },
  control: { paddingHorizontal: 12, paddingTop: 10, gap: 8 },
  pad: {
    height: PAD_HEIGHT,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  spot: {
    position: "absolute",
    left: -23,
    top: -23,
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 1.5,
    opacity: 0,
  },
  spotFill: { ...StyleSheet.absoluteFill, borderRadius: 23, opacity: 0.22 },
  ring: {
    position: "absolute",
    left: -7,
    top: -7,
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 2,
    opacity: 0,
  },
  wideBanner: { position: "absolute", top: 12, maxWidth: 320 },
  // A pill around its 40 pt buttons, 4 pt out: concentric with them.
  dock: { position: "absolute", top: 12, borderRadius: 999 },
  dockGlass: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    padding: 4,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  dockInfo: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  dockDone: { width: 40, height: 40, borderRadius: 20 },
  dockDoneIn: { alignItems: "center", justifyContent: "center" },
  dockNotice: { position: "absolute", top: 70 },
  dockNoticeOpen: { width: 300, paddingHorizontal: 14, paddingBottom: 12, paddingTop: 8, borderRadius: 14 },
  typing: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 8 },
  typingField: { alignItems: "flex-end" },
  // Focusable and so given the keyboard, but never seen or touched: the keys show on the screen itself.
  unseen: { position: "absolute", left: 0, top: 0, width: 1, height: 1, opacity: 0 },
  keys: { flexDirection: "row", alignItems: "center", gap: 6 },
  keyCap: { borderRadius: 10 },
  keyCapIn: { minWidth: 40, alignItems: "center", paddingVertical: 8, paddingHorizontal: 8 },
  keyCapIcon: { flexDirection: "row", gap: 4 },
  medium: { fontWeight: "500" },
  under: { flex: 1, paddingTop: 4 },
  request: { marginHorizontal: 12, marginBottom: 4 },
  // The chat's composer, at the bottom with the chat's own side margins.
  composer: { marginTop: "auto", paddingHorizontal: 10, paddingTop: 8 },
  // In its place while the workspace is being deleted, as the chat says it.
  readOnly: { textAlign: "center", paddingHorizontal: 16, paddingVertical: 12 },
});
