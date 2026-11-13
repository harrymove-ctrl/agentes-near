import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, declarations, rules, topLevel } from "./built-css";

const sheet = (file: string) => Bun.file(join(import.meta.dir, "../src", file)).text();

test("a role card's padding is one length all round: as much above the face as under its last line", async () => {
  const layout = await sheet("layout.css");
  const padding = declarations(topLevel(layout), ".newag__role").filter(([p]) => p.startsWith("padding"));
  expect(padding.map(([p]) => p)).toEqual(["padding"]);
  expect(padding[0]?.[1]).toMatch(/^\d+px$/);
  // Its face row is a bare `.ac-faceline` (new-agent.test.tsx), and no rule that reaches it through the card gives it
  // room, at any width.
  const room = rules(`${layout}\n${await sheet("pages/new-agent.css")}`)
    .filter((r) =>
      r.declarations.some(([p]) => /^(padding|margin)(-top|-block(-start)?)?$|^min-(height|block-size)$/.test(p)),
    )
    .flatMap((r) => r.selectors.filter((s) => s.includes(".newag__role") && /\.ac-faceline[^ >+~]*$/.test(s)));
  expect(room).toEqual([]);
});

test("on a narrow screen, where the preview sits above the form, it waits for the step after the role's", async () => {
  const narrow = atRule(await sheet("pages/new-agent.css"), "@media (max-width: 1100px)");
  expect(declarations(narrow, '.newag__aside[data-step="role"]')).toEqual([["display", "none"]]);
});

test("the new agent's list rows are face lines: no rule centres a face against its two lines (ADR 0164)", async () => {
  const card = await sheet("components/new-agent/new-agent-card.css");
  const centred = rules(card).filter(
    (r) => r.selectors.some((s) => s.includes(".nac__item")) && r.declarations.some(([p]) => p === "align-items"),
  );
  expect(centred).toEqual([]);
});

test("the card's list and body fade at an edge only while there is more to scroll that way (ADR 0164)", async () => {
  const card = topLevel(await sheet("components/new-agent/new-agent-card.css"));
  for (const box of [".nac__list", ".nac__body"]) {
    const own = declarations(card, box);
    // No fade until the flags say so, and the scrollbar's strip stays clear.
    expect(own).toContainEqual(["--nac-fade-top", "0px"]);
    expect(own).toContainEqual(["--nac-fade-bottom", "0px"]);
    expect(own.find(([p]) => p === "mask-image")?.[1]).toContain("var(--scroll-strip)");
  }
  expect(declarations(card, ':is(.nac__list, .nac__body)[data-fade-top="true"]')).toEqual([["--nac-fade-top", "20px"]]);
  expect(declarations(card, ':is(.nac__list, .nac__body)[data-fade-bottom="true"]')).toEqual([
    ["--nac-fade-bottom", "28px"],
  ]);
});

test("narrow, the dialog takes two steps at one height, the card's cover stacks, its fitting room wraps (ADR 0164)", async () => {
  const card = await sheet("components/new-agent/new-agent-card.css");
  const top = topLevel(card);
  // One pane at a time, flagged by the dialog (NEW_AGENT_STEPS_QUERY): the list fills the body, the card scrolls in it.
  expect(declarations(top, ".nac__keys[data-steps] .nac__grid")).toContainEqual([
    "grid-template-columns",
    "minmax(0, 1fr)",
  ]);
  expect(declarations(top, ".ac-dialog.nac:has(> .nac__keys[data-steps])").map(([p]) => p)).toEqual(["height"]);
  expect(declarations(top, '.nac__keys[data-step="card"] .nac__card')).toEqual([["overflow", "visible"]]);
  // What it wears: as many columns as fit, never a fixed six.
  expect(declarations(top, ".nac__look .newag__opts--acc")).toEqual([
    ["grid-template-columns", "repeat(auto-fill, minmax(64px, 1fr))"],
  ]);
  // A card under 480px: the bubble under the agent, at the card's width.
  const narrow = atRule(card, "@container nac-card (max-width: 480px)");
  expect(declarations(narrow, ".nac__cover")).toContainEqual(["flex-direction", "column"]);
  expect(declarations(narrow, ".nac__bubble")).toContainEqual(["position", "relative"]);
  expect(declarations(narrow, ".nac__bubble")).toContainEqual(["align-self", "stretch"]);
});

test("the chat's band fits an AI and four apps at 360px and at 300px, and scrolls sideways past that (ADR 0164)", async () => {
  const card = await sheet("components/new-agent/new-agent-card.css");
  const wide = atRule(card, "@container nac-band (max-width: 520px)");
  const narrow = atRule(card, "@container nac-band (max-width: 400px)");
  // A value in force at a width: the narrower block's over the wider one's.
  const px = (blocks: string[], selector: string, property: string) => {
    const found = blocks
      .flatMap((b) => declarations(b, selector))
      .filter(([p]) => p === property)
      .at(-1)?.[1];
    return Number.parseFloat(found ?? "NaN");
  };
  for (const [width, blocks] of [
    [360, [wide]],
    [300, [wide, narrow]],
  ] as const) {
    const room =
      px([...blocks], ".nac-band__path", "left") +
      px([...blocks], ".nac-band__path", "right") +
      5 * (px([...blocks], ".nac-band__trail", "width") + px([...blocks], ".nac-band__slot", "width"));
    expect(room).toBeLessThanOrEqual(width);
  }
  // Narrower still, the path scrolls and fades only at an edge with more past it.
  expect(declarations(wide, ".nac-band__path")).toContainEqual(["overflow-x", "auto"]);
  expect(declarations(wide, '.nac-band__path[data-fade-end="true"]')).toEqual([["--nac-band-fade-end", "24px"]]);
});
