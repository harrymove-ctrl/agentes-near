import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (state: FakeState = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/settings/media`, { api: createFakeApi(state) });
  await settle(6);
  return { ...r, state };
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const lastSettings = (state: FakeState) => state.calls.findLast((c) => c.method === "orgs.updateSettings")?.args[1];
const asMember = (state = seedState()) => {
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  return state;
};
const disabled = (el: Element) => el.hasAttribute("disabled");
/** The section itself, beside the settings' nav. */
const section = () => within(document.querySelector(".settings__body") as HTMLElement);

describe("Configurações › GIFs e figurinhas (ADR 0091)", () => {
  test("a tab of Workspace, with what it is for", async () => {
    await go();
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    expect(within(nav).getByRole("link", { name: "Workspace" }).getAttribute("aria-current")).toBe("page");
    expect(section().getByRole("tab", { name: "GIFs e figurinhas" }).getAttribute("aria-selected")).toBe("true");
    expect(section().getByRole("heading", { level: 2, name: "GIFs e figurinhas" })).toBeTruthy();
    expect(section().getByRole("region", { name: "Na conversa" })).toBeTruthy();
    expect(section().getByRole("region", { name: "Agentes" })).toBeTruthy();
  });

  test("admins: the rating, how often agents send, the stickers, GIFs and each agent's own switch", async () => {
    const { state } = await go();
    const any = screen().getByRole("radio", { name: "Qualquer idade" });
    expect(any.getAttribute("aria-checked")).toBe("true");
    await click(screen().getByRole("radio", { name: "Até 13 anos" }));
    expect(lastSettings(state)).toEqual({ gifRating: "pg" });
    expect(screen().getByRole("radio", { name: "Às vezes" }).getAttribute("aria-checked")).toBe("true");
    await click(screen().getByRole("radio", { name: "Bastante" }));
    expect(lastSettings(state)).toEqual({ agentMedia: "often" });
    const stickers = screen().getByRole("switch", { name: "Figurinhas dos agentes" });
    expect(stickers.getAttribute("aria-checked")).toBe("true");
    await click(stickers);
    expect(lastSettings(state)).toEqual({ agentStickers: false });
    const gifs = screen().getByRole("switch", { name: "GIFs" });
    await click(gifs);
    expect(lastSettings(state)).toEqual({ gifs: false });
    // GIFs off: their rating waits, off.
    expect(disabled(screen().getByRole("radio", { name: "Até 13 anos" }))).toBe(true);
    const ada = screen().getByRole("switch", { name: "Ada manda GIFs e figurinhas" });
    expect(ada.getAttribute("aria-checked")).toBe("true");
    await click(ada);
    expect(state.calls.findLast((c) => c.method === "agents.update")?.args).toEqual([
      ORG_ID,
      ADA_ID,
      { mediaReplies: false },
    ]);
    expect(screen().getByRole("switch", { name: "Ada manda GIFs e figurinhas" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  test("a press on a switch line's words toggles it, as a press on a line that opens something opens it", async () => {
    const { state } = await go();
    const words = [...document.querySelectorAll(".settings-row__label")].find((e) => e.textContent === "GIFs");
    if (!words) throw new Error("no GIFs line");
    await click(words);
    expect(lastSettings(state)).toEqual({ gifs: false });
    // A line whose control is a choice of several stays as it was: its words pick nothing.
    const rating = [...document.querySelectorAll(".settings-row__label")].find((e) =>
      e.closest(".settings-row")?.querySelector('[role="radio"]'),
    );
    expect(rating?.closest("label")).toBeNull();
  });

  test("members don't open it: the workspace's switches are for who configures it", async () => {
    const { state } = await go(asMember());
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    expect(within(nav).queryByRole("link", { name: "GIFs e figurinhas" })).toBeNull();
    // Their own section instead, nothing of the workspace's.
    expect(section().queryByRole("region", { name: "Na conversa" })).toBeNull();
    expect(screen().queryByRole("switch", { name: "GIFs" })).toBeNull();
    expect(lastSettings(state)).toBeUndefined();
  });

  test("what this server can't do is said beside its control, which stays off", async () => {
    await go(seedState({ media: { gifsAvailable: false, agentMediaAvailable: false } }));
    const gifs = screen().getByRole("switch", { name: "GIFs" });
    expect(gifs.getAttribute("aria-checked")).toBe("false");
    expect(disabled(gifs)).toBe(true);
    expect(document.getElementById("media-gifs-status")?.textContent).toBe(
      "A busca de GIFs ainda não está disponível aqui.",
    );
    expect(gifs.getAttribute("aria-describedby")).toBe("media-gifs-status");
    expect(screen().getByRole("radio", { name: "Nunca" }).getAttribute("aria-checked")).toBe("true");
    expect(disabled(screen().getByRole("radio", { name: "Às vezes" }))).toBe(true);
    expect(document.getElementById("media-level-status")?.textContent).toBe("Ainda não disponível aqui.");
    // Each agent's own switch still decides whether it sends one when asked (its sticker, here).
    expect(disabled(screen().getByRole("switch", { name: "Ada manda GIFs e figurinhas" }))).toBe(false);
    // Stickers need nothing from the server.
    expect(disabled(screen().getByRole("switch", { name: "Figurinhas dos agentes" }))).toBe(false);
    // No internal names in what a person reads.
    expect(section().getByRole("region", { name: "Na conversa" }).textContent).not.toMatch(/GIPHY_API_KEY/);
    expect(section().getByRole("region", { name: "Agentes" }).textContent).not.toMatch(/TypeSafe|\bJev\b/);
  });

  test("Nunca: none on their own; each agent's switch still says whether it sends one when asked", async () => {
    const { state } = await go(seedState({ media: { agentMedia: "never" } }));
    const asked = "Se alguém pedir, mandam mesmo em Nunca.";
    expect(document.getElementById("media-level-help")?.textContent?.endsWith(asked)).toBe(true);
    const ada = screen().getByRole("switch", { name: "Ada manda GIFs e figurinhas" });
    expect(ada.getAttribute("aria-checked")).toBe("true");
    expect(disabled(ada)).toBe(false);
    const note = "Com Nunca, nenhum agente manda por conta própria. Quando alguém pede, os ligados aqui mandam.";
    expect(screen().getByText(note)).toBeTruthy();
    await click(ada);
    expect(state.calls.findLast((c) => c.method === "agents.update")?.args).toEqual([
      ORG_ID,
      ADA_ID,
      { mediaReplies: false },
    ]);
  });
});
