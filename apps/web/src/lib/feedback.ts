import type { FeedbackAbout } from "@agenteschat/client";
import { loadedEntry } from "./app-version";
import { desktopPlatform } from "./desktop";

/*
 * What a feedback knows before the person types (ADR 0160): the thing they right-clicked, where the app is and what
 * went wrong in it lately. All of it is for whoever reads the email, so its labels are plain English and never shown
 * on screen.
 */

/** As the server takes it (`FEEDBACK_ABOUT_MAX`, `FEEDBACK_FACT_MAX`). */
export const ABOUT_MAX = 4000;
const FACT_MAX = 300;

/** What one feedback takes, as the server checks it (`FEEDBACK_FILES`). */
export const FILE_LIMITS = { imageMb: 5, videoMb: 50, images: 3, videos: 1, days: 30 } as const;

/** The thing a right click landed on: what the email names it, what it says, and where it sits in the page. */
export interface Reported {
  about: FeedbackAbout;
  /** Whether it is a message, whose author the form names. */
  message: boolean;
  facts: [string, string][];
}

const squeeze = (s: string) =>
  s
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
const textOf = (el: Element | null) => squeeze((el as HTMLElement | null)?.innerText ?? el?.textContent ?? "");

/** The page's own names down to `el`, outermost first: enough for someone with the code to find it. */
function pathOf(el: Element) {
  const parts: string[] = [];
  for (let at: Element | null = el; at && at !== document.body && parts.length < 7; at = at.parentElement) {
    const cls = typeof at.className === "string" ? at.className.trim().split(/\s+/)[0] : "";
    parts.unshift(cls ? `${at.tagName.toLowerCase()}.${cls}` : at.tagName.toLowerCase());
  }
  return parts.join(" > ").slice(0, FACT_MAX);
}

const BLOCKS =
  "[role='dialog'], article, .ac-card, [role='listitem'], li, [role='row'], tr, [role='tab'], [role='menuitem'], button, a, section";
const nameOf = (el: Element) => {
  const labelled = el.getAttribute("aria-labelledby");
  const byLabel = labelled ? textOf(document.getElementById(labelled.split(" ")[0] ?? "")) : "";
  return squeeze(
    el.getAttribute("aria-label") ?? (byLabel || textOf(el.querySelector("h1, h2, h3, h4, [role='heading']"))),
  ).slice(0, 120);
};

/**
 * What `target` is, for a feedback about it. A message says who wrote it and what it says; anything else its role,
 * its name and its words. `selected`: text the person had selected there, which is then all that is quoted.
 */
export function describeElement(target: EventTarget | null, selected = ""): Reported | null {
  if (!(target instanceof Element)) return null;
  // The row that carries the id first: a message drawn inside it would be found before it.
  const message = target.closest<HTMLElement>("[data-message-id]") ?? target.closest<HTMLElement>(".ac-msg");
  if (message) {
    const author = textOf(message.querySelector(".ac-msg__author"));
    const byAgent = message.matches(".ac-msg--agent") || message.querySelector(".ac-msg--agent") !== null;
    return {
      message: true,
      about: {
        kind: byAgent ? "agent message" : "message",
        ...(author ? { label: author } : {}),
        text: (selected || textOf(message.querySelector(".ac-msg__body") ?? message)).slice(0, ABOUT_MAX),
      },
      facts: [
        // A message the app draws by itself (a greeting) has no id.
        ...(message.dataset.messageId ? ([["Message id", message.dataset.messageId]] as [string, string][]) : []),
        ["Element", pathOf(target)],
      ],
    };
  }
  const block = target.closest(BLOCKS) ?? target;
  const kind = block.matches(".ac-card") ? "card" : (block.getAttribute("role") ?? block.tagName.toLowerCase());
  const label = nameOf(block);
  return {
    message: false,
    about: { kind, ...(label ? { label } : {}), text: (selected || textOf(block)).slice(0, ABOUT_MAX) },
    facts: [["Element", pathOf(target)]],
  };
}

/**
 * What a right click can report where nothing has a menu of its own: a message, a card, a dialog. Elsewhere (the
 * page's empty space, the sidebar) the browser keeps its menu.
 */
export const REPORTABLE = "[data-message-id], .ac-msg, .ac-card, [role='dialog'], article";

/* ---------- what went wrong lately ---------- */

const ERRORS_KEPT = 5;
const errors: string[] = [];
let watching = false;

const keep = (what: unknown) => {
  const text = what instanceof Error ? `${what.name}: ${what.message}` : String(what ?? "");
  if (!text) return;
  errors.push(`${new Date().toISOString().slice(11, 19)} ${squeeze(text).replace(/\n/g, " ").slice(0, 200)}`);
  if (errors.length > ERRORS_KEPT) errors.shift();
};

/** Keeps the app's last few errors in memory, for a feedback sent after them. Nothing leaves the page by itself. */
export function watchErrors() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  // Kept for the feedback's email, never shown on screen.
  window.addEventListener("error", (event) => keep(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => keep(event.reason));
}

export const recentErrors = () => [...errors];

/** The browser and the app, as far as the page knows them. */
export function deviceFacts(): [string, string][] {
  const desktop = desktopPlatform();
  const zone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    } catch {
      return "";
    }
  })();
  const facts: [string, string][] = [
    ["Build", loadedEntry() ?? ""],
    ["Browser", navigator.userAgent],
    ["Window", `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio || 1}x`],
    ["Theme", document.documentElement.dataset.theme ?? ""],
    ["Time zone", zone],
    ["Local time", new Date().toISOString()],
    ["Online", navigator.onLine ? "yes" : "no"],
    ...(desktop ? ([["Desktop app", desktop]] as [string, string][]) : []),
    ...(errors.length ? ([["Recent errors", errors.join(" | ")]] as [string, string][]) : []),
  ];
  return facts.filter(([, v]) => v !== "").map(([k, v]) => [k, v.slice(0, FACT_MAX)]);
}

/* ---------- opening the form from anywhere ---------- */

type Listener = () => void;
let open: { n: number; reported: Reported | null } | null = null;
let seq = 0;
const listeners = new Set<Listener>();
const tell = () => {
  for (const l of listeners) l();
};

/** Opens the feedback form, about `reported` when a right click chose something. */
export function openFeedback(reported: Reported | null = null) {
  open = { n: ++seq, reported };
  tell();
}
export function closeFeedback() {
  open = null;
  tell();
}
export const feedbackOpen = () => open;
export function onFeedbackOpen(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
