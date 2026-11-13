import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ApiClient, Artifact } from "@agenteschat/client";
import { onlyItsConversation, toggledSharing } from "@agenteschat/client/lib/drive";
import { filePath, parseFileLink } from "@agenteschat/client/lib/message-links";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ATLAS_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

const copied: string[] = [];
beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (v: string) => void copied.push(v) },
  });
});
afterAll(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});
afterEach(() => {
  cleanup();
  copied.length = 0;
});

const click = (el: Element) => act(async () => fireEvent.click(el));
/** Opens a dropdown (Radix: keyboard) and picks an item. */
const pick = async (scope: HTMLElement, trigger: string | RegExp, item: string) => {
  const button = within(scope).getByRole("button", { name: trigger });
  button.focus();
  await act(async () => {
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
  await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: item }));
};

/** A report Atlas left in its DM with me, and a manual in the Drive, which the whole workspace sees. */
async function drive() {
  const state = seedState();
  state.dms.push({ channelId: "dm-atlas", with: { type: "agent", id: ATLAS_ID, name: "Atlas", handle: "atlas" } });
  const api = createFakeApi(state);
  const report = await api.artifacts.create(ORG_ID, {
    title: "Relatório de visitas",
    channelId: "dm-atlas",
    content: { kind: "document", markdown: "# Visitas" },
  });
  const manual = await api.artifacts.create(ORG_ID, {
    title: "Manual do time",
    content: { kind: "document", markdown: "# Manual" },
  });
  const r = await renderApp(`/org/${ORG_ID}/drive`, { api });
  await settle(8);
  return { ...r, api, state, report, manual };
}

/** The Drive's details of a file, then its "…" › an item. */
async function fromDetails(title: string, item: string) {
  await click(screen().getByRole("button", { name: title }));
  await settle(4);
  const panel = screen().getByRole("dialog", { name: title });
  await pick(panel, /^Mais ações: /, item);
  await settle(3);
  return panel;
}

const shareDialog = (title: string) => screen().getByRole("dialog", { name: `Compartilhar ${title}` });
const pressed = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.querySelector(".ac-option__title")?.textContent);

