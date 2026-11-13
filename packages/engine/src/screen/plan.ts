import type { ScreenKind } from "@agenteschat/adapters";
import type { Judge } from "../judge";
import { type ConditionResult, checkCondition, findDismiss, findInPage } from "./checks";
import {
  diffObservations,
  SCREEN_NOUN,
  type ScreenChanges,
  type ScreenElement,
  type ScreenImage,
  type ScreenObservation,
  type ScreenRegion,
  screenDigest,
  screenRef,
} from "./observation";
import { locateOnImage, resolveTarget, type TargetCache, type TargetUse } from "./targets";

/**
 * Plans (ADR 0054): several steps on a screen in one call of the agent's
 * model. Each step's target is resolved on the screen as it is at that
 * moment (so a plan can cross pages whose elements it never saw), acted on,
 * left to settle and, when the step says what it expects, checked. The plan
 * stops at the first step that fails or doesn't show what it expected, and
 * says what the screen looks like then. Surface-agnostic: the browser is one
 * surface, the agent's desktop another (ADR 0062).
 */

export type ScreenVerb =
  | "open"
  | "click"
  | "fill"
  | "select"
  | "check"
  | "uncheck"
  | "press"
  | "type_secret"
  | "scroll"
  | "hover"
  | "wait"
  | "back"
  | "read"
  | "focus"
  | "double_click"
  | "right_click"
  | "drag"
  | "type";

/** One step as the agent writes it. */
export interface ScreenStep {
  do: ScreenVerb;
  /** What to act on: an element's number (`e12`) or words ("the Sign in button"). */
  target?: string;
  text?: string;
  value?: string;
  url?: string;
  /** `open` on a desktop: an app (its name), or a file in the agent's home. */
  app?: string;
  path?: string;
  /** `drag`: where it is dropped, as a number or words like `target`. */
  to?: string;
  key?: string;
  secret?: string;
  /** `type_secret`: a Vault login's id (ADR 0144), typed instead of a named `secret`. */
  login?: string;
  /** `type_secret` of a code split in one box per character (ADR 0144): every box in order, instead of `target`. */
  targets?: string[];
  direction?: "up" | "down" | "left" | "right";
  pixels?: number;
  /** `wait`: until this is true on the screen (words), this text shows, or for this long. */
  until?: string;
  seconds?: number;
  /** `read`: what to get from the screen ("the order total"): only the lines that answer it. */
  find?: string;
  /** After the step, this should be true on the screen; the plan stops when it isn't. */
  expect?: string;
}

/** Where an action lands: an element, or a point found on an image (the surface's pixels). */
export type ActTarget = { ref: string } | { x: number; y: number };

const STEP_TEXT = [
  "target",
  "to",
  "app",
  "path",
  "url",
  "text",
  "value",
  "key",
  "secret",
  "login",
  "until",
  "find",
  "expect",
] as const;

/** A step from a model's input when its `do` is one of `verbs`; fields that aren't a step's are dropped. */
export function screenStepOf(v: unknown, verbs: readonly ScreenVerb[]): ScreenStep | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if (typeof s.do !== "string" || !(verbs as readonly string[]).includes(s.do)) return null;
  const out: ScreenStep = { do: s.do as ScreenVerb };
  for (const k of STEP_TEXT) if (typeof s[k] === "string") out[k] = s[k] as string;
  // A model that only has the tool's name guesses which of the two a field or an option takes.
  if (out.do === "fill" && out.value !== undefined) out.text ??= out.value;
  if (out.do === "select" && out.text !== undefined) out.value ??= out.text;
  if (s.direction === "up" || s.direction === "down" || s.direction === "left" || s.direction === "right") {
    out.direction = s.direction;
  }
  if (Array.isArray(s.targets)) {
    const boxes = s.targets.filter((t): t is string => typeof t === "string");
    if (boxes.length > 0) out.targets = boxes;
  }
  if (typeof s.pixels === "number") out.pixels = s.pixels;
  if (typeof s.seconds === "number") out.seconds = s.seconds;
  return out;
}

/**
 * The plan acts on the screen the agent last saw: a step acts before any `open`. After a person changed
 * the screen, such a plan waits until the agent looked at it again.
 */
