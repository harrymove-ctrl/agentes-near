import { describe, expect, test } from "bun:test";
import type { AgentAccess, Connection, CustomServer, ToolDecision } from "@agenteschat/client";
import {
  catalogToolClass,
  inputFromAccess,
  inputWithLevels,
  levelIn,
  resourcesOf,
} from "@agenteschat/client/lib/access-levels";
import { connectedIds, connectedItems } from "@agenteschat/client/lib/connected";
import {
  decisionsOf,
  defaultAccess,
  draftFrom,
  exposedTools,
  humanize,
  toolsToReview,
} from "@agenteschat/client/lib/custom-tools";
import { connectorName } from "@agenteschat/client/lib/scopes";
import { createI18n } from "@/i18n";
import { CATALOG } from "./fake-api";

const server = (reviewedAt: string | null, accesses: (ToolDecision | null)[]): CustomServer => ({
  id: "s",
  serverUrl: "https://mcp.example.com",
  label: "Suporte",
  authType: "api_key",
  reviewedAt,
  createdAt: "2026-10-01T00:00:00Z",
  tools: accesses.map((access, i) => ({
    name: `tool_${i}`,
    description: "",
    readOnlyHint: i === 0 ? true : null,
    suggestedAccess: i === 1 ? "write" : null,
    access,
    label: "",
    firstSeenAt: "",
  })),
});

describe("what a custom server's tools do", () => {
  test("undecided tools start with the suggestion (else read-only → Lê, the rest asks for approval)", () => {
    expect(defaultAccess({ readOnlyHint: true })).toBe("read");
    expect(defaultAccess({ readOnlyHint: null })).toBe("approval");
    const drafts = draftFrom(server(null, [null, null, null]));
    expect(drafts.map((d) => [d.access, d.on, d.label])).toEqual([
      ["read", true, "Tool 0"],
      ["write", true, "Tool 1"],
      ["approval", true, "Tool 2"],
    ]);
    expect(humanize("list_tickets")).toBe("List tickets");
  });

  test("off is a decision: kept off, not offered, not waiting for review; saved as `off`", () => {
    const s = server("2026-10-14", ["read", "off", null]);
    const drafts = draftFrom(s);
    expect(drafts.map((d) => [d.on, d.isNew])).toEqual([
      [true, false],
      [false, false],
      [true, true],
    ]);
    expect(toolsToReview(s)).toBe(1);
    expect(exposedTools(s).map((t) => t.name)).toEqual(["tool_0"]);
    expect(exposedTools(server(null, ["read"]))).toEqual([]);
    expect(decisionsOf(drafts).map((d) => d.access)).toEqual(["read", "off", "approval"]);
  });
});

const conn = (id: string, connector: string): Connection => ({
  id,
  connector,
  label: connector,
  serverUrl: "",
  authType: "oauth",
  accountLabel: "acme",
  tokenExpiresAt: null,
  createdAt: "2026-10-02T00:00:00Z",
  revokedAt: null,
});

describe("Conectados: one row per connection, whatever its kind", () => {
  test("catalog connections and servers by address; a preset is known by its address", () => {
    const zapier = {
      ...server("2026-10-14", ["read", null]),
      id: "z",
      serverUrl: "https://oauth.zapier.example/mcp/",
      createdAt: "2026-10-03T00:00:00Z",
    };
    const items = connectedItems([conn("c1", "github")], [server(null, [null]), zapier], CATALOG.connectors);
    expect(items.map((i) => [i.id, i.custom, i.def?.id ?? null, i.tools, i.pending, i.needsReview])).toEqual([
      ["s", true, null, 0, 1, true],
      ["c1", false, "github", 3, 0, false],
      ["z", true, "zapier", 1, 1, true],
    ]);
    expect(items[2]?.account).toBe("oauth.zapier.example");
    expect([...connectedIds(items)].sort()).toEqual(["github", "zapier"]);
  });
});

/** The access tree of an agent with GitHub (conn-gh) and a custom server (s1). */
const tree = (patch: (a: AgentAccess) => void = () => {}): AgentAccess => {
  const a: AgentAccess = {
    all: false,
    builtins: [
      {
        scope: "memory:write",
        label: "Lembrar",
        state: "granted",
        tools: [{ ...t("remember", "memory:write", null), state: "granted" }],
      },
      {
        scope: "",
        label: "Perguntar",
        state: "inherited",
        tools: [{ ...t("ask_user", "", null), state: "inherited" }],
      },
    ],
    connectors: [
      {
        connectionId: "conn-gh",
        connector: "github",
        label: "GitHub",
        custom: false,
        state: "off",
        scopes: [
          {
            scope: "github:repo.read",
            label: "Ler código",
            state: "off",
            tools: [t("github_get_file", "github:repo.read", "conn-gh", true)],
          },
          {
            scope: "github:pr.merge",
            label: "Merge",
            state: "off",
            tools: [t("github_merge", "github:pr.merge", "conn-gh")],
          },
        ],
      },
      {
        connectionId: "s1",
        connector: "custom:s1",
        label: "Suporte",
        custom: true,
        state: "off",
        scopes: [
          {
            scope: "custom:s1:read",
            label: "Leitura",
            state: "off",
            tools: [t("suporte_list", "custom:s1:read", "s1", true)],
          },
        ],
      },
    ],
  };
  patch(a);
  return a;
};
function t(name: string, scope: string, connectionId: string | null, readOnly = false) {
  return { name, label: name, description: "", readOnly, connectionId, scope, sensitive: false, state: "off" as const };
}

