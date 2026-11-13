import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type {
  Agent,
  AgentBrowserSettings,
  BrowserHandoff,
  ComputerSetup,
  DesktopStatus,
  Machine,
  SocketFactory,
} from "@agenteschat/client";
import { ApiError, keys } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ComputerDialog } from "@/components/computer/ComputerDialog";
import { useChannelRealtime } from "@/realtime/context";
import { ADA_ID, createFakeApi, ENG_ID, fakeBrowserOf, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { fakeSockets } from "./fake-socket";
import { renderApp, renderPage, screen, settle } from "./render";

/** Screen sockets that never connect: the states here are the dialog's, not the stream's. */
class QuietSocket {
  binaryType = "blob";
  closed = false;
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {
    this.closed = true;
  }
}
class FakeRfb {
  viewOnly = false;
  qualityLevel = 3;
  compressionLevel = 2;
  scaleViewport = false;
  resizeSession = false;
  focusOnClick = false;
  background = "";
  constructor(
    readonly el: HTMLElement,
    readonly ws: QuietSocket,
  ) {}
  addEventListener() {}
  clipboardPasteFrom() {}
  sendKey() {}
  focus() {}
  disconnect() {
    this.ws.close();
  }
}
mock.module("@novnc/novnc", () => ({ default: FakeRfb }));

function socketsFor() {
  const screens: QuietSocket[] = [];
  const realtime = fakeSockets();
  const factory: SocketFactory = (url) => {
    if (!url.includes("/api/desktop")) return realtime.factory(url);
    const s = new QuietSocket(url);
    screens.push(s);
    return s as unknown as ReturnType<SocketFactory>;
  };
  return { factory, screens, realtime };
}

const SPECS = { cpus: 4, memoryGb: 8, diskGb: 100 };
const RUNNING: Partial<DesktopStatus> = { available: true, reason: null, running: true, canControl: true };

interface Options {
  /** The workspace gets its own computer (the Cloud), this far. */
  setup?: Partial<ComputerSetup>;
  /** Ada's computer; null: none. */
  machine?: Partial<Machine> | null;
  desktop?: Partial<DesktopStatus>;
  /** Ada may use her browser. */
  browser?: boolean;
  /** What her computer says of her browser (with `browser`: ready). */
  settings?: AgentBrowserSettings;
  handoff?: BrowserHandoff;
  forbidden?: boolean;
}

/** Walter (an owner of Acme) opens Ada's computer. */
async function backend(o: Options = {}) {
  const state = seedState();
  if (o.browser) {
    state.scopes[ADA_ID] = [...(state.scopes[ADA_ID] ?? []), { connectionId: null, scope: "browser:use" }];
  }
  const api = createFakeApi(state);
  const fake = fakeBrowserOf.get(api);
  const machines = fakeMachinesOf.get(api);
  if (!fake || !machines) throw new Error("no fakes");
  if (o.setup) machines.setSetup(o.setup);
  let machine: Machine | null = null;
  if (o.machine !== null) {
    machine = machines.pair({ name: "Servidor de casa", os: "linux", mode: "system", ...o.machine });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, machine.id);
  }
  fake.desktops.set(ADA_ID, o.desktop ?? RUNNING);
  if (o.handoff) fake.handoffs.set(o.handoff.id, o.handoff);
  if (o.forbidden) fake.forbidden.add(ADA_ID);
  if (o.browser)
    fake.settings.set(ADA_ID, { allowedDomains: null, available: true, reason: null, detail: null, machine: null });
  if (o.settings) fake.settings.set(ADA_ID, o.settings);
  return { state, api, fake, machines, machine, sockets: socketsFor() };
}

async function dialog(o: Options = {}) {
  const b = await backend(o);
  const ada = b.state.agents.find((a) => a.id === ADA_ID) as Agent;
  let closed = 0;
  const r = await renderPage(<ComputerDialog agent={ada} open onClose={() => closed++} />, {
    api: b.api,
    org: true,
    createSocket: b.sockets.factory,
  });
  await settle(8);
  return { ...r, ...b, closed: () => closed };
}

