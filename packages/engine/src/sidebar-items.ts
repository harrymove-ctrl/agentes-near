import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { ValidationError } from "./errors";
import { requirePermission } from "./organizations";
import { isPersonalWorkspace } from "./workspace-mode";

const { organizationMembers } = schema;

/**
 * The tools at the top of a person's sidebar, each where they put it in this workspace
 * (`organization_members.sidebar_items`): `always` in the list, `more` only in the More menu, `auto` in the list
 * while its count is above zero and in More otherwise. An item they never moved keeps the app's default for the
 * workspace's mode (`SIDEBAR_DEFAULTS` and `PERSONAL_SIDEBAR_DEFAULTS`, packages/client/src/lib/sidebar-items.ts,
 * which mirrors these lists): only choices are stored here, so a workspace that changes mode (ADR 0159) shows the new
 * defaults for every tool nobody moved.
 */
export const SIDEBAR_ITEMS = [
  "approvals",
  "proposals",
  "threads",
  "issues",
  "wiki",
  "drive",
  "routines",
  "calendar",
  "team",
  "dashboards",
  "taskManager",
] as const;
export type SidebarItem = (typeof SIDEBAR_ITEMS)[number];
/**
 * The tools' default order in a personal workspace (ADR 0159): what waits for the person first, then Routines and
 * Drive, then what starts in More. Mirrors `PERSONAL_SIDEBAR_ITEMS` in packages/client/src/lib/sidebar-items.ts.
 */
export const PERSONAL_SIDEBAR_ITEMS: readonly SidebarItem[] = [
  "approvals",
  "proposals",
  "routines",
  "drive",
  "calendar",
  "issues",
  "threads",
  "team",
  "wiki",
  "dashboards",
  "taskManager",
];
export const SIDEBAR_PLACES = ["always", "more", "auto"] as const;
export type SidebarPlace = (typeof SIDEBAR_PLACES)[number];
export type SidebarItems = Partial<Record<SidebarItem, SidebarPlace>>;

/** The items that show a count in the sidebar: only these can be `auto`. */
export const SIDEBAR_COUNTED: readonly SidebarItem[] = ["approvals", "proposals", "threads"];

const isItem = (value: string): value is SidebarItem => (SIDEBAR_ITEMS as readonly string[]).includes(value);
const isPlace = (value: unknown): value is SidebarPlace =>
  typeof value === "string" && (SIDEBAR_PLACES as readonly string[]).includes(value);

/** Whether `item` may sit at `place` (`auto` only for an item with a count). */
export const sidebarPlaceAllowed = (item: SidebarItem, place: SidebarPlace) =>
  place !== "auto" || SIDEBAR_COUNTED.includes(item);

/** Only known items at a place they can take: what a row holds is never trusted as is. */
export function sidebarItemsOf(raw: unknown): SidebarItems {
  if (!raw || typeof raw !== "object") return {};
  const out: SidebarItems = {};
  for (const [key, value] of Object.entries(raw))
    if (isItem(key) && isPlace(value) && sidebarPlaceAllowed(key, value)) out[key] = value;
  return out;
}

const mine = (orgId: string, userId: string) =>
  and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId));

/** Where the person put each item they moved, in this workspace. */
export async function mySidebarItems(db: Database, orgId: string, userId: string): Promise<SidebarItems> {
  await requirePermission(db, userId, orgId, "read");
  const [row] = await db
    .select({ items: organizationMembers.sidebarItems })
    .from(organizationMembers)
    .where(mine(orgId, userId));
  return sidebarItemsOf(row?.items);
}

/**
 * Puts one item where the person wants it in this workspace (`null`: back on its default) and leaves their other
 * choices as the row has them, so one made on another device in the meantime stays.
 */
export async function setMySidebarItem(
  db: Database,
  orgId: string,
  userId: string,
  item: SidebarItem,
  place: SidebarPlace | null,
): Promise<SidebarItems> {
  await requirePermission(db, userId, orgId, "read");
  if (!isItem(item) || (place !== null && !(isPlace(place) && sidebarPlaceAllowed(item, place))))
    throw new ValidationError(`${item} can't go to ${place}`);
  const items = organizationMembers.sidebarItems;
  const [row] = await db
    .update(organizationMembers)
    .set({
      sidebarItems:
        place === null
          ? sql`${items} - ${item}::text`
          : sql`${items} || jsonb_build_object(${item}::text, ${place}::text)`,
    })
    .where(mine(orgId, userId))
    .returning({ items });
  return sidebarItemsOf(row?.items);
}

