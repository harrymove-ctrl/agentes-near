import type { ApiClient } from "../api/client";
import type { AccessInput, AccessScope, AccessState, AccessTool, AgentAccess, ScopeGrant, ToolRef } from "../api/types";

/**
 * One access model for everything an agent can use: per connector (and per
 * built-in area such as Drive or Issues), a level — "Sem acesso", "Ler" or
 * "Ler e escrever". Levels are read from and written to the existing grants
 * of `GET/PUT …/agents/{id}/access` (no level is stored on its own):
 * - connector `read`: its read scopes (a catalog connector's `*.read` scopes,
 *   a custom server's `custom:{id}:read`), so read tools added later come too;
 * - connector `write`: the whole connection (`connector:*`), now and later;
 * - built-in area `read`: its `:read` scopes; `write`: every scope of the area.
 * Sensitive tools (merge, deploy, "Pede aprovação sempre") keep asking a
 * person at any level: approvals don't depend on grants.
 * Grants that don't match a level (one tool here, a denial there, from older
 * editors) show as `custom` until someone picks a level.
 */
export type Level = "none" | "read" | "write";
export type LevelState = Level | "custom";

export const LEVELS: Level[] = ["none", "read", "write"];

export interface AccessResource {
  /** `connector:{connectionId}` or `area:{area}`. */
  id: string;
  kind: "connector" | "builtin";
  connectionId: string | null;
  /** Catalog id of a connection ("github"), `custom:{id}` for a server by address; null for built-ins. */
  connector: string | null;
  /** Built-in area ("drive", "issues"…); null for connectors. */
  area: string | null;
  /** The server's label (a connection's name; a built-in area's first scope label as fallback). */
  label: string;
  custom: boolean;
  /** The levels this resource offers, in order (skills only read; running code only write). */
  levels: Level[];
  /** Scopes granted by "Ler". */
  readScopes: string[];
  /** Built-ins: scopes granted by "Ler e escrever" (connectors use `connector:*`). */
  writeScopes: string[];
  /** Every scope the tree shows for it (cleared when a level is set). */
  scopes: string[];
  tools: AccessTool[];
  /** The connection itself is granted (`connector:*`) or inherited ("all tools"). */
  whole: boolean;
  /** Not covered by "all tools" (running code). */
  notInAll: boolean;
}

const on = (s: AccessState) => s === "granted" || s === "inherited";

/** Built-in areas, in the order the UI shows them. `memory:*` joins the context area. */
export const AREA_ORDER = [
  "context",
  "drive",
  "issues",
  "calendar",
  "wiki",
  "skills",
  "schedule",
  "sandbox",
  "browser",
  "desktop",
];

/** Areas "all tools" doesn't cover: running code, and the agent's browser and desktop (ADR 0040, ADR 0058). */
export const NOT_IN_ALL_AREAS = ["sandbox", "browser", "desktop"];

/** "drive:read" → "drive"; "memory:write" → "context"; "" (always-on "ask the person") → null. */
export function builtinArea(scope: string): string | null {
  if (scope === "") return null;
  const prefix = scope.split(":")[0] ?? "";
  if (prefix === "memory") return "context";
  if (prefix === "artifacts") return "drive";
  return prefix || null;
}

const isReadScope = (scope: string) => /[.:]read$/.test(scope);

function connectorResource(c: AgentAccess["connectors"][number]): AccessResource {
  const tools = c.scopes.flatMap((s) => s.tools);
  const readScopes = c.custom
    ? [`custom:${c.connectionId}:read`]
    : c.scopes.filter((s) => isReadScope(s.scope) && !s.tools.some((t) => t.sensitive)).map((s) => s.scope);
  return {
    id: `connector:${c.connectionId}`,
    kind: "connector",
    connectionId: c.connectionId,
    connector: c.connector,
    area: null,
    label: c.label,
    custom: c.custom,
    levels: LEVELS,
    readScopes,
    writeScopes: [],
    scopes: c.scopes.map((s) => s.scope),
    tools,
    whole: on(c.state),
    notInAll: false,
  };
}

