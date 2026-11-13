import {
  AGENT_ACCESSORIES,
  AGENT_COLORS,
  AGENT_EYES,
  type AgentAppearance,
  type AgentColor,
} from "@agenteschat/tokens/look";
import { isSecretPath, setsCredential } from "@agenteschat/tokens/names";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  ApiRule,
  BundleAgent,
  BundleChannel,
  BundleNote,
  BundleRoutine,
  BundleSkill,
  BundleTodo,
} from "../../api/types";
import { handleFrom } from "../text";

/** A file to read: `name` is its path relative to the dropped folder, the archive root or the GitHub link. */
export interface ImportFile {
  name: string;
  /** "" for a file that was not read (binary, too large, or a credential store). */
  text: string;
  /** Bytes, when the reader knows them. */
  size?: number;
  /** Its bytes as they are, read only when the file is copied to the Drive (a link's files have none). */
  read?: () => Promise<Blob>;
  /** The text of a small file no format reads (a script, a config), only to look for keys before it goes to the Drive. */
  peek?: string;
}

export type ImportErrorCode = "empty" | "tooLarge" | "unknown" | "newerVersion" | "noAgents" | "unsafe" | "corrupt";

/** An archive the import unpacks (on the web; the phone opens none). */
export const ARCHIVE_PATH = /\.(zip|tar\.gz|tgz|tar)$/i;
/** The text files the formats use: the only ones read. */
export const TEXT_PATH = /\.(md|markdown|json|json5|yaml|yml|txt)$/i;

export class ImportError extends Error {
  constructor(readonly code: ImportErrorCode) {
    super(code);
    this.name = "ImportError";
  }
}

export interface ParseOptions {
  /** Model ids of our catalog; a source model outside it isn't used. */
  models?: string[];
  /** Name of the dropped folder or of the archive's root folder (Hermes names the profile after it). */
  root?: string | null;
  /** System files the reader dropped (`.DS_Store`, `__MACOSX`…), relative to the root like the files. */
  junk?: string[];
}

/** OpenMausBot's limit for a package (PACKAGE_MAX_BYTES); no file we read is larger. */
export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;
/** Our note limit (`FIELD.note` in packages/engine/src/imports.ts): longer memory is split, never cut. */
const NOTE_MAX = 8000;

export type LeftOutKind =
  | "skill"
  | "routine"
  | "notes"
  | "picture"
  | "preset"
  | "remote"
  | "model"
  | "connection"
  | "plugin"
  | "messaging"
  | "task"
  | "team"
  | "secret"
  | "redacted"
  | "file"
  | "other";

export interface LeftOut {
  kind: LeftOutKind;
  /** What it is, in the source's words (a name, a key, a file). */
  label: string;
}

export type Trigger = BundleRoutine["trigger"];

// ── Values ────────────────────────────────────────────────────────────────────

export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string =>
  typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
export const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
export const first = (...values: unknown[]) => values.map(str).find(Boolean) ?? "";

export const join = (parts: string[]) =>
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");

export function section(title: string, parts: string[]): string {
  const body = join(parts);
  if (!body) return "";
  return title ? `## ${title}\n\n${body}` : body;
}

/** Lowercase words joined by `-` (skill names, keys, channel names). */
export const slug = (text: string, max = 64) =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");

// ── Paths ─────────────────────────────────────────────────────────────────────

export const normalizePath = (path: string) =>
  path
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/|\/)+/, "")
    .replace(/\/{2,}/g, "/");
