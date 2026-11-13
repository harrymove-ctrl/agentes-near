import type { MailAdapters } from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import { type MailAccountRow, mailProviders, orgMailAccounts, usableAccount } from "../mail/accounts";
import type { ToolDefinition } from "../tools/types";
import { CONNECTOR_CATALOG, type ConnectorCategory } from "./catalog";
import type { ComposioConnectors } from "./composio";
import { activeConnections } from "./connections";
import { isCustom } from "./custom";
import { composioToolkitUrl, MCP_PRESETS, type McpPreset, presetForServer } from "./presets";

/**
 * Brand icons the web app serves, keyed by icon name. One color, from
 * `apps/web/public/connectors` (Simple Icons, CC0, or the brand's own mark:
 * see the README there): drawn in the brand color, no color = the ink
 * (near-black, very light or many-colored brands). `own`: from
 * `apps/web/public/brands`, in its maker's colors, which one color would
 * flatten (PayPal's three blues, Canva's gradient).
 */
export const CONNECTOR_BRANDS: Record<string, { file: string; color: string | null; own?: true }> = {
  github: { file: "github", color: null },
  linear: { file: "linear", color: "#5E6AD2" },
  sentry: { file: "sentry", color: null },
  notion: { file: "notion", color: null },
  drive: { file: "googledrive", color: "#4285F4" },
  "google-docs": { file: "googledocs", color: "#4285F4" },
  "google-sheets": { file: "googlesheets", color: "#34A853" },
  "google-calendar": { file: "googlecalendar", color: "#4285F4" },
  onedrive: { file: "onedrive", color: null, own: true },
  slack: { file: "slack", color: null, own: true },
  "microsoft-teams": { file: "microsoftteams", color: null, own: true },
  hubspot: { file: "hubspot", color: "#FF7A59" },
  salesforce: { file: "salesforce", color: null, own: true },
  zendesk: { file: "zendesk", color: null },
  atlassian: { file: "atlassian", color: "#0052CC" },
  asana: { file: "asana", color: "#F06A6A" },
  stripe: { file: "stripe", color: "#635BFF" },
  supabase: { file: "supabase", color: "#3FCF8E" },
  cloudflare: { file: "cloudflare", color: "#F38020" },
  intercom: { file: "intercom", color: null },
  zapier: { file: "zapier", color: "#FF4F00" },
  webflow: { file: "webflow", color: "#146EF5" },
  square: { file: "square", color: null },
  paypal: { file: "paypal", color: null, own: true },
  canva: { file: "canva", color: null, own: true },
  gitlab: { file: "gitlab", color: "#FC6D26" },
  neon: { file: "neon", color: "#00E599" },
  prisma: { file: "prisma", color: null },
  netlify: { file: "netlify", color: "#00C7B7" },
  vercel: { file: "vercel", color: null },
  railway: { file: "railway", color: null },
  datadog: { file: "datadog", color: "#632CA6" },
  grafana: { file: "grafana", color: "#F46800" },
  postman: { file: "postman", color: "#FF6C37" },
  jam: { file: "jam", color: "#FF4063" },
  resend: { file: "resend", color: null },
  monday: { file: "monday", color: null },
  clickup: { file: "clickup", color: "#7B68EE" },
  todoist: { file: "todoist", color: "#E44332" },
  figma: { file: "figma", color: null },
  airtable: { file: "airtable", color: "#18BFFF" },
  dropbox: { file: "dropbox", color: "#0061FF" },
  miro: { file: "miro", color: null },
  gamma: { file: "gamma", color: null },
  granola: { file: "granola", color: null },
  fireflies: { file: "fireflies", color: "#DA4292" },
  mercadopago: { file: "mercadopago", color: "#00B1EA" },
  attio: { file: "attio", color: null },
  close: { file: "close", color: null },
  calendly: { file: "calendly", color: "#006BFF" },
  posthog: { file: "posthog", color: null },
  mixpanel: { file: "mixpanel", color: "#7856FF" },
  amplitude: { file: "amplitude", color: "#1E61F0" },
  himetrica: { file: "himetrica", color: "#F97015" },
  meta: { file: "meta", color: "#0467DF" },
  klaviyo: { file: "klaviyo", color: null },
  millionsend: { file: "millionsend", color: null },
  semrush: { file: "semrush", color: "#FF642D" },
  ahrefs: { file: "ahrefs", color: "#FF8800" },
  wix: { file: "wix", color: null },
  sanity: { file: "sanity", color: "#F03E2F" },
  contentful: { file: "contentful", color: "#2478CC" },
  jotform: { file: "jotform", color: "#FF6100" },
  tally: { file: "tally", color: null },
  expo: { file: "expo", color: null },
  revenuecat: { file: "revenuecat", color: "#F2545B" },
  superwall: { file: "superwall", color: null },
  paddle: { file: "paddle", color: null },
  abacatepay: { file: "abacatepay", color: "#337D63" },
  instagram: { file: "instagram", color: null },
  facebook: { file: "facebook", color: "#0866FF" },
  linkedin: { file: "linkedin", color: "#0A66C2" },
  youtube: { file: "youtube", color: "#FF0000" },
  pinterest: { file: "pinterest", color: "#BD081C" },
  reddit: { file: "reddit", color: "#FF4500" },
  whatsapp: { file: "whatsapp", color: "#25D366" },
};

