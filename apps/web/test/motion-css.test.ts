import { expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url).pathname).text();
const NO_PREFERENCE = /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g;
const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

test("with reduced motion nothing moves: every animation in the app's sheets sits in a no-preference block", async () => {
  for (const path of ["src/components/threads/threads.css", "src/layout.css"]) {
    const outside = uncommented(await read(path)).replace(NO_PREFERENCE, "");
    const moving = [...outside.matchAll(/\banimation(-name)?:\s*([^;]+);/g)].filter(([, , v]) => v?.trim() !== "none");
    expect({ path, moving: moving.map(([d]) => d) }).toEqual({ path, moving: [] });
  }
});

test("a side panel slides in on the drawer curve and out faster, its scrim fading with it", async () => {
  const css = uncommented(await read("src/components/threads/threads.css"));
  const motion = [...css.matchAll(NO_PREFERENCE)].map(([block]) => block).join("\n");
  expect(motion).toContain("animation: thread-panel-in var(--dur-panel) var(--drawer)");
  expect(motion).toContain("animation: thread-panel-out var(--dur-base) var(--out) forwards");
  expect(motion).toContain("animation: thread-scrim-in var(--dur-panel) var(--out)");
  expect(motion).toMatch(/\[data-swap\][^{]*\{\s*animation: none/);
  // From past the window's right edge, opaque the whole way (a card sliding in, not a fade).
  expect(css).toMatch(/@keyframes thread-panel-in \{\s*from \{\s*transform: translateX\(calc\(100% \+ 10px\)\);\s*\}/);
});