export const baseName = (path: string) => path.split("/").pop() ?? path;
export const dirName = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
/** `path` read from `dir`, `..` resolved; null when it leaves the root. */
export function resolvePath(dir: string, path: string): string | null {
  const out: string[] = [];
  for (const part of `${dir}/${path.replace(/\\/g, "/")}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/**
 * Credential stores (`isSecretPath`, shared with the server, which refuses them in the Drive too): an import never
 * reads them, only lists their names. (Databases and other binaries are never read either: no format keeps what we
 * bring in them.)
 */
export { isSecretPath };

// ── Reading text ──────────────────────────────────────────────────────────────

const asJson = new WeakMap<ImportFile, unknown>();
const asYaml = new WeakMap<ImportFile, unknown>();
/** Every detector parses the same files: once per file and syntax. */
const memo = (cache: WeakMap<ImportFile, unknown>, file: ImportFile, read: () => unknown) => {
  if (!cache.has(file)) {
    let value: unknown = null;
    try {
      value = read();
    } catch {}
    cache.set(file, value);
  }
  return cache.get(file);
};
const asRecord = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Drops `// …` and block comments outside strings: openclaw.json is JSON5, and the YAML parser reads the rest. */
function stripJsonComments(text: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += ch;
  }
  return out;
}

/**
 * The JSON object in a file: the whole text; for a text at the root (a pasted
 * reply), also a fenced code block or the outermost braces; JSON5 for `.json`.
 */
export function jsonOf(file: ImportFile): Record<string, unknown> | null {
  return asRecord(
    memo(asJson, file, () => {
      const text = file.text.replace(/^\uFEFF/, "").trim();
      const candidates = [text];
      if (!text.startsWith("{") && !file.name.includes("/") && !/\.json5?$/i.test(file.name)) {
        for (const m of text.matchAll(/```[a-zA-Z0-9]*[ \t]*\r?\n?([\s\S]*?)```/g))
          candidates.push((m[1] ?? "").trim());
        const open = text.indexOf("{");
        const close = text.lastIndexOf("}");
        if (open >= 0 && close > open) candidates.push(text.slice(open, close + 1));
      }
      for (const c of candidates) {
        if (!c.startsWith("{")) continue;
        try {
          const v: unknown = JSON.parse(c);
          if (asRecord(v)) return v;
        } catch {}
      }
      return /\.json5?$/i.test(file.name) ? parseYaml(stripJsonComments(text)) : null;
    }),
  );
}

export const yamlOf = (file: ImportFile) => asRecord(memo(asYaml, file, () => parseYaml(file.text)));

/** YAML frontmatter and the Markdown body, or null without a frontmatter block. */
export function frontmatter(text: string): { data: Record<string, unknown>; body: string } | null {
  const m = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .match(/^---[^\S\n]*\n([\s\S]*?)\n---[^\S\n]*(?:\n|$)([\s\S]*)$/);
  if (!m) return null;
  try {
    return { data: obj(parseYaml(m[1] ?? "")), body: (m[2] ?? "").trim() };
  } catch {
    return null;
  }
}

// ── Hashes ────────────────────────────────────────────────────────────────────

const K = Uint32Array.from(
  (
    "428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 " +
    "72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da " +
    "983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 " +
    "650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 " +
    "19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 " +
    "90befffa a4506ceb bef9a3f7 c67178f2"
  )
    .split(" ")
    .map((h) => Number.parseInt(h, 16)),
);
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256 hex of the UTF-8 text, synchronous because parsing is (Web Crypto is async). */
export function sha256(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const words = new Uint32Array((((bytes.length + 8) >> 6) + 1) << 4);
  bytes.forEach((b, i) => {
    words[i >> 2] = (words[i >> 2] as number) | (b << (24 - (i % 4) * 8));
  });
  words[bytes.length >> 2] = (words[bytes.length >> 2] as number) | (0x80 << (24 - (bytes.length % 4) * 8));
  words[words.length - 1] = bytes.length * 8;
  const h = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let at = 0; at < words.length; at += 16) {
    for (let i = 0; i < 64; i++) {
      if (i < 16) {
        w[i] = words[at + i] as number;
        continue;
      }
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      w[i] =
        (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
        (w[i - 7] as number) +
        (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)) +
        (w[i - 16] as number);
    }
    const s = Array.from(h);
    for (let i = 0; i < 64; i++) {
      const [a, b, c, , e, f, g, hh] = s as [number, number, number, number, number, number, number, number];
      const t1 =
        (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K[i] as number) + (w[i] as number)) |
        0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      s.pop();
      s.unshift((t1 + t2) | 0);
      s[4] = ((s[4] as number) + t1) | 0;
    }
    s.forEach((v, i) => {
      h[i] = (h[i] as number) + v;
    });
  }
  return Array.from(h, (v) => v.toString(16).padStart(8, "0")).join("");
}