const sub = () => (document.querySelector(".ac-dialog__sub") as HTMLElement | null)?.textContent ?? null;
const box = () => screen().getByRole("dialog", { name: "Computador da Ada" });
const view = () => within(box());
const calls = (s: { state: ReturnType<typeof seedState> }, method: string) =>
  s.state.calls.filter((c) => c.method === method).map((c) => c.args);
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const screenAsk = (over: Partial<BrowserHandoff> = {}): BrowserHandoff => ({
  id: "h-screen",
  agentId: ADA_ID,
  runId: "r-1",
  machineId: "machine-1",
  screen: "desktop",
  kind: "ask",
  instructions: "Entrar no banco com o token da empresa",
  status: "pending",
  requestedForUserId: null,
  controllerUserId: null,
  note: null,
  expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
  createdAt: new Date().toISOString(),
  resolvedAt: null,
  ...over,
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  setSystemTime();
  cleanup();
});

describe("the computer dialog, Cloud: the workspace's own computer", () => {
  test("being prepared: the steps, the time left, the email to owners, the size; no screen yet", async () => {
    const t = await dialog({
      setup: {
        step: "installing",
        secondsLeft: 330,
        expectedReadyAt: new Date(Date.now() + 330_000).toISOString(),
        requestedAt: new Date(Date.now() - 120_000).toISOString(),
        secondsWaited: 120,
        notifyByEmail: true,
        specs: SPECS,
      },
      machine: null,
      desktop: { available: false, reason: "no_computer" },
    });
    expect(sub()).toBe("Sendo preparado");
    const text = box().textContent ?? "";
    // One name and one status: the head's. The card says neither again.
    expect(text).not.toContain("Computador da Acme");
    expect(text).not.toMatch(/Preparando/);
    expect(text).toContain("Passo 3 de 4 · Instalando os programas");
    expect(text).toContain("Faltam uns 6 min");
    expect(text).toContain("Avisamos\u00a0você\u00a0em walter@acme.com.br quando\u00a0ele\u00a0ficar\u00a0pronto.");
    expect(text).not.toContain("Pode fechar esta página");
    expect(text).toContain("4\u00a0CPUs\u00a0· 8\u00a0GB\u00a0de\u00a0memória\u00a0· 100\u00a0GB\u00a0de\u00a0disco");
    // The head already says whose computer this is: no line that Ada waits, no users line, no plans.
    expect(text).not.toMatch(/começa a usar|Um usuário para cada agente|plano de IA/);
    // Nothing to do but close: no screen opens, no take control.
    expect(t.sockets.screens).toHaveLength(0);
    expect(view().queryByRole("button", { name: "Assumir o controle" })).toBeNull();
    // The wait takes the screen's box and its line's room (the empty row steps aside, computer.css).
    const row = box().querySelector(".cmp-body > .cmp-prep + .cmp-steps-row");
    expect(row?.childElementCount).toBe(0);
    expect(box().querySelector(".cmp-body")?.lastElementChild).toBe(row);
  });

  test("its header says where the wait is, as the chip does: being prepared, in line, a problem; the card never again", async () => {
    const heads: (string | null)[] = [];
    for (const setup of [
      { step: "installing" },
      { state: "waiting", reason: "capacity", notifyByEmail: true },
      { state: "preparing" },
      { state: "problem" },
    ] as const) {
      await dialog({ setup, machine: null, desktop: { available: false, reason: "no_computer" } });
      heads.push(sub());
      const card = box().querySelector(".cmp-prep")?.textContent ?? "";
      // In line: the owner's email in place of a time, and no line saying it waits (the head says "Na fila").
      if (setup.state === "waiting") {
        expect(card).not.toContain("Esperando um computador disponível");
        expect(card).toContain("Avisamos\u00a0você\u00a0em walter@acme.com.br quando\u00a0ele\u00a0ficar\u00a0pronto.");
      }
      // Before its first step, nothing says it's being prepared but the head.
      if (setup.state === "preparing") expect(card).not.toContain("Preparando o computador.");
      // A problem says what happens next.
      if (setup.state === "problem") expect(card).toContain("Algo deu errado ao preparar o computador");
      cleanup();
    }
    expect(heads).toEqual(["Sendo preparado", "Na fila", "Sendo preparado", "Com problema"]);
  });

  test("ready: it flashes Pronto, then opens with nothing to click", async () => {
    const t = await dialog({
      setup: { step: "connecting" },
      machine: null,
      desktop: { available: false, reason: "no_computer" },
    });
    const socket = t.sockets.realtime.last();
    await act(async () => socket.open());
    // The wait takes the screen's box with its line's room.
    expect(box().querySelector(".cmp-body > .cmp-prep + .cmp-steps-row")).toBeTruthy();
    // The computer is made, Ada is on it and its screen shows.
    const m = t.machines.pair({ name: "Computador da Acme", kind: "managed", os: "other" });
    await t.api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
    t.fake.desktops.set(ADA_ID, RUNNING);
    await act(async () =>
      socket.push({
        type: "event",
        scope: "org",
        event: { type: "machine.provisioning", state: "ready", machineId: m.id, since: new Date().toISOString() },
      }),
    );
    await settle(8);
    // The cover says it; the head says nothing over it.
    expect(sub()).toBe("");
    expect(box().textContent?.match(/Pronto/g)).toHaveLength(1);
    // The Pronto leads to the screen: the screen's line stays under it, so the screen opens where it was.
    expect(box().querySelector(".cmp-body > .cmp-stage + .dsk-line")?.textContent).toBe(
      "Os programas do computador da Ada veem a tela e tudo o que é digitado ou colado nele.",
    );
    await act(async () => new Promise((r) => setTimeout(r, 1600)));
    await settle(8);
    // Opening, then the screen: no step of the person's.
    expect(t.sockets.screens.length).toBeGreaterThan(0);
    expect(box().textContent).toContain("Abrindo o computador da Ada…");
    expect(sub()).toBe("");
  });

  test("on hold before the computer is ready: the pause alone, said once, never a countdown", async () => {
    await dialog({
      setup: { secondsLeft: 330, expectedReadyAt: new Date(Date.now() + 330_000).toISOString() },
      machine: null,
      desktop: { available: false, reason: "no_computer", held: true },
    });
    // Nothing to watch here: the cover alone says the pause.
    expect(sub()).toBe("");
    expect(box().textContent).toContain("A Ada está em pausa por enquanto");
    expect(box().textContent).toContain("Ninguém assume o controle até a pausa acabar.");
    expect(box().textContent?.match(/pausa por enquanto/g)).toHaveLength(1);
    expect(box().textContent).not.toMatch(/assistir/i);
    expect(box().textContent).not.toContain("min");
  });

  test("a hold that arrives during the wait: the pause at once, never a Pronto it isn't", async () => {
    const t = await dialog({
      setup: { step: "installing", secondsLeft: 330 },
      machine: null,
      desktop: { available: false, reason: "no_computer" },
    });
    expect(sub()).toBe("Sendo preparado");
    t.fake.desktops.set(ADA_ID, { available: false, reason: "no_computer", held: true });
    await act(async () => t.services.queryClient.invalidateQueries({ queryKey: keys.agentDesktop(ORG_ID, ADA_ID) }));
    await settle(8);
    expect(sub()).toBe("");
    expect(box().textContent).not.toContain("Pronto");
    expect(box().textContent).toContain("A Ada está em pausa por enquanto");
  });

  test("its computer not answering: once, under the window's one name; looked after, nothing to do, no other computer", async () => {
    // Its browser was there before it stopped answering: no page to show from a computer that doesn't answer. Its
    // first owner's language named it in English: no name of its own shows, in either language.
    const t = await dialog({
      setup: { state: "ready" },
      machine: { name: "Acme's computer", kind: "managed", os: "other", online: false },
      desktop: { available: false, reason: "offline" },
      browser: true,
    });
    expect(sub()).toBe("Sem resposta");
    const text = box().textContent ?? "";
    expect(text).toContain("Costuma voltar em poucos minutos. Já estamos cuidando.");
    expect(text).toContain("Tentando de novo…");
    expect(text).not.toMatch(/Computador da Acme|Acme's computer|não está respondendo/);
    expect(text).not.toContain("nada a fazer");
    expect(view().queryByRole("button", { name: "Trocar computador" })).toBeNull();
    expect(t.sockets.screens).toHaveLength(0);
  });

  test("back while this tab was away: the reconnect asks for the computers again, and its screen opens", async () => {
    const t = await dialog({
      setup: { state: "ready" },
      machine: { name: "Computador da Acme", kind: "managed", os: "other", online: false },
      desktop: { available: false, reason: "offline" },
    });
    await act(async () => t.sockets.realtime.last().open());
    await settle(4);
    expect(sub()).toBe("Sem resposta");
    // It comes back by itself: the screen's line stays under the cover, so the screen opens where it was.
    expect(box().querySelector(".cmp-body > .cmp-stage + .dsk-line")).toBeTruthy();
    // The socket drops; meanwhile the computer comes back, and its machine.status never reaches this tab.
    await act(async () => t.sockets.realtime.last().drop());
    t.machines.patch((t.machine as Machine).id, { online: true });
    t.fake.desktops.set(ADA_ID, RUNNING);
    await act(() => new Promise((r) => setTimeout(r, 650)));
    await act(async () => t.sockets.realtime.last().open());
    await settle(8);
    expect(sub()).not.toBe("Sem resposta");
    expect(t.sockets.screens.length).toBeGreaterThan(0);
  });

  test("its screen can't be shown: only to try again in a moment, never a command", async () => {
    await dialog({
      setup: { state: "ready" },
      machine: { name: "Computador da Acme", kind: "managed", os: "other" },
      desktop: { available: false, reason: "not_allowed" },
    });
    expect(box().textContent).toContain("A tela da Ada não pode ser mostrada agora");
    expect(box().textContent).toContain("Tente de novo daqui a pouco.");
    expect(document.querySelector(".machine-command__code")).toBeNull();
    expect(view().getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
    // A cover that stays until someone acts takes the screen's frame and its line's room (the empty row steps aside),
    // as the screen's own do.
    expect(box().querySelector(".cmp-stage")).toBeTruthy();
    expect(box().querySelector(".dsk-line")).toBeNull();
    expect(box().querySelector(".cmp-body > .cmp-steps-row")?.childElementCount).toBe(0);
  });
});

describe("the computer dialog, live", () => {
  test("watching while the agent doesn't work: the steps' row stays empty, for the screen's own line to take its room", async () => {
    await dialog();
    expect(box().querySelector(".dsk")).toBeTruthy();
    const row = box().querySelector(".cmp-body > .cmp-steps-row");
    expect(row?.childElementCount).toBe(0);
    expect(row?.textContent).toBe("");
    expect(box().querySelector(".cmp-body")?.lastElementChild).toBe(row);
  });

  test("the steps' line comes under the screen while the agent works there, and goes with its run", async () => {
    const b = await backend();
    const ada = b.state.agents.find((a) => a.id === ADA_ID) as Agent;
    /** The conversation the agent works in, open in this tab: its runs come live. */
    function Listening() {
      useChannelRealtime(ORG_ID, ENG_ID, true);
      return null;
    }
    await renderPage(
      <>
        <Listening />
        <ComputerDialog agent={ada} open onClose={() => {}} />
      </>,
      { api: b.api, org: true, createSocket: b.sockets.factory },
    );
    await settle(8);
    const socket = b.sockets.realtime.last();
    await act(async () => socket.open());
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    const run = { threadId: null, runId: "r-desktop", agentId: ADA_ID };
    await ev({ type: "agent.thinking", ...run });
    await ev({ type: "agent.tool", ...run, tool: "desktop_click", toolUseId: "c1" });
    await settle(4);
    const row = () => box().querySelector(".cmp-body > .cmp-steps-row");
    expect(row()?.querySelectorAll("li")).toHaveLength(1);
    expect(box().querySelector(".cmp-body")?.lastElementChild).toBe(row());
    await ev({ type: "agent.run", ...run, status: "done" });
    await settle(4);
    // The steps go with the run; their row stays, empty, and steps aside for the screen's own line (computer.css), so
    // the window keeps its size.
    expect(row()?.childElementCount).toBe(0);
  });

  test("held with a ready computer: watching, under the pause's banner, with no take control", async () => {
    await dialog({ desktop: { ...RUNNING, held: true } });
    expect(box().querySelector(".cmp-banner")?.textContent).toContain("A Ada está em pausa por enquanto");
    // Its two lines, in the body's column, where the screen gives it its room (computer.css).
    expect(box().querySelector(":scope > .cmp-body > .cmp-banner > .cmp-banner__t > span")?.textContent).toBe(
      "Ninguém assume o controle até a pausa acabar.",
    );
    // The banner says the pause: the head never says it again.
    expect(sub()).not.toMatch(/pausa/i);
    expect(view().queryByRole("button", { name: "Assumir o controle" })).toBeNull();
  });

  test("a request on the screen for me: the banner's Ajudar takes control of the screen, with the request on top", async () => {
    const t = await dialog({ handoff: screenAsk() });
    const banner = box().querySelector(".cmp-banner") as HTMLElement;
    expect(banner.dataset.tone).toBe("warn");
    expect(banner.textContent).toContain("A Ada precisa de você: “Entrar no banco com o token da empresa” · 4 min");
    // Who asks and what: the banner's alone, its line beside a button.
    expect(sub()).not.toMatch(/precisa de você|pediu/);
    expect(box().querySelector(":scope > .cmp-body > .cmp-banner > .ac-btn")?.textContent).toBe("Ajudar");
    expect(view().queryByRole("button", { name: "Assumir o controle" })).toBeNull();
    await click(within(banner).getByRole("button", { name: "Ajudar" }));
    expect(calls(t, "browser.takeControl")).toEqual([[ORG_ID, "h-screen"]]);
    await settle(4);
    expect(t.sockets.screens.at(-1)?.url).toContain("mode=control");
    expect(sub()).toBe("Você no controle · a\u00a0Ada pediu");
    // In the screen's column, over it in the window and under it on a phone's sheet (computer.css).
    expect(box().querySelector(":scope > .cmp-body > .dsk > .cmp-asked")?.textContent).toBe(
      "“Entrar no banco com o token da empresa”",
    );
    // Both ways out in the bar under the screen, the main one on the right, none in the head.
    const foot = box().querySelector(".dsk > .brw-ac__back") as HTMLElement;
    expect([...foot.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Deixar um recado",
      "Não consegui",
      "Pronto",
    ]);
    expect(foot.textContent).toContain("Devolver à Ada");
    expect(box().querySelector(".cmp-acts")?.textContent).not.toMatch(/Pronto|Não consegui/);
  });

  test("Não consegui on the screen takes the words written in the bar, and Pronto waits for its answer", async () => {
    const t = await dialog({ handoff: screenAsk() });
    await click(within(box().querySelector(".cmp-banner") as HTMLElement).getByRole("button", { name: "Ajudar" }));
    await settle(4);
    const foot = box().querySelector(".dsk > .brw-ac__back") as HTMLElement;
    // Together, so they wrap as one and the main one never sits alone under the other.
    expect(foot.querySelector(".brw-ac__ways")?.textContent).toBe("Não conseguiPronto");
    await click(within(foot).getByRole("button", { name: "Deixar um recado" }));
    await act(async () =>
      fireEvent.change(within(foot).getByRole("textbox", { name: "Recado para a Ada" }), {
        target: { value: "O token venceu" },
      }),
    );
    const browser = t.api.browser as { failed: (...args: unknown[]) => Promise<unknown> };
    const failed = browser.failed;
    let answer = () => {};
    browser.failed = (...args) =>
      new Promise((done) => {
        answer = () => done(failed(...args));
      });
    await click(within(foot).getByRole("button", { name: "Não consegui" }));
    await click(within(foot).getByRole("button", { name: "Pronto" }));
    expect(calls(t, "browser.done")).toEqual([]);
    await act(async () => answer());
    await settle(4);
    expect(calls(t, "browser.failed")).toEqual([[ORG_ID, "h-screen", "O token venceu"]]);
  });

  test("a sign-in request in the browser, its window on the screen: who may drive the screen helps on the whole screen, the request on top", async () => {
    const browserAsk = screenAsk({ id: "h-sign-in", screen: "browser", instructions: "Entrar no painel da loja" });
    const b = await backend({ handoff: browserAsk, browser: true });
    b.fake.sameWindow.add(ADA_ID);
    const ada = b.state.agents.find((a) => a.id === ADA_ID) as Agent;
    await renderPage(<ComputerDialog agent={ada} open onClose={() => {}} />, {
      api: b.api,
      org: true,
      createSocket: b.sockets.factory,
    });
    await settle(8);
    const banner = box().querySelector(".cmp-banner") as HTMLElement;
    expect(banner.textContent).toContain("Entrar no painel da loja");
    await click(within(banner).getByRole("button", { name: "Ajudar" }));
    expect(calls(b, "browser.takeControl")).toEqual([[ORG_ID, "h-sign-in"]]);
    await settle(4);
    // The screen in control, never the page alone: the keys and the paste go through the screen.
    expect(box().querySelector(":scope > .cmp-body > .dsk.is-control")).not.toBeNull();
    expect(box().querySelector(".brw-ac")).toBeNull();
    expect(b.sockets.screens.at(-1)?.url).toContain("mode=control");
    expect(box().querySelector(":scope > .cmp-body > .dsk > .cmp-asked")?.textContent).toBe(
      "“Entrar no painel da loja”",
    );
    expect(view().getByRole("button", { name: "Pronto" })).toBeTruthy();
  });

  test("the same request for who may drive only the browser: the page, labelled as the browser", async () => {
    const browserAsk = screenAsk({ id: "h-sign-in", screen: "browser", instructions: "Entrar no painel da loja" });
    const t = await dialog({ handoff: browserAsk, browser: true, desktop: { ...RUNNING, canControl: false } });
    t.fake.sameWindow.add(ADA_ID);
    await click(within(box().querySelector(".cmp-banner") as HTMLElement).getByRole("button", { name: "Ajudar" }));
    await settle(4);
    expect(box().querySelector(".brw-ac.is-surface.is-control")).not.toBeNull();
    expect(box().querySelector(".dsk")).toBeNull();
  });

  test("Ajudar refused (someone got there first): said in the head for a moment, not in a toast over the window", async () => {
    const t = await dialog({ handoff: screenAsk() });
    t.api.browser.takeControl = async () => {
      throw new ApiError(409, "conflict", "Someone else is in control");
    };
    await click(within(box().querySelector(".cmp-banner") as HTMLElement).getByRole("button", { name: "Ajudar" }));
    const said = box().querySelector(".ac-dialog__sub > .cmp-said");
    expect(said?.textContent).toBe("Outra pessoa já está ajudando.");
    expect(said?.getAttribute("role")).toBe("alert");
    expect(box().querySelector(".cmp-sub")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector(".ac-toast")).toBeNull();
  });

  test("full screen on the agent's page keeps the dialog's layout: only its screen goes alone", async () => {
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: () => Promise.resolve(),
    });
    try {
      await dialog({ desktop: { available: false, reason: "no_desktop" }, browser: true });
      await click(view().getByRole("button", { name: "Tela cheia" }));
      expect(box().classList.contains("is-full")).toBe(true);
      expect(box().classList.contains("is-screen-only")).toBe(false);
    } finally {
      delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen;
    }
  });

  test("whoever may take over the browser but not the screen takes the browser: the page shows", async () => {
    const t = await dialog({ desktop: { ...RUNNING, canControl: false }, browser: true });
    // Watching the screen; not connected yet: no take control until it's live, and the cover alone says it opens.
    expect(t.sockets.screens).toHaveLength(1);
    expect(sub()).toBe("");
    expect(box().textContent).toContain("Abrindo o computador da Ada…");
  });
});