export interface ConnectorListingEntry {
  id: string;
  label: string;
  description: string;
  /**
   * `catalog`: our connector with its own scopes; `remote_mcp`: a server connected by its address, in one click (the
   * vendor's MCP server, or the service through Composio, `via`).
   */
  kind: "catalog" | "remote_mcp";
  category: ConnectorCategory;
  /** How it connects. A one-click server takes a key too, except one marked `cloudOAuthOnly`, on the Cloud. */
  auth: ("oauth" | "api_key")[];
  /** Signs in with OAuth here: our OAuth app, the vendor's MCP OAuth, or Composio's. */
  oauthConfigured: boolean;
  /** Can be connected on this server (an OAuth app, an API key, or Composio). */
  available: boolean;
  /** A one-click server whose vendor hasn't approved agentes.chat yet, which Composio doesn't serve here ("Em breve"). */
  soon: boolean;
  /** Connects through Composio (its page, its OAuth app): available only with `COMPOSIO_API_KEY` (ADR 0107). */
  via?: "composio";
  /** Where it connects, by the way this server picked (a `remote_mcp` entry's address). */
  serverUrl: string;
  /** Served by the web app: `/connectors/{file}.svg` (one color) or `/brands/{file}.svg` (its own colors); null for a monogram. */
  iconUrl: string | null;
  brandColor: string | null;
  scopes: { id: string; label: string; description: string; sensitive: boolean }[];
  tools: { name: string; scope: string; sensitive: boolean }[];
}

const brand = (key: string) => {
  const b = CONNECTOR_BRANDS[key];
  return { iconUrl: b ? `/${b.own ? "brands" : "connectors"}/${b.file}.svg` : null, brandColor: b?.color ?? null };
};

/**
 * Whether this server offers our catalog connector: always, except one a one-click preset stands in for (Linear,
 * Sentry), which only with its OAuth app.
 */
export const offersCatalog = (id: string, oauthApps: Record<string, unknown> = {}) =>
  !MCP_PRESETS.some((p) => p.id === id) || Boolean(CONNECTOR_CATALOG[id]?.oauth && oauthApps[id]);

/**
 * What this server's "Adicionar conector" can connect: its OAuth apps (`connectorOAuthApps`), its mail paths and
 * Composio (null without `COMPOSIO_API_KEY`).
 */
export interface ServerCatalog {
  oauthApps: Record<string, unknown>;
  mail?: MailAdapters | null;
  composio?: ComposioConnectors | null;
  /** The agentes.chat Cloud: a one-click server marked `cloudOAuthOnly` takes no key there. */
  cloud?: boolean;
}

/**
 * The one way a preset connects here (ADR 0107 §1): the vendor's server when it connects today, else Composio when this
 * server is set up for it, else "Em breve" for a vendor that hasn't approved agentes.chat, else unavailable.
 */
