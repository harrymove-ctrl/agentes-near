import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { TeamProposalCard } from "../src/api/types";
import { actionCardOf } from "../src/lib/action-cards";
import {
  aboutYouContext,
  answerAfter,
  answerPicks,
  answerText,
  firstTasks,
  LIFE_AREA_TEMPLATE,
  LIFE_AREAS,
  lifeAreaTemplate,
  readAboutYou,
  replyChipsOf,
  teamColumns,
  teamCounts,
  teamFailureText,
  teamInDms,
  teamStatus,
  teamUndoable,
} from "../src/lib/team-plan";

const at = (min: number) => new Date(Date.UTC(2026, 10, 4, 12, min)).toISOString();
const msg = (id: string, type: "person" | "agent", body: string, min: number) => ({
  id,
  createdAt: at(min),
  author: { type, id: type },
  body,
});

const routine = {
  name: "r",
  prompt: "r",
  schedule: "0 9 * * *",
  rule: null,
  cron: "0 9 * * *",
  timezone: "UTC",
  description: "",
  report: "when_new" as const,
  access: "read" as const,
};
const card = (over: Partial<TeamProposalCard> = {}): TeamProposalCard => ({
  kind: "team_proposal",
  forUserId: "u1",
  params: {
    lead: "",
    agents: [
      {
        name: "Iara",
        handle: "iara",
        role: "",
        line: "x",
        instructions: "",
        appearance: null,
        channel: "atendimento",
        routines: [routine],
        firstTask: "a",
      },
      {
        name: "Bia",
        handle: "bia",
        role: "",
        line: "x",
        instructions: "",
        appearance: null,
        channel: "atendimento",
        routines: [],
        firstTask: null,
      },
      {
        name: "Ada",
        handle: "ada",
        role: "",
        line: "x",
        instructions: "",
        appearance: null,
        channel: "eng",
        routines: [routine],
        firstTask: "b",
      },
    ],
    newChannels: ["atendimento"],
    skills: [],
    weekly: routine,
    approvals: "",
    invite: [],
  },
  state: "pending",
  decidedByUserId: null,
  decidedAt: null,
  expiresAt: at(600),
  ...over,
});

test("a question's answers: their first message after it, its picks, taps joined in the listed order", () => {
  const list = [
    msg("q0", "agent", "oi", 0),
    msg("p1", "person", "Software e apps", 1),
    msg("q", "agent", "?", 2),
    msg("p2", "person", "Cobrar · Bugs", 3),
  ];
  expect(answerAfter(list, null)).toBe("Software e apps");
  expect(answerAfter(list, "q")).toBe("Cobrar · Bugs");
  expect(answerAfter(list.slice(0, 3), "q")).toBeNull();
  expect(answerAfter(list, "gone")).toBeNull();
  expect(answerPicks(["Atender", "Cobrar", "Bugs"], "Cobrar · Bugs")).toEqual(["Cobrar", "Bugs"]);
  expect(answerPicks(["Atender"], null)).toEqual([]);
  expect(answerText(["Atender", "Cobrar", "Bugs"], new Set(["Bugs", "Atender"]))).toBe("Atender · Bugs");
  expect(replyChipsOf({ replyChips: { choices: ["a", 3, ""], multiple: true, step: 9, of: 3 } })).toEqual({
    choices: ["a"],
    multiple: true,
    step: 3,
    of: 3,
  });
  expect(replyChipsOf({})).toBeNull();
});

