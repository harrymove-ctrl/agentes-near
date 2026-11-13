import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { Agent, AgentSetupResult, ForeignMailbox, OrgRole, OrgSummary } from "../src/api/types";
import {
  agentsReach,
  audienceChip,
  audienceLines,
  audienceModeKey,
  audienceModeTextKey,
  audiencePatch,
  audienceSummary,
  audienceWithMe,
  opensDetails,
  opensOthersPlan,
  setupPlanOpens,
  setupPlanQuestion,
  unavailableNotice,
  widenQuestion,
} from "../src/lib/audience";
import { agentWorkingIn, type StreamsState } from "../src/realtime/streams";

const role = (id: string, position: number, kind: OrgRole["kind"] = "custom") =>
  ({ id, name: id, kind, position, color: "amber", icon: "shield" }) as OrgRole;
const roles = [role("suporte", 1), role("produto", 0), role("everyone", 9, "everyone")];
const members = [{ userId: "u-heitor" }, { userId: "u-caio" }, { userId: "u-bia" }];
const agent = (extra: Partial<Agent>) => ({ id: "a-ada", ownerUserId: "u-heitor", ...extra }) as Agent;
const shown = (lines: ReturnType<typeof audienceLines>) =>
  lines.map((l) => (l.kind === "person" ? l.person.userId : l.kind === "role" ? l.role.id : `all:${l.role?.id}`));

describe("audienceLines", () => {
  test("everyone: one line, with the everyone role's mark", () => {
    expect(shown(audienceLines(agent({ audience: { mode: "everyone", userIds: [] } }), roles, members))).toEqual([
      "all:everyone",
    ]);
    expect(shown(audienceLines(agent({}), roles, members))).toEqual(["all:everyone"]);
  });

  test("only its owner: the owner; none without one", () => {
    const owner = { mode: "owner" as const, userIds: [] };
    expect(shown(audienceLines(agent({ audience: owner }), roles, members))).toEqual(["u-heitor"]);
    expect(shown(audienceLines(agent({ audience: owner, ownerUserId: null }), roles, members))).toEqual([]);
  });

  test("some people: roles top first, then the people, never the owner, only who we know", () => {
    const audience = {
      mode: "people" as const,
      userIds: ["u-heitor", "u-caio", "u-gone"],
      roleIds: ["suporte", "produto"],
    };
    expect(shown(audienceLines(agent({ audience }), roles, members))).toEqual(["produto", "suporte", "u-caio"]);
  });
});

describe("audiencePatch", () => {
  test("people and roles only when it answers some people", () => {
    expect(audiencePatch({ mode: "owner", userIds: ["u-caio"], roleIds: ["suporte"] })).toEqual({
      mode: "owner",
      userIds: [],
      roleIds: [],
      consultable: true,
    });
    expect(audiencePatch({ mode: "people", userIds: ["u-caio"], consultable: false })).toEqual({
      mode: "people",
      userIds: ["u-caio"],
      roleIds: [],
      consultable: false,
    });
  });
});

describe("agentWorkingIn", () => {
  test("the channel of a run thinking or writing, none when idle", () => {
    const state = {
      runs: {
        r1: { agentId: "a-ada", channelId: "c-old", status: "done", text: "" },
        r2: { agentId: "a-ada", channelId: "c-launch", status: "running", text: "" },
      },
    } as unknown as StreamsState;
    expect(agentWorkingIn(state, "a-ada")).toBe("c-launch");
    expect(agentWorkingIn(state, "a-theo")).toBeNull();
  });
});

describe("audienceWithMe", () => {
  const admin = { permissions: ["manage_agents", "talk_to_agents"] } as unknown as OrgSummary;
  const member = { permissions: ["talk_to_agents"] } as unknown as OrgSummary;
  const kept = agent({ canTalk: false, audience: { mode: "people", userIds: [], roleIds: ["suporte"] } });
  test("an admin it keeps out lets themselves in, its roles kept; a member outside can't", () => {
    expect(audienceWithMe(admin, kept, "u-caio")).toEqual({
      mode: "people",
      userIds: ["u-caio"],
      roleIds: ["suporte"],
    });
    expect(audienceWithMe(member, kept, "u-bia")).toBeNull();
    expect(audienceWithMe(admin, { ...kept, canTalk: true }, "u-caio")).toBeNull();
  });
  test("on someone else's plan an admin lets themselves in too, asked first; its owner isn't asked", () => {
    const onPlan = { ...kept, brain: { kind: "claude_code", account: "Claude Max" } as Agent["brain"] };
    const next = audienceWithMe(admin, onPlan, "u-caio");
    expect(next).toEqual({ mode: "people", userIds: ["u-caio"], roleIds: ["suporte"] });
    expect(next && opensOthersPlan(onPlan, next, "u-caio")).toBe(true);
    expect(opensOthersPlan(onPlan, { mode: "everyone", userIds: [], roleIds: [] }, "u-heitor")).toBe(false);
    expect(opensOthersPlan(kept, { mode: "everyone", userIds: [], roleIds: [] }, "u-caio")).toBe(false);
    expect(audienceWithMe(member, onPlan, "u-bia")).toBeNull();
    // No plan of anyone's thinks for it there (OpenCode's free tier on a computer nobody connected): nothing to ask.
    const free = { ...kept, brain: { kind: "opencode", model: null } as Agent["brain"] };
    expect(opensOthersPlan(free, { mode: "everyone", userIds: [], roleIds: [] }, "u-caio")).toBe(false);
  });
});

