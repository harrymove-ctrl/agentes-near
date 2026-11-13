import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  buildRunContext,
  type HandOff,
  HOW_YOU_WORK,
  HOW_YOU_WORK_PERSONAL,
  handOffsBlock,
  NO_PERSON,
  PERSONAL_INTERVIEW,
  postPersonMessage,
  REQUEST_APPROVAL_LINE,
  REQUEST_APPROVAL_LINE_PERSONAL,
  RIGHT_HAND,
  ROUTER_SYSTEM,
  ROUTER_SYSTEM_PERSONAL,
  rightHandPrompt,
  routerPrompt,
  TEAM_INTERVIEW,
  teamPrompt,
  turnMeans,
  updateOrgSettings,
} from "../src";
import { agentMediaQuestions, agentMediaState, FITS_QUESTION, FITS_QUESTION_PERSONAL } from "../src/agent-media";
import { handoffGuidance, noticeText } from "../src/notices";
import { type Fixture, setup } from "./fixtures";

/*
 * Personal mode (ADR 0159): what models read speaks of one person (and maybe their family) and their agents, never a
 * company, a team or colleagues, while every rule and capability stays. The team's text stays exactly as it was.
 */

const TEAM_WORDS = ["company", "organization", "colleague", "teammate"];

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

/** The workspace as a personal one, as Settings makes it (its settings row may not exist yet). */
const makePersonal = (fx: Fixture) => updateOrgSettings(fx.db, fx.owner.id, fx.org.id, { mode: "personal" });

describe("the rules every agent reads", () => {
  test("a personal workspace's rules keep every line, in words for one person", () => {
    for (const word of TEAM_WORDS) expect(HOW_YOU_WORK_PERSONAL).not.toContain(word);
    expect(HOW_YOU_WORK_PERSONAL).not.toContain("product choice");
    expect(HOW_YOU_WORK_PERSONAL).toContain("a fact about the person or their life");
    expect(HOW_YOU_WORK_PERSONAL).toContain("when another agent holds it, ask it (ask_agent)");
    expect(HOW_YOU_WORK_PERSONAL).toContain("leave this workspace");
    // The same lines, only reworded: nothing taken out.
    expect(HOW_YOU_WORK_PERSONAL.split("\n").length).toBe(HOW_YOU_WORK.split("\n").length);
    // The team's text is untouched.
    expect(HOW_YOU_WORK).toContain("a fact about the company");
    expect(HOW_YOU_WORK).toContain("the colleague whose role covers it");
    expect(REQUEST_APPROVAL_LINE).toContain("a role like the board");
    expect(REQUEST_APPROVAL_LINE_PERSONAL).not.toContain("board");
    expect(REQUEST_APPROVAL_LINE_PERSONAL).toContain("`request_approval`");
  });

  test("routine reports and hand-offs read like a trusted assistant, not a colleague", () => {
    expect(handoffGuidance("when_new")).toContain("the way a colleague would bring it up");
    expect(handoffGuidance("when_new", true)).toContain("the way a trusted assistant would bring it up");
    const meta = {
      notice: {
        kind: "routine_handoff",
        text: "A conta de luz venceu ontem.",
        from: "Routine «Contas»",
        refs: { runId: "r1", routineId: "x", routineRunId: "y", routineName: "Contas", report: "when_new" },
      },
    };
    expect(noticeText(meta, true, true)).not.toContain("colleague");
    expect(noticeText(meta, true)).toContain("colleague");
    const rows = [
      { handle: "finance", kind: "question", status: "open", question: "Quanto sobrou?", createdAt: new Date() },
    ] as unknown as HandOff[];
    expect(handOffsBlock(rows, "UTC")).toContain("never say a colleague hasn't answered");
    expect(handOffsBlock(rows, "UTC", new Date(), true)).toContain("never say another agent hasn't answered");
  });

  test("the other agents are the person's, not a team", () => {
    const team = [0, 1].map((i) => ({
      id: `a${i}`,
      name: `A${i}`,
      handle: `a${i}`,
      role: i ? "Finance" : "",
      instructions: "",
      ownerUserId: null,
      audienceMode: "everyone" as const,
      audienceUserIds: [],
      audienceRoleIds: [],
      consultable: true,
      brain: "model",
      autonomyBrakes: {},
      reportsToAgentId: null,
    }));
    const personal = teamPrompt(team, "a0", null, new Set(), NO_PERSON, true);
    expect(personal).toStartWith("# Your fellow agents\nOther agents of this person: @a1 (Finance).");
    expect(personal).not.toContain("organization");
    expect(teamPrompt(team, "a0", null, new Set(), NO_PERSON)).toStartWith(
      "# Your team\nOther agents in this organization: @a1 (Finance).",
    );
    const names = new Set(["ask_agent", "tell_agent"]);
    expect(turnMeans(names, ["@a1 (Finance)"], true).join("\n")).toContain("your fellow agents (`ask_agent`");
    expect(turnMeans(names, ["@a1 (Finance)"]).join("\n")).toContain("teammates (`ask_agent`");
  });

  test("a personal workspace's run says whose workspace it is", async () => {
    f = await setup();
    const fx = f;
    const said = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "@dev oi",
    });
    const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, said.id));
    if (!run) throw new Error("no run");
    // The same run's context, built again after the mode changes (a second mention would land in this run's inbox).
    const ask = () => buildRunContext(fx.db, run, fx.agent, { maxMessages: 10, toolsAvailable: true });
    const team = await ask();
    expect(team.personal).toBe(false);
    const teamText = systemText(team.system);
    expect(teamText).toContain(
      'You work in "Acme" on agentes.chat, a workspace where people and AI agents work together.',
    );
    expect(teamText).toContain("# About the organization\nAcme builds rockets.");
    expect(teamText).toContain("an AI agent of this organization.");
    expect(teamText).toContain("Write like a colleague texting the team");

    await makePersonal(fx);
    const personal = await ask();
    expect(personal.personal).toBe(true);
    const text = systemText(personal.system);
    expect(text).toContain(
      'You work in "Acme" on agentes.chat, a personal workspace: one person, and maybe their family',
    );
    expect(text).toContain("# About the person\nAcme builds rockets.");
    expect(text).toContain("one of this person's AI agents.");
    expect(text).toContain("Write like a trusted assistant texting the person");
    expect(text).toContain(HOW_YOU_WORK_PERSONAL);
    expect(text).not.toContain("About the organization");
    expect(text).not.toContain("colleague");
    // Every capability stays: approvals, asking agents, the same tools.
    expect(text).toContain("`request_approval`");
  });
});

