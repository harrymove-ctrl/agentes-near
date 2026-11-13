import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentBrowserSettings, BrowserHandoff } from "@agenteschat/client";
import { isBlankPage, openRefusalKey } from "@agenteschat/client/lib/sites";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { agentSearch } from "@/lib/agent-edit";
import { STORAGE_KEYS } from "@/lib/storage";
import { ADA_ID, createFakeApi, fakeBrowserOf, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const READY: AgentBrowserSettings = {
  allowedDomains: null,
  available: true,
  reason: null,
  detail: null,
  machine: { id: "machine-1", name: "MacBook do Walter" },
};
/** A JPEG's first bytes (SOI + a start-of-frame for 1280×800): enough for the page's size. */
const FRAME_DATA = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 3, 32, 5, 0, 3, 0, 0, 0));
const frame = (url = "https://loja.example.com/carrinho") => ({
  type: "browser.frame",
  agentId: ADA_ID,
  seq: 1,
  data: FRAME_DATA,
  metadata: { deviceWidth: 1280, deviceHeight: 800, url },
});

const ask = (over: Partial<BrowserHandoff> = {}): BrowserHandoff => ({
  id: "h-ask",
  agentId: ADA_ID,
  runId: "r-ask",
  machineId: "machine-1",
  kind: "ask",
  instructions: "Entrar no Stripe",
  status: "pending",
  requestedForUserId: "u-walter",
  controllerUserId: null,
  note: null,
  expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
  createdAt: new Date().toISOString(),
  resolvedAt: null,
  ...over,
});

/**
 * Ada on a Mac of Walter's (no screens there: the dialog shows her browser's page), on a self-hosted server;
 * `as`: who I am to Ada. A member who neither owns it nor was asked may not watch it.
 */
async function setup(options: { as?: "admin" | "owner" | "member"; sites?: string[] | null } = {}) {
  const state = seedState();
  // The header's Computador, the way in with the DM's sidebar closed.
  localStorage.setItem(`${STORAGE_KEYS.dmSidebar}.u-walter.${ORG_ID}`, "0");
  if (options.as === "owner" || options.as === "member") {
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  }
  if (options.as === "owner") {
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
  }
  state.scopes[ADA_ID] = [...(state.scopes[ADA_ID] ?? []), { connectionId: null, scope: "browser:use" }];
  const api = createFakeApi(state);
  const browser = fakeBrowserOf.get(api);
  const machines = fakeMachinesOf.get(api);
  if (!browser || !machines) throw new Error("no fakes");
  const mac = machines.pair({ name: "MacBook do Walter", os: "darwin" });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, mac.id);
  browser.settings.set(ADA_ID, { ...READY, allowedDomains: options.sites ?? null });
  browser.desktops.set(ADA_ID, { available: false, reason: "desktop_unavailable", canControl: true });
  if (options.as === "member") browser.forbidden.add(ADA_ID);
  return { state, api, browser };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function open(path: string, s: Setup) {
  const r = await renderApp(path, { api: s.api });
  await settle(8);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  const push = async (message: Record<string, unknown>) => {
    await act(async () => socket.push(message));
    await settle(2);
  };
  return { ...r, socket, push };
}

const calls = (s: Setup, method: string) => s.state.calls.filter((c) => c.method === method).map((c) => c.args);
const entry = () => screen().queryByRole("region", { name: "Computador da Ada" });
const dialog = () => screen().queryByRole("dialog", { name: "Computador da Ada" });
const card = () => document.querySelector(".brw-ac") as HTMLElement;
const sub = () => (document.querySelector(".ac-dialog__sub") as HTMLElement).textContent;
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};

/** The DM with Ada, its header's Computador opened. */
async function dialogOf(s: Setup) {
  const r = await open(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, s);
  await click(screen().getByRole("button", { name: /^Computador/ }));
  return { ...r, view: within(dialog() as HTMLElement) };
}

