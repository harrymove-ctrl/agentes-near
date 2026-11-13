import { isSecretFile } from "@agenteschat/tokens/names";
import type { MigrationBundle } from "../../api/types";
import { MAX_UPLOAD_BYTES } from "../files";
import { excerpt } from "../text";
import * as agenteschat from "./agenteschat";
import * as hermes from "./hermes";
import * as openbot from "./openbot";
import * as openbotrun from "./openbotrun";
import * as openclaw from "./openclaw";
import * as openmausbot from "./openmausbot";
import * as paperclip from "./paperclip";
import {
  Draft,
  holdsKey,
  IMPORT_MAX_BYTES,
  ImportError,
  type ImportFile,
  isSecretPath,
  type LeftOut,
  type LeftOutKind,
  normalizePath,
  type ParseOptions,
  scrubSecrets,
  slug,
  splitNote,
} from "./shared";

/**
 * Bringing a workspace from another product: the files (a folder, an archive
 * read by `readImportFiles`, a GitHub link's files, or a pasted reply) become
 * one `MigrationBundle`, which the server plans and applies (ADR 0055). The
 * source is recognized by content, never by file name alone. Pure and
 * synchronous; nothing here touches the network.
 */

export { EXPORT_PROMPT } from "./agenteschat";
export { interpolateEnv } from "./openbot";
export {
  IMPORT_MAX_BYTES,
  ImportError,
  type ImportErrorCode,
  type ImportFile,
  type LeftOut,
  type LeftOutKind,
  type ParseOptions,
  scrubSecrets,
  uniqueHandle,
} from "./shared";

export type ImportSource =
  | "openbotrun"
  | "openmausbot"
  | "hermes"
  | "openclaw"
  | "paperclip"
  | "openbot"
  | "agenteschat";
/** Every app the parsers read. */
export const IMPORT_SOURCES: ImportSource[] = [
  "openbotrun",
  "openmausbot",
  "hermes",
  "openclaw",
  "paperclip",
  "openbot",
  "agenteschat",
];
/** Brand names (not translated). */
export const SOURCE_NAME: Record<ImportSource, string> = {
  openbotrun: "OpenBot.run",
  openmausbot: "OpenMausBot",
  hermes: "Hermes Agent",
  openclaw: "OpenClaw",
  paperclip: "Paperclip",
  openbot: "OpenBot",
  agenteschat: "agentes.chat",
};
const ARCHIVES = ".zip,.tar.gz,.tgz,.tar,application/zip,application/gzip,application/x-tar";
/** What the file picker offers for each source. */
export const SOURCE_ACCEPT: Record<ImportSource, string> = {
  openbotrun: `.json,${ARCHIVES}`,
  openmausbot: ".json,.md,.markdown,.yaml,.yml,.txt,application/json,text/markdown",
  hermes: `.md,.yaml,.yml,.json,${ARCHIVES}`,
  openclaw: `.md,.json,.json5,${ARCHIVES}`,
  paperclip: `.md,.yaml,.yml,${ARCHIVES}`,
  openbot: `.yaml,.yml,${ARCHIVES}`,
  agenteschat: ".json,.txt,.md,application/json",
};
/** Everything any source accepts. */
export const IMPORT_ACCEPT = [...new Set(Object.values(SOURCE_ACCEPT).flatMap((a) => a.split(",")))].join(",");

interface Parser {
  detect(files: ImportFile[]): boolean;
  parse(files: ImportFile[], d: Draft): void;
}
const PARSERS: Record<ImportSource, Parser> = {
  agenteschat,
  openbotrun,
  openmausbot,
  paperclip,
  hermes,
  openclaw,
  openbot,
};
/** Strongest signal first: a declared format, then a manifest file, then a folder layout. */
const DETECTION: ImportSource[] = [
  "agenteschat",
  "openbotrun",
  "openmausbot",
  "paperclip",
  "hermes",
  "openclaw",
  "openbot",
];

