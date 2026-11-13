import { randomUUID } from "node:crypto";
import type { ScreenKind } from "@agenteschat/adapters";
import type { Judge, JudgeAnswer, JudgeBox, JudgeQuestion } from "../judge";
import {
  describeElement,
  type ScreenElement,
  type ScreenImage,
  type ScreenObservation,
  type ScreenRegion,
  screenRef,
} from "./observation";

/**
 * Targets in words (ADR 0054): the agent says "the Sign in button" instead of
 * reading the screen and copying a number. Code finds it, cheapest first:
 *
 * 1. a ref (`e12`) as given;
 * 2. one element whose name is exactly the words (no judge);
 * 3. what the same words found on this site before (the target cache);
 * 4. the judge picks among the screen's elements (a Choice over refs, plus
 *    whether it's there at all);
 * 5. on an image of the screen, when the text has nothing that fits (`locate`).
 *
 * The judge only points at something already on the screen; it never decides
 * whether the agent may act.
 */

/** What an action needs its target to be: only fitting elements are offered. */
export type TargetUse = "click" | "fill" | "select" | "check" | "type_secret" | "upload" | "hover" | "window";

const FIELDS = new Set(["textbox", "searchbox", "combobox", "spinbutton", "textarea"]);
const ROLES: Partial<Record<TargetUse, ReadonlySet<string>>> = {
  fill: FIELDS,
  type_secret: new Set(["textbox"]),
  select: new Set(["combobox", "listbox"]),
  check: new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]),
};
/** Controls, as opposed to text with a ref (a heading "Sign in" next to the button "Sign in"). */
const CONTROLS = new Set([
  ...FIELDS,
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
  "listbox",
  "slider",
  "treeitem",
]);

export type TargetFound = {
  found: true;
  ref: string;
  element: ScreenElement | null;
  via: "ref" | "exact" | "cache" | "judge";
  confidence: number;
};
export type TargetMissing = {
  found: false;
  /** `unsure`: several fit; `absent`: nothing on the screen fits; `unjudged`: no calibrated judge answered. */
  reason: "unsure" | "absent" | "unjudged";
  candidates: ScreenElement[];
};
export type TargetResult = TargetFound | TargetMissing;

/** What a target's words found on a site, to find it again without the judge. */
export interface TargetMemory {
  role: string;
  name: string;
  /** Where it sat (its named containers): it is found again only there ("Delete" in the row for invoice 42). */
  context: string[];
  /** The judge found it can't be undone: it is never taken from memory. */
  costly?: boolean;
}

/** In-process memory of targets per agent and site (LRU). */
export interface TargetCache {
  get(key: string): TargetMemory | undefined;
  set(key: string, value: TargetMemory): void;
}

export function createTargetCache(max = 2000): TargetCache {
  const map = new Map<string, TargetMemory>();
  return {
    get(key) {
      const v = map.get(key);
      if (v) {
        map.delete(key);
        map.set(key, v);
      }
      return v;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value as string);
    },
  };
}

/** Words as targets and names are compared: lowercase, no accents or quotes, single spaces. */
export const normalizeWords = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/["'`“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The page a target belongs to, with ids in the path generalized (`/orders/:id`). */
export function pageKey(url: string | null): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((p) => (/^\d+$|^[0-9a-f-]{8,}$|^[A-Za-z0-9_-]{20,}$/i.test(p) ? ":id" : p))
      .join("/");
    return `${u.host}${path}`;
  } catch {
    return url.slice(0, 200);
  }
}

export const targetKey = (scope: string, url: string | null, use: TargetUse, words: string) =>
  `${scope}|${pageKey(url)}|${use}|${normalizeWords(words)}`;

const WINDOWS = new Set(["window", "dialog", "alertdialog"]);
/**
 * A panel's button for a window (`button "Files - Thunar" [window, ref=e3]`): read from the attributes
 * right after the quoted name, so a name with "[window]" in it can't pass for one.
 */
const WINDOW_BUTTON = /^-\s+button(?:\s+"(?:[^"\\]|\\.)*")?\s*\[(?:[^\]]*?,\s*)?window\s*[,\]]/;

const fits = (use: TargetUse, e: ScreenElement) =>
  use === "window" ? WINDOWS.has(e.role) || WINDOW_BUTTON.test(e.line) : (ROLES[use]?.has(e.role) ?? true);