test("the team card: what it counts, its columns, where it stands, who undoes it and its first tasks", () => {
  const c = card();
  expect(actionCardOf({ actionCard: c })?.kind).toBe("team_proposal");
  expect(teamCounts(c.params)).toEqual({ agents: 3, newChannels: 1, routines: 3 });
  expect(teamColumns(c.params).map((col) => [col.channel, col.fresh, col.agents.map((a) => a.name)])).toEqual([
    ["atendimento", true, ["Iara", "Bia"]],
    ["eng", false, ["Ada"]],
  ]);
  const now = Date.parse(at(10));
  expect(teamStatus(c, now)).toBe("open");
  expect(teamStatus(c, Date.parse(at(700)))).toBe("expired");
  const made = card({
    state: "created",
    decidedByUserId: "u1",
    decidedAt: at(5),
    created: { agentIds: ["a1", "a2", "a3"], channelIds: [], routineIds: [], skillIds: [], skipped: [], noAi: [] },
  });
  expect(teamUndoable(made, { userId: "u1", admin: false }, now)).toBe(true);
  expect(teamUndoable(made, { userId: "u2", admin: false }, now)).toBe(false);
  expect(teamUndoable(made, { userId: "u2", admin: true }, now)).toBe(true);
  expect(teamUndoable(made, { userId: "u1", admin: false }, now + 25 * 3_600_000)).toBe(false);
  expect(firstTasks(made).map((f) => [f.agentId, f.task])).toEqual([
    ["a1", "a"],
    ["a3", "b"],
  ]);
});

test("a failed try names its step, with a known reason in the reader's words and an unknown one hidden", () => {
  const t = ((key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key)) as TFunction;
  const taken = { step: "Caio", reason: "@caio is already taken", status: 409, code: "agent.handle_taken" };
  expect(teamFailureText(t, taken)).toContain('"step":"Caio"');
  expect(teamFailureText(t, taken)).toContain("newAgent.errors.handleTaken");
  expect(teamFailureText(t, { step: "#eng", reason: "Something went wrong", status: 500 })).toContain("common.ourSide");
});

test("a personal workspace's areas of life (ADR 0159): the template each opens, and the context they make", () => {
  // Every area but "Something else" opens one of the server's personal templates.
  const personal = ["life", "health", "studies", "home", "travel", "freelance"];
  for (const a of LIFE_AREAS) {
    if (a === "other") expect(LIFE_AREA_TEMPLATE[a]).toBeNull();
    else expect(personal).toContain(LIFE_AREA_TEMPLATE[a] as string);
  }
  // The first picked in the list's order, whatever order they were tapped in.
  expect(lifeAreaTemplate(["travel", "health"])).toBe("health");
  expect(lifeAreaTemplate(["other"])).toBeNull();
  expect(lifeAreaTemplate([])).toBeNull();

  const words: Record<string, string> = {
    "teamPlan.lifeArea.routine": "Calendar and routine",
    "teamPlan.lifeArea.money": "Finances",
    "teamPlan.lifeArea.health": "Health and training",
  };
  const t = ((key: string, o?: Record<string, unknown>) =>
    key === "teamPlan.lifeAreaContext" ? `I want help with: ${o?.areas}.` : (words[key] ?? key)) as never as TFunction;
  const saved = aboutYouContext(t, ["money", "routine", "other"], " I run twice a week. ");
  expect(saved).toBe("I want help with: Calendar and routine, Finances. I run twice a week.");
  expect(aboutYouContext(t, ["other"], "")).toBe("");
  expect(aboutYouContext(t, [], "Just me.")).toBe("Just me.");
  // Opened again, it reads back into the same answers, so saving doesn't repeat them.
  expect(readAboutYou(t, saved)).toEqual({ areas: ["routine", "money"], line: "I run twice a week." });
  expect(readAboutYou(t, "We sell shoes.")).toEqual({ areas: [], line: "We sell shoes." });
  expect(readAboutYou(t, "I want help with: Gardening.")).toEqual({ areas: [], line: "I want help with: Gardening." });
});

test("agents with no channel live in their DM: a map column each, no channel counted", () => {
  const c = card();
  const dm = (handle: string) => ({ ...c.params.agents[0], handle, name: handle, channel: "" }) as never;
  const plan = { ...c.params, agents: [dm("clara"), dm("duda")], newChannels: [] };
  expect(teamInDms(plan)).toBe(true);
  expect(teamInDms(c.params)).toBe(false);
  expect(teamCounts(plan).newChannels).toBe(0);
  expect(teamColumns(plan).map((col) => [col.key, col.channel, col.fresh])).toEqual([
    ["@clara", "", false],
    ["@duda", "", false],
  ]);
});
