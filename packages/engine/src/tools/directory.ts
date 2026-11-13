import type { MissingConnector } from "../connectors/listing";
import { cutText } from "../format";
import { oneLine } from "../mail/text";
import { PASS_TOOL } from "../reply-policy";
import type { JsonSchema } from "./json-schema";
import type { ToolDefinition } from "./types";

/**
 * Big connectors as a directory (ADR 0043): a connector with more tools than the
 * model can take in at once (TikTok Ads: 382) is listed as two tools of ours,
 * `<prefix>_find_tools` (a local search over its tools, no model call) and
 * `<prefix>_use_tool` (runs one of them by its real name). Same for every
 * brain: the API's tool loop, Claude Code and Codex through the MCP bridge.
 *
 * `use_tool` is only a way in: the gateway runs the real tool through the
 * same path as a direct call (scope, schema validation, call checks,
 * approval, run steps), so permissions and approval cards never see the
 * directory.
 */

/** A connector with more tools than this is listed as a directory. */
export const DIRECTORY_MAX_TOOLS = 40;
/** …or with more than this in descriptions and schemas. */
export const DIRECTORY_MAX_CHARS = 100_000;
/** Matches `find_tools` returns by default, and at most. */
export const FIND_DEFAULT = 8;
export const FIND_MAX = 20;
/** A match's input schema in the result, at most (characters). */
const SCHEMA_CHARS = 1_500;
/** Listed tools whose input an `EVERY_TOOL` search shows: the best matches only, so an answer stays small. */
const EVERY_INPUTS = 3;

/** The directory a listed tool stands for (only on the two directory tools). */
export interface DirectoryRole {
  kind: "find" | "use";
  /** The connector's real tools (already filtered by the agent's grants). */
  tools: ToolDefinition[];
  prefix: string;
  label: string;
  /** The prefix its names had before they followed the connector's own (`vega` for `vega_crm`): those still work. */
  legacy?: string;
  /** The on-demand directory of a run that lists every tool (`EVERY_TOOL`): it only searches them. */
  every?: boolean;
}

const roles = new WeakMap<ToolDefinition, DirectoryRole>();

/** The directory behind a listed tool, if it is `find_tools` or `use_tool`. */
export const directoryRole = (tool: ToolDefinition | undefined) => (tool ? roles.get(tool) : undefined);

/** A tool the agent may not use, as `find_tools` names it: its name and what it does, never its input. */
export interface BlockedTool {
  tool: ToolDefinition;
  /**
   * Every permission a person turns on for it, each as `request_permission` takes it; null: an admin turned
   * this tool, or one it needs, off by name; empty: its connector is the agent's with less access than it needs,
   * which only an admin changes.
   */
  permissions: { id: string; label: string }[] | null;
}

/**
 * Read when `find_tools` runs. `ask`: the tool that asks a person for a permission, when this run may call it.
 * `connectors`: the connectors the agent could get, named when a search asks for one.
 */
export type BlockedTools = () => Promise<{ tools: BlockedTool[]; ask: string | null; connectors?: MissingConnector[] }>;

const sizeOf = (t: ToolDefinition) => t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;

/** The first word all the tools' names share (`tiktok_ad_create`, `tiktok_report_get` → `tiktok`), or "". */
function sharedFirstWord(tools: ToolDefinition[]) {
  const first = tools[0]?.name.split("_")[0] ?? "";
  return first && tools.every((t) => t.name.startsWith(`${first}_`)) ? first : "";
}

/**
 * What the connector's tool names start with, so its directory is named the same way: its label as the connector
 * source writes it in them (`Vega CRM` → `vega_crm_…`), else the first word they share (a catalog connector's id:
 * `drive_…` for Google Drive), else the label.
 */
function prefixOf(tools: ToolDefinition[], label: string) {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 24);
  if (slug && tools.every((t) => t.name.startsWith(`${slug}_`))) return slug;
  return sharedFirstWord(tools) || slug || "connector";
}

/** What a harness puts before our MCP tools' names (Claude Code's `mcp__agentes__find_tools`). */
export const HARNESS_PREFIX = /^mcp__agentes__/;
const bareName = (name: string) => name.trim().replace(HARNESS_PREFIX, "");

/** The names a directory's `use_tool` may mean by `name`: as written, after its connector's prefix, after the one before. */
function spellings(role: DirectoryRole, name: string) {
  const n = bareName(name);
  return [n, ...(role.prefix ? [`${role.prefix}_${n}`] : []), ...(role.legacy ? [`${role.legacy}_${n}`] : [])];
}

/** The real tool a directory's `use_tool` names, among the directory's own (`spellings`). */
export function resolveDirectoryTool(role: DirectoryRole, name: string) {
  for (const full of spellings(role, name)) {
    const tool = role.tools.find((t) => t.name === full);
    if (tool) return tool;
  }
  return undefined;
}

