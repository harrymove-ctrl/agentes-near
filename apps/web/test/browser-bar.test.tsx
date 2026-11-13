import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { onScreen, renderApp, settle } from "./render";

let offScreen = () => {};
afterEach(() => {
  cleanup();
  offScreen();
});

describe("the activity bar while an agent is in its browser", () => {
  test("says 'No navegador'; a click on the bar brings the agent's browser card into view in the conversation", async () => {
    const state = seedState();
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    const run = { threadId: null, runId: "r-browser", agentId: ADA_ID };
    await ev({ type: "agent.thinking", ...run });
    await settle();
    const bar = () => document.querySelector(".ac-typing") as HTMLElement;
    // Not in the browser yet: no hint, the bar isn't a link.
    expect(within(bar()).queryByRole("button", { name: "No navegador" })).toBeNull();
    expect(bar().dataset.browser).toBeUndefined();

    await ev({ type: "agent.tool", ...run, tool: "browser_open" });
    await settle();
    expect(bar().dataset.browser).toBe("true");
    // Its row out of view (no layout here): the bar says its row's step.
    expect(bar().querySelector(".ac-typing__text")?.textContent).toStartWith("Ada ");
    expect(within(bar()).getByRole("button", { name: "No navegador" })).toBeTruthy();

    // The agent's browser card on its live row: its page always in view, in a frame of its color whose top says
    // what it does now.
    const card = () => document.querySelector(".brw-ac") as HTMLElement;
    expect(card().classList.contains("brw-mf")).toBe(true);
    expect(card().classList.contains("is-open")).toBe(true);
    expect(card().querySelector(".brw-mf__now")?.textContent).toContain("Ada está abrindo o navegador");

    // The pill itself is the target (its words), not only the button: the card comes into view, no page change.
    let shown = false;
    card().scrollIntoView = () => {
      shown = true;
    };
    await act(async () => fireEvent.click(bar().querySelector(".ac-typing__text") as HTMLElement));
    await settle(2);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(shown).toBe(true);
    // Before the first frame: opening, never an error.
    expect(card().textContent).toContain("Abrindo o navegador da Ada…");
    expect(within(card()).getByRole("button", { name: "Assumir" })).toBeTruthy();
  });

  test("the server's reasons are said in the person's language, never its own words", async () => {
    // Watching it: the card streams while on screen.
    offScreen = onScreen(".brw-ac");
    const state = seedState();
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    const run = { threadId: null, runId: "r-browser-2", agentId: ADA_ID };
    await ev({ type: "agent.thinking", ...run });
    await ev({ type: "agent.tool", ...run, tool: "browser_open" });
    await settle();
    const card = () => document.querySelector(".brw-ac") as HTMLElement;
    // The runner said its browser isn't open (in English): the card keeps "opening" while it retries.
    await act(async () =>
      socket.push({
        type: "browser.unavailable",
        agentId: ADA_ID,
        reason: "unavailable",
        message: "The agent's browser isn't open",
      }),
    );
    await settle();
    expect(card().textContent).not.toContain("isn't open");
    expect(card().textContent).toContain("Abrindo o navegador da Ada…");
    // A computer that's off is said plainly.
    await act(async () => socket.push({ type: "browser.unavailable", agentId: ADA_ID, reason: "offline" }));
    await settle();
    expect(card().textContent).toContain("O computador da Ada está desligado ou sem internet.");
  });
});
