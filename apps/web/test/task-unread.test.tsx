import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { ISSUES_VIEW_DEFAULT } from "@agenteschat/client/lib/issues-view";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { builtCss, declarations, topLevel } from "./built-css";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

/** Task #131 with a conversation where João mentioned me; the server counts it unread until I read the thread. */
async function mentioned(state = seedState()) {
  const api = createFakeApi(state);
  const issue = await api.issues.get(ORG_ID, 131);
  const at = await api.issues.conversation(ORG_ID, issue.id);
  state.messages.push({
    id: "k1",
    channelId: at.channelId,
    threadId: at.rootId,
    author: { type: "person", id: "u-joao" },
    body: "@walter consegue aprovar o texto hoje?",
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date().toISOString(),
  } as Message);
  state.unreadTasks = [{ issueId: issue.id, unread: 1, mentions: 1 }];
  const marked: string[] = [];
  const reads = api.reads;
  if (reads)
    reads.markThreadRead = async (_orgId, threadId) => {
      marked.push(threadId);
      state.unreadTasks = [];
    };
  return { api, state, issue, at, marked };
}

const tasksRow = () => document.querySelector<HTMLElement>(".sidebar__item[href$='/issues']") as HTMLElement;
const mentionsIn = (el: Element | null) => el?.querySelector('[aria-label="1 menção a você"]')?.textContent ?? null;

describe("mentions of me in a task's conversation (ADR 0145)", () => {
  test("Tarefas in the sidebar, the task's card and its row in the list carry the red count", async () => {
    const state = seedState();
    const { api } = await mentioned(state);
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(8);
    expect(mentionsIn(tasksRow())).toBe("1");
    // Beside the conversation's count, among the card's facts.
    expect(mentionsIn(document.querySelector('[data-card="131"] .issue-card__facts'))).toBe("1");
    expect(mentionsIn(document.querySelector('[data-card="132"]'))).toBeNull();
    cleanup();

    state.issuesView = { ...structuredClone(ISSUES_VIEW_DEFAULT), layout: "list" };
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(8);
    expect(mentionsIn(document.querySelector('.issue-list__row[data-card="131"] .issue-card__facts'))).toBe("1");
  });

  test("a plain reply I haven't read in a task's conversation makes Tarefas bold, as a channel, with no red count", async () => {
    const state = seedState();
    const { api } = await mentioned(state);
    const [first] = state.unreadTasks ?? [];
    state.unreadTasks = first ? [{ ...first, mentions: 0 }] : [];
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(8);
    expect(tasksRow().dataset.unread).toBe("true");
    expect(mentionsIn(tasksRow())).toBeNull();
    cleanup();

    state.unreadTasks = [];
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(8);
    expect(tasksRow().dataset.unread).toBe("false");
  });

  test("Conversa on the task's page lights up with it; read there, every mark goes", async () => {
    const { api, at, marked } = await mentioned();
    await renderApp(`/org/${ORG_ID}/issues/131`, { api });
    await settle(8);
    const toggle = document.querySelector<HTMLElement>(".task-talk__toggle") as HTMLElement;
    expect(toggle.dataset.unread).toBe("true");
    expect(mentionsIn(toggle)).toBe("1");

    await act(async () => fireEvent.click(toggle));
    await settle(10);
    // The conversation is the side panel threads use, over a scrim, not a card inside the page.
    const pane = document.querySelector(".issue-page__talk");
    expect(pane?.classList.contains("thread-panel")).toBe(true);
    expect(pane?.previousElementSibling?.classList.contains("thread-panel__scrim")).toBe(true);
    expect(marked).toContain(at.rootId);
    await settle(6);
    expect(mentionsIn(tasksRow())).toBeNull();
    expect(document.querySelector(".task-talk__toggle")?.hasAttribute("data-unread")).toBe(false);
  });
});

test("what ships floats every side pane 10px in from the window's top, right and bottom, rounded", async () => {
  const css = topLevel(await builtCss("src/styles.css", "src/components/threads/threads.css", "src/pages/issues.css"));
  const last = (selector: string, property: string) =>
    declarations(css, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];
  expect(last(".thread-panel", "position")).toBe("fixed");
  for (const edge of ["top", "right", "bottom"]) expect(last(".thread-panel", edge)).toBe("10px");
  expect(last(".thread-panel", "border-radius")).toBe("var(--radius-section)");
  // The task's page has no layout of its own for its conversation any more.
  expect(css).not.toContain(".issue-page--talk");
});

test("an unread reply visibly changes Conversa: a ghost button is already 600 in the muted color", async () => {
  const css = topLevel(await builtCss("src/styles.css", "src/pages/issues.css"));
  const last = (selector: string, property: string) =>
    declarations(css, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];
  expect(last(".ac-btn--ghost", "color")).toBe("var(--muted)");
  expect(last(".task-talk__toggle[data-unread]", "color")).toBe("var(--ink)");
  expect(Number(last(".task-talk__toggle[data-unread]", "font-weight"))).toBeGreaterThan(
    Number(last(".ac-btn", "font-weight")),
  );
});
