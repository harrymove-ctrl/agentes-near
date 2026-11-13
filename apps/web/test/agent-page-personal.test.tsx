import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/* A personal workspace's agent page (ADR 0159 §3): a shorter bar, the hard parts in Advanced, every address working. */

afterEach(() => cleanup());

const personal = () => {
  const state = seedState();
  const org = state.me?.organizations[0];
  if (org) org.mode = "personal";
  return state;
};
const go = async (query = "", state = personal()) => {
  const r = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}${query}`, { api: createFakeApi(state) });
  await settle(8);
  return r;
};
const bar = () => screen().getByRole("tablist", { name: "Seções da Ada" });
const tabNames = () =>
  within(bar())
    .getAllByRole("tab")
    .map((t) => t.textContent?.replace(/\d+$/, ""));
const heading = (name: string) => screen().queryByRole("heading", { name });

describe("a personal workspace's agent page", () => {
  test("its bar: what one person uses and Advanced, no More menu", async () => {
    await go();
    expect(tabNames()).toEqual(["Visão geral", "Instruções", "Memória", "Pode usar", "Ajustes", "Avançado"]);
    expect(within(bar()).queryByRole("button", { name: /^Mais/ })).toBeNull();
  });

  test("Settings keeps its name, look and budget; owner, channels and the danger zone are in Advanced", async () => {
    await go("?tab=settings");
    expect(heading("Identidade e jeito")).not.toBeNull();
    expect(heading("Orçamento")).not.toBeNull();
    expect(heading("Responsável")).toBeNull();
    expect(heading("Arquivar ou apagar")).toBeNull();
    expect(screen().queryByRole("navigation", { name: "Seções das configurações" })).toBeNull();
  });

  test("an address to an advanced section opens Advanced on it; Activity, Files and Usage are a click away", async () => {
    const { router } = await go("?tab=settings&sec=owner");
    expect(within(bar()).getByRole("tab", { name: "Avançado" }).getAttribute("aria-selected")).toBe("true");
    expect(heading("Responsável")).not.toBeNull();
    expect(heading("Arquivar ou apagar")).not.toBeNull();
    expect(heading("Nativos do agentes")).not.toBeNull();
    expect(heading("Identidade e jeito")).toBeNull();
    const links = screen().getByRole("navigation", { name: "Atividade, arquivos e uso" });
    await act(async () => fireEvent.click(within(links).getByRole("button", { name: "Uso" })));
    await settle(4);
    expect(router.state.location.search).toMatchObject({ tab: "usage" });
    // The tab opened from there joins the bar while open.
    expect(tabNames()).toEqual(["Visão geral", "Instruções", "Memória", "Pode usar", "Ajustes", "Avançado", "Uso"]);
  });

  test("Can use shows its apps; the built-in areas and skills are in Advanced", async () => {
    await go("?tab=access");
    expect(heading("Os seus conectores")).not.toBeNull();
    expect(heading("Nativos do agentes")).toBeNull();
    expect(heading("Skills")).toBeNull();
  });

  test("a team's page is as before: Advanced is Configurações there", async () => {
    await go("?tab=advanced", seedState());
    expect(within(bar()).queryByRole("tab", { name: "Avançado" })).toBeNull();
    expect(heading("Responsável")).not.toBeNull();
    expect(heading("Identidade e jeito")).not.toBeNull();
  });
});