describe("the agent's computer without screens (a Mac): its browser's page, in the dialog", () => {
  test("whoever may watch it gets one entry and the DM's Computador; a member who may not gets neither", async () => {
    const admin = await setup();
    await open(`/org/${ORG_ID}/agents/${ADA_ID}`, admin);
    const row = entry() as HTMLElement;
    expect(row.textContent).toContain("Disponível · ninguém usando agora");
    // The entry never opens a stream: no picture, no viewer counted.
    expect(row.querySelector("img")).toBeNull();
    expect(within(row).getByRole("button", { name: "Abrir" })).toBeTruthy();
    // One entry: the browser's, the desktop's and the terminal's rows are gone.
    expect(screen().queryByRole("region", { name: "Navegador da Ada" })).toBeNull();
    expect(document.body.textContent).not.toContain("Abrir o terminal");
    cleanup();

    const owner = await setup({ as: "owner" });
    await open(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, owner);
    expect(screen().getByRole("button", { name: /^Computador/ })).toBeTruthy();
    expect(screen().queryByRole("button", { name: /^Navegador/ })).toBeNull();
    cleanup();

    const member = await setup({ as: "member" });
    await open(`/org/${ORG_ID}/agents/${ADA_ID}`, member);
    expect(entry()).toBeNull();
    cleanup();
    await open(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, member);
    expect(screen().queryByRole("button", { name: /^Computador/ })).toBeNull();
    expect(calls(member, "browser.settings")).toEqual([]);
  });

  test("Abrir shows the page live; a closed browser keeps its sign-ins; Assumir opens it and the address bar a site", async () => {
    const s = await setup({ sites: ["loja.example.com"] });
    const { push } = await open(`/org/${ORG_ID}/agents/${ADA_ID}`, s);
    await click(within(entry() as HTMLElement).getByRole("button", { name: "Abrir" }));
    expect(dialog()).toBeTruthy();
    await push(frame());
    expect(card().querySelector(".brw-ac__page img")).toBeTruthy();
    expect(sub()).toBe("Ao vivo · você está assistindo");
    // One head: the page's address above it, as a browser's bar, read only while watching; no fold, no Parar.
    const watched = within(card()).getByRole("textbox", { name: "Endereço do site" }) as HTMLInputElement;
    expect(watched.value).toBe("loja.example.com/carrinho");
    expect(watched.readOnly).toBe(true);
    expect(within(card()).queryByRole("button", { name: "Voltar à página anterior" })).toBeNull();
    expect(within(dialog() as HTMLElement).queryByRole("button", { name: "Recolher" })).toBeNull();
    expect(within(dialog() as HTMLElement).queryByRole("button", { name: "Parar" })).toBeNull();

    // Closed after 15 unused minutes: never "it opens when", nothing about waking.
    await push({ type: "browser.unavailable", agentId: ADA_ID, reason: "closed" });
    expect(card().textContent).toContain("O navegador da Ada está fechado.");
    expect(card().textContent).toContain("Os logins continuam salvos para a próxima vez.");
    expect(card().textContent).not.toContain("Abre quando");
    // One surface: the agent's sky over the whole stage, its card on it, no frost over a blank page.
    expect(card().querySelector(".brw-ac__stage > .brw-dim--sky > .cmp-sky")).not.toBeNull();
    expect(sub()).toBe("Ao vivo");
    // The dialog's page is its stage, not a card in a message: one sky, under the dialog's head.
    expect(card().classList.contains("is-surface")).toBe(true);
    expect(card().querySelector(".ac-sky-strip")).toBeNull();
    // Closed, so with nothing on the line under it the sky takes that room too (computer.css).
    expect(card().classList.contains("is-closed")).toBe(true);

    // Take control opens it, to sign in ahead of time.
    await click(within(dialog() as HTMLElement).getByRole("button", { name: "Assumir o controle" }));
    expect(calls(s, "browser.takeover")).toEqual([[ORG_ID, ADA_ID]]);
    expect(card().classList.contains("is-control")).toBe(true);
    expect(card().textContent).toContain("Digite um endereço acima para abrir um site.");
    expect(sub()).toBe("Você no controle · a\u00a0Ada espera");

    // Outside the agent's sites: said under the field, nothing opens. Enter opens what is typed: no button for it.
    const address = within(card()).getByRole("textbox", { name: "Endereço do site" }) as HTMLInputElement;
    expect(address.readOnly).toBe(false);
    expect(within(card()).queryByRole("button", { name: "Abrir" })).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Abrir um site" })).toBeNull();
    const enter = (value: string) =>
      act(async () => {
        fireEvent.focus(address);
        fireEvent.change(address, { target: { value } });
        fireEvent.submit(address.closest("form") as HTMLFormElement);
      });
    await enter("outro.com");
    await settle(4);
    expect(within(card()).getByRole("alert").textContent).toBe("Fora dos sites que a Ada pode abrir.");
    await enter("loja.example.com");
    await settle(4);
    expect(calls(s, "browser.open").at(-1)).toEqual([ORG_ID, ADA_ID, "loja.example.com"]);
    await push(frame("https://loja.example.com/"));
    expect(card().querySelector(".brw-ac__page img")).toBeTruthy();
    expect(card().classList.contains("is-closed")).toBe(false);
    // At rest the bar shows where the page is; back, forward and reload are the browser's own.
    expect(address.value).toBe("loja.example.com");
    for (const [name, go] of [
      ["Voltar à página anterior", "back"],
      ["Avançar para a próxima página", "forward"],
      ["Recarregar a página", "reload"],
    ] as const) {
      await click(within(card()).getByRole("button", { name }));
      expect(calls(s, "browser.open").at(-1)).toEqual([ORG_ID, ADA_ID, { go }]);
    }
  });

  test("a request for me: the entry says so with Ajudar, which takes it and opens the page in my control", async () => {
    const s = await setup();
    s.browser.handoffs.set("h-ask", ask());
    await open(`/org/${ORG_ID}/agents/${ADA_ID}`, s);
    const row = entry() as HTMLElement;
    expect(row.dataset.tone).toBe("warn");
    expect(row.textContent).toContain("Precisa de você · Entrar no Stripe · 8 min");
    await click(within(row).getByRole("button", { name: "Ajudar" }));
    expect(calls(s, "browser.takeControl")).toEqual([[ORG_ID, "h-ask"]]);
    // The page with its tools, never the whole screen; the request above it.
    expect(dialog()).toBeTruthy();
    expect(card().classList.contains("is-control")).toBe(true);
    expect(document.querySelector(".cmp-asked")?.textContent).toBe("“Entrar no Stripe”");
    const view = within(dialog() as HTMLElement);
    expect(view.getByRole("button", { name: "Pronto" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Não consegui" })).toBeTruthy();
  });

  test("a request for someone else names them; Help stays for whoever may take it", async () => {
    const s = await setup();
    s.browser.handoffs.set("h-ask", ask({ requestedForUserId: "u-joao" }));
    const { push } = await open(`/org/${ORG_ID}/agents/${ADA_ID}`, s);
    const row = entry() as HTMLElement;
    expect(row.textContent).toContain("Esperando João · Entrar no Stripe · 8 min");
    await click(within(row).getByRole("button", { name: "Abrir" }));
    await push(frame());
    const banner = document.querySelector(".cmp-banner") as HTMLElement;
    expect(banner.textContent).toContain("A Ada pediu para João: “Entrar no Stripe” · 8 min");
    // Who asked whom is the banner's: the head says only that it's live.
    expect(sub()).toBe("Ao vivo");
    // Walter owns the workspace: he may still help.
    expect(within(banner).getByRole("button", { name: "Ajudar" })).toBeTruthy();
    expect(within(dialog() as HTMLElement).queryByRole("button", { name: "Assumir o controle" })).toBeNull();
  });

  test("someone else in control: the entry says who; the page stays hidden in the dialog", async () => {
    const s = await setup();
    const held = ask({ kind: "takeover", status: "active", controllerUserId: "u-joao", expiresAt: null });
    s.browser.handoffs.set(held.id, held);
    const { push } = await open(`/org/${ORG_ID}/agents/${ADA_ID}`, s);
    expect((entry() as HTMLElement).textContent).toContain("João está usando");
    await click(within(entry() as HTMLElement).getByRole("button", { name: "Abrir" }));
    await push({
      type: "browser.status",
      agentId: ADA_ID,
      mode: "control",
      controllerUserId: "u-joao",
      handoff: held,
      hidden: true,
    });
    expect(card().querySelector("img")).toBeNull();
    // Who is in control is the head's; that the page stays hidden, and until when, the cover's alone.
    expect(card().textContent).toContain("Por privacidade, a tela fica oculta até voltar para a Ada.");
    expect(sub()).toBe("João no controle");
    expect(card().textContent).not.toContain("João");
    expect(within(dialog() as HTMLElement).queryByRole("button", { name: "Assumir o controle" })).toBeNull();
  });
});

describe("the DM header's Computador", () => {
  test("opens the dialog in place; closing it in control of a take over hands it back at once", async () => {
    const s = await setup();
    const { view, push } = await dialogOf(s);
    await push(frame());
    await click(view.getByRole("button", { name: "Assumir o controle" }));
    expect(calls(s, "browser.takeover")).toEqual([[ORG_ID, ADA_ID]]);

    // In control, Esc belongs to the computer: the dialog stays.
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    expect(dialog()).toBeTruthy();
    expect(calls(s, "browser.done")).toEqual([]);

    await click(view.getByRole("button", { name: "Fechar" }));
    expect(calls(s, "browser.done")).toEqual([[ORG_ID, "takeover-1"]]);
    expect(dialog()).toBeNull();
    expect(document.body.textContent).toContain("Devolvido à Ada.");
  });

  test("closing it during the agent's own request keeps its 2 minutes of grace, and says so", async () => {
    const s = await setup();
    s.browser.handoffs.set("h-ask", ask());
    const { view } = await dialogOf(s);
    await click(view.getByRole("button", { name: "Ajudar" }));
    expect(calls(s, "browser.takeControl")).toEqual([[ORG_ID, "h-ask"]]);
    await click(view.getByRole("button", { name: "Fechar" }));
    expect(dialog()).toBeNull();
    expect(calls(s, "browser.done")).toEqual([]);
    expect(s.browser.handoffs.get("h-ask")?.status).toBe("active");
    expect(document.body.textContent).toContain("A Ada espera 2 min você voltar.");
  });

  test("its dot: amber while a request waits, said in words for screen readers", async () => {
    const s = await setup();
    s.browser.handoffs.set("h-ask", ask());
    await open(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, s);
    const button = screen().getByRole("button", { name: /^Computador/ });
    expect(button.dataset.state).toBe("waiting");
    expect(button.textContent).toContain("Precisa de você · Entrar no Stripe");
  });

  test("full screen while watching; Esc leaves full screen only, keeping the dialog", async () => {
    const s = await setup();
    const { view, push } = await dialogOf(s);
    await push(frame());
    await click(view.getByRole("button", { name: "Tela cheia" }));
    expect(document.querySelector(".cmp-dialog")?.classList.contains("is-full")).toBe(true);
    expect(calls(s, "browser.takeover")).toEqual([]);
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    await settle(2);
    expect(document.querySelector(".cmp-dialog")?.classList.contains("is-full")).toBe(false);
    expect(dialog()).toBeTruthy();
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    await settle(2);
    expect(dialog()).toBeNull();
  });
});

describe("browser helpers", () => {
  test("the links, blank pages and what a refused open says", () => {
    // `?computer=1`, and the older links to it.
    for (const name of ["computer", "browser", "desktop", "terminal"]) {
      expect(agentSearch({ [name]: 1 })).toEqual({ tab: undefined, sec: undefined, computer: 1 });
      expect(agentSearch({ [name]: "1", tab: "memory" })).toMatchObject({ tab: "memory", computer: 1 });
    }
    expect(agentSearch({ browser: "yes" })).not.toHaveProperty("computer");
    expect(isBlankPage("about:blank")).toBe(true);
    expect(isBlankPage("https://loja.example.com/")).toBe(false);
    expect(isBlankPage(undefined)).toBe(false);
    expect(openRefusalKey("browser.not_allowed")).toBe("browser.inCard.goNotAllowed");
    expect(openRefusalKey("browser.bad_address")).toBe("browser.inCard.goBadAddress");
    expect(openRefusalKey("machine.timeout")).toBe("browser.live.actionFailed");
    // The workspace's own computer is never off.
    expect(openRefusalKey("machine.offline")).toBe("browser.inCard.offline");
    expect(openRefusalKey("machine.offline", true)).toBe("browser.inCard.offlineCloud");
  });
});
