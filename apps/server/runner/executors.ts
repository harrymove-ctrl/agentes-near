import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  type CursorModelInfo,
  parseExecutors,
  type RunnerExecutorInfo,
  type RunnerInfo,
} from "@agenteschat/adapters/machine-protocol";
import { isOpencodeFreeModel, OPENCODE_FREE_MODELS } from "@agenteschat/providers/plans";
import { readSmallJson, writeJson } from "./json-file";
import { SHARED_BIN_ENV } from "./shared-folder";

/**
 * Which coding CLIs this machine has (protocol 7, ADR 0029): `claude` and
 * `codex` on the PATH the runner (and so its tasks) sees, with the first line
 * of `--version`. Best effort and cached: `hello` carries the last known list
 * at once, a fresh look happens in the background at most every
 * `EXECUTORS_TTL_MS`, and a list that changed goes out as `executors.changed`.
 */
export const EXECUTORS_TTL_MS = 10 * 60_000;
/** After a look that couldn't tell (a CLI timed out or failed), the next one comes this soon, then doubles up to the TTL. */
export const EXECUTORS_RETRY_MS = 30_000;
/** A CLI whose `--version` keeps failing this many looks in a row is gone (a broken shim, a launcher left behind). */
export const EXECUTORS_EXIT_STRIKES = 3;

type Executors = NonNullable<RunnerInfo["executors"]>;
type RunResult = { status: number | null; stdout: string; stderr?: string; error?: unknown };
export type ExecutorRun = (command: string, args: string[]) => RunResult | Promise<RunResult>;
type Run = ExecutorRun;

/** Shells' "command not found" (127), "not executable" (126) and cmd.exe's (9009). */
const NOT_FOUND_EXITS = new Set([126, 127, 9009]);

/**
 * Only a binary that isn't there is missing: not found, or a shell saying so (Windows runs CLIs through cmd.exe, an
 * npm shim whose `node` is gone exits 127). A timeout or a crash (a busy machine, a CLI mid-update) says nothing
 * about what is installed, so the last good look stands.
 */
const missing = (r: RunResult) =>
  (r.error as { code?: unknown } | undefined)?.code === "ENOENT" ||
  (r.status !== null && NOT_FOUND_EXITS.has(r.status)) ||
  (process.platform === "win32" &&
    r.status !== 0 &&
    /is not recognized as an internal or external command/i.test(r.stderr ?? ""));

export const isExecutable = (file: string) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * `command`'s full path on the current `process.env.PATH`, or the bare name. The app mode adopts the login
 * shell's PATH after start (`adoptLoginPath`); a compiled runner still looks commands up on the PATH it
 * started with (macOS's bare one from Finder) unless told otherwise, so we resolve it ourselves.
 */
export function resolveCommand(
  command: string,
  pathList = process.env.PATH ?? "",
  sharedBin = process.env[SHARED_BIN_ENV],
): string {
  if (process.platform === "win32" || command.includes("/")) return command;
  const dirs = pathList.split(delimiter).filter((dir) => dir && dir !== sharedBin);
  for (const dir of dirs) {
    const full = join(dir, command);
    if (isExecutable(full)) return full;
  }
  // A bare name would be looked up on the PATH again, shared `bin/` included: a path that isn't there fails the same.
  return sharedBin && dirs[0] ? join(dirs[0], command) : command;
}

/**
 * One argument on cmd.exe's command line, read back by the program as it was: in quotes, so an empty one stays an
 * argument and a space, `&` or `|` stays text; backslashes doubled only where they come before a quote; a quote
 * doubled. `%NAME%` still expands there, so what a person typed goes through its own check first.
 */
export const winQuote = (arg: string) => `"${arg.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, "$1$1")}"`;

/**
 * How a CLI (`command`: a bare name, or a launcher and what it runs) starts with `args`. On Windows a bare name goes
 * through cmd.exe, the one that finds `claude.cmd` and `claude.exe` alike on the PATH, with every argument quoted:
 * Node's own `shell: true` joins them as they are, so an empty one (`--setting-sources ""`) vanished and the next
 * flag became its value, and a path with a space split in two. Elsewhere, and for a launcher: the file and its argv,
 * no shell.
 */
export function cliSpawn(
  command: readonly string[],
  args: readonly string[],
  pathList?: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; windowsVerbatimArguments?: true } {
  const [file = "", ...pre] = command;
  if (platform === "win32" && command.length === 1) {
    const line = [file, ...args].map(winQuote).join(" ");
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: resolveCommand(file, pathList), args: [...pre, ...args] };
}

const defaultRun: Run = (command, args) =>
  new Promise((resolve) => {
    const run = cliSpawn([command], args);
    execFile(
      run.file,
      run.args,
      {
        encoding: "utf8",
        timeout: 8000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: process.env,
        windowsVerbatimArguments: run.windowsVerbatimArguments,
      },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        const out = `${stdout ?? ""}`;
        resolve(
          typeof code === "number"
            ? { status: code, stdout: out, stderr: `${stderr ?? ""}` }
            : err
              ? { status: null, stdout: out, error: err }
              : { status: 0, stdout: out },
        );
      },
    );
  });

