import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type ComputerSetup, NetworkError } from "@agenteschat/client";
import { cleanup } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeBrowserOf, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const HOST = "00000000-0000-4000-8000-0000000009ee";

interface Options {
  /** The workspace gets its own computer (the Cloud), this far; else people connect theirs. */
  setup?: Partial<ComputerSetup>;
  /** This server's own computer, on in this workspace. */
  host?: boolean;
  signupOpen?: boolean;
  role?: "owner" | "member";
}

async function computers(path: string, o: Options = {}) {
  const state = seedState();
  state.authConfig = { ...state.authConfig, signupOpen: o.signupOpen ?? false };
  if (o.role && state.me?.organizations[0]) state.me.organizations[0].role = o.role;
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api);
  if (!machines) throw new Error("no fake machines");
  if (o.setup) machines.setSetup(o.setup);
  if (o.host) {
    machines.pair({ id: HOST, name: "", kind: "host", os: "linux", mode: "system", pairedBy: null });
    machines.setHost({ machineId: HOST, on: true });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, HOST);
  }
  const r = await renderApp(path, { api });
  await settle(10);
  return { ...r, state, api, machines };
}

const CLOUD_LEAD = "Onde seus agentes trabalham: o computador do workspace e os dispositivos que as pessoas conectam.";
const body = () => (document.querySelector(".settings__body") as HTMLElement).textContent ?? "";
const region = (name: string) => screen().queryByRole("region", { name });

