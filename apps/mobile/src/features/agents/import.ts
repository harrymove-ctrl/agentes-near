import type {
  BundleTodo,
  ImportItemKind,
  ImportItemResult,
  ImportSkipReason,
  MigrationBundle,
} from "@agenteschat/client";
import { choosable, IMPORT_KINDS, type ImportCard, itemId } from "@agenteschat/client/lib/import/flow";
import { ARCHIVE_PATH, IMPORT_MAX_BYTES, isSecretPath, TEXT_PATH } from "@agenteschat/client/lib/import/shared";
import { isIdHandle } from "@agenteschat/tokens/names";

/**
 * Bringing agents from another app on the phone, the pure part: which picked files are read, the preview's rows
 * (agents one by one, the rest by kind), and where the person lands once they arrive. The reading, the plan and the
 * apply are the web's (`@agenteschat/client/lib/import`).
 */

export { isRequestCard } from "@agenteschat/client/lib/import/flow";

/** Whether "Choose files" applies: not for Grok Bot, which only answers in chat (ChatGPT dots hands back a file). */
export const takesFiles = (card: ImportCard | null) => card !== "grok-bot";

/** A file from the system picker. */
export interface PickedAsset {
  name: string;
  size?: number | null;
}

/**
 * Which picked files are read as text: the formats' text files under the per-file cap, never a key or login file.
 * The rest still go in, empty, so the preview lists them as left behind. The phone opens no archive: picking only
 * archives is `archive`.
 */
export function phonePicks<T extends PickedAsset>(assets: readonly T[]): { read: boolean[]; archive: boolean } {
  const read = assets.map((a) => TEXT_PATH.test(a.name) && !isSecretPath(a.name) && (a.size ?? 0) <= IMPORT_MAX_BYTES);
  const archive = assets.length > 0 && assets.every((a) => ARCHIVE_PATH.test(a.name));
  return { read, archive };
}

/** A row's status word: `onboarding.import.status.*`, or `join` for a channel that already exists here. */
export type RowStatus = "create" | "update" | "unchanged" | "skip" | "join";

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  /** The @ it gets here (another when the bundle's is taken); null for an id another app gave it, not yet renamed. */
  handle: string | null;
  /** The bundle's @ when it was taken here and the agent gets `handle` instead. */
  wanted: string | null;
  appearance: MigrationBundle["agents"][number]["appearance"];
  status: RowStatus;
  /** Why it doesn't come, or a note on a create (its model isn't here). */
  reason: ImportSkipReason | null;
  /** The person can check or uncheck it. */
  free: boolean;
  on: boolean;
}

/** The agents of the plan, new ones first, each with what happens to it. */
export function agentRows(
  bundle: MigrationBundle,
  items: readonly ImportItemResult[],
  pick: ReadonlySet<string>,
  blocked: ReadonlyMap<string, ImportSkipReason>,
): AgentRow[] {
  const byKey = new Map(bundle.agents.map((a) => [a.key, a]));
  return items
    .filter((i) => i.kind === "agent")
    .sort((a, b) => RANK[a.action] - RANK[b.action])
    .map((item) => {
      const agent = byKey.get(item.key);
      const id = itemId(item);
      const free = choosable(item) && !blocked.has(id);
      const own = agent?.handle ?? item.key;
      return {
        id,
        name: agent?.name ?? item.label,
        role: agent?.role ?? "",
        handle: item.renamedTo ?? (isIdHandle(own) ? null : own),
        wanted: item.renamedTo && !isIdHandle(own) ? own : null,
        appearance: agent?.appearance ?? {},
        status: item.action,
        reason: item.reason ?? blocked.get(id) ?? null,
        free,
        on: item.action === "unchanged" || (free && pick.has(id)),
      };
    });
}

/** Skipped last, already-here before them; the plan's order otherwise (the web's preview). */
const RANK: Record<ImportItemResult["action"], number> = { create: 0, update: 0, unchanged: 1, skip: 2 };

export interface KindGroup {
  kind: Exclude<ImportItemKind, "agent">;
  /** Items that come: picked new or changed ones, and the ones already here. */
  coming: number;
  total: number;
  /** What one switch checks or unchecks. */
  free: string[];
  on: boolean;
}

/**
 * Everything else the agents bring (skills, channels, routines, memory), one switch per kind: on while anything of
 * it is picked. A kind with nothing to pick is still listed, its switch off and locked.
 */
export function kindGroups(
  items: readonly ImportItemResult[],
  pick: ReadonlySet<string>,
  blocked: ReadonlyMap<string, ImportSkipReason>,
): KindGroup[] {
  return IMPORT_KINDS.filter((k): k is KindGroup["kind"] => k !== "agent").flatMap((kind) => {
    const rows = items.filter((i) => i.kind === kind && i.action !== "skip");
    if (rows.length === 0) return [];
    const free = rows.filter((i) => choosable(i) && !blocked.has(itemId(i))).map(itemId);
    const picked = free.filter((id) => pick.has(id)).length;
    const here = rows.filter((i) => i.action === "unchanged").length;
    return [{ kind, coming: here + picked, total: rows.length, free, on: picked > 0 }];
  });
}

/** The agents an apply created or changed, by id here. */
export const arrivedAgents = (report: readonly ImportItemResult[]) =>
  report
    .filter((i) => i.kind === "agent" && (i.action === "create" || i.action === "update") && i.targetId)
    .map((i) => i.targetId as string);

/**
 * Where the person lands: one agent's page in place of the create screen, or back down to the agents tab for
 * several (or none).
 */
export const landingOf = (
  agentIds: readonly string[],
  { left = false }: { left?: boolean } = {},
): { href: string; how: "replace" | "dismissTo" } | null =>
  // Once the person left the screen mid-apply, moving them would replace wherever they are now.
  left
    ? null
    : agentIds.length === 1
      ? { href: `/agent/${agentIds[0]}`, how: "replace" }
      : { href: "/agents", how: "dismissTo" };

/** A plan is shown and applied only in the workspace it was planned for (a push can switch workspaces under it). */
export const planIn = <P extends { orgId: string }>(planned: P | null, orgId: string): P | null =>
  planned?.orgId === orgId ? planned : null;

/**
 * What the Paste button does with the clipboard: a link goes in the field to read; anything else is read right away,
 * never shown (an export can run to megabytes, too much for a text field), as the web does.
 */
export const pasteAction = (text: string): "field" | "read" | null =>
  !text.trim() ? null : /^\s*https?:\/\//i.test(text) ? "field" : "read";

/** A request that never got an answer: fetch's "Network request failed" is a `TypeError` on the phone. */
export const phoneOffline = (e: unknown) => e instanceof TypeError;

/** What the apply brought against what was asked: everything arrived, or how much did. */
export function reportCounts(report: readonly ImportItemResult[], asked: number) {
  const made = report.filter((i) => i.action === "create" || i.action === "update");
  const capped = made.filter((i) => i.reason === "too_many_routines").length;
  return { done: made.length, total: asked, partial: made.length < asked, capped };
}

/** Where a to-do's action opens on the phone: Conectores or the Drive. A key is asked in the chat; a model has no page. */
export const todoHref = (kind: BundleTodo["kind"]): "/connectors" | "/drive" | null =>
  kind === "connection" || kind === "app" ? "/connectors" : kind === "file" ? "/drive" : null;
