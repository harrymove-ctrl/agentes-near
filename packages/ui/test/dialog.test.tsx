import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  InfoHint,
  Input,
  useUnsavedInDialog,
} from "../src";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Ajustar orçamento</Button>
      <Dialog open={open} onOpenChange={setOpen} title="Orçamento mensal" closeLabel="Fechar" width={440}>
        <Input aria-label="Limite mensal (US$)" defaultValue="40" />
        <DialogFooter>
          <Button onClick={() => setOpen(false)}>Cancelar</Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

const body = () => within(document.body);

describe("Dialog", () => {
  test("opens as a labelled modal and moves focus inside", async () => {
    render(<Harness />);
    const trigger = body().getByRole("button", { name: "Ajustar orçamento" });
    trigger.focus();
    await act(async () => fireEvent.click(trigger));
    const dialog = body().getByRole("dialog", { name: "Orçamento mensal" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Fechar" })).toBeTruthy();
  });

  test("opened with nothing pressed (from a link, by itself): the dialog holds the focus, not its close button", () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Conectar uma IA" closeLabel="Fechar">
        <Input aria-label="Chave" />
      </Dialog>,
    );
    const dialog = body().getByRole("dialog", { name: "Conectar uma IA" });
    expect(document.activeElement === dialog).toBe(true);
  });

  test("from the dialog itself, Shift+Tab goes round to its last control that takes the focus", async () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Conectar uma IA" closeLabel="Fechar">
        <Input aria-label="Chave" />
        <DialogFooter>
          <Button>Salvar chave</Button>
          <Button disabled>Remover</Button>
        </DialogFooter>
      </Dialog>,
    );
    const dialog = body().getByRole("dialog", { name: "Conectar uma IA" });
    await act(async () => fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true }));
    expect(document.activeElement === body().getByRole("button", { name: "Salvar chave" })).toBe(true);
  });

  test("a field that takes the focus on its own keeps it", () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Renomear" closeLabel="Fechar">
        <Input aria-label="Nome" autoFocus />
      </Dialog>,
    );
    expect(document.activeElement === body().getByRole("textbox", { name: "Nome" })).toBe(true);
  });

  test("Escape closes it and focus returns to the trigger", async () => {
    render(<Harness />);
    const trigger = body().getByRole("button", { name: "Ajustar orçamento" });
    trigger.focus();
    await act(async () => fireEvent.click(trigger));
    const dialog = body().getByRole("dialog");
    await act(async () => fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" }));
    // Radix restores focus on the next tick after unmounting the focus scope.
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(body().queryByRole("dialog")).toBeNull();
    expect(document.activeElement === trigger).toBe(true);
  });

  test("its head: the face on the title's line, its actions and close in one row of actions", () => {
    render(
      <Dialog
        open
        onOpenChange={() => {}}
        title="Computador da Ada"
        subtitle="Ao vivo"
        leading={<span className="ac-avatar">A</span>}
        actions={<Button size="sm">Assumir o controle</Button>}
        closeLabel="Fechar"
      >
        <p>Tela</p>
      </Dialog>,
    );
    const head = body().getByRole("dialog").querySelector(".ac-dialog__head") as HTMLElement;
    // The title and its actions share an action line, which puts them under it when they don't fit; the close stays
    // after it, on the title's line.
    expect([...head.children].map((c) => c.className)).toEqual([
      "ac-dialog__lead",
      "ac-actline",
      "ac-dialog__close ac-acts",
    ]);
    const line = head.querySelector(".ac-actline") as HTMLElement;
    expect([...line.children].map((c) => c.className)).toEqual(["ac-dialog__titles", "ac-dialog__acts ac-acts"]);
    expect(line.querySelector(".ac-dialog__acts")?.textContent).toBe("Assumir o controle");
    expect(head.querySelector(".ac-dialog__close")?.firstElementChild?.getAttribute("aria-label")).toBe("Fechar");
    expect(head.querySelector(".ac-dialog__lead > .ac-avatar")).not.toBeNull();
  });

  test("with no actions, the title alone in its line and the close after it", () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Conectar Banco de dados" closeLabel="Fechar">
        <p>Passos</p>
      </Dialog>,
    );
    const head = body().getByRole("dialog").querySelector(".ac-dialog__head") as HTMLElement;
    expect([...head.children].map((c) => c.className)).toEqual(["ac-actline", "ac-dialog__close ac-acts"]);
    expect(head.querySelector(".ac-dialog__acts")).toBeNull();
  });

  test("beside a title alone, its close sits on the title's capitals' middle (with a line under it, on the pair's)", async () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Conectar Banco de dados" closeLabel="Fechar">
        <p>Passos</p>
      </Dialog>,
    );
    const head = body().getByRole("dialog").querySelector(".ac-dialog__head") as HTMLElement;
    expect(head.querySelector(".ac-actline:has(> .ac-dialog__title) + .ac-dialog__close")).not.toBeNull();
    const css = (await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    // On the middle an app measured for its title's face, --cap-mid without one: the actions beside the title and
    // the close after its line.
    expect(css).toContain(
      "\n.ac-dialog__title + .ac-dialog__acts,\n.ac-actline:has(> .ac-dialog__title) + .ac-dialog__close {\n  translate: 0 calc(-1 * var(--title-cap-mid, var(--cap-mid)));\n}",
    );
    // A title alone is as tall as the buttons beside it, so actions that went under it stand clear of its words.
    expect(css).toContain(
      "\n.ac-actline > .ac-dialog__title {\n  padding-block: calc((var(--control-h-sm) - 24px) / 2);\n}",
    );
    expect(css).toContain("\n.ac-dialog__head {\n  display: flex;\n  align-items: flex-start;");
    // Nothing else moves the row: a transform beside the translate would be merged away by the build.
    const moved = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter(
      ([, selector, rule]) => /ac-dialog__acts(?![\w-])/.test(selector ?? "") && /transform/.test(rule ?? ""),
    );
    expect(moved).toEqual([]);
  });

  test("the close button closes it", async () => {
    render(<Harness />);
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Ajustar orçamento" })));
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Fechar" })));
    expect(body().queryByRole("dialog")).toBeNull();
  });

  test("one opened from another comes after it in the page: scrim, panel, then its own scrim and panel", async () => {
    function Nested() {
      const [inner, setInner] = useState(false);
      return (
        <Dialog open onOpenChange={() => {}} title="Adicionar conector" closeLabel="Fechar">
          <Button onClick={() => setInner(true)}>GitHub</Button>
          <Dialog open={inner} onOpenChange={setInner} title="GitHub" closeLabel="Fechar" width={440}>
            <p>Código, PRs, issues e Actions.</p>
          </Dialog>
        </Dialog>
      );
    }
    render(<Nested />);
    await act(async () => fireEvent.click(body().getByRole("button", { name: "GitHub" })));
    // Scrims and panels share one layer (layers.css), so this order alone keeps each scrim under its own panel.
    const order = [...document.body.querySelectorAll(".ac-dialog__scrim, .ac-dialog")].map((el) =>
      el.classList.contains("ac-dialog__scrim") ? "scrim" : el.querySelector(".ac-dialog__title")?.textContent,
    );
    expect(order).toEqual(["scrim", "Adicionar conector", "scrim", "GitHub"]);
  });

  test("one opened over another starts on its initialFocus field", async () => {
    function Nested() {
      const [inner, setInner] = useState(false);
      const name = useRef<HTMLInputElement>(null);
      return (
        <Dialog open onOpenChange={() => {}} title="Criar canal" closeLabel="Fechar">
          <Button onClick={() => setInner(true)}>Nova categoria</Button>
          <Dialog open={inner} onOpenChange={setInner} title="Nova categoria" closeLabel="Fechar" initialFocus={name}>
            <Input ref={name} aria-label="Nome" />
          </Dialog>
        </Dialog>
      );
    }
    render(<Nested />);
    const open = body().getByRole("button", { name: "Nova categoria" });
    open.focus();
    await act(async () => fireEvent.click(open));
    expect(document.activeElement === body().getByRole("textbox", { name: "Nome" })).toBe(true);
  });

  test("an ⓘ at the end of the description's line stays out of it: the dialog is described by the sentence alone", () => {
    render(
      <Dialog
        open
        onOpenChange={() => {}}
        title="Entre no Claude pelo navegador"
        description="Entre com a conta que quer adicionar."
        descriptionAside={<InfoHint name="Sobre a conta errada">Saia do Claude lá e tente de novo.</InfoHint>}
        closeLabel="Fechar"
      >
        <DialogBody>Esperando você entrar…</DialogBody>
      </Dialog>,
    );
    const dialog = body().getByRole("dialog", { description: "Entre com a conta que quer adicionar." });
    const info = within(dialog).getByRole("button", { name: "Sobre a conta errada" });
    // Outside the description element, since a browser reads a button's name inside it as part of the description
    // (the test library's own description leaves it out, so it can't tell), but on the sentence's line, after it.
    const description = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("Entre com a conta que quer adicionar.");
    expect(description?.contains(info)).toBe(false);
    expect(info.closest(".ac-dialog__desc")?.textContent).toStartWith("Entre com a conta que quer adicionar.");
  });

  test("a toast over it takes its own clicks, even one that removes it; a press on the scrim still closes it", async () => {
    let closes = 0;
    render(
      <>
        <div className="ac-toasts">
          <div className="ac-toast">
            Salvo <button type="button">Dispensar</button>
          </div>
        </div>
        <Dialog open onOpenChange={() => closes++} title="Orçamento mensal" closeLabel="Fechar">
          <Input aria-label="Limite mensal (US$)" defaultValue="40" />
        </Dialog>
      </>,
    );
    // Radix listens for presses outside a tick after it opens.
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const toast = document.querySelector(".ac-toast") as HTMLElement;
    const dismiss = toast.querySelector("button") as HTMLButtonElement;
    // As in a browser once the toast's own click handler ran: the toast is gone before the click reaches the page.
    toast.parentElement?.addEventListener("click", () => toast.remove());
    await act(async () => {
      fireEvent.pointerDown(dismiss);
      fireEvent.click(dismiss);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(toast.isConnected).toBe(false);
    expect(closes).toBe(0);
    const scrim = document.querySelector(".ac-dialog__scrim") as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(scrim);
      fireEvent.click(scrim);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(closes).toBe(1);
    // A modal dialog turns the page's pointer events off; a toast turns its own back on.
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    expect(css.split("\n.ac-toast {")[1]?.split("}")[0]).toContain("pointer-events: auto");
  });

  test("holding unsaved writing, a press on the scrim or Esc leaves it open; its close button still closes it", async () => {
    let closes = 0;
    render(
      <Dialog open onOpenChange={() => closes++} title="Nova tarefa" closeLabel="Fechar" unsaved>
        <Input aria-label="Título" defaultValue="Fechar a folha" />
      </Dialog>,
    );
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const scrim = document.querySelector(".ac-dialog__scrim") as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(scrim);
      fireEvent.click(scrim);
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => fireEvent.keyDown(body().getByRole("textbox", { name: "Título" }), { key: "Escape" }));
    expect(closes).toBe(0);
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Fechar" })));
    expect(closes).toBe(1);
  });

  test("a form inside it with unsaved writing (a step of a flow) keeps it open the same way, until it's gone", async () => {
    let closes = 0;
    function Step({ unsaved }: { unsaved: boolean }) {
      useUnsavedInDialog(unsaved);
      return <Input aria-label="Senha" />;
    }
    const at = (unsaved: boolean) => (
      <Dialog open onOpenChange={() => closes++} title="Conectar o banco" closeLabel="Fechar">
        <Step unsaved={unsaved} />
      </Dialog>
    );
    const { rerender } = render(at(true));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await act(async () => fireEvent.keyDown(body().getByRole("textbox", { name: "Senha" }), { key: "Escape" }));
    expect(closes).toBe(0);
    rerender(at(false));
    await act(async () => fireEvent.keyDown(body().getByRole("textbox", { name: "Senha" }), { key: "Escape" }));
    expect(closes).toBe(1);
  });

  test("searchable list variant filters and shows the empty message", async () => {
    const items = ["Ler código e issues", "Abrir e comentar PRs", "Fazer merge"];
    function Search() {
      const [q, setQ] = useState("");
      const shown = items.filter((i) => i.toLowerCase().includes(q.toLowerCase()));
      return (
        <Dialog open onOpenChange={() => {}} title="Permissões da Ada" closeLabel="Fechar">
          <DialogSearchList
            query={q}
            onQueryChange={setQ}
            searchLabel="Buscar permissões"
            emptyText={`Nada encontrado com “${q}”.`}
            isEmpty={shown.length === 0}
          >
            <ul>
              {shown.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </DialogSearchList>
        </Dialog>
      );
    }
    render(<Search />);
    const search = body().getByRole("searchbox", { name: "Buscar permissões" });
    expect(body().getAllByRole("listitem")).toHaveLength(3);
    await act(async () => fireEvent.change(search, { target: { value: "merge" } }));
    expect(
      body()
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Fazer merge"]);
    await act(async () => fireEvent.change(search, { target: { value: "deploy" } }));
    expect(body().queryAllByRole("listitem")).toHaveLength(0);
    expect(body().getByText("Nada encontrado com “deploy”.")).toBeTruthy();
  });
});

describe("Dialog without a footer", () => {
  test("its body is the last thing in it, and then keeps the dialog's own edge under its last item", async () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Conectar uma IA" closeLabel="Fechar" width={480}>
        <DialogBody>
          <Button>Chave de API</Button>
        </DialogBody>
      </Dialog>,
    );
    const dialog = body().getByRole("dialog", { name: "Conectar uma IA" });
    expect(dialog.lastElementChild?.classList.contains("ac-dialog__body")).toBe(true);
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    expect(css).toMatch(
      /\n:is\(\.ac-dialog__body, \.ac-dialog__list\):last-child:not\(\.ac-locked:not\(:last-child\) > \*\) \{\s*padding-bottom: var\(--dialog-pad\);/,
    );
  });

  test("a footer's note and its buttons are an action line: the buttons one group, never split one over the other", async () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Conectar servidor MCP" closeLabel="Fechar">
        <DialogBody>
          <p>Endereço</p>
        </DialogBody>
        <DialogFooter bar note="Ao conectar, todos os agentes podem usar. Você muda isso no passo 3.">
          <Button>Cancelar</Button>
          <Button variant="primary">Conectar</Button>
        </DialogFooter>
      </Dialog>,
    );
    const foot = body().getByRole("dialog").querySelector(".ac-dialog__foot") as HTMLElement;
    expect([...foot.children].map((c) => c.className)).toEqual(["ac-dialog__foot-note", "ac-dialog__foot-acts"]);
    expect([...(foot.lastElementChild?.children ?? [])].map((b) => b.textContent)).toEqual(["Cancelar", "Conectar"]);
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    // Beside the note while it keeps one line, else on a row of their own under it, at the footer's end, 8 apart.
    expect(rule(".ac-dialog__foot-note")).toContain("flex: 1 1 auto;");
    expect(rule(".ac-dialog__foot-acts")).toContain("flex: none;");
    expect(rule(".ac-dialog__foot-acts")).toContain("gap: var(--space-2);");
    expect(css).toMatch(/\n\.ac-dialog__foot \{[^}]*justify-content: flex-end;/);
    expect(rule(".ac-dialog__foot:has(> .ac-dialog__foot-acts)")).toContain("column-gap: var(--space-4);");
  });

  test("an empty footer renders nothing, so a list above it ends on the dialog's own edge", () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Membros" closeLabel="Fechar">
        <DialogSearchList query="" onQueryChange={() => {}} searchLabel="Buscar" emptyText="Nada" isEmpty={false}>
          <p>Ada</p>
        </DialogSearchList>
        <DialogFooter note={undefined} />
        <DialogFooter>{false}</DialogFooter>
        <DialogFooter>{[false, null]}</DialogFooter>
      </Dialog>,
    );
    const dialog = body().getByRole("dialog", { name: "Membros" });
    expect(dialog.querySelector(".ac-dialog__foot")).toBeNull();
    expect(dialog.lastElementChild?.classList.contains("ac-dialog__list")).toBe(true);
  });
});
