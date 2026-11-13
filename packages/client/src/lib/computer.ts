import type { TFunction } from "i18next";
import { useSyncExternalStore } from "react";
import type { ComputerSetup, ComputerSetupStep, Edition, Machine } from "../api/types";
import { type ComputerState, computerKind, machineTitle } from "./machines";

/** "Pronto" stays this long before the step line goes away. */
export const READY_FLASH_MS = 1500;

// ── The workspace's own computer (ADR 0056 §10) ─────────────────────────────

/**
 * Which words the computers get: the Cloud's where a provisioner prepares each workspace's own computer
 * (`computer-setup` says `external`), self-host's where people connect theirs (`pair`); before a workspace
 * exists, `workspaceComputer` (`auth-config`) says the same. Null while loading: no edition's words show then.
 * `/api/health`'s edition isn't it: the Cloud runs the self-host image.
 */
export function computerEdition(setup: ComputerSetup | null | undefined, workspaceComputer?: boolean): Edition | null {
  const external = setup ? setup.mode === "external" : workspaceComputer;
  return external === undefined ? null : external ? "cloud" : "selfhost";
}

/** The provisioner's steps, in order (`computerSetup.step.*`). */
export const SETUP_STEPS: readonly ComputerSetupStep[] = ["reserving", "starting", "installing", "connecting"];

/**
 * What the computer is doing within a step, where that has words of its own (`computerSetup.stage.*`), by the step
 * it belongs to. A stage its step already says (`starting`, `apps`, `connecting`), one under another step, or one
 * this app doesn't know yet reads as its step.
 */
export const SETUP_STAGES = {
  ordering: "reserving",
  wiping: "starting",
  booting: "installing",
  updating: "installing",
  restarting: "installing",
  network: "installing",
  firewall: "installing",
} as const satisfies Record<string, ComputerSetupStep>;
type SetupStage = keyof typeof SETUP_STAGES;

/** `paused`: the workspace is on hold, and waits for no computer until it is active again. */
export type SetupPhase = "preparing" | "waiting" | "problem" | "ready" | "paused";
/** What a line or a chip says: the phase, or why it waits. */
type SetupStatus = Exclude<SetupPhase, "waiting"> | "capacity";

/** The workspace's own computer as every screen says it (onboarding, notice, Computers, the agent's page, phone). */
export interface SetupView {
  phase: SetupPhase;
  /** While preparing: the step, and its number from 1 (0 before the provisioner names one). */
  step: ComputerSetupStep | null;
  stepNumber: number;
  /** While waiting: `capacity` (no computer on its way yet). */
  reason: "capacity" | null;
  /** The status line: the stage within the step when it has words, else the step, else the phase. */
  textKey:
    | `computerSetup.stage.${SetupStage}`
    | `computerSetup.step.${ComputerSetupStep}`
    | `computerSetup.status.${SetupStatus}`;
  /** The short word for a chip. */
  chipKey: `computerSetup.chip.${SetupStatus}`;
  /** `computerSetup.specs`'s values ("4 CPUs · 8 GB…"), once the provisioner said. */
  specs: ComputerSetup["specs"];
  /** The computer itself, once made (its page). */
  machineId: string | null;
  /** Since when (ms) it is in this phase, when the server says. */
  since?: number | null;
  /** The server's seconds left when its answer came (`receivedAt`, this device's clock); null: no time said. */
  secondsLeft: number | null;
  receivedAt: number;
  /** Seconds people had waited when the server answered, on the server's clock; null when it doesn't say. */
  waited: number | null;
  /** The server sends email (`promisesEmail`). */
  notifyByEmail: boolean;
}

/**
 * Null where people connect their own computers (`pair`), or before the server answers: nothing to show.
 * `receivedAt`: when the answer came, on this device's clock (the time left counts down from it).
 */