/** A JPEG's first bytes (SOI + a start-of-frame for 1280×800): enough for the page's size. */
const FRAME_DATA = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 3, 32, 5, 0, 3, 0, 0, 0));
const pageFrame = {
  type: "browser.frame",
  agentId: ADA_ID,
  seq: 1,
  data: FRAME_DATA,
  metadata: { deviceWidth: 1280, deviceHeight: 800 },
};

describe("switching between the page and the screen, and watching the page", () => {
  test("handing the page back: the screen opens over the page's last picture, dimmed under Devolvendo à Ada…, never Abrindo", async () => {
    const mine = screenAsk({
      id: "h-page",
      screen: "browser",
      kind: "takeover",
      status: "active",
      controllerUserId: "u-walter",
      expiresAt: null,
    });
    const t = await dialog({ handoff: mine, browser: true, desktop: { ...RUNNING, canControl: false } });
    await act(async () => t.sockets.realtime.last().open());
    await act(async () => t.sockets.realtime.last().push(pageFrame));
    await settle(2);
    expect(box().querySelector(".brw-ac.is-surface.is-control")).not.toBeNull();
    await click(view().getByRole("button", { name: "Devolver" }));
    await settle(6);
    expect(calls(t, "browser.done")).toEqual([[ORG_ID, "h-page"]]);
    expect(box().querySelector(".brw-ac")).toBeNull();
    const still = box().querySelector(".dsk-screen > img.dsk-still") as HTMLImageElement | null;
    expect(still?.getAttribute("src")).toBe(`data:image/jpeg;base64,${FRAME_DATA}`);
    expect(screen().getByText("Devolvendo à Ada…").closest(".brw-dim")?.classList.contains("is-clear")).toBe(true);
    expect(box().textContent).not.toContain("Abrindo o computador da Ada…");
  });

  test("watching the page: a click or a key on it asks, the question stays until Cancelar, and nothing reaches the page", async () => {
    const t = await dialog({ desktop: { available: false, reason: "no_desktop" }, browser: true });
    await act(async () => t.sockets.realtime.last().open());
    await act(async () => t.sockets.realtime.last().push(pageFrame));
    await settle(2);
    const stage = box().querySelector(".brw-ac__stage") as HTMLElement;
    const img = stage.querySelector(".brw-ac__page img") as HTMLElement;
    const prompt = () => box().querySelector(".dsk-ask") as HTMLElement | null;
    await act(async () => fireEvent.pointerDown(img, { pointerType: "mouse", button: 0 }));
    expect(prompt()?.textContent).toContain("Quer assumir o controle?");
    await act(async () => fireEvent.pointerDown(img, { pointerType: "mouse", button: 0 }));
    expect(prompt()).not.toBeNull();
    await click(within(prompt() as HTMLElement).getByRole("button", { name: "Cancelar" }));
    expect(prompt()).toBeNull();
    stage.focus();
    await act(async () => void fireEvent.keyDown(stage, { key: "a" }));
    expect(prompt()).not.toBeNull();
    const sent = t.sockets.realtime.last().sent.filter((f) => (f as { type: string }).type === "browser.input");
    expect(sent).toEqual([]);
  });
});

