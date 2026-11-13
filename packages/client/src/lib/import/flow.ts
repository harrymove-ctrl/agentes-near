import type { TFunction } from "i18next";
import type { ApiClient } from "../../api/client";
import { ApiError } from "../../api/http";
import type {
  BundleNote,
  BundleTodo,
  ImportItemKind,
  ImportItemResult,
  ImportSkipReason,
  MigrationBundle,
} from "../../api/types";
import { IMPORT_APP_CLIENTS } from "../app-clients";
import { forbiddenText } from "../errors";
import { joinNames } from "../format";
import {
  type AgentFile,
  type AgentFileSkip,
  IMPORT_SOURCES,
  ImportError,
  type ImportSource,
  SOURCE_NAME,
} from "./index";
import { baseName } from "./shared";

/**
 * The import screen around the server's plan (ADR 0055): where a bundle came
 * from, what can be picked, what a picked item needs that was unchecked, and
 * the apply in chunks the server takes. Pure, except `applyInChunks`.
 */

/** Items one apply may create or update (`IMPORT_LIMITS.perApply` in packages/engine/src/imports.ts). */
export const PER_APPLY = 200;

/** What an import brings, in the order the screens list it. */
export const IMPORT_KINDS: readonly ImportItemKind[] = ["agent", "skill", "channel", "routine", "note"];

/** "3 agentes · 2 skills": how many of each kind, the kinds with none left out. */
export const kindsLine = (t: TFunction, count: (kind: ImportItemKind) => number) =>
  IMPORT_KINDS.filter((kind) => count(kind) > 0)
    .map((kind) => t(`onboarding.import.report.kinds.${kind}`, { count: count(kind) }))
    .join(" · ");

/**
 * What the import needs set up by hand, as one plain line: "Ada e Theo usam o HubSpot." The agents it matters to
 * are the subject; with none, the import itself.
 */
export function todoLine(t: TFunction, todo: BundleTodo, nameOf: (key: string) => string): string {
  const names = todo.agents.map(nameOf);
  const who = names.length > 0 ? joinNames(names, t) : t("onboarding.import.need.someone");
  return t(`onboarding.import.need.${todo.kind}`, { who, label: todo.label, count: Math.max(names.length, 1) });
}

/** Apps that answer `EXPORT_PROMPT`: the brand, and the `source.app` the prompt suggests it writes. */
export const EXPORT_PROMPT_APPS = [
  { name: "Grok Bot", app: "grok-bot" },
  { name: "ChatGPT dots", app: "chatgpt-dots" },
  { name: "Claude", app: "claude" },
  { name: "Manus", app: "manus" },
  { name: "Rakazo", app: "rakazo" },
] as const;
type PromptApp = (typeof EXPORT_PROMPT_APPS)[number]["app"];

/**
 * The source cards, the most used apps first, then our own export and any other app. Grok Bot and
 * ChatGPT dots answer `EXPORT_PROMPT` on cards of their own. OpenBot has no card: its files are still
 * read, and land on any other app's.
 */
export const IMPORT_CARDS = [
  "grok-bot",
  "chatgpt-dots",
  "openbotrun",
  "openmausbot",
  "hermes",
  "openclaw",
  "paperclip",
  "agenteschat",
  "other",
] as const satisfies readonly (PromptApp | ImportSource | "other")[];
export type ImportCard = (typeof IMPORT_CARDS)[number];
/** The cards that show the export request to copy. */
export type RequestCard = Extract<ImportCard, PromptApp | "other">;
/** The cards whose app answers the export request (pasted back), not a file. */
export const isRequestCard = (card: ImportCard | null): card is RequestCard =>
  card === "grok-bot" || card === "chatgpt-dots" || card === "other";

/** How a source's agents come: the app creates them here through this server's MCP, or the request and its reply. */
export type ImportMethod = "mcp" | "prompt";

/** A source's steps to connect it to this server's MCP; none for one that can't take an MCP server. */
export const mcpClient = (card: ImportCard) => IMPORT_APP_CLIENTS.find((c) => c.id === card);

/**
 * Offered, but not the default: no document says a dot calls a custom plugin, and custom MCP on some ChatGPT plans is
 * read-only, which can't create agents.
 */
const MCP_UNCONFIRMED: ReadonlySet<ImportCard> = new Set(["chatgpt-dots"]);

