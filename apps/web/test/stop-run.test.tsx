import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { LiveRun } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { TFunction } from "i18next";
import { HOVER_OPEN_MS } from "@/components/ProfileCard";
import { runContext } from "@/components/StopRun";
import { createI18n } from "@/i18n";
import { requestAgentPanel } from "@/lib/agent-panel-ask";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const ids = { threadId: null, runId: "r-live", agentId: ADA_ID };

const open = async (configure?: (s: ReturnType<typeof seedState>) => void) => {
  const state = seedState();
  configure?.(state);
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  const ev = (event: Record<string, unknown>) =>
    act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
  return { state, ev };
};
const cancels = (state: ReturnType<typeof seedState>) => state.calls.filter((c) => c.method === "agents.cancelRun");
const esc = () => act(async () => fireEvent.keyDown(window, { key: "Escape" }));

describe("Parar is immediate", () => {
  test("the card above the box, no row yet or its row out of view: its face, name, step and stop, 'Ver' once the row shows", async () => {
    const { state, ev } = await open((s) => {
      const ada = s.agents.find((a) => a.id === ADA_ID);
      if (ada) (ada as { appearance?: unknown }).appearance = { color: "amber", accessory: "hat" };
    });
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(3);
    // At work it has no row: the line above the composer speaks for it.
    const bar = document.querySelector('.ac-typing[data-active="true"]') as HTMLElement;
    // Its row isn't in the conversation yet: its face, its step and its stop, no "Ver" (nothing to go back to).
    expect(bar.querySelector(".ac-avatar--agent")).not.toBeNull();
    expect(bar.querySelector(".ac-typing__text")?.textContent).toBe("Ada pensando…");
    expect(within(bar).queryByRole("button", { name: "Ver" })).toBeNull();
    // No thinking row comes later either: still no "Ver" while it has no words.
    await act(() => new Promise((r) => setTimeout(r, 2100)));
    expect(within(bar).queryByRole("button", { name: "Ver" })).toBeNull();
    expect(within(bar).getByRole("button", { name: "Parar" })).toBeTruthy();
    // Writing brings no row either: the bar still speaks for it, still with no "Ver".
    await ev({ type: "agent.typing", ...ids });
    await settle(3);
    expect(bar.querySelector(".ac-avatar--agent")).not.toBeNull();
    expect(bar.querySelector(".ac-typing__text")?.textContent).toBe("Ada escrevendo…");
    expect(within(bar).queryByRole("button", { name: "Ver" })).toBeNull();
    // Its stop, one click, nothing asked.
    await act(async () => fireEvent.click(within(bar).getByRole("button", { name: "Parar" })));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(cancels(state)).toHaveLength(1);
  });

  test("the send button turns into stop with an empty box; one click stops, nothing asked", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.typing", ...ids });
    await settle(2);
    const stop = screen().getByRole("button", { name: "Parar a Ada" });
    expect(stop.getAttribute("data-mode")).toBe("stop");
    await act(async () => fireEvent.click(stop));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(cancels(state)).toHaveLength(1);
  });

  test("Esc with an empty composer stops right away", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(2);
    await esc();
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(cancels(state)).toHaveLength(1);
  });

  test("Esc that closes a card opened under the pointer stops nothing and goes no further; the next one stops", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(2);
    const box = screen().getByRole("combobox", { name: /Mensagem para/ });
    box.focus();
    const face = screen().getAllByRole("button", { name: "Perfil de Ada" })[0] as HTMLElement;
    await act(async () => fireEvent.pointerEnter(face, { pointerType: "mouse" }));
    await act(() => new Promise((r) => setTimeout(r, HOVER_OPEN_MS + 100)));
    await settle(2);
    const card = () => screen().queryByRole("dialog", { name: "Perfil" });
    expect(card()).not.toBeNull();
    expect(document.activeElement === box).toBe(true);
    // What the page's own Esc handlers (an inbox reply that closes) would see.
    const reached: string[] = [];
    const onKey = (e: KeyboardEvent) => reached.push(e.key);
    window.addEventListener("keydown", onKey);
    try {
      await act(async () => fireEvent.keyDown(box, { key: "Escape" }));
      await settle(2);
      expect(card()).toBeNull();
      expect(cancels(state)).toHaveLength(0);
      expect(reached).toEqual([]);
    } finally {
      window.removeEventListener("keydown", onKey);
    }
    await act(async () => fireEvent.keyDown(box, { key: "Escape" }));
    await settle(2);
    expect(cancels(state)).toHaveLength(1);
  });

  test("Esc in the conversation's search stops nothing, the second one neither", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(2);
    const search = screen().getAllByRole("combobox", { name: "Buscar" })[0] as HTMLInputElement;
    search.focus();
    await act(async () => fireEvent.change(search, { target: { value: "login" } }));
    await settle(2);
    await act(async () => fireEvent.keyDown(search, { key: "Escape" }));
    await settle(2);
    await act(async () => fireEvent.keyDown(search, { key: "Escape" }));
    await settle(2);
    expect(cancels(state)).toHaveLength(0);
    // From the page itself, Esc still stops it.
    search.blur();
    await esc();
    await settle(2);
    expect(cancels(state)).toHaveLength(1);
  });

  test("Esc in a field of the agent's page in the panel stops nothing under it", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await act(async () => requestAgentPanel(ADA_ID, "settings"));
    await settle(6);
    const panel = screen().getByRole("complementary", { name: "Perfil da Ada" });
    const field = panel.querySelector("input, textarea") as HTMLElement;
    field.focus();
    await act(async () => fireEvent.keyDown(field, { key: "Escape" }));
    await settle(2);
    expect(cancels(state)).toHaveLength(0);
    expect(screen().getByRole("complementary", { name: "Perfil da Ada" })).toBeTruthy();
  });

  test("typing while it works: 'Juntar' (↵) joins; ⌘↵ / Ctrl↵ sends with 'Parar e mandar'", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(2);
    const box = screen().getByRole("combobox", { name: /Mensagem para/ });
    await act(async () => fireEvent.change(box, { target: { value: "olha o refresh" } }));
    const group = screen().getByRole("radiogroup", { name: "Como mandar enquanto a Ada trabalha" });
    expect(
      within(group)
        .getByRole("radio", { name: /Juntar ao que (a|o) \w+ faz/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await act(async () => fireEvent.keyDown(box, { key: "Enter", ctrlKey: true }));
    await settle(3);
    const posts = state.calls.filter((c) => c.method === "chat.post").map((c) => c.args[2] as { steer?: string });
    expect(posts.at(-1)?.steer).toBe("now");
    await act(async () => fireEvent.change(box, { target: { value: "e o login" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(3);
    const again = state.calls.filter((c) => c.method === "chat.post").map((c) => c.args[2] as { steer?: string });
    expect(again.at(-1)?.steer).toBeUndefined();
  });

  test("a member who may not stop it still chooses 'Parar e mandar'; there is no stop button", async () => {
    const { state, ev } = await open((s) => {
      const o = s.me?.organizations[0];
      if (o) o.role = "member";
    });
    // Someone else's message in the channel started it (not mine), on an agent owned by João.
    await ev({ type: "agent.run", ...ids, triggerMessageId: "m-1", status: "running" });
    await settle(2);
    expect(screen().queryByRole("button", { name: "Parar a Ada" })).toBeNull();
    const box = screen().getByRole("combobox", { name: /Mensagem para/ });
    await act(async () => fireEvent.change(box, { target: { value: "olha o refresh" } }));
    expect(screen().getByRole("radiogroup", { name: "Como mandar enquanto a Ada trabalha" })).toBeTruthy();
    await act(async () => fireEvent.keyDown(box, { key: "Enter", ctrlKey: true }));
    await settle(3);
    const posts = state.calls.filter((c) => c.method === "chat.post").map((c) => c.args[2] as { steer?: string });
    expect(posts.at(-1)?.steer).toBe("now");
    await esc();
    await settle(2);
    expect(cancels(state)).toHaveLength(0);
  });

  test("the context line: code for N min, a tool, writing, thinking", () => {
    const i18n = createI18n("pt-BR");
    const t = i18n.t.bind(i18n) as TFunction;
    const base: LiveRun = {
      runId: "r",
      agentId: "a",
      channelId: "c",
      threadId: "t",
      status: "thinking",
      startedAt: 0,
    };
    const call = (tool: string, code: boolean) => ({
      kind: "call" as const,
      id: "x",
      tool,
      connector: null,
      detail: null,
      code: code ? { language: "bash", source: "ls" } : null,
      output: [],
      running: true,
      since: 0,
    });
    expect(runContext(t, { ...base, work: [call("run_code", true)] }, 2 * 60_000)).toBe("rodando código há 2 min");
    expect(runContext(t, { ...base, status: "running" }, 1000)).toBe("escrevendo a resposta");
    expect(runContext(t, base, 10_000)).toBe("pensando há menos de 1 min");
  });
});
