import { randomInt, randomUUID } from "node:crypto";
import {
  type MachineReplies,
  type MachineRequest,
  type PhonePairFailure,
  type PhonePairing,
  pairAddress,
} from "@agenteschat/adapters/machine-protocol";
import { type AndroidFacts, FACTS_SHELL, parseAdbDevices, parseAndroidFacts } from "./adb";
import { RunnerError } from "./errors";
import type { ToolOptions, ToolResult } from "./phones";

/**
 * Android's Wireless debugging, paired by this computer. The QR way: Android Studio's code
 * (`WIFI:T:ADB;S:<service>;P:<password>;;`), which the phone scans and answers by advertising `_adb-tls-pairing._tcp`
 * under that service name over mDNS. The code way: the six digits and the address the phone shows. Then `adb pair`,
 * and `adb connect` to the phone's `_adb-tls-connect._tcp` service, named after the guid `adb pair` prints
 * (`adb-<ro.serialno>-<suffix>`). One pairing at a time: a new one ends the one before.
 */

export const PAIR_TIMEOUT_MS = 2 * 60_000;
export const PAIR_POLL_MS = 1500;
/** After pairing, how long the phone's connect service may take to show up. */
const CONNECT_WAIT_MS = 20_000;
/** How long an ended pairing still answers its status. */
const KEEP_MS = 10 * 60_000;
/**
 * CVE-2026-0073 (adbd's TLS bypass, a shell from the same network) is fixed from the 2026-05-01 patch on Android 14
 * to 16, and never below: a phone left in Wireless debugging needs both.
 */
export const MIN_WIFI_SDK = 34;
export const MIN_WIFI_PATCH = "2026-05-01";
export const wifiOutdated = (f: Pick<AndroidFacts, "sdk" | "patch">) =>
  f.sdk < MIN_WIFI_SDK || !f.patch || f.patch < MIN_WIFI_PATCH;

export type PairRequest = Extract<
  MachineRequest,
  { op: "phone.pair.start" | "phone.pair.code" | "phone.pair.status" | "phone.pair.cancel" }
>;

/** One line of `adb mdns services`: `adb-38021FDH-AbCdEf\t_adb-tls-connect._tcp\t192.168.1.20:41235`. */
export interface MdnsService {
  name: string;
  kind: "pairing" | "connect" | "other";
  address: string;
}

export function parseMdnsServices(text: string): MdnsService[] {
  const out: MdnsService[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // adb before 34 ended the type with a dot.
    const m = /^(\S+)\s+(_[\w-]+\._tcp)\.?\s+(\S+:\d+)$/.exec(raw.trim());
    if (!m) continue;
    const [, name = "", type, address = ""] = m;
    const kind = type === "_adb-tls-pairing._tcp" ? "pairing" : type === "_adb-tls-connect._tcp" ? "connect" : "other";
    out.push({ name, kind, address });
  }
  return out;
}

/** The phone's own serial in its mDNS name (`adb-<serial>-<suffix>`, or adb's serial for it), or null. */
export function serialOfMdnsName(name: string): string | null {
  const m = /^adb-([\w.-]+)-[A-Za-z0-9]+(?:\._adb-tls-connect\._tcp\.?)?$/.exec(name);
  return m?.[1] ?? null;
}

/** The QR Android scans under Wireless debugging › Pair device with QR code. */
export const pairingQr = (service: string, password: string) => `WIFI:T:ADB;S:${service};P:${password};;`;

const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const randomWord = (n: number) => Array.from({ length: n }, () => ALNUM[randomInt(ALNUM.length)]).join("");

/** What `adb pair` said: paired (with the phone's guid when it says it), or why not. */
export function pairOutcome(
  r: Pick<ToolResult, "code" | "timedOut"> & { text: string },
): { ok: true; guid: string | null } | { ok: false; reason: PhonePairFailure } {
  const ok = /Successfully paired to \S+(?:\s+\[guid=([^\]\s]+)\])?/i.exec(r.text);
  if (ok) return { ok: true, guid: ok[1] ?? null };
  // adb words a wrong code and a phone that closed its pairing screen alike.
  if (/wrong password|connection was dropped/i.test(r.text)) return { ok: false, reason: "refused" };
  // adb 36 answers an address nothing listens on with "protocol fault (couldn't read status message)".
  if (
    r.timedOut ||
    /unable to start pairing|failed to connect|protocol fault|refused|no route|unreachable|timed out/i.test(r.text)
  ) {
    return { ok: false, reason: "same_wifi" };
  }
  return { ok: false, reason: "failed" };
}