export function setupView(setup: ComputerSetup | null | undefined, receivedAt = Date.now()): SetupView | null {
  if (setup?.mode !== "external") return null;
  // The server says no state only for a workspace that isn't active and has no ready computer.
  const phase: SetupPhase = setup.state ?? "paused";
  const step = phase === "preparing" && setup.step && SETUP_STEPS.includes(setup.step) ? setup.step : null;
  const stage = setup.stage as SetupStage | null | undefined;
  // Every wait reads as capacity: an older server's `approval` too.
  const status: SetupStatus = phase === "waiting" ? "capacity" : phase;
  const secondsLeft = typeof setup.secondsLeft === "number" ? setup.secondsLeft : null;
  return {
    phase,
    step,
    stepNumber: step ? SETUP_STEPS.indexOf(step) + 1 : 0,
    reason: phase === "waiting" ? "capacity" : null,
    textKey:
      step && stage && SETUP_STAGES[stage] === step
        ? `computerSetup.stage.${stage}`
        : step
          ? `computerSetup.step.${step}`
          : `computerSetup.status.${status}`,
    chipKey: `computerSetup.chip.${status}`,
    specs: setup.specs,
    machineId: setup.machineId,
    since: setup.since ? Date.parse(setup.since) : null,
    secondsLeft,
    receivedAt,
    waited: typeof setup.secondsWaited === "number" ? Math.max(0, setup.secondsWaited) : null,
    notifyByEmail: setup.notifyByEmail === true,
  };
}

/**
 * The team's playful lines while the computer is prepared (`computerSetup.lines.<said>.<agent>`), keyed by what the
 * status line says (`setupView`): its stage when it has words, else its step. Each line names one of the
 * onboarding's agents, by the handle the onboarding gives it.
 */
const SETUP_LINES = {
  reserving: ["atlas", "theo", "lia"],
  ordering: ["ada", "atlas", "theo"],
  wiping: ["ada", "atlas", "lia"],
  starting: ["atlas", "ada", "theo"],
  booting: ["ada", "atlas", "theo"],
  updating: ["lia", "ada", "theo"],
  restarting: ["ada", "atlas", "theo"],
  network: ["lia", "atlas", "theo"],
  firewall: ["atlas", "lia", "theo"],
  installing: ["theo", "lia", "ada"],
  connecting: ["ada", "atlas", "lia"],
} as const satisfies Record<SetupStage | ComputerSetupStep, readonly string[]>;
type Said = keyof typeof SETUP_LINES;
type SetupLineKey = { [S in Said]: `computerSetup.lines.${S}.${(typeof SETUP_LINES)[S][number]}` }[Said];
/** The lines that give the computer's memory: left out until its size is known. */
const MEMORY_LINES: readonly SetupLineKey[] = ["computerSetup.lines.ordering.ada", "computerSetup.lines.booting.ada"];

/**
 * The lines for where it is now, in order, each with the agent it names: only an agent on the team; none while it
 * isn't being prepared within a step.
 */
export function setupLines<A extends { handle: string }>(view: SetupView, team: readonly A[]) {
  const said = (view.step ? view.textKey.slice(view.textKey.lastIndexOf(".") + 1) : null) as Said | null;
  const named: readonly string[] = said ? SETUP_LINES[said] : [];
  return named.flatMap((handle) => {
    const agent = team.find((a) => a.handle === handle);
    const key = `computerSetup.lines.${said}.${handle}` as SetupLineKey;
    return agent && (view.specs || !MEMORY_LINES.includes(key)) ? [{ key, agent }] : [];
  });
}

/** The time left as the preparing screens say it (`computerSetup.eta.*`). */
export type EtaView =
  | { kind: "minutes"; count: number }
  | { kind: "underMinute" }
  | { kind: "almost" }
  | { kind: "late" };

/**
 * The time left now: the server's `secondsLeft` less the seconds since its answer came. Run out, it says a little
 * longer than expected until the computer is ready: the server never moves a wait's time later. Else almost ready
 * in the last step (`last`), whole minutes rounded up from a minute, less than a minute under that. Null without
 * a time.
 */
export function etaView(secondsLeft: number | null, receivedAtMs: number, nowMs: number, last = false): EtaView | null {
  if (secondsLeft === null) return null;
  const left = secondsLeft - Math.max(0, (nowMs - receivedAtMs) / 1000);
  if (left <= 0) return { kind: "late" };
  if (last) return { kind: "almost" };
  return left >= 60 ? { kind: "minutes", count: Math.ceil(left / 60) } : { kind: "underMinute" };
}

/** "About 6 min left", "Almost ready…" (`computerSetup.eta.*`). */
export const etaLine = (t: TFunction, eta: EtaView) =>
  eta.kind === "minutes" ? t("computerSetup.eta.minutes", { count: eta.count }) : t(`computerSetup.eta.${eta.kind}`);

