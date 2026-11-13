import { expect, test } from "bun:test";
import path from "node:path";
import { declarations, rules } from "./built-css";

const ROOT = path.join(import.meta.dir, "../../..");
const sheet = (file: string) => Bun.file(path.join(ROOT, file)).text();
const last = (pairs: (readonly [string, string])[], property: string) => pairs.findLast(([p]) => p === property)?.[1];

test("a chip under an agent's names keeps the card's row gap, never touching the line above", async () => {
  const layout = await sheet("apps/web/src/layout.css");
  const card = await sheet("apps/web/src/components/profile-card.css");
  // The member card: the chip is a row of the body (12px apart), at its own width.
  expect(last(declarations(card, ".mcard .profile-card__body"), "gap")).toBe("12px");
  expect(last(declarations(card, ".mcard .profile-card__body > :is(.noai-chip, .ac-chip)"), "align-self")).toBe(
    "flex-start",
  );
  expect(last(declarations(layout, ".profile-card__body"), "flex-direction")).toBe("column");
});

test("the card's banner buttons are one round kind: the computer's and the ⋯", async () => {
  const card = await sheet("apps/web/src/components/profile-card.css");
  expect(last(declarations(card, ".mcard__act.ac-btn"), "border-radius")).toBe("var(--radius-full)");
  // Their plates 8 apart, as every pair of icon buttons stands.
  expect(last(declarations(card, ".mcard__acts"), "gap")).toBe("var(--space-2)");
});

test("short of room, the card's banner gives way first, then it scrolls with its actions pinned to its foot", async () => {
  const card = await sheet("apps/web/src/components/profile-card.css");
  expect(last(declarations(card, ".mcard__frame"), "display")).toBe("contents");
  expect(last(declarations(card, ".mcard.profile-card"), "gap")).toBe("0");
  expect(last(declarations(card, ".mcard__banner"), "flex")).toBe("0 1 96px");
  expect(last(declarations(card, ".mcard__banner"), "min-height")).toBe("56px");
  // The face in the flow, so it rides the banner's foot whatever its height: 90px tall, 44 over it, 46 under.
  expect(last(declarations(card, ".mcard__face"), "position")).toBe("relative");
  expect(last(declarations(card, ".mcard__face"), "margin")).toBe("-44px 0 -46px 16px");
  expect(last(declarations(card, ".mcard .profile-card__body"), "flex")).toBe("none");
  expect(last(declarations(card, ".mcard .profile-card__body"), "padding")).toBe("50px 16px 16px");
  for (const foot of [".mcard__foot", ".mcard .profile-card__body > .profile-card__actions:last-child"])
    expect(last(declarations(card, foot), "position")).toBe("sticky");
});

test("the audience popover's Cancelar and Salvar stay pinned to its foot when the choice scrolls", async () => {
  const card = await sheet("apps/web/src/components/profile-card.css");
  expect(last(declarations(card, ".mcard-audience.ac-popover"), "padding")).toBe("var(--menu-pad) var(--menu-pad) 0");
  expect(last(declarations(card, ".mcard-audience__acts"), "position")).toBe("sticky");
  expect(last(declarations(card, ".mcard-audience__acts"), "bottom")).toBe("0");
  expect(last(declarations(card, ".mcard-audience__acts"), "padding")).toBe("12px 0 var(--menu-pad)");
});

test("a paragraph or a list in a stack takes the stack's gap, never its browser margins on top", async () => {
  const layout = await sheet("apps/web/src/layout.css");
  const kit = await sheet("packages/ui/src/styles/components.css");
  // The rule for these stacks' paragraphs and lists, and what it sets.
  const reset = (css: string, stack: string) =>
    rules(css)
      .filter((r) => r.selectors.some((s) => s.endsWith(">:where(p,ul,ol)") && s.includes(`${stack},`)))
      .flatMap((r) => r.declarations);
  // An agent's card: "só responde a" sat 13px further than the 12px gap from the bar above and the button below.
  expect(last(reset(layout, ".profile-card__body"), "margin-block")).toBe("0");
  for (const stack of [".stack-4", ".skill-sheet__main", ".cal-side__section"])
    expect(last(reset(layout, stack), "margin-block")).toBe("0");
  // The kit's cards (settings sections, dialogs' cards) as its forms and fields already did; their notes too.
  for (const stack of [".ac-form", ".ac-dialog__body", ".ac-card"])
    expect(last(reset(kit, stack), "margin-block")).toBe("0");
  expect(last(declarations(kit, ":is(.ac-form, .ac-field, .ac-dialog__body, .ac-card) > .ac-setnote"), "margin")).toBe(
    "0",
  );
});
