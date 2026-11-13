import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import {
  Checkbox,
  CheckboxPill,
  Chip,
  Field,
  Input,
  Locked,
  PickerHeading,
  Radio,
  RadioCard,
  RadioGroup,
  Switch,
  TabPanel,
  Tabs,
  useLocked,
} from "../src";

const body = () => within(document.body);

describe("Locked", () => {
  const Reads = () => <output>{useLocked() ? "off" : "on"}</output>;
  const form = (when: boolean) => (
    <Locked when={when}>
      <Input aria-label="Recado" defaultValue="Deixei aberto" />
      <Switch aria-label="Avisar" checked={false} onCheckedChange={() => {}} />
      <Reads />
    </Locked>
  );

  test("turns off native and Radix controls alike, keeps the text and tells what a fieldset can't reach", () => {
    const { container, rerender } = render(form(false));
    const box = container.querySelector("fieldset") as HTMLFieldSetElement;
    expect(box.disabled).toBe(false);
    expect(container.querySelector("output")?.textContent).toBe("on");
    rerender(form(true));
    expect(box.disabled).toBe(true);
    expect(box.querySelector("input")?.value).toBe("Deixei aberto");
    // Radix draws its controls as buttons, which the fieldset reaches with no prop of its own.
    expect(box.querySelector("button.ac-switch")).not.toBeNull();
    expect(container.querySelector("output")?.textContent).toBe("off");
  });

  test("focus goes back to the field it left, so a failed send can be retried from the keyboard", () => {
    const { container, rerender } = render(form(false));
    const input = container.querySelector("input") as HTMLInputElement;
    input.focus();
    rerender(form(true));
    input.blur();
    rerender(form(false));
    expect(document.activeElement === input).toBe(true);
  });

  test("focus comes back from a browser that drops it as the lock commits, before any layout effect, as Chromium does", () => {
    const Drops = ({ when }: { when: boolean }) => {
      useLayoutEffect(() => {
        if (when && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }, [when]);
      return <Input aria-label="Recado" />;
    };
    const dropping = (when: boolean) => (
      <Locked when={when}>
        <Drops when={when} />
      </Locked>
    );
    const { container, rerender } = render(dropping(false));
    const input = container.querySelector("input") as HTMLInputElement;
    input.focus();
    rerender(dropping(true));
    expect(document.activeElement === input).toBe(false);
    rerender(dropping(false));
    expect(document.activeElement === input).toBe(true);
  });

  test("focus the person moved elsewhere stays there", () => {
    const other = document.createElement("button");
    document.body.append(other);
    const { container, rerender } = render(form(false));
    (container.querySelector("input") as HTMLInputElement).focus();
    rerender(form(true));
    other.focus();
    rerender(form(false));
    expect(document.activeElement === other).toBe(true);
    other.remove();
  });

  test("has no box of its own, and CSS can't miss a control it turned off", async () => {
    const read = (path: string) => Bun.file(new URL(path, import.meta.url).pathname).text();
    const kit = await read("../src/styles/components.css");
    expect(kit).toMatch(/\.ac-locked \{\s*display: contents;/);
    // `[disabled]` only sees the control's own attribute, never a fieldset's.
    expect(kit).not.toContain("[disabled]");
    expect(await read("../../../apps/web/src/layout.css")).not.toContain("[disabled]");
  });
});

describe("Checkbox", () => {
  function Harness({ disabled }: { disabled?: boolean }) {
    const [on, setOn] = useState(false);
    return (
      <>
        <Checkbox id="c1" checked={on} onCheckedChange={setOn} disabled={disabled} />
        <label htmlFor="c1">Ler arquivos</label>
      </>
    );
  }

  test("is our own role=checkbox (no native input look) named by its label", () => {
    const { container } = render(<Harness />);
    expect(container.querySelector('input[type="checkbox"]:not([aria-hidden="true"])')).toBeNull();
    const box = body().getByRole("checkbox", { name: "Ler arquivos" });
    expect(box.className).toContain("ac-check");
    expect(box.getAttribute("aria-checked")).toBe("false");
  });

  test("toggles with click and with the keyboard (Space)", async () => {
    render(<Harness />);
    const box = body().getByRole("checkbox", { name: "Ler arquivos" });
    await act(async () => fireEvent.click(box));
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(box.getAttribute("data-state")).toBe("checked");
    // Radix checkboxes are buttons: Space/Enter activate them as a click.
    box.focus();
    await act(async () => {
      fireEvent.keyDown(box, { key: " " });
      fireEvent.keyUp(box, { key: " " });
      fireEvent.click(box);
    });
    expect(box.getAttribute("aria-checked")).toBe("false");
  });

  test("clicking the label toggles it", async () => {
    render(<Harness />);
    await act(async () => fireEvent.click(body().getByText("Ler arquivos")));
    expect(body().getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  });

  test("disabled cannot be toggled", async () => {
    render(<Harness disabled />);
    const box = body().getByRole("checkbox");
    await act(async () => fireEvent.click(box));
    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(box.hasAttribute("disabled")).toBe(true);
  });

  test("pill reflects the checked state for styling", async () => {
    function Pill() {
      const [on, setOn] = useState(true);
      return (
        <CheckboxPill id="tg-eng" checked={on} onCheckedChange={setOn}>
          #eng
        </CheckboxPill>
      );
    }
    const { container } = render(<Pill />);
    const pill = container.querySelector(".ac-pill");
    expect(pill?.getAttribute("data-checked")).toBe("true");
    await act(async () => fireEvent.click(body().getByRole("checkbox", { name: "#eng" })));
    expect(pill?.getAttribute("data-checked")).toBe("false");
  });
});

describe("Radio", () => {
  test("one tab stop, arrow keys select the next option", async () => {
    function Harness() {
      const [v, setV] = useState("platform");
      return (
        <RadioGroup value={v} onValueChange={setV} aria-label="Qual chave o agente usa?">
          <Radio value="platform" aria-label="Chave do agentes" />
          <Radio value="own" aria-label="Chave da Acme" />
        </RadioGroup>
      );
    }
    render(<Harness />);
    const [a, b] = body().getAllByRole("radio");
    expect(a?.getAttribute("aria-checked")).toBe("true");
    expect(b?.getAttribute("tabindex")).toBe("-1");
    await act(async () => fireEvent.click(b as HTMLElement));
    expect(b?.getAttribute("aria-checked")).toBe("true");
    expect(a?.getAttribute("aria-checked")).toBe("false");
  });
});

describe("RadioCard", () => {
  test("its chip rides on the title's line, and the description takes the card's whole width under both", async () => {
    render(
      <RadioGroup value="s3" onValueChange={() => {}} aria-label="Onde ficam os arquivos">
        <RadioCard
          value="disk"
          id="disk"
          checked={false}
          title="Este servidor"
          description="Os arquivos ficam no disco dele."
          aside={<Chip icon="check">Em uso</Chip>}
        />
      </RadioGroup>,
    );
    const head = document.querySelector(".ac-option__head");
    expect([...(head?.children ?? [])].map((c) => c.className)).toEqual(["ac-option__title", "ac-option__aside"]);
    expect(head?.nextElementSibling?.className).toBe("ac-option__desc");
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-option__text:has(> .ac-option__head)")).toContain("flex: 1;");
    expect(rule(".ac-option__head")).toContain("display: flex;");
    expect(rule(".ac-option__aside")).toContain("display: flex;");
    // On a narrow card (a decision's three options) the chip drops under the title instead of leaving the card: the
    // row wraps, the title can shrink to its longest word, and the dropped chip starts under it with no gap between.
    expect(rule(".ac-option__head")).toContain("flex-wrap: wrap;");
    expect(rule(".ac-option__head")).not.toMatch(/\n\s*(row-)?gap:/);
    expect(rule(".ac-option__head > .ac-option__title")).toContain("flex: 1 1 0;");
    expect(rule(".ac-option__aside")).not.toContain("margin-left");
    expect(rule(".ac-option__desc")).toContain("text-wrap: pretty;");
    // An option that can't be picked dims; its "Em breve" stays clear.
    expect(
      rule(
        ".ac-option:is([data-disabled], :disabled, :has(> .ac-radio:disabled)) :is(.ac-option__title, .ac-option__desc)",
      ),
    ).toContain("opacity: 0.55;");
  });

  test("a detail is a line of its own under the description, in the same words' style", () => {
    render(
      <RadioGroup value="disk" onValueChange={() => {}} aria-label="Onde ficam os arquivos">
        <RadioCard
          value="disk"
          id="disk"
          checked
          title="Este servidor"
          description="Os arquivos ficam no disco dele."
          detail="2,4 GB de arquivos · 38 GB livres no disco"
        />
      </RadioGroup>,
    );
    const text = document.querySelector(".ac-option__text");
    expect([...(text?.children ?? [])].map((c) => [c.className, c.textContent])).toEqual([
      ["ac-option__head", "Este servidor"],
      ["ac-option__desc", "Os arquivos ficam no disco dele."],
      ["ac-option__desc", "2,4 GB de arquivos · 38 GB livres no disco"],
    ]);
  });
});

describe("Field", () => {
  test("label, example and error are wired to the control", () => {
    render(
      <>
        <Field label="Senha" id="pw" example="Pelo menos 8 caracteres.">
          <Input type="password" />
        </Field>
        <Field label="Orçamento" id="b" error="Use um valor maior que zero.">
          <Input />
        </Field>
      </>,
    );
    const pw = body().getByLabelText("Senha");
    expect(pw.getAttribute("aria-describedby")).toBe("pw-help");
    expect(document.getElementById("pw-help")?.textContent).toBe("Pelo menos 8 caracteres.");
    expect(pw.hasAttribute("aria-invalid")).toBe(false);
    const budget = body().getByLabelText("Orçamento");
    expect(budget.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("b-help")?.className).toBe("ac-field__error");
  });
});

describe("Tabs", () => {
  test("tablist with counts; selecting a tab shows its panel", async () => {
    function Harness() {
      const [tab, setTab] = useState<"pending" | "done">("pending");
      return (
        <Tabs
          value={tab}
          onValueChange={setTab}
          label="Filtro"
          items={[
            { value: "pending", label: "Pendentes", count: 2 },
            { value: "done", label: "Decididas", count: 2 },
          ]}
        >
          <TabPanel value="pending">Lista pendente</TabPanel>
          <TabPanel value="done">Lista decidida</TabPanel>
        </Tabs>
      );
    }
    render(<Harness />);
    const list = body().getByRole("tablist", { name: "Filtro" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Pendentes 2", "Decididas 2"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(body().getByRole("tabpanel").textContent).toBe("Lista pendente");
    // An inactive panel stays out of the layout: no inline display to beat its `hidden`.
    const inactive = document.querySelector(".ac-tabpanel[hidden]") as HTMLElement;
    expect(inactive.style.display).toBe("");
    await act(async () => {
      fireEvent.mouseDown(tabs[1] as HTMLElement, { button: 0 });
    });
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(body().getByRole("tabpanel").textContent).toBe("Lista decidida");
  });
});

describe("PickerHeading", () => {
  test("a section's label over its description, with a real gap between them", async () => {
    render(<PickerHeading label="Papéis" description="Quem tem o papel pode falar." />);
    const head = document.querySelector(".ac-picker-head");
    expect([...(head?.children ?? [])].map((c) => c.textContent)).toEqual(["Papéis", "Quem tem o papel pode falar."]);
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-picker-head")).toContain("flex-direction: column;");
    expect(rule(".ac-picker-head")).toContain("gap: var(--space-1);");
  });
});