export function actsBeforeOpening(steps: ScreenStep[]) {
  for (const s of steps) {
    if (s.do === "open") return false;
    if (s.do !== "read" && s.do !== "wait" && s.do !== "back") return true;
  }
  return false;
}

type Scroll = { kind: "scroll"; direction: "up" | "down" | "left" | "right"; pixels: number };

/**
 * A step resolved for the surface. A `type` or a `scroll` either has `at` or has no such key, so
 * `"at" in action` says it acts on an element or a point.
 */
export type ScreenAction =
  | { kind: "open"; url: string }
  | { kind: "launch"; app: string }
  | { kind: "open_file"; path: string }
  | { kind: "back" }
  | { kind: "click" | "double_click" | "right_click" | "hover" | "focus" | "check" | "uncheck"; at: ActTarget }
  | { kind: "drag"; from: ActTarget; to: ActTarget }
  | { kind: "fill"; at: ActTarget; text: string }
  | { kind: "type"; text: string }
  | { kind: "type"; text: string; at: ActTarget }
  | { kind: "select"; at: ActTarget; value: string }
  /** A named secret; `more`: the other boxes of a code split in one box per character, in order (ADR 0144). */
  | { kind: "type_secret"; at: { ref: string }; secret: string; more?: { ref: string }[] }
  /** A Vault login (ADR 0144): `url` is the page the field was found on, where the login is checked first. */
  | { kind: "type_secret"; at: { ref: string }; login: string; url: string | null }
  | { kind: "press"; key: string }
  | Scroll
  | (Scroll & { at: ActTarget })
  | { kind: "pause"; ms: number };

export type ScreenActOutcome =
  | {
      ok: true;
      observation: ScreenObservation | null;
      /** What was typed, as the report names it (the site a Vault login was typed for, ADR 0144): never a value. */
      typed?: string;
    }
  | { ok: false; error: string };

/** What a plan drives: looking, acting, and (when it can) taking an image. */
export interface ScreenSurface {
  /** Which of the agent's screens it is (default the browser): how plans word it and images are read. */
  kind?: ScreenKind;
  /** The screen now. */
  observe(): Promise<ScreenObservation>;
  /** One action; with `settle`, waits until the screen stops changing and looks again. */
  perform(action: ScreenAction, options: { settle: boolean }): Promise<ScreenActOutcome>;
  /**
   * An image of the screen with its elements marked, or null when this surface can't. With a `region`
   * (only when `regions` is set), that part of the screen at its native size.
   */
  capture?(region?: ScreenRegion): Promise<ScreenImage | null>;
  /** `capture` takes a region: a small target found on the image is looked at again up close. */
  regions?: boolean;
}

export interface PlanDeps {
  judge: Judge;
  orgId: string;
  agentId?: string | null;
  runId?: string;
  surface: ScreenSurface;
  cache?: TargetCache;
  /** Whose memory of targets this is (the agent's browser). */
  scope: string;
  signal?: AbortSignal;
  /** Before each step: why to stop now (a person took over the screen), or null. */
  hold?: () => Promise<string | null>;
  /** The screen as last seen, when it is fresh enough to resolve the first target on. */
  last?: ScreenObservation | null;
  /** What the agent last saw of this screen (what the report's changes are counted from). */
  before?: ScreenObservation | null;
  /** The judge may look at images (Jev's vision): the fallback for targets the text lacks. */
  vision?: boolean;
  /**
   * Something covering a target is closed once (a cookie banner) and the step runs again; default on.
   * Off on a desktop, where what covers is usually a real dialog ("Save changes?") whose buttons can
   * throw work away: the plan stops there and says what covers it.
   */
  dismiss?: boolean;
  /** How long an `expect` that isn't true yet may take to become true (default `EXPECT_GRACE_MS`). */
  expectGraceMs?: number;
  now?: () => number;
}

export type StepStatus = "done" | "failed" | "skipped";

