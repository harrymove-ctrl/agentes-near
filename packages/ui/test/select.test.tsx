import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { Field, SearchSelect, Select } from "../src";

const roles = [
  { value: "member", label: "Membro", description: "Conversa, cria issues" },
  { value: "admin", label: "Admin", description: "Também gerencia membros" },
  { value: "owner", label: "Dono" },
];

function Harness({ onChange }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState("member");
  return (
    <Field label="Papel" id="role">
      <Select
        value={value}
        onValueChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
        options={roles}
      />
    </Field>
  );
}

const body = () => within(document.body);
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  // Radix moves focus between options (and back to the trigger) on the next tick.
  await act(() => new Promise((r) => setTimeout(r, 0)));
};

describe("Select", () => {
  test("is a labelled button with the current value, never a native select", () => {
    const { container } = render(<Harness />);
    expect(container.querySelector("select")).toBeNull();
    const trigger = body().getByRole("combobox", { name: "Papel" });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.textContent).toContain("Membro");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("keyboard: opens with Enter, moves with arrows, picks with Enter, focus returns", async () => {
    const changes: string[] = [];
    render(<Harness onChange={(v) => changes.push(v)} />);
    const trigger = body().getByRole("combobox", { name: "Papel" });
    trigger.focus();
    await key(trigger, "Enter");
    const listbox = body().getByRole("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const options = within(listbox).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "MembroConversa, cria issues",
      "AdminTambém gerencia membros",
      "Dono",
    ]);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    // The selected option has focus; move down once and pick it.
    await key(document.activeElement ?? listbox, "ArrowDown");
    expect(document.activeElement?.textContent).toContain("Admin");
    await key(document.activeElement ?? listbox, "Enter");
    expect(changes).toEqual(["admin"]);
    expect(body().queryByRole("listbox")).toBeNull();
    expect(trigger.textContent).toContain("Admin");
    expect(document.activeElement === trigger).toBe(true);
  });

  test("an option whose value is empty (Ninguém) shows in the trigger when chosen, and picking it gives back the empty value", async () => {
    const changes: string[] = [];
    function Nobody() {
      const [value, setValue] = useState("ada");
      return (
        <Select
          aria-label="Responde a"
          value={value}
          onValueChange={(v) => {
            setValue(v);
            changes.push(v);
          }}
          options={[
            { value: "", label: "Ninguém" },
            { value: "ada", label: "Ada" },
          ]}
        />
      );
    }
    render(<Nobody />);
    const trigger = body().getByRole("combobox", { name: "Responde a" });
    trigger.focus();
    await key(trigger, "Enter");
    await key(document.activeElement ?? document.body, "ArrowUp");
    await key(document.activeElement ?? document.body, "Enter");
    expect(changes).toEqual([""]);
    expect(trigger.textContent).toContain("Ninguém");
    expect(trigger.hasAttribute("data-placeholder")).toBe(false);
  });

  test("Escape closes without changing the value", async () => {
    const changes: string[] = [];
    render(<Harness onChange={(v) => changes.push(v)} />);
    const trigger = body().getByRole("combobox", { name: "Papel" });
    trigger.focus();
    await key(trigger, "ArrowDown");
    expect(body().getByRole("listbox")).toBeTruthy();
    await key(document.activeElement ?? document.body, "Escape");
    expect(body().queryByRole("listbox")).toBeNull();
    expect(changes).toEqual([]);
    expect(trigger.textContent).toContain("Membro");
  });

  test("the list opens on the trigger's start edge, or on its end edge for a select that ends its row", async () => {
    for (const align of [undefined, "end"] as const) {
      const { unmount } = render(
        <Select aria-label="Papel" value="member" onValueChange={() => {}} options={roles} align={align} />,
      );
      const trigger = body().getByRole("combobox", { name: "Papel" });
      trigger.focus();
      await key(trigger, "Enter");
      expect(body().getByRole("listbox").getAttribute("data-align")).toBe(align ?? "start");
      unmount();
    }
  });

  test("people and agents (OptionRow): a 24px face 6 from the row's top and bottom and 8 from its start, the role on the name's line", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    const list = ":is(.ac-menu, .ac-palette__list):has(.ac-menu__leading > .ac-avatar)";
    expect(css).toContain("--option-face: 24px;");
    expect(css).toContain("--option-h: 36px;");
    // 44 under a finger: the face keeps 10 above and below.
    expect(css).toMatch(/@media \(pointer: coarse\) \{[^@]*--option-h: 44px;/);
    expect(rule(":is(.ac-menu, .ac-palette__list) .ac-menu__leading > .ac-avatar")).toContain(
      "width: var(--option-face);",
    );
    const rows = rule(`${list} .ac-menu__item`);
    expect(rows).toContain("padding: calc((var(--option-h) - var(--option-face)) / 2) var(--menu-item-px);");
    expect(rows).toContain("min-height: var(--option-h);");
    // Every row of that list leads with a face's width, so a glyph-led choice ("Sem responsável") lines up and matches.
    expect(rule(`${list} .ac-menu__item > .ac-menu__leading`)).toContain("min-width: var(--option-face);");
    expect(rule(`${list} .ac-menu__item > .ac-menu__leading`)).toContain("translate: none;");
    expect(rule(`${list} .ac-menu__label`)).toContain("flex-direction: row;");
    expect(rule(`${list} .ac-menu__desc`)).toContain("white-space: nowrap;");
    expect(css).not.toContain(".ac-menu--select .ac-menu__leading > .ac-avatar {\n  width: 32px;");
  });

  test("every option keeps a check's room at its end, shown on the chosen one; the trigger shows the chosen face", async () => {
    const faces = [
      { value: "ada", label: "Ada", description: "Dona", leading: <span className="ac-avatar">A</span> },
      { value: "bia", label: "Bia", leading: <span className="ac-avatar">B</span> },
    ];
    render(<Select aria-label="Responsável" value="ada" onValueChange={() => {}} options={faces} />);
    const trigger = body().getByRole("combobox", { name: "Responsável" });
    const lead = trigger.querySelector(".ac-select__lead");
    expect(lead?.textContent).toBe("A");
    expect(lead?.getAttribute("aria-hidden")).toBe("true");
    expect(lead?.nextElementSibling?.className).toBe("ac-select__text");
    trigger.focus();
    await key(trigger, "Enter");
    const options = body().getAllByRole("option");
    for (const option of options) expect(option.lastElementChild?.getAttribute("class")).toBe("ac-menu__check");
    expect(options[0]?.getAttribute("data-state")).toBe("checked");
    expect(options[1]?.getAttribute("data-state")).toBe("unchecked");
  });

  test("a searchable select's trigger shows the chosen face too, as a select's does", () => {
    const faces = [{ value: "ada", label: "Ada", leading: <span className="ac-avatar">A</span> }];
    const labels = { search: "Buscar", searchPlaceholder: "Buscar", noResults: "Nada", list: "Pessoas" };
    render(
      <SearchSelect<string> aria-label="Quem" value="ada" onValueChange={() => {}} options={faces} labels={labels} />,
    );
    const lead = body().getByRole("combobox", { name: "Quem" }).querySelector(".ac-select__lead");
    expect(lead?.textContent).toBe("A");
    expect(lead?.nextElementSibling?.textContent).toBe("Ada");
  });

  test("a value without a lead shows its words alone, and a value drawn by the caller keeps its drawing", () => {
    const { container, rerender } = render(<Select value="member" onValueChange={() => {}} options={roles} />);
    expect(container.querySelector(".ac-select__lead")).toBeNull();
    rerender(
      <Select
        value="member"
        onValueChange={() => {}}
        options={roles.map((r) => ({ ...r, leading: <i>x</i> }))}
        renderValue={(o) => <b className="mine">{o.label}</b>}
      />,
    );
    expect(container.querySelector(".ac-select__lead")).toBeNull();
    expect(container.querySelector(".mine")?.textContent).toBe("Membro");
  });

  test("an action row is set apart by a line, rows keep a gap, two-line rows a one-line row's room above and below", async () => {
    const options = [...roles, { value: "new", label: "Nova categoria…", action: true }];
    render(<Select aria-label="Categoria" value="member" onValueChange={() => {}} options={options} />);
    const trigger = body().getByRole("combobox", { name: "Categoria" });
    trigger.focus();
    await key(trigger, "Enter");
    const listbox = body().getByRole("listbox");
    const separators = listbox.querySelectorAll(".ac-menu__separator");
    expect(separators.length).toBe(1);
    expect(separators[0]?.nextElementSibling?.textContent).toContain("Nova categoria");
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-menu--select [data-radix-select-viewport]")).toContain("gap: 2px;");
    // A two-line row takes the one-line row's room above and below: 32 for one line, 50 with a description.
    expect(rule(".ac-menu__item:has(> .ac-menu__label > .ac-menu__desc)")).toBe("");
  });
});

