import { expect, test } from "bun:test";
import { join } from "node:path";
import { builtCss, declarations, topLevel } from "./built-css";

const SRC = join(import.meta.dir, "../src");

/** Declarations as `property:value`, spaces and a number's leading zero out: the minifier drops the ones it may. */
const squeeze = (list: (readonly [string, string])[]) =>
  list.map(([p, v]) => `${p}:${v.replace(/\s+/g, "").replace(/(^|[^\d.])0\./g, "$1.")}`);

const builds = new Map<string, Promise<string>>();
const built = (input: string) => {
  if (!builds.has(input)) builds.set(input, builtCss(input).then(topLevel));
  return builds.get(input) as Promise<string>;
};

/** What `file` (under src) declares for `selector` at every width, all of it in the build of `input` too. */
async function ships(file: string, input: string, selector: string) {
  const written = squeeze(declarations(topLevel(await Bun.file(join(SRC, file)).text()), selector));
  const shipped = squeeze(declarations(await built(input), selector));
  expect({ selector, written: written.length > 0 }).toEqual({ selector, written: true });
  expect({ selector, shipped }).toEqual({ selector, shipped: expect.arrayContaining(written) });
  return shipped;
}

test("the setup rail's horizon ships in the rail's column, under its steps, never laid over them", async () => {
  const shipped = await ships("layout.css", "src/styles.css", ".onb__horizon");
  expect(shipped).toContain("max-height:calc(var(--onb-h,100dvh)*.46)");
  expect(shipped.some((d) => /^(position:absolute|inset:|top:|z-index:)/.test(d))).toBe(false);
});

test("a service's × ships in the full ink on its sky, its ink as far from the top as from the side", async () => {
  const selector = ".catalog-svc .ac-dialog__close > .ac-btn--glyph";
  const glyph = await ships("layout.css", "src/styles.css", selector);
  expect(glyph).toContain("color:var(--ink)");
  // It reaches up and down as far as the kit's row makes it reach sideways, so its row is its ink, placed evenly.
  const kit = squeeze(
    declarations(
      topLevel(await Bun.file(join(SRC, "../../../packages/ui/src/styles/components.css")).text()),
      ".ac-acts > .ac-btn--glyph",
    ),
  );
  const sideways = kit.find((d) => d.startsWith("margin-inline:"))?.slice("margin-inline:".length);
  expect(sideways).toBeTruthy();
  expect(glyph).toContain(`margin-block:${sideways}`);
  const row = await ships("layout.css", "src/styles.css", ".catalog-svc .ac-dialog__close");
  expect(row).toEqual(expect.arrayContaining(["top:var(--dialog-pad)", "right:var(--dialog-pad)"]));
  // The sheet's own inset, where its icon and words start, under the sky's densest top rows.
  expect(await ships("layout.css", "src/styles.css", ".ac-dialog.catalog-svc")).toContain("--dialog-pad:24px");
});

test("a closed browser's sky takes the line's room in the computer window, steps or not, at every width", async () => {
  // Not only while the line is empty: a run's first step comes before the frame that ends the closed state.
  const selector = ".cmp-body:has(> .brw-ac.is-surface.is-closed) > .cmp-steps-row";
  const file = "components/computer/computer.css";
  expect(await ships(file, `src/${file}`, selector)).toContain("display:none");
});
