/**
 * Desktop computer use against the real Jev (ADR 0062), on scenes recorded from an agent's desktop (XFCE at
 * 1280×800; the helper's own screenshots, JPEG q70, and the runner's looks with their marks): Jev's Box on
 * the screenshot, first pass and with the close-up of small targets; targets that aren't there; the judge's
 * Choice over the accessibility tree; checks on the text and with the image. Prints each against its bar
 * and exits 1 when one is below it: run it before changing `JEV_VISION_MODEL`.
 *
 *   bun run eval:desktop:micro
 *
 * Needs TYPESAFE_API_KEY. The close-ups are cut from the recorded screenshots with `sips` (macOS) or
 * ImageMagick, at the runner's quality; without either, the close-up pass is skipped and said so.
 * EVAL_DESKTOP_TRIALS (default 2) repeats each image case.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserCaptureMark, DesktopLookReply } from "@agenteschat/adapters";
import { observationOf } from "../../src/desktop/surface";
import {
  checkCondition,
  createTargetCache,
  locateOnImage,
  resolveTarget,
  type ScreenImage,
  type ScreenObservation,
  type ScreenRegion,
  type TargetUse,
} from "../../src/screen";
import { jevJudge, newJudgeLog, p50, requireKey, sum, writeReport } from "../browser/harness";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const TRIALS = Number(process.env.EVAL_DESKTOP_TRIALS ?? 2);
const ids = { orgId: "eval", agentId: "eval-agent", runId: "eval-run" };

/** Thunar in front (its icon view only on the image), the Applications menu open, a dialog that loses work. */
type Scene = "files" | "menu" | "dialog";
type Look = DesktopLookReply & { marks: BrowserCaptureMark[] };
/** On the screen: x, y, width, height. */
type Box = [number, number, number, number];

const looks = new Map<Scene, Look>();
const lookOf = (scene: Scene): Look => {
  let look = looks.get(scene);
  if (!look) {
    look = JSON.parse(readFileSync(path.join(FIXTURES, `${scene}.json`), "utf8")) as Look;
    looks.set(scene, look);
  }
  return look;
};
const screenshotOf = (scene: Scene): ScreenImage => {
  const look = lookOf(scene);
  return {
    data: readFileSync(path.join(FIXTURES, `${scene}.jpg`)).toString("base64"),
    width: look.screen.width,
    height: look.screen.height,
    viewport: look.screen,
    marks: look.marks,
  };
};
/** An element's box from the look's marks (the dock and the menu both have a "File Manager"). */
const markBox = (scene: Scene, role: string, name: string): Box => {
  const m = lookOf(scene).marks.find((x) => x.role === role && (x.name ?? "") === name);
  if (!m) throw new Error(`no ${role} "${name}" in ${scene}`);
  return [m.box.x, m.box.y, m.box.width, m.box.height];
};

/** The program that cuts a close-up out of a recorded screenshot, as the runner's region capture would. */
const CUTTER =
  process.platform === "darwin" && Bun.which("sips") ? "sips" : (Bun.which("magick") ?? Bun.which("convert") ?? null);

async function closeUp(scene: Scene, r: ScreenRegion): Promise<ScreenImage | null> {
  if (!CUTTER) return null;
  const from = path.join(FIXTURES, `${scene}.jpg`);
  const to = path.join(os.tmpdir(), `agentes-eval-${randomUUID()}.jpg`);
  // sips takes an offset of 0 as none and centers the crop instead: a region at the screen's edge starts 1 px in.
  const x = CUTTER === "sips" ? Math.max(1, r.x) : r.x;
  const y = CUTTER === "sips" ? Math.max(1, r.y) : r.y;
  const sips = `-s format jpeg -s formatOptions 70 -c ${r.height} ${r.width} --cropOffset ${y} ${x}`.split(" ");
  const argv =
    CUTTER === "sips"
      ? ["sips", ...sips, from, "--out", to]
      : [CUTTER, from, ...`-crop ${r.width}x${r.height}+${x}+${y} +repage -quality 70`.split(" "), to];
  try {
    const p = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
    if ((await p.exited) !== 0) return null;
    return {
      data: readFileSync(to).toString("base64"),
      width: r.width,
      height: r.height,
      viewport: { width: r.width, height: r.height },
      origin: { x, y },
    };
  } finally {
    rmSync(to, { force: true });
  }
}

