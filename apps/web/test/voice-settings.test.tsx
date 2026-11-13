import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { SpeechKey } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const OFF: SpeechKey = { provider: null, hint: null, state: "off", envProviders: [] };

const go = async (patch: Partial<FakeState> = {}) => {
  const state = seedState(patch);
  await renderApp(`/org/${ORG_ID}/settings/voice`, { api: createFakeApi(state) });
  await settle(6);
  return state;
};
const card = () => screen().getByRole("region", { name: "Mensagens de voz" });
const field = () => within(card()).getByLabelText("Chave da AssemblyAI") as HTMLInputElement;
const test_ = () => within(card()).getByRole("button", { name: "Testar" });

describe("voice messages in Configurações (ADR 0100)", () => {
  test("nobody but the server's owner picks a provider, and no cost shows", async () => {
    await go({ media: { voiceAvailable: true } });
    expect(within(card()).queryByRole("button", { name: "Testar" })).toBeNull();
    expect(card().textContent).not.toMatch(/US\$|R\$|minutos/);
  });

  test("a key is tried, kept, and never shown", async () => {
    const state = await go({ speechKey: OFF, media: { voiceAvailable: false } });
    await act(async () => fireEvent.change(field(), { target: { value: "aai_key_7a1e" } }));
    await act(async () => fireEvent.click(test_()));
    await settle(6);
    expect(state.calls.some((c) => c.method === "system.saveSpeechKey")).toBe(true);
    expect(card().textContent).toContain("Termina em 7a1e");
    expect(document.body.innerHTML).not.toContain("aai_key_7a1e");
    expect(screen().getByRole("switch", { name: "Mensagens de voz" }).hasAttribute("disabled")).toBe(false);
  });

  test("a tab of Workspace only on a self-hosted server: agentes.chat Cloud has no Voz, and its link opens Sua conta", async () => {
    const nav = () => within(screen().getByRole("navigation", { name: "Seções das configurações" }));
    await go({ authConfig: { cloud: false }, media: { voiceAvailable: true } });
    expect(nav().getByRole("link", { name: "Workspace" }).getAttribute("aria-current")).toBe("page");
    expect(screen().getByRole("tab", { name: "Voz" }).getAttribute("aria-selected")).toBe("true");
    expect(card()).toBeTruthy();
    cleanup();

    await go({ authConfig: { cloud: true }, media: { voiceAvailable: true } });
    expect(screen().queryByRole("tab", { name: "Voz" })).toBeNull();
    expect(screen().queryByRole("region", { name: "Mensagens de voz" })).toBeNull();
    expect(screen().getByRole("heading", { level: 2, name: "Sua conta" })).toBeTruthy();
    // Nothing about the person's role: no one has Voz on the Cloud.
    expect(screen().queryByText(/não abre com o seu papel/)).toBeNull();
  });

  test("a key the provider refuses: said under the field, nothing kept", async () => {
    const state = await go({ speechKey: OFF, speechKeyRefused: ["wrong_key_0000"], media: { voiceAvailable: false } });
    await act(async () => fireEvent.change(field(), { target: { value: "wrong_key_0000" } }));
    await act(async () => fireEvent.click(test_()));
    await settle(6);
    expect(state.speechKey?.provider).toBeNull();
    expect(field().getAttribute("aria-invalid")).toBe("true");
  });
});
