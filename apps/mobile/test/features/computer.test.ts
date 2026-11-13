import { describe, expect, test } from "bun:test";
import type { BrowserHandoff, ComputerSetup } from "@agenteschat/client";
import {
  type AgentComputerFacts,
  type EntryWords,
  entryLine,
  entryState,
  liveSubLine,
} from "@agenteschat/client/lib/agent-computer";
import {
  type SetupView,
  setupEta,
  setupNoticeStatusKey,
  setupNoticeTitleKey,
  setupView,
  statusRestatesChip,
} from "@agenteschat/client/lib/computer";
import { clockAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { resources } from "@agenteschat/i18n";
import { bannedIn, CLOUD_BANNED } from "../../../../packages/i18n/test/edition-words";
import { offersKeyNow, pollsPlan } from "../../src/features/ai/logic";
import { pageGapKey, stepText } from "../../src/features/browser/logic";
import {
  offersSwitch,
  phoneEntryButton,
  phoneStage,
  setupNoticeLine,
  setupSub,
} from "../../src/features/computer/logic";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";
import { missionComputerKey, missionComputerText } from "../../src/features/missions/logic";
import { translator } from "./fixtures";

/** The phone's own words a Cloud workspace shows where its computer is named. */
const CLOUD_KEYS = [
  "browser.live.unavailable.offlineCloudF",
  "browser.live.unavailable.offlineCloudM",
  "browser.live.closedHelpF",
  "browser.live.closedHelpM",
  "outage.titleCloud",
  "outage.a11yCloud",
  "outage.cloudSub",
  "mission.computerOn",
  "mission.computerNotAnswering",
  "mission.computerNotAnsweringPlain",
] as const;

const at = (strings: object, path: string) =>
  path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], strings);

describe("the agent's computer on the phone: its words by edition", () => {
  test("the Cloud's computer isn't answering where self-host's is offline", async () => {
    expect(pageGapKey("offline", "F", true)).toBe("mobile.browser.live.unavailable.offlineCloudF");
    expect(pageGapKey("offline", "M", false)).toBe("mobile.browser.live.unavailable.offlineM");
    expect(pageGapKey("closed", "F", true)).toBe("mobile.browser.live.unavailable.closedF");
    const t = await translator("pt-BR");
    expect(t(pageGapKey("offline", "F", true), { name: "Ada" })).toBe(
      "O computador da Ada não está respondendo agora.",
    );
    expect(t(pageGapKey("offline", "M", false), { name: "Theo" })).toBe("O computador do Theo está offline.");
    const en = await translator("en");
    expect(en(pageGapKey("offline", "F", true), { name: "Ada" })).toBe("Ada's computer isn't answering right now.");
    expect(en(pageGapKey("offline", "F", false), { name: "Ada" })).toBe("Ada's computer is offline.");
  });

  test("a mission's computer on the Cloud isn't answering, never off", async () => {
    expect(missionComputerKey(false, true)).toBe("mobile.mission.computerNotAnswering");
    expect(missionComputerKey(false, false)).toBe("mobile.mission.computerOff");
    expect(missionComputerKey(true, true)).toBe("mobile.mission.computerOn");
    const t = await translator("pt-BR");
    expect(t(missionComputerKey(false, true), { name: "Computador da Acme" })).toBe(
      "Computador da Acme · sem resposta",
    );
    const en = await translator("en");
    expect(en(missionComputerKey(false, true), { name: "Acme's computer" })).toBe("Acme's computer · not answering");
  });

  test("a mission's computer by name only where the workspace has more than one; else only when it isn't working", async () => {
    const t = await translator("pt-BR");
    const acme = { name: "Computador da Acme", online: true };
    const mac = { name: "MacBook do Walter", online: false };
    expect(missionComputerText(t, mac, { cloud: false, names: true })).toBe("MacBook do Walter · desligado");
    expect(missionComputerText(t, acme, { cloud: true, names: false })).toBeNull();
    expect(missionComputerText(t, { ...acme, online: false }, { cloud: true, names: false })).toBe(
      "Computador sem resposta",
    );
    expect(missionComputerText(t, mac, { cloud: false, names: false })).toBe("Computador desligado");
    const en = await translator("en");
    expect(missionComputerText(en, mac, { cloud: false, names: false })).toBe("Computer off");
  });

  test("a closed browser keeps its sign-ins and promises no reopening", async () => {
    for (const lng of ["pt-BR", "en"] as const) {
      const t = await translator(lng);
      for (const g of ["F", "M"]) expect(t(`mobile.browser.live.closedHelp${g}`)).not.toMatch(/Abre quando|opens when/);
    }
    expect((await translator("pt-BR"))("mobile.browser.live.closedHelpF")).toBe(
      "Os logins continuam salvos para a próxima vez.",
    );
    expect((await translator("en"))("mobile.browser.live.closedHelpM")).toBe("Logins stay saved for next time.");
  });

  test("the phone's own Cloud words name no off, pairing, cloud or terminal", () => {
    for (const [lng, keys] of [
      ["pt-BR", featureKeysPtBR],
      ["en", featureKeysEn],
    ] as const) {
      expect(CLOUD_KEYS.filter((k) => typeof at(keys, k) !== "string")).toEqual([]);
      const hits = CLOUD_KEYS.flatMap((k) => bannedIn(String(at(keys, k)), CLOUD_BANNED[lng]).map((w) => `${k}: ${w}`));
      expect(hits).toEqual([]);
    }
  });

  test("the profile's section and its row are the web's words, so the phone keeps no key of its own", () => {
    for (const keys of [featureKeysPtBR, featureKeysEn]) {
      expect(at(keys, "browser.profile")).toBeUndefined();
    }
    expect(at(resources["pt-BR"].translation, "agentComputer.button")).toBe("Computador");
    expect(at(resources["pt-BR"].translation, "agentComputer.title")).toBe("Computador do {{name}}");
  });
});

