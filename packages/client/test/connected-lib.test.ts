import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { Connection, ConnectorDef, CustomServer } from "../src/api/types";
import { composioOffText, composioUsageText, hiddenWithoutComposio, nearComposioLimit } from "../src/lib/composio";
import {
  accountUnchecked,
  appConnector,
  connectedItems,
  fromConnection,
  isMcpItem,
  itemName,
  outcomeText,
  reconnectAddsText,
} from "../src/lib/connected";

/** The app's words for the keys these tests need; any other key comes back with its values. */
const WORDS: Record<string, string> = { "connectors.names.atlassian": "Atlassian (Jira e Confluence)" };
const t = ((key: string, o?: Record<string, unknown>) =>
  WORDS[key] ??
  (typeof o?.defaultValue === "string" ? o.defaultValue : `${key} ${JSON.stringify(o ?? {})}`)) as unknown as TFunction;

const remote = (id: string, label: string, serverUrl: string): ConnectorDef => ({
  id,
  label,
  description: "",
  kind: "remote_mcp",
  category: "payments",
  auth: ["oauth"],
  oauthConfigured: true,
  available: true,
  serverUrl,
  iconUrl: null,
  brandColor: null,
  scopes: [],
  tools: [],
});
const STRIPE = remote("stripe", "Stripe", "https://mcp.stripe.com");
const ATLASSIAN = remote("atlassian", "Atlassian", "https://mcp.atlassian.com/v1/mcp");
const GITHUB: ConnectorDef = { ...remote("github", "GitHub", "https://api.githubcopilot.com/mcp/"), kind: "catalog" };

let n = 0;
const server = (
  label: string,
  accountLabel: string | null = null,
  serverUrl = "https://mcp.stripe.com/",
): CustomServer => ({
  id: `s-${++n}`,
  serverUrl,
  label,
  accountLabel,
  authType: "oauth",
  tools: [],
  reviewedAt: "2026-10-30T12:00:00.000Z",
  createdAt: `2026-10-30T12:00:0${n}.000Z`,
});
const connection = (label: string, accountLabel: string | null): Connection => ({
  id: "c-gh",
  connector: "github",
  label,
  serverUrl: "https://api.githubcopilot.com/mcp/",
  authType: "oauth",
  accountLabel,
  tokenExpiresAt: null,
  createdAt: "2026-10-29T12:00:00.000Z",
  revokedAt: null,
});

describe("connected accounts", () => {
  test("accounts of one service read apart; a name nobody changed is the catalog's, in the app's language", () => {
    const items = connectedItems(
      [connection("GitHub", "acme")],
      [
        server("Stripe"),
        server("Stripe (Acme)", "Acme"),
        server("Stripe 2"),
        server("Loja", "Acme B"),
        server("Atlassian (Jira e Confluence)", null, "https://mcp.atlassian.com/v1/mcp"),
        server("Atlassian 2", null, "https://mcp.atlassian.com/v1/mcp"),
      ],
      [GITHUB, STRIPE, ATLASSIAN],
    );
    expect(items.map((i) => itemName(t, i))).toEqual([
      "GitHub",
      "Stripe",
      "Stripe (Acme)",
      "Stripe 2",
      "Loja",
      "Atlassian (Jira e Confluence)",
      // A later account nobody renamed: the catalog's name too, with its number.
      "Atlassian (Jira e Confluence) 2",
    ]);
    // "Conectado como": the account when the name doesn't already say it, else a server's host.
    expect(items.map((i) => i.account)).toEqual([
      "acme",
      "mcp.stripe.com",
      null,
      "mcp.stripe.com",
      "Acme B",
      "mcp.atlassian.com",
      "mcp.atlassian.com",
    ]);
    // A renamed catalog connection goes by its own name.
    expect(
      itemName(t, connectedItems([connection("GitHub Acme", null)], [], [GITHUB])[0] ?? { def: null, label: "" }),
    ).toBe("GitHub Acme");
  });

  test("a work log's app is its catalog entry, a numbered or provider-named account too", () => {
    const readOnly = remote("supabase-readonly", "Supabase (read-only)", "https://mcp.supabase.com/mcp?read_only=true");
    const catalog = [GITHUB, STRIPE, ATLASSIAN, readOnly];
    expect(
      ["GitHub", "Stripe (Acme)", "Stripe (Acme) 2", "Atlassian (Jira e Confluence)", "Supabase (read-only) 2"].map(
        (app) => appConnector(catalog, app)?.id,
      ),
    ).toEqual(["github", "stripe", "stripe", "atlassian", "supabase-readonly"]);
    expect(appConnector(catalog, "Tickets")).toBeNull();
  });

  test("what a connect did, as a toast", () => {
    const [plain, named] = connectedItems([], [server("Stripe 2"), server("Stripe (Acme)", "Acme")], [STRIPE]);
    if (!plain || !named) throw new Error("no items");
    expect(outcomeText(t, "connected", plain)).toBe('connectors.connectedToast {"name":"Stripe 2"}');
    expect(outcomeText(t, "reconnected", named)).toBe('connectors.outcome.reconnected {"name":"Stripe (Acme)"}');
    expect(outcomeText(t, "same_account", named)).toBe(
      'connectors.outcome.sameAccount {"name":"Stripe (Acme)","service":"Stripe"}',
    );
    expect(outcomeText(t, "same_account", plain)).toBe('connectors.outcome.already {"name":"Stripe 2"}');
  });
});