/** A target on the image: where it is (any of these boxes; none: not on the screen). */
interface ImageCase {
  scene: Scene;
  target: string;
  at: Box[];
}
const imageCases: ImageCase[] = [
  // Only on the image: Thunar's icon view and the window frames aren't in the tree.
  { scene: "files", target: "the Documents folder in the file manager", at: [[1045, 135, 85, 90]] },
  { scene: "files", target: "the close button of the file manager window", at: [[1262, 36, 18, 18]] },
  { scene: "dialog", target: "the close button of the dialog's title bar", at: [[858, 318, 18, 18]] },
  {
    scene: "files",
    target: "the search button of the file manager",
    at: [markBox("files", "button", "Search for Files...")],
  },
  { scene: "files", target: "the Home button in the file manager's toolbar", at: [markBox("files", "button", "Home")] },
  {
    scene: "files",
    target: "the Join the list button on the web page",
    // The page has two: in its header and in its form.
    at: [
      [452, 535, 125, 48],
      [543, 161, 95, 31],
    ],
  },
  {
    scene: "menu",
    target: "File Manager in the Applications menu",
    at: [markBox("menu", "menuitem", "File Manager")],
  },
  {
    scene: "menu",
    target: "Terminal Emulator in the Applications menu",
    at: [markBox("menu", "menuitem", "Terminal Emulator")],
  },
  { scene: "menu", target: "the Settings submenu", at: [markBox("menu", "menu", "Settings")] },
  { scene: "menu", target: "Log Out in the menu", at: [markBox("menu", "menuitem", "Log Out")] },
  {
    scene: "menu",
    target: "the Applications menu button in the panel",
    at: [markBox("menu", "button", "Applications")],
  },
  { scene: "dialog", target: "the Cancel button of the dialog", at: [markBox("dialog", "button", "Cancel")] },
  { scene: "dialog", target: "Save in the dialog", at: [markBox("dialog", "button", "Save")] },
  // Small, but taller than half of a 240×150 close-up when boxed whole: a folder with its name, a picture.
  { scene: "files", target: "the Downloads folder in the file manager", at: [[915, 235, 70, 82]] },
  { scene: "files", target: "the Pictures folder in the file manager", at: [[1058, 235, 56, 82]] },
  { scene: "files", target: "the blue robot picture at the bottom of the web page", at: [[510, 575, 115, 112]] },
  // Large: wider or taller than the close-up is for.
  { scene: "files", target: "the location bar of the file manager", at: [markBox("files", "textbox", "")] },
  { scene: "files", target: "the browser's address bar", at: [[148, 94, 445, 35]] },
  { scene: "files", target: "the email field on the web page", at: [[63, 528, 520, 62]] },
  { scene: "files", target: "the text area of the terminal", at: [[706, 470, 568, 330]] },
  // Not on the screen.
  { scene: "files", target: "the Trash icon", at: [] },
  { scene: "files", target: "the Save button", at: [] },
  { scene: "dialog", target: "the Settings submenu", at: [] },
  { scene: "menu", target: "the Print button", at: [] },
];

/** What the close-up is for: a target no wider or taller than 15% of the screen. */
const isSmall = (scene: Scene, [, , w, h]: Box) =>
  w <= 0.15 * lookOf(scene).screen.width && h <= 0.15 * lookOf(scene).screen.height;
const inside = (boxes: Box[], p: { x: number; y: number }) =>
  boxes.some(([x, y, w, h]) => p.x >= x - 2 && p.x <= x + w + 2 && p.y >= y - 2 && p.y <= y + h + 2);

