import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { keys } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const box = () => screen().getByRole("combobox", { name: "Buscar" }) as HTMLInputElement;
const typeIn = async (value: string) => {
  await act(async () => fireEvent.change(box(), { target: { value } }));
  // The search runs a beat after the last key.
  await act(() => new Promise((r) => setTimeout(r, 300)));
  await settle(4);
};
const lastSearch = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "search.query").at(-1)?.args[1] as {
    q: string;
    kinds: string[];
    filters?: Record<string, unknown>;
  };
const text = () => document.body.textContent ?? "";

describe("search filters (ADR 0123)", () => {
  test("typing de: opens the people and agents picker; a pick is a chip, results are by channel and open at the message", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const { router } = await renderApp(`/org/${ORG_ID}/search`, { api });
    await settle(4);
    await act(async () => fireEvent.focus(box()));
    // The empty box offers the filters, in the person's language.
    expect(screen().getByRole("option", { name: /de: De uma pessoa ou agente/ })).toBeTruthy();

    await typeIn("de:ad");
    const ada = screen().getByRole("option", { name: /Ada/ });
    await act(async () => fireEvent.click(ada));
    await act(() => new Promise((r) => setTimeout(r, 300)));
    await settle(4);
    expect(screen().getByRole("button", { name: "Remover de: Ada" })).toBeTruthy();
    expect(box().value).toBe("");
    expect(lastSearch(state)).toEqual({
      q: "",
      kinds: ["message"],
      limit: 100,
      filters: { fromAgents: [ADA_ID], sort: "newest" },
    } as never);
    expect(text()).toContain("#eng");
    expect(text()).toContain("Achei a causa");
    expect(text()).not.toContain("o login está devolvendo 401");

    // English operators work too, turned into chips by a space; Enter remembers the search.
    await typeIn("in:eng ");
    expect(screen().getByRole("button", { name: "Remover em: #eng" })).toBeTruthy();
    expect(lastSearch(state).filters).toEqual({ fromAgents: [ADA_ID], in: [ENG_ID], sort: "newest" });
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));

    const hit = screen().getByRole("link", { name: /Achei a causa/ });
    await act(async () => fireEvent.click(hit));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(router.state.location.search).toEqual({ m: "m-2" });
  });

  test("opened from a conversation it starts scoped to it; recent searches come back and clear", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await renderApp(`/org/${ORG_ID}/search?in=${ENG_ID}`, { api });
    await settle(6);
    expect(screen().getByRole("button", { name: "Remover em: #eng" })).toBeTruthy();
    await typeIn("deploy");
    expect(lastSearch(state)).toEqual({
      q: "deploy",
      kinds: ["message"],
      limit: 100,
      filters: { in: [ENG_ID], sort: "relevance" },
    } as never);
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
    // Emptied, the box lists it under the recent searches; picking it searches it again.
    await act(async () => fireEvent.keyDown(box(), { key: "Backspace" }));
    await typeIn("");
    await act(async () => fireEvent.focus(box()));
    const recent = screen().getByRole("option", { name: "in:eng deploy" });
    await act(async () => fireEvent.click(recent));
    await settle(4);
    expect(box().value).toBe("deploy");
    expect(screen().getByRole("button", { name: "Remover em: #eng" })).toBeTruthy();

    await typeIn("");
    await act(async () => fireEvent.keyDown(box(), { key: "Backspace" }));
    await act(async () => fireEvent.focus(box()));
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Limpar" })));
    expect(screen().queryByRole("option", { name: "in:eng deploy" })).toBeNull();
  });

  test("a DM's message opens in the DM and a thread reply in its thread, each at the message", async () => {
    const state = seedState();
    state.dms.push({ channelId: "dm-ada", with: { type: "agent", id: ADA_ID, name: "Ada", handle: "ada" } });
    state.channelMembers["dm-ada"] = [
      { type: "person", id: state.me?.user.id ?? "" },
      { type: "agent", id: ADA_ID },
    ];
    const at = new Date().toISOString();
    state.messages.push(
      {
        id: "m-dm",
        channelId: "dm-ada",
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body: "zebra no privado",
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: at,
      },
      {
        id: "m-reply",
        channelId: ENG_ID,
        threadId: "m-1",
        author: { type: "agent", id: ADA_ID },
        body: "zebra na resposta",
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: at,
      },
    );
    const api = createFakeApi(state);
    const { router } = await renderApp(`/org/${ORG_ID}/search?in=dm-ada`, { api });
    await settle(6);
    await typeIn("zebra");
    expect(screen().queryByText("zebra na resposta")).toBeNull();
    await act(async () => fireEvent.click(screen().getByRole("link", { name: /zebra no privado/ })));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
    expect(router.state.location.search).toEqual({ m: "m-dm" });
    expect(text()).not.toContain("Este canal não existe");
    expect(text()).toContain("zebra no privado");

    await act(() => router.navigate({ to: "/org/$orgId/search", params: { orgId: ORG_ID } }));
    await settle(6);
    await typeIn("zebra");
    await act(async () => fireEvent.click(screen().getByRole("link", { name: /zebra na resposta/ })));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/threads/m-1`);
    expect(router.state.location.search).toEqual({ m: "m-reply" });
  });

  test("a removed scope chip stays removed when the channel list refetches", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const { services } = await renderApp(`/org/${ORG_ID}/search?in=${ENG_ID}`, { api });
    await settle(6);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Remover em: #eng" })));
    // A new message anywhere rewrites the channel list (a new array).
    await act(async () =>
      services.queryClient.setQueryData(keys.channels(ORG_ID), (cs: { topic: string }[] | undefined) =>
        cs?.map((c) => ({ ...c, topic: `${c.topic} ` })),
      ),
    );
    await settle(6);
    expect(screen().queryByRole("button", { name: "Remover em: #eng" })).toBeNull();
  });

  test("the empty box's filters and recent searches are picked from the keyboard", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await renderApp(`/org/${ORG_ID}/search`, { api });
    await settle(4);
    await act(async () => fireEvent.focus(box()));
    // Enter with nothing highlighted just searches.
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
    expect(box().value).toBe("");
    await act(async () => fireEvent.focus(box()));
    await act(async () => fireEvent.keyDown(box(), { key: "ArrowDown" }));
    expect(box().getAttribute("aria-activedescendant")).toBeTruthy();
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
    expect(box().value).toBe("de:");
  });
});