function builtinResources(builtins: AccessScope[], all: boolean): AccessResource[] {
  const by = new Map<string, AccessScope[]>();
  for (const s of builtins) {
    const area = builtinArea(s.scope);
    // A scope with no tools has no level to show; its grant is still saved back (`inputFromAccess` reads the tree).
    if (area && s.tools.length > 0) by.set(area, [...(by.get(area) ?? []), s]);
  }
  const order = (a: string) => (AREA_ORDER.includes(a) ? AREA_ORDER.indexOf(a) : AREA_ORDER.length);
  return [...by.entries()]
    .sort(([a], [b]) => order(a) - order(b))
    .map(([area, scopes]) => {
      const names = scopes.map((s) => s.scope);
      const readScopes = names.filter(isReadScope);
      const levels: Level[] = ["none"];
      if (readScopes.length > 0) levels.push("read");
      if (readScopes.length < names.length) levels.push("write");
      const notInAll = NOT_IN_ALL_AREAS.includes(area);
      return {
        id: `area:${area}`,
        kind: "builtin",
        connectionId: null,
        connector: null,
        area,
        label: scopes[0]?.label ?? area,
        custom: false,
        levels,
        readScopes,
        writeScopes: names,
        scopes: names,
        tools: scopes.flatMap((s) => s.tools),
        whole: all && !notInAll,
        notInAll,
      };
    });
}

/** What can be given to an agent, from its tree: connectors first, then the built-in areas. */
export function resourcesOf(access: AgentAccess): AccessResource[] {
  return [...access.connectors.map(connectorResource), ...builtinResources(access.builtins, access.all)];
}

/** The tools a level gives (sensitive ones included: they still ask). */
export function toolsAt(r: Pick<AccessResource, "tools" | "readScopes">, level: LevelState): AccessTool[] {
  if (level === "write") return r.tools;
  if (level === "read") return r.tools.filter((t) => r.readScopes.includes(t.scope));
  if (level === "custom") return r.tools.filter((t) => on(t.state));
  return [];
}

/** The sensitive tools a level gives: they always ask a person. */
export const asksAt = (r: Pick<AccessResource, "tools" | "readScopes">, level: LevelState) =>
  level === "none" ? [] : toolsAt(r, level).filter((t) => t.sensitive);

/** The resource's level, from the effective state of its tools. */
export function levelOf(r: AccessResource): LevelState {
  const tools = r.tools;
  const top: Level = r.levels.includes("write") ? "write" : "read";
  // Nothing to compare (a server not reviewed yet): only the whole connection says something.
  if (tools.length === 0) return r.whole ? top : "none";
  const granted = tools.filter((t) => on(t.state));
  if (granted.length === 0) return "none";
  const reads = toolsAt(r, "read");
  const onlyReads = reads.length === tools.length;
  if (granted.length === tools.length) {
    // Every tool is a read tool: "Ler" unless the whole connection is granted.
    if (onlyReads && r.levels.includes("read") && !r.whole) return "read";
    return top;
  }
  if (r.levels.includes("read") && granted.length === reads.length && granted.every((t) => reads.includes(t))) {
    return "read";
  }
  return "custom";
}

/** Every resource's level, by id. */
export function levelsOf(access: AgentAccess | undefined): Record<string, LevelState> {
  if (!access) return {};
  return Object.fromEntries(resourcesOf(access).map((r) => [r.id, levelOf(r)]));
}

/** One resource's level (`connector:{connectionId}` or `area:{area}`); none when unknown. */
export function levelIn(access: AgentAccess | undefined, resourceId: string): LevelState {
  return levelsOf(access)[resourceId] ?? "none";
}

/** The level everyone has ("Todos os agentes"), or null when they differ (or there is nobody). */
export function sharedLevel(levels: LevelState[]): LevelState | null {
  const [first] = levels;
  return first !== undefined && levels.every((l) => l === first) ? first : null;
}

/** The next level of a matrix cell: Sem acesso → Ler → Ler e escrever → Sem acesso (custom → the first after none). */
export function nextLevel(r: Pick<AccessResource, "levels">, current: LevelState): Level {
  const i = current === "custom" ? 0 : r.levels.indexOf(current);
  return r.levels[(i + 1) % r.levels.length] ?? "none";
}

/** Grant rows that aren't plain scopes (`*`, `connector:*`, `tool:…`, `deny:…`): the tree already says them. */
const special = (scope: string) =>
  scope === "*" || scope === "connector:*" || scope.startsWith("tool:") || scope.startsWith("deny:");

const key = (connectionId: string | null, scope: string) => `${connectionId ?? ""}|${scope}`;

/**
 * The agent's current grants as a PUT body, read back from the tree: explicit
 * scopes, connectors and per-tool allows/denials (what's only inherited is
 * left out, as it comes from a broader grant that is kept). `raw` (the
 * agent's grant rows) keeps scopes the tree doesn't show.
 */