/** Only while it is being prepared: a wait and a problem have no time. */
export const setupEta = (view: SetupView, nowMs: number) =>
  view.phase === "preparing"
    ? etaView(view.secondsLeft, view.receivedAt, nowMs, view.step === SETUP_STEPS.at(-1))
    : null;

/** How often every time line repaints, all together. No ticking seconds. */
const ETA_TICK_MS = 5_000;

/**
 * One clock for every time line on screen (the notice, the setup, the computer's window, the agent's page): one
 * that shows up later reads the time the others read, and they all move on together, so two of them never say two
 * different times. It runs only while one is shown.
 */
const etaClock = {
  now: Date.now(),
  shown: new Set<() => void>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
};

function showEta(repaint: () => void) {
  if (etaClock.shown.size === 0) {
    etaClock.now = Date.now();
    etaClock.timer = setInterval(() => {
      etaClock.now = Date.now();
      for (const shown of etaClock.shown) shown();
    }, ETA_TICK_MS);
  }
  etaClock.shown.add(repaint);
  return () => {
    etaClock.shown.delete(repaint);
    if (etaClock.shown.size === 0) clearInterval(etaClock.timer);
  };
}

const hidden = () => () => {};

/** The time every time line reads now (`shown`: one is on screen, so the clock moves). */
export const useEtaNow = (shown: boolean) => useSyncExternalStore(shown ? showEta : hidden, () => etaClock.now);

/**
 * Whether "we'll email you" holds: the server sends email, and the wait is or will be over a minute, which
 * is when it emails the owners once the computer is ready: more than a minute left when it answered,
 * waiting or a problem, or a minute gone since people started waiting (with no time said, only that).
 */
export function promisesEmail(view: SetupView, nowMs: number): boolean {
  if (!view.notifyByEmail || view.phase === "ready") return false;
  if (view.phase === "waiting" || view.phase === "problem") return true;
  if (view.secondsLeft !== null && view.secondsLeft > 60) return true;
  return view.waited !== null && view.waited + Math.max(0, nowMs - view.receivedAt) / 1000 > 60;
}

/**
 * What the setup query keeps when an answer arrives: one asked before a `machine.provisioning` event and back
 * after it never undoes that event (`since`, when the state began, only moves forward while the workspace keeps
 * its computer).
 */
export function newerSetup(cached: ComputerSetup | undefined, fetched: ComputerSetup): ComputerSetup {
  if (!cached?.since || !fetched.since) return fetched;
  return Date.parse(fetched.since) < Date.parse(cached.since) ? cached : fetched;
}

/** The portrait: lit once ready and online, dimmed while on its way, dark when stuck or offline. */
export function setupPortrait(view: SetupView, online: boolean): ComputerState {
  if (view.phase === "ready") return online ? "online" : "offline";
  return view.phase === "problem" ? "offline" : "paused";
}

/**
 * Its one-line status (no step yet) only restates its chip: in line, or being prepared before a step. A problem or a
 * hold says more than its chip (what happens, why).
 */
export const statusRestatesChip = (view: SetupView) =>
  view.step === null && (view.phase === "waiting" || view.phase === "preparing");

/** The notice's title ("Preparando o computador da Acme"): in line nothing is prepared yet, so its name alone. */
export const setupNoticeTitleKey = (view: SetupView) =>
  view.phase === "waiting" ? "computerSetup.title" : "computerSetup.notice.title";

/**
 * The notice's status line under its title: the step, else the phase, except before a step while it is prepared,
 * where "Preparando o computador." would only say the title again. Null then.
 */
export const setupNoticeStatusKey = (view: SetupView) =>
  view.phase === "preparing" && view.step === null ? null : view.textKey;

/** On its way: the notice, the waiting agents and the onboarding's progress show. */
export const setupPending = (view: SetupView | null): view is SetupView =>
  view !== null && view.phase !== "ready" && view.phase !== "paused";

/**
 * The agents waiting for the workspace's computer: those no computer lists. Its first hello gives it to every
 * agent without one (ADR 0056 §10).
 */
export function agentsWaitingForComputer<A extends { id: string }>(
  agents: readonly A[],
  machines: readonly Pick<Machine, "agents">[],
): A[] {
  const placed = new Set(machines.flatMap((m) => m.agents.map((a) => a.id)));
  return agents.filter((a) => !placed.has(a.id));
}

