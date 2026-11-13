import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

/**
 * Connecting a computer with a device code (ADR 0036 §5), the client half.
 * The runner asks our server for a code (`POST /api/machines/device`), shows
 * it with the confirmation URL, and polls `POST /api/machines/device/token`
 * until the person confirms on the site with their normal session. The
 * token goes straight into the config; nobody types a code.
 */

export interface DeviceCode {
  deviceCode: string;
  /** 6 characters (`K7Q4ZP`); shown as `K7Q·4ZP`. */
  userCode: string;
  verificationUrl: string;
  /** Seconds. */
  expiresIn: number;
  /** Seconds between polls. */
  interval: number;
  /** A connect link's code: who made the link (they let this computer in), and their workspace. */
  maker?: string;
  orgName?: string;
}

export interface DeviceGrant {
  token: string;
  machineId: string;
  name: string;
  org: { id: string; name: string };
  /** Who may use it as it joined, whoever connected it, and its page (servers before bring your own devices: none). */
  audience?: "everyone" | "people" | "owner";
  owner?: string;
  url?: string;
}

export type PairingFailure = "expired" | "denied" | "network" | "internal" | "canceled" | "link_invalid";

/** A connect link's code as people paste it (`7KQ2-M9XD`); the server checks the rest. */
export const LINK_CODE = /^[A-Za-z0-9-]{4,40}$/;

/** A connect link that was used, expired or never existed (`machine.link_invalid`). */
export const LINK_INVALID = "This link expired or was used already. Make a new one under Settings › Devices.";

