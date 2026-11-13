import { describe, expect, test } from "bun:test";
import type { AgentGroup, TeamAgent } from "../src/api/types";
import {
  chartByPerson,
  filterTeam,
  lineSize,
  lineTop,
  mapColumns,
  mayReportTo,
  noSectorsCopy,
  reportsOf,
  reportsTo,
  sectorGap,
  sectorLineChanges,
  sectorReach,
  sectorSupervisor,
  sharedSupervisor,
  sortTeam,
  supervisorOf,
  supervisors,
} from "../src/lib/team-views";

const agent = (id: string, over: Partial<TeamAgent> = {}): TeamAgent => ({
  id,
  name: id,
  handle: id.toLowerCase(),
  role: "",
  appearance: null,
  ownerUserId: null,
  capabilities: [],
  busy: false,
  canTalk: true,
  channelIds: [],
  ...over,
});
const ada = agent("Ada", { role: "Dev", ownerUserId: "u-lukas", channelIds: ["c-eng"], busy: true });
const kai = agent("Kai", { role: "Revisor", channelIds: ["c-eng", "c-ops"] });
const milo = agent("Milo", { role: "Financeiro", ownerUserId: "u-amara" });
const lodi = agent("Lodi");
const eng: AgentGroup = { id: "g-eng", name: "Engenharia", agentIds: ["Kai", "Ada"], leadUserId: "u-lukas" };
const members = new Set(["u-lukas", "u-amara"]);

describe("Equipe's views (ADR 0148)", () => {
  test("an empty Setores offers the first one only to who can create it", () => {
    expect(noSectorsCopy(true).title).toBe("team.sectors.emptyTitle");
    expect(noSectorsCopy(false).text).toBe("team.sectors.emptyViewer");
  });

  test("the list: a filter, then a search by name, role or a channel's name", () => {
    const names = (list: TeamAgent[]) => list.map((a) => a.name);
    const all = [ada, kai, milo];
    const base = { q: "", meId: "u-amara", channelName: (id: string) => ({ "c-eng": "engenharia" })[id] };
    expect(names(filterTeam(all, { ...base, filter: "mine" }))).toEqual(["Milo"]);
    expect(names(filterTeam(all, { ...base, filter: "working" }))).toEqual(["Ada"]);
    expect(names(filterTeam(all, { ...base, filter: "noOwner" }))).toEqual(["Kai"]);
    expect(names(filterTeam(all, { ...base, filter: "waiting", waitingIds: new Set(["Kai"]) }))).toEqual(["Kai"]);
    expect(names(filterTeam(all, { ...base, filter: "all", q: "ENGEN" }))).toEqual(["Ada", "Kai"]);
    expect(names(filterTeam(all, { ...base, filter: "all", q: "finan" }))).toEqual(["Milo"]);
  });

  test("sorting by a column puts the empty ones last either way", () => {
    const names = {
      sector: (id: string) => (eng.agentIds.includes(id) ? "Engenharia" : ""),
      owner: (id: string | null) => id ?? "",
    };
    expect(sortTeam([milo, kai, ada], "name", false, names).map((a) => a.name)).toEqual(["Ada", "Kai", "Milo"]);
    expect(sortTeam([milo, kai, ada], "sector", true, names).map((a) => a.name)).toEqual(["Ada", "Kai", "Milo"]);
    expect(sortTeam([kai, milo, ada], "owner", false, names).map((a) => a.name)).toEqual(["Milo", "Ada", "Kai"]);
  });

  test("the org chart: under the owner, else the setor's lead, else nobody; the right hand on its own", () => {
    expect(reportsTo(kai, [eng], members)).toBe("u-lukas");
    // A lead who left the workspace leads nobody.
    expect(reportsTo(kai, [eng], new Set(["u-amara"]))).toBeNull();
    const cols = chartByPerson([ada, kai, milo, lodi], [eng], members, (a) => a.id === "Lodi");
    expect(cols.map((c) => [c.personId, c.agents.map((a) => a.name)])).toEqual([
      ["u-lukas", ["Ada", "Kai"]],
      ["u-amara", ["Milo"]],
    ]);
    expect(chartByPerson([kai], [], members).map((c) => c.personId)).toEqual([null]);
  });

  test("the map: a column per channel in the sidebar's order, an agent in each of its channels, none last", () => {
    const cols = mapColumns([ada, kai, milo, lodi], ["c-ops", "c-eng", "c-empty"], (a) => a.id === "Lodi");
    expect(cols.map((c) => [c.channelId, c.agents.map((a) => a.name)])).toEqual([
      ["c-ops", ["Kai"]],
      ["c-eng", ["Ada", "Kai"]],
      [null, ["Milo"]],
    ]);
    // A channel I don't see doesn't place an agent.
    expect(mapColumns([kai], ["c-eng"]).map((c) => c.channelId)).toEqual(["c-eng"]);
    expect(mapColumns([agent("X", { channelIds: ["c-secret"] })], ["c-eng"]).map((c) => c.channelId)).toEqual([null]);
  });

  test("a setor's people, channels and what it is missing", () => {
    expect(sectorReach({ ...eng, backupUserId: "u-amara" }, [ada, kai, milo])).toEqual({
      agents: [kai, ada],
      people: ["u-lukas", "u-amara"],
      channelIds: ["c-eng", "c-ops"],
    });
    expect(sectorGap({ ...eng, leadUserId: null })).toBe("noLead");
    expect(sectorGap(eng)).toBe("noBackup");
    expect(sectorGap({ ...eng, backupUserId: "u-amara" })).toBeNull();
  });
});