const directoryName = (prefix: string, kind: DirectoryRole["kind"]) =>
  `${prefix}_${kind === "find" ? "find_tools" : "use_tool"}`;

/** A listed tool by its name, or a directory by the name it had before (`vega_find_tools`: `vega_crm_find_tools`). */
export function listedTool(shown: readonly ToolDefinition[], name: string) {
  const n = bareName(name);
  const exact = shown.find((t) => t.name === n);
  if (exact) return exact;
  const before = shown.filter((t) => {
    const role = roles.get(t);
    return role?.legacy !== undefined && directoryName(role.legacy, role.kind) === n;
  });
  return before.length === 1 ? before[0] : undefined;
}

/**
 * Names one `_` word away from `name`, a word missing or extra (`vega_listar` for `vega_crm_listar`), or the same
 * name with words before it or without them, when there are few enough to name. Never another word in a word's
 * place: `get` for `delete` is another tool.
 */
function nearNames(name: string, names: Iterable<string>) {
  if (!name) return [];
  const words = name.split("_");
  const near = (other: string) => {
    if (other === name) return false;
    if (other.endsWith(`_${name}`) || name.endsWith(`_${other}`)) return true;
    const o = other.split("_");
    if (Math.abs(o.length - words.length) !== 1) return false;
    let head = 0;
    while (head < o.length && head < words.length && o[head] === words[head]) head++;
    let tail = 0;
    while (tail < o.length - head && tail < words.length - head && o.at(-1 - tail) === words.at(-1 - tail)) tail++;
    return Math.max(o.length, words.length) - head - tail === 1;
  };
  const found = [...new Set(names)].filter(near).sort();
  return found.length <= 3 ? found : [];
}

/**
 * Nothing runs by that name: what the agent can call instead. `within`: the directory whose `use_tool` named it.
 * A close name is given exactly (and the directory that runs it, when it isn't listed); else where to search.
 */
function unknownTool(
  name: string,
  shown: readonly ToolDefinition[],
  all: ReadonlyMap<string, ToolDefinition>,
  within: DirectoryRole | null,
) {
  const head = within ? `No ${within.label} tool named "${name}".` : `Unknown tool ${name}`;
  const near = nearNames(name, [...all.keys(), ...shown.filter((t) => roles.has(t)).map((t) => t.name)]);
  const via = (exact: string) => {
    if (shown.some((t) => t.name === exact)) return "";
    const runs = shown.find((t) => roles.get(t)?.kind === "use" && roles.get(t)?.tools.some((r) => r.name === exact));
    return runs ? ` (run it with ${runs.name})` : "";
  };
  const end = within ? "" : ".";
  if (near.length === 1) return `${head}${end} The exact name is ${near[0]}${via(near[0] as string)}.`;
  if (near.length > 1) return `${head}${end} Exact names close to it: ${near.join(", ")}.`;
  return within
    ? `${head} Find the exact name with ${within.prefix ? directoryName(within.prefix, "find") : ON_DEMAND_FIND}.`
    : head;
}

/**
 * What a call runs, from the run's list as the model sees it (`shown`) and every tool of the sources (`all`): a tool
 * by its name; a directory's `find_tools` as itself (`find`); its `use_tool` as the tool it names, through another
 * directory's `use_tool` inside too. That tool may be any of the sources', by its name or without its connector's
 * prefix, a directory's own tools included: the gateway then refuses one the agent may not use, saying why. A name a
 * directory had before (`legacy`) is that directory now, and a harness's prefix (`HARNESS_PREFIX`) is no part of
 * the name. Nothing by that name: an error naming what to call instead (`unknownTool`).
 */
export function resolveCall<C extends { name: string; input: Record<string, unknown> }>(
  shown: readonly ToolDefinition[],
  all: ReadonlyMap<string, ToolDefinition>,
  call: C,
): { call: C; find?: ToolDefinition } | { error: string } {
  // The call itself while nothing about it changes: the gateway tells a call that came through a directory by that.
  const bare = bareName(call.name);
  let current: C = bare === call.name ? call : { ...call, name: bare };
  let within: DirectoryRole | null = null;
  for (let hop = 0; hop <= 3; hop++) {
    if (all.has(current.name)) return { call: current };
    const listed = listedTool(shown, current.name);
    const role = directoryRole(listed);
    if (!listed || !role) break;
    if (role.kind === "find") {
      return { call: listed.name === current.name ? current : { ...current, name: listed.name }, find: listed };
    }
    if (hop === 3) break;
    const named = typeof current.input.tool === "string" ? current.input.tool : "";
    const spelled = spellings(role, named);
    const args = current.input.arguments;
    current = {
      ...current,
      // The directory's own first, then any tool by those names: one the agent may not use is refused as itself.
      name: resolveDirectoryTool(role, named)?.name ?? spelled.find((n) => all.has(n)) ?? (spelled[0] as string),
      input: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
    };
    within = role;
  }
  return { error: unknownTool(current.name, shown, all, within) };
}

