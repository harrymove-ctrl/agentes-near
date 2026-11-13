import { afterEach, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { DESKTOP_QUERY } from "@/components/NavDrawer";
import { useEscClose } from "@/hooks/useEscClose";
import { requestAgentPanel } from "@/lib/agent-panel-ask";
import { holdsText } from "@/lib/keys";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

let media: { mockRestore: () => void } | null = null;
afterEach(() => {
  cleanup();
  media?.mockRestore();
  media = null;
  localStorage.clear();
});

const esc = (el: Element | Window = document.body) => act(async () => fireEvent.keyDown(el, { key: "Escape" }));

function Panel({ name, onClose }: { name: string; onClose: () => void }) {
  useEscClose(onClose);
  return (
    <aside aria-label={name}>
      <input aria-label={`${name} field`} />
    </aside>
  );
}

function Panels() {
  const [open, setOpen] = useState(["a", "b"]);
  return (
    <>
      <button type="button" onClick={() => setOpen(["a"])}>
        opener
      </button>
      {open.map((name) => (
        <Panel key={name} name={name} onClose={() => setOpen((l) => l.filter((n) => n !== name))} />
      ))}
    </>
  );
}

const shown = (name: string) => document.querySelector(`[aria-label="${name}"]`);

test("Esc closes the newest panel alone, then the one under it", async () => {
  render(<Panels />);
  await esc();
  expect(shown("b")).toBeNull();
  expect(shown("a")).not.toBeNull();
  await esc();
  expect(shown("a")).toBeNull();
});

test("a menu, a dialog or a listbox takes Esc first", async () => {
  render(<Panels />);
  for (const role of ["menu", "dialog", "listbox"]) {
    const layer = document.body.appendChild(document.createElement("div"));
    layer.setAttribute("role", role);
    await esc();
    layer.remove();
    expect(shown("b")).not.toBeNull();
  }
});

test("something marked as a layer takes Esc wherever the focus is", async () => {
  render(<Panels />);
  const layer = document.body.appendChild(document.createElement("div"));
  layer.setAttribute("data-esc-layer", "");
  await esc();
  layer.remove();
  expect(shown("b")).not.toBeNull();
});

test("a field with text and a field with an Esc of its own keep it; an empty field gives it to the panel", async () => {
  render(<Panels />);
  const field = shown("b field") as HTMLInputElement;
  field.focus();
  await act(async () => fireEvent.change(field, { target: { value: "oi" } }));
  await esc(field);
  expect(shown("b")).not.toBeNull();
  await act(async () => fireEvent.change(field, { target: { value: "" } }));
  field.setAttribute("data-esc-own", "");
  await esc(field);
  expect(shown("b")).not.toBeNull();
  field.removeAttribute("data-esc-own");
  await esc(field);
  expect(shown("b")).toBeNull();
});

test("a field marked free gives Esc to the panel with its text in it", async () => {
  render(<Panels />);
  const field = shown("b field") as HTMLInputElement;
  field.setAttribute("data-esc-free", "");
  await act(async () => fireEvent.change(field, { target: { value: "oi" } }));
  await esc(field);
  expect(shown("b")).toBeNull();
});

test("an Esc something else already took closes nothing", async () => {
  const taken = (e: KeyboardEvent) => e.preventDefault();
  window.addEventListener("keydown", taken, true);
  render(<Panels />);
  await esc();
  window.removeEventListener("keydown", taken, true);
  expect(shown("b")).not.toBeNull();
});

test("holdsText: a filled text field, not a checkbox", () => {
  const box = (html: string) => {
    const el = document.createElement("div");
    el.innerHTML = html;
    return el.firstElementChild;
  };
  expect(holdsText(box('<input value="oi">'))).toBe(true);
  expect(holdsText(box("<textarea>oi</textarea>"))).toBe(true);
  expect(holdsText(box('<div contenteditable="true">oi</div>'))).toBe(true);
  expect(holdsText(box('<input value="  ">'))).toBe(false);
  expect(holdsText(box('<input type="checkbox" value="on">'))).toBe(false);
  expect(holdsText(box("<button>oi</button>"))).toBe(false);
  expect(holdsText(window)).toBe(false);
});

const thread = () => screen().queryByRole("complementary", { name: "Thread" });
const main = () => document.getElementById(`composer-${ENG_ID}`) as HTMLTextAreaElement;

/** A desktop, #eng open, and a thread opened from its pinned reply. */
async function openThread() {
  media = spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === DESKTOP_QUERY,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  const state = seedState();
  const reply: Message = {
    id: "m-reply",
    channelId: ENG_ID,
    threadId: "m-1",
    author: { type: "agent", id: ADA_ID },
    body: "Corrigido no refresh",
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date().toISOString(),
  };
  state.messages.push(reply);
  const api = createFakeApi(state);
  const pin = {
    messageId: reply.id,
    channelId: ENG_ID,
    threadId: "m-1",
    pinnedByUserId: "u-joao",
    pinnedAt: "2026-11-01T10:00:00.000Z",
    message: reply,
  };
  api.pins = { list: async () => [pin], pin: async () => ({}) as never, unpin: async () => {} };
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(8);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Mensagens fixadas \(/ })));
  await settle(2);
  const list = screen().getByRole("dialog", { name: "Mensagens fixadas em #eng" });
  await act(async () => fireEvent.click(list.querySelector(".thread-pop__row") as HTMLElement));
  await settle(6);
  expect(thread()).toBeTruthy();
  const running = () =>
    act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          channelId: ENG_ID,
          type: "agent.run",
          threadId: null,
          runId: "r-live",
          agentId: ADA_ID,
          status: "running",
        },
      }),
    );
  return { state, running };
}

