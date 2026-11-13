import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { COMPACT_QUERY } from "@/components/NavDrawer";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, screen, settle } from "./render";

/* The account button at the foot of the sidebar: a menu right above it, me on top, my status in a menu beside it. */

/** A phone: only the compact query matches (the rest goes to the real `matchMedia`). */
let restore: (() => void) | null = null;
function onPhone() {
  const real = window.matchMedia.bind(window);
  window.matchMedia = ((query: string) =>
    query === COMPACT_QUERY
      ? ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        } as unknown as MediaQueryList)
      : real(query)) as typeof window.matchMedia;
  restore = () => {
    window.matchMedia = real;
  };
}

afterEach(() => {
  cleanup();
  restore?.();
  restore = null;
});

const go = async (state = seedState()) => {
  const fake = createFakeAuth();
  // As the server: after signing out, no session, no one.
  const signOut = fake.auth.signOut;
  fake.auth.signOut = async () => {
    await signOut();
    state.me = null;
  };
  // As the server: the account's name is its member's name in every workspace.
  const updateName = fake.auth.updateName;
  fake.auth.updateName = async (name) => {
    const result = await updateName(name);
    if (state.me) state.me.user.name = name;
    for (const m of state.members) if (m.userId === state.me?.user.id) m.name = name;
    return result;
  };
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state), auth: fake.auth });
  await settle(6);
  return { ...r, state, authCalls: fake.calls };
};
const account = () => screen().getByRole("button", { name: /^Conta: / });
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
/** Radix menus open from the keyboard here (a pointer press, not a click, opens them with a mouse). */
const press = async (k: string, el = document.activeElement ?? document.body) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await settle(2);
};
const openMenu = async () => {
  account().focus();
  await press("Enter", account());
  return screen().getAllByRole("menu")[0] as HTMLElement;
};
/** "Definir status" → its menu beside (→ from the item). */
const openStatus = async () => {
  const menu = await openMenu();
  within(menu).getByRole("menuitem", { name: "Definir status" }).focus();
  await press("ArrowRight");
  return screen().getAllByRole("menu")[1] as HTMLElement;
};
const names = (els: HTMLElement[]) => els.map((el) => el.getAttribute("aria-label") ?? el.textContent);
const statusCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "orgs.setStatus").map((c) => c.args);