export function inputFromAccess(access: AgentAccess, raw: ScopeGrant[] = []): AccessInput {
  const input: AccessInput = { all: access.all, connectors: {}, scopes: [], tools: { allow: [], deny: [] } };
  const take = (connectionId: string | null, scopes: AccessScope[]) => {
    for (const s of scopes) {
      const scopeGranted = s.scope !== "" && s.state === "granted";
      if (scopeGranted) input.scopes.push({ connectionId, scope: s.scope });
      for (const t of s.tools) {
        const ref: ToolRef = { connectionId, name: t.name };
        if (t.state === "denied") input.tools.deny.push(ref);
        else if (t.state === "granted" && !scopeGranted) input.tools.allow.push(ref);
      }
    }
  };
  take(null, access.builtins);
  for (const c of access.connectors) {
    if (c.state === "granted") input.connectors[c.connectionId] = true;
    take(c.connectionId, c.scopes);
  }
  const known = new Set(access.builtins.map((s) => key(null, s.scope)));
  for (const c of access.connectors) for (const s of c.scopes) known.add(key(c.connectionId, s.scope));
  const active = new Set(access.connectors.map((c) => c.connectionId));
  for (const g of raw) {
    // Only active connections: the server refuses grants on anything else.
    if (!g.connectionId || !active.has(g.connectionId) || special(g.scope)) continue;
    if (!known.has(key(g.connectionId, g.scope))) input.scopes.push(g);
  }
  return input;
}

/** Replaces what a resource grants with a level (or, for `custom`, the tools it has on now). */
function apply(input: AccessInput, r: AccessResource, level: LevelState) {
  const owns = (connectionId: string | null, scope: string) =>
    r.kind === "connector" ? connectionId === r.connectionId : connectionId === null && r.scopes.includes(scope);
  const names = new Set(r.tools.map((t) => t.name));
  const ownsTool = (t: ToolRef) =>
    r.kind === "connector" ? t.connectionId === r.connectionId : t.connectionId === null && names.has(t.name);
  if (level === "custom") {
    // Keep it as it is, tool by tool (when "all tools" goes away).
    for (const t of r.tools) {
      if (
        t.state === "inherited" &&
        !input.tools.allow.some((x) => x.connectionId === t.connectionId && x.name === t.name)
      ) {
        input.tools.allow.push({ connectionId: t.connectionId, name: t.name });
      }
    }
    return;
  }
  if (r.connectionId) delete input.connectors[r.connectionId];
  input.scopes = input.scopes.filter((s) => !owns(s.connectionId, s.scope));
  input.tools.allow = input.tools.allow.filter((t) => !ownsTool(t));
  input.tools.deny = input.tools.deny.filter((t) => !ownsTool(t));
  const scopes =
    level === "read" ? r.readScopes : level === "write" && r.kind === "builtin" ? r.writeScopes : ([] as string[]);
  for (const scope of scopes) input.scopes.push({ connectionId: r.connectionId, scope });
  if (level === "write" && r.connectionId) input.connectors[r.connectionId] = true;
}

/**
 * The PUT body that sets some resources to a level and keeps everything
 * else (other connectors, built-ins). "All tools" is
 * spelled out per resource first, so lowering one doesn't leave it granted.
 */
export function inputWithLevels(access: AgentAccess, raw: ScopeGrant[], changes: Record<string, Level>): AccessInput {
  const input = inputFromAccess(access, raw);
  const resources = resourcesOf(access);
  const changed = resources.filter((r) => changes[r.id] !== undefined);
  if (changed.length === 0) return input;
  if (input.all) {
    input.all = false;
    for (const r of resources) {
      if (r.notInAll || changes[r.id] !== undefined) continue;
      apply(input, r, levelOf(r));
    }
  }
  for (const r of changed) apply(input, r, changes[r.id] as Level);
  return input;
}

/** Reads the agent's grants fresh, sets the levels and saves (one PUT). */
export async function saveLevels(
  api: Pick<ApiClient, "access" | "scopes">,
  orgId: string,
  agentId: string,
  changes: Record<string, Level>,
): Promise<AgentAccess> {
  const [access, raw] = await Promise.all([api.access.get(orgId, agentId), api.scopes.get(orgId, agentId)]);
  return api.access.set(orgId, agentId, inputWithLevels(access, raw, changes));
}

/** How a catalog connector's tool is used: sensitive ones always ask; `*.read` scopes only read. */
export function catalogToolClass(tool: { scope: string; sensitive: boolean }): "read" | "write" | "approval" {
  if (tool.sensitive) return "approval";
  return tool.scope.endsWith(".read") ? "read" : "write";
}
