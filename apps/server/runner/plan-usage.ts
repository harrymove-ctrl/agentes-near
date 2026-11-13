import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import {
  PLAN_USAGE_LIMITS,
  type PlanUsage,
  type PlanWindow,
  type PlanWindowKind,
} from "@agenteschat/adapters/machine-protocol";
import { type PlanId, planOf } from "@agenteschat/providers/plans";
import { killTree } from "./exec";
import { cliSpawn } from "./executors";

/**
 * Plan usage (protocol 19), read without touching any token: the CLIs and the
 * providers keep theirs.
 * - Claude Code: each turn's `rate_limit_event`, and on demand `get_usage`, a
 *   control request (no model call) to a short-lived `claude -p` that loads no
 *   settings, hooks or MCP servers and keeps no session.
 * - Codex: `account/rateLimits/updated` during turns, and on demand
 *   `account/rateLimits/read` on a short-lived `codex app-server`.
 * - A coding plan's key: the provider's usage endpoint, the key only in
 *   `Authorization`, no redirects (it never reaches another host).
 * A probe that hangs is killed with its whole process tree.
 */

export const USAGE_PROBE_TIMEOUT_MS = 15_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** A number, also when the provider sends it as a string ("120"). */
const numeric = (v: unknown) => finite(typeof v === "string" && v.trim() ? Number(v) : v);
const percent = (v: number) => Math.round(Math.min(100, Math.max(0, v)));
const iso = (ms: number) => new Date(ms).toISOString();
const label = (v: string) => v.replace(/\s+/g, " ").trim().slice(0, PLAN_USAGE_LIMITS.label);

/** A reset time: an ISO date, or seconds (milliseconds when that large) since the epoch. */
export function resetIso(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : iso(t);
  }
  const n = finite(v);
  return n !== undefined && n > 0 ? iso(n < 1e12 ? n * 1000 : n) : undefined;
}

const planWindow = (where: Pick<PlanWindow, "kind" | "label">, used: number, resetsAt?: unknown): PlanWindow => {
  const at = resetIso(resetsAt);
  return { ...where, usedPercent: percent(used), ...(at ? { resetsAt: at } : {}) };
};

const snapshot = (windows: PlanWindow[], source: PlanUsage["source"], now: number): PlanUsage | null =>
  windows.length ? { windows: windows.slice(0, PLAN_USAGE_LIMITS.windows), source, at: iso(now) } : null;

/** The percentage `w`'s window has in `u` (same kind and label), if any. */
const usedIn = (u: PlanUsage | undefined, w: PlanWindow) =>
  u?.windows.find((x) => x.kind === w.kind && x.label === w.label)?.usedPercent;

/**
 * People should hear it at once: a limit hit or cleared, or a window crossing a line where its bar changes color
 * (80, 90) or 100.
 */
export function usageCrossed(prev: PlanUsage | undefined, next: PlanUsage): boolean {
  if (!prev || Boolean(prev.limited) !== Boolean(next.limited)) return true;
  return next.windows.some((w) => {
    const before = usedIn(prev, w) ?? 0;
    // `PLAN_ALMOST` and `PLAN_CRITICAL` in packages/ui/src/plan-state.ts, then the limit.
    return [80, 90, 100].some((line) => before < line !== w.usedPercent < line);
  });
}

// ── Claude Code ──────────────────────────────────────────────────────────────

/** `rate_limit_event`'s `rateLimitType` → our window. */
const RATE_LIMIT_WINDOWS = new Map<string, Pick<PlanWindow, "kind" | "label">>([
  ["five_hour", { kind: "five_hour" }],
  ["seven_day", { kind: "seven_day" }],
  ["seven_day_opus", { kind: "seven_day_opus" }],
  ["seven_day_sonnet", { kind: "seven_day_sonnet" }],
  ["seven_day_overage_included", { kind: "seven_day" }],
  ["overage", { kind: "other", label: "Extra usage" }],
]);

/** A utilization up to 1 is a fraction. */
const usedOf = (u: number) => (u <= 1 ? u * 100 : u);
const windowKey = (w: Pick<PlanWindow, "kind" | "label">) => `${w.kind}:${w.label ?? ""}`;