const NOW = Date.parse("2026-10-24T21:05:00.000Z");
const ACME = { name: "Computador da Acme", online: true, lastSeenAt: "2026-10-24T14:05:00.000Z", paused: null };

/** Desk on the workspace's own computer (the Cloud's), its screen and browser ready, nothing going on. */
const facts = (over: Partial<AgentComputerFacts> = {}): AgentComputerFacts => ({
  edition: "cloud",
  held: false,
  setup: null,
  machine: ACME,
  desktop: { available: true, reason: null },
  browser: true,
  browserGranted: true,
  handoff: null,
  userId: "me",
  working: false,
  ...over,
});

const request = (over: Partial<BrowserHandoff> = {}): BrowserHandoff => ({
  id: "h1",
  agentId: "desk",
  runId: "r1",
  machineId: "m1",
  screen: "browser",
  kind: "ask",
  instructions: "Entrar no gov.br",
  status: "pending",
  requestedForUserId: null,
  controllerUserId: null,
  note: null,
  expiresAt: new Date(NOW + 4 * 60_000).toISOString(),
  createdAt: new Date(NOW - 60_000).toISOString(),
  resolvedAt: null,
  ...over,
});

const external = (patch: Partial<ComputerSetup> = {}): ComputerSetup => ({
  mode: "external",
  state: "preparing",
  step: "installing",
  reason: null,
  since: "2026-10-24T21:00:00.000Z",
  requestedAt: "2026-10-24T21:00:00.000Z",
  expectedReadyAt: null,
  secondsLeft: 330,
  secondsWaited: 300,
  notifyByEmail: true,
  specs: null,
  machineId: null,
  ...patch,
});
const viewOf = (patch: Partial<ComputerSetup> = {}) => setupView(external(patch), NOW) as SetupView;
/** The workspace's computer on its way, the agent without one. */
const waiting = (over: Partial<AgentComputerFacts> = {}) =>
  facts({ setup: viewOf(), machine: null, desktop: null, browser: false, ...over });

