import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentAction } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const FILE = "019a1b74-5b85-74a8-9ffa-f9a6ace806d8";
const TASK = "019a1b74-5b85-74a8-9ffa-000000000131";
const OTHER = "019a1b74-5b85-74a8-9ffa-0000000000ff";
const SAID = "00000000-0000-4000-8000-0000000000f1";

/** The fake server knows the print and task #131 by their ids; `OTHER` names nothing. */
function withRefs() {
  const state = seedState();
  state.idRefs = {
    [FILE]: {
      kind: "file",
      id: FILE,
      title: "print.png",
      artifactKind: "file",
      fileName: "print.png",
      contentType: "image/png",
    },
    [TASK]: { kind: "task", id: TASK, number: 131, title: "Widget flutuante" },
  };
  return state;
}

/** Ada's message in #general saying `body`, with `actions` under it. */
function said(state: ReturnType<typeof seedState>, body: string, actions?: AgentAction[]) {
  state.messages.push({
    id: SAID,
    channelId: GENERAL_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body,
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date().toISOString(),
    ...(actions ? { actions } : {}),
  });
  return state;
}

const row = () => document.querySelector(`[data-message-id="${SAID}"]`) as HTMLElement;

describe("an internal id in a text is the pill of what it names", () => {
  test("in a message: a file's id is its name, a task's is #131 and its title, one that names nothing stays", async () => {
    const state = said(
      withRefs(),
      `Na referência (print anexado na conversa, artifact ${FILE}) e na tarefa id=${TASK}. O pedido ${OTHER} é do cliente.`,
    );
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const file = within(row()).getByRole("link", { name: "Arquivo print.png" });
    expect(file.textContent).toBe("print.png");
    const task = within(row()).getByRole("link", { name: "#131 Widget flutuante" });
    expect(task.getAttribute("href")).toBe(`/org/${ORG_ID}/issues/131`);
    const text = row().textContent ?? "";
    expect(text).not.toContain(FILE);
    expect(text).not.toContain(TASK);
    expect(text).not.toContain("artifact");
    expect(text).toContain(`O pedido ${OTHER} é do cliente.`);
  });

  test("alone in a code span too, as agents write ids; one that names nothing stays code", async () => {
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, {
      api: createFakeApi(said(withRefs(), `O print \`${FILE}\` e o pedido \`${OTHER}\`.`)),
    });
    await settle(8);
    expect(within(row()).getByRole("link", { name: "Arquivo print.png" }).textContent).toBe("print.png");
    expect(row().textContent).not.toContain(FILE);
    expect(row().querySelector("code")?.textContent).toBe(OTHER);
  });

  test("while it loads, a quiet pill stands in: the id never shows on its way", async () => {
    const api = createFakeApi(said(withRefs(), `Na referência (artifact ${FILE}).`));
    api.chat.idRef = () => new Promise(() => {});
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api });
    await settle(6);
    expect(row().querySelector('.id-ref[aria-busy="true"]')).not.toBeNull();
    expect(row().textContent).not.toContain(FILE);
  });

  test("in a task's description too", async () => {
    const api = createFakeApi(withRefs());
    const t = await api.issues.get(ORG_ID, 131);
    await api.issues.update(ORG_ID, t.id, {
      description: `Na referência (artifact ${FILE}): uma barra presa na borda.`,
    });
    await renderApp(`/org/${ORG_ID}/issues/131`, { api });
    await settle(8);
    const description = document.querySelector(".issue-description") ?? document.body;
    expect(within(description as HTMLElement).getByRole("link", { name: "Arquivo print.png" })).not.toBeNull();
    expect(description.textContent).not.toContain(FILE);
  });
});

describe("the receipt of a task an agent made with a file", () => {
  test("says the file went with it on a line of its own, and nothing says who sees the task", async () => {
    const at = new Date().toISOString();
    const state = said(withRefs(), "Pus no backlog como tarefa #131.", [
      {
        id: "act-1",
        kind: "issue.created",
        agentId: ADA_ID,
        messageId: SAID,
        requestedByUserId: null,
        target: { type: "issue", id: TASK, number: 131, title: "Widget flutuante" },
        params: { number: 131, title: "Widget flutuante", audience: "everyone", files: ["print.png"] },
        createdAt: at,
        undoableUntil: new Date(Date.now() + 120_000).toISOString(),
        undoneAt: null,
        undoneByUserId: null,
        redoneAt: null,
      },
    ]);
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const receipt = row().querySelector(".ag-rcs") as HTMLElement;
    expect([...receipt.querySelectorAll(".ag-rc__line")].map((l) => l.textContent)).toEqual([
      "Criei a tarefa #131 · Widget flutuante",
      "Anexei print.png",
    ]);
    expect(receipt.textContent).not.toContain("Quem vê");
  });
});

describe("a task's Anexos", () => {
  const openFiles = async () => {
    await act(async () => fireEvent.mouseDown(screen().getByRole("tab", { name: /Anexos/ }), { button: 0 }));
    await settle(4);
    return document.querySelector(".issue-files") as HTMLElement;
  };

  test("with none: one empty state with one button, no switcher and no tile", async () => {
    await renderApp(`/org/${ORG_ID}/issues/131`, { api: createFakeApi(seedState()) });
    await settle(6);
    const files = await openFiles();
    expect(within(files).getAllByRole("button", { name: "Adicionar arquivos" })).toHaveLength(1);
    expect(files.querySelector(".ac-empty__title")?.textContent).toBe("Os arquivos da tarefa ficam aqui");
    expect(files.querySelector(".ac-empty__text")?.textContent).toBe(
      "Arraste arquivos para cá, cole um print ou mande na conversa da tarefa.",
    );
    expect(within(files).queryByRole("radiogroup")).toBeNull();
    expect(files.querySelector(".issue-files__add")).toBeNull();
  });

  test("the new task's full form has one way to add files too", async () => {
    await renderApp(`/org/${ORG_ID}/issues`, { api: createFakeApi(seedState()) });
    await settle(6);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Nova tarefa" })));
    const dialog = screen().getByRole("dialog", { name: "Nova tarefa" });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Abrir o formulário completo" })));
    const files = within(dialog).getByRole("region", { name: "Anexos" });
    expect(within(files).getAllByRole("button", { name: /Adicionar arquivos/ })).toHaveLength(1);
  });

  test("with files: the switcher, one Adicionar arquivos, and each file", async () => {
    const api = createFakeApi(seedState());
    const t = await api.issues.get(ORG_ID, 131);
    await api.issues.comment(ORG_ID, t.id, "", ["print.png"]);
    await renderApp(`/org/${ORG_ID}/issues/131`, { api });
    await settle(6);
    const files = await openFiles();
    expect(within(files).getAllByRole("button", { name: "Adicionar arquivos" })).toHaveLength(1);
    expect(within(files).getByRole("radiogroup")).not.toBeNull();
    expect(within(files).getByRole("button", { name: "Abrir print.png" })).not.toBeNull();
    expect(files.querySelector(".ac-empty")).toBeNull();
  });
});