/** The elements an action may target, best guesses first when there are too many for one question. */
function candidatesFor(words: string, use: TargetUse, o: ScreenObservation, max: number): ScreenElement[] {
  const fitting = o.elements.filter((e) => fits(use, e));
  // Only a window is brought to the front: with none on the screen, nothing else stands in.
  const pool = fitting.length > 0 || use === "window" ? fitting : o.elements;
  if (pool.length <= max) return pool;
  const terms = normalizeWords(words)
    .split(" ")
    .filter((t) => t.length > 1);
  const scored = pool.map((e) => {
    const text = normalizeWords(`${e.role} ${e.name} ${e.context.join(" ")}`);
    return { e, score: terms.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0) };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.e.index - b.e.index)
    .slice(0, max)
    .map((s) => s.e)
    .sort((a, b) => a.index - b.index);
}

/** The one element with exactly these words as its name (and a fitting role), if there is exactly one. */
function exactMatch(words: string, use: TargetUse, o: ScreenObservation): ScreenElement | null {
  const w = normalizeWords(words.replace(/^(the|o|a|os|as)\s+/i, ""));
  if (!w) return null;
  const same = o.elements.filter((e) => fits(use, e) && normalizeWords(e.name) === w);
  if (same.length === 1) return same[0] as ScreenElement;
  // The same name on a heading and a button: the button is what one acts on.
  const controls = same.filter((e) => CONTROLS.has(e.role));
  if (controls.length === 1) return controls[0] as ScreenElement;
  // `button "Save"` written out.
  const m = /^([a-z]+)\s+"(.+)"$/i.exec(words.trim());
  if (m) {
    const role = (m[1] as string).toLowerCase();
    const name = normalizeWords(m[2] as string);
    const hits = o.elements.filter((e) => e.role.toLowerCase() === role && normalizeWords(e.name) === name);
    if (hits.length === 1) return hits[0] as ScreenElement;
  }
  return null;
}

/** The one element with the remembered role, name and place; none or several: the judge decides again. */
function fromMemory(memory: TargetMemory, o: ScreenObservation): ScreenElement | null {
  const place = memory.context.join(" › ");
  const same = o.elements.filter(
    (e) => e.role === memory.role && e.name === memory.name && e.context.join(" › ") === place,
  );
  return same.length === 1 ? (same[0] as ScreenElement) : null;
}

const memoryOf = (e: ScreenElement): TargetMemory => ({ role: e.role, name: e.name, context: e.context });

/** Most options one Choice offers (Jev takes 255, one is "none"). */
const MAX_OPTIONS = 200;
/** The judge's pick is taken from this probability, this far ahead of the next one. */
export const PICK_AT = 0.55;
const PICK_MARGIN = 0.2;
/**
 * An element whose wrong pick costs (it pays, deletes, sends, throws work away): the judge must be this
 * sure, else the closest ones go back to the agent, which picks by number.
 */
export const COSTLY_PICK_AT = 0.85;
/**
 * Whether acting on the target can't be undone, asked of the judge with the pick: a screen in any language reads
 * the same. No answer is a yes.
 */
const COSTLY: JudgeQuestion = {
  type: "noul",
  instructions:
    "Would acting on `target` pay, delete, send or do something else that can't be undone? A plain Yes or OK in a dialog that asks for such a thing does what the dialog asks.",
  criteria: {
    true: "It pays, buys, deletes, discards, empties, overwrites, replaces, sends, transfers, uninstalls, formats, cancels an account or a plan, closes without saving, or confirms one of these.",
    false: "It can be undone, or only opens, shows, selects or types something.",
  },
};
const costlyOf = (answers: Record<string, JudgeAnswer>) => (answers.costly?.noul ?? 1) >= 0.5;
/** Below this, nothing on the screen is it. */
const ABSENT_BELOW = 0.3;

export interface ResolveInput {
  judge: Judge;
  orgId: string;
  agentId?: string | null;
  runId?: string;
  /** The ref or the words, as the agent gave them. */
  target: string;
  use: TargetUse;
  observation: ScreenObservation;
  cache?: TargetCache;
  /** Who the cache is for (the agent's browser): one agent's sites never steer another's. */
  scope: string;
}

