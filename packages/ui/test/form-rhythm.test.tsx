import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, render, screen } from "@testing-library/react";
import { AffixInput, Field, FormActions, FormStack, Input, Locked } from "../src/components/Field";
import { Segmented } from "../src/components/Segmented";

afterEach(() => cleanup());

const ROOT = new URL("../../../", import.meta.url).pathname;
const kit = readFileSync(join(ROOT, "packages/ui/src/styles/components.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = readFileSync(join(ROOT, "packages/ui/src/styles/tokens.css"), "utf8");

/** The body of the rule for exactly `selector`, wherever it stands in a selector list. */
const rule = (selector: string) =>
  [...kit.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? "").split(",").some((s) => s.trim() === selector))
    .map((m) => m[2])
    .join("\n");

const px = (name: string) => {
  const space = (n: string) => Number(tokens.match(new RegExp(`--space-${n}:\\s*(\\d+)px`))?.[1]);
  return space(tokens.match(new RegExp(`${name}:\\s*var\\(--space-(\\d)\\)`))?.[1] ?? "");
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : [],
  );
}

describe("a form's rhythm", () => {
  test("fields stand clearly further from each other than a label or a help from its control", () => {
    expect(px("--form-gap")).toBeGreaterThanOrEqual(px("--field-gap") * 3);
  });

  test("every stack of fields takes the one gap, and a field its own", () => {
    expect(rule(".ac-form")).toContain("gap: var(--form-gap);");
    expect(rule(".ac-form")).toContain("display: flex;");
    expect(rule(".ac-dialog__body")).toContain("gap: var(--form-gap);");
    expect(rule(".ac-field")).toContain("gap: var(--field-gap);");
    // `Locked` must stay boxless, or what it holds would leave the stack's gap.
    expect(rule(".ac-locked")).toContain("display: contents;");
  });

  test("a Segmented in a field fills it, its options sharing the track", () => {
    expect(rule(".ac-field > .ac-seg")).toContain("display: flex;");
    expect(rule(".ac-field > .ac-seg > .ac-seg__item")).toContain("flex: 1 1 0;");
    expect(rule(".ac-field > .ac-seg > .ac-seg__item")).toContain("min-width: max-content;");
  });

  test("a Segmented straight in a form's column fills it too, and `block` does it anywhere", () => {
    for (const box of [".ac-form > .ac-seg", ".ac-dialog__body > .ac-seg", ".ac-seg--block"])
      expect(rule(box)).toContain("display: flex;");
    render(<Segmented block label="Vista" value="a" onValueChange={() => {}} options={[{ value: "a", label: "A" }]} />);
    expect(screen.getByRole("radiogroup", { name: "Vista" }).className).toContain("ac-seg--block");
  });

  test('nothing stacks on a class with no rule: `className="stack"` once left a form with no gaps at all', () => {
    const uses = ["apps/web/src", "packages/ui/src"]
      .flatMap((d) => sources(join(ROOT, d)))
      .filter((f) => /className="stack"/.test(readFileSync(f, "utf8")));
    expect(uses).toEqual([]);
  });

  test("a dialog's form has no box, so its body scrolls and its footer stays in a short window", () => {
    expect(rule(".ac-dialog > form")).toContain("display: contents;");
    expect(rule(".ac-dialog__body")).toContain("overflow-y: auto;");
  });

  test("on a phone a form's Segmented wraps a choice instead of running it past the track", () => {
    const item = rule(".ac-field > .ac-seg > .ac-seg__item");
    expect(item).toContain("white-space: normal;");
    expect(item).toContain("min-width: min-content;");
    expect(rule(".ac-field > .ac-seg")).toContain("min-height: var(--seg-h);");
  });

  test("a textarea's words start where an input's do, and a tab's panel keeps the form's gap", () => {
    expect(rule("textarea.ac-input")).toContain("padding: 10px var(--control-px-md);");
    expect(rule(".ac-tabpanel")).toContain("gap: var(--form-gap);");
  });

  test("a ghost at a footer's edge puts its words on the dialog's edge", () => {
    expect(rule(".ac-dialog__foot > .ac-btn--ghost:not(.ac-btn--icon):first-child")).toContain(
      "margin-inline-start: calc(-1 * var(--ghost-plate));",
    );
    expect(rule(".ac-dialog__foot > .ac-btn--ghost:not(.ac-btn--icon):last-child")).toContain(
      "margin-inline-end: calc(-1 * var(--ghost-plate));",
    );
  });

  test("Cancelar looks the same in every footer: the plain button, never a ghost", () => {
    const ghosts = sources(join(ROOT, "apps/web/src")).flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/<DialogFooter\b[\s\S]*?<\/DialogFooter>/g)].flatMap((foot) =>
        [...foot[0].matchAll(/<Button\b[^>]*variant="ghost"[^>]*>\s*\{t\("[\w.]*[cC]ancel"\)\}/g)].map(() => f),
      ),
    );
    expect(ghosts).toEqual([]);
  });

  test("a sheet's head wraps its buttons on a phone", () => {
    expect(rule(".ac-details__actions")).toContain("flex-wrap: wrap;");
  });

  test("a form's actions sit at the end, spaced as a dialog's footer", () => {
    expect(rule(".ac-form__actions")).toContain("justify-content: flex-end;");
    expect(rule(".ac-form__actions")).toContain("gap: var(--space-2);");
  });
});

describe("the pieces", () => {
  test("a group field names its Segmented by the visible label and describes it by the example", () => {
    render(
      <Field label="Formato" example="Como o servidor fala" group>
        <Segmented
          label="Formato do servidor"
          value="a"
          onValueChange={() => {}}
          options={[
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ]}
        />
      </Field>,
    );
    const radios = screen.getByRole("radiogroup", { name: "Formato" });
    expect(radios.hasAttribute("aria-label")).toBe(false);
    expect(document.getElementById(radios.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Como o servidor fala",
    );
    expect(document.querySelector("label")).toBeNull();
  });

  test("a Segmented outside a field keeps its own name", () => {
    render(<Segmented label="Vista" value="a" onValueChange={() => {}} options={[{ value: "a", label: "A" }]} />);
    expect(screen.getByRole("radiogroup", { name: "Vista" }).hasAttribute("aria-labelledby")).toBe(false);
  });

  test("an AffixInput takes an action inside its end, without a prefix too, and shows it's invalid", () => {
    render(
      <Field label="Modelo">
        <AffixInput invalid action={<button type="button">Adicionar</button>} />
      </Field>,
    );
    const input = screen.getByLabelText("Modelo");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.parentElement?.querySelector(".ac-input-affix__prefix")).toBeNull();
    expect(input.nextElementSibling?.className).toBe("ac-input-affix__action");
    expect(rule('.ac-input-affix:has(input[aria-invalid="true"])')).toContain("border-color: var(--danger);");
  });

  test("Locked inside a FormStack leaves its fields the stack's; FormActions' note comes before its buttons", () => {
    render(
      <FormStack>
        <Locked when>
          <Field label="Nome">
            <Input />
          </Field>
        </Locked>
        <FormActions note="Testando">
          <button type="button">Salvar</button>
        </FormActions>
      </FormStack>,
    );
    expect(document.querySelector(".ac-form > .ac-locked > .ac-field")).not.toBeNull();
    expect(document.querySelector(".ac-form__actions")?.firstElementChild?.textContent).toBe("Testando");
  });
});
