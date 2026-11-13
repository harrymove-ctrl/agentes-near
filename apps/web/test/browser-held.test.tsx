import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type BrowserHandoff, heldRowsIn, resetHeldPlaces } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, fakeBrowserOf, ORG_ID, seedState } from "./fake-api";
import { onScreen, renderApp, settle } from "./render";

let offScreen = () => {};
afterEach(() => {
  cleanup();
  resetHeldPlaces();
  offScreen();
});

const cards = () => [...document.querySelectorAll(".brw-ac")] as HTMLElement[];

/** Ada at work in its browser in #eng: its live row with the browser card. */
async function browsing(api = createFakeApi(seedState())) {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  const ev = (event: Record<string, unknown>) =>
    act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
  return { r, socket, ev, api };
}

describe("Assumir: the card stays the control while the agent waits", () => {
  test("the run pauses for the person and posts its line: the card stays on that message, in control, until Pronto", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const { ev } = await browsing(api);
    const run = { threadId: null, runId: "r-held", agentId: ADA_ID };
    await ev({ type: "agent.thinking", ...run });
    await ev({ type: "agent.tool", ...run, tool: "browser_open" });
    await settle();
    await act(async () => fireEvent.click(within(cards()[0] as HTMLElement).getByRole("button", { name: "Assumir" })));
    await settle(3);
    // The take over is bound to the run whose card it was taken from.
    const call = state.calls.find((c) => c.method === "browser.takeover");
    expect(call?.args).toEqual([ORG_ID, ADA_ID, "r-held"]);
    expect(cards()).toHaveLength(1);
    // In control the frame turns graphite and Devolver sits under the page, not in its top.
    expect(cards()[0]?.classList.contains("is-control")).toBe(true);
    const top = cards()[0]?.querySelector(".brw-mf__top") as HTMLElement;
    expect(within(top).queryByRole("button", { name: "Devolver" })).toBeNull();
    const foot = cards()[0]?.querySelector(".brw-ac__back") as HTMLElement;
    expect(within(foot).getByRole("button", { name: "Devolver" })).toBeTruthy();

    // The agent pauses (waiting for the hand back) and says so: the live row goes, its message lands.
    await ev({ type: "agent.run", ...run, status: "waiting_input" });
    await ev({
      type: "message.created",
      messageId: "m-took",
      message: {
        id: "m-took",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body: "Uma pessoa pegou o controle do meu navegador; espero ela devolver.",
        mentionedAgentIds: [],
        agentRunId: "r-held",
        createdAt: new Date().toISOString(),
      },
    });
    await settle(4);
    // Still there, still mine, open: one card (not two), Devolver under the page (a take over, not a request).
    expect(cards()).toHaveLength(1);
    const card = cards()[0] as HTMLElement;
    expect(card.classList.contains("is-control")).toBe(true);
    expect(card.classList.contains("is-open")).toBe(true);
    expect(within(card).queryByRole("button", { name: "Pronto" })).toBeNull();
    expect(card.closest("article")?.textContent).toContain("Uma pessoa pegou o controle");

    // An optional word to the agent, then Devolver hands back: the card goes with the take over.
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Deixar um recado" })));
    const note = within(card).getByRole("textbox", { name: "Recado para a Ada" });
    await act(async () => fireEvent.change(note, { target: { value: "Entrei com a conta de teste" } }));
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Devolver" })));
    await settle(3);
    const done = state.calls.find((c) => c.method === "browser.done");
    expect(done?.args.at(-1)).toBe("Entrei com a conta de teste");
    expect(cards()).toHaveLength(0);
  });

  test("the run fails while I hold the browser: the card stays for me to hand back", async () => {
    const state = seedState();
    const { ev } = await browsing(createFakeApi(state));
    const run = { threadId: null, runId: "r-fail", agentId: ADA_ID };
    await ev({ type: "agent.thinking", ...run });
    await ev({ type: "agent.tool", ...run, tool: "browser_open" });
    await settle();
    await act(async () => fireEvent.click(within(cards()[0] as HTMLElement).getByRole("button", { name: "Assumir" })));
    await settle(3);
    await ev({ type: "run.finished", ...run, status: "failed", error: "boom" });
    await settle(3);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.classList.contains("is-control")).toBe(true);
    expect(within(cards()[0] as HTMLElement).getByRole("button", { name: "Devolver" })).toBeTruthy();
  });

  test("someone else holding it: Assumir says another person is helping", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const fake = fakeBrowserOf.get(api);
    if (!fake) throw new Error("no fake browser");
    fake.client.takeover = async () => {
      throw new ApiError(409, "conflict", "Someone else is in control");
    };
    const { ev } = await browsing(api);
    const run = { threadId: null, runId: "r-busy", agentId: ADA_ID };
    await ev({ type: "agent.thinking", ...run });
    await ev({ type: "agent.tool", ...run, tool: "browser_open" });
    await settle();
    await act(async () => fireEvent.click(within(cards()[0] as HTMLElement).getByRole("button", { name: "Assumir" })));
    await settle(3);
    expect(document.body.textContent).toContain("Outra pessoa já está ajudando.");
  });

  test("Devolver while the agent still works: its page stays in view, with Assumir again", async () => {
    const state = seedState();
    const { ev } = await browsing(createFakeApi(state));
    const run = { threadId: null, runId: "r-back", agentId: ADA_ID };
    await ev({ type: "agent.thinking", ...run });
    await ev({ type: "agent.tool", ...run, tool: "browser_open" });
    await settle();
    const card = cards()[0] as HTMLElement;
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Assumir" })));
    await settle(3);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Devolver" })));
    await settle(3);
    expect(state.calls.some((c) => c.method === "browser.done")).toBe(true);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toBe(card);
    expect(card.classList.contains("is-control")).toBe(false);
    expect(card.querySelector(".brw-ac__back")).toBeNull();
    expect(card.classList.contains("is-open")).toBe(true);
    expect(within(card).getByRole("button", { name: "Assumir" })).toBeTruthy();
  });

  test("who may only watch gets no Assumir: Parar stays", async () => {
    const api = createFakeApi(seedState());
    fakeBrowserOf.get(api)?.watchOnly.add(ADA_ID);
    const { ev } = await browsing(api);
    const run = { threadId: null, runId: "r-watch", agentId: ADA_ID };
    await ev({ type: "agent.thinking", ...run });
    await ev({ type: "agent.tool", ...run, tool: "browser_open" });
    await settle(3);
    const card = cards()[0] as HTMLElement;
    expect(within(card).getByRole("button", { name: "Parar" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Assumir" })).toBeNull();
  });

  test("Parar by someone else reaches every viewer: the card says who stopped it", async () => {
    // Watching it (on screen): the live view hears the stop.
    offScreen = onScreen(".brw-ac");
    const state = seedState();
    const { ev, socket } = await browsing(createFakeApi(state));
    const run = { threadId: null, runId: "r-stop", agentId: ADA_ID };
    await ev({ type: "agent.thinking", ...run });
    await ev({ type: "agent.tool", ...run, tool: "browser_open" });
    await settle(2);
    await act(async () =>
      socket.push({
        type: "browser.ended",
        agentId: ADA_ID,
        reason: "stopped",
        byUserId: "u-joao",
        at: new Date().toISOString(),
      }),
    );
    await settle();
    const card = cards()[0] as HTMLElement;
    expect(card.textContent).toContain("Navegador parado");
    expect(card.textContent).toContain("por João ·");
    expect(within(card).queryByRole("button", { name: "Assumir" })).toBeNull();
  });
});

describe("where a held card goes when its run has no live block", () => {
  const place = { runId: "r1", agentId: ADA_ID, channelId: ENG_ID, threadId: "t1" };
  test("only this channel's, in a thread this view shows, with no live block and no message here", () => {
    const view = {
      channelId: ENG_ID,
      visible: (t: string | null) => t !== "hidden",
      live: new Set<string>(),
      landed: new Set<string>(),
    };
    expect(heldRowsIn([place], view)).toEqual([place]);
    expect(heldRowsIn([{ ...place, channelId: "other" }], view)).toEqual([]);
    expect(heldRowsIn([{ ...place, threadId: "hidden" }], view)).toEqual([]);
    // The live block draws it; else the run's last message here does.
    expect(heldRowsIn([place], { ...view, live: new Set(["r1"]) })).toEqual([]);
    expect(heldRowsIn([place], { ...view, landed: new Set(["r1"]) })).toEqual([]);
  });

  test("a take over is held by its run only while it is open", async () => {
    const { isHeldTakeover } = await import("@agenteschat/client");
    const h: BrowserHandoff = {
      id: "h1",
      agentId: ADA_ID,
      runId: "r1",
      machineId: "machine-1",
      kind: "takeover",
      instructions: "",
      status: "active",
      requestedForUserId: null,
      controllerUserId: "u-walter",
      note: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    expect(isHeldTakeover(h, "r1")).toBe(true);
    expect(isHeldTakeover(h, "r2")).toBe(false);
    expect(isHeldTakeover({ ...h, status: "done" }, "r1")).toBe(false);
    expect(isHeldTakeover({ ...h, kind: "ask" }, "r1")).toBe(false);
  });
});
