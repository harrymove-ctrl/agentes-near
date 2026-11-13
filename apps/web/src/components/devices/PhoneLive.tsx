import type { DesktopMode, PhoneDevice, SocketLike } from "@agenteschat/client";
import { desktopRetryMs } from "@agenteschat/client";
import {
  controlRefusalText,
  mayTakePhone,
  PHONE_TEXT_MAX,
  type PhoneScreenState,
  personInControl,
  phoneCloseState,
  phoneScreenAway,
  phoneScreenCover,
  phoneScreenUrl,
  screenGesture,
} from "@agenteschat/client/lib/devices";
import { firstName } from "@agenteschat/client/lib/format";
import { Button, Card, CardHeader, PixelSpinner } from "@agenteschat/ui";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";
import { SocketFactoryContext } from "@/realtime/context";
import { useOrg } from "../org-context";

/** The keys a keyboard presses on the phone; any other printable key types itself. */
const KEYS: Record<string, "enter" | "delete" | "back"> = { Enter: "enter", Backspace: "delete", Escape: "back" };

/** A phone's screen before its first picture: a common phone's shape. */
const PHONE_SHAPE = { width: 9, height: 19.5 };

/**
 * A phone's screen live on its page (bring your own devices): watching for whoever may use it, and control for
 * whoever may take it (`mayTakePhone`), which pauses an agent holding it until they give it back. In control a click
 * taps, a drag swipes, the keyboard types (Enter, Backspace and Esc press the phone's own keys), and an Android phone
 * gets its Back and Home buttons. It opens again by itself after drops, as a watcher after control ends.
 */