describe("Configurações → Computadores on the Cloud: one computer, nothing to connect or pick", () => {
  test("the lead line and the workspace's card, and nothing else", async () => {
    await computers(`/org/${ORG_ID}/settings/computers`, { setup: { step: "installing", specs: null } });
    expect(body()).toContain(CLOUD_LEAD);
    expect(region("Computador da Acme")).toBeTruthy();
    for (const name of ["Outros computadores", "Conectar outro computador", "Qual computador cada agente usa"])
      expect(region(name)).toBeNull();
    expect(screen().queryByRole("link", { name: /^Baixar o app para/ })).toBeNull();
    // The page on how people's own computers work is self-host's alone.
    expect(screen().queryByRole("link", { name: "Como os computadores funcionam" })).toBeNull();
    // Drawn as a server, never as the cloud.
    expect(document.querySelector(".setup-card canvas.ac-computer")?.getAttribute("data-kind")).toBe("linux");
    expect(body()).not.toMatch(/na nuvem|seu computador|desligad|parear|terminal/i);
  });

  test("its page, for a member: Open only beside the agents they may watch, and no word on who changes it", async () => {
    const { api, machines } = await computers(`/org/${ORG_ID}/settings/computers`, {
      setup: { state: "ready" },
      role: "member",
    });
    const m = machines.pair({
      name: "Computador da Acme",
      kind: "managed",
      os: "other",
      pairedBy: null,
      canManage: false,
    });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
    await api.sandbox.setTarget(ORG_ID, ATLAS_ID, m.id);
    // Atlas's computer isn't this member's to watch: its dialog would only say so.
    fakeBrowserOf.get(api)?.forbidden.add(ATLAS_ID);
    cleanup();
    await renderApp(`/org/${ORG_ID}/settings/computers/${m.id}`, { api });
    await settle(10);
    expect(screen().getByRole("button", { name: "Abrir: Computador da Ada" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Abrir: Computador do Atlas" })).toBeNull();
    // Nobody in the workspace changes what its own computer allows: no note that only admins do.
    expect(document.body.textContent).not.toContain("mudam o que este computador libera");
  });

  test("before the server says which edition this is, neither edition's cards nor its lead line", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setSetup({ step: "installing" });
    api.machines.computerSetup = async () => {
      throw new NetworkError(new TypeError("Failed to fetch"));
    };
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
    await settle(10);
    for (const name of ["Computador da Acme", "Computador deste servidor", "Qual computador cada agente usa"])
      expect(region(name)).toBeNull();
    expect(body()).not.toContain(CLOUD_LEAD);
    expect(body()).not.toContain("install.sh");
  });

  test("an agent on it: no Trabalha no to change, and no picker in its settings", async () => {
    await computers(`/org/${ORG_ID}/agents/${ADA_ID}`, { setup: { state: "preparing" } });
    expect(document.querySelector(".agp-workcard")?.textContent).not.toContain("Trabalha no");
    expect(screen().queryByRole("button", { name: "Mudar onde trabalha" })).toBeNull();
    cleanup();
    await computers(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings&sec=computer`, { setup: { state: "preparing" } });
    expect(document.querySelector(".agp-pc")?.textContent).toContain("Computador da Acme");
    expect(screen().queryByRole("button", { name: "Mudar onde trabalha" })).toBeNull();
  });
});

describe("Configurações → Computadores on self-host", () => {
  test("this server's computer in the devices list, then which computer each agent uses, then how devices work", async () => {
    await computers(`/org/${ORG_ID}/settings/computers`, { host: true });
    expect(body()).toContain("Onde seus agentes trabalham: os computadores e celulares que as pessoas conectam.");
    const list = screen().getByRole("list", { name: "Dispositivos" });
    expect(list.querySelector(".dv-row__name")?.textContent).toBe("Computador deste servidor");
    // Its own card is only for a stopped one, or how to make one.
    expect(region("Computador deste servidor")).toBeNull();
    expect((region("Qual computador cada agente usa") as HTMLElement).textContent).not.toContain("Um por agente");
    expect(body()).not.toMatch(/na nuvem|computador na nuvem|in the cloud/i);
    // What it all means is one help page, linked once at the end.
    const how = screen().getByRole("link", { name: "Como os dispositivos funcionam" });
    expect(new URL(how.getAttribute("href") ?? "").href).toBe("https://agentes.chat/pt/docs/computers");
    expect(how.className).toBe("ac-link ac-link--muted");
    expect([...document.querySelectorAll(".settings__body a")].at(-1)).toBe(how);
  });

  test("with no computer of the server's own, admins read how to make it one, only while sign-up is closed", async () => {
    await computers(`/org/${ORG_ID}/settings/computers`);
    const missing = region("Computador deste servidor") as HTMLElement;
    // The install page's steps, on the public docs: the repository's own guide isn't public.
    expect(missing.textContent).toContain("Este servidor também pode ser o computador dos agentes: veja como.");
    const link = [...missing.querySelectorAll("a")].find((a) => a.textContent === "veja como");
    expect(link?.getAttribute("href")).toBe("https://agentes.chat/pt/docs/install-on-a-server#computers");
    expect(link?.getAttribute("target")).toBe("_blank");
    cleanup();
    // Open sign-up: the server refuses a computer of its own, so nothing to suggest.
    await computers(`/org/${ORG_ID}/settings/computers`, { signupOpen: true });
    expect(region("Computador deste servidor")).toBeNull();
    cleanup();
    await computers(`/org/${ORG_ID}/settings/computers`, { role: "member" });
    expect(region("Computador deste servidor")).toBeNull();
  });

  test("an agent with no computer has none", async () => {
    await computers(`/org/${ORG_ID}/settings/computers`);
    const rows = (region("Qual computador cada agente usa") as HTMLElement).textContent ?? "";
    expect(rows).toContain("Nenhum computador");
    expect(rows).not.toMatch(/Nuvem/);
    cleanup();

    await computers(`/org/${ORG_ID}/agents/${ATLAS_ID}`);
    const work = document.querySelector(".agp-workcard") as HTMLElement;
    expect(work.textContent).toContain("Nenhum computador");
    expect(work.textContent).not.toMatch(/nuvem/i);
  });

  test("a computer's page: Open beside each agent opens its computer in place", async () => {
    const { api, machines } = await computers(`/org/${ORG_ID}/settings/computers`);
    const m = machines.pair({ name: "Mac mini", os: "darwin" });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
    cleanup();
    await renderApp(`/org/${ORG_ID}/settings/computers/${m.id}`, { api });
    await settle(10);
    expect(screen().queryByRole("link", { name: /Tela ao vivo|Ver a tela/ })).toBeNull();
    const open = screen().getByRole("button", { name: "Abrir: Computador da Ada" });
    open.click();
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Computador da Ada" })).toBeTruthy();
  });
});