export class PairingError extends Error {
  constructor(
    readonly code: PairingFailure,
    message: string,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface DeviceInfo {
  name?: string;
  os: string;
  arch: string;
  hostname: string;
  version: string;
  /**
   * The machine this computer was on that server (its config keeps it after
   * a refusal or "leave"): the site reconnects that machine, with its name,
   * permissions and agents, when the person confirming may manage it.
   */
  previousMachineId?: string;
  /** The token it had for `previousMachineId`: the proof that it is that computer (no reconnect without it). */
  previousToken?: string;
  /**
   * A connect link's code (`/i/<code>`): the server makes the device code for the link's workspace and asks the
   * link's maker to let this computer in, instead of anyone confirming a code.
   */
  link?: string;
}

/** Who may use the computer it just connected, in a sentence; null from a server that doesn't say. */
export function whoCanUse(grant: DeviceGrant, name: string): string | null {
  switch (grant.audience) {
    case "everyone":
      return `Everyone in the workspace can use ${name}.`;
    case "people":
      return `Only the people and roles chosen can use ${name}.`;
    case "owner":
      return `Only ${grant.owner ?? "the person who connected it"} can use ${name}.`;
    default:
      return null;
  }
}

/** `K7Q4ZP` → `K7Q·4ZP`. */
export function formatUserCode(code: string): string {
  const c = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return c.length === 6 ? `${c.slice(0, 3)}·${c.slice(3)}` : c;
}

/** The error word of an OAuth-style answer: `{ error: "slow_down" }` or `{ error: { code } }`. */
function errorWord(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const e = (body as { error?: unknown }).error;
  if (typeof e === "string") return e;
  if (typeof e === "object" && e !== null) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

function errorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const e = (body as { error?: unknown; message?: unknown }).error;
  if (typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  const m = (body as { message?: unknown }).message;
  return typeof m === "string" ? m : undefined;
}

async function postJson(fetchFn: FetchFn, url: string, body: unknown, signal?: AbortSignal) {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (signal?.aborted) throw new PairingError("canceled", "Canceled");
    throw new PairingError(
      "network",
      `Couldn't reach ${new URL(url).origin}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, ok: res.ok, json };
}

/** Asks the server for a device code. */
export async function requestDeviceCode(
  server: string,
  info: DeviceInfo,
  opts: { fetch?: FetchFn; signal?: AbortSignal } = {},
): Promise<DeviceCode> {
  const fetchFn: FetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  const res = await postJson(fetchFn, `${server}/api/machines/device`, info, opts.signal);
  if (!res.ok && errorWord(res.json) === "machine.link_invalid") {
    throw new PairingError("link_invalid", errorMessage(res.json) ?? LINK_INVALID);
  }
  if (!res.ok) {
    throw new PairingError(
      res.status === 429 ? "network" : "internal",
      errorMessage(res.json) ??
        (res.status === 429
          ? "Too many connection attempts from this network. Try again in a few minutes."
          : `The server refused to start the connection (HTTP ${res.status})`),
    );
  }
  const d = res.json as Partial<DeviceCode> | null;
  if (
    !d ||
    typeof d.deviceCode !== "string" ||
    typeof d.userCode !== "string" ||
    typeof d.verificationUrl !== "string"
  ) {
    throw new PairingError("internal", "The server's answer was not understood");
  }
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);
  const named = (v: unknown) => {
    const name = typeof v === "object" && v !== null ? (v as { name?: unknown }).name : undefined;
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : undefined;
  };
  const maker = named((d as { maker?: unknown }).maker);
  const orgName = named((d as { org?: unknown }).org);
  return {
    ...(maker ? { maker } : {}),
    ...(orgName ? { orgName } : {}),
    deviceCode: d.deviceCode,
    userCode: d.userCode.replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
    verificationUrl: d.verificationUrl,
    expiresIn: num(d.expiresIn, 600),
    interval: num(d.interval, 3),
  };
}

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new PairingError("canceled", "Canceled"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new PairingError("canceled", "Canceled"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Polls for the token every `interval` seconds (5 more after each
 * `slow_down`, as OAuth's device flow says) until the person confirms, says
 * "Não fui eu" (`denied`) or the code expires. A network hiccup is retried
 * until the code expires.
 */
export async function pollDeviceToken(
  server: string,
  code: DeviceCode,
  opts: {
    fetch?: FetchFn;
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<DeviceGrant> {
  const fetchFn: FetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleep ?? abortableSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + code.expiresIn * 1000;
  let interval = code.interval;
  let lastNetwork: string | null = null;
  for (;;) {
    await sleep(interval * 1000, opts.signal);
    if (opts.signal?.aborted) throw new PairingError("canceled", "Canceled");
    let res: Awaited<ReturnType<typeof postJson>>;
    try {
      res = await postJson(
        fetchFn,
        `${server}/api/machines/device/token`,
        { deviceCode: code.deviceCode },
        opts.signal,
      );
      lastNetwork = null;
    } catch (err) {
      if (err instanceof PairingError && err.code === "network") {
        lastNetwork = err.message;
        if (now() >= deadline) throw err;
        continue;
      }
      throw err;
    }
    if (res.ok) {
      const g = res.json as Partial<DeviceGrant> | null;
      if (!g || typeof g.token !== "string" || typeof g.machineId !== "string") {
        throw new PairingError("internal", "The server's answer was not understood");
      }
      const org =
        g.org && typeof g.org.id === "string" ? { id: g.org.id, name: String(g.org.name ?? "") } : { id: "", name: "" };
      const audience = ["everyone", "people", "owner"].find((a) => a === g.audience) as DeviceGrant["audience"];
      return {
        token: g.token,
        machineId: g.machineId,
        name: typeof g.name === "string" ? g.name : "",
        org,
        ...(audience ? { audience } : {}),
        ...(typeof g.owner === "string" && g.owner ? { owner: g.owner } : {}),
        ...(typeof g.url === "string" && /^https?:\/\//.test(g.url) ? { url: g.url } : {}),
      };
    }
    const word = errorWord(res.json);
    if (word === "authorization_pending") {
      // keep waiting
    } else if (word === "slow_down" || res.status === 429) {
      interval += 5;
    } else if (word === "access_denied") {
      throw new PairingError("denied", "The connection was refused on the site");
    } else if (word === "expired_token") {
      throw new PairingError("expired", "The code expired. Start again.");
    } else if (res.status >= 500) {
      lastNetwork = `The server answered HTTP ${res.status}`;
    } else {
      throw new PairingError("internal", errorMessage(res.json) ?? `Connecting failed (HTTP ${res.status})`);
    }
    if (now() >= deadline) {
      throw lastNetwork
        ? new PairingError("network", lastNetwork)
        : new PairingError("expired", "The code expired. Start again.");
    }
  }
}

/** The whole flow: a code (shown through `onCode`), then the token. */
export async function devicePair(
  server: string,
  info: DeviceInfo,
  onCode: (code: DeviceCode) => void,
  opts: Parameters<typeof pollDeviceToken>[2] = {},
): Promise<DeviceGrant> {
  const code = await requestDeviceCode(server, info, opts);
  onCode(code);
  return pollDeviceToken(server, code, opts);
}

/**
 * A code issued for this computer by whoever provisions it (ADR 0056 §10), from the file it was handed
 * in, never a command line (any local user can read those). The file is removed as soon as it is read,
 * so no failure after this leaves the code on disk.
 */
export function takeEnrollCode(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new PairingError(
      "internal",
      `Couldn't read the enrollment file: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // not there, or not a file
    }
  }
  const code = text.trim();
  // Checked before it leaves: another file's contents (a config with its token) never reach the server.
  if (!/^[\w-]{20,200}$/.test(code)) throw new PairingError("internal", `${file} doesn't hold an enrollment code`);
  return code;
}

/**
 * Connects with an issued code: it is confirmed already, so the first poll gets the token. A code that
 * expired, was used or was withdrawn fails with a message about the code, since nobody confirms one.
 */
export async function redeemIssuedCode(
  server: string,
  code: string,
  opts: Parameters<typeof pollDeviceToken>[2] = {},
): Promise<DeviceGrant> {
  // The server's whole lifetime for a code: it was issued earlier, so the real expiry can be sooner.
  const issued: DeviceCode = { deviceCode: code, userCode: "", verificationUrl: "", expiresIn: 600, interval: 2 };
  try {
    return await pollDeviceToken(server, issued, opts);
  } catch (err) {
    if (!(err instanceof PairingError)) throw err;
    if (err.code === "expired") {
      throw new PairingError("expired", "The enrollment code expired or was already used. Issue a new one.");
    }
    if (err.code === "denied") {
      throw new PairingError(
        "denied",
        "The enrollment code was withdrawn: a newer one replaced it, or this computer was removed",
      );
    }
    throw err;
  }
}

/** `Ação & Cia` → `acao-cia`. */
export function orgSlug(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "org";
}

/**
 * The desktop app's workspace for an organization: `<base>/<org-slug>`, or
 * `<slug>-2`, `<slug>-3`… when a folder of that name already has something
 * in it (another organization with the same name, or files of the person's).
 */
export function uniqueWorkspace(base: string, orgName: string): string {
  const slug = orgSlug(orgName);
  for (let i = 1; i < 1000; i++) {
    const dir = path.join(base, i === 1 ? slug : `${slug}-${i}`);
    if (!existsSync(dir)) return dir;
    try {
      if (readdirSync(dir).length === 0) return dir;
    } catch {
      // not a folder we can use
    }
  }
  return path.join(base, `${slug}-${Date.now()}`);
}