/** A target in words over the tree: the elements that count (role and name), none when it isn't there. */
interface ChoiceCase {
  scene: Scene;
  target: string;
  use: TargetUse;
  right: [role: string, name: string][];
}
const choiceCases: ChoiceCase[] = [
  { scene: "menu", target: "open the file manager from the menu", use: "click", right: [["menuitem", "File Manager"]] },
  {
    scene: "menu",
    target: "a terminal, from the Applications menu",
    use: "click",
    right: [["menuitem", "Terminal Emulator"]],
  },
  { scene: "menu", target: "the submenu with the settings", use: "click", right: [["menu", "Settings"]] },
  { scene: "menu", target: "go up one folder in the file manager", use: "click", right: [["button", "Open Parent"]] },
  { scene: "menu", target: "the View menu of the file manager", use: "click", right: [["menu", "View"]] },
  { scene: "files", target: "where the folder's path is typed", use: "fill", right: [["textbox", ""]] },
  { scene: "files", target: "search for files", use: "click", right: [["button", "Search for Files..."]] },
  { scene: "files", target: "the button that goes to the home folder", use: "click", right: [["button", "Home"]] },
  {
    scene: "files",
    target: "the terminal",
    use: "window",
    right: [
      ["window", "Terminal - agent@desktop: ~"],
      ["button", "Terminal - agent@desktop: ~"],
    ],
  },
  { scene: "dialog", target: "the button that keeps the changes", use: "click", right: [["button", "Save"]] },
  { scene: "dialog", target: "keep editing, without closing", use: "click", right: [["button", "Cancel"]] },
  {
    scene: "dialog",
    target: "close the file and lose the changes",
    use: "click",
    right: [["button", "Close without Saving"]],
  },
  { scene: "files", target: "the Trash in the sidebar", use: "click", right: [] },
  { scene: "dialog", target: "the Print button", use: "click", right: [] },
];

/** Whether the screen shows it now; some only the image can tell (the terminal's text is behind in the tree). */
const checkCases: { scene: Scene; condition: string; holds: boolean }[] = [
  { scene: "menu", condition: "the Applications menu is open", holds: true },
  { scene: "menu", condition: "a dialog asks to save changes", holds: false },
  { scene: "dialog", condition: "a dialog asks whether to save the changes to a file", holds: true },
  { scene: "dialog", condition: "the file was saved", holds: false },
  { scene: "files", condition: "the file manager shows the home folder", holds: true },
  { scene: "files", condition: "the terminal lists the files of the home folder", holds: true },
  { scene: "files", condition: "an error message is on the screen", holds: false },
];

requireKey("TYPESAFE_API_KEY");
const log = newJudgeLog();
const judge = jevJudge(log);
const report: Record<string, unknown> = {
  model: process.env.JEV_VISION_MODEL ?? "jev-preview",
  trials: TRIALS,
  closeUps: CUTTER ?? "none: install ImageMagick (or use macOS) to measure them",
};

// ── Box on the screenshot: first pass, then with the close-up ──
const boxes: Record<string, unknown>[] = [];
const passes = CUTTER ? (["first", "closeUp"] as const) : (["first"] as const);
for (const c of imageCases) {
  const image = screenshotOf(c.scene);
  for (let trial = 0; trial < TRIALS; trial++) {
    for (const pass of passes) {
      const t0 = performance.now();
      const r = await locateOnImage({
        judge,
        ...ids,
        target: c.target,
        image,
        url: lookOf(c.scene).address,
        kind: "desktop",
        ...(pass === "closeUp" ? { zoom: (region: ScreenRegion) => closeUp(c.scene, region) } : {}),
      });
      const right = c.at.length > 0 ? r.found && inside(c.at, r) : !r.found;
      boxes.push({
        scene: c.scene,
        target: c.target,
        pass,
        size: c.at[0] ? (isSmall(c.scene, c.at[0]) ? "small" : "large") : "absent",
        ms: Math.round(performance.now() - t0),
        right,
        got: r.found ? { x: r.x, y: r.y, ref: r.ref } : r.reason,
      });
    }
  }
}
const rate = (rows: Record<string, unknown>[]) => {
  const right = rows.filter((r) => r.right).length;
  return { right: `${right}/${rows.length}`, share: rows.length ? right / rows.length : 1 };
};
const of = (pass: string, size: string) => boxes.filter((b) => b.pass === pass && b.size === size);
report.box = {
  small: { first: rate(of("first", "small")), closeUp: rate(of("closeUp", "small")) },
  large: { first: rate(of("first", "large")), closeUp: rate(of("closeUp", "large")) },
  absent: { first: rate(of("first", "absent")), closeUp: rate(of("closeUp", "absent")) },
  p50Ms: {
    first: p50(boxes.filter((b) => b.pass === "first").map((b) => b.ms as number)),
    closeUp: p50(boxes.filter((b) => b.pass === "closeUp").map((b) => b.ms as number)),
  },
  // Each target's score per pass, so a miss shows where it is.
  byTarget: Object.fromEntries(
    imageCases.map((c) => [
      `${c.scene}: ${c.target}`,
      Object.fromEntries(
        passes.map((pass) => [
          pass,
          rate(boxes.filter((b) => b.pass === pass && b.scene === c.scene && b.target === c.target)).right,
        ]),
      ),
    ]),
  ),
  cases: boxes,
};

