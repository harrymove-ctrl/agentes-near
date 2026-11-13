import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DirectMessage } from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import {
  firstVisitOf,
  introCards,
  introLeadKey,
  offersTeamSetup,
  rightHandOf,
  teamAnswered,
  tellsNameStory,
} from "@agenteschat/client/lib/right-hand";
import { STICKER_STILL_T, WAVE_SECONDS } from "@agenteschat/ui/agent/stickers";
import { stickerFrame } from "../../src/agent/sticker";
import { agentStarters, buildConversations, homeLayout, rightHandPin } from "../../src/features/chats/logic";
import { SETTINGS_SECTIONS } from "../../src/features/settings/logic";
import { agent, at } from "./fixtures";

const lodi = agent({ id: "a-lodi", name: "Lodi", builtin: "right_hand" });
const theo = agent({ id: "a-theo", name: "Theo" });
const dm = (a: { id: string; name: string; handle: string }, minutesAgo: number, unread = 0): DirectMessage => ({
  channelId: `d-${a.id}`,
  with: { type: "agent", id: a.id, name: a.name, handle: a.handle },
  lastMessage: { id: `m-${a.id}`, body: "Oi", createdAt: at(minutesAgo), authorType: "agent" },
  unread,
});

test("the right hand is its own row, its DM's unread kept, never one of Agentes' sorted rows", () => {
  const rows = buildConversations({ channels: [], dms: [dm(lodi, 1, 2), dm(theo, 5)], threads: [] });
  const { pin, rows: rest } = rightHandPin(rows, rightHandOf([theo, lodi]));
  expect(pin).toMatchObject({ kind: "dm", channelId: "d-a-lodi", unread: 2 });
  const agents = homeLayout(rest, []).find((s) => s.key === "agents");
  expect(agents?.rows.map((r) => r.key)).toEqual(["d:d-a-theo"]);
});

test("Conversas asks the right hand from its own field under the greeting, never one of Agentes' rows", () => {
  const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");
  const chats = src("chats/ChatsScreen.tsx");
  // Its face wakes as Conversas arrives after the splash (once per launch).
  expect(chats).toContain(
    "<RightHandAsk row={pinned.pin} onStart={startDm} faceMode={wake.mode} faceStyle={wake.style} />",
  );
  expect(chats).toContain("after={ask}");
  expect(chats).not.toContain("kept: lead");
  expect(src("right-hand/Pin.tsx")).toContain('t("mobile.chat.messageTo", { name: row.with.name })');
});

test("with no DM yet its row starts one, and the Agentes starters leave it out", () => {
  const { pin, rows } = rightHandPin([], lodi);
  expect(pin).toMatchObject({ kind: "dm", channelId: "", with: { id: "a-lodi" } });
  expect(rows).toEqual([]);
  const starters = agentStarters([lodi, theo].filter((a) => a.builtin !== "right_hand"));
  expect(starters.map((r) => r.key)).toEqual(["a:a-theo"]);
});

test("outside its audience there is no pin", () => {
  const hidden = { ...lodi, canTalk: false };
  expect(canTalk(hidden)).toBe(false);
  const rows = buildConversations({ channels: [], dms: [dm(lodi, 1)], threads: [] });
  expect(rightHandPin(rows, canTalk(hidden) ? hidden : undefined)).toEqual({ pin: null, rows });
});

test("the way to build the team: with a team, no card left and no open checklist, for who may create agents", () => {
  const base = { noAi: false, aiKnown: true, createsAgents: true, hasTeam: true, cards: [] };
  expect(offersTeamSetup(base)).toBe(true);
  // A card still asks, or there is no team to build again: the card or the interview is the way.
  expect(offersTeamSetup({ ...base, cards: ["style"] })).toBe(false);
  expect(offersTeamSetup({ ...base, hasTeam: false })).toBe(false);
  expect(offersTeamSetup({ ...base, noAi: true })).toBe(false);
  expect(offersTeamSetup({ ...base, aiKnown: false })).toBe(false);
  expect(offersTeamSetup({ ...base, createsAgents: false })).toBe(false);
  // Under the owner's checklist (ADR 0155 §6): only once it is complete.
  expect(offersTeamSetup({ ...base, checklist: "open" })).toBe(false);
  expect(offersTeamSetup({ ...base, checklist: "complete" })).toBe(true);
});

test("on a billing hold its greeting offers no line to build the team: that message would be refused", () => {
  const s = { noAi: false, aiKnown: true, createsAgents: true, hasTeam: true, cards: [] };
  expect(offersTeamSetup(s)).toBe(true);
  expect(offersTeamSetup({ ...s, held: true })).toBe(false);
});

