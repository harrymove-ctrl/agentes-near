import { afterEach, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { join } from "node:path";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { declarations } from "./built-css";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

const state = () => {
  const s = seedState();
  s.approvals = s.approvals.filter((a) => a.id === "ap-deploy");
  return s;
};
const hold = async () => {
  const s = state();
  await renderApp(`/org/${ORG_ID}/approvals`, { api: createFakeApi(s) });
  await settle(8);
  const button = document.querySelector<HTMLButtonElement>(".ap-hold") as HTMLButtonElement;
  button.setPointerCapture = () => {};
  return { s, button, capture: spyOn(button, "setPointerCapture") };
};
const decided = (s: ReturnType<typeof state>) => s.approvals.some((a) => a.status !== "pending");
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

test("the press is the button's: its label stays, so it keeps its width, and leaving it doesn't end the hold", async () => {
  const { s, button, capture } = await hold();
  const label = button.textContent;
  await act(async () => fireEvent.pointerDown(button, { button: 0, pointerId: 7 }));
  expect(capture).toHaveBeenCalledWith(7);
  expect(button.classList.contains("is-holding")).toBe(true);
  expect(button.textContent).toBe(label);
  await act(async () => fireEvent.pointerLeave(button, { pointerId: 7 }));
  expect(button.classList.contains("is-holding")).toBe(true);
  await wait(1150);
  expect(decided(s)).toBe(true);
});

test("let go early, nothing is approved and the click explains", async () => {
  const { s, button } = await hold();
  await act(async () => fireEvent.pointerDown(button, { button: 0, pointerId: 7 }));
  await act(async () => fireEvent.pointerUp(button, { pointerId: 7 }));
  await act(async () => fireEvent.click(button, { detail: 1 }));
  expect(button.classList.contains("is-holding")).toBe(false);
  await wait(1150);
  expect(decided(s)).toBe(false);
  expect(document.querySelector(".ac-toast")?.textContent).toContain("Segure o botão");
});

test("a finished hold no click ends (a finger's long press, a failed approve): the next plain click still explains", async () => {
  const api = createFakeApi(state());
  api.approvals.approve = () => Promise.reject(new Error("offline"));
  await renderApp(`/org/${ORG_ID}/approvals`, { api });
  await settle(8);
  const button = document.querySelector<HTMLButtonElement>(".ap-hold") as HTMLButtonElement;
  button.setPointerCapture = () => {};
  await act(async () => fireEvent.pointerDown(button, { button: 0, pointerId: 7 }));
  await wait(1150);
  await settle(4);
  await act(async () => fireEvent.pointerUp(button, { pointerId: 7 }));
  await act(async () => fireEvent.pointerDown(button, { button: 0, pointerId: 8 }));
  await act(async () => fireEvent.pointerUp(button, { pointerId: 8 }));
  await act(async () => fireEvent.click(button, { detail: 1 }));
  expect(document.querySelector(".ac-toasts")?.textContent).toContain("Segure o botão");
});

test("the browser takes the press away (a scroll, a lost capture): the hold ends", async () => {
  const { s, button } = await hold();
  await act(async () => fireEvent.pointerDown(button, { button: 0, pointerId: 7 }));
  await act(async () => fireEvent.lostPointerCapture(button, { pointerId: 7 }));
  await wait(1150);
  expect(decided(s)).toBe(false);
});

test("holding selects no text and a finger's press isn't taken for a scroll", async () => {
  const css = await Bun.file(join(import.meta.dir, "../src/pages/approvals.css")).text();
  expect(declarations(css, ".ap-hold")).toEqual(
    expect.arrayContaining([
      ["user-select", "none"],
      ["touch-action", "none"],
    ]),
  );
});