/** MCP wherever the app takes it and apps on the internet reach this server (`aiAppImport`'s `available`). */
export const defaultMethod = (card: ImportCard, reachable: boolean): ImportMethod =>
  reachable && mcpClient(card) && !MCP_UNCONFIRMED.has(card) ? "mcp" : "prompt";

/**
 * The agents that arrived through MCP: not among `seen` (the ids there when its steps first showed, so the server's
 * clock is never compared with the device's) and the person's own, made by them or by their app.
 */
export const agentsSince = <A extends { id: string; ownerUserId: string | null }>(
  list: readonly A[],
  seen: ReadonlySet<string>,
  userId: string,
) => list.filter((a) => !seen.has(a.id) && a.ownerUserId === userId);

/** An app's own card, else any other app's. */
const cardOf = (app: string): ImportCard => IMPORT_CARDS.find((c) => c === app) ?? "other";

/**
 * The card and app name of a bundle (or of what one brought, `imports.sources`). One in our format names its app in
 * `source.ref` ("agenteschat:<org>" for our own export, "grok-bot" for a
 * reply to `EXPORT_PROMPT`, "grok-bot:…" for one imported before); `app` is null for an app we don't know.
 */
export function bundleOrigin(bundle: { source: Pick<MigrationBundle["source"], "app" | "ref"> }): {
  card: ImportCard;
  app: string | null;
} {
  const source = IMPORT_SOURCES.find((s) => s === bundle.source.app);
  if (!source) return { card: "other", app: null };
  if (source !== "agenteschat" || bundle.source.ref.startsWith("agenteschat:")) {
    return { card: cardOf(source), app: SOURCE_NAME[source] };
  }
  const declared = EXPORT_PROMPT_APPS.find((a) => a.app === bundle.source.ref.split(":")[0]);
  return { card: declared ? cardOf(declared.app) : "other", app: declared?.name ?? null };
}

