import { afterEach, describe, expect, jest, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { HOVER_CLOSE_MS, HOVER_SWITCH_MS } from "@agenteschat/ui";
import { box, mouse, place, step, tick } from "@agenteschat/ui/testing";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { HOVER_OPEN_MS } from "@/components/ProfileCard";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  // happy-dom's window (shared by every DOM file) runs its 0 ms timeouts as one batch on a timer of its own: dropped
  // while fake, that batch never runs and no later file's window timeout fires again (Radix's outside-press
  // listener, a smooth scroll).
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

const { enter, leave, move } = mouse;
const cards = () => screen().queryAllByRole("dialog", { name: "Perfil" });
/** Whose profile cards are open: the name each one shows. */
const shown = () => cards().map((c) => c.querySelector(".profile-card__name")?.textContent);
const article = (text: string) =>
  screen()
    .getAllByRole("article")
    .find((a) => a.textContent?.includes(text)) as HTMLElement;

/*
 * João's name on his message's first line, his card 6 px under it. The @Ada mention right of his name, over the way
 * from his name to the far side of his card; Ada's own name further right.
 */
const JOAO = box(60, 100, 50, 18);
const JOAO_CARD = box(60, 124, 300, 220);
const MENTION = box(150, 106, 40, 14);
const ADA = box(400, 100, 40, 18);

/** The channel, its timers fake from here on, with João's card open under a resting mouse. */
async function joaoOpen() {
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
  await settle(6);
  jest.useFakeTimers();
  const joao = screen().getAllByRole("button", { name: "Perfil de João" })[0] as HTMLElement;
  const mention = within(article("o login está devolvendo 401")).getByRole("button", { name: "Perfil de Ada" });
  const ada = within(article("Achei a causa")).getAllByRole("button", { name: "Perfil de Ada" })[0] as HTMLElement;
  place(joao, JOAO);
  place(mention, MENTION);
  place(ada, ADA);
  await enter(joao, 85, 109);
  await tick(HOVER_OPEN_MS);
  place(cards()[0] ?? null, JOAO_CARD);
  expect(shown()).toEqual(["João"]);
  return { joao, mention, ada, text: article("o login está devolvendo 401") };
}

describe("the profile card opened on hover", () => {
  test("moving toward the card along the way keeps it open, over the text and a mention on the way", async () => {
    const { joao, mention, text } = await joaoOpen();
    // Out of the name's right side toward the far end of the card, slower than the close delay.
    await leave(joao, 110, 110, text);
    await move(text, 130, 112);
    await tick(HOVER_CLOSE_MS - 50);
    await enter(mention, 160, 115);
    await move(mention, 180, 118);
    await tick(HOVER_CLOSE_MS - 50);
    await leave(mention, 190, 119, text);
    await move(text, 240, 121);
    await tick(HOVER_CLOSE_MS - 50);
    expect(shown()).toEqual(["João"]);
    await enter(cards()[0] as HTMLElement, 250, 140);
    await tick(HOVER_CLOSE_MS * 5);
    expect(shown()).toEqual(["João"]);
  });

  test("a brief exit from the name or the card, and back, keeps it open", async () => {
    const { joao, text } = await joaoOpen();
    await leave(joao, 85, 100, text);
    await move(text, 85, 92);
    await tick(HOVER_CLOSE_MS - 100);
    await enter(joao, 85, 101);
    await tick(HOVER_CLOSE_MS * 2);
    expect(shown()).toEqual(["João"]);
    const card = cards()[0] as HTMLElement;
    await leave(joao, 85, 118, card);
    await enter(card, 85, 130);
    await leave(card, 361, 200, text);
    await move(text, 370, 200);
    await tick(HOVER_CLOSE_MS - 100);
    await enter(card, 359, 200);
    await tick(HOVER_CLOSE_MS * 2);
    expect(shown()).toEqual(["João"]);
  });

  test("settling on something else closes it, the close delay after the pointer left", async () => {
    const { joao, text } = await joaoOpen();
    await leave(joao, 85, 100, text);
    await move(text, 85, 80);
    await tick(HOVER_CLOSE_MS - 1);
    expect(shown()).toEqual(["João"]);
    await tick(1);
    expect(shown()).toEqual([]);
  });

  test("another name the pointer rests on switches cards after a short rest, never two open", async () => {
    const { joao, ada, text } = await joaoOpen();
    await leave(joao, 110, 102, text);
    await move(text, 250, 102);
    await enter(ada, 400, 104);
    expect(shown()).toEqual(["João"]);
    await tick(HOVER_SWITCH_MS);
    expect(shown()).toEqual(["Ada"]);
    await leave(ada, 400, 104, text);
    await enter(joao, 109, 104);
    await tick(HOVER_SWITCH_MS);
    expect(shown()).toEqual(["João"]);
  });

  test("a click on another name, as its card takes over, leaves that card open", async () => {
    const { joao, ada, text } = await joaoOpen();
    await leave(joao, 110, 102, text);
    await move(text, 250, 102);
    await enter(ada, 400, 104);
    await tick(HOVER_SWITCH_MS);
    await step(() => fireEvent.click(ada));
    expect(shown()).toEqual(["Ada"]);
  });

  test("a member's card opens from the members column and stays while the pointer goes over to it", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(6);
    jest.useFakeTimers();
    const side = screen().getByRole("complementary", { name: "Membros de #eng" });
    const row = within(side).getByRole("button", { name: "Perfil de João" });
    place(row, box(1186, 300, 244, 46));
    await enter(row, 1300, 320);
    await tick(HOVER_OPEN_MS);
    expect(shown()).toEqual(["João"]);
    // His card to the column's left: out of the row, to the card.
    const card = cards()[0] as HTMLElement;
    place(card, box(880, 260, 300, 220));
    await leave(row, 1186, 320, card);
    await enter(card, 1170, 320);
    await tick(HOVER_CLOSE_MS * 3);
    expect(shown()).toEqual(["João"]);
    await leave(card, 860, 320);
    await move(document.body, 850, 320);
    await tick(HOVER_CLOSE_MS);
    expect(shown()).toEqual([]);
  });
});