test("a list mixing two-line options and one-line actions gives every row the same room above and below", async () => {
  const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url)).text();
  expect(css).toContain("padding: calc((var(--menu-item-h) - 20px) / 2) var(--menu-item-px);");
  expect(css).not.toContain(".ac-menu:has(.ac-menu__desc) .ac-menu__item {");
});

test("a browser translating the trigger's text doesn't break it: the words sit in an element of ours", () => {
  const { container, rerender, unmount } = render(<Select value="member" onValueChange={() => {}} options={roles} />);
  const value = container.querySelector(".ac-select__text") as HTMLElement;
  expect(value.textContent).toBe("Membro");
  // What Google Translate does: the text node goes, a <font> holding the new words takes its place.
  const font = document.createElement("font");
  font.textContent = "Member";
  value.replaceChild(font, value.firstChild as Text);
  rerender(<Select value="admin" onValueChange={() => {}} options={roles} />);
  expect(container.querySelector(".ac-select__value")?.textContent).toBe("Admin");
  expect(() => unmount()).not.toThrow();
});

test("a value its options don't have shows the placeholder, never an empty box", () => {
  const { container, rerender } = render(
    <Select value="col-gone" onValueChange={() => {}} options={roles} placeholder="A fazer" aria-label="Coluna" />,
  );
  const trigger = container.querySelector(".ac-select__trigger") as HTMLElement;
  expect(trigger.textContent).toBe("A fazer");
  expect(trigger.hasAttribute("data-placeholder")).toBe(true);
  // Once the options come, the chosen one's name.
  rerender(
    <Select
      value="col-gone"
      onValueChange={() => {}}
      options={[...roles, { value: "col-gone", label: "Aguardando o jurídico" }]}
      placeholder="A fazer"
      aria-label="Coluna"
    />,
  );
  expect(trigger.textContent).toBe("Aguardando o jurídico");
});