/** What one import may carry (IMPORT_LIMITS in packages/engine/src/imports.ts); the rest is listed. */
const LIMITS = { agents: 200, skills: 300, channels: 300, routines: 1000, notes: 5000 };
/** The longest to-do or left-out label the server takes (`Bundle` in apps/server/src/routes/app/agent-imports.ts). */
const LABEL_MAX = 500;
/** Files about a package rather than in it: never listed as left behind. */
const NOISE = /(^|\/)(\.[^/]*|__MACOSX\/.*|(README|LICEN[CS]E|NOTICE|CHANGELOG|CONTRIBUTING)(\.[a-z]+)?)$/i;

const prepare = (files: ImportFile[]) =>
  files.map((f) => ({ ...f, name: normalizePath(f.name), text: f.text.replace(/^\uFEFF/, "") }));
const readable = (files: ImportFile[]) => files.filter((f) => !isSecretPath(f.name) && f.text.trim());

/** Why one of an agent's files doesn't go to the Drive. */
export type AgentFileSkip = "secret" | "junk" | "too_large" | "unreadable";

/** A file of an agent's own (OpenBot.run's `files/`, an OpenClaw workspace), for its folder in the Drive. */
export interface AgentFile {
  /** The agent's key in the bundle. */
  agent: string;
  /** Where it goes in the agent's folder, keeping the source's folders. */
  path: string;
  /** Bytes (0 for a system file the reader dropped). */
  size: number;
  /** Why it stays behind; without one it is copied. */
  skip?: AgentFileSkip;
  read?: () => Promise<Blob>;
}

/** The source these files come from, or null. Throws `ImportError("newerVersion")` for a newer format. */
export function detectSource(files: ImportFile[]): ImportSource | null {
  const usable = readable(prepare(files));
  return DETECTION.find((id) => PARSERS[id].detect(usable)) ?? null;
}

/** Reads the files into a bundle. Throws `ImportError` when they are none of the sources, or carry no agent. */
export const parseImport = (files: ImportFile[], options: ParseOptions = {}): MigrationBundle =>
  parsePackage(files, options).bundle;

/** `parseImport`, with the agents' own files beside the bundle (they never travel in it). */
export function parsePackage(
  files: ImportFile[],
  options: ParseOptions = {},
): { bundle: MigrationBundle; files: AgentFile[] } {
  const all = prepare(files);
  if (
    all.some((f) => f.text.length > IMPORT_MAX_BYTES || new TextEncoder().encode(f.text).byteLength > IMPORT_MAX_BYTES)
  ) {
    throw new ImportError("tooLarge");
  }
  const usable = readable(all);
  if (usable.length === 0) throw new ImportError("empty");
  const source = DETECTION.find((id) => PARSERS[id].detect(usable));
  if (!source) throw new ImportError("unknown");
  const d = new Draft(usable, options);
  PARSERS[source].parse(usable, d);
  return finish(d, source, all);
}

/**
 * Whose own files each path is: the deepest folder a parser gave an agent wins (a workspace inside another),
 * and a subfolder that isn't the agent's (its skills) is no one's.
 */
function ownerOf(d: Draft, path: string): { agent: string; path: string } | null {
  let best: Draft["fileDirs"][number] | undefined;
  for (const x of d.fileDirs) {
    if ((!x.dir || path.startsWith(`${x.dir}/`)) && (!best || x.dir.length > best.dir.length)) best = x;
  }
  if (!best) return null;
  const rest = best.dir ? path.slice(best.dir.length + 1) : path;
  return best.skip.some((s) => rest.startsWith(`${s}/`)) ? null : { agent: best.agent, path: rest };
}

/**
 * One of an agent's files: copied unless it is a credential store (by its name, or a key in its text or in what the
 * reader peeked at), has no bytes we can read, or is over the Drive's limit.
 */