export function PhoneLive({ phone: p, host }: { phone: PhoneDevice; host: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const createSocket = useContext(SocketFactoryContext);
  const [mode, setMode] = useState<DesktopMode>("watch");
  const [view, setView] = useState<PhoneScreenState>("connecting");
  const [shown, setShown] = useState(false);
  const [shape, setShape] = useState(PHONE_SHAPE);
  const [round, setRound] = useState(0);
  const [full, setFull] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<SocketLike | null>(null);
  const attempts = useRef(0);
  const down = useRef<{ x: number; y: number; at: number } | null>(null);
  const name = p.name;
  const s = p.status;
  const controller = personInControl(s);
  const inControl = mode === "control" && view === "live";
  const mayTake = mayTakePhone(p, me.user.id);
  const agent = s.kind === "in_use" && s.agentId ? (s.agentName ?? name) : null;
  const person = s.kind === "in_use" && s.userName ? firstName(s.userName) : null;

  // A phone that can't show opens nothing (offline, or waiting on its person): the list says when that changes.
  const away = phoneScreenAway(p);
  // `t`, `toast` and the names only word a close: a new socket for them would drop the screen for nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!p.mayUse || away) return;
    let done = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // A new stream (control taken, given back) shows nothing of its own until its first picture: an iPhone's test
    // helper starts in several seconds, and input before then would go nowhere.
    setView("connecting");
    const socket = createSocket(phoneScreenUrl(window.location, { orgId: org.id, phoneId: p.id, mode }));
    (socket as unknown as WebSocket).binaryType = "arraybuffer";
    socketRef.current = socket;
    socket.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      void createImageBitmap(new Blob([ev.data]))
        .then((bitmap) => {
          const canvas = canvasRef.current;
          if (!done && canvas) {
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
              setShape({ width: bitmap.width, height: bitmap.height });
            }
            canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
            attempts.current = 0;
            setShown(true);
            setView("live");
          }
          bitmap.close();
        })
        .catch(() => undefined)
        .finally(() => {
          if (!done && socket.readyState === 1) socket.send(JSON.stringify({ type: "ack" }));
        });
    };
    socket.onclose = (ev) => {
      if (done) return;
      socketRef.current = null;
      const next = phoneCloseState(ev.code, (ev as { reason?: string }).reason ?? "");
      // A watcher meets these only when the phone itself can't be used: opening again at once would loop.
      if (next.control && mode === "control") {
        toast.show(
          controlRefusalText(t, next.control, { host, name, agent: agent ?? name }),
          next.control === "lost" ? "success" : "error",
        );
        setMode("watch");
        return;
      }
      if (next.control) return setView("unavailable");
      setView(next.state);
      if (next.retry === "now") setRound((r) => r + 1);
      else if (next.retry === "later")
        retry = setTimeout(() => setRound((r) => r + 1), desktopRetryMs(attempts.current++));
    };
    return () => {
      done = true;
      clearTimeout(retry);
      socket.onclose = null;
      socket.onmessage = null;
      socket.close(1000);
      socketRef.current = null;
    };
  }, [createSocket, org.id, p.id, p.mayUse, away, mode, round]);

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  // The keyboard types on the phone from the moment control starts, not after a first click on it.
  useEffect(() => {
    if (inControl) stageRef.current?.focus();
  }, [inControl]);

  const send = (frame: object) => {
    const socket = socketRef.current;
    if (mode === "control" && socket?.readyState === 1) socket.send(JSON.stringify(frame));
  };
  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height, at: e.timeStamp };
  };
  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!inControl || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    stageRef.current?.focus();
    down.current = at(e);
  };
  const onUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const from = down.current;
    down.current = null;
    if (from && inControl) send(screenGesture(from, at(e)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys on the stage's own buttons (Back, Home) stay theirs.
    if (!inControl || e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
    const key = KEYS[e.key];
    if (key) send({ type: "key", key });
    else if (e.key.length === 1) send({ type: "text", text: e.key });
    else return;
    e.preventDefault();
  };
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen?.();
  };

  const action =
    mode === "control" ? (
      <Button size="sm" icon="undo" onClick={() => setMode("watch")}>
        {t("devices.screen.give")}
      </Button>
    ) : mayTake && view === "live" && !controller ? (
      <Button size="sm" icon="pointer" onClick={() => setMode("control")}>
        {t("devices.screen.take")}
      </Button>
    ) : undefined;
  const banner = inControl
    ? { title: t("devices.screen.yours"), text: null }
    : mode === "control"
      ? null
      : controller
        ? { title: t("devices.screen.personControls", { name: person ?? "" }), text: null }
        : agent
          ? {
              title: person
                ? t("devices.screen.agentUsesFor", { agent, person })
                : t("devices.screen.agentUses", { agent }),
              text: mayTake ? t("devices.screen.takeHint", { agent }) : t("devices.screen.noTake", { agent }),
            }
          : null;
  const cover = phoneScreenCover(t, view, p, host);

  return (
    <Card aria-labelledby="dv-screen-title">
      <CardHeader
        id="dv-screen-title"
        icon="phone"
        title={t("devices.screen.title")}
        hint={mode === "control" ? { name: t("devices.screen.title"), text: t("devices.screen.yoursHint") } : undefined}
        action={
          <div className="dv-screen__acts">
            {action}
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={full ? "fullscreenExit" : "fullscreen"}
              aria-label={full ? t("devices.screen.fullExit") : t("common.fullScreen")}
              onClick={toggleFull}
              disabled={!shown}
            />
          </div>
        }
      />
      {banner && (
        <div className="dv-statusline dv-screen__banner" data-status="inuse" role="status">
          <span className="dv-statusline__text">
            {banner.title}
            {banner.text && <small> · {banner.text}</small>}
          </span>
        </div>
      )}
      {/* Focus stays on the screen while in control, so the keyboard types on the phone. */}
      <div
        ref={stageRef}
        role="application"
        aria-label={t("devices.screen.label", { name })}
        className="dv-screen"
        data-full={full || undefined}
        data-control={inControl || undefined}
        tabIndex={inControl ? 0 : -1}
        onKeyDown={onKey}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text").slice(0, PHONE_TEXT_MAX);
          if (!inControl || !text) return;
          e.preventDefault();
          send({ type: "text", text });
        }}
      >
        <div className="dv-screen__frame" style={{ "--dv-ratio": shape.width / shape.height } as CSSProperties}>
          <canvas
            ref={canvasRef}
            className="dv-screen__canvas"
            data-shown={shown || undefined}
            onPointerDown={onDown}
            onPointerUp={onUp}
            onPointerCancel={() => {
              down.current = null;
            }}
          />
          {cover && (
            <div className="dv-screen__cover" role="status">
              {cover.spinner && <PixelSpinner size={24} />}
              <strong>{cover.title}</strong>
              {cover.text && <span>{cover.text}</span>}
              {cover.retry && (
                <Button size="sm" onClick={() => setRound((r) => r + 1)}>
                  {t("common.retry")}
                </Button>
              )}
            </div>
          )}
        </div>
        {/* In the stage, so they stay at hand in full screen. */}
        {inControl && p.platform === "android" && (
          <div className="dv-screen__keys ac-acts">
            <Button size="sm" icon="chevronLeft" onClick={() => send({ type: "key", key: "back" })}>
              {t("common.back")}
            </Button>
            <Button size="sm" icon="home" onClick={() => send({ type: "key", key: "home" })}>
              {t("devices.screen.home")}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
