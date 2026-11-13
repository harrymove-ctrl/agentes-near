import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { render } from "@testing-library/react";
import { Field, Input, SettingRow } from "../src";

describe("help behind an ⓘ", () => {
  test("a field's ⓘ says what it is for, a format example sits under the control and describes it, an error replaces it", () => {
    const { container, rerender } = render(
      <Field
        label="Endereço do webhook"
        hint={{ name: "Sobre Endereço do webhook", text: "Recebe um aviso a cada tarefa concluída." }}
        example="ex.: https://acme.example/webhook"
      >
        <Input />
      </Field>,
    );
    const input = container.querySelector("input") as HTMLInputElement;
    expect(container.querySelector(".ac-hintline .ac-hint")?.getAttribute("aria-label")).toBe(
      "Sobre Endereço do webhook",
    );
    const example = container.querySelector(".ac-field__example");
    expect(example?.textContent).toBe("ex.: https://acme.example/webhook");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(example?.id as string);
    rerender(
      <Field label="Endereço do webhook" example="ex.: https://acme.example/webhook" error="Use um endereço https.">
        <Input />
      </Field>,
    );
    expect(container.querySelector(".ac-field__example")).toBeNull();
    expect(container.querySelector(".ac-field__error")?.textContent).toBe("Use um endereço https.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  test("a setting's ⓘ sits beside its title, outside its label; a status that must stay in sight sits under it", () => {
    const { container } = render(
      <SettingRow
        title="Resumo semanal"
        htmlFor="weekly"
        hint={{ name: "Sobre Resumo semanal", text: "Toda segunda, o que o time fez na semana." }}
        status="Desligado pelos admins."
      >
        <input id="weekly" type="checkbox" />
      </SettingRow>,
    );
    const line = container.querySelector(".ac-setrow__text > .ac-hintline");
    expect(line?.querySelector("label.ac-setrow__title")?.textContent).toBe("Resumo semanal");
    expect(line?.querySelector("label .ac-hint")).toBeNull();
    expect(line?.querySelector(":scope > .ac-hint")?.getAttribute("aria-label")).toBe("Sobre Resumo semanal");
    expect(container.querySelector(".ac-setrow__status")?.textContent).toBe("Desligado pelos admins.");
    expect(container.querySelector(".ac-setrow__desc")).toBeNull();
  });
});
