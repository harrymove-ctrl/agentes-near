import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const ids = { threadId: null, runId: "r-live", agentId: ADA_ID };

const open = async () => {
  const state = seedState();
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  const ev = (event: Record<string, unknown>) =>
    act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
  return { state, ev };
};
const started = (ev: (event: Record<string, unknown>) => Promise<void>) =>
  ev({ type: "agent.run", ...ids, status: "running", startedAt: new Date(Date.now() - 13_000).toISOString() });
/** At work for a while already, on a step. */
const thinking = async (ev: (event: Record<string, unknown>) => Promise<void>) => {
  await started(ev);
  await ev({ type: "agent.tool", ...ids, tool: "read_file", toolUseId: "t1", detail: "apps/api/auth/refresh.ts" });
  await settle(3);
};
/** At work for a while already, writing its reply (an older server's delta carries some of it). */
const writing = async (ev: (event: Record<string, unknown>) => Promise<void>) => {
  await started(ev);
  await ev({ type: "agent.typing", ...ids });
  await ev({ type: "agent.delta", ...ids, seq: 0, text: "O refresh expira cedo." });
  await settle(3);
};
const bar = () => document.querySelector(".ac-typing") as HTMLElement;
const row = () => document.querySelector('[data-run-id="r-live"]') as HTMLElement | null;
const typing = (ev: (event: Record<string, unknown>) => Promise<void>) =>
  ev({ type: "user.typing", userId: "u-joao", threadId: null, ttlMs: 6000 });
const cancels = (state: ReturnType<typeof seedState>) => state.calls.filter((c) => c.method === "agents.cancelRun");

describe("while it works the bar alone says it: no row in the conversation, writing or not", () => {
  test("on a step: the bar says what it does, its time and its stop; nothing in the conversation", async () => {
    const { state, ev } = await open();
    await thinking(ev);
    await act(() => new Promise((r) => setTimeout(r, 2100)));
    await settle(2);
    expect(row()).toBeNull();
    expect(document.querySelector(".ac-msg--waiting")).toBeNull();
    expect(bar().dataset.active).toBe("true");
    expect(bar().querySelector(".ac-typing__avatars .ac-avatar--agent")).not.toBeNull();
    expect(bar().querySelector(".ac-typing__text")?.textContent).toBe("Ada mexendo nos arquivos do PC · refresh.ts…");
    expect(bar().querySelector(".ac-typing__step")?.getAttribute("title")).toBe(
      "mexendo nos arquivos do PC · refresh.ts…",
    );
    expect(bar().querySelector(".ac-typing__elapsed")?.textContent).toMatch(/^1\d s$/);
    // Nothing to go back to.
    expect(within(bar()).queryByRole("button", { name: "Ver" })).toBeNull();
    await act(async () => fireEvent.click(within(bar()).getByRole("button", { name: "Parar" })));
    await settle(2);
    expect(cancels(state)).toHaveLength(1);
  });

  test("writing: still no row and none of its words; the bar says it writes, its time and its stop", async () => {
    const { state, ev } = await open();
    await writing(ev);
    expect(row()).toBeNull();
    expect(document.body.textContent).not.toContain("O refresh expira cedo.");
    expect(bar().dataset.active).toBe("true");
    expect(bar().querySelector(".ac-typing__text")?.textContent).toBe("Ada escrevendo…");
    expect(bar().querySelector(".ac-typing__elapsed")?.textContent).toMatch(/^1\d s$/);
    await act(async () => fireEvent.click(within(bar()).getByRole("button", { name: "Parar" })));
    await settle(2);
    expect(cancels(state)).toHaveLength(1);
  });

  test("someone typing beside it: 'Ada mexendo… · 13 s · João digitando…', the time and the stop hers", async () => {
    const { ev } = await open();
    await thinking(ev);
    await typing(ev);
    await settle(2);
    expect(bar().querySelector(".ac-typing__text")?.textContent).toBe("Ada mexendo nos arquivos do PC · refresh.ts…");
    const took = bar().querySelector(".ac-typing__elapsed") as HTMLElement;
    expect(took.textContent).toMatch(/^1\d s$/);
    const also = took.nextElementSibling as HTMLElement;
    expect(also.classList.contains("ac-typing__also")).toBe(true);
    expect(also.textContent).toBe("João digitando…");
    expect(also.querySelector(".ac-typing__typers")?.textContent).toBe("João");
    // Both faces, and the stop at its end.
    expect(bar().querySelectorAll(".ac-typing__tok")).toHaveLength(2);
    expect(bar().lastElementChild?.querySelector(".stop-run")).not.toBeNull();
  });
});

test("the composer's own stop is there too while the bar speaks", async () => {
  const { ev } = await open();
  await writing(ev);
  expect(bar().dataset.active).toBe("true");
  expect(screen().getByRole("button", { name: "Parar a Ada" })).toBeTruthy();
});
