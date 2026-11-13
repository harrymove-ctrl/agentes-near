import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { click, press, typeIn } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const LONG_ROLE = "Assistente de e-mails, agenda e reuniões";

test("Criar agente › Do zero: a 40-character role types whole, with no count beside it", async () => {
  await renderApp(`/org/${ORG_ID}/agents/new`, { api: createFakeApi(seedState()) });
  await settle(8);
  await click(screen().getByRole("button", { name: /^Do zero/ }));
  const role = screen().getByLabelText("Cargo") as HTMLInputElement;
  expect(role.maxLength).toBe(200);
  await typeIn(role, LONG_ROLE);
  expect(role.value).toBe(LONG_ROLE);
  expect(role.closest(".ac-field")?.textContent).toContain(
    "O que ele faz pelo time, ex.: Assistente de e-mails e agenda.",
  );
  expect(role.closest(".ac-field")?.textContent).not.toContain("/16");
});

test("Editar: a 40-character role saves whole", async () => {
  const state = seedState();
  const api = createFakeApi(state);
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings&sec=identity`, { api });
  await settle(10);
  // The role is a tag: a click turns it into its field.
  await click(screen().getByRole("button", { name: /^Editar cargo/ }));
  const role = screen().getByRole("combobox", { name: "Cargo" }) as HTMLInputElement;
  expect(role.maxLength).toBe(200);
  await typeIn(role, LONG_ROLE);
  await press(role, "Enter");
  expect(screen().getByRole("button", { name: /^Editar cargo/ }).textContent).toBe(LONG_ROLE);
  await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Salvar/ })));
  await settle(6);
  const saved = state.calls.find((c) => c.method === "agents.update")?.args[2] as Record<string, unknown> | undefined;
  expect(saved?.role).toBe(LONG_ROLE);
});

test("where a role is cut to the line, it shows whole on hover", async () => {
  const state = seedState();
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.role = "Assistente de e-mails";
  seedDm(state, { type: "agent", id: ADA_ID });
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  // The sidebar's DM row.
  const row = document.querySelector(`[data-agent-row="${ADA_ID}"] .sidebar__item`);
  expect(row?.getAttribute("title")).toContain("Assistente de e-mails");
  // The channel's members column: the role is a one-line tag under the name, and the row's title has it whole.
  const member = [...document.querySelectorAll(".members-side__inner")].find((m) =>
    m.textContent?.includes("Assistente"),
  );
  expect(member?.querySelector(".members-side__line")?.textContent).toBe("Assistente de e-mails");
  expect(member?.querySelector(".members-side__line")?.classList.contains("ac-tag")).toBe(true);
  expect(member?.getAttribute("title")).toEndWith(" · Assistente de e-mails");
});