export interface StepReport {
  step: ScreenStep;
  status: StepStatus;
  /** What happened, in a few words ("button "Sign in" (e7)", "not on the page"). */
  note?: string;
  /** The element acted on (for a drag, the one dragged). */
  element?: Pick<ScreenElement, "ref" | "role" | "name"> | null;
  /** How the target was found. */
  via?: "ref" | "exact" | "cache" | "judge" | "image";
  /** Another element closed first (a banner in the way). */
  dismissed?: string;
  /** The step's `expect`, as checked. */
  expected?: { met: boolean | null; p: number };
  /** Its action went through (a failed step with this only failed its `expect`: it must not be done again). */
  ran?: boolean;
  /** What a `type_secret` typed, by name (the site a Vault login was typed for, ADR 0144): never a value. */
  typed?: string;
  /** An `open` the site sent to another page than the one asked (a deep link it doesn't take). */
  landedElsewhere?: boolean;
  /** `read` with `find`: the lines that answer it (page text, untrusted), or why there are none. */
  found?: {
    question: string;
    text: string;
    answered: "yes" | "partly" | "no";
    searched?: { lines: number; of: number };
  };
  ms: number;
}

export interface PlanReport {
  /** The screen it ran on (default the browser). */
  kind?: ScreenKind;
  steps: StepReport[];
  /** The first step that didn't go through, and why. */
  stopped?: { index: number; reason: string; candidates?: ScreenElement[] };
  /** The screen before the plan and at its end (null when nothing was seen). */
  before: ScreenObservation | null;
  after: ScreenObservation | null;
  changes: ScreenChanges | null;
  ms: number;
}

const USES: Partial<Record<ScreenVerb, TargetUse>> = {
  click: "click",
  double_click: "click",
  right_click: "click",
  drag: "click",
  hover: "hover",
  focus: "window",
  fill: "fill",
  select: "select",
  check: "check",
  uncheck: "check",
  type_secret: "type_secret",
};

/** Steps that need a target (`type` and `scroll` act on one only when it is given). */
export const needsTarget = (step: ScreenStep) => step.do in USES;

const COVERED = /covered by|intercept|obscured|another element would receive/i;
const STALE = /stale|unknown ref|ref\b.*\b(not found|no longer|invalid)|no element (for|matches) ref/i;
/** Most boxes a code split in one box per character fills (ADR 0144). */
export const MAX_CODE_BOXES = 12;
/** Longest a `wait` step waits. */
export const MAX_WAIT_MS = 120_000;
const POLL_MS = 700;
/** A wait gives up after this many failed looks or judgments in a row. */
const WAIT_FAILURES = 3;
/**
 * An `expect` that isn't true yet gets up to this long to become true: a form
 * that navigates 300 ms after its submit, a message that shows when the
 * server answers. Looked at again every 300 ms, the judge only when the page
 * changed; it stops sooner when the page stays the same for `EXPECT_QUIET_MS`.
 */
export const EXPECT_GRACE_MS = 2000;
const EXPECT_QUIET_MS = 1000;
const EXPECT_POLL_MS = 300;

/** The plan stops here, for this reason (said to the agent). */
class Stop extends Error {
  constructor(
    readonly reason: string,
    readonly candidates?: ScreenElement[],
  ) {
    super(reason);
  }
}

/** The surface refused or failed an action: its own words. */
class ActFailed extends Error {}

const elementOf = (e: ScreenElement | null | undefined) => (e ? { ref: e.ref, role: e.role, name: e.name } : null);
/**
 * An element as the report names it: its role and number only. Names are page text, and page text
 * reaches the agent only inside the untrusted block (the screen part of the report, which has them).
 */
const quoted = (e: Pick<ScreenElement, "role" | "ref">) => `${e.role} (${e.ref})`;

type Found = { at: ActTarget; element: ScreenElement | null; via: NonNullable<StepReport["via"]> };

/** What a step that acts on elements acts on (one, or two for a drag), and its action on them. */
interface Targets {
  words: string[];
  use: TargetUse;
  act: (at: ActTarget[]) => ScreenAction;
}

/**
 * The page an `open` landed on is another one than asked: another site or path, past a `www.`, a trailing slash, a
 * language prefix, the query and the fragment. Opening a site's front page never counts (it may send to a language's own).
 */
export function landedElsewhere(asked: string, landed: string): boolean {
  const place = (u: string) => {
    try {
      const url = new URL(u);
      return { host: url.host.replace(/^www\./, ""), path: url.pathname.replace(/\/+$/, "") };
    } catch {
      return null;
    }
  };
  const a = place(asked);
  const b = place(landed);
  // A language or region put in front (`/docs` → `/en/docs`) is the same page.
  return Boolean(a && b && a.path !== "" && (a.host !== b.host || !b.path.endsWith(a.path)));
}