interface Pairing {
  id: string;
  way: "qr" | "code";
  state: PhonePairing["state"];
  reason?: PhonePairFailure;
  qr?: string;
  service?: string;
  password?: string;
  /** The code way: the address and code the person typed. */
  address?: string;
  code?: string;
  serial?: string;
  /** Paired: the guid `adb pair` said, and the address `adb connect` was given. */
  guid?: string | null;
  tried?: string;
  expiresAt: number;
  endedAt?: number;
  abort: AbortController;
}

export interface WifiPairerOptions {
  /** The adb to use (the running server's), or null when there is none. */
  adb: () => Promise<string | null>;
  run: (bin: string, args: string[], opts?: ToolOptions) => Promise<ToolResult>;
  /** It connected: `serial` is the phone's own, `adbSerial` what adb calls it now. Resolves once the list knows it. */
  connected: (serial: string, adbSerial: string) => Promise<void>;
  /** Refused as outdated: its own serial (it keeps this computer's key, so adb may connect it again by itself). */
  refused: (serial: string) => void;
  log: (line: string) => void;
  env: NodeJS.ProcessEnv;
  now: () => number;
  pollMs?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export class WifiPairer {
  private current: Pairing | null = null;

  constructor(private readonly opts: WifiPairerOptions) {}

  /** A pairing is under way (the runner leaves the network alone meanwhile). */
  get busy() {
    const p = this.current;
    return Boolean(p && p.endedAt === undefined);
  }

  /** adb's serial is the phone being paired, not checked yet: the list leaves it out until it is (`ready`). */
  hides(adbSerial: string) {
    const p = this.current;
    if (!p || p.endedAt !== undefined || p.state !== "connecting") return false;
    return adbSerial === p.tried || (Boolean(p.guid) && adbSerial.startsWith(`${p.guid}.`));
  }

  async handle(req: PairRequest): Promise<unknown> {
    switch (req.op) {
      case "phone.pair.start":
        return this.view(await this.begin("qr"), true) satisfies MachineReplies["phone.pair.start"];
      case "phone.pair.code": {
        const address = pairAddress(req.address);
        const code = typeof req.code === "string" ? req.code.replace(/\s/g, "") : "";
        if (!address) throw new RunnerError("bad_request", "That isn't an address and port (192.168.1.20:37099)");
        if (!/^\d{6}$/.test(code)) throw new RunnerError("bad_request", "A pairing code is six digits");
        return this.view(await this.begin("code", address, code)) satisfies MachineReplies["phone.pair.code"];
      }
      case "phone.pair.status":
        return this.view(this.find(req.pairingId)) satisfies MachineReplies["phone.pair.status"];
      case "phone.pair.cancel": {
        const p = this.current?.id === req.pairingId ? this.current : null;
        const live = Boolean(p && p.endedAt === undefined);
        if (p && live) this.end(p, "failed", "canceled");
        return { canceled: live } satisfies MachineReplies["phone.pair.cancel"];
      }
      default:
        throw new RunnerError("bad_request", `Unknown op ${(req as { op: string }).op}`);
    }
  }

  stop() {
    if (this.current && this.current.endedAt === undefined) this.end(this.current, "failed", "canceled");
  }

  private find(id: unknown) {
    const p = this.current;
    if (!p || p.id !== id || (p.endedAt !== undefined && this.opts.now() - p.endedAt > KEEP_MS)) {
      throw new RunnerError("not_found", "No such pairing on this computer. Start again.");
    }
    return p;
  }

  private view(p: Pairing, withQr = false): PhonePairing {
    return {
      id: p.id,
      way: p.way,
      state: p.state,
      ...(p.reason ? { reason: p.reason } : {}),
      ...(withQr && p.qr ? { qr: p.qr } : {}),
      ...(p.serial ? { serial: p.serial } : {}),
      expiresAt: new Date(p.expiresAt).toISOString(),
    };
  }

  private end(p: Pairing, state: "connected" | "failed", reason?: PhonePairFailure) {
    if (p.endedAt !== undefined) return;
    p.state = state;
    if (reason) p.reason = reason;
    p.endedAt = this.opts.now();
    p.abort.abort();
    p.password = undefined;
    p.code = undefined;
  }

  private async begin(way: "qr" | "code", address?: string, code?: string): Promise<Pairing> {
    this.stop();
    const p: Pairing = {
      id: randomUUID(),
      way,
      state: "waiting",
      expiresAt: this.opts.now() + PAIR_TIMEOUT_MS,
      abort: new AbortController(),
      ...(address ? { address, code } : {}),
    };
    if (way === "qr") {
      p.service = `agentes-${randomWord(10)}`;
      p.password = randomWord(12);
      p.qr = pairingQr(p.service, p.password);
    }
    this.current = p;
    const adb = await this.opts.adb();
    if (!adb) {
      this.end(p, "failed", "adb_missing");
      return p;
    }
    const check = await this.adb(adb, ["mdns", "check"], p.abort.signal, 10_000);
    const mdns = check.code === 0 && /mdns daemon version/i.test(check.text);
    // The QR way is found only over mDNS; the code way needs it only to find where to connect.
    if (way === "qr" && !mdns) {
      this.end(p, "failed", "mdns_off");
      return p;
    }
    void this.drive(p, adb, mdns).catch((err: unknown) => {
      this.opts.log(`wifi pairing: ${err instanceof Error ? err.message : String(err)}`);
      this.end(p, "failed", "failed");
    });
    return p;
  }

  private async adb(adb: string, args: string[], signal: AbortSignal, timeoutMs = 15_000) {
    const r = await this.opts.run(adb, args, { timeoutMs, signal, env: this.opts.env });
    return { ...r, text: `${r.stdout.toString("utf8")}\n${r.stderr}` };
  }

  private late(p: Pairing) {
    if (p.abort.signal.aborted) return true;
    if (this.opts.now() < p.expiresAt) return false;
    this.end(p, "failed", "timed_out");
    return true;
  }

  private async services(adb: string, p: Pairing) {
    return parseMdnsServices((await this.adb(adb, ["mdns", "services"], p.abort.signal, 10_000)).text);
  }

  private async drive(p: Pairing, adb: string, mdns: boolean) {
    const poll = this.opts.pollMs ?? PAIR_POLL_MS;
    let target = p.address ?? null;
    let secret = p.code ?? null;
    while (!target) {
      if (this.late(p)) return;
      const found = (await this.services(adb, p)).find((s) => s.kind === "pairing" && s.name === p.service);
      if (found) {
        target = found.address;
        secret = p.password ?? null;
        break;
      }
      await sleep(poll, p.abort.signal);
    }
    if (this.late(p) || !secret) return;
    p.state = "pairing";
    const paired = pairOutcome(await this.adb(adb, ["pair", target, secret], p.abort.signal, 30_000));
    if (p.abort.signal.aborted) return;
    if (!paired.ok) return this.end(p, "failed", paired.reason);
    p.guid = paired.guid;
    p.state = "connecting";
    const host = target.slice(0, target.lastIndexOf(":"));
    const until = this.opts.now() + CONNECT_WAIT_MS;
    let tried = "";
    while (this.opts.now() < until && !p.abort.signal.aborted) {
      // adb connects a paired phone by itself when its mDNS sees it; else we do.
      const listed = parseAdbDevices((await this.adb(adb, ["devices", "-l"], p.abort.signal, 10_000)).text);
      const mine = listed.find(
        (e) =>
          e.state === "device" &&
          ((paired.guid !== null && e.serial.startsWith(`${paired.guid}.`)) || (tried !== "" && e.serial === tried)),
      );
      if (mine) return this.ready(p, adb, mine.serial);
      const connect = (await this.services(adb, p)).find(
        (s) =>
          s.kind === "connect" &&
          (paired.guid !== null ? s.name === paired.guid : s.address.slice(0, s.address.lastIndexOf(":")) === host),
      );
      if (connect && connect.address !== tried) {
        tried = connect.address;
        p.tried = tried;
        await this.adb(adb, ["connect", connect.address], p.abort.signal, 15_000);
        continue;
      }
      await sleep(poll, p.abort.signal);
    }
    if (!p.abort.signal.aborted) this.end(p, "failed", mdns ? "same_wifi" : "mdns_off");
  }

  /** Connected: refused when it is open to CVE-2026-0073, else known by its own serial from now on. */
  private async ready(p: Pairing, adb: string, adbSerial: string) {
    const r = await this.adb(adb, ["-s", adbSerial, "shell", FACTS_SHELL], p.abort.signal, 15_000);
    const facts = parseAndroidFacts(r.stdout.toString("utf8").replace(/\r\n/g, "\n"));
    if (r.code !== 0 || facts.sdk === 0) return this.end(p, "failed", "failed");
    const serial = facts.serialno ?? serialOfMdnsName(adbSerial) ?? adbSerial;
    if (wifiOutdated(facts)) {
      this.opts.refused(serial);
      await this.adb(adb, ["disconnect", adbSerial], p.abort.signal, 10_000);
      return this.end(p, "failed", "outdated");
    }
    // Checked: the list may show it now, and says connected only once it does.
    p.guid = null;
    p.tried = undefined;
    await this.opts.connected(serial, adbSerial);
    p.serial = serial;
    this.end(p, "connected");
    this.opts.log(`wifi pairing: ${facts.model} connected as ${adbSerial}`);
  }
}