function agentFile(agent: string, path: string, f: ImportFile): AgentFile {
  const size = f.size ?? new TextEncoder().encode(f.text).byteLength;
  const read = f.read ?? (f.text ? async () => new Blob([f.text]) : undefined);
  const skip: AgentFileSkip | undefined =
    isSecretFile(path) || holdsKey(f.text || f.peek || "")
      ? "secret"
      : !read
        ? "unreadable"
        : size > MAX_UPLOAD_BYTES
          ? "too_large"
          : undefined;
  return skip ? { agent, path, size, skip } : { agent, path, size, read };
}

/** Checks references, scrubs every text, splits long notes and lists what was not read. */
function finish(d: Draft, app: ImportSource, files: ImportFile[]): { bundle: MigrationBundle; files: AgentFile[] } {
  const leftOut: LeftOut[] = [...d.leftOut];
  const left = (kind: LeftOutKind, label: string) => {
    if (label) leftOut.push({ kind, label });
  };
  const clean = (text: string, owner: string) => {
    const r = scrubSecrets(text);
    if (r.redacted) left("redacted", owner);
    return r.text;
  };
  const label = (text: string) => scrubSecrets(text).text;
  // Another app's agent may write these as paragraphs: shortened to what the server takes, so one can't refuse the file.
  const shortLabel = (text: string) => {
    const scrubbed = label(text);
    return scrubbed.length <= LABEL_MAX ? scrubbed : excerpt(scrubbed, LABEL_MAX, Number.POSITIVE_INFINITY);
  };
  const capped = <T>(items: T[], max: number, kind: LeftOutKind, name: (item: T) => string) => {
    for (const item of items.slice(max)) left(kind, name(item));
    return items.slice(0, max);
  };

  const skillKeys = new Set(d.skills.map((s) => s.key));
  const agents = capped(d.agents, LIMITS.agents, "other", (a) => a.name).map((a) => {
    const name = label(a.name);
    return {
      ...a,
      name: clean(a.name, name),
      role: clean(a.role, name),
      instructions: clean(a.instructions, name),
      skills: a.skills.filter((k) => skillKeys.has(k)),
    };
  });
  const agentKeys = new Set(agents.map((a) => a.key));
  const agentName = new Map(agents.map((a) => [a.key, a.name]));
  const skills = capped(d.skills, LIMITS.skills, "skill", (s) => s.key).map((s) => ({
    key: s.key,
    markdown: clean(s.markdown, s.key),
  }));
  const channels = capped(d.channels, LIMITS.channels, "other", (c) => c.name).map((c) => ({
    ...c,
    name: clean(c.name, c.name),
    topic: clean(c.topic, c.name),
    agents: c.agents.filter((m, i, all) => agentKeys.has(m.key) && all.findIndex((x) => x.key === m.key) === i),
  }));
  const channelKeys = new Set(channels.map((c) => c.key));
  const routines = capped(
    d.routines.filter((r) => {
      if (!agentKeys.has(r.agent)) left("routine", label(r.name));
      return agentKeys.has(r.agent);
    }),
    LIMITS.routines,
    "routine",
    (r) => label(r.name),
  ).map((r) => {
    const name = label(r.name);
    // A routine of a group chat that didn't come posts in the agent's DM.
    return {
      ...r,
      name: clean(r.name, name),
      prompt: clean(r.prompt, name),
      channel: r.channel && channelKeys.has(r.channel) ? r.channel : null,
    };
  });

  const noteKeys = new Set<string>();
  const notes = d.notes.flatMap((n) => {
    if (n.agent !== null && !agentKeys.has(n.agent)) {
      left("notes", label(n.key));
      return [];
    }
    const owner = (n.agent !== null && agentName.get(n.agent)) || label(d.name) || SOURCE_NAME[app];
    return splitNote(clean(n.content, owner)).map((content, i) => {
      let key = (i ? `${n.key}~${i + 1}` : n.key) || "note";
      for (let k = 2; noteKeys.has(key); k++) key = `${n.key || "note"}~${k}`;
      noteKeys.add(key);
      return { key, agent: n.agent, kind: n.kind, ...(n.title ? { title: label(n.title) } : {}), content };
    });
  });
  if (notes.length > LIMITS.notes) left("notes", `+${notes.length - LIMITS.notes}`);

  const todo = d.todo.map((t) => ({
    ...t,
    label: shortLabel(t.label),
    agents: t.agents.filter((k) => agentKeys.has(k)),
  }));

  // The agents' own files go beside the bundle, for their folders in the Drive. Keys and sign-ins among them are
  // named with what never comes, before Importar.
  const agentFiles: AgentFile[] = [];
  const own = new Set<string>();
  const add = (agent: string, path: string, f: ImportFile) => {
    const file = agentFile(agent, path, f);
    agentFiles.push(file);
    if (file.skip === "secret") left("secret", f.name);
  };
  for (const f of files) {
    const owner = d.used.has(f.name) ? null : ownerOf(d, f.name);
    if (!owner || !agentKeys.has(owner.agent)) continue;
    add(owner.agent, owner.path, f);
    own.add(f.name);
  }
  for (const x of d.agentFiles) {
    const f = files.find((file) => file.name === x.from);
    if (f && agentKeys.has(x.agent)) add(x.agent, x.to, f);
    else if (!f) left("file", x.to);
  }

  for (const path of d.options.junk ?? []) {
    const owner = ownerOf(d, path);
    if (owner && agentKeys.has(owner.agent)) agentFiles.push({ ...owner, size: 0, skip: "junk" });
  }

  // Credential stores were never read; other files nobody used are listed by folder.
  const unread = new Map<string, number>();
  for (const f of files) {
    if (d.used.has(f.name) || own.has(f.name)) continue;
    if (isSecretPath(f.name)) {
      left("secret", f.name);
      continue;
    }
    if (NOISE.test(f.name)) continue;
    const top = f.name.includes("/") ? `${f.name.split("/")[0]}/` : f.name;
    unread.set(top, (unread.get(top) ?? 0) + 1);
  }
  for (const [path, count] of unread) left("file", path.endsWith("/") ? `${path} (${count})` : path);

  if (agents.length === 0) throw new ImportError("noAgents");
  const used = files.filter((f) => d.used.has(f.name));
  const seen = new Set<string>();
  const bundle: MigrationBundle = {
    format: "agenteschat.bundle",
    version: 1,
    source: {
      app,
      // Stable across edits and fresh exports of the same package, so importing it again updates it.
      ref:
        d.ref ||
        slug(d.options.root ?? "") ||
        agents
          .map((a) => a.key)
          .sort()
          .join(","),
      name: label(d.name) || d.options.root || SOURCE_NAME[app],
      files: used.map((f) => f.name),
    },
    agents,
    skills,
    channels,
    routines,
    notes: notes.slice(0, LIMITS.notes),
    todo,
    leftOut: leftOut
      .map((l) => ({ kind: l.kind, label: shortLabel(l.label) }))
      .filter((l) => {
        const k = `${l.kind}\u0000${l.label}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }),
  };
  return { bundle, files: agentFiles };
}

/** The model an imported agent is created with: its own when it's in the catalog, else the suggestion. */
export function importedModel(agent: { model: string | null }, models: string[], suggested: string | undefined) {
  return agent.model && models.includes(agent.model) ? agent.model : suggested;
}

/** Leftovers grouped by kind, in a fixed order (for the "what doesn't come along" list). */
export const LEFT_OUT_ORDER: LeftOutKind[] = [
  "skill",
  "routine",
  "notes",
  "connection",
  "messaging",
  "plugin",
  "remote",
  "model",
  "task",
  "team",
  "preset",
  "picture",
  "secret",
  "redacted",
  "file",
  "other",
];
export function groupLeftOut(items: { kind: string; label: string }[]): { kind: LeftOutKind; labels: string[] }[] {
  return LEFT_OUT_ORDER.map((kind) => ({
    kind,
    labels: items.filter((i) => i.kind === kind).map((i) => i.label),
  })).filter((g) => g.labels.length > 0);
}