/** A link the server reads (the route's rule): https on github.com or raw.githubusercontent.com. */
export function isGithubLink(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" && ["github.com", "raw.githubusercontent.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * What a GitHub link names, as a dropped folder's name does: the linked folder or file, and the
 * repository for a link to the repository itself or to one of its branches (never the branch).
 */
export function githubRoot(link: string): string | null {
  const parts = new URL(link).pathname.split("/").filter(Boolean);
  const repository = parts.length === 2 || (parts.length === 4 && (parts[2] === "tree" || parts[2] === "blob"));
  const name = repository ? parts[1] : parts.at(-1);
  return name ? decodeURIComponent(name) : null;
}

/** The cause of a pasted link to a host the server doesn't read. */
export const NOT_GITHUB = "notGithub";

/** A read that failed: the input, and the step (reading it, parsing it, or planning it on the server). */
export interface ImportFailure {
  from: "files" | "link" | "paste";
  step: "read" | "parse" | "plan";
  cause: unknown;
}

/** Trying the same input again only helps when the network or the server failed (a file is picked again instead). */
export const retryable = ({ from, step, cause }: ImportFailure) =>
  (step === "plan" || from === "link") &&
  cause !== NOT_GITHUB &&
  !(cause instanceof ImportError) &&
  !(cause instanceof ApiError && cause.status < 500);

export const itemId = (item: { kind: string; key: string }) => `${item.kind}:${item.key}`;

/** A row the person checks or unchecks: something the import would create or change. */
export const choosable = (item: ImportItemResult) => item.action === "create" || item.action === "update";

/**
 * Routines and notes that won't come although checked: the agent (or channel)
 * they need is new here, or a channel the agents would only now join, and
 * unchecked. One that an earlier import brought stays either way.
 */
export function blockedItems(
  bundle: MigrationBundle,
  items: ImportItemResult[],
  pick: ReadonlySet<string>,
): Map<string, ImportSkipReason> {
  const onlyIfPicked = new Set(
    items.filter((i) => i.action === "create" || (i.action === "update" && i.reason === "exists")).map(itemId),
  );
  const gone = (id: string) => onlyIfPicked.has(id) && !pick.has(id);
  const out = new Map<string, ImportSkipReason>();
  for (const r of bundle.routines) {
    if (gone(`agent:${r.agent}`)) out.set(`routine:${r.key}`, "agent_not_picked");
    else if (r.channel !== null && gone(`channel:${r.channel}`)) out.set(`routine:${r.key}`, "channel_not_picked");
  }
  for (const n of bundle.notes) {
    if (n.agent !== null && gone(`agent:${n.agent}`)) out.set(`note:${n.key}`, "agent_not_picked");
  }
  return out;
}

/** What to apply, in the plan's order (what an item needs comes before it). */
export function picksOf(
  items: ImportItemResult[],
  pick: ReadonlySet<string>,
  blocked: ReadonlyMap<string, ImportSkipReason>,
): string[] {
  return items.filter((i) => choosable(i) && pick.has(itemId(i)) && !blocked.has(itemId(i))).map(itemId);
}

/**
 * The bundle with only these items, and every agent: the server gives a new
 * agent its handle looking at all of them, picked or not, so the handle each
 * row showed is the one it gets. What earlier chunks made, the server already
 * knows by its provenance, so a chunk doesn't carry the whole bundle.
 */
export function sliceBundle(bundle: MigrationBundle, pick: ReadonlySet<string>): MigrationBundle {
  const has =
    (kind: string) =>
    ({ key }: { key: string }) =>
      pick.has(`${kind}:${key}`);
  return {
    ...bundle,
    skills: bundle.skills.filter(has("skill")),
    channels: bundle.channels.filter(has("channel")),
    routines: bundle.routines.filter(has("routine")),
    notes: bundle.notes.filter(has("note")),
    todo: [],
    leftOut: [],
  };
}

/**
 * Applies the picked items, `PER_APPLY` at a time in the plan's order (each
 * call is safe to repeat). `done` carries over attempts: an item an earlier
 * attempt made comes back unchanged on a retry, and still counts as made.
 */
export async function applyInChunks(
  api: ApiClient,
  orgId: string,
  input: { bundle: MigrationBundle; pick: string[] },
  done: Map<string, ImportItemResult>,
  onProgress?: (applied: number) => void,
): Promise<ImportItemResult[]> {
  for (let at = 0; at < input.pick.length; at += PER_APPLY) {
    const pick = input.pick.slice(at, at + PER_APPLY);
    const { items } = await api.imports.apply(orgId, {
      bundle: sliceBundle(input.bundle, new Set(pick)),
      dryRun: false,
      pick,
    });
    for (const item of items) {
      const before = done.get(itemId(item));
      if (!(before && before.action !== "skip" && item.action === "unchanged")) done.set(itemId(item), item);
    }
    onProgress?.(Math.min(at + PER_APPLY, input.pick.length));
  }
  return input.pick.flatMap((id) => done.get(id) ?? []);
}

/** A card's name: the brand, or our own name and "Outro app" in the person's words. */
export function cardName(t: TFunction, card: ImportCard): string {
  if (card === "other") return t("onboarding.import.otherName");
  if (card === "agenteschat") return t("onboarding.import.agenteschatName");
  if (card === "grok-bot" || card === "chatgpt-dots") {
    return EXPORT_PROMPT_APPS.find((a) => a.app === card)?.name ?? card;
  }
  return SOURCE_NAME[card];
}

/**
 * What went wrong reading or planning, and what to do next. `offline` tells a request that never got an answer
 * (each app knows its own way).
 */
export function importFailureText(
  t: TFunction,
  { from, step, cause }: ImportFailure,
  offline: (e: unknown) => boolean,
) {
  if (cause === NOT_GITHUB) return t("onboarding.import.errors.notGithub");
  if (cause instanceof ImportError) {
    return cause.code === "unknown" && from === "paste"
      ? t("onboarding.import.errors.unknownPasted")
      : t(`onboarding.import.errors.${cause.code}`);
  }
  const network = step === "plan" || (step === "read" && from === "link");
  if (network && offline(cause)) return t("onboarding.import.errors.offline");
  if (cause instanceof ApiError && cause.status === 413) return t("onboarding.import.errors.tooBig");
  if (cause instanceof ApiError && cause.status === 403) return forbiddenText(t, cause);
  if (step === "plan" && cause instanceof ApiError && cause.status === 400) {
    return t("onboarding.import.errors.invalidBundle");
  }
  if (step === "plan") return t("onboarding.import.errors.plan");
  return from === "link" ? t("onboarding.import.errors.link") : t("onboarding.import.errors.read");
}

/** Why the apply stopped (what arrived stays: trying again brings the rest). */
export function importApplyErrorText(t: TFunction, error: unknown, offline: (e: unknown) => boolean) {
  if (offline(error)) return t("onboarding.import.errors.offline");
  if (error instanceof ApiError && error.status === 413) return t("onboarding.import.errors.tooBig");
  if (error instanceof ApiError && error.status === 403) return forbiddenText(t, error);
  if (error instanceof ApiError && error.code === "import.too_many_items") return t("onboarding.import.errors.tooMany");
  return t("onboarding.import.errors.apply");
}

/** Why one of an agent's files isn't in its Drive folder after the import. */
export type FileLeft = AgentFileSkip | "exists" | "storage_full" | "daily_full" | "failed";

/** The agents' files after the copy. */
export interface FilesCopy {
  /** Copied now. */
  copied: number;
  /** Agent key → its folder in the Drive, for each agent whose files are there (copied now or before). */
  folders: Map<string, string>;
  /** What isn't there, and why. */
  left: { file: AgentFile; why: FileLeft }[];
}

/**
 * Past this many files, copying them starts off: the browser sends each one, so the page stays open that long, and
 * that many in a flat Drive is more likely a project's working copy than the agent's own files.
 */
export const MANY_FILES = 500;

/** Files sent at a time. */
const PARALLEL_COPIES = 4;

/**
 * Copies the agents' own files into their folders in the Drive, a few at a time, for the agents the import brought
 * (`agentIds`: key → id). What `parsePackage` set aside stays behind with its reason; a name the folder already has
 * stays as it was (`exists`); once the workspace's storage or today's uploads are full, so does the rest.
 */
export async function copyAgentFiles(
  api: ApiClient,
  orgId: string,
  input: { files: AgentFile[]; agentIds: ReadonlyMap<string, string>; note: string },
  onProgress?: (done: number, total: number) => void,
): Promise<FilesCopy> {
  const out: FilesCopy = { copied: 0, folders: new Map(), left: [] };
  const theirs = input.files.filter((f) => input.agentIds.has(f.agent));
  for (const file of theirs) if (file.skip) out.left.push({ file, why: file.skip });
  const todo = theirs.filter((f) => !f.skip && f.read);
  let full: "storage_full" | "daily_full" | null = null;
  const copy = async (file: AgentFile): Promise<FileLeft | null> => {
    if (full) return full;
    try {
      const copied = await api.imports.copyFile(orgId, {
        file: await (file.read as () => Promise<Blob>)(),
        name: baseName(file.path),
        agentId: input.agentIds.get(file.agent) as string,
        path: file.path,
        note: input.note,
      });
      out.folders.set(file.agent, copied.folder);
      if (copied.status === "exists") return "exists";
      out.copied++;
      return null;
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "";
      if (code === "storage.full" || code === "storage.daily_full") {
        full ??= code === "storage.full" ? "storage_full" : "daily_full";
        return full;
      }
      if (code === "artifact.file_too_large") return "too_large";
      if (code === "import.secret_file") return "secret";
      return "failed";
    }
  };
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < todo.length) {
      const file = todo[next++] as AgentFile;
      const why = await copy(file);
      if (why) out.left.push({ file, why });
      onProgress?.(++done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_COPIES, todo.length) }, worker));
  return out;
}

