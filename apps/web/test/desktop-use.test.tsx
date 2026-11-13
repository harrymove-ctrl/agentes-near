import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Machine } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, fakeMachinesOf, NOW, ORG_ID, seedState } from "./fake-api";
import { hintOf } from "./hint";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const at = (minute: number) => new Date(NOW.getTime() - (10 - minute) * 60_000).toISOString();
const MISSING =
  "Install what desktop use needs: `sudo apt install --no-install-recommends python3-gi` (missing: python3-gi)";

describe("what the agent did on its desktop, on its message", () => {
  test("its own card beside the browser's: the app it opened, its steps in words, never a link", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-desk",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Criei a pasta relatórios.",
      mentionedAgentIds: [],
      agentRunId: "r-desk",
      createdAt: at(9),
      meta: {
        browser: { steps: [{ tool: "browser_open", detail: "shop.example/cart", at: at(1) }] },
        desktop: {
          steps: [
            { tool: "desktop_read", at: at(2) },
            { tool: "desktop_open", detail: "Arquivos", at: at(3) },
            { tool: "desktop_double_click", at: at(4) },
            { tool: "desktop_type", at: at(5) },
            { tool: "desktop_press", at: at(6), failed: true },
          ],
        },
      },
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);

    const desk = screen().getByRole("group", { name: "Tela da Ada" });
    // Closed into one band that opens to the steps: the app, its steps, how long.
    const band = within(desk).getByRole("button", { expanded: false });
    expect(band.querySelector("b")?.textContent).toBe("Arquivos");
    expect(band.title).toBe("Ver os passos");
    expect(band.textContent).toContain("5 passos");
    await act(async () => fireEvent.click(band));
    const pages = [...desk.querySelectorAll(".brw-trail__page")].map((p) => p.textContent ?? "");
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain("Antes de abrir um app");
    expect(pages[0]).toContain("Leu a tela");
    expect(pages[1]).toContain("Arquivos");
    expect(pages[1]).toContain("Abriu Arquivos");
    expect(pages[1]).toContain("Clicou duas vezes");
    expect(pages[1]).toContain("Digitou");
    expect(pages[1]).toContain("Apertou uma tecla · não funcionou");
    // An app isn't a site: nothing to open in the person's browser.
    expect(desk.querySelector(".brw-trail__ext")).toBeNull();

    const browser = screen().getByRole("group", { name: "Navegador da Ada" });
    expect(within(browser).getByRole("button", { expanded: false }).querySelector("b")?.textContent).toBe(
      "shop.example",
    );
  });
});

describe("whether agents can use apps on their desktops", () => {
  /** A computer as its runner reports desktop use, its desktop and commands switches as given. */
  const computer = (api: ReturnType<typeof createFakeApi>, m: Partial<Machine> & { name: string }, on = true) =>
    fakeMachinesOf.get(api)?.pair({
      access: { folders: [], tools: { claude: false, codex: false, commands: on, desktop: on } },
      ...m,
    }) as Machine;
  const card = () => screen().getByRole("region", { name: "Apps nas telas dos agentes" });

  test("a computer's page: what is missing and the command, Linux only, or the switches to turn on", async () => {
    const api = createFakeApi(seedState());
    const linux = computer(api, { name: "Servidor", desktopUse: { available: false, reason: MISSING } });
    const mac = computer(api, {
      name: "MacBook",
      os: "darwin",
      desktopUse: { available: false, reason: "Desktop use runs on Linux computers with the agents' desktops only" },
    });
    const off = computer(api, { name: "Caixa", desktopUse: { available: true, reason: null } }, false);
    const ready = computer(api, { name: "Pronta", desktopUse: { available: true, reason: null } });
    const old = computer(api, { name: "Antigo" });

    const page = async (m: Machine) => {
      cleanup();
      await renderApp(`/org/${ORG_ID}/settings/computers/${m.id}`, { api });
      await settle(8);
    };
    await page(linux);
    // What the card is for is its title's ⓘ.
    expect(card().querySelector(".ac-card__sub")).toBeNull();
    expect(hintOf("Apps nas telas dos agentes", card()).text).toBe(
      "Os agentes abrem e usam apps na própria tela aqui, como uma pessoa faria, e as pessoas assistem pela página de cada um.",
    );
    expect(card().textContent).toContain("Indisponível");
    // A runner from before reason codes: the app's own sentence, the command once, in its block to copy.
    expect(card().textContent).toContain("Instale neste computador o que o uso da área de trabalho precisa:");
    expect(card().textContent).not.toContain("Install what desktop use needs");
    expect(card().querySelector(".machine-command code")?.textContent).toBe(
      "sudo apt install --no-install-recommends python3-gi",
    );
    expect(card().textContent?.split("sudo apt install").length).toBe(2);

    // Nothing to install on a Mac: the app's own words, not the computer's English.
    await page(mac);
    expect(card().textContent).toContain("Os agentes só usam apps na própria tela em computadores Linux.");
    expect(card().textContent).not.toContain("runs on Linux computers");
    expect(card().querySelector(".machine-command")).toBeNull();

    await page(off);
    expect(card().textContent).toContain("Desligado");
    expect(card().querySelector(".machine-command code")?.textContent).toBe(
      "agentes-runner tools enable desktop && agentes-runner tools enable commands",
    );

    await page(ready);
    expect(card().textContent).toContain("Pronto");
    expect(card().querySelector(".brw-note")).toBeNull();

    // A runner that doesn't report it shows nothing.
    await page(old);
    expect(screen().queryByRole("region", { name: "Apps nas telas dos agentes" })).toBeNull();
  });

  test("the agent's page says it on its Linux computer, when the agent may use its desktop", async () => {
    const open = async (m: Partial<Machine> & { name: string }, granted: boolean) => {
      cleanup();
      const state = seedState();
      if (granted) state.scopes[ADA_ID]?.push({ connectionId: null, scope: "desktop:use" });
      const api = createFakeApi(state);
      const paired = computer(api, m);
      await api.sandbox.setTarget(ORG_ID, ADA_ID, paired.id);
      await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
      await settle(8);
      return document.body.textContent ?? "";
    };
    const linux = { name: "Servidor", desktopUse: { available: false, reason: MISSING } };
    const page = await open(linux, true);
    expect(page).toContain("A Ada ainda não consegue usar apps na própria tela no Servidor.");
    expect(page).toContain("Instale neste computador o que o uso da área de trabalho precisa:");
    expect(page.split("sudo apt install --no-install-recommends python3-gi").length).toBe(2);

    expect(await open(linux, false)).not.toContain("ainda não consegue usar apps");
    const mac = { ...linux, name: "MacBook", os: "darwin" };
    expect(await open(mac, true)).not.toContain("ainda não consegue usar apps");
  });
});