const cancels = (state: ReturnType<typeof seedState>) => state.calls.filter((c) => c.method === "agents.cancelRun");

test("Esc closes the thread from the page, and the focus lands in a composer", async () => {
  await openThread();
  (document.activeElement as HTMLElement | null)?.blur();
  await esc();
  await settle(2);
  expect(thread()).toBeNull();
  expect(document.activeElement).toBe(main());
});

test("in the thread: its empty box closes it, with text the box keeps Esc", async () => {
  await openThread();
  const box = (thread() as HTMLElement).querySelector("textarea") as HTMLTextAreaElement;
  box.focus();
  await act(async () => fireEvent.change(box, { target: { value: "rascunho" } }));
  await esc(box);
  await settle(2);
  expect(thread()).toBeTruthy();
  await act(async () => fireEvent.change(box, { target: { value: "" } }));
  await esc(box);
  await settle(2);
  expect(thread()).toBeNull();
});

test("the main composer: Esc stops the agent while one runs and leaves the thread open; with none it closes it", async () => {
  const { state, running } = await openThread();
  await running();
  await settle(2);
  main().focus();
  await esc(main());
  await settle(2);
  expect(cancels(state)).toHaveLength(1);
  expect(thread()).toBeTruthy();
  await act(async () => fireEvent.change(main(), { target: { value: "oi" } }));
  await esc(main());
  await settle(2);
  expect(thread()).toBeTruthy();
});

test("the main composer with no run going: Esc closes the thread and the focus stays in it", async () => {
  await openThread();
  main().focus();
  await esc(main());
  await settle(2);
  expect(thread()).toBeNull();
  expect(document.activeElement).toBe(main());
});

test("a run going: Esc from a panel's field with text stops nothing, Esc from the page closes the panel first", async () => {
  const { state, running } = await openThread();
  await running();
  await settle(2);
  const box = (thread() as HTMLElement).querySelector("textarea") as HTMLTextAreaElement;
  box.focus();
  await act(async () => fireEvent.change(box, { target: { value: "rascunho" } }));
  await esc(box);
  await settle(2);
  expect(cancels(state)).toHaveLength(0);
  box.blur();
  await esc();
  await settle(2);
  expect(thread()).toBeNull();
  expect(cancels(state)).toHaveLength(0);
});

test("the agent's page in the panel closes on Esc too", async () => {
  await openThread();
  await act(async () => requestAgentPanel(ADA_ID, "overview"));
  await settle(6);
  const profile = () => screen().queryByRole("complementary", { name: "Perfil da Ada" });
  expect(profile()).toBeTruthy();
  await esc();
  await settle(4);
  expect(profile()).toBeNull();
});
