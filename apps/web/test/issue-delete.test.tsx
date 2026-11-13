import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { canDeleteIssue } from "@agenteschat/client/lib/issues";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const cardOf = (number: number) => document.querySelector<HTMLElement>(`[data-card="${number}"]`) as HTMLElement;
const board = async (state = seedState()) => {
  const api = createFakeApi(state);
  await renderApp(`/org/${ORG_ID}/issues`, { api });
  await settle(8);
  return { api, state };
};
const menu = async (number: number) => {
  await act(async () => fireEvent.contextMenu(cardOf(number), { clientX: 10, clientY: 10 }));
  await settle(2);
  return screen().queryByRole("menu");
};

describe("Excluir tarefa", () => {
  test("the card's menu asks first, says what goes with it, and the card leaves the board", async () => {
    const { state } = await board();
    const items = await menu(128);
    await click(within(items as HTMLElement).getByRole("menuitem", { name: "Excluir tarefa" }));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Excluir a tarefa #128?" });
    expect(dialog.textContent).toContain("com a conversa e os arquivos da conversa");
    expect(dialog.textContent).toContain("Não dá para desfazer.");
    await click(within(dialog).getByRole("button", { name: "Excluir" }));
    await settle(6);
    expect(state.calls.some((c) => c.method === "issues.delete")).toBe(true);
    expect(cardOf(128)).toBeNull();
    expect(document.querySelector(".ac-toast")?.textContent).toContain("Tarefa #128 excluída.");
  });

  test("the task's own dialog and page have it too", async () => {
    await board();
    await click(cardOf(128));
    await settle(4);
    const dialog = screen().getAllByRole("dialog").at(-1) as HTMLElement;
    // In the dialog, behind ⋯ beside the ×, after a divider.
    const more = within(dialog).getByRole("button", { name: "Mais opções" });
    more.focus();
    await act(async () => fireEvent.keyDown(more, { key: "Enter" }));
    await settle(2);
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Excluir tarefa" }));
    await settle(3);
    expect(screen().getByRole("dialog", { name: "Excluir a tarefa #128?" })).toBeTruthy();
    cleanup();
    await renderApp(`/org/${ORG_ID}/issues/128`, { api: createFakeApi(seedState()) });
    await settle(8);
    expect(screen().getByRole("button", { name: "Excluir tarefa" })).toBeTruthy();
  });

  test("Cancelar keeps it", async () => {
    const { state } = await board();
    const items = await menu(128);
    await click(within(items as HTMLElement).getByRole("menuitem", { name: "Excluir tarefa" }));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Excluir a tarefa #128?" });
    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await settle(3);
    expect(state.calls.some((c) => c.method === "issues.delete")).toBe(false);
    expect(cardOf(128)).toBeTruthy();
  });

  test("a member who didn't create it isn't offered it, and who may is the same rule everywhere", () => {
    const task = { createdBy: { type: "person" as const, id: "u-joao" } };
    const agents = { createdBy: { type: "agent" as const, id: "a-ada" } };
    const member = { permissions: ["read", "assign_work"] };
    const admin = { permissions: ["read", "administrator"] };
    expect(canDeleteIssue(member, task, "u-ana")).toBe(false);
    expect(canDeleteIssue(member, task, "u-joao")).toBe(true);
    expect(canDeleteIssue(admin, task, "u-ana")).toBe(true);
    expect(canDeleteIssue(member, agents, "u-ana")).toBe(true);
    expect(canDeleteIssue({ permissions: ["read"] }, agents, "u-ana")).toBe(false);
  });
});
