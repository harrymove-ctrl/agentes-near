import type { ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { PhoneReason } from "@agenteschat/adapters/machine-protocol";
import { tunnelOf } from "./apple-devices";
import { RunnerError } from "./errors";
import { killTree } from "./exec";
import { REASON_WORDS, runTool, startTool } from "./phones";
import { loopbackForward } from "./usbmux";

/**
 * CoreDevice's tunnel to an iPhone over Wi-Fi: the encrypted link Xcode itself uses, between this Mac's `utun`
 * interface and the phone, with a fresh unique local IPv6 address on each side every time it comes up. It stays up
 * only while a client uses it, so while an iPhone over Wi-Fi is held (or its test helper runs) a keeper waits on it:
 * `devicectl device notification observe` for a notification nothing posts, started again each `KEEP_SECONDS`.
 */

export const KEEP_SECONDS = 300;
/** Observed on the phone by the keeper; nothing posts it. */
export const KEEP_NOTIFICATION = "chat.agentes.runner.tunnel";
/** A keeper ending sooner than this after it started lost the tunnel (the phone left the network or slept). */
const KEPT_MS = 30_000;
const RETRY_MS = 5_000;

/** Both ends of an iPhone's tunnel: the phone's address, and this Mac's own on the same `utun`. */
export interface Tunnel {
  address: string;
  local: string;
}

/**
 * A port on this Mac's loopback that reaches `port` on the phone through its tunnel. Each connection leaves from this
 * Mac's own end: once the tunnel is gone that address is too, so connecting fails instead of taking the default route
 * out over Wi-Fi, where another host could answer as the phone's test helper.
 */
export function tunnelForward(tunnel: Tunnel, port: number) {
  return loopbackForward(
    () =>
      new Promise<net.Socket>((resolve, reject) => {
        const socket = net.connect({ host: tunnel.address, port, localAddress: tunnel.local });
        socket.once("connect", () => resolve(socket)).once("error", reject);
      }),
  );
}

/** The tunnel isn't there to use: why, in words (`REASON_WORDS`), with its code for the phone's state. */
export class TunnelMissing extends RunnerError {
  constructor(readonly reason: PhoneReason) {
    super("phone_not_ready", REASON_WORDS[reason] ?? "The iPhone can't be reached over Wi-Fi now.");
  }
}

type Interfaces = Parameters<typeof tunnelOf>[1];

export interface AppleTunnelsOptions {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Tests: this Mac's interfaces (default `os.networkInterfaces()`). */
  interfaces?: () => Interfaces;
  now?: () => number;
}

interface Keep {
  count: number;
  child: ChildProcess | null;
  /** The keeper lost the tunnel while held: a tunnel that won't come back has dropped, not slept. */
  lost: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class AppleTunnels {
  private readonly keeps = new Map<string, Keep>();

  constructor(private readonly opts: AppleTunnelsOptions) {}

  /** Keeps the phone's tunnel up until the returned function is called (holds add up). */
  hold(xcrun: string, udid: string): () => void {
    let keep = this.keeps.get(udid);
    if (!keep) {
      keep = { count: 0, child: null, lost: false };
      this.keeps.set(udid, keep);
    }
    keep.count++;
    if (keep.count === 1) this.keep(xcrun, udid, keep);
    let released = false;
    return () => {
      if (released || !keep) return;
      released = true;
      keep.count--;
      if (keep.count > 0) return;
      clearTimeout(keep.timer);
      if (keep.child) killTree(keep.child, "SIGTERM");
      this.keeps.delete(udid);
    };
  }

  private keep(xcrun: string, udid: string, keep: Keep) {
    const now = this.opts.now ?? Date.now;
    const started = now();
    const run = startTool(
      xcrun,
      [
        "devicectl",
        "device",
        "notification",
        "observe",
        "--device",
        udid,
        "--name",
        KEEP_NOTIFICATION,
        "--session-timeout",
        String(KEEP_SECONDS),
        "--timeout",
        String(KEEP_SECONDS + 30),
        "--quiet",
      ],
      { env: this.opts.env },
    );
    keep.child = run.child;
    void run.done.then((r) => {
      keep.child = null;
      if (this.keeps.get(udid) !== keep || keep.count === 0) return;
      const early = now() - started < KEPT_MS;
      if (early && !keep.lost)
        this.opts.log(`iPhone ${udid}: the Wi-Fi tunnel dropped (${r.stderr.trim().slice(0, 200)})`);
      if (early) keep.lost = true;
      keep.timer = setTimeout(() => this.keep(xcrun, udid, keep), early ? RETRY_MS : 0);
      keep.timer.unref?.();
    });
  }

  /**
   * The phone's tunnel, read now and checked (`tunnelOf`); the tunnel comes up for the read. Throws
   * `TunnelMissing` when it can't be had for certain: never another address.
   */
  async address(xcrun: string, udid: string): Promise<Tunnel> {
    const file = path.join(os.tmpdir(), `agentes-tunnel-${process.pid}-${udid.replace(/[^\w-]/g, "_")}.json`);
    try {
      const r = await runTool(
        xcrun,
        [
          "devicectl",
          "device",
          "info",
          "details",
          "--device",
          udid,
          "--timeout",
          "30",
          "--quiet",
          "--json-output",
          file,
        ],
        { timeoutMs: 45_000, env: this.opts.env },
      );
      const text = r.code === 0 && !r.timedOut ? await readFile(file, "utf8").catch(() => "") : "";
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // half written: read as no answer
      }
      const got = json
        ? tunnelOf(json, (this.opts.interfaces ?? os.networkInterfaces)())
        : { reason: "wifi_asleep" as const };
      const keep = this.keeps.get(udid);
      if ("address" in got) {
        if (keep) keep.lost = false;
        return got;
      }
      throw new TunnelMissing(got.reason === "wifi_asleep" && keep?.lost ? "tunnel_down" : got.reason);
    } finally {
      await rm(file, { force: true });
    }
  }

  stopAll() {
    for (const keep of this.keeps.values()) {
      keep.count = 0;
      clearTimeout(keep.timer);
      if (keep.child) killTree(keep.child, "SIGTERM");
    }
    this.keeps.clear();
  }
}