describe("one level per agent and connection", () => {
  test("the level comes from the tree: the connection whole = write; only reads = read", () => {
    expect(levelIn(tree(), "connector:conn-gh")).toBe("none");
    expect(levelIn(undefined, "connector:conn-gh")).toBe("none");
    const whole = tree((a) => {
      const gh = a.connectors[0];
      if (gh) {
        gh.state = "granted";
        for (const s of gh.scopes) for (const x of s.tools) x.state = "inherited";
      }
    });
    expect(levelIn(whole, "connector:conn-gh")).toBe("write");
    const reads = tree((a) => {
      const s = a.connectors[0]?.scopes[0];
      if (s) {
        s.state = "granted";
        for (const x of s.tools) x.state = "inherited";
      }
    });
    expect(levelIn(reads, "connector:conn-gh")).toBe("read");
    // A server with only read tools: "Ler" unless the whole connection is granted.
    const serverRead = tree((a) => {
      for (const x of a.connectors[1]?.scopes[0]?.tools ?? []) x.state = "inherited";
    });
    expect(levelIn(serverRead, "connector:s1")).toBe("read");
    const serverWhole = tree((a) => {
      const s1 = a.connectors[1];
      if (s1) s1.state = "granted";
      for (const x of s1?.scopes[0]?.tools ?? []) x.state = "inherited";
    });
    expect(levelIn(serverWhole, "connector:s1")).toBe("write");
  });

  test("read scopes: a catalog connector's *.read scopes, a custom server's own read scope", () => {
    const [github, server] = resourcesOf(tree());
    expect(github?.readScopes).toEqual(["github:repo.read"]);
    expect(server?.readScopes).toEqual(["custom:s1:read"]);
  });

  test("setting a level keeps every other grant (built-ins, other connections)", () => {
    const access = tree((a) => {
      const s1 = a.connectors[1];
      if (s1) s1.state = "granted";
      const merge = a.connectors[0]?.scopes[1]?.tools[0];
      if (merge) merge.state = "denied";
    });
    expect(inputFromAccess(access)).toEqual({
      all: false,
      connectors: { s1: true },
      scopes: [{ connectionId: null, scope: "memory:write" }],
      tools: { allow: [], deny: [{ connectionId: "conn-gh", name: "github_merge" }] },
    });
    const raw = [
      { connectionId: "gone", scope: "github:repo.read" },
      { connectionId: "s1", scope: "connector:*" },
    ];
    const read = inputWithLevels(access, raw, { "connector:conn-gh": "read" });
    expect(read.connectors).toEqual({ s1: true });
    expect(read.scopes).toEqual([
      { connectionId: null, scope: "memory:write" },
      { connectionId: "conn-gh", scope: "github:repo.read" },
    ]);
    // A level says it all: the connection's own denials go with it.
    expect(read.tools.deny).toEqual([]);
    const none = inputWithLevels(access, [], { "connector:s1": "none" });
    expect(none.connectors).toEqual({});
    expect(none.tools.deny).toEqual([{ connectionId: "conn-gh", name: "github_merge" }]);
    const write = inputWithLevels(access, [], { "connector:conn-gh": "write" });
    expect(write.connectors).toEqual({ s1: true, "conn-gh": true });
    expect(write.scopes.some((s) => s.connectionId === "conn-gh")).toBe(false);
  });

  test("a built-in scope without tools shows no level, and saving another level keeps its grant", () => {
    const access = tree((a) => {
      a.builtins.push({ scope: "desktop:use", label: "Use its desktop", state: "granted", tools: [] });
    });
    expect(resourcesOf(access).some((r) => r.area === "desktop")).toBe(false);
    expect(inputWithLevels(access, [], { "connector:conn-gh": "read" }).scopes).toContainEqual({
      connectionId: null,
      scope: "desktop:use",
    });
  });

  test("our tools by scope: sensitive ones always ask, *.read only reads", () => {
    expect(catalogToolClass({ scope: "github:pr.merge", sensitive: true })).toBe("approval");
    expect(catalogToolClass({ scope: "github:repo.read", sensitive: false })).toBe("read");
    expect(catalogToolClass({ scope: "github:pr.write", sensitive: false })).toBe("write");
  });
});

describe("connector names", () => {
  test("the server sends the brand; what a variant is comes from the app's language", () => {
    const tOf = (lng: "en" | "pt-BR") => {
      const i18n = createI18n(lng);
      return i18n.t.bind(i18n);
    };
    const def = { id: "supabase-readonly", label: "Supabase" };
    expect(connectorName(tOf("pt-BR"), def)).toBe("Supabase (somente leitura)");
    expect(connectorName(tOf("en"), def)).toBe("Supabase (read-only)");
    // No translation: the brand as is.
    expect(connectorName(tOf("en"), { id: "stripe", label: "Stripe" })).toBe("Stripe");
  });
});