/**
 * The agents whose files go to the Drive after an apply (key → id): here now, as the preview shows them coming
 * (already here unchanged, or checked and applied, not skipped), and not sent by an earlier apply. An unchecked
 * update, or an agent whose apply failed, waits for the next apply that brings it.
 */
export function agentsArrived(
  planned: readonly ImportItemResult[],
  applied: readonly ImportItemResult[],
  pick: ReadonlySet<string>,
  sent: ReadonlySet<string>,
): Map<string, string> {
  const results = new Map(applied.map((i) => [itemId(i), i]));
  const out = new Map<string, string>();
  for (const item of planned) {
    if (item.kind !== "agent" || sent.has(item.key)) continue;
    const now = item.action === "unchanged" ? item : pick.has(itemId(item)) ? results.get(itemId(item)) : undefined;
    if (now?.targetId && now.action !== "skip") out.set(item.key, now.targetId);
  }
  return out;
}

/** The line each agent keeps in its memory about where its files are: a note the import brings (once). */
export const filesNotes = (folders: ReadonlyMap<string, string>, line: (folder: string) => string): BundleNote[] =>
  [...folders].map(([agent, folder]) => ({
    key: `${agent}/drive-files`,
    agent,
    kind: "fact" as const,
    content: line(folder),
  }));
