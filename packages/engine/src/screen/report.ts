import type { ScreenKind } from "@agenteschat/adapters";
import {
  clipLines,
  describeElement,
  SCREEN_NOUN,
  type ScreenChanges,
  type ScreenObservation,
  screenOverview,
} from "./observation";
import type { PlanReport, ScreenStep, ScreenVerb, StepReport } from "./plan";

/**
 * A plan's report as the agent reads it (ADR 0054): what was done, where it
 * stopped and why, and the screen at the end: what changed on it, or, on a
 * new page, what can be acted on. The agent rarely needs a separate read
 * after acting. A desktop's report says "screen" where a browser's says
 * "page" (ADR 0062).
 */

const DONE: Record<ScreenVerb, string> = {
  open: "Opened",
  click: "Clicked",
  fill: "Filled in",
  select: "Selected in",
  check: "Ticked",
  uncheck: "Unticked",
  press: "Pressed",
  type_secret: "Typed the secret into",
  scroll: "Scrolled",
  hover: "Hovered",
  wait: "Waited",
  back: "Went back",
  read: "Read",
  focus: "Focused",
  double_click: "Double-clicked",
  right_click: "Right-clicked",
  drag: "Dragged",
  type: "Typed",
};

/** One step in a few words ("click "the Sign in button""). */
export function stepLabel(step: ScreenStep, kind: ScreenKind = "browser"): string {
  switch (step.do) {
    case "open":
      return `open ${step.app ?? step.path ?? step.url ?? step.target ?? ""}`.trim();
    case "press":
      return `press ${step.key ?? ""}`.trim();
    case "scroll":
      return `scroll ${step.direction ?? "down"}${step.target ? ` over "${step.target}"` : ""}`;
    case "type":
      return step.target ? `type into "${step.target}"` : "type";
    case "drag":
      return `drag "${step.target ?? ""}" to "${step.to ?? ""}"`;
    case "wait":
      return step.until ? `wait until "${step.until}"` : step.text ? `wait for "${step.text}"` : "wait";
    case "back":
      return "back";
    case "read":
      return step.find || step.target ? `read "${step.find ?? step.target}"` : `read the ${SCREEN_NOUN[kind]}`;
    default:
      return `${step.do.replace("_", " ")} "${step.target ?? ""}"`;
  }
}

function stepLine(r: StepReport, kind: ScreenKind): string {
  const what =
    r.step.do === "press"
      ? `${DONE.press} ${r.step.key ?? ""}`
      : r.step.do === "scroll"
        ? `${DONE.scroll} ${r.step.direction ?? "down"}${r.note ? ` over ${r.note}` : ""}`
        : r.step.do === "type"
          ? `${DONE.type}${r.note ? ` into ${r.note}` : ""}`
          : r.step.do === "type_secret"
            ? r.step.login
              ? // The site it was typed for, never the login's title (ADR 0144 §4).
                `Typed the Vault login${r.typed ? ` for ${r.typed}` : ""} into ${r.note ?? "the field"}`
              : `${DONE.type_secret} ${r.note ?? "the field"} (${r.step.secret ?? ""})`
            : `${DONE[r.step.do]}${r.note ? ` ${r.note}` : ""}`;
  const extra = [
    r.dismissed ? `closed ${r.dismissed} first: it covered the ${SCREEN_NOUN[kind]}` : null,
    r.via === "image" ? "found on the screen image" : null,
    r.expected?.met === true ? `✓ ${JSON.stringify(r.step.expect?.trim() ?? "")}` : null,
  ].filter(Boolean);
  const line = `${what.trim()}${extra.length > 0 ? ` (${extra.join("; ")})` : ""}.`;
  return r.landedElsewhere ? `${line} ${LANDED_ELSEWHERE}` : line;
}

/** An `open` the site sent elsewhere: its own way in, not the address again. */
export const LANDED_ELSEWHERE =
  "The site sent you to another page (where you are now is below): it doesn't open that one by its address. Sign in if that is what it shows; otherwise get there through the site's own menus, links or search, not by trying more addresses.";

export interface FormattedReport {
  /** What was done and where it stopped (no page text). */
  summary: string;
  /** The screen at the end (page text: untrusted, wrapped by the caller), or null. */
  screen: string | null;
  /** The plan stopped before its end. */
  failed: boolean;
}