/** Runs `steps` in order on `deps.surface` (see the file's comment). */
export async function runPlan(deps: PlanDeps, steps: ScreenStep[]): Promise<PlanReport> {
  const now = deps.now ?? Date.now;
  const started = now();
  const kind = deps.surface.kind ?? "browser";
  const noun = SCREEN_NOUN[kind];
  const ids = { judge: deps.judge, orgId: deps.orgId, agentId: deps.agentId, runId: deps.runId };
  const reports: StepReport[] = steps.map((step) => ({ step, status: "skipped", ms: 0 }));
  let screen: ScreenObservation | null = deps.last ?? null;
  const before = deps.before ?? screen;
  let stopped: PlanReport["stopped"];
  let dismissedOnce = false;

  const look = async () => {
    screen = await deps.surface.observe();
    return screen;
  };
  /** After an action that went through: a look that fails doesn't undo the action (the next step looks again). */
  const lookAfter = async (seen: ScreenObservation | null) => {
    if (seen) {
      screen = seen;
      return;
    }
    screen = await deps.surface.observe().catch(() => null);
  };

  const settleOn = async (action: ScreenAction) => {
    const out = await deps.surface.perform(action, { settle: true });
    if (!out.ok) throw new ActFailed(out.error);
    await lookAfter(out.observation);
  };

  /**
   * A check the text left unsure, judged once more on an image of the screen when the judge sees
   * images: much only shows (a progress bar, a window that drew).
   */
  const onImage = async (
    r: ConditionResult,
    condition: string,
    observation: ScreenObservation,
    changes?: ScreenChanges,
  ): Promise<ConditionResult> => {
    if (r.met !== null || !deps.vision || !deps.surface.capture) return r;
    const image = await deps.surface.capture().catch(() => null);
    if (!image) return r;
    return checkCondition({ ...ids, condition, observation, changes, image }).catch(() => r);
  };

  async function runStep(step: ScreenStep, report: StepReport) {
    switch (step.do) {
      case "open": {
        const app = step.app?.trim();
        const path = step.path?.trim();
        if (app || path) {
          await settleOn(app ? { kind: "launch", app } : { kind: "open_file", path: path as string });
          report.note = app || path;
          return;
        }
        const url = (step.url ?? step.target ?? "").trim();
        if (!/^https?:\/\//i.test(url)) {
          throw new Stop(
            kind === "browser"
              ? "give a full address starting with https://"
              : "say which app (`app`) or file (`path`)",
          );
        }
        await settleOn({ kind: "open", url });
        report.note = url;
        if (kind === "browser" && screen?.url && landedElsewhere(url, screen.url)) report.landedElsewhere = true;
        return;
      }
      case "back":
        await settleOn({ kind: "back" });
        return;
      case "press":
        if (!step.key?.trim()) throw new Stop("say which key");
        await settleOn({ kind: "press", key: step.key.trim() });
        return;
      case "scroll":
      case "type":
        // Over or into an element when one is named; else wherever the screen is.
        if (step.target?.trim()) await targeted(step, report);
        else await settleOn(untargeted(step));
        return;
      case "wait":
        await waitStep(step, report);
        return;
      case "read":
        await readStep(step, report);
        return;
      default:
        await targeted(step, report);
    }
  }

  const scrollOf = (step: ScreenStep, at?: ActTarget): ScreenAction => {
    const scroll: Scroll = {
      kind: "scroll",
      direction: step.direction ?? "down",
      pixels: Math.min(10_000, Math.max(50, Math.round(step.pixels ?? 800))),
    };
    return at ? { ...scroll, at } : scroll;
  };

  /** A `scroll` or a `type` with no target. */
  function untargeted(step: ScreenStep): ScreenAction {
    if (step.do === "scroll") return scrollOf(step);
    if (!step.text) throw new Stop("say what to type (`text`)");
    return { kind: "type", text: step.text };
  }

  /** A look at the screen as a step: with `find`, only the lines that answer it go into the report. */
  async function readStep(step: ScreenStep, report: StepReport) {
    const current = await look();
    const question = step.find?.trim() || step.target?.trim();
    if (!question) {
      report.note = `the ${noun}`;
      return;
    }
    const found = await findInPage({ ...ids, question, observation: current });
    report.note = `"${question}"`;
    report.found = {
      question,
      text: found.text,
      answered: found.answered,
      ...(found.searched ? { searched: found.searched } : {}),
    };
  }

  async function waitStep(step: ScreenStep, report: StepReport) {
    const ms = Math.min(MAX_WAIT_MS, Math.max(0, Math.round((step.seconds ?? 30) * 1000)));
    const until = step.until?.trim();
    const text = step.text?.trim();
    if (!until && !text) {
      await deps.surface.perform({ kind: "pause", ms: Math.min(ms, 30_000) }, { settle: false });
      await lookAfter(null);
      return;
    }
    const deadline = now() + ms;
    let checked: string | null = null;
    let failures = 0;
    for (;;) {
      if (deps.signal?.aborted) throw new Stop("stopped");
      try {
        const current = await look();
        if (text && current.lines.some((l) => l.includes(text))) {
          report.note = `"${text}" showed`;
          return;
        }
        // The judge only looks again when the screen changed.
        const digest = screenDigest(current);
        if (until && digest !== checked) {
          const r = await onImage(
            await checkCondition({ ...ids, condition: until, observation: current }),
            until,
            current,
          );
          checked = digest;
          if (r.met === true) {
            report.note = `"${until}" is true`;
            return;
          }
        }
        failures = 0;
      } catch (error) {
        // A look or a judgment that failed once (a page loading, a slow answer) isn't the end of the wait.
        if (++failures >= WAIT_FAILURES) throw error;
      }
      if (now() + POLL_MS > deadline) throw new Stop(`waited ${Math.round(ms / 1000)} s and it didn't happen`);
      await deps.surface.perform({ kind: "pause", ms: POLL_MS }, { settle: false });
    }
  }

  /** Where `words` are on the screen (see the comments inside); `fresh`: never on the look kept from before. */
  async function find(words: string, use: TargetUse, fresh: boolean): Promise<Found> {
    // A number from the page needs no look: the surface checks it (a stale one fails and says so).
    const given = screenRef(words);
    if (given)
      return { at: { ref: given }, element: screen?.elements.find((e) => e.ref === given) ?? null, via: "ref" };
    const resolveOn = (observation: ScreenObservation) =>
      resolveTarget({ ...ids, target: words, use, observation, cache: deps.cache, scope: deps.scope });
    // A look kept from before may predate the target (seconds old): when it isn't there, look once more.
    const kept = fresh ? null : screen;
    let current = kept ?? (await look());
    let r = await resolveOn(current);
    if (!r.found && kept) {
      current = await look();
      r = await resolveOn(current);
    }
    if (r.found) return { at: { ref: r.ref }, element: r.element, via: r.via };
    // Not in the text (an icon without a name, a canvas): look at the screen itself.
    if (deps.vision && deps.surface.capture && use !== "type_secret") {
      const image = await deps.surface.capture().catch(() => null);
      if (image) {
        const spot = await locateOnImage({
          ...ids,
          target: words,
          image,
          url: current.url,
          kind,
          ...(deps.surface.regions
            ? { zoom: async (region: ScreenRegion) => (await deps.surface.capture?.(region)) ?? null }
            : {}),
        });
        if (spot.found) {
          const element = spot.ref ? (current.elements.find((e) => e.ref === spot.ref) ?? null) : null;
          return { at: spot.ref ? { ref: spot.ref } : { x: spot.x, y: spot.y }, element, via: "image" };
        }
        if (spot.refused) {
          throw new Stop(
            `found "${words}" only on the ${noun} image, not as an element: something that can't be undone isn't done at a bare spot. Do it another way (a menu, keys) or ask a person`,
          );
        }
      }
    }
    throw new Stop(
      r.reason === "unsure"
        ? `"${words}" could be more than one thing on the ${noun}`
        : r.reason === "unjudged"
          ? `couldn't match "${words}" to an element by its words here: give its number or its exact name (read the ${noun} for them)`
          : `couldn't find "${words}" on the ${noun}`,
      r.candidates,
    );
  }

  /** What `step` acts on and how, its fields checked first. */
  function targetsOf(step: ScreenStep): Targets {
    // A code split in one box per character names every box (ADR 0144); any other step one target.
    const boxes =
      step.do === "type_secret" ? (step.targets ?? []).map((t) => t.trim()).filter((t) => t.length > 0) : [];
    const words = boxes[0] ?? step.target?.trim();
    if (!words) throw new Stop("say what to act on (`target`)");
    if (step.do === "fill" && step.text === undefined) throw new Stop("say what to write (`text`)");
    if (step.do === "select" && !step.value?.trim()) throw new Stop("say which option (`value`)");
    if (step.do === "type_secret") {
      const login = step.login?.trim();
      const secret = step.secret?.trim();
      if (!login && !secret) throw new Stop("say which secret (`secret`) or Vault login (`login`)");
      if (login && secret) throw new Stop("give either `secret` or `login`, not both");
      if (login && boxes.length > 1) {
        throw new Stop("a Vault login goes into one password field: give its `target`, not `targets`");
      }
      if (boxes.length > MAX_CODE_BOXES) throw new Stop(`a code goes into at most ${MAX_CODE_BOXES} boxes`);
    }
    if (step.do === "type" && !step.text) throw new Stop("say what to type (`text`)");
    const to = step.to?.trim();
    if (step.do === "drag" && !to) throw new Stop("say where to drop it (`to`)");
    const one = (use: TargetUse, act: (at: ActTarget) => ScreenAction): Targets => ({
      words: [words],
      use,
      act: ([at]) => act(at as ActTarget),
    });
    switch (step.do) {
      case "fill":
        return one("fill", (at) => ({ kind: "fill", at, text: step.text ?? "" }));
      case "select":
        return one("select", (at) => ({ kind: "select", at, value: (step.value ?? "").trim() }));
      case "type_secret": {
        const login = step.login?.trim();
        return {
          words: boxes.length > 0 ? boxes : [words],
          use: "type_secret",
          act: (ats) => {
            const refs = ats.map((at) => {
              if (!("ref" in at)) throw new Stop(`a password goes only into a field found on the ${noun}`);
              return at;
            });
            const [first, ...more] = refs as [{ ref: string }, ...{ ref: string }[]];
            // The page the field was found on: the Vault checks the login's site against it before the value goes out.
            if (login) return { kind: "type_secret", at: first, login, url: screen?.url ?? null };
            return {
              kind: "type_secret",
              at: first,
              secret: (step.secret ?? "").trim(),
              ...(more.length > 0 ? { more } : {}),
            };
          },
        };
      }
      case "type":
        return one("click", (at) => ({ kind: "type", text: step.text ?? "", at }));
      case "scroll":
        return one("hover", (at) => scrollOf(step, at));
      case "drag":
        return {
          words: [words, to as string],
          use: "click",
          act: ([from, at]) => ({ kind: "drag", from: from as ActTarget, to: at as ActTarget }),
        };
      case "click":
      case "double_click":
      case "right_click":
      case "hover":
      case "focus":
      case "check":
      case "uncheck": {
        const verb = step.do;
        return one(USES[verb] as TargetUse, (at) => ({ kind: verb, at }));
      }
      default:
        throw new Stop(`can't ${step.do} a target`);
    }
  }

  async function targeted(step: ScreenStep, report: StepReport) {
    const { words, use, act } = targetsOf(step);
    // Each end of a drag is found on the screen as it is: the second on the look the first was found on.
    const findAll = async (fresh: boolean) => {
      const out: Found[] = [];
      for (const [i, w] of words.entries()) out.push(await find(w, use, fresh && i === 0));
      return out;
    };
    const noteOf = (f: Found) =>
      f.element ? quoted(f.element) : "ref" in f.at ? `element ${f.at.ref}` : `a spot on the ${noun}`;
    const describe = (found: Found[]) => {
      report.element = elementOf(found[0]?.element);
      const [first, last] = [found[0], found.at(-1)];
      report.note =
        step.do === "type_secret" && found.length > 1 && first && last
          ? `${found.length} boxes, ${noteOf(first)} to ${noteOf(last)}`
          : found.map(noteOf).join(" to ");
      report.via = found.some((f) => f.via === "image") ? "image" : found[0]?.via;
    };
    const perform = (found: Found[]) => deps.surface.perform(act(found.map((f) => f.at)), { settle: true });

    let found = await findAll(false);
    describe(found);
    let out = await perform(found);
    if (!out.ok && COVERED.test(out.error)) {
      // On a desktop, what covers it may be asking to save or discard work: never closed on a guess. The
      // report shows the screen as it is now, so what covers it (named only by its number) is in it.
      if (deps.dismiss === false) {
        screen = (await deps.surface.observe().catch(() => null)) ?? screen;
        throw new Stop(`${out.error}: nothing was done; deal with what covers it first`);
      }
      // Something covers it (a cookie banner, a dialog): close it once, then the step again.
      if (!dismissedOnce) {
        dismissedOnce = true;
        const current = await look();
        const close = await findDismiss({ ...ids, observation: current, covering: out.error });
        if (close) {
          const closed = await deps.surface.perform({ kind: "click", at: { ref: close.ref } }, { settle: true });
          if (closed.ok) {
            report.dismissed = quoted(close);
            await lookAfter(closed.observation);
            found = await findAll(false);
            out = await perform(found);
          }
        }
      }
    }
    // The screen changed since the target was found (its number went stale): find it again once.
    if (!out.ok && STALE.test(out.error) && found.some((f) => f.via !== "ref")) {
      found = await findAll(true);
      out = await perform(found);
    }
    if (!out.ok) throw new ActFailed(out.error);
    describe(found);
    if (out.typed) report.typed = out.typed;
    await lookAfter(out.observation);
  }

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] as ScreenStep;
    const report = reports[index] as StepReport;
    const t0 = now();
    try {
      if (deps.signal?.aborted) throw new Stop("stopped");
      const held = await deps.hold?.();
      if (held) throw new Stop(held);
      const prior: ScreenObservation | null = screen;
      await runStep(step, report);
      // The action went through; what follows only checks it.
      report.ran = true;
      if (step.expect?.trim()) {
        const condition = step.expect.trim();
        const judgeOn = (o: ScreenObservation) =>
          checkCondition({ ...ids, condition, observation: o, changes: diffObservations(prior, o) });
        let after = screen ?? (await look());
        let check = await judgeOn(after);
        // Not true yet: the page may still be on its way (a submit that navigates later, a server's answer).
        const until = now() + (deps.expectGraceMs ?? EXPECT_GRACE_MS);
        let judged = screenDigest(after);
        let changedAt = now();
        let failures = 0;
        while (check.met !== true && now() < until && now() - changedAt < EXPECT_QUIET_MS) {
          if (deps.signal?.aborted) throw new Stop("stopped");
          await deps.surface.perform({ kind: "pause", ms: EXPECT_POLL_MS }, { settle: false });
          try {
            after = await look();
            const digest = screenDigest(after);
            if (digest !== judged) {
              check = await judgeOn(after);
              // Judged once the judge answered (a failed judgment is asked again), and quiet counts from
              // then: nobody looked while it ran.
              judged = digest;
              changedAt = now();
            }
            failures = 0;
          } catch (error) {
            // A look or a judgment that failed once (the page navigating, a slow answer) isn't the end of the
            // grace, nor a quiet page.
            if (++failures >= WAIT_FAILURES) throw error;
            changedAt = now();
          }
        }
        check = await onImage(check, condition, after, diffObservations(prior, after));
        report.expected = check;
        if (check.met !== true) {
          throw new Stop(
            check.met === false
              ? `the ${noun} doesn't show "${condition}"`
              : `couldn't confirm "${condition}" on the ${noun}`,
          );
        }
      }
      report.status = "done";
    } catch (error) {
      report.status = "failed";
      const reason = error instanceof Error ? error.message : String(error);
      // A step that ran keeps saying what it did: only its check failed.
      if (!report.ran) report.note = report.note ? `${report.note}: ${reason}` : reason;
      stopped = {
        index,
        reason,
        ...(error instanceof Stop && error.candidates ? { candidates: error.candidates } : {}),
      };
    } finally {
      report.ms = now() - t0;
    }
    if (stopped) break;
  }
  const after: ScreenObservation | null = screen;
  return {
    ...(kind !== "browser" ? { kind } : {}),
    steps: reports,
    ...(stopped ? { stopped } : {}),
    before,
    after,
    changes: after ? diffObservations(before, after) : null,
    ms: now() - started,
  };
}