/** What a closed notice remembers: the same state stays closed, a new state (or step) shows again. */
export const setupNoticeKey = (orgId: string, view: SetupView) =>
  `${orgId}:${view.phase}:${view.step ?? view.reason ?? ""}`;

/** The workspace's own computer's portrait, before and after it exists: a server (its OS reads `other`). */
export const WORKSPACE_COMPUTER_KIND = computerKind("other");

/**
 * The names the server gives the workspace's own computer (`managedMachineName`), in each language its first owner
 * may speak: a team's names its workspace (`computerSetup.title`, `{{org}}` its name), a personal workspace's (ADR
 * 0158) its person's agents (`computerSetup.titlePersonal`). The apps load one language at a time, so they are kept
 * here as the translations say them, compared and never shown; a test keeps them in step with packages/i18n.
 */
export const GIVEN_COMPUTER_NAMES = {
  team: [
    "{{org}}'s computer",
    "Computador da {{org}}",
    "Computadora de {{org}}",
    "Ordinateur de {{org}}",
    "Computer von {{org}}",
    "Computer di {{org}}",
    "Computer van {{org}}",
    "{{org}}のコンピューター",
    "{{org}}의 컴퓨터",
    "{{org}} 的电脑",
    "Komputer {{org}}",
    "{{org}} bilgisayarı",
    "Komputer przestrzeni {{org}}",
    "Компьютер {{org}}",
  ],
  personal: [
    "Your agents' computer",
    "Computador dos seus agentes",
    "Computadora de tus agentes",
    "Ordinateur de vos agents",
    "Computer deiner Agenten",
    "Computer dei tuoi agenti",
    "Computer van je agents",
    "エージェントのコンピューター",
    "내 에이전트의 컴퓨터",
    "你的智能体的电脑",
    "Komputer agen-agenmu",
    "Ajanlarınızın bilgisayarı",
    "Komputer twoich agentów",
    "Компьютер ваших агентов",
  ],
} as const;

const givenNames = (orgName: string): string[] => [
  ...GIVEN_COMPUTER_NAMES.team.map((name) => name.replace("{{org}}", () => orgName)),
  ...GIVEN_COMPUTER_NAMES.personal,
];

/**
 * The agent's computer as this reader calls it. The workspace's own keeps the name it got in its first owner's
 * language (mirrors `managedMachineName` in packages/engine/src/machine-provisioning.ts) until someone renames
 * it: until then it reads in the reader's words, as before it exists, in the workspace's mode (a name given in the
 * other mode reads as this one's too). Any other computer goes by its own name, and the server's own, until its
 * runner names it, by what it is. `personal`: the workspace is personal (ADR 0159), where its own computer is its
 * person's agents' (`computerSetup.titlePersonal`), never "Personal's computer".
 */
export function computerName(
  t: TFunction,
  orgName: string,
  machine: Pick<Machine, "kind" | "name"> | null | undefined,
  personal = false,
): string {
  const ours = personal ? t("computerSetup.titlePersonal") : t("computerSetup.title", { org: orgName });
  if (!machine) return ours;
  if (machine.kind !== "managed") return machineTitle(machine, t("machines.host.label"));
  return givenNames(orgName).includes(machine.name) ? ours : machine.name;
}

/** A computer known only by its name, for `computerName`: the workspace's own reads in the reader's words. */
export const managedNamed = (c: { name: string } | null | undefined) =>
  c ? { kind: "managed" as const, name: c.name } : null;

/** `computerName` where a list carries only a computer's name. */
export const computerNameOf = (t: TFunction, orgName: string, name: string, personal = false) =>
  computerName(t, orgName, managedNamed({ name }), personal);

export type NoComputer = "workspace" | "none";

/**
 * What an agent's "no computer" choice (`machineId` null) stands for in a picker: `workspace` while the
 * workspace's own computer is on its way (the agents with none get it); else `none`, shown only for an agent that
 * has none (picking it would leave an agent with no computer). Null: not offered.
 */
export function noComputerChoice(view: SetupView | null, current: boolean): NoComputer | null {
  if (setupPending(view)) return "workspace";
  return current ? "none" : null;
}