describe("the account menu", () => {
  test("Enter opens it: me on top, my face first, then four items; Esc closes it and focus is back on the row", async () => {
    await go();
    const row = account();
    expect(row.getAttribute("aria-haspopup")).toBe("menu");
    const menu = await openMenu();
    expect(row.getAttribute("aria-expanded")).toBe("true");
    // Not a full-screen sheet: nothing blurs the app behind it.
    expect(document.documentElement.hasAttribute("data-menu-overlay")).toBe(false);
    const head = menu.querySelector(".profile-menu__head");
    expect(head?.textContent).toContain("Walter");
    expect(head?.textContent).toContain("@walter · Online");
    expect(head?.querySelector(".ac-presence")?.getAttribute("data-presence")).toBe("online");
    expect(names(within(menu).getAllByRole("menuitem"))).toEqual([
      "Trocar foto",
      "Definir status",
      "Editar perfil",
      "Configurações",
      "Sair",
    ]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Trocar foto");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Definir status");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Editar perfil");
    await press("Escape");
    expect(screen().queryByRole("menu")).toBeNull();
    expect(document.activeElement === row).toBe(true);
  });

  test("Definir status: → opens how I appear (mine checked) and what I'm up to, ← goes back to the item", async () => {
    await go();
    const status = await openStatus();
    const radios = within(status).getAllByRole("menuitemradio");
    expect(names(radios)).toEqual(["Online", "Ausente", "Ocupado", "Fora do escritório", "Oculto"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false", "false"]);
    // Each choice with its badge, drawn as on my face.
    expect(radios.map((r) => r.querySelector(".ac-presence")?.getAttribute("data-presence"))).toEqual([
      "online",
      "away",
      "busy",
      "out",
      "hidden",
    ]);
    expect(within(status).getByRole("menuitem", { name: "O que você está fazendo?" })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Online");
    await press("ArrowLeft");
    expect(screen().getAllByRole("menu")).toHaveLength(1);
    expect(document.activeElement?.textContent).toBe("Definir status");
  });

  test("picking Ocupado saves it: my row and its badge say so, and how I appear is told; mine again sends nothing", async () => {
    const { state } = await go();
    await click(within(await openStatus()).getByRole("menuitemradio", { name: "Ocupado" }));
    expect(statusCalls(state)).toEqual([[ORG_ID, { availability: "busy" }]]);
    expect(screen().queryByRole("menu")).toBeNull();
    expect(account().querySelector(".sidebar__user-line")?.textContent).toBe("Ocupado");
    expect(account().querySelector(".ac-presence")?.getAttribute("data-presence")).toBe("busy");
    expect(screen().getByText("Você aparece como ocupado")).toBeTruthy();
    await click(within(await openStatus()).getByRole("menuitemradio", { name: "Ocupado" }));
    expect(statusCalls(state)).toHaveLength(1);
  });

  test("with a line: it sits under my name in a well with when it clears, and what I'm up to opens it to change", async () => {
    const state = seedState();
    state.statuses = new Map([
      ["u-walter", { availability: "busy", status: { text: "Em reunião", emoji: "📅", until: null } }],
    ]);
    await go(state);
    const menu = await openMenu();
    expect(menu.querySelector(".profile-menu__head")?.textContent).toContain("@walter · Ocupado");
    expect(menu.querySelector(".profile-menu__line")?.textContent).toBe("📅Em reuniãoAté você mudar");
    // Past my face, the first row.
    await press("ArrowDown");
    await press("ArrowRight");
    const status = screen().getAllByRole("menu")[1] as HTMLElement;
    expect(within(status).getByRole("menuitemradio", { name: "Ocupado" }).getAttribute("aria-checked")).toBe("true");
    await click(within(status).getByRole("menuitem", { name: "O que você está fazendo?" }));
    const dialog = screen().getByRole("dialog", { name: "Definir status" });
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "O que você está fazendo?" }).value).toBe(
      "Em reunião",
    );
  });

  test("Editar perfil opens my profile over the page, on my @; closing it, focus is back on the row", async () => {
    const { router } = await go();
    const row = account();
    await click(within(await openMenu()).getByRole("menuitem", { name: "Editar perfil" }));
    const dialog = screen().getByRole("dialog", { name: "Seu perfil neste workspace" });
    expect(document.activeElement === within(dialog).getByLabelText("Seu nome")).toBe(true);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(document.activeElement === row).toBe(true);
  });

  test("my face on top changes my photo: Enter on it asks how I want to appear, Esc brings focus back to the row", async () => {
    const { router } = await go();
    const row = account();
    const menu = await openMenu();
    const face = within(menu).getByRole("menuitem", { name: "Trocar foto" });
    // My face as everywhere, with how I appear; the glyph over it shows on hover and focus, the photo badge on a touch
    // screen, both for the eyes only.
    expect(face.getAttribute("title")).toBe("Trocar foto");
    expect(face.querySelector(".ac-avatar .ac-presence")?.getAttribute("data-presence")).toBe("online");
    for (const part of [".ac-face-edit__glyph", ".ac-face-edit__badge"])
      expect(face.querySelector(part)?.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement === face).toBe(true);
    await press("Enter");
    await settle(2);
    expect(screen().queryByRole("menu")).toBeNull();
    const ask = screen().getByRole("dialog", { name: "Como você quer aparecer?" });
    expect(within(ask).getByRole("button", { name: /^Criar um avatar/ })).toBeTruthy();
    expect(within(ask).getByRole("button", { name: /^Enviar uma foto/ })).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    await press("Escape");
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(document.activeElement === row).toBe(true);
  });

  test("its question leads where Editar perfil's does: the photo to upload, or the avatar builder", async () => {
    await go();
    await click(within(await openMenu()).getByRole("menuitem", { name: "Trocar foto" }));
    await click(
      within(screen().getByRole("dialog", { name: "Como você quer aparecer?" })).getByRole("button", {
        name: /^Enviar uma foto/,
      }),
    );
    const photo = screen().getByRole("dialog", { name: "Foto do perfil" });
    expect(within(photo).getByRole("button", { name: /Solte uma imagem aqui/ })).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: "Como você quer aparecer?" })).toBeNull();
    await press("Escape");
    expect(screen().queryByRole("dialog")).toBeNull();

    await click(within(await openMenu()).getByRole("menuitem", { name: "Trocar foto" }));
    await click(
      within(screen().getByRole("dialog", { name: "Como você quer aparecer?" })).getByRole("button", {
        name: /^Criar um avatar/,
      }),
    );
    const builder = screen().getByRole("dialog", { name: "Seu avatar" });
    expect(within(builder).getByRole("radio", { name: "Masculino" })).toBeTruthy();
    // The photo is one link away there too.
    await click(within(builder).getByRole("button", { name: "Enviar foto" }));
    expect(screen().getByRole("dialog", { name: "Foto do perfil" })).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: "Seu avatar" })).toBeNull();
  });

  test("a long name and @ are whole on top and at the foot, the name's capitals at the face's top", async () => {
    const long = "Maria Eduarda Albuquerque de Vasconcelos Figueiredo";
    const state = seedState();
    const walter = state.members.find((m) => m.userId === "u-walter");
    if (walter) Object.assign(walter, { name: long, handle: "maria.eduarda.vasconcelos.figueiredo" });
    if (state.me) state.me.user.name = long;
    await go(state);
    expect(account().querySelector(".sidebar__user-name")?.textContent).toBe(long);
    const head = (await openMenu()).querySelector(".profile-menu__head");
    // The name's capitals start at the face's top, as beside any face taller than its line.
    expect(head?.querySelector(".profile-card__name.ac-captop")?.textContent).toBe(long);
    expect(head?.textContent).toContain("@maria.eduarda.vasconcelos.figueiredo · Online");
  });

  test("my name is in my profile: one Salvar saves it, and the directory shows it at once", async () => {
    const state = seedState();
    const { authCalls } = await go(state);
    const me = state.me;
    await click(within(await openMenu()).getByRole("menuitem", { name: "Editar perfil" }));
    const dialog = screen().getByRole("dialog", { name: "Seu perfil neste workspace" });
    const name = within(dialog).getByLabelText<HTMLInputElement>("Seu nome");
    expect(name.value).toBe(me?.user.name ?? "");
    await act(async () => fireEvent.change(name, { target: { value: "  Walter Lima " } }));
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(authCalls.filter((c) => c.method === "updateName")).toEqual([
      { method: "updateName", args: ["Walter Lima"] },
    ]);
    expect(state.calls.filter((c) => c.method === "orgs.updateMe")).toHaveLength(1);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(account().getAttribute("aria-label")).toContain("Walter Lima");
  });

  test("an empty name can't be saved", async () => {
    const { authCalls, state } = await go();
    await click(within(await openMenu()).getByRole("menuitem", { name: "Editar perfil" }));
    const dialog = screen().getByRole("dialog", { name: "Seu perfil neste workspace" });
    await act(async () => fireEvent.change(within(dialog).getByLabelText("Seu nome"), { target: { value: "   " } }));
    expect(within(dialog).getByText("Escreva seu nome.")).toBeTruthy();
    const save = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Salvar" });
    expect(save.disabled).toBe(true);
    await act(async () => fireEvent.submit(save.closest("form") as HTMLFormElement));
    await settle(2);
    expect(authCalls.some((c) => c.method === "updateName")).toBe(false);
    expect(state.calls.some((c) => c.method === "orgs.updateMe")).toBe(false);
  });

  test("Configurações opens Sua conta in the settings", async () => {
    const { router } = await go();
    await click(within(await openMenu()).getByRole("menuitem", { name: "Configurações" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/account`);
    expect(screen().getByRole("heading", { level: 2, name: "Sua conta" })).toBeTruthy();
  });

  test("Sair signs out and goes to sign in", async () => {
    const { router, authCalls } = await go();
    await click(within(await openMenu()).getByRole("menuitem", { name: "Sair" }));
    await settle(4);
    expect(authCalls.map((c) => c.method)).toEqual(["signOut"]);
    expect(router.state.location.pathname).toBe("/login");
  });

  test("on a phone, with no room beside it, how I appear is in the menu itself", async () => {
    onPhone();
    await go();
    await click(screen().getAllByRole("button", { name: "Abrir menu" })[0] as HTMLElement);
    const menu = await openMenu();
    expect(within(menu).queryByRole("menuitem", { name: "Definir status" })).toBeNull();
    expect(names(within(menu).getAllByRole("menuitemradio"))).toEqual([
      "Online",
      "Ausente",
      "Ocupado",
      "Fora do escritório",
      "Oculto",
    ]);
    expect(names(within(menu).getAllByRole("menuitem"))).toEqual([
      "Trocar foto",
      "O que você está fazendo?",
      "Editar perfil",
      "Configurações",
      "Sair",
    ]);
  });
});