describe("the computer dialog, self-host", () => {
  test("paused on the computer itself: until when and by whom, live, no take control", async () => {
    const until = new Date(Date.now() + 2 * 3_600_000);
    await dialog({ machine: { paused: { until: until.toISOString() } } });
    const banner = box().querySelector(".cmp-banner") as HTMLElement;
    expect(banner.textContent).toContain("O Servidor de casa está pausado até");
    expect(banner.textContent).toContain("Pausado no próprio computador por quem o conectou.");
    // The banner names the computer and its pause: the head names neither again.
    expect(sub()).not.toMatch(/Servidor de casa|[Pp]ausado/);
    expect(view().queryByRole("button", { name: "Assumir o controle" })).toBeNull();
  });

  test("offline: since when, Ada waits, and Trocar computador for who may move her", async () => {
    // Mid-day: half an hour ago is still today, so the time shows without its date.
    setSystemTime(new Date(2026, 9, 21, 12));
    const seen = new Date(Date.now() - 30 * 60_000).toISOString();
    const t = await dialog({
      machine: { online: false, lastSeenAt: seen },
      desktop: { available: false, reason: "offline" },
      browser: true,
    });
    expect(box().textContent).toContain("O Servidor de casa está offline");
    // Since when is the head's: the cover says only that Ada waits.
    expect(box().textContent).toContain("A Ada espera o computador voltar.");
    expect(box().textContent).not.toMatch(/Desde \d\d:\d\d/);
    expect(sub()).toMatch(/^Offline desde \d\d:\d\d$/);
    // The switch shows where the server lists the outage.
    expect(view().queryByRole("button", { name: "Trocar computador" })).toBeNull();
    cleanup();

    const listed = await backend({
      machine: { online: false, lastSeenAt: seen },
      desktop: { available: false, reason: "offline" },
    });
    const m = listed.machine as Machine;
    listed.machines.setOutages({
      outages: [
        {
          machineId: m.id,
          name: m.name,
          platform: "linux",
          offlineSince: seen,
          agents: [{ agentId: ADA_ID, name: "Ada", brain: "claude_code", waiting: { routines: 0, conversations: 1 } }],
          waitingRuns: 1,
        },
      ],
      targets: [],
    });
    const ada = listed.state.agents.find((a) => a.id === ADA_ID) as Agent;
    await renderPage(<ComputerDialog agent={ada} open onClose={() => {}} />, {
      api: listed.api,
      org: true,
      createSocket: listed.sockets.factory,
    });
    await settle(8);
    await click(view().getByRole("button", { name: "Trocar computador" }));
    expect(screen().getByRole("dialog", { name: "Trocar o computador" })).toBeTruthy();
    expect(t.closed()).toBe(0);
  });

  test("a Mac with its browser off: that, and who turns it on, never a screen it doesn't have", async () => {
    await dialog({
      machine: { name: "Mac mini", os: "darwin", mode: "single" },
      desktop: { available: false, reason: "not_allowed" },
      settings: {
        allowedDomains: null,
        available: false,
        reason: "switched_off",
        detail: null,
        machine: { id: "machine-1", name: "Mac mini" },
      },
    });
    expect(box().textContent).toContain("O navegador da Ada está desligado no Mac mini");
    expect(box().textContent).toContain(
      "Só quem está no computador liga, no app do agentes.chat: Preferências → Ferramentas.",
    );
    expect(box().textContent).not.toContain("A tela da Ada não pode ser mostrada agora");
  });

  test("no computer yet: choose one for her", async () => {
    await dialog({ machine: null, desktop: { available: false, reason: "no_computer" } });
    expect(sub()).toBe("Sem computador ainda");
    expect(box().textContent).toContain("Escolha um computador para a Ada.");
    expect(view().getByRole("button", { name: "Escolher um computador" })).toBeTruthy();
  });

  test("neither its screen nor its browser: where to allow them is the button", async () => {
    await dialog({ desktop: { available: false, reason: "no_desktop" } });
    expect(box().textContent).toContain("A Ada não tem tela para mostrar aqui");
    expect(box().textContent).not.toContain("Libere a tela ou o navegador");
    expect(view().getByRole("button", { name: "Abrir Ferramentas e acesso" })).toBeTruthy();
  });

  test("not allowed: someone who may not watch it reads so", async () => {
    await dialog({ forbidden: true });
    expect(box().textContent).toContain("Você não pode ver este computador.");
  });
});