function presetWay(p: McpPreset, composio: ComposioConnectors | null | undefined) {
  const viaComposio = p.composio ? composioToolkitUrl(p.composio.toolkit) : null;
  if (!p.soon && p.serverUrl !== viaComposio) return { serverUrl: p.serverUrl, available: true, soon: false };
  if (viaComposio && composio) {
    return { serverUrl: viaComposio, available: true, soon: false, via: "composio" as const };
  }
  if (p.soon) return { serverUrl: p.serverUrl, available: false, soon: true };
  return { serverUrl: p.serverUrl, available: false, soon: false, via: "composio" as const };
}

/**
 * One list for "Adicionar conector": our catalog connectors and the one-click presets, each service once. A service in
 * both (Linear, Sentry) is our connector when this server has its OAuth app, else the preset, which connects by the way
 * `presetWay` picks.
 */
export function connectorListing(server: ServerCatalog): ConnectorListingEntry[] {
  const { oauthApps } = server;
  const builtinWins = new Set<string>();
  const builtins: ConnectorListingEntry[] = [];
  for (const d of Object.values(CONNECTOR_CATALOG)) {
    if (!offersCatalog(d.id, oauthApps)) continue;
    const oauthConfigured = Boolean(d.oauth && oauthApps[d.id]);
    builtinWins.add(d.id);
    const sensitiveScopes = new Set(Object.values(d.tools).flatMap((t) => (t.sensitive ? [t.scope] : [])));
    builtins.push({
      id: d.id,
      label: d.label,
      description: d.description,
      kind: "catalog",
      category: d.category,
      auth: d.auth,
      oauthConfigured,
      available: oauthConfigured || d.auth.includes("api_key"),
      soon: false,
      serverUrl: d.serverUrl,
      ...brand(d.id),
      scopes: Object.entries(d.scopes).map(([id, s]) => ({
        id: `${d.id}:${id}`,
        label: s.label,
        description: s.description,
        sensitive: sensitiveScopes.has(id),
      })),
      tools: Object.entries(d.tools).map(([name, t]) => ({
        name,
        scope: `${d.id}:${t.scope}`,
        sensitive: t.sensitive === true,
      })),
    });
  }
  const presets = MCP_PRESETS.filter((p) => !builtinWins.has(p.id)).map((p): ConnectorListingEntry => {
    const way = presetWay(p, server.composio);
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      kind: "remote_mcp",
      category: p.category,
      // A service through Composio signs in there; a vendor's own server takes a key too.
      auth: way.via === "composio" || (p.cloudOAuthOnly && server.cloud) ? ["oauth"] : ["oauth", "api_key"],
      oauthConfigured: true,
      ...way,
      ...brand(p.icon),
      scopes: [],
      tools: [],
    };
  });
  return [...builtins, ...presets];
}

/** A connector of "Adicionar conector" the agent has no tool of, as `find_tools` names it (ADR 0043). */
export interface MissingConnector {
  label: string;
  description: string;
  /** What names it in a search: its label and its ids (`drive`). */
  names: string[];
  /**
   * `unavailable`: this server can't connect it; `soon`: its vendor hasn't approved agentes.chat yet (a `soon`
   * preset); `not_connected`: the workspace hasn't; `not_given`: the agent lacks it; `needs_reconnect`: a mailbox or
   * a Composio account of it stopped working.
   */
  state: "unavailable" | "soon" | "not_connected" | "not_given" | "needs_reconnect";
  /** The workspace's working connections and mailboxes of it. */
  connectionIds: string[];
}

/** A connector of "Adicionar conector" as this agent stands with it: `usable`, it has tools of it. */
export type ConnectorState = Omit<MissingConnector, "state"> & { state: MissingConnector["state"] | "usable" };

/** The mailboxes "Adicionar conector" offers, by the rule of `mailChoices` (apps/web/src/components/MailConnect.tsx). */
const MAILBOXES: {
  label: string;
  description: string;
  /** Words besides its label that name it in a search. */
  names?: string[];
  offered: (mail: ReturnType<typeof mailProviders>) => boolean;
  holds: (account: MailAccountRow) => boolean;
}[] = [
  {
    label: "Gmail",
    description: "Read, organize and answer Gmail email.",
    offered: (m) => m.composio,
    holds: (a) => a.provider === "gmail",
  },
  {
    label: "Outlook",
    description: "Outlook and Microsoft 365 email.",
    offered: (m) => m.composio,
    holds: (a) => a.provider === "outlook",
  },
  {
    label: "iCloud",
    description: "iCloud email, custom domains included.",
    offered: (m) => m.imap && m.presets.some((p) => p.id === "icloud"),
    holds: (a) => a.preset === "icloud",
  },
  {
    label: "Email",
    description: "A mailbox: Gmail, Outlook, iCloud or another provider.",
    names: ["mail", "mailbox", "inbox"],
    offered: (m) => m.composio || m.imap,
    holds: () => true,
  },
];

