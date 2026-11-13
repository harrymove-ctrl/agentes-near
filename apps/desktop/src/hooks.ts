import type { ControlAgent } from "@agenteschat/adapters/runner-control";
import type { WifiIphone } from "@agenteschat/client";
import { WIFI_IPHONES_POLL_MS } from "@agenteschat/client/lib/devices";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHost } from "./app";
import { siteApi } from "./control/devices";
import { type LocalServerStatus, NO_SERVER, type Tailnet } from "./control/local-server";
import type { ServerWorkspaces } from "./control/server";
import type { Home } from "./control/store";
import {
  CHECK_EVERY_MS,
  type LatestRelease,
  latestUrl,
  parseLatest,
  type UpdateState,
  updateStateOf,
} from "./control/version";
import type { AppInfo, WindowName } from "./host/types";

/**
 * The iPhones on this Mac's Wi-Fi that trust it, from its server (`GET …/wifi-iphones`, for who may manage the Mac),
 * asked every `WIFI_IPHONES_POLL_MS` while `on`. `pick` picks one (and throws what the server said); `using` is the one
 * being picked.
 */
export function useWifiIphones(
  at: { server: string | null; orgId: string | null; machineId: string | null },
  on: boolean,
) {
  const host = useHost();
  const { server, orgId, machineId } = at;
  const [available, setAvailable] = useState<WifiIphone[]>([]);
  const [using, setUsing] = useState<string | null>(null);
  useEffect(() => {
    if (!on || !server || !orgId || !machineId) {
      setAvailable([]);
      return;
    }
    let live = true;
    const ask = () =>
      siteApi(host, server)
        .devices.wifiIphones(orgId, machineId)
        .then((r) => live && setAvailable(r.available))
        .catch(() => live && setAvailable([]));
    void ask();
    const timer = setInterval(() => void ask(), WIFI_IPHONES_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [host, server, orgId, machineId, on]);
  const pick = async (serial: string) => {
    if (!server || !orgId || !machineId) return;
    setUsing(serial);
    try {
      setAvailable((await siteApi(host, server).devices.pickIphoneOverWifi(orgId, machineId, serial)).available);
    } finally {
      setUsing(null);
    }
  };
  return { available, pick, using };
}

/** The app's version and the Mac's arch (from the shell). */
export function useAppInfo(): AppInfo | null {
  const host = useHost();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let live = true;
    host
      .appInfo()
      .then((i) => live && setInfo(i))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [host]);
  return info;
}

export interface UpdateCheck {
  state: UpdateState;
  checkedAt: number | null;
  checking: boolean;
  failed: boolean;
  check: () => Promise<UpdateState | null>;
  version: string | null;
}

/**
 * The "Versão nova" check against our server (ADR 0036 §9). `auto`: at start and every 6 hours
 * (the popover window, which owns the tray icon); otherwise only when asked (Preferences).
 */
export function useUpdateCheck(auto: boolean): UpdateCheck {
  const info = useAppInfo();
  const [latest, setLatest] = useState<LatestRelease | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const version = info?.version ?? null;
  const arch = info?.arch ?? null;
  const os = info?.os ?? null;

  const check = useCallback(async (): Promise<UpdateState | null> => {
    if (!version || !arch || !os) return null;
    setChecking(true);
    setFailed(false);
    // A check that hasn't answered in 15 s failed. A timer, not `AbortSignal.timeout`, which macOS 11's WebKit lacks.
    const quit = new AbortController();
    const timer = setTimeout(() => quit.abort(), 15_000);
    try {
      const res = await fetch(latestUrl(os, arch), { headers: { accept: "application/json" }, signal: quit.signal });
      // 404: no release published yet (or the server can't read them): nothing to offer.
      const found = res.ok ? parseLatest(await res.json()) : null;
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      setLatest(found);
      setCheckedAt(Date.now());
      return updateStateOf(version, found);
    } catch {
      setFailed(true);
      return null;
    } finally {
      clearTimeout(timer);
      setChecking(false);
    }
  }, [version, arch, os]);

  useEffect(() => {
    if (!auto || !version) return;
    void check();
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [auto, version, check]);

  return { state: updateStateOf(version ?? "0.0.0", latest), checkedAt, checking, failed, check, version };
}

/** The server here (`local_server.rs`), kept current. */
export function useLocalServer(): LocalServerStatus {
  const host = useHost();
  const [local, setLocal] = useState<LocalServerStatus>(NO_SERVER);
  useEffect(() => {
    let live = true;
    host
      .localServer()
      .then((s) => live && setLocal(s))
      .catch(() => {});
    const off = host.onLocalServer(setLocal);
    return () => {
      live = false;
      off();
    };
  }, [host]);
  return local;
}

/** Every server's workspaces as the app last read them, again whenever they change. */
export function useWorkspaces(): ServerWorkspaces[] {
  const host = useHost();
  const [list, setList] = useState<ServerWorkspaces[]>([]);
  useEffect(() => {
    let live = true;
    const read = () =>
      void host
        .workspaces()
        .then((l) => live && setList(l))
        .catch(() => {});
    read();
    const off = host.onWorkspaces(read);
    return () => {
      live = false;
      off();
    };
  }, [host]);
  return list;
}

/**
 * What Tailscale is doing on this computer, read again each time the window comes to the front (the person may
 * have just connected it). Null until the first read answers, which can take a couple of seconds: guessing a state
 * before that would show its line, then take it back.
 */
export function useTailnet(): Tailnet | null {
  const host = useHost();
  const [tailnet, setTailnet] = useState<Tailnet | null>(null);
  useEffect(() => {
    const read = () =>
      void host
        .tailscale()
        .then(setTailnet)
        .catch(() => setTailnet({ state: "missing" }));
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [host]);
  return tailnet;
}

/** Runs `fn` whenever the shell brings this window up. */
export function useOnShown(name: WindowName, fn: () => void) {
  const host = useHost();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(
    () =>
      host.onShown((shown) => {
        if (shown === name) ref.current();
      }),
    [host, name],
  );
}

/** The agent's look from its organization's agents list (jobs and requests carry only id and name). */
export function agentOf(home: Home | undefined, agent: { id: string; name: string }): ControlAgent {
  const known = home?.status?.agents.find((a) => a.id === agent.id);
  return known ?? { id: agent.id, handle: agent.name.toLowerCase(), name: agent.name };
}

/** A small per-viewer preference kept in the web view's storage (survives restarts). */
export function usePref<T>(key: string, fallback: T): [T, (value: T) => void] {
  const read = (): T => {
    try {
      const raw = localStorage.getItem(`agentes.desktop.${key}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  };
  const [value, setValue] = useState<T>(read);
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(`agentes.desktop.${key}`, JSON.stringify(v));
      } catch {
        // Not kept; still applies now.
      }
    },
    [key],
  );
  return [value, set];
}

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`agentes.desktop.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref<T>(key: string, value: T) {
  try {
    localStorage.setItem(`agentes.desktop.${key}`, JSON.stringify(value));
  } catch {
    // ignore
  }
}

/**
 * The action running now, by name: its button shows `loading` and no other starts until it ends, so a second press
 * never sends it twice. Each action says its own errors.
 */
export function usePending<K extends string>() {
  const [pending, setPending] = useState<K | null>(null);
  const running = useRef(false);
  const run = useCallback(async (key: K, action: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setPending(key);
    try {
      await action();
    } finally {
      running.current = false;
      setPending(null);
    }
  }, []);
  return [pending, run] as const;
}