describe("the agent's computer full screen on the phone: what its stage shows", () => {
  test("the screen where the web shows it; the page where there is none, or for a person in the browser", () => {
    expect(phoneStage(facts())).toBe("screen");
    expect(phoneStage(facts({ working: true }))).toBe("screen");
    expect(phoneStage(facts({ browser: false }))).toBe("screen");
    // A computer without screens (a Mac): the page.
    expect(phoneStage(facts({ desktop: { available: false, reason: "not_allowed" } }))).toBe("page");
    // This person in the agent's browser: its page, whatever else the computer serves.
    expect(phoneStage(facts({ handoff: request({ status: "active", controllerUserId: "me" }) }))).toBe("page");
    // A request on the screen, whoever holds it: the screen.
    expect(
      phoneStage(facts({ handoff: request({ screen: "desktop", status: "active", controllerUserId: "me" }) })),
    ).toBe("screen");
  });

  test("held or on its way first, then why nothing shows, in the web's order", () => {
    expect(phoneStage(waiting())).toBe("preparing");
    expect(phoneStage(waiting({ held: true }))).toBe("held");
    expect(phoneStage(facts({ machine: { ...ACME, online: false } }))).toBe("offline");
    // Asleep in standby: it opens as it wakes, like one about to say its first hello.
    expect(phoneStage(facts({ machine: { ...ACME, online: false, standby: true } }))).toBe("joining");
    // Ready, and the agent gets it at its next hello: a moment more.
    expect(phoneStage(facts({ machine: null, desktop: null, browser: false }))).toBe("joining");
    expect(phoneStage(facts({ edition: "selfhost", machine: null, desktop: null, browser: false }))).toBe("noComputer");
    const neither = { desktop: { available: false, reason: "no_desktop" }, browser: false, browserGranted: false };
    expect(phoneStage(facts(neither))).toBe("noScreen");
    expect(phoneStage(facts({ desktop: { available: false, reason: "runner_outdated" }, browser: false }))).toBe(
      "unavailable",
    );
  });

  test("the screen's steps in its words", async () => {
    const en = await translator("en");
    expect(stepText(en, { tool: "desktop_click", detail: null }, "desktop")).toBe("Clicked");
    expect(stepText(en, { tool: "mcp__agentes__desktop_open", detail: "Files" }, "desktop")).toBe("Opened Files");
    expect(stepText(en, { tool: "desktop_open", detail: null }, "desktop")).toBe("Opened an app");
    expect(stepText(en, { tool: "desktop_something_new", detail: null }, "desktop")).toBe("Used the screen");
  });

  test("its header says each thing once: live alone under a banner, who holds it over a page that hides", async () => {
    const pt = await translator("pt-BR");
    const words = { name: "Ada", person: (id: string) => (id === "u-joao" ? "João" : "?"), nowMs: NOW };
    // A hold, or a request waiting: the banner (or the page) says it.
    expect(liveSubLine(pt, facts({ held: true }), words)).toBe("Ao vivo");
    expect(liveSubLine(pt, facts({ handoff: request({ screen: "desktop" }) }), words)).toBe("Ao vivo");
    // Someone else in control: the header says who, and the page only why nothing shows.
    const joao = request({ status: "active", controllerUserId: "u-joao", kind: "takeover", expiresAt: null });
    expect(liveSubLine(pt, facts({ handoff: joao }), words)).toBe("João no controle");
    expect(pt("browser.inCard.hiddenHelp", agentGrammar("Ada"))).toBe(
      "Por privacidade, a tela fica oculta até voltar para a Ada.",
    );
    const card = await Bun.file(new URL("../../src/features/browser/BrowserCard.tsx", import.meta.url).pathname).text();
    expect(card).toContain('? t("browser.inCard.hiddenHelp", agentGrammar(name))');
  });
});