describe("widenQuestion", () => {
  const t = ((key: string, o?: Record<string, string>) =>
    `${key}${o ? JSON.stringify(o) : ""}`) as unknown as TFunction;
  const ada = { name: "Ada", brain: { kind: "claude_code" } as Agent["brain"] };
  const box = { accountId: "m1", address: "w@x.test", ownerName: "Walter" } as ForeignMailbox;
  test("nothing to ask, the mailboxes alone, or the plan with the mailboxes in one question", () => {
    expect(widenQuestion(t, ada, null, [])).toBeNull();
    expect(widenQuestion(t, ada, null, [box])?.title).toBe("reach.mailLossTitle");
    const plan = widenQuestion(t, ada, "Walter", []);
    expect(plan?.title).toBe('reach.planTitle{"owner":"Walter"}');
    expect(plan?.description).toContain('"plan":"aiAccounts.connect.claude_code"');
    const glm = { name: "Ada", brain: { kind: "claude_code", provider: "zai" } as Agent["brain"] };
    expect(widenQuestion(t, glm, "Walter", [])?.description).toContain('"plan":"Z.ai"');
    expect(widenQuestion(t, ada, "Walter", [box])?.description).toMatch(
      /^common\.joinSentences.*reach\.planOpen.*reach\.mailLoss/,
    );
  });
});

describe("setupPlanQuestion (Usar em outros agentes)", () => {
  const t = ((key: string, o?: Record<string, unknown>) =>
    `${key}${o ? JSON.stringify(o) : ""}`) as unknown as TFunction;
  const claude = { kind: "claude_code" as const, provider: null };
  const agents = new Map([
    ["a-1", { name: "Ada", ownerUserId: "u-joao" }],
    ["a-2", { name: "Atlas", ownerUserId: "u-joao" }],
    ["a-3", { name: "Lia", ownerUserId: "u-bia" }],
    ["a-4", { name: "Theo", ownerUserId: "u-bia" }],
  ]);
  const names: Record<string, string> = { "u-joao": "João", "u-bia": "Bia" };
  const results: AgentSetupResult[] = [
    { agentId: "a-1", status: "applied", opensPlan: true },
    { agentId: "a-2", status: "applied", opensPlan: true },
    { agentId: "a-3", status: "applied", opensPlan: true },
    { agentId: "a-4", status: "applied" },
  ];
  const opens = (ids: string[]) =>
    setupPlanOpens(
      results,
      ids,
      (id) => agents.get(id),
      (id) => names[id] ?? "",
    );

  test("none picked on someone else's plan: nothing to ask", () => {
    expect(opens(["a-4"])).toEqual([]);
    expect(setupPlanQuestion(t, claude, opens(["a-4"]))).toBeNull();
  });

  test("one owner: their plan, their agents in one line", () => {
    const q = setupPlanQuestion(t, claude, opens(["a-1", "a-2", "a-4"]));
    expect(q?.title).toBe('reach.planTitle{"owner":"João"}');
    expect(q?.description).toBe(
      'reach.planOpen{"name":"format.list{\\"names\\":[\\"Ada\\",\\"Atlas\\"]}","owner":"João","plan":"aiAccounts.connect.claude_code"}',
    );
  });

  test("several owners: all of them in the title, one line each", () => {
    const q = setupPlanQuestion(t, claude, opens(["a-1", "a-3"]));
    expect(q?.title).toBe('reach.plansTitle{"owners":"format.list{\\"names\\":[\\"João\\",\\"Bia\\"]}"}');
    const lines = q?.description.split("\n") ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"owner":"João"');
    expect(lines[1]).toContain('"owner":"Bia"');
  });
});

test("an agent's picture leads to its details unless it left the team or the viewer sees only its public card", () => {
  expect(opensDetails({})).toBe(true);
  expect(opensDetails({ seesDetails: true })).toBe(true);
  expect(opensDetails({ seesDetails: false })).toBe(false);
  expect(opensDetails({ former: "archived" })).toBe(false);
  expect(opensDetails(undefined)).toBe(false);
});