describe("Responde a (ADR 0148 addendum)", () => {
  const nina = agent("Nina", { ownerUserId: "u-amara" });
  const bea = agent("Bea", { reportsToAgentId: "Nina", ownerUserId: "u-lukas" });
  const cid = agent("Cid", { reportsToAgentId: "Bea" });
  const dan = agent("Dan", { reportsToAgentId: "Nina" });
  const team = [nina, bea, cid, dan, kai];
  const sales: AgentGroup = { id: "g-sales", name: "Vendas", agentIds: ["Bea", "Dan", "Kai"] };

  test("the org chart: a supervisor in its person's column with its line under it, counted", () => {
    const columns = chartByPerson(team, [], members);
    expect(columns.map((c) => c.personId)).toEqual(["u-amara", null]);
    const [amara] = columns;
    // Bea's owner is Lukas, but she reports to Nina: she sits under her.
    expect(amara?.agents.map((a) => a.id)).toEqual(["Nina", "Bea", "Cid", "Dan"]);
    expect(amara?.nodes.map((n) => n.agent.id)).toEqual(["Nina"]);
    const top = amara?.nodes[0];
    expect(top?.reports.map((r) => r.agent.id)).toEqual(["Bea", "Dan"]);
    expect(top?.reports[0]?.reports.map((r) => r.agent.id)).toEqual(["Cid"]);
    expect(top && lineSize(top)).toBe(3);
    expect(reportsTo(cid, [], members, team)).toBe("u-amara");
    expect(lineTop(cid, team).id).toBe("Nina");
    expect(supervisorOf(cid, team)?.id).toBe("Bea");
    expect(reportsOf("Nina", team).map((a) => a.id)).toEqual(["Bea", "Dan"]);
  });

  test("lines that loop in storage still draw each agent once", () => {
    const a = agent("A", { reportsToAgentId: "B" });
    const b = agent("B", { reportsToAgentId: "A" });
    const columns = chartByPerson([a, b], [], members);
    expect(columns.flatMap((c) => c.agents.map((x) => x.id)).sort()).toEqual(["A", "B"]);
    const drawn = (n: { agent: TeamAgent; reports: unknown[] }): string[] => [
      n.agent.id,
      ...(n.reports as (typeof n)[]).flatMap(drawn),
    ];
    expect(columns.flatMap((c) => c.nodes.flatMap(drawn)).sort()).toEqual(["A", "B"]);
  });

  test("the map's band and a column's face", () => {
    expect(supervisors(team).map((a) => a.id)).toEqual(["Nina", "Bea"]);
    expect(sharedSupervisor([bea, dan], team)?.id).toBe("Nina");
    expect(sharedSupervisor([bea, kai], team)).toBeNull();
    expect(sharedSupervisor([kai], team)).toBeNull();
  });

  test("a setor's supervisor, who is off it, and the changes that set or clear it", () => {
    expect(sectorSupervisor(sales, team)).toEqual({ supervisor: nina, off: [kai] });
    expect(sectorSupervisor(eng, team)).toBeNull();
    expect(sectorLineChanges(sales, team, "Nina")).toEqual([{ agentId: "Kai", reportsToAgentId: "Nina" }]);
    // The supervisor itself is left as it is.
    expect(sectorLineChanges(sales, team, "Bea")).toEqual([
      { agentId: "Dan", reportsToAgentId: "Bea" },
      { agentId: "Kai", reportsToAgentId: "Bea" },
    ]);
    expect(sectorLineChanges(sales, team, null, "Nina")).toEqual([
      { agentId: "Bea", reportsToAgentId: null },
      { agentId: "Dan", reportsToAgentId: null },
    ]);
  });

  test("who an agent may report to: not itself, not below itself, at most 3 agents top to bottom", () => {
    expect(mayReportTo(team, "Kai", "Kai")).toBe(false);
    expect(mayReportTo(team, "Nina", "Cid")).toBe(false);
    expect(mayReportTo(team, "Kai", "Bea")).toBe(true);
    // Nina, Bea, Cid, Kai: four.
    expect(mayReportTo(team, "Kai", "Cid")).toBe(false);
    // Bea's line (Bea, Cid) under Kai: Kai, Bea, Cid.
    expect(mayReportTo(team, "Bea", "Kai")).toBe(true);
    expect(mayReportTo([...team, agent("Eli")], "Nina", "Eli")).toBe(false);
  });
});