/** Finds the element the agent means (see the file's comment for the order). */
export async function resolveTarget(input: ResolveInput): Promise<TargetResult> {
  const { observation: o } = input;
  const ref = screenRef(input.target);
  if (ref) {
    return {
      found: true,
      ref,
      element: o.elements.find((e) => e.ref === ref) ?? null,
      via: "ref",
      confidence: 1,
    };
  }
  const words = input.target.trim();
  const exact = exactMatch(words, input.use, o);
  if (exact) return { found: true, ref: exact.ref, element: exact, via: "exact", confidence: 1 };
  const key = targetKey(input.scope, o.url, input.use, words);
  const remembered = input.cache?.get(key);
  const again = remembered ? fromMemory(remembered, o) : null;
  // A costly one (delete, pay) is never taken from memory: its place is kept only in part (row text cut short).
  if (again && !remembered?.costly) return { found: true, ref: again.ref, element: again, via: "cache", confidence: 1 };

  const candidates = candidatesFor(words, input.use, o, MAX_OPTIONS);
  if (candidates.length === 0) return { found: false, reason: "absent", candidates: [] };
  const criteria: Record<string, string> = {};
  for (const e of candidates) criteria[e.ref] = describeElement(e);
  criteria.none = "None of these elements is it.";
  const questions: Record<string, JudgeQuestion> = {
    which: {
      type: "choice",
      instructions:
        "An agent is working on `screen` and wants to act on `target`. Which element is the one it means? Judge by what each element is, its name and where it sits.",
      criteria,
    },
    present: {
      type: "noul",
      instructions: "Is `target` one of the elements on `screen`?",
      criteria: {
        true: "One element on the screen is clearly what `target` describes.",
        false: "Nothing on the screen is what `target` describes, or it can't be told apart from others.",
      },
    },
    costly: COSTLY,
  };
  let answers: Record<string, JudgeAnswer>;
  try {
    answers = await input.judge.ask({
      orgId: input.orgId,
      agentId: input.agentId,
      runId: input.runId,
      kind: "screen_target",
      // The pick is taken on its probabilities (the margin, 0.85 for costly ones): only a calibrated
      // judge answers. The cheap model would say 1 to anything.
      calibrated: true,
      state: {
        target: words,
        action: input.use,
        screen: { address: o.url, elements: candidates.map((e) => `${e.ref}: ${describeElement(e)}`).join("\n") },
      },
      questions,
    });
  } catch {
    // No calibrated judge (or it failed): the closest by their words go back, and the agent picks by number.
    return { found: false, reason: "unjudged", candidates: closestByWords(words, candidates) };
  }
  return decide(answers, candidates, (picked, costly) => {
    input.cache?.set(key, { ...memoryOf(picked), costly });
  });
}

/**
 * The three elements that share the most words with the target: its name counts most, then its
 * role, then where it sits; a control comes before text with the same words.
 */
function closestByWords(words: string, candidates: ScreenElement[]): ScreenElement[] {
  const terms = normalizeWords(words)
    .split(" ")
    .filter((t) => t.length > 1);
  const hits = (text: string) => {
    const said = normalizeWords(text);
    return terms.filter((t) => said.includes(t)).length;
  };
  return candidates
    .map((e) => ({
      e,
      score: 2 * hits(e.name) + hits(e.role) + 0.5 * hits(e.context.join(" ")) + (CONTROLS.has(e.role) ? 0.5 : 0),
    }))
    .filter((s) => s.score > 0.5)
    .sort((a, b) => b.score - a.score || a.e.index - b.e.index)
    .slice(0, 3)
    .map((s) => s.e);
}

function decide(
  answers: Record<string, JudgeAnswer>,
  candidates: ScreenElement[],
  remember: (e: ScreenElement, costly: boolean) => void,
): TargetResult {
  const which = answers.which;
  const probabilities = which?.probabilities ?? {};
  const present = answers.present?.noul ?? 0;
  const ranked = candidates
    .map((e) => ({ e, p: probabilities[e.ref] ?? 0 }))
    .filter((r) => r.p > 0.02)
    .sort((a, b) => b.p - a.p);
  const choice = which?.choice;
  const picked = choice && choice !== "none" ? candidates.find((e) => e.ref === choice) : undefined;
  const p = choice ? (probabilities[choice] ?? 0) : 0;
  // The pick must stand out: ahead of the next element (or of "none").
  const next = Math.max(
    ranked.find((r) => r.e.ref !== choice)?.p ?? 0,
    choice === "none" ? 0 : (probabilities.none ?? 0),
  );
  // Elements that read the same can't be told apart, whatever the judge says: the agent picks by number.
  const twins = picked ? candidates.filter((e) => e !== picked && describeElement(e) === describeElement(picked)) : [];
  if (picked && twins.length > 0) {
    return { found: false, reason: "unsure", candidates: [picked, ...twins].slice(0, 3) };
  }
  const costly = costlyOf(answers);
  if (picked && p >= (costly ? COSTLY_PICK_AT : PICK_AT) && p - next >= PICK_MARGIN && present >= ABSENT_BELOW) {
    remember(picked, costly);
    return { found: true, ref: picked.ref, element: picked, via: "judge", confidence: p };
  }
  const top = ranked.slice(0, 3).map((r) => r.e);
  if (present < ABSENT_BELOW || (choice === "none" && p >= PICK_AT)) {
    return { found: false, reason: "absent", candidates: top };
  }
  return { found: false, reason: "unsure", candidates: top };
}

