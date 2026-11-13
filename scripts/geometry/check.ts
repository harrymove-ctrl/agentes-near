/**
 * Lays out the screens `capture.ts` saved in headless Chromium, with the app's real CSS, at each width, and runs
 * `rules.js` on them. No dev server. Fails on an offender that isn't in `baseline.json`.
 *
 *   GEOMETRY_OUT=<states dir> bun test --preload ./scripts/geometry/capture.ts apps/web packages/ui
 *   bun run check:geometry <states dir> [--report <file>] [--update] [--text-size xs,xl]
 *
 * `--update` rewrites the baseline: after fixing offenders, or to accept one the rules got wrong. `--text-size` lays a
 * screen with messages out again at those steps of Tamanho do texto (`html[data-text-size]`), the only screens it
 * changes. Chromium comes from CHROME_BIN, or a Chrome found on the machine, over plain DevTools Protocol: the check
 * needs no browser library.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const HERE = import.meta.dir;
const ROOT = join(HERE, "../..");
const WEB = join(ROOT, "apps/web");
const BASELINE = join(HERE, "baseline.json");
/** A desktop, the narrowest phone, and the common one: a row can fit at 320 and still squeeze its words at 390. */
const WIDTHS = [1280, 320, 390];
/**
 * One browser each: tabs on the same file:// origin share a renderer, so they'd lay out one at a time.
 * `GEOMETRY_BROWSERS` raises it on a machine with more cores to spare (CI's runner).
 */
const BROWSERS = Math.max(1, Number(process.env.GEOMETRY_BROWSERS) || 4);
/**
 * Fewer than this means the capture broke, and an empty run must not read as a clean one. `GEOMETRY_MIN_STATES` lowers
 * it for a local run over a few test files.
 */
const MIN_STATES = Number(process.env.GEOMETRY_MIN_STATES ?? 300);
/** The window's height, and how much taller the second look at a `sliver` is. */
const HEIGHT = 900;
const TALLER = 40;

export interface Finding {
  rule: string;
  el: string;
  box?: string;
  /** The nearest box with a class of the app's own, for a finding named only by the kit's classes. */
  at?: string;
  text?: string;
  [detail: string]: unknown;
}

export const keyOf = (f: Finding, width: number) =>
  `${f.rule}@${width} ${f.el}${f.box ? ` in ${f.box}` : ""}${f.at ? ` at ${f.at}` : ""}`;

/**
 * The findings, less each `sliver` gone in a window `TALLER` px taller (`taller`): content 1–3 px longer than the
 * window, which a window of any other height shows whole or scrolls for real. One the layout makes stays.
 */
export function lasting(found: Finding[], taller: Finding[], width: number) {
  const stays = new Set(taller.filter((f) => f.rule === "sliver").map((f) => keyOf(f, width)));
  return found.filter((f) => f.rule !== "sliver" || stays.has(keyOf(f, width)));
}

/** Offenders the baseline doesn't know, and baseline entries nothing hit any more. */
export function compare(found: Iterable<string>, baseline: string[]) {
  const now = new Set(found);
  const known = new Set(baseline);
  return { fresh: [...now].filter((k) => !known.has(k)).sort(), gone: baseline.filter((k) => !now.has(k)) };
}

const VOID = /^(area|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/;

/** Every parent and child pair of tags with their classes: what CSS selectors and flex and grid rows act on. */
export function edgesOf(html: string) {
  const edges = new Set<string>();
  const stack = ["root"];
  for (const [, close, tag, attrs] of html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/g)) {
    if (close) {
      stack.pop();
      continue;
    }
    const me = `${tag}.${attrs?.match(/class="([^"]*)"/)?.[1] ?? ""}`;
    edges.add(`${stack.at(-1)}>${me}`);
    if (!VOID.test(tag as string) && !attrs?.endsWith("/")) stack.push(me);
  }
  return edges;
}

/**
 * Fewer screens that still show every parent and child pair: the tests pass through thousands of near copies of a page.
 * By name, a hash of the screen's shape, so the same screens always pick the same ones.
 * ponytail: a pair seen once counts as covered, so the same row under a longer title isn't laid out again. Measure every
 * screen if a wrap that needs a particular word count ever slips through.
 */