describe("the profile's Computador entry on the phone", () => {
  test("Help for a request of this person's, in the agent's browser or on its screen", () => {
    expect(phoneEntryButton(entryState(facts({ handoff: request() }), NOW))).toBe("help");
    const screenAsk = entryState(facts({ handoff: request({ screen: "desktop" }) }), NOW);
    expect(screenAsk.kind).toBe("needsYou");
    expect(phoneEntryButton(screenAsk)).toBe("help");
    // A request for someone else, and no computer (the phone has no picker): Open.
    expect(phoneEntryButton(entryState(facts({ handoff: request({ requestedForUserId: "ana" }) }), NOW))).toBe("open");
    const none = entryState(facts({ edition: "selfhost", machine: null, desktop: null, browser: false }), NOW);
    expect(none.kind).toBe("noComputer");
    expect(phoneEntryButton(none)).toBe("open");
  });

  test("the web's status line, in each edition's words", async () => {
    const t = await translator("pt-BR");
    const words: EntryWords = {
      edition: "cloud",
      locale: "pt-BR",
      computer: "Computador da Acme",
      lastSeenAt: ACME.lastSeenAt,
      person: () => "Ana",
      step: null,
      emailPromised: false,
      now: new Date(NOW),
    };
    const offline = facts({ machine: { ...ACME, online: false } });
    expect(entryLine(t, entryState(offline, NOW), words)).toBe("Sem resposta · já estamos cuidando");
    // Asleep in standby, nothing is wrong: it wakes when wanted.
    const asleep = facts({
      machine: { ...ACME, online: false, standby: true },
      desktop: { available: false, reason: "offline" },
      browser: false,
    });
    expect(entryLine(t, entryState(asleep, NOW), words)).toBe("Disponível · ninguém usando agora");
    expect(entryLine(t, entryState({ ...offline, edition: "selfhost" }, NOW), { ...words, edition: "selfhost" })).toBe(
      `Offline desde ${clockAt("pt-BR", ACME.lastSeenAt, new Date(NOW))}`,
    );
    expect(entryLine(t, entryState(waiting(), NOW), words)).toBe("Sendo preparado · faltam uns 6 min");
    expect(entryLine(t, entryState(waiting({ held: true }), NOW), words)).toBe("Em pausa por enquanto");
    expect(entryLine(t, entryState(facts({ handoff: request() }), NOW), words)).toBe(
      "Precisa de você · Entrar no gov.br · 4 min",
    );
    // The phone hears no run here: at work, it says only that.
    expect(entryLine(t, entryState(facts({ working: true }), NOW), words)).toBe("Trabalhando");
    // Nothing to show: why, never a bare "can't show it now".
    const cant = (reason: string, over: Partial<AgentComputerFacts> = {}, w = words) =>
      entryLine(t, entryState(facts({ desktop: { available: false, reason }, browser: false, ...over }), NOW), w);
    expect(cant("runner_outdated")).toBe("Sendo atualizado · volta sozinho");
    expect(cant("desktop_unavailable")).toBe("O Computador da Acme ainda não mostra telas");
    expect(cant("no_computer", { machine: null })).toBe("Sendo preparado");
    // A self-hoster's own computer: its switches are theirs to turn on, its program theirs to update.
    const own: EntryWords = { ...words, edition: "selfhost", computer: "Box" };
    expect(cant("not_allowed", { edition: "selfhost" }, own)).toBe("Telas desligadas no Box");
    expect(cant("no_desktop", { edition: "selfhost", browserReason: "switched_off" }, own)).toBe(
      "Navegador desligado no Box",
    );
    expect(cant("runner_outdated", { edition: "selfhost" }, own)).toBe("Precisa de uma atualização no Box");
  });

  test("no Trocar computador on the Cloud: there is no other computer there", () => {
    expect(offersSwitch({ edition: "cloud" }, true, true)).toBe(false);
    expect(offersSwitch({ edition: "selfhost" }, true, true)).toBe(true);
    // Only for who manages the agents, and only for a computer that went offline with them waiting.
    expect(offersSwitch({ edition: "selfhost" }, false, true)).toBe(false);
    expect(offersSwitch({ edition: "selfhost" }, true, false)).toBe(false);
  });
});