// ── The judge's Choice over the tree ──
const choices: Record<string, unknown>[] = [];
for (const c of choiceCases) {
  const observation: ScreenObservation = observationOf(lookOf(c.scene));
  const t0 = performance.now();
  const r = await resolveTarget({
    judge,
    ...ids,
    target: c.target,
    use: c.use,
    observation,
    cache: createTargetCache(),
    scope: "eval",
  });
  const element = r.found ? observation.elements.find((e) => e.ref === r.ref) : null;
  const right =
    c.right.length === 0
      ? !r.found
      : Boolean(element && c.right.some(([role, name]) => element.role === role && element.name === name));
  choices.push({
    scene: c.scene,
    target: c.target,
    ms: Math.round(performance.now() - t0),
    right,
    got: element ? `${element.role} "${element.name}" via ${r.found ? r.via : ""}` : r.found ? r.ref : r.reason,
  });
}
report.choice = { ...rate(choices), p50Ms: p50(choices.map((c) => c.ms as number)), cases: choices };

// ── Checks: on the text, with the image, and as plans run them (the image when the text is unsure) ──
const checks: Record<string, unknown>[] = [];
for (const c of checkCases) {
  const observation = observationOf(lookOf(c.scene));
  const t0 = performance.now();
  const text = await checkCondition({ judge, ...ids, condition: c.condition, observation });
  const textMs = performance.now() - t0;
  const t1 = performance.now();
  const seen = await checkCondition({
    judge,
    ...ids,
    condition: c.condition,
    observation,
    image: screenshotOf(c.scene),
  });
  const imageMs = performance.now() - t1;
  const asPlans = text.met ?? seen.met;
  checks.push({
    scene: c.scene,
    condition: c.condition,
    holds: c.holds,
    text: { met: text.met, p: Number(text.p.toFixed(2)), ms: Math.round(textMs) },
    image: { met: seen.met, p: Number(seen.p.toFixed(2)), ms: Math.round(imageMs) },
    right: { text: text.met === c.holds, image: seen.met === c.holds, asPlans: asPlans === c.holds },
  });
}
const checkRate = (k: "text" | "image" | "asPlans") =>
  rate(checks.map((c) => ({ right: (c.right as Record<string, boolean>)[k] })));
report.checks = { text: checkRate("text"), image: checkRate("image"), asPlans: checkRate("asPlans"), cases: checks };

report.judge = {
  calls: log.calls.length,
  p50Ms: p50(log.calls.map((c) => c.ms)),
  maxMs: Math.max(0, ...log.calls.map((c) => c.ms)),
  failed: log.calls.filter((c) => !c.ok).length,
  inputTokens: sum(log.usage.map((u) => u.inputTokens)),
  costUsd: sum(log.usage.map((u) => u.costNanoUsd)) / 1e9,
  models: [...new Set(log.usage.map((u) => u.model))],
};

/**
 * The bars a model must clear: a little under what `jev-1.14.0` measured here (ADR 0062: small targets with the
 * close-up 185/192 over three runs of 4 trials, the rest all right), so that noise alone doesn't fail a run and a
 * worse model does.
 */
const box = report.box as Record<string, Record<string, { share: number; right: string }>>;
const none = { share: 0, right: "-" };
// The desktop's own path: with the close-up, when one can be cut.
const [desktop, via] = CUTTER ? (["closeUp", "with the close-up"] as const) : (["first", "first pass"] as const);
const bars: [string, { share: number; right: string }, number][] = [
  ["small targets with the close-up", box.small?.closeUp ?? none, 0.9],
  [`large targets, ${via}`, box.large?.[desktop] ?? none, 0.9],
  [`absent targets said absent, ${via}`, box.absent?.[desktop] ?? none, 0.9],
  ["Choice over the tree", report.choice as { share: number; right: string }, 0.9],
];
if (!CUTTER) bars.shift();
console.log(JSON.stringify(report, null, 2));
console.log(`report: ${await writeReport("desktop-micro", report)}`);
let below = false;
for (const [what, got, bar] of bars) {
  const ok = got.share >= bar;
  below ||= !ok;
  console.log(`${ok ? "ok  " : "LOW "} ${what}: ${got.right} (bar ${Math.round(bar * 100)}%)`);
}
if (below) process.exit(1);