/**
 * One `rate_limit_event` (its `rate_limit_info`) folded into what was known: its
 * windows replaced, `limited` as its status says. Null when it says nothing new.
 * Its own `utilization` comes only past a warning threshold; each window's
 * reading is in `unifiedWindows`, also on a `claude setup-token` sign-in, whose
 * `get_usage` has no limits to read (Claude Code 2.1.312 to 2.1.316, read
 * 2026-10-31).
 */
export function withRateLimit(prev: PlanUsage | undefined, info: unknown, now = Date.now()): PlanUsage | null {
  if (!isObj(info)) return null;
  const limited = info.status === "rejected";
  const read = new Map<string, PlanWindow>();
  const where = typeof info.rateLimitType === "string" ? RATE_LIMIT_WINDOWS.get(info.rateLimitType) : undefined;
  const u = finite(info.utilization);
  const used = u !== undefined ? usedOf(u) : limited ? 100 : undefined;
  if (where && used !== undefined) read.set(windowKey(where), planWindow(where, used, info.resetsAt));
  const unified = isObj(info.unifiedWindows) ? info.unifiedWindows : {};
  for (const [name, at] of RATE_LIMIT_WINDOWS) {
    const w = unified[name];
    const reading = isObj(w) ? finite(w.utilization) : undefined;
    if (isObj(w) && reading !== undefined && !read.has(windowKey(at)))
      read.set(windowKey(at), planWindow(at, usedOf(reading), w.resetsAt));
  }
  if (read.size === 0 && limited === Boolean(prev?.limited)) return null;
  const windows = (prev?.windows ?? []).filter((w) => !read.has(windowKey(w)));
  windows.push(...read.values());
  return {
    windows: windows.slice(-PLAN_USAGE_LIMITS.windows),
    ...(limited ? { limited: true } : {}),
    source: "turn",
    at: iso(now),
  };
}

const CLAUDE_WINDOWS: [string, Pick<PlanWindow, "kind" | "label">][] = [
  ["five_hour", { kind: "five_hour" }],
  ["seven_day", { kind: "seven_day" }],
  ["seven_day_opus", { kind: "seven_day_opus" }],
  ["seven_day_sonnet", { kind: "seven_day_sonnet" }],
  ["seven_day_oauth_apps", { kind: "other", label: "OAuth apps" }],
];

/**
 * `get_usage`'s answer (`rate_limits`, utilization 0–100, ISO `resets_at`) →
 * a snapshot; null when the plan's limits don't apply (signed out, an API key)
 * or it lists none.
 */
export function claudeUsage(response: unknown, now = Date.now()): PlanUsage | null {
  if (!isObj(response) || response.rate_limits_available !== true || !isObj(response.rate_limits)) return null;
  const limits = response.rate_limits;
  const windows: PlanWindow[] = [];
  const add = (where: Pick<PlanWindow, "kind" | "label">, w: unknown) => {
    const used = isObj(w) ? finite(w.utilization) : undefined;
    if (isObj(w) && used !== undefined) windows.push(planWindow(where, used, w.resets_at));
  };
  for (const [key, where] of CLAUDE_WINDOWS) add(where, limits[key]);
  for (const m of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    const name = isObj(m) && typeof m.display_name === "string" ? label(m.display_name) : "";
    if (name) add({ kind: "other", label: name }, m);
  }
  if (isObj(limits.extra_usage) && limits.extra_usage.is_enabled === true) {
    add({ kind: "other", label: "Extra usage" }, limits.extra_usage);
  }
  return snapshot(windows, "probe", now);
}

// ── Codex ────────────────────────────────────────────────────────────────────

/**
 * Codex's `rateLimits` (`account/rateLimits/read`, `account/rateLimits/updated`):
 * `primary` and `secondary` windows, told apart by their length (300 minutes,
 * 10080), else primary is the 5 hours and secondary the week.
 */
