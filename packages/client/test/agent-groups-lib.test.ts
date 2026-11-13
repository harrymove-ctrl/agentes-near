import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { ApiError } from "../src/api/http";
import { createHttpApi } from "../src/api/http-client";
import { keys } from "../src/api/keys";
import type { AgentGroup } from "../src/api/types";
import { agentSections, groupOf, moveInGroups } from "../src/lib/agent-groups";
import { knownErrorText } from "../src/lib/errors";
import { applyWorkspaceEvent } from "../src/realtime/machines";

const groups: AgentGroup[] = [
  { id: "g1", name: "Integrations", agentIds: ["c", "a"] },
  { id: "g2", name: "Produto", agentIds: [] },
];
const agents = ["a", "b", "c", "d"].map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((a) => a.id);

describe("agent groups (ADR 0083)", () => {
  test("sections: each group in order with its agents in the group's order; the rest as they came", () => {
    const s = agentSections(agents, groups, (a) => a.id);
    expect(ids(s.ungrouped)).toEqual(["b", "d"]);
    expect(s.groups.map((g) => [g.group.name, ids(g.items)])).toEqual([
      ["Integrations", ["c", "a"]],
      ["Produto", []],
    ]);
    // An agent the list doesn't have (archived, not loaded) is skipped; no groups: everyone as they came.
    expect(ids(agentSections([{ id: "a" }], groups, (a) => a.id).groups[0]?.items ?? [])).toEqual(["a"]);
    expect(ids(agentSections(agents, undefined, (a) => a.id).ungrouped)).toEqual(["a", "b", "c", "d"]);
    expect(groupOf(groups, "a")?.id).toBe("g1");
    expect(groupOf(groups, "b")).toBeUndefined();
  });

  test("a move, as the server does it: a place in the group, another group, out of any", () => {
    expect(moveInGroups(groups, "b", "g1", 1)[0]?.agentIds).toEqual(["c", "b", "a"]);
    expect(moveInGroups(groups, "c", "g1", 9)[0]?.agentIds).toEqual(["a", "c"]);
    expect(moveInGroups(groups, "a", "g2").map((g) => g.agentIds)).toEqual([["c"], ["a"]]);
    const out = moveInGroups(groups, "c", null);
    expect(out.map((g) => g.agentIds)).toEqual([["a"], []]);
    // Untouched groups stay the same objects.
    expect(out[1]).toBe(groups[1] as AgentGroup);
  });

  test("the HTTP client's routes and methods", async () => {
    const org = "/api/app/organizations/o1";
    const seen: string[] = [];
    const api = createHttpApi({
      fetch: async (url: string, init: RequestInit) => {
        seen.push(`${init.method} ${url} ${init.body ?? ""}`.trim());
        return new Response(JSON.stringify({ groups }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(await api.agentGroups.list("o1")).toEqual(groups);
    await api.agentGroups.create("o1", { name: "Produto", agentIds: ["a"] });
    await api.agentGroups.update("o1", "g1", { index: 0 });
    await api.agentGroups.remove("o1", "g1");
    expect(await api.agentGroups.move("o1", "a", { groupId: null })).toEqual(groups);
    expect(seen).toEqual([
      `GET ${org}/agent-groups`,
      `POST ${org}/agent-groups {"name":"Produto","agentIds":["a"]}`,
      `PATCH ${org}/agent-groups/g1 {"index":0}`,
      `DELETE ${org}/agent-groups/g1`,
      `PUT ${org}/agents/a/group {"groupId":null}`,
    ]);
  });

  test("the org event reads the groups again", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.agentGroups("o1"), groups);
    expect(applyWorkspaceEvent(qc, "o1", { type: "agent.groups" })).toBe(true);
    expect(qc.getQueryState(keys.agentGroups("o1"))?.isInvalidated).toBe(true);
  });

  test("its refusals in the person's words: too many groups, a group gone meanwhile", () => {
    const t = ((key: string, o?: { max?: number }) => `${key} ${o?.max}`) as unknown as TFunction;
    const said = (status: number, code: string, params?: { max: number }) =>
      knownErrorText(t, new ApiError(status, code, "In English", params));
    expect(said(400, "agent_group.too_many", { max: 50 })).toBe("errors.agentGroup.tooMany 50");
    expect(said(404, "agent_group.not_found")).toStartWith("errors.agentGroup.notFound");
  });
});