const word = (v: unknown) => (typeof v === "string" && /^[\w.-]{1,40}$/.test(v) ? v : undefined);

/**
 * The rate-limit tier of the plan Anthropic sold as Max 20x, called Ultra since 2026-10-30 (claude.com/pricing);
 * the old Max 5x, now Max, is `default_claude_max_5x`.
 */
const ULTRA_TIER = "default_claude_max_20x";
/** `.claude.json` also holds the CLI's projects: one larger than this isn't read. */
const CLAUDE_CONFIG_MAX_BYTES = 4 * 1024 * 1024;
/** Claude Code's `subscriptionType` for each organization type, as the CLI maps them. */
const CLAUDE_ORG_PLANS = new Map([
  ["claude_pro", "pro"],
  ["claude_max", "max"],
  ["claude_team", "team"],
  ["claude_enterprise", "enterprise"],
]);

/**
 * Claude's plan as Anthropic names it (`pro`, `max`, `ultra`, `team`, `enterprise`): Claude Code's
 * `subscriptionType`, which says `max` for both Max and Ultra, told apart by the organization's rate-limit tier
 * (`tier`, read only for a `max`). A `max` whose tier is unknown stays `max`.
 */
export function claudePlan(subscriptionType: unknown, tier: () => unknown): string | undefined {
  const plan = word(subscriptionType);
  return plan === "max" && tier() === ULTRA_TIER ? "ultra" : plan;
}

/**
 * The organization Claude Code is signed in to, as the CLI keeps it in its config folder's `.claude.json`
 * (`oauthAccount`): its type and rate-limit tier, which `auth status` doesn't say. Its sign-in writes both, and they
 * are missing only where its bootstrap call there failed or was skipped (offline, nonessential traffic off, another
 * provider). `own`: the computer's own config, read through a link as Claude Code reads it; an account folder's never
 * is.
 */
function claudeOrganization(configDir: string, own = false) {
  const config = readSmallJson(join(configDir, ".claude.json"), CLAUDE_CONFIG_MAX_BYTES, own) as {
    oauthAccount?: { organizationType?: unknown; organizationRateLimitTier?: unknown };
  } | null;
  return config?.oauthAccount;
}

/** The rate-limit tier of the organization Claude Code is signed in to (`claudeOrganization`). */
export const claudeTier = (configDir: string, own = false): unknown =>
  claudeOrganization(configDir, own)?.organizationRateLimitTier;

/** The plan as `claudePlan` names it from `.claude.json` alone, for a folder where no CLI may run. */
export function claudeKeptPlan(configDir: string): string | undefined {
  const org = claudeOrganization(configDir);
  const type = typeof org?.organizationType === "string" ? CLAUDE_ORG_PLANS.get(org.organizationType) : undefined;
  return claudePlan(type, () => org?.organizationRateLimitTier);
}

/**
 * Protocol 8: whether Claude Code is logged in (`claude auth status --json`:
 * `loggedIn`, `authMethod`, `subscriptionType`, the plan as `claudePlan` names
 * it). Only these three leave the machine (never the email or the
 * organization). Unknown on any failure; null when the CLI couldn't answer (timed out, failed to start).
 */
export async function claudeAuth(
  run: Run = defaultRun,
  tier: () => unknown = () => claudeTier(process.env.CLAUDE_CONFIG_DIR || homedir(), true),
): Promise<{ loggedIn?: boolean; authMethod?: string; plan?: string } | null> {
  try {
    const r = await run("claude", ["auth", "status", "--json"]);
    if (r.error) return missing(r) ? {} : null;
    const json = JSON.parse(r.stdout.trim() || "null") as Record<string, unknown> | null;
    if (!json || typeof json !== "object") return r.status !== 0 ? { loggedIn: false } : {};
    const authMethod = word(json.authMethod);
    const plan = claudePlan(json.subscriptionType, tier);
    return {
      ...(typeof json.loggedIn === "boolean" ? { loggedIn: json.loggedIn } : {}),
      ...(authMethod ? { authMethod } : {}),
      ...(plan ? { plan } : {}),
    };
  } catch {
    return {};
  }
}