describe("services through Composio (ADR 0107)", () => {
  const DRIVE_URL = "https://backend.composio.dev/api/v3.1/toolkits/googledrive";
  const drive = (available: boolean): ConnectorDef => ({
    ...remote("drive", "Google Drive", DRIVE_URL),
    category: "docs",
    available,
    via: "composio",
  });

  test("an account shows no address, only its own name when known; one that stopped working says so", () => {
    const items = connectedItems(
      [],
      [
        { ...server("Google Drive (ana@acme.com)", "ana@acme.com", DRIVE_URL), via: "composio" },
        { ...server("Google Drive 2", null, DRIVE_URL), via: "composio" },
        { ...server("Google Drive 3", null, DRIVE_URL), via: "composio", status: "needs_reconnect" },
      ],
      [drive(true)],
    );
    const [named, plain, broken] = ["Google Drive (ana@acme.com)", "Google Drive 2", "Google Drive 3"].map((label) =>
      items.find((i) => i.label === label),
    );
    expect([named?.account, plain?.account, broken?.account]).toEqual([null, null, null]);
    expect([named?.def?.id, named?.viaComposio, named?.needsReconnect]).toEqual(["drive", true, false]);
    expect(broken?.needsReconnect).toBe(true);
    // Any other server still shows its host.
    expect(connectedItems([], [server("Stripe")], [STRIPE])[0]?.viaComposio).toBe(false);
  });

  test("without Composio its services are hidden, and admins read which and how many in one line", () => {
    const hidden = (id: string, label: string) => ({ ...drive(false), id, label });
    const catalog = [
      STRIPE,
      hidden("hubspot", "HubSpot"),
      hidden("slack", "Slack"),
      drive(false),
      { ...remote("asana", "Asana", "https://mcp.asana.com/mcp"), available: false, soon: true },
    ];
    expect(catalog.filter(hiddenWithoutComposio).map((d) => d.id)).toEqual(["hubspot", "slack", "drive"]);
    expect(composioOffText(t, catalog, ["drive", "slack"])).toBe(
      'connectors.composio.off {"names":"Google Drive, Slack","count":1}',
    );
    // Composio connects here: nothing to say.
    expect(composioOffText(t, [...catalog, { ...drive(true), id: "google-docs" }], [])).toBeNull();
  });

  test("Uso's line, and the warning past 80% of the month's cap", () => {
    const tt = ((key: string, o?: Record<string, unknown>) => `${key} ${JSON.stringify(o)}`) as unknown as TFunction;
    expect(composioUsageText(tt, "pt-BR", { calls: 1234, limit: 5000, month: "2026-11" })).toBe(
      'connectors.composio.usage {"calls":"1.234","month":"novembro","limit":"5.000"}',
    );
    expect(composioUsageText(tt, "en", { calls: 12, limit: null, month: "2026-11" })).toBe(
      'connectors.composio.usageNoLimit {"calls":"12","month":"November"}',
    );
    expect(nearComposioLimit({ calls: 3999, limit: 5000, month: "2026-11" })).toBe(false);
    expect(nearComposioLimit({ calls: 4000, limit: 5000, month: "2026-11" })).toBe(true);
    expect(nearComposioLimit({ calls: 9000, limit: null, month: "2026-11" })).toBe(false);
  });
});

test("a server whose provider named none of its accounts can't be checked; one named account means it can", () => {
  expect(accountUnchecked([])).toBe(true);
  expect(accountUnchecked([{ accountLabel: null }, undefined])).toBe(true);
  expect(accountUnchecked([{ accountLabel: null }, { accountLabel: "Acme" }])).toBe(false);
});

test("an MCP is a server by address the catalog doesn't list; a one-click server, Composio's and ours are connectors", () => {
  const item = (custom: boolean, def: boolean, viaComposio = false) => ({
    custom,
    def: def ? ({ id: "x" } as ConnectorDef) : null,
    viaComposio,
  });
  expect(isMcpItem(item(true, false))).toBe(true);
  expect(isMcpItem(item(true, true))).toBe(false);
  expect(isMcpItem(item(true, false, true))).toBe(false);
  expect(isMcpItem(item(false, true))).toBe(false);
});

describe("what Reconectar adds", () => {
  test("a sign-in without the scopes the connector asks for now says what reconnecting lets agents do", () => {
    const words = ((key: string, o?: Record<string, unknown>) =>
      key === "connectors.adds.github_project"
        ? "usar o GitHub Projects"
        : `${key} ${JSON.stringify(o ?? {})}`) as unknown as TFunction;
    const old = fromConnection({ ...connection("GitHub", null), reconnectAdds: ["project"] }, [GITHUB]);
    expect(reconnectAddsText(words, old)).toBe(
      'connectors.reconnectAdds {"name":"GitHub","what":"usar o GitHub Projects"}',
    );
    expect(reconnectAddsText(words, fromConnection(connection("GitHub", null), [GITHUB]))).toBeNull();
  });
});
