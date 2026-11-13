import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const url = "https://github.com/acme/app/pull/40";
const strip = () => screen().getByRole("group", { name: "Detalhes da tarefa" });
/** "GitHub" at the strip's end opens the field to paste the link in its popover. */
const openField = async () => {
  await act(async () => fireEvent.click(within(strip()).getByRole("button", { name: "Adicionar link do GitHub" })));
  await settle(3);
  return screen().getByLabelText("Link do GitHub");
};
const paste = async (field: HTMLElement, text: string) => {
  await act(async () => fireEvent.change(field, { target: { value: text } }));
  await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
  await settle(4);
};

describe("a task's GitHub link", () => {
  test("pasted from the strip's GitHub it turns into a chip that opens it, and its × brings GitHub back", async () => {
    await renderApp(`/org/${ORG_ID}/issues/131`, { api: createFakeApi(seedState()) });
    await settle(6);
    const field = await openField();
    await paste(field, "https://github.com/acme/app");
    expect(screen().getByText("Esse não é o link de uma issue ou pull request do GitHub.")).toBeTruthy();
    await paste(screen().getByLabelText("Link do GitHub"), url);
    // Saved: the popover closes, the chip takes GitHub's place in the strip.
    expect(screen().queryByLabelText("Link do GitHub")).toBeNull();
    const chip = within(strip()).getByRole("link", { name: "app#40" });
    expect(chip.getAttribute("href")).toBe(url);
    expect(chip.getAttribute("rel")).toContain("noopener");
    await act(async () => fireEvent.click(within(strip()).getByRole("button", { name: "Remover o link do GitHub" })));
    await settle(4);
    expect(within(strip()).queryByRole("link", { name: "app#40" })).toBeNull();
    expect(within(strip()).getByRole("button", { name: "Adicionar link do GitHub" })).toBeTruthy();
  });

  test("Enter and the blur that follows it save once", async () => {
    const api = createFakeApi(seedState());
    let saves = 0;
    const update = api.issues.update.bind(api.issues);
    api.issues.update = (...args: Parameters<typeof update>) => {
      saves += 1;
      return update(...args);
    };
    await renderApp(`/org/${ORG_ID}/issues/131`, { api });
    await settle(6);
    const field = await openField();
    await act(async () => {
      fireEvent.change(field, { target: { value: url } });
    });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
      await Promise.resolve();
      fireEvent.blur(field);
    });
    await settle(4);
    expect(saves).toBe(1);
  });

  test("its card on the board shows the link among its facts", async () => {
    const api = createFakeApi(seedState());
    const task = await api.issues.get(ORG_ID, 131);
    await api.issues.update(ORG_ID, task.id, { githubUrl: url });
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(8);
    const card = document.querySelector('[data-card="131"]') as HTMLElement;
    expect(card.querySelector(`.ac-factline__fact[title="${url}"]`)?.textContent).toBe("app#40");
  });
});