/** Replaces the person's choices in this workspace (`{}` puts every item back on its default). */
export async function setMySidebarItems(
  db: Database,
  orgId: string,
  userId: string,
  items: SidebarItems,
): Promise<SidebarItems> {
  await requirePermission(db, userId, orgId, "read");
  const clean = sidebarItemsOf(items);
  const column = organizationMembers.sidebarItems;
  // The section order, the tools' order and the view share the row (`setMySidebarOrder`, `setMySidebarToolOrder`,
  // `setMySidebarView`) and stay.
  await db
    .update(organizationMembers)
    .set({
      sidebarItems: sql`${JSON.stringify(clean)}::jsonb || jsonb_strip_nulls(jsonb_build_object('order', ${column} -> 'order', 'tools', ${column} -> 'tools', 'view', ${column} -> 'view'))`,
    })
    .where(mine(orgId, userId));
  return clean;
}

/**
 * The sidebar's sections in the person's order (`order` in the same `sidebar_items` row, beside the tools' places):
 * the tools on top, the channels (with their categories), the agents (with their groups), the direct messages.
 * Mirrors `SIDEBAR_SECTIONS` in packages/client/src/lib/sidebar-items.ts.
 */
export const SIDEBAR_SECTIONS = ["tools", "channels", "agents", "people"] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];
/**
 * The default order in a personal workspace (ADR 0159): the agents before the group conversations. Mirrors
 * `PERSONAL_SIDEBAR_SECTIONS` in packages/client/src/lib/sidebar-items.ts.
 */
export const PERSONAL_SIDEBAR_SECTIONS: readonly SidebarSection[] = ["tools", "agents", "channels", "people"];
const ORDER_KEY = "order";

/**
 * Every section exactly once, else `fallback` (the default of the workspace's mode): a stored order is never trusted
 * as is.
 */
export function sidebarOrderOf(raw: unknown, fallback: readonly SidebarSection[] = SIDEBAR_SECTIONS): SidebarSection[] {
  const list = Array.isArray(raw) ? raw : [];
  const valid =
    list.length === SIDEBAR_SECTIONS.length && SIDEBAR_SECTIONS.every((s) => list.filter((x) => x === s).length === 1);
  return valid ? (list as SidebarSection[]) : [...fallback];
}

/**
 * The defaults of the workspace's mode: what a person who never saved an order sees. Read here and not by the apps
 * alone: an order the person saved that matches another mode's default (the agents under the channels, in a personal
 * workspace) is theirs, and must not read as "never saved".
 */
async function defaultsOf(db: Database, orgId: string) {
  const personal = await isPersonalWorkspace(db, orgId);
  return {
    sections: personal ? PERSONAL_SIDEBAR_SECTIONS : SIDEBAR_SECTIONS,
    tools: personal ? PERSONAL_SIDEBAR_ITEMS : SIDEBAR_ITEMS,
  };
}

/** The person's section order in this workspace. */
export async function mySidebarOrder(db: Database, orgId: string, userId: string): Promise<SidebarSection[]> {
  await requirePermission(db, userId, orgId, "read");
  const [row] = await db
    .select({ items: organizationMembers.sidebarItems })
    .from(organizationMembers)
    .where(mine(orgId, userId));
  return sidebarOrderOf(
    (row?.items as Record<string, unknown> | undefined)?.[ORDER_KEY],
    (await defaultsOf(db, orgId)).sections,
  );
}

/** Saves the person's section order in this workspace (`null`: back to the default); the tools' places stay. */
export async function setMySidebarOrder(
  db: Database,
  orgId: string,
  userId: string,
  order: readonly string[] | null,
): Promise<SidebarSection[]> {
  await requirePermission(db, userId, orgId, "read");
  if (order !== null && sidebarOrderOf(order).join() !== order.join())
    throw new ValidationError("the order must list every section once");
  const items = organizationMembers.sidebarItems;
  const [row] = await db
    .update(organizationMembers)
    .set({
      sidebarItems:
        order === null
          ? sql`${items} - ${ORDER_KEY}::text`
          : sql`${items} || jsonb_build_object(${ORDER_KEY}::text, ${JSON.stringify(order)}::jsonb)`,
    })
    .where(mine(orgId, userId))
    .returning({ items });
  return sidebarOrderOf(
    (row?.items as Record<string, unknown> | undefined)?.[ORDER_KEY],
    (await defaultsOf(db, orgId)).sections,
  );
}

const TOOLS_KEY = "tools";

/**
 * The tools in the person's order (`tools` in the same `sidebar_items` row): the known ones as stored, each once, then
 * any tool the app gained since in the default order (`base`, the workspace's mode's). Where each shows (list or More)
 * is its place, not this.
 */
export function sidebarToolOrderOf(raw: unknown, base: readonly SidebarItem[] = SIDEBAR_ITEMS): SidebarItem[] {
  const stored = Array.isArray(raw) ? raw.filter((x): x is SidebarItem => typeof x === "string" && isItem(x)) : [];
  return [...new Set([...stored, ...base])];
}