/** How a default template is compared: LF line ends, no BOM, trimmed. */
export const templateHash = (text: string) =>
  sha256(
    text
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n")
      .trim(),
  );

// ── Secrets ───────────────────────────────────────────────────────────────────

const REDACTED = "[redacted]";
/**
 * Text that looks like a credential never travels. A superset of what the
 * server refuses (`looksLikeSecret` in packages/engine/src/context/items.ts),
 * so an import loses the value instead of the whole item; `name: value` loses
 * its separator too, or the server would still read it as a credential.
 */
const KEY_FORMATS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/gi, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9._-]{20,}/gi, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/gi, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{20,}/gi, `$1 ${REDACTED}`],
];
const SECRET_PATTERNS: [RegExp, string][] = [
  ...KEY_FORMATS,
  [/\b(password|senha|passwd|secret|api[_ -]?key|token)\s*[:=]\s*\S{6,}/gi, `$1 ${REDACTED}`],
];

/** A file that holds a key: one by its format, or one set in its text (`setsCredential`, as the server checks). */
export const holdsKey = (text: string) =>
  KEY_FORMATS.some(([re]) => new RegExp(re.source, re.flags.replace("g", "")).test(text)) || setsCredential(text);

export function scrubSecrets(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return { text: out, redacted: out !== text };
}

// ── Agents ────────────────────────────────────────────────────────────────────

/**
 * Our handle rule (HANDLE_PATTERN in packages/engine/src/agents.ts): the source key when it fits. A key that is an
 * id stays too: the server gives that agent a handle from its name (`isIdHandle`), and the bundle of a file imported
 * before still hashes the same.
 */
export function handleOf(key: string, name: string): string {
  const k = key
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
  return /^[a-z0-9][a-z0-9_-]{1,31}$/.test(k) ? k : handleFrom(name);
}

/** `base`, else `base2`, `base3`… not in `used` (≤ 32 characters). */
export function uniqueHandle(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 32 - String(n).length)}${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** A stable look from a seed: the source's color when it has one; eyes and accessory from the seed. */
export function lookFor(seed: string, color?: AgentColor): Required<AgentAppearance> {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619) >>> 0;
  const at = <T>(items: readonly T[], shift: number) => items[(h >>> shift) % items.length] as T;
  return {
    color: color ?? at(AGENT_COLORS, 0),
    eyes: at(AGENT_EYES, 8),
    accessory: at(AGENT_ACCESSORIES, 16),
  };
}

// ── Skills ────────────────────────────────────────────────────────────────────

