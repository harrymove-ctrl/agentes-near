import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { TFunction } from "i18next";
import { roleIcon } from "@/components/AgentFields";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
const typeIn = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const press = (el: Element, key: string) => act(async () => fireEvent.keyDown(el, { key }));
const saveBar = () => screen().queryByRole("region", { name: "Alterações não salvas" });
const save = async () => {
  await click(within(saveBar() as HTMLElement).getByRole("button", { name: /^Salvar/ }));
  await settle(6);
};
const updates = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.update").map((c) => c.args[2]);

const nameButton = () => screen().getByRole("button", { name: /^Editar nome/ });
const nameField = () => screen().getByLabelText("Nome") as HTMLInputElement;
const roleButton = () => screen().getByRole("button", { name: /^Editar cargo/ });
const roleField = () => screen().getByRole("combobox", { name: "Cargo" }) as HTMLInputElement;
const options = () => within(screen().getByRole("listbox", { name: "Cargos" })).getAllByRole("option");
const card = () => document.querySelector(".agp-id") as HTMLElement;

async function settings(state = seedState()) {
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings&sec=identity`, { api: createFakeApi(state) });
  await settle(10);
  return state;
}

describe("the agent's identity as a card", () => {
  test("the name edits in place: Esc puts it back, Enter and leaving keep it, in the save bar's draft", async () => {
    const state = await settings();
    expect(nameButton().textContent).toBe("Ada");
    expect(nameButton().getAttribute("aria-label")).toBe("Editar nome: Ada");

    await click(nameButton());
    expect(nameField().value).toBe("Ada");
    expect(document.activeElement === nameField()).toBe(true);
    await typeIn(nameField(), "Zé");
    await press(nameField(), "Escape");
    expect(screen().queryByLabelText("Nome")).toBeNull();
    expect(nameButton().textContent).toBe("Ada");
    expect(document.activeElement === nameButton()).toBe(true);
    expect(saveBar()).toBeNull();

    await click(nameButton());
    await typeIn(nameField(), "Ada Lovelace");
    await press(nameField(), "Enter");
    expect(nameButton().textContent).toBe("Ada Lovelace");
    expect(document.activeElement === nameButton()).toBe(true);
    // The @ follows the new name, the hint says the old one keeps working, what it was shows under the line.
    expect(screen().getByRole("button", { name: /^Editar menções/ }).textContent).toBe("@adalovelace");
    expect(card().textContent).toContain("As menções passam a ser por @adalovelace. @ada continua funcionando.");
    expect(card().querySelector(".agp-id__was")?.textContent).toContain("Ada");
    expect(saveBar()?.textContent).toContain("Nome e Menções");

    // Leaving the field keeps what was typed; nothing typed keeps the name.
    await click(nameButton());
    await typeIn(nameField(), "Ada King");
    await act(async () => fireEvent.blur(nameField()));
    expect(nameButton().textContent).toBe("Ada King");
    await click(nameButton());
    await typeIn(nameField(), "   ");
    await press(nameField(), "Enter");
    expect(nameButton().textContent).toBe("Ada King");

    await save();
    expect(updates(state)).toEqual([{ name: "Ada King", handle: "adaking" }]);
  });

  test("the role is a tag: picked from the roles the app knows, or typed as one of its own", async () => {
    const state = await settings();
    expect(roleButton().textContent).toBe("Dev");
    expect(roleButton().getAttribute("aria-label")).toBe("Editar cargo: Dev");

    await click(roleButton());
    expect(roleField().value).toBe("Dev");
    expect(roleField().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement === roleField()).toBe(true);
    // As it opens, every role "Criar agente" offers, the one it has highlighted and marked.
    expect(options().map((o) => o.textContent)).toEqual([
      "Devatual",
      "Ops",
      "QA",
      "PM",
      "Atendimento",
      "Vendas",
      "Marketing",
      "Conteúdo",
      "Dados",
      "Financeiro",
      "Pessoas",
      "Pesquisa",
      "Assistente",
    ]);
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(roleField().getAttribute("aria-activedescendant")).toBe(options()[0]?.id ?? "");
    // The arrows move, Enter picks; the focus goes back to the tag.
    await press(roleField(), "ArrowDown");
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(roleField().getAttribute("aria-activedescendant")).toBe(options()[1]?.id ?? "");
    await press(roleField(), "Enter");
    expect(roleButton().textContent).toBe("Ops");
    expect(document.activeElement === roleButton()).toBe(true);

    // Typing filters and offers what was typed; Enter takes the highlighted one, the first.
    await click(roleButton());
    await typeIn(roleField(), "aten");
    expect(options().map((o) => o.textContent)).toEqual(["Atendimento", "Usar “aten”"]);
    await press(roleField(), "Enter");
    expect(roleButton().textContent).toBe("Atendimento");

    // A role of its own, picked with a click.
    await click(roleButton());
    await typeIn(roleField(), "Pesquisa de preços");
    expect(options().map((o) => o.textContent)).toEqual(["Usar “Pesquisa de preços”"]);
    await click(options()[0] as HTMLElement);
    expect(roleButton().textContent).toBe("Pesquisa de preços");

    // Esc puts it back; leaving keeps what was typed.
    await click(roleButton());
    await typeIn(roleField(), "Suporte N2");
    await press(roleField(), "Escape");
    expect(screen().queryByRole("combobox", { name: "Cargo" })).toBeNull();
    expect(roleButton().textContent).toBe("Pesquisa de preços");
    await click(roleButton());
    await typeIn(roleField(), "Suporte N2");
    await act(async () => fireEvent.blur(roleField()));
    expect(roleButton().textContent).toBe("Suporte N2");
    expect(card().querySelector(".agp-id__was")?.textContent).toContain("Dev");
    expect(saveBar()?.textContent).toContain("Cargo");

    await save();
    expect(updates(state)).toEqual([{ role: "Suporte N2" }]);
  });

  test("a member reads the same card: no pencils, no fields, the role as a still chip", async () => {
    const member = () => {
      const state = seedState();
      if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
      return state;
    };
    await settings(member());
    expect(within(card()).queryAllByRole("button")).toEqual([]);
    expect(card().querySelector(".agp-inplace__pen, .agp-roletag__pen")).toBeNull();
    expect(screen().queryByLabelText("Nome")).toBeNull();
    expect(screen().queryByRole("combobox", { name: "Cargo" })).toBeNull();
    expect(card().querySelector(".agp-id__name")?.textContent).toBe("Ada");
    expect(card().querySelector(".agp-id__handle")?.textContent).toBe("@ada");
    const tag = card().querySelector(".agp-roletag") as HTMLElement;
    expect(tag.tagName).toBe("SPAN");
    expect(tag.textContent).toBe("Dev");
    // What the card is for sits behind the ⓘ on its section's head, not under the name.
    expect(card().textContent).not.toContain("É como todo mundo vê o agente.");
    const about = screen().getByRole("button", { name: "Sobre Identidade e jeito" });
    expect(document.getElementById(about.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "É como todo mundo vê o agente. O @ acompanha o nome.",
    );

    cleanup();
    const noRole = member();
    const ada = noRole.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.role = "";
    await settings(noRole);
    expect(card().querySelector(".agp-roletag")?.textContent).toBe("Sem cargo");
  });

  test("a long name and role read whole, as the screen's worst case: nothing cut to fit the card", async () => {
    const long = seedState();
    const ada = long.agents.find((a) => a.id === ADA_ID);
    const role = "Desenvolvedora de software sênior responsável pelas integrações com os parceiros";
    if (ada) {
      ada.name = "Ada Beatriz Lovelace Byron de Almeida";
      ada.role = role;
    }
    await settings(long);
    expect(nameButton().textContent).toBe("Ada Beatriz Lovelace Byron de Almeida");
    expect(card().querySelector(".agp-roletag__text")?.textContent).toBe(role);
  });
});

test("a role's icon is the one Criar agente gives that name in the person's language, else the agent's", () => {
  const names: Record<string, string> = {
    "newAgent.roles.support.name": "Atendimento",
    "newAgent.roles.dev.name": "Dev",
  };
  const t = ((key: string) => names[key] ?? key) as unknown as TFunction;
  expect(roleIcon(t, "Atendimento")).toBe("message");
  expect(roleIcon(t, " atendímento ")).toBe("message");
  expect(roleIcon(t, "dev")).toBe("code");
  expect(roleIcon(t, "Tech lead")).toBe("agent");
  expect(roleIcon(t, "")).toBe("agent");
});