describe("agentsReach: whether a narrowed audience holds for agents too", () => {
  const owner = { mode: "owner" as const, userIds: [] };
  test("everyone talks to it: nothing to say", () => {
    expect(agentsReach({ mode: "everyone", userIds: [] }, true, "u-heitor")).toBeNull();
  });
  test("other agents still consult it unless switched off", () => {
    expect(agentsReach(owner, false, "u-heitor")).toBe("consulted");
    expect(agentsReach({ ...owner, consultable: false }, false, "u-heitor")).toBe("blocked");
    expect(agentsReach({ mode: "people", userIds: ["u-bia"] }, true, "u-heitor")).toBe("consulted");
  });
  test("on its owner's plan answering only its owner, nobody else, agents included", () => {
    expect(agentsReach(owner, true, "u-heitor")).toBe("plan");
    expect(agentsReach({ mode: "people", userIds: [] }, true, "u-heitor")).toBe("plan");
  });
});

describe("unavailableNotice (an agent I named won't answer me)", () => {
  const t = ((key: string, o?: Record<string, unknown>) =>
    `${key}${o ? JSON.stringify(o) : ""}`) as unknown as TFunction;
  const nobody = () => undefined;
  test("the channel's exception, the agent as the directory knows it, else the server's names: never its English", () => {
    expect(unavailableNotice(t, { code: "channel.agents_denied" }, undefined, nobody)).toBe(
      "channel.perms.agentsDenied",
    );
    const theo = { name: "Theo", audience: { mode: "people", userIds: ["u-a"], roleIds: [] } } as unknown as Agent;
    const known = unavailableNotice(t, { code: "audience.only" }, theo, (id) => (id === "u-a" ? "Ana" : undefined));
    expect(known).toStartWith('audience.notice.only{"name":"Theo"');
    expect(known).toContain("Ana");
    const sent = unavailableNotice(
      t,
      { code: "audience.only", params: { agentName: "Lia", names: ["Suporte"] } },
      undefined,
      nobody,
    );
    expect(sent).toStartWith('audience.notice.only{"name":"Lia","context":"female"');
    expect(sent).toContain("Suporte");
    expect(
      unavailableNotice(t, { code: "audience.nobody", params: { agentName: "Theo", names: [] } }, undefined, nobody),
    ).toBe('audience.notice.nobody{"name":"Theo"}');
  });
});

describe("a personal workspace's audience words (ADR 0159)", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  const personal = { mode: "personal" } as Pick<OrgSummary, "mode">;
  const team = { mode: "team" } as Pick<OrgSummary, "mode">;

  test("the choices' names and lines: plain in a personal one; the owner's reads the same; a team's as always", () => {
    expect(audienceModeKey(personal, "everyone")).toBe("audience.mode.everyonePersonal");
    expect(audienceModeKey(personal, "people")).toBe("audience.mode.peoplePersonal");
    expect(audienceModeKey(personal, "owner")).toBe("audience.mode.owner");
    expect(audienceModeKey(team, "everyone")).toBe("audience.mode.everyone");
    expect(audienceModeKey(undefined, "people")).toBe("audience.mode.people");
    expect(audienceModeTextKey(personal, "people")).toBe("audience.modeText.peoplePersonal");
    expect(audienceModeTextKey(team, "everyone")).toBe("audience.modeText.everyone");
  });

  test("the chip says Only you to its owner in a personal one; anyone else, and a team's, read Personal", () => {
    const mine = agent({ audience: { mode: "owner", userIds: [] } });
    expect(audienceChip(t, mine, { org: personal, meId: "u-heitor" })).toBe("audience.chip.ownerPersonal");
    expect(audienceChip(t, mine, { org: personal, meId: "u-bia" })).toBe("audience.chip.owner");
    expect(audienceChip(t, mine, { org: team, meId: "u-heitor" })).toBe("audience.chip.owner");
    expect(audienceChip(t, mine)).toBe("audience.chip.owner");
    const open = agent({ audience: { mode: "everyone", userIds: [] } });
    expect(audienceChip(t, open, { org: personal, meId: "u-heitor" })).toBeNull();
  });

  test("the summary of everyone in its words", () => {
    const open = agent({ audience: { mode: "everyone", userIds: [] } });
    expect(
      audienceSummary(
        t,
        open,
        () => undefined,
        () => undefined,
        personal,
      ),
    ).toBe("audience.summary.everyonePersonal");
    expect(audienceSummary(t, open, () => undefined)).toBe("audience.summary.everyone");
  });
});