describe("the router", () => {
  const cand = (handle: string) => ({ agentId: handle, handle, name: handle, role: "", about: "" });
  const input = {
    orgId: "o",
    channel: { id: "c", name: "familia", topic: "" },
    message: { id: "m", author: "ana", body: "alguém sabe a senha do wifi?" },
    thread: [],
    candidates: [cand("casa"), cand("financas")],
  };

  test("in a personal workspace the person mostly talks to their agents", () => {
    expect(routerPrompt(input).system).toBe(ROUTER_SYSTEM);
    expect(routerPrompt({ ...input, personal: true }).system).toBe(ROUTER_SYSTEM_PERSONAL);
    expect(ROUTER_SYSTEM).toContain("Most messages are people talking to each other: every agent then scores low.");
    expect(ROUTER_SYSTEM_PERSONAL).not.toContain("Most messages are people talking to each other");
    expect(ROUTER_SYSTEM_PERSONAL).toContain("Here the person mostly talks to their agents");
    expect(ROUTER_SYSTEM_PERSONAL).not.toContain("team chat");
    // The same rules otherwise, line for line.
    expect(ROUTER_SYSTEM_PERSONAL.split("\n").length).toBe(ROUTER_SYSTEM.split("\n").length);
  });

  test("an agent's sticker after its reply is judged as one of the person's agents", () => {
    expect(agentMediaQuestions({ gif: false }).fits).toBe(FITS_QUESTION);
    expect(agentMediaQuestions({ gif: false, personal: true }).fits).toBe(FITS_QUESTION_PERSONAL);
    expect(FITS_QUESTION_PERSONAL.instructions).not.toContain("teammate");
    const state = (personal: boolean) =>
      agentMediaState({
        agent: { name: "Casa", role: "" },
        where: "channel",
        conversation: [],
        reply: "Feito!",
        personal,
      });
    expect(state(false).where).toBe("a team channel where people and AI agents talk");
    expect(String(state(true).where)).not.toContain("team");
  });
});

describe("the right hand", () => {
  const lodiOf = async (fx: Fixture) => {
    const [lodi] = await fx.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
    if (!lodi) throw new Error("no right hand");
    return lodi;
  };

  test("in a personal workspace it never nudges to invite people and its checklist has no people row", async () => {
    f = await setup({ rightHand: true });
    const fx = f;
    const lodi = await lodiOf(fx);
    // Apps skipped: in a team workspace only the people row keeps the checklist open.
    await fx.db
      .update(schema.agents)
      .set({ setup: { role: null, done: ["apps"] } })
      .where(eq(schema.agents.id, lodi.id));
    const prompt = () =>
      rightHandPrompt({ db: fx.db }, { orgId: fx.org.id, agent: lodi, personId: fx.owner.id, inDm: true });
    const team = await prompt();
    expect(team).toContain("The checklist card at the top of your DM shows what is left to set up");
    expect(team).toContain(TEAM_INTERVIEW);
    expect(team).toContain("# The team now");

    await makePersonal(fx);
    const personal = await prompt();
    expect(personal).not.toContain("The checklist card at the top of your DM");
    expect(personal).not.toContain("offer_invites).");
    expect(personal).not.toContain("invite the team");
    expect(personal).toContain(PERSONAL_INTERVIEW);
    expect(personal).not.toContain(TEAM_INTERVIEW);
    expect(personal).toContain("# Their agents now");
    expect(personal).toContain("this person's right hand in their personal workspace");
    expect(personal).not.toContain("Semana da equipe");
    expect(PERSONAL_INTERVIEW).not.toContain("who else works there");
    // Everything it can do stays: the same cards.
    expect(personal).toContain("propose_team");
    expect(personal).toContain("set_team_week");
  });

  test("with the checklist open, a personal workspace's card names no people row", async () => {
    f = await setup({ rightHand: true });
    const fx = f;
    const lodi = await lodiOf(fx);
    await makePersonal(fx);
    await fx.db.update(schema.organizations).set({ context: "" }).where(eq(schema.organizations.id, fx.org.id));
    const text = await rightHandPrompt(
      { db: fx.db },
      { orgId: fx.org.id, agent: lodi, personId: fx.owner.id, inDm: true },
    );
    expect(text).toContain("(what they want help with, their agents, an AI, apps)");
    expect(text).not.toContain("apps, people)");
  });
});
