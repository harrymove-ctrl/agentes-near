/**
 * Development only (`bun run dev` in a browser): a bar to switch windows and nudge the fake runners
 * (go offline, raise a folder request), and a frame the size of each real window. `?bare=1` drops the bar
 * (screenshots). Not product UI.
 */
import { useEffect, useReducer } from "react";
import type { FakeHost } from "../host/fake";
import type { WindowName } from "../host/types";
import { WindowView } from "../WindowView";

const SIZES: Record<WindowName, { width: number; height: number | "auto" }> = {
  popover: { width: 380, height: "auto" },
  welcome: { width: 720, height: 600 },
  prefs: { width: 860, height: 600 },
  notch: { width: 480, height: 420 },
};

export function DevFrame({ host }: { host: FakeHost }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => host.onDev(rerender), [host]);
  const name = host.window;
  const size = SIZES[name];
  const first = [...host.runners.values()][0];
  const bare = new URLSearchParams(window.location.search).get("bare") === "1";
  const toggleTheme = () => {
    const r = document.documentElement;
    r.dataset.theme = r.dataset.theme === "dark" ? "light" : "dark";
  };
  return (
    <div className="dk-dev" data-bare={bare || undefined}>
      {!bare && (
        <div className="dk-dev__bar">
          {(["popover", "welcome", "prefs", "notch"] as const).map((w) => (
            <button key={w} type="button" aria-pressed={w === name} onClick={() => void host.showWindow(w)}>
              {w}
            </button>
          ))}
          <span className="dk-dev__sep" />
          <button type="button" onClick={() => first?.setOnline(false)}>
            offline
          </button>
          <button type="button" onClick={() => first?.setOnline(true)}>
            online
          </button>
          <button type="button" onClick={() => first?.raiseRequest()}>
            folder request
          </button>
          <button type="button" onClick={toggleTheme}>
            theme
          </button>
          <span className="dk-dev__tray">
            tray: {host.tray} · server: {host.list.current ?? "none"}
          </span>
        </div>
      )}
      <div
        className="dk-dev__window"
        data-window={name}
        style={{ width: size.width, height: size.height === "auto" ? undefined : size.height }}
      >
        <WindowView key={name} name={name} />
      </div>
    </div>
  );
}
