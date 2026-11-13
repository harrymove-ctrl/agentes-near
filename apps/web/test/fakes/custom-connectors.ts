/**
 * Test fake — custom MCP servers ("Outro servidor MCP" in "Adicionar conector").
 * Mirrors these endpoints:
 * - GET    /api/app/organizations/{orgId}/connectors/custom
 * - POST   /api/app/organizations/{orgId}/connectors/custom { serverUrl, apiKey?, label?, returnTo, connectionId? }
 *          → { status: "connected", server, outcome } | { status: "oauth", authorizeUrl } | { status: "needs_key" }
 *          (the same address again is another account, "Name 2", which no agent uses; `connectionId`
 *          reconnects that account in place)
 * - POST   /api/app/organizations/{orgId}/connectors/custom/{id}/refresh (re-list tools)
 * - PUT    /api/app/organizations/{orgId}/connectors/custom/{id}/tools { label, tools: [{ name, access, label, confirmed? }] }
 *          (`access`: read | write | approval | off; sensitive tools only approval | off)
 * - DELETE /api/app/organizations/{orgId}/connectors/custom/{id}
 * The mock never talks to the URL: it pretends the server offers a ticket
 * tool set, needs an API key unless the URL contains "oauth", and gains one
 * new tool on the first refresh. Tools come classified as the backend does
 * (annotations, the verb; `close_ticket` is ambiguous: the judge suggests
 * "write" and it waits for a decision; `delete_customer` is sensitive).
 */
import type { ApiClient, CustomServer, CustomTool, ToolAccess } from "@agenteschat/client";
import { partsOf } from "@agenteschat/client/lib/tool-review";
import { clone, type MockContext, MockNotFoundError, mockId } from "./context";

const TOOLS: [name: string, description: string, readOnly: boolean | null][] = [
  ["list_tickets", "List support tickets, filtered by status or customer.", true],
  ["get_ticket", "Read one ticket with its messages.", true],
  ["create_ticket", "Open a new ticket for a customer.", false],
  ["close_ticket", "Close a ticket with a resolution note.", null],
  ["delete_customer", "Permanently delete a customer and their data.", false],
];
const LATER: [string, string, boolean | null] = ["export_tickets", "Export tickets as CSV.", true];

/** How the backend classifies each (classify.ts): level, source, reason, sensitive. */
const CLASS: Record<string, [ToolAccess, NonNullable<CustomTool["suggestionSource"]>, string, boolean]> = {
  list_tickets: ["read", "annotation", "read_only_hint", false],
  get_ticket: ["read", "annotation", "read_only_hint", false],
  create_ticket: ["write", "verb", "verb_write", false],
  close_ticket: ["write", "judge", "changes_undoable", false],
  delete_customer: ["approval", "verb", "verb_sensitive", true],
  export_tickets: ["read", "annotation", "read_only_hint", false],
};

const tool = ([name, description, readOnly]: [string, string, boolean | null], now: Date): CustomTool => {
  const [level, source, reason, sensitive] = CLASS[name] ?? ["approval", "judge_failed", "unknown", false];
  const { subject, ...nameParts } = partsOf(name);
  return {
    name,
    description,
    readOnlyHint: readOnly,
    suggestedAccess: level,
    access: null,
    level,
    suggestionSource: source,
    suggestionReason: reason,
    sensitive,
    pending: source === "judge" || source === "judge_failed",
    off: false,
    nameParts,
    subject,
    label: "",
    firstSeenAt: now.toISOString(),
  };
};

export function createMockCustomConnectors(
  ctx: MockContext,
  log: (method: string, ...args: unknown[]) => void = () => {},
  /** An account connected (the backend gives it to every agent). */
  onConnected: (orgId: string, serverId: string) => Promise<void> = async () => {},
): ApiClient["customConnectors"] & {
  rename(orgId: string, id: string, label: string): CustomServer | null;
} {
  const byOrg = new Map<string, CustomServer[]>();
  const refreshed = new Set<string>();
  const list = (orgId: string) => {
    let l = byOrg.get(orgId);
    if (!l) {
      l = [];
      byOrg.set(orgId, l);
    }
    return l;
  };
  const find = (orgId: string, id: string) => {
    const s = list(orgId).find((x) => x.id === id);
    if (!s) throw new MockNotFoundError("Server not found");
    return s;
  };
  return {
    list: async (orgId) => clone(list(orgId)),
    connect: async (orgId, input) => {
      log("customConnectors.connect", orgId, { ...input, apiKey: input.apiKey ? "[redacted]" : undefined });
      // Through Composio: its page signs in, back to the callback.
      if (input.serverUrl.startsWith("https://backend.composio.dev/")) {
        return { status: "oauth", authorizeUrl: "https://composio.example/connect/ca_1?state=s" };
      }
      const oauth = input.serverUrl.includes("oauth");
      if (!oauth && !input.apiKey) return { status: "needs_key" };
      if (input.connectionId) {
        return { status: "connected", server: clone(find(orgId, input.connectionId)), outcome: "reconnected" };
      }
      const now = ctx.now();
      const base = input.label?.trim() || new URL(input.serverUrl).hostname;
      const taken = new Set(list(orgId).map((s) => s.label.toLowerCase()));
      let label = base;
      for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${base} ${n}`;
      const server: CustomServer = {
        id: mockId("mcp"),
        serverUrl: input.serverUrl,
        label,
        accountLabel: null,
        authType: oauth ? "oauth" : "api_key",
        tools: TOOLS.map((t) => tool(t, now)),
        reviewedAt: null,
        createdAt: now.toISOString(),
      };
      list(orgId).push(server);
      await onConnected(orgId, server.id);
      // A real OAuth flow leaves for the provider; the mock connects at once.
      return { status: "connected", server: clone(server), outcome: "connected" };
    },
    rename: (orgId, id, label) => {
      const s = list(orgId).find((x) => x.id === id);
      if (s) s.label = label;
      return s ? clone(s) : null;
    },
    refresh: async (orgId, id) => {
      log("customConnectors.refresh", orgId, id);
      const s = find(orgId, id);
      if (!refreshed.has(id)) {
        refreshed.add(id);
        s.tools.push(tool(LATER, ctx.now()));
      }
      return clone(s);
    },
    saveTools: async (orgId, id, input) => {
      log("customConnectors.saveTools", orgId, id, structuredClone(input));
      const s = find(orgId, id);
      s.label = input.label;
      for (const t of input.tools) {
        const existing = s.tools.find((x) => x.name === t.name);
        if (existing) {
          if (existing.sensitive && (t.access === "read" || t.access === "write")) {
            throw new Error(`${t.name} is sensitive: it can only ask for approval or be off`);
          }
          existing.access = t.access;
          existing.level = t.access;
          existing.off = t.access === "off";
          existing.label = t.label;
          if (t.confirmed !== false) existing.pending = false;
        }
      }
      s.reviewedAt = ctx.now().toISOString();
      return clone(s);
    },
    disconnect: async (orgId, id) => {
      log("customConnectors.disconnect", orgId, id);
      byOrg.set(
        orgId,
        list(orgId).filter((x) => x.id !== id),
      );
    },
  };
}