/** The most common topics in the connector's tool names (`ad`, `campaign`, `report`…), for the search's description. */
function areasOf(tools: ToolDefinition[], prefix: string) {
  const counts = new Map<string, number>();
  for (const t of tools) {
    const word = t.name.slice(prefix.length + 1).split("_")[0];
    if (word && word.length > 1) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 24)
    .map(([w]) => w);
}

type IsSensitive = (tool: ToolDefinition) => boolean;

function directoryTools(
  prefix: string,
  label: string,
  tools: ToolDefinition[],
  connectionId: string,
  sensitive: IsSensitive,
) {
  const areas = areasOf(tools, prefix);
  const find: ToolDefinition = {
    name: `${prefix}_find_tools`,
    description: `Find ${label} tools (${tools.length} in all${areas.length ? `, about: ${areas.join(", ")}` : ""}) by what you need to do. Returns the best matches with their exact names, what each needs (input) and whether it asks a person's approval. Then call one with \`${prefix}_use_tool\`.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What you need, in a few words (e.g. 'create an ad', 'campaign report').",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: FIND_MAX,
          description: `How many matches (default ${FIND_DEFAULT}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    scope: "",
    connectionId,
    connectorLabel: label,
    execute: async (input) => ({ content: findTools(tools, prefix, label, input, sensitive) }),
  };
  const use: ToolDefinition = {
    name: `${prefix}_use_tool`,
    description: `Run one ${label} tool by the exact name \`${prefix}_find_tools\` gave you, with its input in \`arguments\`. Approvals and permissions are the tool's own.`,
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: `The tool's name, e.g. ${tools[0]?.name ?? `${prefix}_…`}.` },
        arguments: { type: "object", description: "The tool's input, as its schema says." },
      },
      required: ["tool", "arguments"],
      additionalProperties: false,
    },
    scope: "",
    connectionId,
    connectorLabel: label,
    // Never runs itself: the gateway runs the real tool (`directoryRole`).
    execute: async () => ({ content: "Unknown tool", isError: true }),
  };
  // Named after the first word of the tools' names before: a conversation that learned those names keeps them.
  const before = sharedFirstWord(tools);
  const legacy = before && before !== prefix ? { legacy: before } : {};
  roles.set(find, { kind: "find", tools, prefix, label, ...legacy });
  roles.set(use, { kind: "use", tools, prefix, label, ...legacy });
  return [find, use];
}

/**
 * The tools as the model sees them: every built-in tool and small connector
 * as is, each big connector (`DIRECTORY_MAX_TOOLS` / `DIRECTORY_MAX_CHARS`)
 * as its two directory tools. Order is kept (a big connector's pair sits where
 * its first tool was).
 *
 * Tools on demand (`loaded`, a run's tool groups, ADR 0043): only the core groups
 * and the loaded ones go as they are; the rest sit behind one directory of
 * their own, `find_tools` / `use_tool`, at the end of the list. Without
 * `loaded` every tool goes. `blocked`: what that `find_tools` also names as
 * not allowed yet (the gateway's, when it runs a call).
 */
