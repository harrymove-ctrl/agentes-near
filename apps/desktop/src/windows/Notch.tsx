/**
 * The notch (off by default, Preferências → Geral): a black
 * island over the MacBook's camera housing. Closed, it grows wings: who is working on the left, the
 * clock (or what needs you) on the right. When an agent needs a person, or the last work ends, it
 * drops for a few seconds with one line; a click opens the list. Nothing going on: hidden.
 * This window has its own store, as every window; Rust only finds the notch and places the window.
 */
import { Button, Icon, normalizeAppearance, PixelSpinner } from "@agenteschat/ui";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../app";
import { saidText } from "../control/activity";
import { siteLink } from "../control/browser";
import {
  finishedOf,
  type NotchHelp,
  type NotchState,
  type NotchWork,
  notchStateOf,
  oldestStart,
} from "../control/notch";
import { homeServer } from "../control/server";
import { type Home, pairedHomes } from "../control/store";
import { agentOf, usePending } from "../hooks";
import type { NotchInfo } from "../host/types";
import { AgentFace, BrandFace, Count } from "../ui/bits";
import { useToast } from "../ui/Toast";
import { clock, elapsedClock } from "../ui/time";

/** Each wing beside the notch. */
const WING = 74;
const PEEK = { width: 400, extra: 50 };
const OPEN_WIDTH = 420;
/** Transparent margin around the dropped island, for its shadow. */
const PAD = { x: 24, bottom: 36 };
/** The island's spring (`.dk-notch__island`); the window shrinks after it. */
const SETTLE_MS = 450;
const PEEK_MS = { needs: 6000, done: 5000 };

type Mode = "closed" | "peek" | "open";
interface Done {
  work: NotchWork;
  ms: number;
}