export function codexUsage(rateLimits: unknown, source: PlanUsage["source"], now = Date.now()): PlanUsage | null {
  if (!isObj(rateLimits)) return null;
  const windows: PlanWindow[] = [];
  const add = (w: unknown, fallback: PlanWindowKind) => {
    const used = isObj(w) ? finite(w.usedPercent) : undefined;
    if (!isObj(w) || used === undefined) return;
    const mins = finite(w.windowDurationMins);
    const kind =
      mins !== undefined && Math.abs(mins - 300) <= 1
        ? "five_hour"
        : mins !== undefined && Math.abs(mins - 10_080) <= 1
          ? "seven_day"
          : fallback;
    windows.push(planWindow({ kind }, used, w.resetsAt));
  };
  add(rateLimits.primary, "five_hour");
  add(rateLimits.secondary, "seven_day");
  return snapshot(windows, source, now);
}

// ── Coding-plan keys ─────────────────────────────────────────────────────────

/** Z.ai's `unit` → minutes (its `number` counts them). */
const ZAI_UNIT_MINUTES: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10_080 };

/** Minutes → our window, for the providers that state a window's length. */
const byMinutes = (mins: number | undefined): PlanWindowKind | undefined =>
  mins === 300 ? "five_hour" : mins === 10_080 ? "seven_day" : undefined;

/** Z.ai's `data.limits`: token or credit windows (`unit` 3 hours, 6 weeks…), and the monthly `TIME_LIMIT`. */
function zaiWindows(body: unknown): PlanWindow[] {
  const data = isObj(body) && body.success === true && isObj(body.data) ? body.data : null;
  const out: PlanWindow[] = [];
  for (const l of data && Array.isArray(data.limits) ? data.limits : []) {
    if (!isObj(l)) continue;
    const total = numeric(l.usage);
    const current = numeric(l.currentValue);
    const remaining = numeric(l.remaining);
    const used =
      total && total > 0 && (current !== undefined || remaining !== undefined)
        ? ((current ?? total - (remaining ?? 0)) / total) * 100
        : numeric(l.percentage);
    const unit = ZAI_UNIT_MINUTES[numeric(l.unit) ?? 0];
    const count = numeric(l.number);
    const kind =
      l.type === "TIME_LIMIT"
        ? "monthly"
        : (l.type === "TOKENS_LIMIT" || l.type === "CREDIT_LIMIT") && unit && count
          ? byMinutes(unit * count)
          : undefined;
    if (kind && used !== undefined) out.push(planWindow({ kind }, used, l.nextResetTime));
  }
  return out;
}

/** Kimi Code's `/usages`: the week at the top (`usage`), shorter windows in `limits` (string numbers too). */
function kimiWindows(body: unknown): PlanWindow[] {
  if (!isObj(body)) return [];
  const out: PlanWindow[] = [];
  const add = (kind: PlanWindowKind, d: unknown) => {
    if (!isObj(d)) return;
    const limit = numeric(d.limit);
    const remaining = numeric(d.remaining);
    const used = numeric(d.used) ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined);
    if (limit && limit > 0 && used !== undefined) {
      out.push(planWindow({ kind }, (used / limit) * 100, d.resetTime ?? d.resetAt));
    }
  };
  add("seven_day", body.usage);
  for (const l of Array.isArray(body.limits) ? body.limits : []) {
    if (!isObj(l) || out.some((w) => w.kind === "five_hour")) continue;
    const w = isObj(l.window) ? l.window : {};
    const unit = String(w.timeUnit ?? "").toUpperCase();
    const n = numeric(w.duration);
    const mins = n === undefined ? 300 : unit.includes("HOUR") ? n * 60 : unit.includes("DAY") ? n * 1440 : n;
    if (byMinutes(mins) === "five_hour") add("five_hour", l.detail);
  }
  return out;
}

/**
 * OpenCode Go's `/usage`: `rolling` (5 hours), `weekly` and `monthly`, each `{ status, percent, resetsAt }`. A window
 * whose `status` is `rate-limited` refuses requests whatever its percent says (97%), so it reads as full.
 */