test("its greeting's cards beside the checklist: one question at a time (ADR 0155 §6)", () => {
  const base = { noAi: false, aiKnown: true, askStyle: true };
  // The owner's open checklist holds the whole setup: nothing else asks, Connect included.
  expect(introCards({ ...base, noAi: true, checklist: "open" })).toEqual([]);
  expect(introCards({ ...base, checklist: "open" })).toEqual([]);
  // Complete: how agents talk to them, until they pick (ADR 0147); never a second Connect.
  expect(introCards({ ...base, checklist: "complete" })).toEqual(["style"]);
  expect(introCards({ ...base, noAi: true, checklist: "complete" })).toEqual(["style"]);
  // Anyone without the checklist (an invited person): Connect AI first, then the question.
  expect(introCards({ ...base, noAi: true, checklist: "none" })).toEqual(["connect"]);
  expect(introCards({ ...base, noAi: true, noAiCard: true })).toEqual([]);
  expect(introCards(base)).toEqual(["style"]);
  expect(introCards({ ...base, askStyle: false })).toEqual([]);
  expect(introCards({ ...base, aiKnown: false })).toEqual([]);
  // On a billing hold an AI comes after the plan, a saved key reading ready changes nothing: no card asks.
  expect(introCards({ ...base, noAi: true, held: true })).toEqual([]);
  expect(introCards({ ...base, held: true })).toEqual([]);
  // On a hold the greeting says how the team comes only while there is none; then what it does, on web and phone.
  expect(introLeadKey(true, false)).toBe("rightHand.intro.heldLead");
  expect(introLeadKey(true, true)).toBe("rightHand.intro.lead");
  expect(introLeadKey(false, false)).toBe("rightHand.intro.lead");
  const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  // A personal workspace reads its own sibling (ADR 0159), on both.
  for (const f of ["../../src/features/right-hand/Intro.tsx", "../../../web/src/components/RightHandIntro.tsx"])
    expect(src(f)).toContain("t(modeKey(org, introLeadKey(held, team.length > 0)))");
});

test("how agents should talk waits for the team's first answer, so it never stands beside the first task", () => {
  const base = { noAi: false, aiKnown: true, askStyle: true, checklist: "complete" as const };
  expect(introCards({ ...base, answered: false })).toEqual([]);
  expect(introCards({ ...base, answered: true })).toEqual(["style"]);
  const iara = agent({ id: "a-iara", name: "Iara" });
  const status = (agentId: string, activeAt: string | null) => ({ agentId, activeAt });
  // The team made, nobody of it worked yet (the right hand's own runs don't count): it waits.
  expect(teamAnswered([iara], [status("a-iara", null), status("a-lodi", at(0))])).toBe(false);
  expect(teamAnswered([iara], undefined)).toBe(false);
  // Iara answered the first task.
  expect(teamAnswered([iara], [status("a-iara", at(0))])).toBe(true);
  // No team: no first task to wait for.
  expect(teamAnswered([], undefined)).toBe(true);
  const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  for (const f of ["../../src/features/right-hand/Intro.tsx", "../../../web/src/components/RightHandIntro.tsx"])
    expect(src(f)).toContain("answered: useTeamAnswered(");
});

test("the phone's greeting draws the checklist and Conversas has one line back to it, not a second list", () => {
  const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");
  expect(src("right-hand/Intro.tsx")).toContain("<FirstRunCard agent={agent} channelId={channelId} />");
  expect(src("chats/ChatsScreen.tsx")).toContain("<FirstRunLine />");
  // One line that says who is setting up the team and how far ("Atlas is setting up the team · 1 of 3"); a personal
  // workspace's says "your agents" (ADR 0159).
  expect(src("chats/FirstRunLine.tsx")).toContain('t(modeKey(org, "mobile.chats.firstRunLine")');
  // The apps row names what it reads, as the web's does, never "Sem apps" with apps connected; an invitation waiting
  // finishes the people row, saying who; a personal workspace's rows read its own words (ADR 0159).
  const card = src("right-hand/FirstRun.tsx");
  expect(card).toContain("apps: appNames,");
  expect(card).toContain("invited: run.invited.length ? joinNames(run.invited, t) : null,");
  // As on the web: the AI row connects the whole team, the apps row is its own screen of suggested apps, a skip says
  // nothing, and an invitation only sent says so, the welcome kept for someone joining (ADR 0162).
  expect(card).toContain("openConnectAi(team.length > 0 ? {} : { agentId: agent.id })");
  expect(card).toContain('apps: () => openSetupStep(agent.id, "apps")');
  expect(card).toContain("firstRunBeats(doneHere, { members: run.members, invited: run.invited.length })");
  expect(card).toContain('? t("agentSetup.firstRun.say.invited")');
  expect(card).toContain(
    ": firstRunFact(facts, beat)\n          ? t(firstRunSayKey(beat, personal), agentGrammar(agent.name))",
  );
  // One first task, the team card's: the card's asks offer none.
  expect(card).not.toContain("firstTask");
  const steps = src("agents/setup/SetupStepScreen.tsx");
  expect(steps).toContain("firstRun ? <FirstRunAppsStep /> : <AppsStep agent={agent} />");
  expect(steps).toContain("firstRunAppList(");
  expect(steps).toContain('router.push({ pathname: "/connectors", params: { connect: def.id } })');
});