/** Where a target is on an image of the screen (the surface's pixels), with the element there if marked. */
export type Located =
  | { found: true; x: number; y: number; ref: string | null; confidence: number }
  | {
      found: false;
      reason: string;
      /** It is there, but only as a spot on the image, and the judge found it can't be undone. */
      refused?: true;
    };

/** How the judge is asked about each kind of screen: the whole of it, and a close-up of part of it. */
const ON_IMAGE: Record<ScreenKind, { where: string; closeUp: string; present: string; absent: string }> = {
  browser: {
    where:
      "In `screenshot` (a web page), box the one control that does what `target` describes, tightly. It may be only an icon: a gear for settings, a trash can for delete, a pencil for edit, a magnifier for search, × for close.",
    closeUp:
      "`screenshot` is a close-up of part of a web page. Box the one control that does what `target` describes, tightly. It may be only an icon.",
    present: "Does `screenshot` show a control that does what `target` describes (maybe only as an icon)?",
    absent: "It isn't on the screenshot (hidden, scrolled away or not on this page).",
  },
  desktop: {
    where:
      "In `screenshot` (a computer's desktop: windows, menus, a panel), box the one control that does what `target` describes, tightly. It may be only an icon: a gear for settings, a trash can for delete, a magnifier for search, x for close.",
    closeUp:
      "`screenshot` is a close-up of part of a computer's desktop. Box the one control that does what `target` describes, tightly. It may be only an icon.",
    present: "Does `screenshot` show a control that does what `target` describes?",
    absent: "It isn't on the screenshot.",
  },
};
/** The judge must say it's there at least this sure, on the whole image and on a close-up. */
const PRESENT_AT = 0.6;
/** A first box this small (of each side) is looked at again on a close-up, when the surface takes one. */
const ZOOM_BELOW = 0.15;
/** The image Jev sees of a close-up, whatever part of the screen it shows: Jev takes none under 280 px a side. */
const CLOSE_UP = { width: 480, height: 300 };
/**
 * The most a close-up enlarges the screen. At native size Jev's box on a 14 px control (a title bar's ×)
 * lands on its neighbor; on 240×150 of the screen enlarged twice, it doesn't.
 */
const CLOSE_UP_ZOOM = 2;
/**
 * A close-up shows at least this many times the first box's height and width. Up close Jev may box the
 * target whole, larger than at first (a folder with its name under it); a box over half the close-up's
 * height or 80% of its width isn't one control, so this leaves room for 1.5 times the first box's height
 * and 1.2 times its width.
 */
const CLOSE_UP_ROOM = { height: 3, width: 1.5 };

/** One control: a box taller than half the image or wider than 80% of it isn't one. */
const clearBox = (b: JudgeBox) => {
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  return w > 0 && h > 0 && h <= 0.5 && w <= 0.8;
};

/** A box's center on the screen. */
const centerOf = (image: ScreenImage, b: JudgeBox) => ({
  x: Math.round((image.origin?.x ?? 0) + ((b.left + b.right) / 2) * image.viewport.width),
  y: Math.round((image.origin?.y ?? 0) + ((b.top + b.bottom) / 2) * image.viewport.height),
});

/**
 * The part of the screen a close-up of `box` shows: `CLOSE_UP_ROOM` times the box, and at least
 * `CLOSE_UP` over `CLOSE_UP_ZOOM`, in `CLOSE_UP`'s shape, centered on the box and kept inside the screen.
 */
function closeUpAround(box: JudgeBox, image: ScreenImage): ScreenRegion {
  const origin = image.origin ?? { x: 0, y: 0 };
  const screen = image.viewport;
  const perPixel = Math.max(
    1 / CLOSE_UP_ZOOM,
    (CLOSE_UP_ROOM.height * (box.bottom - box.top) * screen.height) / CLOSE_UP.height,
    (CLOSE_UP_ROOM.width * (box.right - box.left) * screen.width) / CLOSE_UP.width,
  );
  const width = Math.min(Math.round(CLOSE_UP.width * perPixel), screen.width);
  const height = Math.min(Math.round(CLOSE_UP.height * perPixel), screen.height);
  const center = centerOf(image, box);
  const within = (at: number, from: number, side: number, span: number) =>
    Math.round(Math.min(Math.max(at - span / 2, from), from + side - span));
  return {
    x: within(center.x, origin.x, screen.width, width),
    y: within(center.y, origin.y, screen.height, height),
    width,
    height,
  };
}