export function presentTools(
  tools: ToolDefinition[],
  sensitive: IsSensitive = (t) => t.sensitive === true,
  loaded?: readonly string[] | null,
  blocked?: BlockedTools,
): ToolDefinition[] {
  if (loaded?.includes(EVERY_TOOL)) {
    if (tools.length === 0) return [];
    const shown = presentTools(
      [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      sensitive,
    );
    const taken = new Set(shown.map((t) => t.name));
    if (taken.has(ON_DEMAND_FIND) || taken.has(ON_DEMAND_USE)) return shown;
    // A big connector's own tools stay behind its directory, and are found by `find_tools` too.
    const behind = tools.filter((t) => !taken.has(t.name));
    const groups = deferrableGroups(shown.flatMap((t) => directoryRole(t)?.tools ?? [t])).map((g) => g.label);
    return [...shown, ...onDemandTools(behind, sensitive, shown, blocked, groups)];
  }
  if (loaded) {
    const keep = new Set(loaded);
    const now = new Set(tools.filter((t) => isCore(t) || keep.has(toolGroupKey(t))));
    const later = tools.filter((t) => !now.has(t));
    const shown = presentTools([...now], sensitive);
    if (later.length === 0) return shown;
    const taken = new Set(shown.map((t) => t.name));
    if (taken.has(ON_DEMAND_FIND) || taken.has(ON_DEMAND_USE)) return [...shown, ...later];
    return [...shown, ...onDemandTools(later, sensitive, shown, blocked)];
  }
  const byConnection = new Map<string, ToolDefinition[]>();
  for (const t of tools) {
    if (!t.connectionId) continue;
    const group = byConnection.get(t.connectionId) ?? [];
    group.push(t);
    byConnection.set(t.connectionId, group);
  }
  const big = new Map<string, ToolDefinition[]>();
  const taken = new Set(tools.map((t) => t.name));
  for (const [id, group] of byConnection) {
    const chars = group.reduce((n, t) => n + sizeOf(t), 0);
    if (group.length <= DIRECTORY_MAX_TOOLS && chars <= DIRECTORY_MAX_CHARS) continue;
    const label = group[0]?.connectorLabel ?? "Connector";
    // Two accounts of one server share their names' first word: each connection's own prefix keeps them apart.
    let prefix = group[0]?.toolPrefix ?? prefixOf(group, label);
    // A name a real tool already has can't be taken by the directory.
    if (taken.has(`${prefix}_find_tools`) || taken.has(`${prefix}_use_tool`)) prefix = `${prefix}_dir`;
    big.set(id, directoryTools(prefix, label, group, id, sensitive));
  }
  if (big.size === 0) return tools;
  const out: ToolDefinition[] = [];
  const placed = new Set<string>();
  for (const t of tools) {
    const pair = t.connectionId ? big.get(t.connectionId) : undefined;
    if (!pair) out.push(t);
    else if (t.connectionId && !placed.has(t.connectionId)) {
      placed.add(t.connectionId);
      out.push(...pair);
    }
  }
  return out;
}

// ── Tools on demand (ADR 0043) ───────────────────────────────────────────────

/** A tool's group: its scope's prefix (`drive:write` → `drive`), each custom connector on its own; "" = conversation. */
export function toolGroupKey(tool: Pick<ToolDefinition, "scope" | "connectionId"> & { name?: string }) {
  if (tool.name && RARE_TOOLS.has(tool.name)) return RARE_GROUP;
  if (tool.name && DASHBOARD_TOOLS.has(tool.name) && !tool.connectionId) return DASHBOARD_GROUP;
  const prefix = tool.scope.split(":")[0] ?? "";
  return prefix.startsWith("custom") ? `custom:${tool.connectionId ?? prefix}` : prefix;
}

/**
 * Groups every run gets as they are: the conversation, memory and skills
 * (the prompt points at them), and reading the wiki (its index is in the
 * prompt). Everything else is loaded when the run needs it.
 */
export const CORE_GROUPS: ReadonlySet<string> = new Set(["", "context", "memory", "skills"]);
/** `vault_list` too (ADR 0144): an agent looks in the Vault before it asks a person for a password, a key or an address. */
const CORE_TOOLS: ReadonlySet<string> = new Set(["read_wiki_page", "search_wiki", "vault_list"]);

/**
 * Tools of the core groups that few runs use (token-trim B3): a group of their own, loaded on demand like any other.
 * Never what the agent reaches for on its own (react, ask_user, request_permission, remember, save_how_to,
 * update_memory, forget, update_skill, search_context, the web, ask_agent, tell_agent, follow_up,
 * work_in_background, post_message, send_dm, post_update, show_block, the skill and wiki readers).
 */
export const RARE_TOOLS: ReadonlySet<string> = new Set([
  "propose_instruction_change",
  // Its schema is the whole settings card: up front in every run it outweighs what it saves (ADR 0137, 2026-11-12).
  "request_settings_change",
  "send_sticker",
  "read_skill_file",
  "find_agent",
  "get_my_usage",
  "set_status",
  "set_reply_style",
  "add_agent_to_channel",
  "update_thread",
  "cancel_follow_up",
  "offer_install_skill",
  "update_skill_from_source",
  "read_conversation",
  "send_feedback",
  "offer_feedback",
]);
const RARE_GROUP = "more";

/**
 * Boards and widgets (ADR 0135 §10): built-in for every agent (no scope), loaded when a run needs them, like a scope's
 * group. `update_widget` stays with the conversation's tools: it is listed only on a widget's own run.
 */
export const DASHBOARD_TOOLS: ReadonlySet<string> = new Set([
  "list_dashboards",
  "create_dashboard",
  "create_widget",
  "share_dashboard",
]);
const DASHBOARD_GROUP = "dashboards";

export const isCore = (tool: Pick<ToolDefinition, "name" | "scope" | "connectionId">) =>
  !RARE_TOOLS.has(tool.name) && (CORE_GROUPS.has(toolGroupKey(tool)) || CORE_TOOLS.has(tool.name));

/**
 * A core tool whose definition is the same in every run of the agent (`ToolSpec.stable`, the cached start of the
 * tool list): not the on-demand pair (it names what isn't loaded) nor `pass` (only a run nobody called gets it).
 */
export const isStableTool = (tool: Pick<ToolDefinition, "name" | "scope" | "connectionId">) =>
  isCore(tool) && tool.name !== ON_DEMAND_FIND && tool.name !== ON_DEMAND_USE && tool.name !== PASS_TOOL;

/** How a group is named for the model and the judge ("Browser", "GitHub", a connector's label). */
const GROUP_LABELS: Record<string, string> = {
  [RARE_GROUP]:
    "More of the conversation (reading a channel or a message by its link, stickers, your status, reply style, threads, adding agents to channels, the agents' directory, your usage, instruction changes, your own settings, feedback on this app)",
  drive: "Files (Drive)",
  [DASHBOARD_GROUP]: "Dashboards and widgets (numbers and charts kept up to date, boards to share)",
  issues: "Issues",
  calendar: "Calendar",
  schedule: "Schedule, reminders and routines",
  wiki: "Organization wiki (writing)",
  sandbox: "Computer and code",
  browser: "Browser",
  setup:
    "Workspace setup (connect an AI, an app or an MCP server, invite people, create channels, propose agents, archive or delete agents; the right hand: approvals, people, any screen)",
  vault: "Vault (saving contact details, changing a saved username or description)",
  github: "GitHub",
  sentry: "Sentry",
  linear: "Linear",
};

export interface ToolGroup {
  key: string;
  label: string;
  tools: ToolDefinition[];
}

/** The groups a run could load (core groups left out), in the order of their first tool. */
export function deferrableGroups(tools: ToolDefinition[]): ToolGroup[] {
  const groups = new Map<string, ToolGroup>();
  for (const t of tools) {
    if (isCore(t)) continue;
    const key = toolGroupKey(t);
    const group = groups.get(key) ?? {
      key,
      label: GROUP_LABELS[key] ?? t.connectorLabel ?? key.charAt(0).toUpperCase() + key.slice(1),
      tools: [],
    };
    group.tools.push(t);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export const ON_DEMAND_FIND = "find_tools";
export const ON_DEMAND_USE = "use_tool";

/**
 * A run's tool groups that list every granted tool, sorted by name, with `find_tools` / `use_tool` after them
 * (`presentTools`): a computer brain's harness defers our tools itself, so one list per agent keeps its cached prefix
 * the same from run to run and session to session.
 */
export const EVERY_TOOL = "*";

/** Whether the run lists every tool (`EVERY_TOOL`): tools that don't apply to it are listed anyway, and refuse. */
export const listsEveryTool = (ctx: { loadedGroups?: readonly string[] | null }) =>
  ctx.loadedGroups?.includes(EVERY_TOOL) === true;

/**
 * The directory of a run's tools not loaded yet: `find_tools` searches them
 * (BM25, no model call) and `use_tool` runs one by its name, through the
 * gateway like any direct call. Its description names every group, so the
 * model knows what it can reach. The search ranks the run's `loaded` tools
 * too: a model that searches for a tool it already has is told to call it,
 * never ahead of a better match. And the `blocked` ones: a missing permission
 * then reads as one, not as a missing capability.
 */
function onDemandTools(
  tools: ToolDefinition[],
  sensitive: IsSensitive,
  loaded: ToolDefinition[],
  blocked?: BlockedTools,
  /** Every tool is listed (`EVERY_TOOL`): the groups the agent has, named the same in every run. */
  every?: string[],
): ToolDefinition[] {
  const groups = deferrableGroups(tools);
  const areas = groups.map((g) => `${g.label} (${g.tools.length})`);
  const label = "other";
  const find: ToolDefinition = {
    name: ON_DEMAND_FIND,
    description: every
      ? `Search all your tools${every.length ? ` (the conversation's and ${every.join(", ")})` : ""} by what you need to do; returns the best matches with their exact names, what each needs (input) and whether it asks a person's approval. Call one directly, or with \`${ON_DEMAND_USE}\`. It also tells which tools you aren't allowed to use yet and how to ask for them. Search before saying you can't do something.`
      : `More tools you have, loaded when you need them: ${areas.join(", ")}. Find them by what you need to do; returns the best matches with their exact names, what each needs (input) and whether it asks a person's approval. Then call one with \`${ON_DEMAND_USE}\`. It also tells which tools you aren't allowed to use yet and how to ask for them. Search before saying you can't do something.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What you need, in a few words (e.g. 'open a web page', 'create an issue', 'sentry errors').",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: FIND_MAX,
          description: `How many matches (default ${FIND_DEFAULT}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    scope: "",
    execute: async (input, ctx) => ({
      content: findTools(
        tools,
        "",
        label,
        input,
        sensitive,
        every ?? groups.map((g) => g.label),
        ON_DEMAND_USE,
        loaded,
        await blocked?.(),
        await (async () => {
          const names = new Set([...tools, ...loaded].map((t) => t.name));
          const teammates = reachesTeammates(names)
            ? await import("../team").then((m) => m.teammateMeans(ctx)).catch(() => [])
            : [];
          const personal = await import("../workspace-mode")
            .then((m) => m.isPersonalWorkspace(ctx.db, ctx.orgId))
            .catch(() => false);
          return turnMeans(names, teammates, personal);
        })(),
        every ? EVERY_INPUTS : 0,
      ),
    }),
  };
  const use: ToolDefinition = {
    name: ON_DEMAND_USE,
    description: `Run one of your tools by the exact name \`${ON_DEMAND_FIND}\` gave you, with its input in \`arguments\`. Approvals and permissions are the tool's own.`,
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "The tool's exact name." },
        arguments: { type: "object", description: "The tool's input, as its schema says." },
      },
      required: ["tool", "arguments"],
      additionalProperties: false,
    },
    scope: "",
    // Never runs itself: the gateway runs the real tool (`directoryRole`).
    execute: async () => ({ content: "Unknown tool", isError: true }),
  };
  const all = every ? { every: true } : {};
  roles.set(find, { kind: "find", tools, prefix: "", label, ...all });
  roles.set(use, { kind: "use", tools, prefix: "", label, ...all });
  return [find, use];
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

/** A singular-ish stem, so "ads" finds "ad" and "campaigns" finds "campaign". */
const stem = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** What the search reads in a tool: its name (twice: it matters most), description and input's names and descriptions. */
function docOf(t: ToolDefinition, prefix: string) {
  const name = t.name.startsWith(`${prefix}_`) ? t.name.slice(prefix.length + 1) : t.name;
  const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
  const input = Object.entries(props)
    .map(([k, v]) => `${k} ${v?.description ?? ""}`)
    .join(" ");
  return [...words(name), ...words(name), ...words(t.description), ...words(input)].map(stem);
}

/** BM25 ranking of the connector's tools for a query (best first, only tools that match). */
export function rankTools(tools: ToolDefinition[], prefix: string, query: string): ToolDefinition[] {
  const terms = [...new Set(words(query).map(stem))];
  if (terms.length === 0) return [];
  const docs = tools.map((t) => docOf(t, prefix));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(docs.length, 1);
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  const scored = docs.map((d, i) => {
    let score = 0;
    for (const term of terms) {
      const tf = d.filter((w) => w === term).length;
      if (tf === 0) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avg));
    }
    return { tool: tools[i] as ToolDefinition, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .map((s) => s.tool);
}

/** A tool's input schema, short enough for a search result: `required` first, so the cut never takes it. */
export function compactSchema(schema: JsonSchema) {
  const text = JSON.stringify({ required: schema.required, ...schema });
  return text.length > SCHEMA_CHARS ? `${cutText(text, SCHEMA_CHARS)}…` : text;
}

/** How a person gets a connector the agent lacks, in the app's words (and the Portuguese the app shows). */
export const HOW_TO_GET: Record<MissingConnector["state"], (label: string) => string> = {
  not_connected: (label) =>
    `Not connected in this workspace: an admin connects it in Settings › Connectors and MCPs › Add connector › ${label} (in Portuguese, Configurações › Conectores e MCPs › Adicionar conector › ${label}).`,
  not_given: () =>
    "Connected in this workspace but not given to you: an admin gives you access on your page, in Tools and access (in Portuguese, Ferramentas e acesso).",
  unavailable: () => "Not available on this installation: whoever runs the installation has to turn it on first.",
  soon: () =>
    "Not open to agentes.chat yet: it only lets apps it approved connect in one click. If it gives an API key, an admin connects it with that by its address, in Settings › Connectors and MCPs › Add MCP (in Portuguese, Configurações › Conectores e MCPs › Adicionar MCP).",
  needs_reconnect: () =>
    "Connected in this workspace but needs reconnecting: an admin clicks Reconnect on its row in Settings › Connectors and MCPs (in Portuguese, Configurações › Conectores e MCPs › Reconectar).",
};

/** The connectors the agent lacks that the query names (every word of a label or of an id), with how to get each. */
function connectorsToGet(query: string, connectors: MissingConnector[] = []) {
  const terms = new Set(words(query).map(stem));
  const isNamed = (name: string) => {
    const named = words(name).map(stem);
    return named.length > 0 && named.every((w) => terms.has(w));
  };
  const lines = connectors
    .filter((c) => c.names.some(isNamed))
    .map((c) => `- ${c.label}: ${c.description} ${HOW_TO_GET[c.state](c.label)}`);
  if (lines.length === 0) return "";
  return `Connectors you don't have yet. If the person wants one, offer it with offer_connect_app (a card that opens the app's own connect dialog) or say how to get it, never that it doesn't exist.\n${lines.join("\n")}`;
}

/**
 * A search's answer. `loaded`: tools already in the model's list, ranked with the directory's in one pass.
 * Those that outrank every other match open the answer, to call directly; any other keeps its rank, marked.
 * `blocked`: tools the agent may not use, in the same pass; those among the best `limit` close the answer in
 * sections of their own, never in a usable match's place. Last, the connectors the query names that the agent
 * lacks (`connectorsToGet`). `listedInputs`: how many of the best matches show their input even when listed: a
 * computer brain's harness may hold a listed tool's schema back, leaving the model only its name (`EVERY_TOOL`).
 */
function findTools(
  tools: ToolDefinition[],
  prefix: string,
  label: string,
  input: Record<string, unknown>,
  sensitive: IsSensitive,
  areas: string[] = areasOf(tools, prefix),
  useName = `${prefix}_use_tool`,
  loaded: ToolDefinition[] = [],
  blocked: Awaited<ReturnType<BlockedTools>> = { tools: [], ask: null },
  means: string[] = [],
  listedInputs = 0,
) {
  const query = typeof input.query === "string" ? input.query : "";
  const limit = Math.min(Math.max(Number(input.limit) || FIND_DEFAULT, 1), FIND_MAX);
  const blockedOf = new Map(blocked.tools.map((b) => [b.tool, b]));
  const ranked = rankTools([...loaded, ...tools, ...blockedOf.keys()], prefix, query);
  const matches = ranked.filter((t) => !blockedOf.has(t)).slice(0, limit);
  const notAllowed = ranked.slice(0, limit).flatMap((t) => blockedOf.get(t) ?? []);
  const toGet = connectorsToGet(query, blocked.connectors);
  // No dedicated tool, or only weak matches (the best one has under half the query's words): the general means.
  const weak = !matches[0] || coverage(matches[0], prefix, query) < 0.5;
  const general =
    weak && means.length > 0
      ? `General means you have for "${query}", whatever the words:\n${means.map((m) => `- ${m}`).join("\n")}`
      : "";
  if (matches.length === 0 && notAllowed.length === 0) {
    return `No ${label} tool matches "${query}". Try other words (${areas.slice(0, 12).join(", ")}).${general ? `\n\n${general}` : ""}${toGet ? `\n\n${toGet}` : ""}`;
  }
  const listed = new Set(loaded);
  const lead = matches.findIndex((t) => !listed.has(t));
  const ready = lead < 0 ? matches : matches.slice(0, lead);
  const more = matches.slice(ready.length);
  const parts: string[] = [];
  const withInput = new Set(matches.slice(0, listedInputs));
  const listedInput = (t: ToolDefinition) => (withInput.has(t) ? `\n  input: ${compactSchema(t.inputSchema)}` : "");
  if (ready.length > 0) {
    const names = ready.map((t) => `- ${t.name}: ${cutText(t.description, 300)}${listedInput(t)}`);
    // A computer brain's harness may still list what it had when it started: `use_tool` runs these too.
    const them = ready.length > 1 ? "them" : "it";
    parts.push(
      `Already in your tool list for "${query}": call ${them} directly (if your list doesn't show ${them} yet, ${useName} runs ${them} too).\n${names.join("\n")}`,
    );
  }
  if (more.length > 0) {
    const lines = more.map((t) =>
      listed.has(t)
        ? `- ${t.name} (already in your tool list: call it directly): ${cutText(t.description, 300)}${listedInput(t)}`
        : `- ${t.name}${sensitive(t) ? " (asks a person's approval; its input includes why)" : ""}: ${cutText(t.description, 300)}\n  input: ${compactSchema(t.inputSchema)}`,
    );
    parts.push(`${label} tools for "${query}" (call one with ${useName}):\n${lines.join("\n")}`);
  }
  // What it does in one sentence, never its input: nothing here is a way to call it.
  const named = (t: ToolDefinition) => `- ${t.name}: ${oneLine(t.description.split(/(?<=[.!?])\s/)[0] ?? "", 200)}`;
  const byPermission = new Map<string, string[]>();
  for (const { tool, permissions } of notAllowed) {
    if (!permissions?.length) continue;
    const head = `- ${permissions.map((p) => `permission "${p.id}" (${p.label})`).join(" and ")}, for:`;
    byPermission.set(head, [...(byPermission.get(head) ?? []), `  ${named(tool)}`]);
  }
  if (byPermission.size > 0) {
    const how = blocked.ask
      ? `ask a person with ${blocked.ask} (the permission as written here, and why), if the request needs it.`
      : "a person can turn these on for you; you can't ask for them from here.";
    const lines = [...byPermission].flatMap(([head, entries]) => [head, ...entries]);
    parts.push(`Not allowed for you yet: ${how}\n${lines.join("\n")}`);
  }
  const turnedOff = notAllowed.flatMap(({ tool, permissions }) => (permissions ? [] : [named(tool)]));
  if (turnedOff.length > 0) {
    parts.push(`Turned off for you by an admin; only an admin can turn them back on:\n${turnedOff.join("\n")}`);
  }
  const beyond = notAllowed.flatMap(({ tool, permissions }) => (permissions?.length === 0 ? [named(tool)] : []));
  if (beyond.length > 0) {
    parts.push(
      `Beyond your access to their connector; only an admin can change it, on your page in Tools and access (in Portuguese, Ferramentas e acesso):\n${beyond.join("\n")}`,
    );
  }
  if (general) parts.push(general);
  if (toGet) parts.push(toGet);
  return parts.join("\n\n");
}

/** How many of the query's words a tool's text has, as a share (0 to 1). */
function coverage(tool: ToolDefinition, prefix: string, query: string) {
  const terms = [...new Set(words(query).map(stem))];
  if (terms.length === 0) return 0;
  const doc = new Set(docOf(tool, prefix));
  return terms.filter((t) => doc.has(t)).length / terms.length;
}

/**
 * The general means a run has beyond any task's own tools (ADR 0109), by the tool names it can reach (loaded or on
 * demand): what the prompt's "Your means", `find_tools` with no good match and the turn-end judge all name, so none
 * points the agent at something it lacks. `teammates`: their handles with what they do, when known.
 */
/** Whether a run reaches other agents (`ask_agent`, `tell_agent`): only then does `turnMeans` name its teammates. */
export const reachesTeammates = (names: ReadonlySet<string>) => names.has("ask_agent") || names.has("tell_agent");

/** The requests that hand a person a step only they can do (ADR 0097 addendum): a step that needs them is no blocker. */
export const HAND_OVER_TOOLS = [
  "browser_ask_person",
  "desktop_ask_person",
  "request_secret",
  "request_approval",
  "request_permission",
] as const;

/**
 * What a run reads when a step needs a person: it is handed over with the request made for it, never a reason to stop
 * (ADR 0097 addendum). The controller's nudges and the mission prompts say it the same way.
 */
export const HAND_OVER_STEP =
  "A step only a person can do (sign in, scan a QR code, type a code sent to them, a captcha, approve, grant a permission, a key, a file or a fact only they have, something done by hand) is never a blocker or a reason to say you can't: do everything up to it, hand it over with its request (on a page or app: `browser_ask_person` or `desktop_ask_person` once at that step; a key: `request_secret`; an approval only someone else can give: `request_approval`; a permission: `request_permission`; else `ask_user`), then go on.";

/** The run's general means; `personal`: a personal workspace's words (ADR 0159), its other agents not "teammates". */
export function turnMeans(names: ReadonlySet<string>, teammates: string[] = [], personal = false): string[] {
  const out: string[] = [];
  if (names.has("web_search")) out.push("the web: `web_search` to search it, `web_fetch` to read any public page");
  if (names.has("browser_open") || names.has("browser_do"))
    out.push(
      "your browser (`browser_*`): any website or web app, search engines included, used as a person would, signed in to their account with their help (a service with no connector but a web version)",
    );
  if (names.has("run_code")) out.push("your computer's terminal (`run_code`): commands, scripts, files");
  if (names.has("vault_list"))
    out.push(
      "the Vault (`vault_list`): logins, keys and contact details people saved for you, used without ever seeing a password or a key",
    );
  if (names.has("find_tools")) out.push("the tool directory (`find_tools`): tools for apps and services");
  if (names.has("search_context"))
    out.push("the workspace (`search_context`): memory, past messages and steps, who holds which login");
  const handOver = HAND_OVER_TOOLS.filter((t) => names.has(t));
  if (handOver.length > 0)
    out.push(
      `hand a person a step only they can do (sign in, scan a QR code, a code, a captcha, approve, a key) with ${handOver.map((t) => `\`${t}\``).join(", ")}, then go on`,
    );
  if (reachesTeammates(names))
    out.push(
      `${personal ? "your fellow agents" : "teammates"} (\`ask_agent\`, \`tell_agent\`)${teammates.length > 0 ? `: ${teammates.join("; ")}` : ": the ones whose role covers it"}`,
    );
  return out;
}