export function coverage(names: string[], read: (name: string) => string) {
  const known = new Set<string>();
  return [...names].sort().filter((name) => {
    const before = known.size;
    for (const edge of edgesOf(read(name))) known.add(edge);
    return known.size > before;
  });
}

/** A Chromium Playwright installed, newest first: a Mac without Chrome may still have one. */
export function playwrightChromes() {
  const home = process.env.HOME ?? "";
  return [join(home, "Library/Caches/ms-playwright"), join(home, ".cache/ms-playwright")].flatMap((dir) => {
    try {
      const found = ["chromium-*/chrome-*/*.app/Contents/MacOS/*", "chromium-*/chrome-*/chrome"].flatMap((p) => [
        ...new Bun.Glob(p).scanSync({ cwd: dir, onlyFiles: true }),
      ]);
      return found
        .sort()
        .reverse()
        .map((f) => join(dir, f));
    } catch {
      return [];
    }
  });
}

export function findChrome() {
  const known = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    Bun.which("google-chrome"),
    Bun.which("google-chrome-stable"),
    Bun.which("chromium"),
    Bun.which("chromium-browser"),
    ...playwrightChromes(),
  ];
  const bin = known.find((p) => p && Bun.file(p).size > 0);
  if (!bin) throw new Error("No Chrome found: set CHROME_BIN");
  return bin;
}

/**
 * The app's stylesheets in the app's order: the entry and what it imports, then what components import after it. Or
 * reversed: the page sheets backwards and the entry last, the worst case of the order the build links its chunks in
 * (the shared chunks' sheets before the main one, in an order that changes with the routes), for `cascadeorder`.
 */
export function cssSheets(order: "app" | "reverse" = "app") {
  const main = readFileSync(join(WEB, "src/styles.css"), "utf8");
  const inMain = (file: string) => main.includes(`"./${file.replace(/^src\//, "")}"`);
  const rest = [...new Bun.Glob("src/**/*.css").scanSync(WEB)]
    .filter((f) => f !== "src/styles.css" && !inMain(f))
    .sort();
  return order === "app" ? ["src/styles.css", ...rest] : [...rest.reverse(), "src/styles.css"];
}