describe("the workspace's computer on its way, on Conversas", () => {
  test("its notice: the time left, else where it is; waiting for a computer, the email for those who get it", async () => {
    const t = await translator("pt-BR");
    const view = viewOf();
    const wait = viewOf({ state: "waiting", step: null, reason: "capacity", secondsLeft: null });
    // Titled as the web's: being prepared once it is, its name alone while in line, where nothing is yet.
    expect(t(setupNoticeTitleKey(view), { org: "Acme" })).toBe("Preparando o computador da Acme");
    expect(t(setupNoticeTitleKey(wait), { org: "Acme" })).toBe("Computador da Acme");
    expect(setupNoticeLine(t, view, setupEta(view, NOW), true)).toBe("Faltam uns 6 min");
    expect(setupNoticeLine(t, wait, setupEta(wait, NOW), false)).toBe("Esperando um computador disponível");
    expect(setupNoticeLine(t, wait, setupEta(wait, NOW), true)).toBe(
      "Esperando um computador disponível. Avisamos por e-mail.",
    );
    // On hold no time is said: where it is instead.
    expect(setupNoticeLine(t, view, null, false)).toBe("Instalando os programas");
    // Before a step, "Preparando o computador." would only say the title again: no line.
    const early = viewOf({ state: "preparing", step: null, secondsLeft: null });
    expect(t(setupNoticeTitleKey(early), { org: "Acme" })).toBe("Preparando o computador da Acme");
    expect(setupNoticeLine(t, early, null, true)).toBeNull();
    expect(setupNoticeStatusKey(early)).toBeNull();
    expect(setupNoticeStatusKey(wait)).toBe("computerSetup.status.capacity");
    const source = await Bun.file(
      new URL("../../src/features/computer/SetupWait.tsx", import.meta.url).pathname,
    ).text();
    expect(source).toContain("{line ? (");
  });

  test("the full screen's header says the chip's word: being prepared, in line or a problem", async () => {
    const t = await translator("pt-BR");
    expect(setupSub(t, viewOf())).toBe("Sendo preparado");
    expect(setupSub(t, viewOf({ state: "waiting", step: null, reason: "capacity", secondsLeft: null }))).toBe(
      "Na fila",
    );
    expect(setupSub(t, viewOf({ state: "problem", step: null, secondsLeft: null }))).toBe("Com problema");
    const en = await translator("en");
    expect(setupSub(en, viewOf({ state: "waiting", step: null, reason: "capacity", secondsLeft: null }))).toBe(
      "In line",
    );
  });

  test("under that header the wait names nothing and says no status the header says (`said`), as on the web", async () => {
    const source = await Bun.file(
      new URL("../../src/features/computer/SetupWait.tsx", import.meta.url).pathname,
    ).text();
    // Its title is the computer's name, in every state, and only where no header names it; a personal workspace's
    // is its person's agents' computer (ADR 0159).
    expect(source).toContain('const name = t(modeKey(wait, "computerSetup.title"), { org: wait.org });');
    expect(source).toContain("mode: workspaceModeOf(org),");
    expect(source).toContain('t(modeKey(org, setupNoticeTitleKey(view)), { org: org?.name ?? "" })');
    expect(source).not.toContain("computerSetup.notice.title");
    expect(source).toContain("{said ? null : (");
    // In line, or being prepared before a step: the header's word already says it.
    expect(source).toContain(") : said && statusRestatesChip(view) ? null : (");
    expect(statusRestatesChip(viewOf({ state: "waiting", step: null, reason: "capacity", secondsLeft: null }))).toBe(
      true,
    );
    expect(statusRestatesChip(viewOf({ state: "preparing", step: null, secondsLeft: null }))).toBe(true);
    expect(statusRestatesChip(viewOf({ state: "problem", step: null, secondsLeft: null }))).toBe(false);
    const screen = await Bun.file(
      new URL("../../src/features/computer/ComputerScreen.tsx", import.meta.url).pathname,
    ).text();
    expect(screen).toContain("<SetupWait view={f.setup} said />");
  });

  test("the AI step offers an API key now in every wait, a page away on the phone, but not on hold", () => {
    const wait = viewOf({ state: "waiting", step: null, reason: "capacity", secondsLeft: null });
    for (const view of [viewOf(), wait, viewOf({ state: "problem", step: null, secondsLeft: null })]) {
      expect(offersKeyNow({ state: "preparing", view }, false)).toBe(true);
      expect(offersKeyNow({ state: "preparing", view }, true)).toBe(false);
    }
    // Ready, its agent getting it at the next refresh: seconds, nothing to offer.
    expect(offersKeyNow({ state: "preparing", view: null }, false)).toBe(false);
    // A billing hold: a key is no way around it.
    expect(offersKeyNow({ state: "billing", hold: "payment" }, true)).toBe(false);
    // Where the plan can't sign in there: as before.
    expect(offersKeyNow({ state: "offline" }, false)).toBe(true);
    expect(offersKeyNow({ state: "missing" }, false)).toBe(true);
    expect(offersKeyNow({ state: "unsupported", reason: "keys" }, false)).toBe(true);
    // On a hold no key runs, and the line says the hold.
    for (const gate of [{ state: "offline" }, { state: "unsupported", reason: "keys" }] as const)
      expect(offersKeyNow(gate, true)).toBe(false);
    expect(offersKeyNow({ state: "ready" }, false)).toBe(false);
    expect(offersKeyNow({ state: "loading" }, false)).toBe(false);
    expect(offersKeyNow({ state: "locked", who: "owner" }, false)).toBe(false);
  });

  test("a plan's page asks again only while it waits on something no event may bring", () => {
    for (const edition of ["cloud", "selfhost"] as const) {
      expect(pollsPlan({ state: "preparing", view: null }, edition)).toBe(true);
      expect(pollsPlan({ state: "offline" }, edition)).toBe(true);
      expect(pollsPlan({ state: "loading" }, edition)).toBe(true);
      expect(pollsPlan({ state: "ready" }, edition)).toBe(false);
      expect(pollsPlan({ state: "missing" }, edition)).toBe(false);
      expect(pollsPlan({ state: "locked", who: "owner" }, edition)).toBe(false);
      // A program not allowed there waits for someone.
      expect(pollsPlan({ state: "unsupported", reason: "tool_off" }, edition)).toBe(false);
    }
    // The Cloud's computer installing or updating a program comes back by itself; a self-hosted one waits for its person.
    expect(pollsPlan({ state: "unsupported", reason: "not_installed" }, "cloud")).toBe(true);
    expect(pollsPlan({ state: "unsupported", reason: "runner_old" }, "cloud")).toBe(true);
    expect(pollsPlan({ state: "unsupported", reason: "not_installed" }, "selfhost")).toBe(false);
    expect(pollsPlan({ state: "unsupported", reason: "not_reported" }, "selfhost")).toBe(true);
  });
});