export function Notch() {
  const { t } = useTranslation();
  const host = useHost();
  const snap = useSnapshot();
  const homes = pairedHomes(snap);
  const [now, setNow] = useState(() => Date.now());
  // The clock below re-renders it while it shows, so a browser left idle drops out on its own.
  const state = notchStateOf(homes, now);
  const [info, setInfo] = useState<NotchInfo | null>(null);
  const [mode, setMode] = useState<Mode>("closed");
  const [done, setDone] = useState<Done | null>(null);
  const [bodyHeight, setBodyHeight] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The notch can come and go (the lid closed on an external display): ask again now and then.
  useEffect(() => {
    let live = true;
    const ask = () =>
      host
        .notchInfo()
        .then((i) => live && setInfo((cur) => (same(cur, i) ? cur : i)))
        .catch(() => {});
    ask();
    const timer = setInterval(ask, 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [host]);

  const peek = (ms: number) => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    setMode((m) => (m === "open" ? m : "peek"));
    peekTimer.current = setTimeout(() => {
      setMode((m) => (m === "peek" ? "closed" : m));
      setDone(null);
    }, ms);
  };

  // A new request for a person drops the island; so does the end of the last work.
  const helpKeys = state.help.map((h) => h.key).join("|");
  const seenHelp = useRef<Set<string> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the set of requests changes
  useEffect(() => {
    const keys = new Set(state.help.map((h) => h.key));
    const fresh = seenHelp.current !== null && [...keys].some((k) => !seenHelp.current?.has(k));
    seenHelp.current = keys;
    if (fresh) peek(PEEK_MS.needs);
  }, [helpKeys]);

  const workKeys = state.work.map((w) => w.key).join("|");
  const lastWork = useRef<NotchWork[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the set of work changes
  useEffect(() => {
    const ended = finishedOf(lastWork.current, state.work, Date.now());
    lastWork.current = state.work;
    if (ended && state.kind === "idle") {
      setDone(ended);
      peek(PEEK_MS.done);
    } else if (state.work.length > 0) {
      setDone(null);
    }
  }, [workKeys]);

  useEffect(
    () => () => {
      if (peekTimer.current) clearTimeout(peekTimer.current);
    },
    [],
  );

  const showDone = done !== null && state.kind === "idle";
  const visible = info !== null && (state.kind !== "idle" || showDone || mode === "open");

  // The clock on the wing ticks while it shows.
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);

  // Closed by a click anywhere else (the window loses focus) or Escape.
  useEffect(() => {
    const close = () => setMode((m) => (m === "open" ? "closed" : m));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // The open list's height.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe the list each time it opens
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => setBodyHeight(Math.ceil(el.getBoundingClientRect().height));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  const nw = info?.width ?? 0;
  const nh = info?.height ?? 0;
  const dropping = mode === "peek" && (state.kind === "needs" || showDone);
  const island = !visible
    ? { width: nw, height: nh, radius: 10 }
    : mode === "open"
      ? { width: OPEN_WIDTH, height: nh + bodyHeight, radius: 26 }
      : dropping
        ? { width: PEEK.width, height: nh + PEEK.extra, radius: 22 }
        : { width: nw + WING * 2, height: nh, radius: 12 };
  const big = visible && (mode === "open" || dropping);
  const winWidth = big ? island.width + PAD.x * 2 : island.width;
  const winHeight = big ? island.height + PAD.bottom : island.height;

  // The window grows before the island springs open and shrinks after it settles, so nothing is cut;
  // hidden once the island is back to the notch's own size.
  const placed = useRef({ width: 0, height: 0 });
  useEffect(() => {
    if (!info) return;
    const place = (width: number, height: number) => {
      placed.current = { width, height };
      void host.notchPlace(width, height).catch(() => {});
    };
    const target = visible ? { width: winWidth, height: winHeight } : { width: 0, height: 0 };
    const cur = placed.current;
    if (target.width >= cur.width && target.height >= cur.height) {
      place(target.width, target.height);
      return;
    }
    if (visible) place(Math.max(cur.width, target.width), Math.max(cur.height, target.height));
    const timer = setTimeout(() => place(target.width, target.height), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [host, info, visible, winWidth, winHeight]);

  const homeOf = (id: string) => homes.find((h) => h.homeId === id);
  const style = {
    "--dk-notch-w": `${island.width}px`,
    "--dk-notch-h": `${island.height}px`,
    "--dk-notch-r": `${island.radius}px`,
    "--dk-notch-top": `${nh}px`,
  } as CSSProperties;

  return (
    <div className="dk-notch" data-theme="dark">
      <div className="dk-notch__island" data-big={big || undefined} style={style}>
        {visible && mode !== "open" && (
          <button
            type="button"
            className="dk-notch__hit"
            aria-label={t("desktop.notch.label")}
            onClick={() => setMode("open")}
          />
        )}
        {visible && mode !== "open" && (
          <Wings homes={homes} state={state} done={showDone ? done : null} now={now} peeking={dropping} />
        )}
        {visible && dropping && (
          <div className="dk-notch__peek">
            {state.kind === "needs" && state.help[0] ? (
              <HelpLine home={homeOf(state.help[0].homeId)} help={state.help[0]} />
            ) : done ? (
              <DoneLine home={homeOf(done.work.homeId)} done={done} />
            ) : null}
          </div>
        )}
        {visible && mode === "open" && (
          <button
            type="button"
            className="dk-notch__top"
            aria-label={t("desktop.common.close")}
            onClick={() => setMode("closed")}
          />
        )}
        {visible && mode === "open" && (
          <div className="dk-notch__body" ref={body}>
            <OpenList homes={homes} state={state} done={showDone ? done : null} now={now} />
          </div>
        )}
      </div>
    </div>
  );
}

const same = (a: NotchInfo | null, b: NotchInfo | null) =>
  a === b || (!!a && !!b && a.width === b.width && a.height === b.height);

/** Up to two agents on the left wing; on the right, what matters now. */
function Wings({
  homes,
  state,
  done,
  now,
  peeking,
}: {
  homes: Home[];
  state: NotchState;
  done: Done | null;
  now: number;
  peeking: boolean;
}) {
  const seen = new Map<string, { home: Home | undefined; agent: { id: string; name: string } }>();
  const add = (homeId: string, agent?: { id: string; name: string }) => {
    if (agent && !seen.has(agent.id)) seen.set(agent.id, { home: homes.find((h) => h.homeId === homeId), agent });
  };
  if (state.kind === "needs") for (const h of state.help) add(h.homeId, { id: h.agentId, name: "" });
  for (const w of state.work) add(w.homeId, w.agent);
  if (done) add(done.work.homeId, done.work.agent);
  const faces = [...seen.values()].slice(0, 2);
  const first = faces[0] ? agentOf(faces[0].home, faces[0].agent) : null;
  const started = oldestStart(state.work);
  const face = state.kind === "working" ? "writing" : "waiting";
  return (
    <>
      {!peeking && (
        <span className="dk-notch__wing dk-notch__wing--l">
          {faces.map((f) => (
            <AgentFace
              key={f.agent.id}
              agent={agentOf(f.home, f.agent)}
              size="xs"
              state={done ? "idle" : face}
              expression={done ? "happy" : undefined}
            />
          ))}
        </span>
      )}
      <span className="dk-notch__wing dk-notch__wing--r">
        {state.kind === "needs" ? (
          <Icon name="pointer" size={14} className="dk-notch__warn" />
        ) : state.kind === "paused" ? (
          <Icon name="pause" size={14} className="dk-notch__muted" />
        ) : done ? (
          <Icon name="check" size={14} className="dk-notch__ok" />
        ) : (
          <>
            <PixelSpinner size={14} color={normalizeAppearance(first?.look).color} />
            {started !== null && <span className="dk-notch__clock">{elapsedClock(now - started)}</span>}
          </>
        )}
      </span>
    </>
  );
}

/** "Bento precisa de você" with Abrir: the conversation on the site, where the person takes over. */
function HelpLine({ home, help, row }: { home: Home | undefined; help: NotchHelp; row?: boolean }) {
  const { t } = useTranslation();
  const host = useHost();
  const agent = agentOf(home, { id: help.agentId, name: t("desktop.notch.someAgent") });
  return (
    <div className={row ? "dk-notch__row" : "dk-notch__line"}>
      <AgentFace agent={agent} size="sm" state="waiting" />
      <span className="dk-notch__text">
        <b>{t("desktop.notch.needs", { agent: agent.name })}</b>
        <small>{[help.host, help.request].filter(Boolean).join(" · ")}</small>
      </span>
      <Button
        size="sm"
        variant="primary"
        onClick={(e) => {
          e.stopPropagation();
          const server = home ? homeServer(home) : null;
          if (server) void host.openExternal(siteLink(server, help.link, server)).catch(() => {});
        }}
      >
        {t("desktop.notch.open")}
      </Button>
    </div>
  );
}

function DoneLine({ home, done, row }: { home: Home | undefined; done: Done; row?: boolean }) {
  const { t, i18n } = useTranslation();
  const agent = agentOf(home, done.work.agent ?? { id: "", name: t("desktop.notch.someAgent") });
  const what = saidText(t, done.work, (iso) => clock(iso, i18n.language, new Date()));
  return (
    <div className={row ? "dk-notch__row" : "dk-notch__line"}>
      <AgentFace agent={agent} size="sm" expression="happy" />
      <span className="dk-notch__text">
        <b>{t("desktop.notch.done", { agent: agent.name })}</b>
        <small>{[what, elapsedClock(done.ms)].filter(Boolean).join(" · ")}</small>
      </span>
    </div>
  );
}

function WorkRow({ home, work, now }: { home: Home | undefined; work: NotchWork; now: number }) {
  const { t, i18n } = useTranslation();
  const agent = work.agent ? agentOf(home, work.agent) : null;
  const what = saidText(t, work, (iso) => clock(iso, i18n.language, new Date()));
  const color = normalizeAppearance(agent?.look).color;
  const started = work.startedAt ? Date.parse(work.startedAt) : Number.NaN;
  const title = work.browser
    ? t("desktop.notch.inBrowser", { agent: agent?.name || t("desktop.notch.someAgent") })
    : agent
      ? `${agent.name} · ${what}`
      : what;
  return (
    <div className="dk-notch__row">
      {agent ? <AgentFace agent={agent} size="sm" state="writing" /> : <BrandFace size="sm" />}
      <span className="dk-notch__text">
        <b>{title}</b>
        <small>
          <PixelSpinner size={14} color={color} />
          {work.where && <span>{work.where}</span>}
          {work.command && <code className="dk-code-inline">{work.command}</code>}
        </small>
      </span>
      {Number.isFinite(started) && <span className="dk-notch__clock">{elapsedClock(now - started)}</span>}
    </div>
  );
}

function OpenList({ homes, state, done, now }: { homes: Home[]; state: NotchState; done: Done | null; now: number }) {
  const { t } = useTranslation();
  const host = useHost();
  const store = useStore();
  const toast = useToast();
  const homeOf = (id: string) => homes.find((h) => h.homeId === id);
  const [pending, run] = usePending<"resume">();
  const resume = () =>
    run("resume", () => store.requestAll({ type: "resume" }).catch(() => toast(t("desktop.common.error"), "alert")));
  return (
    <>
      <div className="dk-notch__head">
        {t("desktop.notch.here")} <Count n={state.work.length + state.help.length} />
      </div>
      {state.kind === "paused" && (
        <div className="dk-notch__row">
          <span className="dk-notch__text">
            <b>{t("desktop.notch.pausedTitle")}</b>
            <small>{t("desktop.notch.pausedBody")}</small>
          </span>
          <Button size="sm" variant="primary" icon="play" loading={pending === "resume"} onClick={() => void resume()}>
            {t("desktop.notch.resume")}
          </Button>
        </div>
      )}
      {state.help.map((h) => (
        <HelpLine key={h.key} home={homeOf(h.homeId)} help={h} row />
      ))}
      {state.work.map((w) => (
        <WorkRow key={w.key} home={homeOf(w.homeId)} work={w} now={now} />
      ))}
      {done && <DoneLine home={homeOf(done.work.homeId)} done={done} row />}
      <div className="dk-notch__foot">
        <button type="button" className="dk-notch__link" onClick={() => void host.showWindow("popover")}>
          {t("desktop.notch.openApp")}
        </button>
      </div>
    </>
  );
}