function opencodeWindows(body: unknown): PlanWindow[] {
  const usage = isObj(body) && isObj(body.usage) ? body.usage : {};
  const out: PlanWindow[] = [];
  for (const [key, kind] of [
    ["rolling", "five_hour"],
    ["weekly", "seven_day"],
    ["monthly", "monthly"],
  ] as const) {
    const m = usage[key];
    const used = !isObj(m) ? undefined : m.status === "rate-limited" ? 100 : finite(m.percent);
    if (isObj(m) && used !== undefined) out.push(planWindow({ kind }, used, m.resetsAt));
  }
  return out;
}

/** How each coding plan's usage endpoint (`plans.ts` `usage`) answers, as windows. */
const PLAN_KEY_WINDOWS: Partial<Record<PlanId, (body: unknown) => PlanWindow[]>> = {
  zai: zaiWindows,
  kimi: kimiWindows,
  opencode: opencodeWindows,
};

/**
 * A coding plan's usage from its provider: the snapshot; `"backoff"` when it
 * answered 429 (ask again much later); null for anything else (no endpoint,
 * refused, unreadable). Never throws, and no error carries the key.
 */
export async function fetchPlanKeyUsage(
  provider: string,
  key: string,
  opts: { fetch?: typeof fetch; now?: number; timeoutMs?: number } = {},
): Promise<PlanUsage | "backoff" | null> {
  const endpoint = planOf(provider)?.usage;
  const windows = endpoint ? PLAN_KEY_WINDOWS[provider as PlanId] : undefined;
  if (!endpoint || !windows || !key || /[\r\n]/.test(key)) return null;
  try {
    const res = await (opts.fetch ?? fetch)(endpoint.url, {
      headers: { Authorization: endpoint.auth === "bearer" ? `Bearer ${key}` : key, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? USAGE_PROBE_TIMEOUT_MS),
    });
    if (res.status === 429) return "backoff";
    if (!res.ok) return null;
    return snapshot(windows(await res.json()), "probe", opts.now ?? Date.now());
  } catch {
    return null;
  }
}

// ── Probes: a short-lived CLI ────────────────────────────────────────────────

export interface UsageProbe {
  /** How to start the CLI (`["claude"]`, `["codex"]`, a fake script in tests). */
  command: string[];
  /** The account folder (nothing of the person's own projects loads there). */
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Runs a CLI that speaks JSON lines until `onLine` has its answer (or the CLI
 * ends, or the timeout): the answer, else null. Its process tree is killed at
 * the end either way.
 */
export function jsonLines<T>(
  p: UsageProbe,
  args: string[],
  start: (send: (msg: unknown) => void) => void,
  onLine: (msg: Record<string, unknown>, send: (msg: unknown) => void) => T | null | undefined,
): Promise<T | null> {
  return new Promise((resolve) => {
    const run = cliSpawn(p.command, args, p.env.PATH);
    let child: ChildProcess;
    try {
      child = spawn(run.file, run.args, {
        cwd: p.cwd,
        env: p.env,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        // Its own process group: the kill reaches what it started (posix).
        detached: process.platform !== "win32",
        windowsVerbatimArguments: run.windowsVerbatimArguments,
      });
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree(child, "SIGKILL");
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), p.timeoutMs ?? USAGE_PROBE_TIMEOUT_MS);
    timer.unref?.();
    const send = (msg: unknown) => {
      try {
        child.stdin?.write(`${JSON.stringify(msg)}\n`);
      } catch {
        // gone: its end settles
      }
    };
    child.stdin?.on("error", () => {});
    (child as unknown as EventEmitter).on("error", () => finish(null));
    if (!child.stdout) return finish(null);
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    const events = lines as unknown as EventEmitter;
    events.on("line", (line: string) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (done || !isObj(msg)) return;
      const out = onLine(msg, send);
      if (out !== undefined) finish(out);
    });
    // Every line it printed came first.
    events.on("close", () => finish(null));
    start(send);
  });
}

/** Claude Code with nothing of the person's: no settings files, hooks or MCP servers, no session kept. */
export const CLAUDE_PROBE_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--no-session-persistence",
];