/** The person's order of the tools in this workspace. */
export async function mySidebarToolOrder(db: Database, orgId: string, userId: string): Promise<SidebarItem[]> {
  await requirePermission(db, userId, orgId, "read");
  const [row] = await db
    .select({ items: organizationMembers.sidebarItems })
    .from(organizationMembers)
    .where(mine(orgId, userId));
  return sidebarToolOrderOf(
    (row?.items as Record<string, unknown> | undefined)?.[TOOLS_KEY],
    (await defaultsOf(db, orgId)).tools,
  );
}

/**
 * Saves the person's order of the tools in this workspace (`null`: back to the default); places and sections stay. A
 * tab left open across a deploy sends the tools it knew, so `order` goes through `sidebarToolOrderOf` and isn't refused.
 */
export async function setMySidebarToolOrder(
  db: Database,
  orgId: string,
  userId: string,
  order: readonly string[] | null,
): Promise<SidebarItem[]> {
  await requirePermission(db, userId, orgId, "read");
  const items = organizationMembers.sidebarItems;
  const [row] = await db
    .update(organizationMembers)
    .set({
      sidebarItems:
        order === null
          ? sql`${items} - ${TOOLS_KEY}::text`
          : sql`${items} || jsonb_build_object(${TOOLS_KEY}::text, ${JSON.stringify(sidebarToolOrderOf(order))}::jsonb)`,
    })
    .where(mine(orgId, userId))
    .returning({ items });
  return sidebarToolOrderOf(
    (row?.items as Record<string, unknown> | undefined)?.[TOOLS_KEY],
    (await defaultsOf(db, orgId)).tools,
  );
}

const VIEW_KEY = "view";

/** How the AGENTES section orders the agents inside each group: the workspace's order, mine first, working first. */
export const AGENT_SORTS = ["workspace", "mine", "working"] as const;
export type AgentSort = (typeof AGENT_SORTS)[number];
/** At most this many pinned rows on top of each section ("Fixar no topo"). */
export const SIDEBAR_PIN_LIMIT = 5;
export const SIDEBAR_PIN_KINDS = ["agents", "channels", "people"] as const;
export type SidebarPins = Record<(typeof SIDEBAR_PIN_KINDS)[number], string[]>;

/**
 * How the person sees the sidebar's agents and what they pinned (`view` in the same `sidebar_items` row): the AGENTES
 * order, whether a manager shows the agents that don't talk to them, and the pinned agents, channels and people (agent,
 * channel and user ids, in order). `pins: null` means never saved: the apps pin the person's own agents then.
 */
export interface SidebarView {
  agentSort: AgentSort;
  showAllAgents: boolean;
  pins: SidebarPins | null;
}

const ids = (raw: unknown) =>
  Array.isArray(raw)
    ? [...new Set(raw.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64))].slice(
        0,
        SIDEBAR_PIN_LIMIT,
      )
    : [];

/** Only what the apps know, each pin list once per id and at most `SIDEBAR_PIN_LIMIT`: a row is never trusted as is. */
export function sidebarViewOf(raw: unknown): SidebarView {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const sort = (AGENT_SORTS as readonly unknown[]).includes(v.agentSort) ? (v.agentSort as AgentSort) : "workspace";
  const pins =
    v.pins && typeof v.pins === "object"
      ? (Object.fromEntries(
          SIDEBAR_PIN_KINDS.map((k) => [k, ids((v.pins as Record<string, unknown>)[k])]),
        ) as SidebarPins)
      : null;
  return { agentSort: sort, showAllAgents: v.showAllAgents === true, pins };
}

/** The person's sidebar view in this workspace. */
export async function mySidebarView(db: Database, orgId: string, userId: string): Promise<SidebarView> {
  await requirePermission(db, userId, orgId, "read");
  const [row] = await db
    .select({ items: organizationMembers.sidebarItems })
    .from(organizationMembers)
    .where(mine(orgId, userId));
  return sidebarViewOf((row?.items as Record<string, unknown> | undefined)?.[VIEW_KEY]);
}

/** Replaces the person's sidebar view in this workspace; the tools' places and both orders stay. */
export async function setMySidebarView(
  db: Database,
  orgId: string,
  userId: string,
  view: SidebarView,
): Promise<SidebarView> {
  await requirePermission(db, userId, orgId, "read");
  const clean = sidebarViewOf(view);
  const items = organizationMembers.sidebarItems;
  await db
    .update(organizationMembers)
    .set({ sidebarItems: sql`${items} || jsonb_build_object(${VIEW_KEY}::text, ${JSON.stringify(clean)}::jsonb)` })
    .where(mine(orgId, userId));
  return clean;
}