describe("the links", () => {
  test("?computer=1, and the older ?browser=1, ?desktop=1 and ?terminal=1, open the dialog on the agent's page", async () => {
    for (const link of ["computer", "browser", "desktop", "terminal"]) {
      const b = await backend();
      const r = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?${link}=1`, {
        api: b.api,
        createSocket: b.sockets.factory,
      });
      await settle(10);
      expect(screen().getByRole("dialog", { name: "Computador da Ada" })).toBeTruthy();
      // Used once: a reload doesn't open it again.
      const search = r.router.state.location.search as Record<string, unknown>;
      expect({ link, computer: search.computer, own: search[link] }).toEqual({
        link,
        computer: undefined,
        own: undefined,
      });
      cleanup();
    }
  });
});

describe("the profile card's computer button", () => {
  /** Ada's card in #eng, as Walter (an owner) sees it. */
  async function card(o: Options = {}) {
    const b = await backend(o);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: b.api, createSocket: b.sockets.factory });
    await settle(8);
    const trigger = screen()
      .getAllByRole("button", { name: "Perfil de Ada" })
      .find((x) => !x.hasAttribute("aria-hidden"));
    if (!trigger) throw new Error("no trigger");
    await click(trigger);
    await settle(6);
    return { ...b, card: screen().getByRole("dialog", { name: "Perfil" }) };
  }
  const menuOf = async (c: HTMLElement) => {
    await act(async () => fireEvent.pointerDown(within(c).getByRole("button", { name: "Mais" }), { button: 0 }));
    await settle(2);
    return within(screen().getByRole("menu", { name: "Mais" }))
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
  };

  test("beside the ⋯, round like it, it opens her computer in its dialog and closes the card", async () => {
    const { card: c } = await card();
    const button = within(c).getByRole("button", { name: "Abrir o computador da Ada" });
    expect(button.getAttribute("title")).toBe("Abrir o computador da Ada");
    expect(button.classList.contains("mcard__act")).toBe(true);
    expect(within(c).getByRole("button", { name: "Mais" }).classList.contains("mcard__act")).toBe(true);
    // First of the banner's buttons, the ⋯ last.
    expect(button.nextElementSibling?.getAttribute("aria-label") ?? "").toBe("Mais");
    await click(button);
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Computador da Ada" })).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: "Perfil" })).toBeNull();
  });

  test("the ⋯ lists Abrir o computador under Ver perfil, and it opens the dialog too", async () => {
    const { card: c } = await card();
    expect((await menuOf(c)).slice(0, 3)).toEqual(["Mensagem direta", "Ver perfil", "Abrir o computador"]);
    await click(
      within(screen().getByRole("menu", { name: "Mais" })).getByRole("menuitem", { name: "Abrir o computador" }),
    );
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Computador da Ada" })).toBeTruthy();
  });

  test("nothing for whoever may not watch it, nor for a self-hosted agent with no computer yet", async () => {
    for (const o of [{ forbidden: true }, { machine: null }] satisfies Options[]) {
      const { card: c } = await card(o);
      expect(within(c).queryByRole("button", { name: "Abrir o computador da Ada" })).toBeNull();
      expect(await menuOf(c)).not.toContain("Abrir o computador");
      cleanup();
    }
  });

  test("the Cloud's agents have the workspace's computer: the button shows with no computer of their own", async () => {
    const { card: c } = await card({ setup: {}, machine: null });
    expect(within(c).getByRole("button", { name: "Abrir o computador da Ada" })).toBeTruthy();
  });
});