type Tools = Iterable<Pick<ToolDefinition, "connectionId">>;

/** The connectors the agent has no tool of, and why (`connectorStates`). */
export async function missingConnectors(
  db: Database,
  orgId: string,
  catalog: ServerCatalog,
  tools: { usable: Tools; listed: Tools },
): Promise<MissingConnector[]> {
  const states = await connectorStates(db, orgId, catalog, tools);
  return states.filter((c): c is MissingConnector => c.state !== "usable");
}

/**
 * The connectors of "Adicionar conector" (`connectorListing` and the mailboxes) and how the agent stands with each.
 * `usable`: the agent's tools; `listed`: every tool this server lists for the workspace. Names and states only:
 * never a connection's account, address or key.
 */
export async function connectorStates(
  db: Database,
  orgId: string,
  catalog: ServerCatalog,
  tools: { usable: Tools; listed: Tools },
): Promise<ConnectorState[]> {
  const [connections, mailboxes] = await Promise.all([activeConnections(db, orgId), orgMailAccounts(db, orgId)]);
  const services = new Map<
    string,
    {
      label: string;
      description: string;
      names: Set<string>;
      offered: boolean;
      soon: boolean;
      held: string[];
      reconnect: boolean;
    }
  >();
  const service = (label: string, description: string) => {
    const key = label.toLowerCase();
    const found = services.get(key) ?? {
      label,
      description,
      names: new Set([label]),
      offered: false,
      soon: false,
      held: [],
      reconnect: false,
    };
    services.set(key, found);
    return found;
  };
  for (const entry of connectorListing(catalog)) {
    const s = service(entry.label, entry.description);
    s.names.add(entry.id);
    s.offered ||= entry.available;
    s.soon ||= entry.soon;
  }
  const mail = mailProviders(catalog.mail);
  for (const m of MAILBOXES) {
    const s = service(m.label, m.description);
    for (const name of m.names ?? []) s.names.add(name);
    s.offered ||= m.offered(mail);
    const own = mailboxes.filter(m.holds);
    s.held.push(...own.filter(usableAccount).map((a) => a.id));
    // Connecting the same mailbox again fails as already connected: only Reconnect on its row brings it back.
    s.reconnect ||= own.some((a) => a.status === "needs_reconnect");
  }
  // A server connected by address is its preset's service, or the one it was named after (a mailbox's too).
  for (const c of connections) {
    const label = isCustom(c)
      ? (presetForServer(c.serverUrl)?.label ?? c.label)
      : (CONNECTOR_CATALOG[c.connector]?.label ?? c.label);
    const s = services.get(label.toLowerCase());
    if (!s) continue;
    // A sign-in that stopped working (a Composio account too) has no tools until Reconectar.
    if (c.status === "needs_reconnect") s.reconnect = true;
    else s.held.push(c.id);
  }
  const ids = (list: Tools) => new Set([...list].map((t) => t.connectionId));
  const [usable, listed] = [ids(tools.usable), ids(tools.listed)];
  return [...services.values()].flatMap((s): ConnectorState[] => {
    let state: ConnectorState["state"];
    if (s.held.some((id) => usable.has(id))) state = "usable";
    else if (s.held.some((id) => listed.has(id))) state = "not_given";
    else if (s.reconnect) state = "needs_reconnect";
    // Connected, but no tool of it listed (server down, not reviewed yet): nothing says the agent lacks it.
    else if (s.held.length > 0) return [];
    else state = s.offered ? "not_connected" : s.soon ? "soon" : "unavailable";
    return [{ label: s.label, description: s.description, names: [...s.names], state, connectionIds: s.held }];
  });
}
