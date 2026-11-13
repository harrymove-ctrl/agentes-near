import { describe, expect, test } from "bun:test";
import { scopeGroups, scopeSummary } from "@agenteschat/client/lib/scopes";
import type { TFunction } from "i18next";
import { approvalAction } from "@/components/ApprovalItem";
import { createI18n } from "@/i18n";
import { budgetAlert } from "@/realtime/context";
import { CATALOG, seedState } from "./fake-api";

const i18n = createI18n("pt-BR");
const t = i18n.t.bind(i18n) as TFunction;
const state = seedState();
const groups = scopeGroups(t, CATALOG, state.connections, { name: "agentes", note: "permissões embutidas" });

describe("agent permissions model", () => {
  test("built-in scopes, then one group per active connection; labels in pt-BR", () => {
    expect(groups.map((g) => g.name)).toEqual(["agentes", "GitHub"]);
    expect(groups[1]?.note).toBe("acme");
    expect(groups[1]?.scopes.map((s) => s.label)).toEqual([
      "Ler código",
      "Ler PRs",
      "Abrir e comentar PRs",
      "Fazer merge",
    ]);
    expect(groups[1]?.scopes[3]).toMatchObject({
      sensitive: true,
      grant: { connectionId: "conn-gh", scope: "github:pr.merge" },
    });
  });

  test("a custom MCP server shows up with its read and write scopes", () => {
    const server = {
      id: "conn-mcp",
      serverUrl: "https://app.himetrica.com/api/v1/mcp",
      label: "himetrica",
      authType: "oauth" as const,
      tools: [],
      reviewedAt: "2026-10-14T00:00:00Z",
      createdAt: "2026-10-14T00:00:00Z",
    };
    const g = scopeGroups(t, CATALOG, [], { name: "agentes", note: "" }, [
      server,
      { ...server, id: "x", reviewedAt: null },
    ]);
    expect(g.map((x) => x.name)).toEqual(["agentes", "himetrica"]);
    expect(g[1]?.scopes.map((s) => s.grant)).toEqual([
      { connectionId: "conn-mcp", scope: "custom:conn-mcp:read" },
      { connectionId: "conn-mcp", scope: "custom:conn-mcp:write" },
    ]);
    expect(g[1]?.scopes[1]?.sensitive).toBe(true);
  });

  test("summary counts and approval-gated scopes", () => {
    const summary = scopeSummary(groups, state.scopes[Object.keys(state.scopes)[0] ?? ""] ?? [], "Nenhuma permissão");
    expect(summary).toMatchObject({ total: 7, granted: 4, connectors: 1 });
    expect(summary.rows[1]).toEqual({ id: "conn-gh", name: "GitHub", granted: "ler código", gated: ["fazer merge"] });
  });

  test("approve button verb from the tool/scope; budget alert copy", () => {
    expect(approvalAction({ tool: "merge_pull_request", scope: "github:pr.merge" })).toBe("merge");
    expect(approvalAction({ tool: "run_workflow", scope: "github:actions.run" })).toBe("deploy");
    expect(approvalAction({ tool: "onedrive_create_share_link", scope: "custom:c1:write" })).toBe("publish");
    expect(approvalAction({ tool: "x", scope: "y" })).toBe("other");
    expect(budgetAlert(t, "pt-BR", { type: "budget.warning", agentId: "a", percent: 80.4 }, "Ada")).toBe(
      "Ada usou 80% do orçamento do mês.",
    );
    // It pauses until the budget renews next month (the date depends on today) or an admin raises the limit.
    expect(budgetAlert(t, "pt-BR", { type: "budget.exhausted", agentId: "a", percent: 100 }, "Ada")).toMatch(
      /^Ada atingiu o orçamento do mês e pausou\. Continua .+ ou quando um admin aumentar o limite\.$/,
    );
  });
});