/** The app's CSS in one file, in that order. */
export async function bundleCss(out: string, order: "app" | "reverse" = "app") {
  const entry = join(out, `entry-${order}.css`);
  writeFileSync(
    entry,
    cssSheets(order)
      .map((s) => `@import ${JSON.stringify(join(WEB, s))};`)
      .join("\n"),
  );
  const built = await Bun.build({
    entrypoints: [entry],
    outdir: join(out, `css-${order}`),
    naming: { asset: "[name]-[hash].[ext]" },
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const css = built.outputs.find((o) => o.path.endsWith(".css"));
  if (!css) throw new Error("The CSS bundle came out empty");
  return relative(out, css.path);
}

/**
 * The page the screens are laid out in, and its twin with the CSS in the reverse order. Two small sheets go into both,
 * after the bundle in the first and before it in the twin: `cascadeorder`'s offender and its sound twin.
 */
export function writeFrame(out: string, css: string, reverse: string) {
  for (const file of ["rules.js", "fixture-a.css", "fixture-b.css"]) copyFileSync(join(HERE, file), join(out, file));
  const links = (sheets: string[]) => sheets.map((href) => `<link rel="stylesheet" href="${href}">`).join("");
  // Layout only: no motion mid-measure, and scrollbars don't take width differently per machine.
  const frame = (sheets: string[]) =>
    `<!doctype html><html lang="pt-BR" data-theme="light" data-pointer><head><meta charset="utf-8">${links(sheets)}<style>*,*::before,*::after{animation:none!important;transition:none!important}</style><script src="rules.js"></script></head><body></body></html>`;
  writeFileSync(join(out, "frame.html"), frame([css, "fixture-a.css", "fixture-b.css"]));
  writeFileSync(join(out, "frame-rev.html"), frame(["fixture-b.css", "fixture-a.css", reverse]));
  return { url: `file://${join(out, "frame.html")}`, reverse: `file://${join(out, "frame-rev.html")}` };
}

export async function launch(bin: string, profile: string) {
  const chrome = Bun.spawn(
    [
      bin,
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--allow-file-access-from-files",
      // Text advances as on every machine, not hinted to this one's pixels.
      "--font-render-hinting=none",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-sandbox",
      "about:blank",
    ],
    { stderr: "pipe", stdout: "ignore" },
  );
  let log = "";
  const reader = chrome.stderr.getReader();
  const decoder = new TextDecoder();
  let url: string | undefined;
  while (!url) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`Chrome exited: ${log.slice(-500)}`);
    log += decoder.decode(value);
    url = log.match(/ws:\/\/\S+/)?.[0];
  }
  // Kept draining: a full stderr pipe would block Chrome mid-run (Linux runners log to it freely).
  void (async () => {
    while (!(await reader.read()).done);
  })();
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = fail;
  });
  let id = 0;
  const waiting = new Map<number, { ok: (v: never) => void; fail: (e: Error) => void }>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const call = waiting.get(m.id);
    if (!call) return;
    waiting.delete(m.id);
    if (m.error) call.fail(new Error(m.error.message));
    else call.ok(m.result as never);
  };
  const send = <T = Record<string, never>>(method: string, params: object = {}, sessionId?: string) =>
    new Promise<T>((ok, fail) => {
      id += 1;
      waiting.set(id, { ok: ok as (v: never) => void, fail });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return { send, close: () => chrome.kill() };
}

type Send = Awaited<ReturnType<typeof launch>>["send"];

export async function openTab(send: Send, url: string) {
  const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.navigate", { url }, sessionId);
  const run = async <T>(expression: string): Promise<T> => {
    const r = await send<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
    return r.result.value;
  };
  for (let i = 0; i < 200 && !(await run<boolean>("document.readyState === 'complete' && !!window.geometry")); i++) {
    await Bun.sleep(50);
  }
  const resize = async (width: number, height = HEIGHT) => {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    // Below the desktop width a screen is on a phone, whose touch sizes the kit grows controls to.
    await send("Emulation.setTouchEmulationEnabled", { enabled: width < 640, maxTouchPoints: 1 }, sessionId);
  };
  return { run, resize, send: (method: string, params: object = {}) => send(method, params, sessionId) };
}

/** What `rules.js` reports, each with a `bad-` offender and a `good-` twin in `fixture.html`. */
export const SELF_TESTED = [
  "edge",
  "pad",
  "clipped",
  "overlap",
  "wordwrap",
  "midword",
  "stub",
  "viewport",
  "plate",
  "sliver",
  "actions",
  "stack",
  "nameless",
  "quiet",
  "inset",
  "icongap",
  "square",
  "touch",
  "floating",
  "squarecol",
  "rim",
  "inlinebase",
  "iconmid",
  "fieldwidth",
  "corner",
  "clip",
  "cascadeorder",
  "pagetop",
  "groupedge",
  "menuitem",
  "rowpad",
  "emptyselect",
  "toolorder",
  "toolrow",
  "captop",
  "timeedge",
  "panefill",
  "squeeze",
  "loneprimary",
  "btngap",
  "btnsplit",
  "toolheight",
  "factwrap",
  "undoinline",
  "barend",
  "countfill",
  "calstack",
  "bleed",
  "stampout",
  "stampover",
];

/** Rules about a desktop layout only (panes floating beside the conversation, a toolbar's one row): a phone has none. */
export const DESKTOP_ONLY = ["floating", "toolorder"];
/** Rules about a phone's layout only (a lone main button as wide as its card): a desktop keeps its own width. */
export const PHONE_ONLY = ["loneprimary"];

type Tab = Awaited<ReturnType<typeof openTab>>;

/** What the rules find on the loaded screen at a width, a `sliver` only if it stays in a taller window (`lasting`). */
async function findingsAt(tab: Tab, width: number) {
  await tab.resize(width);
  const found = await tab.run<Finding[]>("geometry.detect()");
  if (!found.some((f) => f.rule === "sliver")) return found;
  await tab.resize(width, HEIGHT + TALLER);
  return lasting(found, await tab.run<Finding[]>("geometry.detect()"), width);
}

/**
 * Elements whose own style differs between the two CSS orders: a tie between two sheets that the build can decide the
 * other way. Named by the element and the property. Both tabs at the same width and height.
 */
async function orderFindings(tab: Tab, reverse: Tab): Promise<Finding[]> {
  const [a, b] = await Promise.all([
    tab.run<number[]>("geometry.styles()"),
    reverse.run<number[]>("geometry.styles()"),
  ]);
  const differ = a.flatMap((hash, i) => (hash !== b[i] ? [i] : []));
  if (!differ.length) return [];
  type Styled = { el: string; at?: string; parent: number; props: string[]; values: string[] };
  const ask = `geometry.styleOf(${JSON.stringify(differ)})`;
  const [va, vb] = await Promise.all([tab.run<Styled[]>(ask), reverse.run<Styled[]>(ask)]);
  const differs = new Set(differ);
  return va.flatMap((x, k) =>
    x.props.flatMap((prop, j) =>
      x.values[j] === vb[k]?.values[j] ||
      // A size that follows its parent's change (its padding, its width) is that change, reported once on the parent.
      ((prop === "width" || prop === "height") && differs.has(x.parent))
        ? []
        : [{ rule: "cascadeorder", el: x.el, box: prop, at: x.at, a: x.values[j], b: vb[k]?.values[j] }],
    ),
  );
}

/**
 * Every rule fires on each of its fixture's offenders (`bad-<rule>`, `bad-<rule>--<case>`) and stays quiet on each
 * sound twin (`good-…`), and what opens from another layer is the topmost thing at its center (`geometry.layers`).
 */
async function selfTest(tab: Tab, reverse: Tab) {
  const fixture = readFileSync(join(HERE, "fixture.html"), "utf8");
  for (const t of [tab, reverse]) await t.run(`geometry.load(${JSON.stringify(fixture)})`);
  const twins = [...new Set(fixture.match(/\b(?:bad|good)-[a-z]+(?:--[a-z]+)?\b/g))];
  const wrong: string[] = [];
  // At every width the screens are checked at, a phone's touch sizes included.
  for (const width of WIDTHS) {
    await Promise.all([tab.resize(width), reverse.resize(width)]);
    // The two orders first: `findingsAt` may leave the tab taller than its twin.
    const found = [...(await orderFindings(tab, reverse)), ...(await findingsAt(tab, width))];
    const hit = (rule: string, cls: string) =>
      found.some((f) => f.rule === rule && `${f.el} ${f.box ?? ""} ${f.at ?? ""}`.split(/[.\s]/).includes(cls));
    const here = (r: string) => (width >= 640 ? !PHONE_ONLY.includes(r) : !DESKTOP_ONLY.includes(r));
    for (const rule of SELF_TESTED.filter(here)) {
      for (const cls of twins.filter((c) => c.replace(/^(bad|good)-|--.*$/g, "") === rule)) {
        if (cls.startsWith("bad-") && !hit(rule, cls)) wrong.push(`${rule}@${width} missed ${cls}`);
        if (cls.startsWith("good-") && hit(rule, cls)) wrong.push(`${rule}@${width} flagged ${cls}`);
      }
    }
  }
  // At every width (a dialog is a sheet on a phone) and in both CSS orders.
  for (const width of WIDTHS) {
    await Promise.all([tab.resize(width), reverse.resize(width)]);
    for (const [t, order] of [
      [tab, "app"],
      [reverse, "reverse"],
    ] as const)
      for (const layer of await t.run<string[]>("geometry.layers()"))
        wrong.push(`layers@${width} (${order} order): ${layer} opens under what opened it`);
  }
  if (wrong.length) throw new Error(`Self-test: ${wrong.join(", ")}`);
}

interface Hit {
  width: number;
  screen: string;
  finding: Finding;
}

function writeReport(file: string, hits: Hit[], states: number, fresh: string[]) {
  const byKey = new Map<string, Hit[]>();
  const byScreen = new Map<string, Map<string, Hit>>();
  for (const h of hits) {
    const key = keyOf(h.finding, h.width);
    byKey.set(key, [...(byKey.get(key) ?? []), h]);
    const screen = byScreen.get(h.screen) ?? new Map<string, Hit>();
    screen.set(key, h);
    byScreen.set(h.screen, screen);
  }
  const detail = ({ finding: { rule: _r, el: _e, box: _b, at: _a, text, ...rest } }: Hit) =>
    `${Object.entries(rest)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}${text ? ` "${text}"` : ""}`;
  const lines = [
    `# Geometry report`,
    ``,
    `${states} screens at ${WIDTHS.join(" and ")} px, light. ${byKey.size} offenders, ${fresh.length} not in the baseline.`,
    ``,
    `## By offender`,
    ``,
  ];
  for (const [key, list] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    const screens = [...new Set(list.map((h) => h.screen))];
    const first = list[0] as Hit;
    lines.push(
      `- ${fresh.includes(key) ? "**new** " : ""}\`${key}\` x${list.length}: ${detail(first)}. On ${screens.slice(0, 4).join(", ")}${screens.length > 4 ? ` and ${screens.length - 4} more` : ""}`,
    );
  }
  lines.push(``, `## By screen`, ``);
  for (const [screen, keys] of [...byScreen].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `### ${screen}`,
      ``,
      ...[...keys].sort(([a], [b]) => a.localeCompare(b)).map(([k, h]) => `- \`${k}\`: ${detail(h)}`),
      ``,
    );
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n"));
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => (flag(name) ? args[args.indexOf(name) + 1] : undefined);
  const dir = args[0];
  if (!dir) throw new Error("Usage: check.ts <states dir> [--report <file>] [--update] [--text-size xs,xl]");
  const textSizes = value("--text-size")?.split(",").filter(Boolean) ?? [];

  const out = mkdtempSync(join(tmpdir(), "geometry-"));
  const browsers = await Promise.all(
    Array.from({ length: BROWSERS }, (_, i) => launch(findChrome(), join(out, `profile-${i}`))),
  );
  try {
    const frames = writeFrame(out, await bundleCss(out), await bundleCss(out, "reverse"));
    // Each browser lays a screen out twice: in the app's CSS order and in the reverse one, for `cascadeorder`.
    const pairs = await Promise.all(
      browsers.map(async (b) => [await openTab(b.send, frames.url), await openTab(b.send, frames.reverse)] as const),
    );
    await selfTest(...(pairs[0] as (typeof pairs)[number]));

    const captured = readdirSync(dir).filter((f) => f.endsWith(".html"));
    if (captured.length < MIN_STATES) throw new Error(`Only ${captured.length} screens captured: the capture broke`);
    const read = (name: string) => readFileSync(join(dir, name), "utf8");
    const queue = coverage(captured, read);
    const measured = queue.length;
    const hits: Hit[] = [];
    await Promise.all(
      pairs.map(async ([tab, reverse]) => {
        for (let name = queue.pop(); name; name = queue.pop()) {
          const raw = read(name);
          const cut = raw.indexOf("-->");
          const { screen } = JSON.parse(raw.slice(4, cut)) as { screen: string };
          const load = `geometry.load(${JSON.stringify(raw.slice(cut + 4))})`;
          await Promise.all([tab.run(load), reverse.run(load)]);
          for (const width of WIDTHS) {
            for (const size of ["", ...(raw.includes("ac-msg") ? textSizes : [])]) {
              await tab.run(
                size
                  ? `document.documentElement.dataset.textSize = ${JSON.stringify(size)}`
                  : "delete document.documentElement.dataset.textSize",
              );
              // The two CSS orders at the default text size, both tabs at this width, before `findingsAt` may leave
              // the tab taller than its twin.
              if (!size) {
                await Promise.all([tab.resize(width), reverse.resize(width)]);
                for (const finding of await orderFindings(tab, reverse)) hits.push({ width, screen, finding });
              }
              for (const finding of await findingsAt(tab, width)) hits.push({ width, screen, finding });
            }
          }
        }
      }),
    );

    const found = new Set(hits.map((h) => keyOf(h.finding, h.width)));
    if (flag("--update")) {
      writeFileSync(BASELINE, `${JSON.stringify([...found].sort(), null, 2)}\n`);
      console.log(`Baseline: ${found.size} entries`);
    }
    const baseline: string[] = JSON.parse(readFileSync(BASELINE, "utf8"));
    const { fresh, gone } = compare(found, baseline);
    const report = value("--report");
    if (report) writeReport(report, hits, measured, fresh);
    console.log(
      `${captured.length} screens captured, ${measured} laid out, ${found.size} offenders, ${fresh.length} new, ${gone.length} gone from the baseline`,
    );
    for (const key of gone) console.log(`  fixed, drop with --update: ${key}`);
    for (const key of fresh) {
      const h = hits.find((x) => keyOf(x.finding, x.width) === key) as Hit;
      console.error(`NEW ${key}\n    on "${h.screen}": ${JSON.stringify(h.finding)}`);
    }
    process.exitCode = fresh.length ? 1 : 0;
  } finally {
    for (const b of browsers) b.close();
    rmSync(out, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