/** Our skill name rule (SKILL_NAME in packages/engine/src/skills.ts). */
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The SKILL.md as written when its frontmatter has a valid `name` and
 * `description`; otherwise the frontmatter is written again with them (from
 * the source's fields) and the body is kept word for word.
 */
export function skillMarkdown(text: string, name: string, description = "", extra: Record<string, unknown> = {}) {
  const fm = frontmatter(text);
  const { name: ownName, description: ownAbout, ...rest } = fm?.data ?? {};
  const body = fm ? fm.body : text.replace(/^\uFEFF/, "").trim();
  const wanted = slug(str(ownName) || name);
  // A description longer than ours stays as written: the server reports that skill instead of us cutting it.
  const about =
    oneLine(str(ownAbout) || description) ||
    oneLine((body.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "")).slice(0, 1024) ||
    wanted;
  if (fm && str(ownName) === wanted && str(ownAbout)) return text;
  const head = stringifyYaml({ name: wanted, description: about, ...extra, ...rest }, { lineWidth: 0 }).trimEnd();
  return `---\n${head}\n---\n\n${body}\n`;
}

// ── Schedules ─────────────────────────────────────────────────────────────────

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** A five-field cron our scheduler reads (names become numbers, `?` becomes `*`), or null. */
export function cronOf(expression: string): string | null {
  const raw = expression.trim().replace(/\s+/g, " ");
  const fields = (MACROS[raw.toLowerCase()] ?? raw).split(" ");
  if (fields.length !== 5) return null;
  const named = (field: string, table: string[], offset: number) =>
    field.replace(/[A-Za-z]{3}/g, (n) => {
      const i = table.indexOf(n.toUpperCase());
      return i < 0 ? n : String(i + offset);
    });
  fields[3] = named(fields[3] as string, MONTHS, 1);
  fields[4] = named(fields[4] as string, DAYS, 0);
  const out = fields.map((f) => (f === "?" ? "*" : f));
  return out.every((f) => /^[\d*,/-]+$/.test(f)) ? out.join(" ") : null;
}

export const cronTrigger = (expression: string, timezone?: string | null): Trigger | null => {
  const cron = cronOf(expression);
  return cron ? { cron, timezone: timezone || null } : null;
};

const clock = (time: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? { h: Number(m[1]), m: Number(m[2]) } : null;
};

/** At `time` ("HH:MM") on these weekdays (0 = Sunday; none = every day) or days of the month. */
export function atTime(time: string, timezone: string | null, weekdays: number[] = [], monthDays: number[] = []) {
  const t = clock(time);
  if (!t) return null;
  const dow = [...new Set(weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  const dom = monthDays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 31);
  const days = dow.length === 0 || dow.length === 7 ? "*" : dow.join(",");
  return cronTrigger(`${t.m} ${t.h} ${dom.length ? dom.join(",") : "*"} * ${days}`, timezone);
}

/**
 * Every `minutes`, from `anchor` (epoch ms) when there is one: a cron when the
 * cadence divides an hour or a day (in UTC, so the runs keep their instants),
 * a rule for whole days; null for a cadence neither can say.
 */
export function everyMinutes(minutes: number, anchor?: number | null): Trigger | null {
  if (!Number.isInteger(minutes) || minutes < 1) return null;
  const at = anchor !== undefined && anchor !== null && Number.isFinite(anchor) ? new Date(anchor) : null;
  const timezone = at ? "UTC" : null;
  if (minutes < 60 && 60 % minutes === 0) {
    const field = minutes === 1 ? "*" : at ? `${at.getUTCMinutes() % minutes}/${minutes}` : `*/${minutes}`;
    return { cron: `${field} * * * *`, timezone };
  }
  const minute = at ? at.getUTCMinutes() : 0;
  const hours = minutes / 60;
  if (Number.isInteger(hours) && hours < 24 && 24 % hours === 0) {
    const field = hours === 1 ? "*" : at ? `${at.getUTCHours() % hours}/${hours}` : `*/${hours}`;
    return { cron: `${minute} ${field} * * *`, timezone };
  }
  const days = minutes / 1440;
  if (!Number.isInteger(days)) return null;
  const time = at ? `${String(at.getUTCHours()).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : "09:00";
  const rule: ApiRule = { freq: "daily", interval: days, times: [time], timezone: timezone ?? "" };
  if (at) rule.start = at.toISOString().slice(0, 10);
  return { rule };
}

/** One run at a local date ("YYYY-MM-DD") and time in a zone (the person's when unknown). */
export function onceAt(date: string, time: string, timezone: string | null): Trigger | null {
  const t = clock(time);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !t) return null;
  const hhmm = `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`;
  return { rule: { freq: "once", start: date, times: [hhmm], timezone: timezone ?? "" } };
}

/** A duration like "30m", "2h", "1d" or "45" (minutes), in whole minutes, or null. */
export function durationMinutes(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)?$/i.exec(text.trim());
  if (!m) return null;
  const unit = (m[2] ?? "m").toLowerCase()[0];
  const n = Number(m[1]) * (unit === "s" ? 1 / 60 : unit === "h" ? 60 : unit === "d" ? 1440 : 1);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── Connections ───────────────────────────────────────────────────────────────

/** An address without credentials, query or fragment (some services keep a key there). */
export function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return `${u.origin}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return "";
  }
}
export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

// ── The draft every parser fills ──────────────────────────────────────────────

export interface DraftAgent {
  key: string;
  name: string;
  /** The source's own handle, when it has one that fits ours (else from the key or the name). */
  handle?: string;
  role?: string;
  instructions?: string;
  /** The source's model, mapped to our catalog (else listed). */
  model?: unknown;
  color?: AgentColor;
  /** Seed for the look (default: the key). */
  seed?: string;
  appearance?: AgentAppearance;
  skills?: string[];
}

export interface DraftNote {
  key: string;
  agent: string | null;
  kind: BundleNote["kind"];
  title?: string;
  content: string;
}

/**
 * What a parser found. `finish` (index.ts) then checks the references,
 * scrubs the text, splits long notes and lists the files nobody read.
 */
export class Draft {
  readonly agents: BundleAgent[] = [];
  readonly skills: BundleSkill[] = [];
  readonly channels: BundleChannel[] = [];
  readonly routines: BundleRoutine[] = [];
  readonly notes: DraftNote[] = [];
  readonly todo: BundleTodo[] = [];
  readonly leftOut: LeftOut[] = [];
  /** Files a parser read, or dropped on purpose (an unchanged template). */
  readonly used = new Set<string>();
  /** Folders of an agent's own files (`skip`: its subfolders that aren't, like its skills). */
  readonly fileDirs: { agent: string; dir: string; skip: string[] }[] = [];
  /** Single files of an agent, and where they go in its folder. */
  readonly agentFiles: { agent: string; from: string; to: string }[] = [];
  name = "";
  ref = "";

  constructor(
    readonly files: ImportFile[],
    readonly options: ParseOptions,
  ) {}

  /** The file at `path`, marked as read. */
  file(path: string | null): ImportFile | undefined {
    if (path === null) return undefined;
    const file = this.files.find((f) => f.name === path);
    if (file) this.used.add(file.name);
    return file;
  }

  /** Files under `dir/` (not marked as read). */
  under(dir: string): ImportFile[] {
    const prefix = dir ? `${dir}/` : "";
    return this.files.filter((f) => f.name.startsWith(prefix));
  }

  left(kind: LeftOutKind, label: string) {
    if (label.trim()) this.leftOut.push({ kind, label: label.trim() });
  }

  /** What is under `dir` and nothing else reads is the agent's own (`finish` decides, once every file is read). */
  filesIn(agent: string, dir: string, skip: string[] = []) {
    this.fileDirs.push({ agent, dir, skip });
  }

  /** One file of the agent's own, at `to` in its folder. */
  fileAt(agent: string, from: string, to: string) {
    this.used.add(from);
    this.agentFiles.push({ agent, from, to });
  }

  need(kind: BundleTodo["kind"], label: string, agents: string[] = [], url?: string) {
    if (!label.trim()) return;
    const same = this.todo.find((t) => t.kind === kind && t.label === label.trim());
    if (same) same.agents = [...new Set([...same.agents, ...agents])];
    else this.todo.push({ kind, label: label.trim(), agents: [...new Set(agents)], ...(url ? { url } : {}) });
  }

  /** Our catalog id for the source's model ("provider/model", "provider:model"), else null and listed. */
  model(raw: unknown): string | null {
    const wanted = str(raw);
    if (!wanted) return null;
    const bare = (wanted.split(/[/:]/).pop() ?? "").trim().toLowerCase();
    const models = this.options.models ?? [];
    const hit = [bare, bare.replace(/\./g, "-")].find((m) => models.includes(m));
    if (hit) return hit;
    this.left("model", wanted);
    return null;
  }

  /** Adds an agent; the first of two with one key wins. */
  agent(a: DraftAgent): string | null {
    const key = a.key.trim();
    const name = a.name.trim() || key;
    if (!key || this.agents.some((x) => x.key === key)) return null;
    const look = Object.fromEntries(Object.entries(a.appearance ?? {}).filter(([, v]) => v));
    this.agents.push({
      key,
      name,
      handle: handleOf(a.handle || key, name),
      role: (a.role ?? "").trim(),
      instructions: (a.instructions ?? "").trim(),
      model: a.model === undefined ? null : this.model(a.model),
      appearance: { ...lookFor(a.seed || key, a.color), ...look },
      skills: [...new Set(a.skills ?? [])],
    });
    return key;
  }

  /** Adds a skill (one per name; a different text under a taken name is listed). Its key, or null. */
  skill(markdown: string, fallbackName: string, description = "", extra: Record<string, unknown> = {}): string | null {
    if (!markdown.trim()) {
      this.left("skill", fallbackName);
      return null;
    }
    const text = skillMarkdown(markdown, fallbackName, description, extra);
    const key = str(frontmatter(text)?.data.name);
    if (!SKILL_NAME.test(key)) {
      this.left("skill", fallbackName);
      return null;
    }
    const same = this.skills.find((s) => s.key === key);
    if (same && same.markdown !== text) this.left("skill", fallbackName === key ? key : `${fallbackName} (${key})`);
    if (!same) this.skills.push({ key, markdown: text });
    return key;
  }

  /** The SKILL.md of a skill folder; its other files (scripts, references) are listed, not brought. */
  skillDir(dir: string, label = baseName(dir)): string | null {
    const md = this.file(`${dir}/SKILL.md`);
    if (!md?.text) {
      this.left("skill", label);
      return null;
    }
    const extra = this.under(dir).filter((f) => !this.used.has(f.name));
    for (const f of extra) this.used.add(f.name);
    if (extra.length) this.left("file", `${dir}/ (${extra.length})`);
    return this.skill(md.text, label);
  }

  /** Every `<dir>/…/SKILL.md` folder under `root`, as skills; their keys. */
  skillsUnder(root: string): string[] {
    const prefix = root ? `${root}/` : "";
    return this.files
      .filter((f) => f.name.startsWith(prefix) && baseName(f.name) === "SKILL.md" && f.name !== `${prefix}SKILL.md`)
      .flatMap((f) => {
        const key = this.skillDir(dirName(f.name));
        return key ? [key] : [];
      });
  }

  /**
   * A remote MCP server to connect again, labeled by its name (else its host) since the label reads inside a sentence
   * ("Ada usa o HubSpot."); header values never come. One that runs a command is listed.
   */
  connection(name: string, url: string, agents: string[] = []) {
    const clean = cleanUrl(url);
    if (!clean) {
      this.left("connection", name);
      return;
    }
    this.need("connection", name.trim() || hostOf(clean), agents, clean);
  }

  channel(c: { key: string; name: string; topic?: string; agents: { key: string; autoReply: boolean }[] }) {
    const name = channelName(c.name) || channelName(c.key);
    if (!c.key || !name || this.channels.some((x) => x.key === c.key)) return;
    this.channels.push({ key: c.key, name, topic: (c.topic ?? "").trim(), agents: c.agents });
  }

  /** A routine; one without a schedule we can say, a prompt or an agent is listed under `label`. */
  routine(r: {
    key: string;
    name: string;
    agent: string;
    prompt: string;
    channel?: string | null;
    trigger: Trigger | null;
    label?: string;
  }) {
    if (!r.trigger || !r.prompt.trim() || !r.agent) {
      this.left("routine", r.label ?? r.name);
      return;
    }
    const base = r.key || slug(r.name) || "routine";
    let key = base;
    for (let n = 2; this.routines.some((x) => x.key === key); n++) key = `${base}-${n}`;
    this.routines.push({
      key,
      name: r.name.trim() || r.prompt.trim().split("\n")[0]?.slice(0, 80) || key,
      agent: r.agent,
      prompt: r.prompt.trim(),
      channel: r.channel ?? null,
      trigger: r.trigger,
    });
  }

  note(n: DraftNote) {
    if (n.content.trim()) this.notes.push({ ...n, content: n.content.trim() });
  }
}

/** A channel name we accept (CHANNEL_NAME_PATTERN in packages/engine/src/channels.ts; no `dm-`). */
export function channelName(name: string): string {
  const s = slug(name, 80);
  return s.startsWith("dm-") ? `c-${s}`.slice(0, 80) : s;
}

/** Text split at paragraph (else line) breaks into parts of at most `max` characters. */
export function splitNote(text: string, max = NOTE_MAX): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = /[\uD800-\uDBFF]/.test(rest[max - 1] ?? "") ? max - 1 : max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
