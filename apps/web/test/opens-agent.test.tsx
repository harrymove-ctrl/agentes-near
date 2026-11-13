import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { COMPACT_QUERY } from "@/components/NavDrawer";
import { DM_SIDE_WIDE_QUERY } from "@/hooks/useMembersColumn";
import { ADA_ID, createFakeApi, ENG_ID, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

let media: { mockRestore: () => void } | null = null;
afterEach(() => {
  cleanup();
  media?.mockRestore();
  media = null;
  localStorage.clear();
});

const widthIs = (query: string) => {
  media = spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === query,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
};

const PICTURE = { name: "Perfil de Ada" };
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(6);
};
const go = async (state: FakeState, path = `c/${ENG_ID}`) => {
  await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(10);
};
const card = () => screen().queryByRole("dialog", { name: "Perfil" });
const panel = () => screen().queryByRole("complementary", { name: "Perfil da Ada" });
const openCard = async () => {
  const trigger = screen()
    .getAllByRole("button", PICTURE)
    .find((b) => !b.hasAttribute("aria-hidden"));
  await click(trigger as HTMLElement);
  return card() as HTMLElement;
};
const picture = (c: HTMLElement) =>
  within(c.querySelector(".mcard__face") as HTMLElement).queryByRole("button", PICTURE);

/** A viewer who sees only Ada's public card. */
const noDetails = (state = seedState()) => {
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) {
    ada.ownerUserId = "u-joao";
    ada.audience = { mode: "owner", userIds: [] };
    ada.seesDetails = false;
  }
  return state;
};

describe("the picture on an agent's card", () => {
  test("a named button that opens its details beside the conversation, and the card closes", async () => {
    await go(seedState());
    const button = picture(await openCard()) as HTMLButtonElement;
    expect(button.tagName).toBe("BUTTON");
    expect(button.classList.contains("profile-trigger")).toBe(true);
    await click(button);
    expect(panel()).toBeTruthy();
    expect(card()).toBeNull();
  });

  test("with its panel already open it stays open, where its other openers close it", async () => {
    await go(seedState());
    await click(picture(await openCard()) as HTMLElement);
    await click(picture(await openCard()) as HTMLElement);
    expect(panel()).toBeTruthy();
    expect(card()).toBeNull();
  });

  test("the panel keeps the focus, and gives it back to what opened the card", async () => {
    await go(seedState());
    const c = await openCard();
    const trigger = screen()
      .getAllByRole("button", PICTURE)
      .find((b) => !b.hasAttribute("aria-hidden") && !c.contains(b)) as HTMLElement;
    const button = picture(c) as HTMLElement;
    button.focus();
    await click(button);
    expect(panel()?.contains(document.activeElement)).toBe(true);
    await click(within(panel() as HTMLElement).getByRole("button", { name: "Fechar" }));
    await act(() => new Promise((done) => requestAnimationFrame(done)));
    expect(document.activeElement).toBe(trigger);
  });

  test("unsaved edits in its open panel aren't asked about: the panel stays as it is", async () => {
    await go(seedState());
    await click(picture(await openCard()) as HTMLElement);
    panel()?.querySelector(".thread-panel__page")?.setAttribute("data-dirty", "");
    await click(picture(await openCard()) as HTMLElement);
    expect(panel()).toBeTruthy();
    expect(screen().queryByRole("alertdialog")).toBeNull();
  });

  test("its status dot opens nothing", async () => {
    await go(seedState());
    const c = await openCard();
    const dot = c.querySelector(".ac-avatar__badge") as HTMLElement;
    expect(dot).toBeTruthy();
    await click(dot);
    expect(panel()).toBeNull();
    expect(card()).toBeTruthy();
  });

  test("plain for who sees only its public card", async () => {
    await go(noDetails());
    const c = await openCard();
    expect(picture(c)).toBeNull();
    expect(c.querySelector(".mcard__face .ac-avatar")).toBeTruthy();
  });

  test("plain for an agent no longer in the team", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    state.agents = state.agents.filter((a) => a.id !== ADA_ID);
    state.former = [{ id: ADA_ID, name: ada?.name ?? "", role: "", appearance: {}, deleted: false }];
    await go(state);
    const trigger = screen()
      .getAllByRole("button", PICTURE)
      .find((b) => !b.hasAttribute("aria-hidden"));
    await click(trigger as HTMLElement);
    expect(picture(card() as HTMLElement)).toBeNull();
  });
});

describe("the picture in a channel's details", () => {
  test("opens the panel, and the dialog closes with what it was saving", async () => {
    await go(seedState());
    await click(within(screen().getByRole("main")).getByRole("button", { name: "Configurações do canal" }));
    const dialog = () => screen().queryByRole("dialog", { name: "#eng" });
    await click(within(dialog() as HTMLElement).getByRole("button", { name: "Membros" }));
    await click(within(dialog() as HTMLElement).getByRole("button", PICTURE));
    expect(panel()).toBeTruthy();
    expect(dialog()).toBeNull();
    expect(panel()?.contains(document.activeElement)).toBe(true);
  });
});

describe("the picture on the card from the phone's members sheet", () => {
  test("the panel takes the screen, and the sheet is back when it closes", async () => {
    widthIs(COMPACT_QUERY);
    await go(seedState());
    const sheet = () => screen().queryByRole("dialog", { name: "Membros de #eng" });
    await click(screen().getByRole("button", { name: /^Membros do canal/ }));
    await click(within(sheet() as HTMLElement).getByRole("button", PICTURE));
    await click(picture(card() as HTMLElement) as HTMLElement);
    expect(panel()).toBeTruthy();
    expect(sheet()).toBeNull();
    await click(within(panel() as HTMLElement).getByRole("button", { name: "Fechar" }));
    expect(sheet()).toBeTruthy();
  });
});

describe("the picture in a DM's sidebar", () => {
  const side = () => screen().queryByRole("complementary", { name: "Detalhes" });
  const openDm = async (state: FakeState) => {
    widthIs(DM_SIDE_WIDE_QUERY);
    await go(state, `dm/agent/${ADA_ID}`);
    return side() as HTMLElement;
  };

  test("opens the panel over the conversation, the sidebar staying under it out of reach", async () => {
    const aside = await openDm(seedState());
    await click(within(aside).getByRole("button", PICTURE));
    expect(panel()).toBeTruthy();
    expect(side()?.closest("[inert]")).toBeTruthy();
  });

  test("stays plain for who sees only its head", async () => {
    const aside = await openDm(noDetails());
    expect(within(aside).queryByRole("button", PICTURE)).toBeNull();
    expect(aside.querySelector(".dm-side__face .ac-avatar")).toBeTruthy();
  });
});