describe("Compartilhar (ADR 0157)", () => {
  test("a DM's file: only the conversation, said plainly beside Copiar link, which copies the app's address", async () => {
    const { report } = await drive();
    await fromDetails("Relatório de visitas", "Compartilhar");
    const dialog = shareDialog("Relatório de visitas");
    expect(pressed(dialog)).toEqual(["Só a conversa"]);
    // Who has access: the conversation, by name.
    expect(dialog.querySelector(".share__list")?.textContent).toBe("A DM com Atlas");
    expect(dialog.textContent).toContain("Quem não está nesta conversa não vai abrir o link.");
    expect(within(dialog).getByRole("button", { name: "Escolher pessoas" })).toBeTruthy();
    await click(within(dialog).getByRole("button", { name: "Copiar link" }));
    await settle(2);
    expect(copied).toEqual([`http://localhost:3000${filePath(ORG_ID, report.id)}`]);
    expect(copied[0]).not.toContain("/api/");
  });

  test("Todos no workspace: saved at once, with Desfazer; the warning goes", async () => {
    const { state, report } = await drive();
    await fromDetails("Relatório de visitas", "Compartilhar");
    const dialog = shareDialog("Relatório de visitas");
    await click(within(dialog).getByRole("button", { name: "Todos no workspace" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "artifacts.setSharing").map((c) => c.args.slice(1))).toEqual([
      [report.id, { mode: "everyone", userIds: [], roleIds: [] }],
    ]);
    expect(pressed(dialog)).toEqual(["Todos no workspace"]);
    expect(dialog.textContent).not.toContain("não vai abrir o link");
    expect(screen().getByText("Agora todos no workspace veem o arquivo.")).toBeTruthy();
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(4);
    expect(
      state.calls
        .filter((c) => c.method === "artifacts.setSharing")
        .at(-1)
        ?.args.slice(1),
    ).toEqual([report.id, { mode: "conversation", userIds: [], roleIds: [] }]);
  });

  test("people: Escolher pessoas opens the field; who's added shows with Tirar, and administrators always see", async () => {
    const { state, report } = await drive();
    await fromDetails("Relatório de visitas", "Compartilhar");
    const dialog = shareDialog("Relatório de visitas");
    await click(within(dialog).getByRole("button", { name: "Escolher pessoas" }));
    await settle(2);
    // Chosen, not saved yet: nobody is on the list.
    expect(pressed(dialog)).toEqual(["Pessoas e papéis que você escolher"]);
    expect(state.calls.some((c) => c.method === "artifacts.setSharing")).toBe(false);
    const add = within(dialog).getByRole("combobox", { name: "Adicionar pessoa ou papel" });
    add.focus();
    await act(async () => {
      fireEvent.keyDown(add, { key: "Enter" });
      fireEvent.keyUp(add, { key: "Enter" });
    });
    await settle(2);
    await click(screen().getByRole("option", { name: /João/ }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "artifacts.setSharing").map((c) => c.args.slice(1))).toEqual([
      [report.id, { mode: "people", userIds: ["u-joao"], roleIds: [] }],
    ]);
    expect(within(dialog).getByRole("button", { name: "Tirar João" })).toBeTruthy();
    expect(dialog.textContent).toContain("Administradores sempre veem.");
    await click(within(dialog).getByRole("button", { name: "Tirar João" }));
    await settle(4);
    // The list left empty is the conversation alone.
    expect(
      state.calls
        .filter((c) => c.method === "artifacts.setSharing")
        .at(-1)
        ?.args.slice(1),
    ).toEqual([report.id, { mode: "conversation", userIds: [], roleIds: [] }]);
  });

  test("a file the whole workspace sees: nothing to widen, its link copies as is", async () => {
    await drive();
    await fromDetails("Manual do time", "Compartilhar");
    const dialog = shareDialog("Manual do time");
    expect(dialog.textContent).toContain("Todos no workspace veem este arquivo.");
    expect(within(dialog).queryByRole("button", { name: "Só a conversa" })).toBeNull();
    expect(dialog.textContent).not.toContain("não vai abrir o link");
  });

  test("Copiar link of a file only its conversation sees opens the dialog; of an open one, copies the app's address", async () => {
    await drive();
    await fromDetails("Relatório de visitas", "Copiar link");
    expect(copied).toEqual([]);
    expect(shareDialog("Relatório de visitas").textContent).toContain("não vai abrir o link");
    cleanup();
    const again = await drive();
    await fromDetails("Manual do time", "Copiar link");
    expect(copied).toEqual([`http://localhost:3000${filePath(ORG_ID, again.manual.id)}`]);
  });

  test("the viewer's header has Compartilhar beside Baixar", async () => {
    const { report } = await drive();
    await click(screen().getByRole("button", { name: "Relatório de visitas" }));
    await settle(4);
    const panel = screen().getByRole("dialog", { name: "Relatório de visitas" });
    await click(
      within(panel)
        .getAllByRole("button", { name: "Abrir" })
        .find((b) => b.textContent?.trim() === "Abrir") as HTMLElement,
    );
    await settle(6);
    const viewer = screen().getByRole("dialog", { name: "Relatório de visitas" });
    const share = within(viewer).getByRole("button", { name: "Compartilhar" });
    const download = within(viewer).getByRole("button", { name: "Baixar" });
    expect(download.compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await click(share);
    await settle(3);
    expect(shareDialog("Relatório de visitas")).toBeTruthy();
    expect(report.id).toBeTruthy();
  });

  test("shared with me from a DM I'm not in: whose DM it is, no way into it, and the sharing isn't mine to change", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const report = await api.artifacts.create(ORG_ID, {
      title: "Relatório de visitas",
      channelId: GENERAL_ID,
      content: { kind: "document", markdown: "# Visitas" },
    });
    // As the server answers someone João's DM with Atlas was shared with (ADR 0157).
    const outsider = <T extends Artifact>(a: T): T =>
      a.id === report.id
        ? {
            ...a,
            channelId: "dm-joao-atlas",
            audience: {
              kind: "dm",
              with: null,
              between: [
                { type: "person", id: "u-joao" },
                { type: "agent", id: ATLAS_ID },
              ],
            },
            sharing: { mode: "people", userIds: ["u-walter"], roleIds: [] },
            canShare: false,
          }
        : a;
    const list = api.artifacts.list;
    api.artifacts.list = async (...args) => (await list(...args)).map(outsider);
    const page = api.artifacts.page;
    api.artifacts.page = async (...args) => {
      const got = await page(...args);
      return { ...got, artifacts: got.artifacts.map(outsider) };
    };
    const get = api.artifacts.get;
    api.artifacts.get = async (...args) => outsider(await get(...args));
    await renderApp(`/org/${ORG_ID}/drive`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Relatório de visitas" }));
    await settle(4);
    const panel = screen().getByRole("dialog", { name: "Relatório de visitas" });
    expect(panel.querySelector(".drive-audience")?.textContent).toBe(
      "Só João e Atlas podem ver: veio de uma mensagem direta. Também compartilhado com Walter.",
    );
    expect(panel.textContent).toContain("Mensagem direta entre João e Atlas");
    await pick(panel, /^Mais ações: /, "Compartilhar");
    const dialog = shareDialog("Relatório de visitas");
    expect([...dialog.querySelectorAll(".share__name")].map((n) => n.textContent)).toEqual([
      "A DM entre João e Atlas",
      "Walter (você)",
    ]);
    expect(dialog.textContent).toContain("Só quem está na conversa muda quem vê.");
    const options = [...dialog.querySelectorAll("button.ac-option")];
    expect(options.length).toBe(3);
    expect(options.every((b) => b.hasAttribute("disabled"))).toBe(true);
    await click(within(dialog).getByRole("button", { name: "Concluir" }));
    await settle(2);
    // Its "…" has no way into a DM I'm not in (neither mine with Atlas nor mine with João).
    const more = within(panel).getByRole("button", { name: /^Mais ações: / });
    more.focus();
    await act(async () => {
      fireEvent.keyDown(more, { key: "Enter" });
      fireEvent.keyUp(more, { key: "Enter" });
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const menu = screen().getByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Compartilhar" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Abrir a conversa" })).toBeNull();
  });
});

describe("a file's link pasted in a message", () => {
  test("the API's address and the app's both show as the file's pill, never the raw address", async () => {
    const state = seedState();
    const api: ApiClient = createFakeApi(state);
    const doc = (await api.artifacts.list(ORG_ID)).find((a) => a.kind === "document") as Artifact;
    // The server's ids are UUIDs (and only those parse as a file's link); the fake's aren't.
    const id = "00000000-0000-4000-8000-0000000000f2";
    const get = api.artifacts.get;
    api.artifacts.get = (orgId, wanted, version) => get(orgId, wanted === id ? doc.id : wanted, version);
    state.messages.push({
      id: "m-link",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: `olha http://localhost:3000/api/app/organizations/${ORG_ID}/artifacts/${id}/file?version=1&format=pdf`,
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {},
      createdAt: new Date().toISOString(),
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const pill = screen().getByRole("link", { name: `Arquivo ${doc.title}` });
    expect(pill.textContent).toBe(doc.title);
    expect(document.body.textContent).not.toContain("/api/app/organizations");
    await click(pill);
    await settle(6);
    expect(screen().getByRole("dialog", { name: doc.title })).toBeTruthy();
  });
});

describe("the link rules, as the apps share them", () => {
  test("parseFileLink reads the app's and the API's addresses of this server only", () => {
    const id = "00000000-0000-4000-8000-0000000000f1";
    const origins = ["http://localhost:3000"];
    expect(parseFileLink(`http://localhost:3000${filePath(ORG_ID, id, 3)}`, origins)).toEqual({
      orgId: ORG_ID,
      artifactId: id,
      version: 3,
    });
    expect(
      parseFileLink(
        `http://localhost:3000/api/app/organizations/${ORG_ID}/artifacts/${id}/file?version=2&format=pdf`,
        origins,
      ),
    ).toEqual({ orgId: ORG_ID, artifactId: id, version: 2 });
    expect(parseFileLink(`/api/app/organizations/${ORG_ID}/artifacts/${id}/file`)).toEqual({
      orgId: ORG_ID,
      artifactId: id,
      version: null,
    });
    expect(parseFileLink(`https://elsewhere.test${filePath(ORG_ID, id)}`, origins)).toBeNull();
    expect(parseFileLink(`http://localhost:3000/org/${ORG_ID}/drive`, origins)).toBeNull();
  });

  test("onlyItsConversation and toggledSharing", () => {
    const dm = { audience: { kind: "dm" as const, with: null } };
    expect(onlyItsConversation({ ...dm, sharing: { mode: "conversation", userIds: [], roleIds: [] } })).toBe(true);
    expect(onlyItsConversation({ ...dm, sharing: { mode: "people", userIds: ["u"], roleIds: [] } })).toBe(false);
    expect(onlyItsConversation({ audience: { kind: "workspace" } })).toBe(false);
    const one = toggledSharing(undefined, { kind: "user", id: "u" });
    expect(one).toEqual({ mode: "people", userIds: ["u"], roleIds: [] });
    expect(toggledSharing(toggledSharing(one, { kind: "role", id: "r" }), { kind: "user", id: "u" })).toEqual({
      mode: "people",
      userIds: [],
      roleIds: ["r"],
    });
    expect(toggledSharing(one, { kind: "user", id: "u" })).toEqual({ mode: "conversation", userIds: [], roleIds: [] });
  });
});
