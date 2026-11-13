import { afterEach, beforeEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

// What I type and don't send stays in this browser: switching conversations or reloading keeps it.

const BOOK = "agentes.drafts.u-walter";

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

const box = (name: string) => screen().getByRole("combobox", { name }) as HTMLTextAreaElement;
const type = (el: HTMLTextAreaElement, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

test("a text left in a channel's composer is there again after a reload, and only in that channel", async () => {
  const state = seedState();
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  await type(box("Mensagem para #eng"), "metade de uma ideia");
  await wait(500);
  expect(JSON.parse(localStorage.getItem(BOOK) ?? "{}")[`channel:${ENG_ID}`]?.text).toBe("metade de uma ideia");
  cleanup();

  // "Reload": the app starts again with the same browser storage.
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state), reload: true });
  await settle(8);
  expect(box("Mensagem para #eng").value).toBe("metade de uma ideia");
  cleanup();

  await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state), reload: true });
  await settle(8);
  expect(box("Mensagem para #general").value).toBe("");
});

test("leaving the conversation right after typing still keeps the text", async () => {
  const state = seedState();
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state), reload: true });
  await settle(8);
  await type(box("Mensagem para #eng"), "rápido");
  cleanup();
  expect(JSON.parse(localStorage.getItem(BOOK) ?? "{}")[`channel:${ENG_ID}`]?.text).toBe("rápido");
});

test("sending clears the saved text", async () => {
  const state = seedState();
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state), reload: true });
  await settle(8);
  const el = box("Mensagem para #eng");
  await type(el, "vai agora");
  await wait(500);
  await act(async () => fireEvent.keyDown(el, { key: "Enter" }));
  await settle(4);
  expect(state.calls.some((c) => c.method === "chat.post")).toBe(true);
  await wait(500);
  expect(localStorage.getItem(BOOK)).toBeNull();
});