describe("the agent's computer, from the app's own pieces", () => {
  const read = (path: string) => Bun.file(new URL(`../../src/features/${path}`, import.meta.url).pathname).text();

  test("actions ride the screen's capsule; a request is the chat's card; Agora is the live trail", async () => {
    const [screen, page, cover] = await Promise.all([
      read("computer/AgentScreen.tsx"),
      read("computer/ComputerScreen.tsx"),
      read("computer/Cover.tsx"),
    ]);
    // Taking control, the keyboard, laying it down and the way out: on the capsule, never loose in a corner.
    expect(screen).toContain("{docked ? <EdgeDock>{dock}</EdgeDock> : null}");
    expect(screen).not.toContain("styles.padTurn");
    expect(screen).toContain("<DockDone label={doneLabel} loading={finishing} onPress={handBack} />");
    // The request for help: the chat's card with Ajudar and Agora não, not a gray line over the screen.
    expect(screen).toContain("<AskCard");
    expect(screen).not.toContain("agentComputer.ask.banner");
    // What it did: the browser's trail, live; and the chat's composer to it.
    expect(screen).toContain("<LiveTrail steps={steps} color={color} now={now} />");
    expect(screen).toContain("<Composer");
    // The header is the conversation's glass pill.
    expect(page).toContain("<HeaderPill");
    // A state with nothing live says itself on the screen, with no card inside it (glass only over a live picture).
    expect(cover.slice(cover.indexOf("const screen = ("))).not.toContain("<Glass");
  });
});