test("on a hold for its first plan the phone's card leads with the plan row: where to choose it, in words only", () => {
  const card = readFileSync(new URL("../../src/features/right-hand/FirstRun.tsx", import.meta.url), "utf8");
  // The row comes only while the workspace waits for its first plan (ADR 0162, amended 2026-11-10).
  expect(card).toContain('waitsForPlan: hold === "payment",');
  expect(card).toContain('plan: "play",');
  // No button and no way to pay from the phone (App Store 3.1.1): its line says where the plan is chosen, or who can.
  expect(card).toContain("plan: () => undefined,");
  expect(card).toContain('...(words.action && s !== "plan" && !(s === "about" && next === "about")');
  expect(card).toContain('b: t(mayPay ? "connectAi.billingWeb" : "standing.billing.askAdmin"),');
  // Any other hold has no plan row: the AI row says it, as before.
  expect(card).toContain('const holdLine = s === "ai" && state === "afterPlan" && !steps.includes("plan");');
  for (const banned of ["billingLink", "BillingLink", "planOffer", "plans.json"]) expect(card).not.toContain(banned);
});

test("Configurações lists no section for it: its settings open from its own profile, on their screen", () => {
  const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");
  expect(SETTINGS_SECTIONS.map((s) => s.id as string)).not.toContain("right_hand");
  expect(src("right-hand/SettingsScreen.tsx")).toContain('router.push("/settings/right-hand" as never)');
  expect(src("agents/AgentProfileScreen.tsx")).toContain("onPress: openRightHandSettings");
});

test("its DM, cards and profile treat it apart through the one shared helper", () => {
  const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");
  // No computer in its DM, and its own line; its field says "Mensagem para …" on one line, as every DM's.
  const chat = src("chat/ChatScreen.tsx");
  expect(chat).toContain("isRightHand(dmAgent)");
  expect(chat).not.toContain('t("rightHand.composerHint")');
  expect(chat).toMatch(/dmComputer = dmAgentId && !isThread && !rightHand/);
  // Never archived or deleted from the phone.
  expect(src("agents/AgentEditScreen.tsx")).toContain("admin && !rightHand");
  // No coordinator anywhere on the phone (ADR 0093, superseded by 0137).
  for (const f of [
    "agents/AgentEditScreen.tsx",
    "agents/edit.ts",
    "agents/AgentProfileScreen.tsx",
    "chat/ChannelMembers.tsx",
  ])
    expect(src(f)).not.toMatch(/coordinator/i);
});

test("it waves on the person's first visit only: its DM never read by them, on any device", () => {
  expect(firstVisitOf(undefined, lodi.id)).toBeUndefined();
  expect(firstVisitOf([dm(theo, 1)], lodi.id)).toBeUndefined();
  expect(firstVisitOf([{ ...dm(lodi, 1), everRead: false }], lodi.id)).toBe(true);
  expect(firstVisitOf([{ ...dm(lodi, 1), everRead: true }], lodi.id)).toBe(false);
  // An older server says nothing: no wave.
  expect(firstVisitOf([dm(lodi, 1)], lodi.id)).toBe(false);
  // Decided by the conversation, so the greeting moving into the list with the first message keeps it, not playing
  // again; under the greeting, decorative, playing once.
  const chat = readFileSync(new URL("../../src/features/chat/ChatScreen.tsx", import.meta.url), "utf8");
  expect(chat).toContain('useRightHandWave(orgId, rightHand && dmAgent ? dmAgent.id : "")');
  expect(
    chat.match(/<RightHandIntro agent=\{dmAgent\} channelId=\{channelId\} waveFrom=\{waveFrom\} \/>/g),
  ).toHaveLength(2);
  const intro = readFileSync(new URL("../../src/features/right-hand/Intro.tsx", import.meta.url), "utf8");
  expect(intro).toMatch(/mood="wave"[\s\S]*playFor=\{WAVE_SECONDS\}[\s\S]*from=\{waveFrom\}/);
  expect(intro).toContain('importantForAccessibility="no-hide-descendants"');
});

test("its wave moves, then ends on its still frame, so stopping shows no jump", () => {
  const look = { color: "teal", eyes: "happy", accessory: "headset" };
  const still = JSON.stringify(stickerFrame(look, "wave", 110, STICKER_STILL_T));
  expect(JSON.stringify(stickerFrame(look, "wave", 110, 0.1))).not.toBe(still);
  expect(JSON.stringify(stickerFrame(look, "wave", 110, WAVE_SECONDS))).toBe(still);
});

test("its profile tells where its name comes from only while it keeps it, and only for the right hand", () => {
  expect(tellsNameStory(lodi)).toBe(true);
  expect(tellsNameStory({ ...lodi, name: "Tuca" })).toBe(false);
  expect(tellsNameStory(agent({ id: "a-other", name: "Lodi" }))).toBe(false);
  expect(tellsNameStory(undefined)).toBe(false);
});
