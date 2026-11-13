import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type SetupRowFacts, setupRow, setupSteps } from "@agenteschat/client/lib/setup-checklist";
import { setupStepsInSight } from "../../src/features/agents/setup/steps";
import { agent, translator } from "./fixtures";

// A new agent's setup checklist on the phone (ADR 0155 §2): the web's words and rules, its own screens.

const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");

const facts: SetupRowFacts = {
  org: "Acme",
  role: "support",
  granted: null,
  suggested: null,
  channels: null,
  firstChannel: "#suporte",
  audience: "everyone",
  otherOwner: null,
  onPlan: false,
};

test("its rows say what the web's say, in the agent's voice", async () => {
  const t = await translator("pt-BR");
  expect(setupRow(t, "ai", false, facts).title).toBe("Conectar uma IA");
  expect(setupRow(t, "where", false, facts).title).toBe("Entrar em #suporte");
  expect(setupRow(t, "who", true, { ...facts, audience: "owner" }).title).toBe("Falo só com você");
  const en = await translator("en");
  expect(setupRow(en, "where", false, facts).title).toBe("Join #suporte");
});

test("who sees it on the phone: who manages agents every step, its owner theirs, the right hand none", () => {
  const leo = agent({ id: "a-leo", name: "Leo", ownerUserId: "u-owner", setup: { role: "sales", done: [] } });
  expect(setupSteps(leo, { meId: "u-admin", admin: true })).toEqual(["ai", "apps", "where", "who", "how"]);
  expect(setupSteps(leo, { meId: "u-owner", admin: false })).toEqual(["ai", "where", "who"]);
  expect(setupSteps({ ...leo, builtin: "right_hand" }, { meId: "u-admin", admin: true })).toEqual([]);
  expect(setupSteps({ ...leo, setup: null }, { meId: "u-admin", admin: true })).toEqual([]);
});

test("the DM draws the checklist on top for whoever sets it up, not the first day nor the no-AI line", () => {
  const chat = src("chat/ChatScreen.tsx");
  expect(chat).toContain("const setupIntro = useSetupSteps(dmAgent).length > 0 && !rightHand && !isThread;");
  // No no-AI line over it (nor over the plan hold's).
  expect(chat).toContain("member && !rightHand && !planHeld && !setupIntro");
  expect(chat.match(/<AgentSetupIntro agent=\{dmAgent\} channelId=\{channelId\} \/>/g)?.length).toBe(2);
  // Its screen shows the same card while something is left.
  expect(src("agents/AgentProfileScreen.tsx")).toContain('<AgentSetupCard agent={agent} place="profile" />');
});

test("each step but thinking is a pushed screen, registered in the stack; thinking opens Connect AI", () => {
  const card = src("agents/setup/SetupCard.tsx");
  expect(card).toContain('if (step === "ai") openConnectAi({ agentId: agent.id });');
  expect(card).toContain("else openSetupStep(agent.id, step);");
  const layout = readFileSync(new URL("../../app/(app)/_layout.tsx", import.meta.url), "utf8");
  expect(layout).toContain('<Stack.Screen name="agent-step/[id]" options={{ ...pushed, ...scrollUnder }} />');
  const steps = src("agents/setup/SetupStepScreen.tsx");
  // Nothing saves until its word on the bar; then the step is confirmed and the screen goes back.
  expect(steps).toContain("await confirm.mutateAsync(step);");
  expect(steps).toContain("goBack();");
});

test("its greeting as the web's: its own role, no help asked over a card all done, apps skipped for the team", async () => {
  const card = src("agents/setup/SetupCard.tsx");
  // A template agent greets in the role it was given, never saying back what it was asked.
  expect(card).toContain("const asked = role || own ? null : askedLine(agent.instructions);");
  // It asks for help only while something is left, latched once the checklist is read.
  expect(card).toContain("if (asks === null && progress.ready) setAsks(!progress.all);");
  expect(card).toContain('asks ? t("agentSetup.lead") : null');
  // "Agora não" to apps on Lodi's card is the team's.
  expect(card).toContain('dir.agents.find(isRightHand)?.setup?.done.includes("apps")');
  // No article before the workspace's name ("de Acme"): the app can't know its gender.
  const t = await translator("pt-BR");
  expect(setupRow(t, "who", true, facts).title).toBe("Falo com todos de Acme");
  expect(setupRow(t, "who", false, { ...facts, onPlan: false }).title).toBe("Falar com todos de Acme");
});

test("alone in a personal workspace, nothing asks who else talks to an agent (ADR 0159)", () => {
  const steps = ["ai", "apps", "where", "who", "how"] as const;
  // Alone: everyone and only its owner are both just the person, so "who" leaves the card.
  expect(setupStepsInSight(steps, { mode: "everyone" }, true)).toEqual(["ai", "apps", "where", "how"]);
  expect(setupStepsInSight(steps, { mode: "owner" }, true)).toEqual(["ai", "apps", "where", "how"]);
  // People someone picked keep it in sight; a team's workspace, a family or a list still loading (not solo) keep it.
  expect(setupStepsInSight(steps, { mode: "people" }, true)).toEqual([...steps]);
  expect(setupStepsInSight(steps, { mode: "everyone" }, false)).toEqual([...steps]);
  const card = src("agents/setup/SetupCard.tsx");
  expect(card).toContain(
    'setupStepsInSight(setupSteps(agent, { meId, admin: can(org, "manage_agents") }), audienceOf(agent), solo)',
  );
  expect(card).toContain("personal: isPersonal(org),");
});

test("a personal workspace's rows and screens read its own words, the same choices under them", async () => {
  const pt = await translator("pt-BR");
  const personal = { ...facts, personal: true };
  expect(setupRow(pt, "who", false, personal).title).toBe(pt("agentSetup.who.todoPersonal"));
  expect(setupRow(pt, "who", true, personal).title).toBe(pt("agentSetup.who.doneEveryonePersonal"));
  expect(setupRow(pt, "who", false, facts).title).toBe(pt("agentSetup.who.todo", { org: "Acme" }));
  const steps = src("agents/setup/SetupStepScreen.tsx");
  expect(steps).toContain('t(modeKey(org, "agentSetup.how.desc"))');
  expect(steps).toContain('t(modeKey(org, "agentSetup.apps.empty"), { org: org?.name ?? "" })');
  // Who talks to it: plain words, and a family picks people; its roles only when one is picked or exists beyond the
  // base and admin ones.
  expect(steps).toContain("rolePicksInSight(org, roles.data?.roles ?? [], audience.roleIds ?? [])");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the screen's own template, read as source text
  expect(steps).toContain("t(modeKey(org, `audience.mode.${mode}`))");
  const en = await translator("en");
  expect(en("audience.mode.everyonePersonal")).toBe("Everyone here");
  const leo = pt("audience.modeText.peoplePersonal", { name: "Leo" });
  expect(leo).toBe("Escolha as pessoas que podem falar com o Leo.");
});