/** `image` drawn at `CLOSE_UP`'s size (a JPEG at the runner's quality); what it shows, and where, stay the same. */
async function asCloseUp(image: ScreenImage): Promise<ScreenImage> {
  const data = await new Bun.Image(Buffer.from(image.data, "base64"))
    .resize(CLOSE_UP.width, CLOSE_UP.height)
    .jpeg({ quality: 70 })
    .toBase64();
  return { ...image, data, ...CLOSE_UP };
}

/**
 * Looks for the target on an image of the screen (Jev's Box, plus whether it's
 * there). With marks (an annotated screenshot), the point lands on a marked
 * element's ref, so the action stays as exact as a ref; else it's a point.
 * With `zoom`, a small first box is boxed again on a close-up of the screen
 * around it, up to twice as large (small desktop targets: menu items, icons,
 * a title bar's buttons), and the close-up's answer is the one taken. A target
 * the judge finds can't be undone (delete, discard…) is never taken at a bare point.
 */
export async function locateOnImage(input: {
  judge: Judge;
  orgId: string;
  agentId?: string | null;
  runId?: string;
  target: string;
  image: ScreenImage;
  url?: string | null;
  /** Which screen the image shows (default the browser's page). */
  kind?: ScreenKind;
  /** A close-up of a region of the screen, at its native size, or null when it can't be taken. */
  zoom?: (region: ScreenRegion) => Promise<ScreenImage | null>;
}): Promise<Located> {
  const words = ON_IMAGE[input.kind ?? "browser"];
  const target = input.target.trim();
  const boxOn = async (image: ScreenImage, where: string, first = false) => {
    const placeholder = `screen_${randomUUID()}`;
    const answers: Record<string, JudgeAnswer> = await input.judge.ask({
      orgId: input.orgId,
      agentId: input.agentId,
      runId: input.runId,
      kind: "screen_locate",
      state: { screenshot: placeholder, address: input.url ?? null, target },
      images: { [placeholder]: { data: image.data, format: "jpeg" } },
      questions: {
        where: { type: "box", instructions: where },
        present: {
          type: "noul",
          instructions: words.present,
          criteria: { true: "It is visible on the screenshot.", false: words.absent },
        },
        ...(first ? { costly: COSTLY } : {}),
      },
    });
    return { box: answers.where?.box, present: answers.present?.noul ?? 0, costly: first && costlyOf(answers) };
  };

  let first: Awaited<ReturnType<typeof boxOn>>;
  try {
    first = await boxOn(input.image, words.where, true);
  } catch (error) {
    return { found: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!first.box || first.present < PRESENT_AT) return { found: false, reason: "not on the screen" };
  if (!clearBox(first.box)) return { found: false, reason: "no clear element there" };
  let point = centerOf(input.image, first.box);
  let present = first.present;

  const small = first.box.right - first.box.left <= ZOOM_BELOW && first.box.bottom - first.box.top <= ZOOM_BELOW;
  if (input.zoom && small) {
    const taken = await input.zoom(closeUpAround(first.box, input.image)).catch(() => null);
    // Only an image that says where it sits maps back; without one the first answer stands.
    const close = taken?.origin ? await asCloseUp(taken).catch(() => null) : null;
    const second = close ? await boxOn(close, words.closeUp).catch(() => null) : null;
    if (close && second) {
      // Up close it isn't there, or isn't one control: the first box was most likely on a neighbor.
      if (!second.box || second.present < PRESENT_AT || !clearBox(second.box)) {
        return { found: false, reason: "not clear on a close-up" };
      }
      point = centerOf(close, second.box);
      present = second.present;
    }
  }

  const { x, y } = point;
  const hit = (input.image.marks ?? [])
    .filter((m) => x >= m.box.x && x <= m.box.x + m.box.width && y >= m.box.y && y <= m.box.y + m.box.height)
    .sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)[0];
  // A spot is only as exact as the box: something that can't be undone is done on an element, or not at all.
  if (!hit && first.costly) return { found: false, reason: "only a spot on the image", refused: true };
  return { found: true, x, y, ref: hit?.ref ?? null, confidence: present };
}