/** `get_usage` on a short-lived Claude Code (after `initialize`): the snapshot, or null. */
export function probeClaudeUsage(p: UsageProbe): Promise<PlanUsage | null> {
  const request = (id: string, body: Record<string, unknown>) => ({
    type: "control_request",
    request_id: id,
    request: body,
  });
  return jsonLines(
    p,
    CLAUDE_PROBE_ARGS,
    (send) => send(request("init", { subtype: "initialize" })),
    (msg, send) => {
      const r = msg.type === "control_response" && isObj(msg.response) ? msg.response : null;
      if (r?.request_id === "init") {
        if (r.subtype !== "success") return null;
        send(request("usage", { subtype: "get_usage", skip_behaviors: true }));
      } else if (r?.request_id === "usage") return r.subtype === "success" ? claudeUsage(r.response) : null;
      return undefined;
    },
  );
}

/** `account/rateLimits/read` on a short-lived `codex app-server` (after `initialize`): the snapshot, or null. */
export function probeCodexUsage(p: UsageProbe): Promise<PlanUsage | null> {
  return jsonLines(
    p,
    ["app-server"],
    (send) => send({ id: 1, method: "initialize", params: { clientInfo: { name: "agentes_runner", version: "1" } } }),
    (msg, send) => {
      if (msg.id === 1) {
        if (!isObj(msg.result)) return null;
        send({ method: "initialized" });
        send({ id: 2, method: "account/rateLimits/read", params: {} });
      } else if (msg.id === 2) {
        return isObj(msg.result) ? codexUsage(msg.result.rateLimits, "probe") : null;
      }
      return undefined;
    },
  );
}

const DURATION_UNIT: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

/**
 * When a quota refreshes, from words like "resets in 2h 13m", "refreshes in 3 days" or "Resets at 2026-11-05T10:00Z":
 * the ISO time, or undefined.
 */
export function resetFromWords(text: string, now = Date.now()): string | undefined {
  const at = /\b(?:resets?|refresh(?:es)?)\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(
    text,
  );
  if (at?.[1]) return resetIso(at[1].replace(" ", "T"));
  const rel =
    /\b(?:resets?|refresh(?:es)?)\s+in\s+((?:\d+\s*(?:d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)[\s,]*)+)/i.exec(
      text,
    );
  if (!rel?.[1]) return undefined;
  let ms = 0;
  for (const m of rel[1].matchAll(/(\d+)\s*([dhms])/gi))
    ms += Number(m[1]) * (DURATION_UNIT[(m[2] ?? "").toLowerCase()] ?? 0);
  return ms > 0 ? iso(now + ms) : undefined;
}

/**
 * The Antigravity CLI's `/usage` report (ADR 0143), printed in print mode: per model group, its "Five Hour Limit
 * Remaining" and "Weekly Limit Remaining" as percentages left (antigravity.google/docs/models' View Usage panel, read
 * 2026-11-04), with when each refreshes where it says. The first group's (Gemini's) are the plan's windows; another
 * group's ("Claude and GPT models") come as `other` with its name.
 * ponytail: read from the docs' panel, not a real report; the probe drops what it can't read.
 */
export function antigravityUsage(text: string, source: PlanUsage["source"], now = Date.now()): PlanUsage | null {
  const lines = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the CLI's colors
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim());
  const windows: PlanWindow[] = [];
  let group = "";
  let first: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const which = /five[- ]hour/i.test(line) ? "five_hour" : /weekly|seven[- ]day/i.test(line) ? "seven_day" : null;
    if (!which) {
      if (/\bmodels?\b/i.test(line) && !/%/.test(line) && line.length <= 60) {
        group = line.replace(/[:]+$/, "");
      }
      continue;
    }
    const near = `${line} ${lines[i + 1] ?? ""}`;
    const left = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(near);
    if (!left?.[1]) continue;
    const remaining = /remaining|left/i.test(line);
    const used = remaining ? 100 - Number(left[1]) : Number(left[1]);
    const at = resetFromWords(`${near} ${lines[i + 2] ?? ""}`, now);
    first ??= group;
    const other = group !== first && group;
    windows.push({
      ...(other
        ? { kind: "other" as const, label: label(`${group} · ${which === "five_hour" ? "5h" : "7d"}`) }
        : { kind: which }),
      usedPercent: percent(used),
      ...(at ? { resetsAt: at } : {}),
    });
  }
  return snapshot(windows, source, now);
}