/** What changed, or the new page's controls, at most `max` characters. */
export function describeScreen(
  after: ScreenObservation | null,
  changes: ScreenChanges | null,
  options: { maxChanges?: number; maxOverview?: number; overview?: boolean; kind?: ScreenKind } = {},
): string | null {
  if (!after) return null;
  const kind = options.kind ?? "browser";
  const noun = SCREEN_NOUN[kind];
  const head = after.url
    ? `${kind === "browser" ? "Now at" : "Now in"} ${after.url}${after.title ? ` — ${after.title}` : ""}`
    : null;
  if (!changes || changes.newPage || options.overview) {
    const { text, omitted } = screenOverview(after, options.maxOverview ?? 6000);
    const rest = omitted > 0 ? `\n[${omitted} more lines: read the ${noun} for its text]` : "";
    return [
      head,
      `${changes?.newPage === false ? `On the ${noun}` : `New ${noun}`}: what you can act on`,
      text || "(nothing to act on)",
    ]
      .filter(Boolean)
      .join("\n")
      .concat(rest);
  }
  if (changes.added.length === 0 && changes.removed.length === 0) {
    return [head, `Nothing changed on the ${noun}.`].filter(Boolean).join("\n");
  }
  const lines = [...changes.added.map((l) => `+ ${l.trim()}`), ...changes.removed.map((l) => `- ${l.trim()}`)];
  const { text, omitted } = clipLines(lines, options.maxChanges ?? 3500);
  return [
    head,
    `Changed on the ${noun} (+ new, - gone):`,
    text,
    omitted > 0 ? `[${omitted} more changes: read the ${noun} to see it all]` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The report for the agent (see the file's comment). */
export function formatPlanReport(r: PlanReport): FormattedReport {
  const kind = r.kind ?? "browser";
  const noun = SCREEN_NOUN[kind];
  const done = r.steps.filter((s) => s.status === "done");
  const out: string[] = [];
  // The closest elements are page text: listed with the page (untrusted), only pointed at here.
  const candidates = r.stopped?.candidates ?? [];
  const closest =
    candidates.length > 0 ? `The closest elements on the ${noun} are listed below: name one by its number.` : null;
  const closestList =
    candidates.length > 0
      ? `Closest on the ${noun}:\n${candidates.map((c) => `- ${describeElement(c, 160)} [${c.ref}]`).join("\n")}`
      : null;
  // The step that stopped the plan ran, and only its check failed: say it was done, so it isn't done twice.
  const stoppedStep = r.stopped ? (r.steps[r.stopped.index] as StepReport) : null;
  const ranButUnconfirmed = stoppedStep?.ran
    ? `${stepLine({ ...stoppedStep, expected: undefined }, kind).replace(/\.$/, "")}, but ${r.stopped?.reason}. It was done: don't do it again; look at what the ${noun} shows.`
    : null;
  if (r.steps.length === 1) {
    const only = r.steps[0] as StepReport;
    if (ranButUnconfirmed) out.push(ranButUnconfirmed);
    else if (r.stopped) out.push(`Couldn't ${stepLabel(only.step, kind)}: ${r.stopped.reason}`);
    else out.push(stepLine(only, kind));
    if (closest) out.push(closest);
  } else {
    if (r.stopped) {
      const n = r.stopped.index + 1;
      const at = stepLabel((stoppedStep as StepReport).step, kind);
      out.push(
        ranButUnconfirmed
          ? `Stopped after step ${n} of ${r.steps.length} (${at}): ${ranButUnconfirmed}`
          : `Stopped at step ${n} of ${r.steps.length} (${at}): ${r.stopped.reason}`,
      );
      if (closest) out.push(closest);
      out.push(
        done.length > 0 ? `Done before it: ${done.length} step${done.length > 1 ? "s" : ""}.` : "Nothing was done.",
      );
    } else out.push(`Done: all ${r.steps.length} steps.`);
    done.forEach((s, i) => {
      out.push(`${i + 1}. ${stepLine(s, kind)}`);
    });
  }
  // What `read` steps found goes with the page (it is page text), before what changed on it.
  const found = r.steps
    .filter((s) => s.status === "done" && s.found)
    .map((s) => {
      const f = s.found as NonNullable<StepReport["found"]>;
      const part = f.searched ? ` (searched ${f.searched.lines} of the ${noun}'s ${f.searched.of} lines)` : "";
      if (f.answered === "no" || !f.text) return `Nothing on the ${noun} answers "${f.question}"${part}.`;
      return `Where the ${noun} answers "${f.question}"${f.answered === "partly" ? " (maybe only in part)" : ""}${part}:\n${f.text}`;
    });
  // A page just opened shows what can be acted on there, even when it is the page the agent saw before.
  const opened = done.at(-1)?.step.do === "open";
  const screen = describeScreen(r.after, r.changes, { overview: opened, kind });
  const parts = [closestList, ...found, screen].filter((p): p is string => Boolean(p));
  return {
    summary: out.join("\n"),
    screen: parts.length > 0 ? parts.join("\n\n") : null,
    failed: Boolean(r.stopped),
  };
}
