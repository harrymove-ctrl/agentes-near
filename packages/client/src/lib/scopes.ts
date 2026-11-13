import type { TFunction } from "i18next";
import type { Connection, ConnectorCatalog, ConnectorDef, CustomServer, ScopeGrant, ScopeInfo } from "../api/types";

/**
 * Agent permissions in two layers (ADR 0016): built-in scopes, plus the scopes of
 * each connector the organization connected. The server checks every grant
 * against its catalog; this only shapes it for the screens.
 */

export const grantKey = (g: ScopeGrant) => `${g.connectionId ?? ""}|${g.scope}`;

/** i18n key of a scope or connector id (`github:pr.merge` → `github_pr_merge`, `meta-ads` → `meta_ads`). */
const safe = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "_");

/** Our translation of a known scope, or the server's (English) text. */
export function scopeText(t: TFunction, scope: ScopeInfo) {
  const tt = t as unknown as (key: string, options: { defaultValue: string }) => string;
  return {
    label: tt(`scopes.${safe(scope.id)}.label`, { defaultValue: scope.label }),
    description: tt(`scopes.${safe(scope.id)}.description`, { defaultValue: scope.description }),
  };
}

/** A built-in tool's label and description in the app's language (keyed by tool name), or the server's English. */
export function builtinToolText(t: TFunction, tool: { name: string; label: string; description: string }) {
  const tt = t as unknown as (key: string, options: { defaultValue: string }) => string;
  return {
    label: tt(`builtinTools.${safe(tool.name)}.label`, { defaultValue: tool.label }),
    description: tt(`builtinTools.${safe(tool.name)}.description`, { defaultValue: tool.description }),
  };
}

/** The connector's name in the app's language: the brand, plus what a variant is ("Supabase (somente leitura)"). */
export function connectorName(t: TFunction, def: Pick<ConnectorDef, "id" | "label">) {
  const tt = t as unknown as (key: string, options: { defaultValue: string }) => string;
  return tt(`connectors.names.${safe(def.id)}`, { defaultValue: def.label });
}

/** Where one signs in: the brand, without what a variant is ("Supabase (read-only)" → "Supabase"). */
export const connectorBrand = (def: Pick<ConnectorDef, "label">) => def.label.replace(/\s*\(.*\)$/, "");

export function connectorDescription(t: TFunction, def: ConnectorDef) {
  const tt = t as unknown as (key: string, options: { defaultValue: string }) => string;
  return tt(`connectors.descriptions.${safe(def.id)}`, { defaultValue: def.description });
}

export interface ScopeRow {
  key: string;
  grant: ScopeGrant;
  label: string;
  description: string;
  sensitive: boolean;
}

export interface ScopeGroup {
  id: string;
  name: string;
  note: string;
  scopes: ScopeRow[];
}

/** Built-in scopes first, then one group per active connection. */
export function scopeGroups(
  t: TFunction,
  catalog: ConnectorCatalog,
  connections: Connection[],
  builtinName: { name: string; note: string },
  customServers: CustomServer[] = [],
): ScopeGroup[] {
  const row = (connectionId: string | null, s: ScopeInfo): ScopeRow => {
    const grant = { connectionId, scope: s.id };
    return { key: grantKey(grant), grant, ...scopeText(t, s), sensitive: s.sensitive };
  };
  const groups: ScopeGroup[] = [
    { id: "builtin", ...builtinName, scopes: catalog.builtinScopes.map((s) => row(null, s)) },
  ];
  for (const c of connections.filter((x) => !x.revokedAt)) {
    const def = catalog.connectors.find((d) => d.id === c.connector);
    if (!def) continue;
    groups.push({
      id: c.id,
      name: def.label,
      note: c.accountLabel ?? c.label,
      scopes: def.scopes.map((s) => row(c.id, s)),
    });
  }
  // Custom MCP servers come from their own endpoint; nothing is exposed until an admin reviews the tools.
  for (const c of customServers.filter((x) => x.reviewedAt)) {
    groups.push({
      id: c.id,
      name: c.label,
      note: c.via === "composio" ? (c.accountLabel ?? "") : c.serverUrl,
      scopes: customScopes(t, c.id),
    });
  }
  return groups;
}

/** Profile summary: what is granted per group, and which granted scopes ask for approval. */
export function scopeSummary(groups: ScopeGroup[], grants: ScopeGrant[], none: string) {
  const granted = new Set(grants.map(grantKey));
  const rows = groups.map((g) => {
    const on = g.scopes.filter((s) => granted.has(s.key));
    const plain = on.filter((s) => !s.sensitive).map((s) => s.label.toLowerCase());
    return {
      id: g.id,
      name: g.name,
      granted: plain.length ? plain.join(", ") : none,
      gated: on.filter((s) => s.sensitive).map((s) => s.label.toLowerCase()),
    };
  });
  const all = groups.flatMap((g) => g.scopes);
  return {
    rows,
    total: all.length,
    granted: all.filter((s) => granted.has(s.key)).length,
    connectors: groups.length - 1,
  };
}

/** A custom MCP server has two scopes: its read tools, and its write tools (those that ask approval included). */
function customScopes(t: TFunction, connectionId: string): ScopeRow[] {
  const tt = t as unknown as (key: string, options: { defaultValue: string }) => string;
  return (["read", "write"] as const).map((access) => {
    const grant = { connectionId, scope: `custom:${connectionId}:${access}` };
    return {
      key: grantKey(grant),
      grant,
      label: tt(`scopes.custom_${access}.label`, {
        defaultValue: access === "read" ? "Read tools" : "Write tools",
      }),
      description: tt(`scopes.custom_${access}.description`, {
        defaultValue:
          access === "read"
            ? "Look up data with the tools classified as read."
            : "Use the write tools. Those marked sensitive always ask for approval.",
      }),
      sensitive: access === "write",
    };
  });
}
