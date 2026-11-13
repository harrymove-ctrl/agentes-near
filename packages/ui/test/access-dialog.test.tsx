import { describe, expect, mock, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { AccessDialog, type AccessLevel, type AccessSubject } from "../src";

const body = () => within(document.body);

const levels: AccessLevel[] = [
  { value: "view", label: "Ver" },
  { value: "edit", label: "Editar" },
];
const person = (id: string, name: string): AccessSubject => ({ id, name, lead: <span />, group: "Pessoas" });
const labels = {
  add: "Adicionar",
  addList: "Quem adicionar",
  addSearch: "Buscar",
  noResults: "Ninguém",
  removeOf: (name: string) => `Remover ${name}`,
  levelOf: (name: string) => `Nível de ${name}`,
  close: "Fechar",
  cancel: "Cancelar",
  save: "Salvar",
};

/** Waits for the open list: its rows mount a moment after the key, and with no layout here the popper hides them. */
const optionsOpen = async () => {
  for (let i = 0; i < 50; i++) {
    const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    if (found.length) return found;
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  throw new Error("the list didn't open");
};

/** Lets the dialog and the last dropdown hand focus back: a list opened before that closes on it, faster than any hand. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

const pick = async (name: string, option: string) => {
  await settle();
  const trigger = within(body().getByRole("dialog")).getByRole("combobox", { name });
  trigger.focus();
  await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
  const row = (await optionsOpen()).find((o) => o.textContent?.startsWith(option));
  if (!row) throw new Error(`no ${option}`);
  await act(async () => fireEvent.click(row));
};

describe("AccessDialog", () => {
  const setup = (over: { listed?: Record<string, string>; closed?: string[] } = {}) => {
    const onLevelChange = mock();
    const onSave = mock();
    const onBase = mock();
    const listed = over.listed ?? { ana: "view" };
    render(
      <AccessDialog
        title="Acesso a Deploy"
        base={[
          {
            id: "all",
            name: "Todos",
            lead: <span />,
            level: "view",
            levels: [{ value: "none", label: "Sem acesso" }, ...levels],
            onChange: onBase,
          },
        ]}
        subjects={[person("ana", "Ana"), person("bia", "Bia"), person("caio", "Caio")]}
        levelOf={(s) => listed[s.id]}
        levelsFor={(s) => (over.closed?.includes(s.id) ? [] : levels)}
        onLevelChange={onLevelChange}
        labels={labels}
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    return { onLevelChange, onSave, onBase };
  };

  test("a row is always there; others show once they're on the list", () => {
    setup();
    const d = within(body().getByRole("dialog"));
    expect(d.getByRole("combobox", { name: "Nível de Todos" })).toBeTruthy();
    expect(d.getByRole("combobox", { name: "Nível de Ana" })).toBeTruthy();
    expect(d.queryByRole("combobox", { name: "Nível de Bia" })).toBeNull();
    // Who is always there can't be taken out.
    expect(d.queryByRole("button", { name: "Remover Todos" })).toBeNull();
  });

  test("changing a level, taking someone out and adding someone at the highest level", async () => {
    const { onLevelChange, onBase } = setup();
    await pick("Nível de Ana", "Editar");
    expect(onLevelChange.mock.calls.at(-1)?.slice(1)).toEqual(["edit"]);
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Remover Ana" })));
    expect(onLevelChange.mock.calls.at(-1)?.slice(1)).toEqual([null]);
    await pick("Nível de Todos", "Sem acesso");
    expect(onBase).toHaveBeenCalledWith("none");
    await pick("Adicionar", "Bia");
    expect(onLevelChange.mock.calls.at(-1)?.[0].id).toBe("bia");
    expect(onLevelChange.mock.calls.at(-1)?.[1]).toBe("edit");
  });

  test("someone with no level to get isn't listed nor offered", async () => {
    setup({ listed: { ana: "view" }, closed: ["ana", "caio"] });
    expect(within(body().getByRole("dialog")).queryByRole("combobox", { name: "Nível de Ana" })).toBeNull();
    await settle();
    const trigger = within(body().getByRole("dialog")).getByRole("combobox", { name: "Adicionar" });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    const options = await optionsOpen();
    expect(options.map((o) => o.textContent)).toEqual(["Bia"]);
  });
});
