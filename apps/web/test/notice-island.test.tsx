import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { island } from "@/lib/island";
import { builtCss, declarations, topLevel } from "./built-css";
import { ADA_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, settle } from "./render";

afterEach(() => {
  island.putAway();
  cleanup();
});

const reply = notification({
  id: "n-reply",
  kind: "agent_reply",
  actors: [{ type: "agent", id: ADA_ID }],
  source: { channelId: GENERAL_ID, messageId: "m-1" },
  latest: { text: "Não tô contra, mas acho que vale testar antes." },
});

test("the closed island ends in 'Ver', which opens the message where it happened", async () => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
  await act(async () => island.arrive(reply));
  await settle(3);
  const bar = document.querySelector(".ni__bar") as HTMLElement;
  // A button of its own after the pill, never one inside the other.
  const see = within(bar).getByRole("button", { name: "Ver" });
  expect(see.previousElementSibling?.classList.contains("ni__pill")).toBe(true);
  expect(bar.querySelector(".ni__pill button")).toBeNull();
  await act(async () => fireEvent.click(see));
  await settle(4);
  expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
  expect(r.router.state.location.search).toMatchObject({ m: "m-1" });
  // It goes off the island once opened.
  expect(island.get().items.map((i) => i.n.id)).toEqual([]);
});

test("in a workspace being deleted the open island takes no answer: its quick reply's place says why", async () => {
  const opened = async (state: ReturnType<typeof seedState>) => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await act(async () => island.arrive(reply));
    await settle(3);
    await act(async () => fireEvent.click(document.querySelector(".ni__pill") as HTMLElement));
    await settle(3);
    return document.querySelector(".ni__item") as HTMLElement;
  };
  expect(within(await opened(seedState())).getByRole("button", { name: "Responder" })).toBeTruthy();
  cleanup();
  island.clear();

  const state = seedState();
  for (const org of state.me?.organizations ?? [])
    org.deletion = { dueAt: new Date(Date.now() + 6 * 86_400_000).toISOString(), requestedAt: null, requestedBy: null };
  const row = await opened(state);
  expect(within(row).queryByRole("button", { name: "Responder" })).toBeNull();
  expect(within(row).getByRole("status").textContent).toBe(
    "Você não pode enviar mensagens enquanto este workspace está sendo apagado",
  );
  await act(async () => island.clear());
});

test("over a thread open in the panel the island stays in reach: its 'Ver' is the island's, never the panel's", async () => {
  const state = seedState();
  state.messages.push({
    id: "m-reply",
    channelId: ENG_ID,
    threadId: "m-1",
    author: { type: "agent", id: ADA_ID },
    body: "Olhei o refresh.",
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date().toISOString(),
  });
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}?thread=m-1`, { api: createFakeApi(state) });
  await settle(6);
  expect(document.querySelector(".thread-panel")).toBeTruthy();
  await act(async () => island.arrive(reply));
  await settle(3);
  // In <body> beside the panel, never in the page the panel makes inert behind it.
  const wrap = document.querySelector(".ni-wrap") as HTMLElement;
  expect(wrap.parentElement).toBe(document.body);
  expect(wrap.closest("[inert]")).toBeNull();
  await act(async () => fireEvent.click(within(wrap).getByRole("button", { name: "Ver" })));
  await settle(4);
  expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
  expect(r.router.state.location.search).toMatchObject({ m: "m-1" });
});

test("the island is centered on the window, not the work area beside the sidebar", async () => {
  const css = topLevel(await builtCss("src/styles.css", "src/components/notice-island.css"));
  const last = (selector: string, property: string) =>
    declarations(css, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];
  expect(last(".ni-wrap", "position")).toBe("fixed");
  expect(last(".ni-wrap", "left")).toBe("0");
  expect(last(".ni-wrap", "right")).toBe("0");
  expect(last(".ni-wrap", "justify-content")).toBe("center");
});