/** Cursor's CLI, named `agent` since it was renamed from `cursor-agent`. */
export const CURSOR_BIN = "agent";

/**
 * `agent models` → the models its sign-in lists. One per line, `<id> - <label>` (or the id alone); a line that says
 * the plan includes it (`included`) marks it `inPlan`. Headers and anything that isn't a model id are skipped.
 */
export function parseCursorModels(output: string): CursorModelInfo[] {
  const out: CursorModelInfo[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the CLI's colors
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
  for (const raw of clean.split("\n")) {
    const line = raw.replace(/^[\s*•>-]+/, "").trim();
    const m = /^([a-z0-9][\w.:/-]{0,79})(?:\s+[-–—:]\s+(.+))?$/i.exec(line);
    if (!m?.[1] || !/[\d-]/.test(m[1]) || out.some((x) => x.id === m[1])) continue;
    const rest = m[2]?.trim() ?? "";
    const inPlan = /\bincluded\b/i.test(rest);
    const label = rest
      .replace(/\(?\s*(?:current|default|included(?: in (?:your )?plan)?)\s*\)?/gi, "")
      .trim()
      .slice(0, 80);
    out.push({ id: m[1], ...(label ? { label } : {}), ...(inPlan ? { inPlan: true } : {}) });
    if (out.length >= 60) break;
  }
  return out;
}

/** Cursor's CLI versions are dated (`2026.10.28-1a2b3c4`): an `agent` on the PATH that isn't Cursor's is skipped. */
const CURSOR_VERSION = /^\d{4}\.\d{1,2}\.\d{1,2}\b/;

/**
 * Protocol 36 (ADR 0114): Cursor's CLI (`agent`) and the models its sign-in lists (`agent models`, which asks
 * Cursor: none when signed out or offline).
 */
function detectCursor(run: Run): Promise<Probe> {
  return detectWithModels(run, CURSOR_BIN, CURSOR_VERSION, parseCursorModels);
}

/** OpenCode's CLI (`opencode-ai` on npm). */
export const OPENCODE_BIN = "opencode";

/**
 * `opencode models` → the models it can run: one `provider/model` per line (its own sort, OpenCode's first). With no
 * key that is OpenCode's free tier and whatever providers the computer's own config signs in; `free` marks the free
 * tier's. Anything that isn't a `provider/model` id is skipped.
 */
export function parseOpencodeModels(output: string): CursorModelInfo[] {
  const out: CursorModelInfo[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the CLI's colors
  for (const raw of output.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
    const id = raw.trim();
    if (!/^[\w.-]{1,40}\/[\w.:-]{1,79}$/.test(id) || id.length > 80 || out.some((x) => x.id === id)) continue;
    const label = OPENCODE_FREE_MODELS.find((m) => m.id === id)?.label;
    out.push({ id, ...(label ? { label } : {}), ...(isOpencodeFreeModel(id) ? { free: true } : {}) });
    if (out.length >= 60) break;
  }
  return out;
}

/** OpenCode's versions are plain semver (`1.19.5`): an `opencode` on the PATH that says anything else is skipped. */
const OPENCODE_VERSION = /^v?\d+\.\d+\.\d+\b/;

/** Protocol 39 (ADR 0132): OpenCode's CLI and the models it lists (`opencode models`: the free tier with no key). */
function detectOpencode(run: Run): Promise<Probe> {
  return detectWithModels(run, OPENCODE_BIN, OPENCODE_VERSION, parseOpencodeModels);
}

/** xAI's Grok Build CLI. Always `grok`: its installer also makes `~/.local/bin/agent`, which is Cursor's name. */
export const GROK_BIN = "grok";

/**
 * `grok models` → the models it lists: `  * grok-4.6 (default)` and `  - grok-4.5` under "Available models" (Grok Build
 * 1.0.34). Anything else (its "Default model:" line, a sign-in notice) is skipped.
 */
export function parseGrokModels(output: string): CursorModelInfo[] {
  const out: CursorModelInfo[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the CLI's colors
  for (const raw of output.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
    const id = /^\s*[*-]\s+([a-z0-9][\w.:/-]{0,79})(?:\s|$)/i.exec(raw)?.[1];
    if (!id || out.some((x) => x.id === id)) continue;
    out.push({ id });
    if (out.length >= 60) break;
  }
  return out;
}

/** Grok Build's version line: `grok 1.0.34 (3736acbc8658) [stable]`; a `grok` that says anything else is skipped. */
const GROK_VERSION = /^grok \d+\.\d+\.\d+\b/;

/** Protocol 43 (ADR 0142): Grok Build and the models it lists (`grok models`). */
function detectGrok(run: Run): Promise<Probe> {
  return detectWithModels(run, GROK_BIN, GROK_VERSION, parseGrokModels);
}

/** Google's Antigravity CLI (ADR 0143). */
export const AGY_BIN = "agy";

/**
 * `agy models` → its slugs and names, one per line, split by a tab in 1.5.0 (`gemini-4-argon-high\tGemini 4 Argon
 * (High)`) or by spaces. A line without a slug and a name (a sign-in notice, `...`) is skipped.
 */
export function parseAgyModels(output: string): CursorModelInfo[] {
  const out: CursorModelInfo[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the CLI's colors
  for (const raw of output.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
    const m = /^\s*([a-z0-9][\w.:/-]{0,79})(?:\t\s*| {2,})(\S.{0,79}?)\s*$/i.exec(raw);
    if (!m?.[1] || !m[2] || out.some((x) => x.id === m[1])) continue;
    out.push({ id: m[1], label: m[2] });
    if (out.length >= 60) break;
  }
  return out;
}

/** The Antigravity CLI's version line has its version in it (`agy 1.4.12`, `1.4.12`); anything else is skipped. */
const AGY_VERSION = /^(?:agy|antigravity(?: cli)?)?[\s:v]*\d+\.\d+\.\d+\b/i;

/** Protocol 44 (ADR 0143): the Antigravity CLI and the models it lists (`agy models`). */
function detectAntigravity(run: Run): Promise<Probe> {
  return detectWithModels(run, AGY_BIN, AGY_VERSION, parseAgyModels);
}

/**
 * One CLI's look: what it found, and whether it couldn't tell (then the last good look stands). `exited`: unsure
 * because `--version` failed with an exit code, counted toward `EXECUTORS_EXIT_STRIKES`.
 */
type Probe = { entry?: RunnerExecutorInfo; unsure?: boolean; exited?: boolean };

const versionFailed = (r: RunResult): Probe =>
  missing(r) ? {} : r.error ? { unsure: true } : { unsure: true, exited: true };

const firstLine = (r: RunResult) => r.stdout.trim().split("\n")[0]?.trim().slice(0, 80) ?? "";

/** `<bin> --version` checked against `shape`, then `<bin> models` (none when signed out or offline). */
async function detectWithModels(
  run: Run,
  bin: string,
  shape: RegExp,
  parse: (output: string) => CursorModelInfo[],
): Promise<Probe> {
  const r = await run(bin, ["--version"]);
  if (r.error || r.status !== 0) return versionFailed(r);
  const version = firstLine(r);
  if (!shape.test(version)) return {};
  const m = await run(bin, ["models"]);
  const models = !m.error && m.status === 0 ? parse(m.stdout) : [];
  return {
    entry: { version, ...(models.length ? { models } : {}) },
    ...(m.error && !missing(m) ? { unsure: true } : {}),
  };
}

async function detectVersion(run: Run, name: "claude" | "codex"): Promise<Probe> {
  const r = await run(name, ["--version"]);
  if (r.error || r.status !== 0) return versionFailed(r);
  const version = firstLine(r);
  if (!version) return {};
  if (name !== "claude") return { entry: { version } };
  const auth = await claudeAuth(run);
  return auth ? { entry: { version, ...auth } } : { entry: { version }, unsure: true };
}

/**
 * Every CLI looked up at once. One that couldn't tell keeps its entry from `prev` (the last good look), and the
 * whole look is `unsure`, so it is retried soon instead of cached. `strikes` counts each CLI's failing exits in a
 * row across looks (the caller keeps it).
 */
export async function detectExecutors(
  run: Run = defaultRun,
  prev: Executors = {},
  strikes: Partial<Record<string, number>> = {},
): Promise<{ found: Executors; unsure: boolean }> {
  const safe = (p: () => Promise<Probe>) => p().catch((): Probe => ({ unsure: true }));
  const names = ["claude", "codex", "cursor", "opencode", "grok", "antigravity"] as const;
  const probes = await Promise.all([
    safe(() => detectVersion(run, "claude")),
    safe(() => detectVersion(run, "codex")),
    safe(() => detectCursor(run)),
    safe(() => detectOpencode(run)),
    safe(() => detectGrok(run)),
    safe(() => detectAntigravity(run)),
  ]);
  const found: Executors = {};
  let unsure = false;
  names.forEach((name, i) => {
    let p = probes[i] ?? {};
    strikes[name] = p.exited ? (strikes[name] ?? 0) + 1 : 0;
    if ((strikes[name] ?? 0) >= EXECUTORS_EXIT_STRIKES) p = {};
    const entry = p.unsure ? (prev[name] ?? p.entry) : p.entry;
    if (entry) found[name] = entry;
    if (p.unsure) unsure = true;
  });
  return { found, unsure };
}

/** The last list kept on disk, believed only as far as `hello` would carry it; null when there is none. */
function keptExecutors(file: string): Executors | null {
  const kept = readSmallJson(file, 1024 * 1024);
  return kept && typeof kept === "object" && !Array.isArray(kept)
    ? parseExecutors(kept as Record<string, unknown>)
    : null;
}

export interface ExecutorsCache {
  /** The last known list, at once; a look starts in the background when it is due. */
  (): Executors;
  /** False until a list is known (kept on disk or looked up): an empty list then means "not looked yet", not "none". */
  readonly known: boolean;
  /** The list, waiting for the first look when none is known yet. */
  ready(): Promise<Executors>;
  /** A look now, whatever the TTL says (the app's "Check again" after an install). */
  fresh(): Promise<Executors>;
}

/**
 * `detectExecutors` in the background, looked up again only after the TTL (sooner after an unsure look). `file`
 * keeps the last list across restarts, so the first `hello` after one already has it; `onChange` hears of a list
 * that changed.
 */
export function cachedExecutors(
  opts: { now?: () => number; run?: Run; file?: string; onChange?: (found: Executors) => void } = {},
): ExecutorsCache {
  const now = opts.now ?? Date.now;
  const kept = opts.file ? keptExecutors(opts.file) : null;
  let value: Executors = kept ?? {};
  let known = kept !== null;
  let at = Number.NEGATIVE_INFINITY;
  let wait = EXECUTORS_TTL_MS;
  let retry = 0;
  let running: Promise<Executors> | null = null;
  const strikes: Partial<Record<string, number>> = {};
  const look = (): Promise<Executors> =>
    (running ??= detectExecutors(opts.run, value, strikes)
      .then(({ found, unsure }) => {
        at = now();
        retry = unsure ? Math.min(retry ? retry * 2 : EXECUTORS_RETRY_MS, EXECUTORS_TTL_MS) : 0;
        wait = retry || EXECUTORS_TTL_MS;
        if (unsure) setTimeout(() => void look(), wait).unref?.();
        const changed = !known || JSON.stringify(found) !== JSON.stringify(value);
        value = found;
        known = true;
        if (changed) {
          if (opts.file) {
            try {
              writeJson(opts.file, found);
            } catch {}
          }
          try {
            opts.onChange?.(found);
          } catch {}
        }
        return value;
      })
      .finally(() => {
        running = null;
      }));
  const get = (() => {
    if (now() - at >= wait) void look();
    return value;
  }) as ExecutorsCache;
  get.ready = () => (known ? Promise.resolve(get()) : look());
  get.fresh = look;
  Object.defineProperty(get, "known", { get: () => known });
  return get;
}

/**
 * `codex --version` alone, for a Codex turn: a good answer is kept for the TTL; null when it couldn't tell (timed
 * out, failed), never cached.
 */
export function cachedCodexVersion(run: Run = defaultRun, now: () => number = Date.now) {
  let kept: { version?: string; at: number } | undefined;
  return async (): Promise<string | undefined | null> => {
    if (kept && now() - kept.at < EXECUTORS_TTL_MS) return kept.version;
    const p = await detectVersion(run, "codex").catch((): Probe => ({ unsure: true }));
    if (p.unsure) return null;
    kept = { ...(p.entry ? { version: p.entry.version } : {}), at: now() };
    return kept.version;
  };
}
