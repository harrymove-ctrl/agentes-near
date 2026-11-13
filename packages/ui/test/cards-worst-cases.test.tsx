import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, render, within } from "@testing-library/react";
import { Button, Card, CardHeader, DetailsDialog, Dialog, DialogBody, DialogFooter, FactStrip } from "../src";

afterEach(cleanup);

const body = () => within(document.body);

/**
 * The worst realistic data through the heads that keep words beside their actions: CI's geometry check lays these
 * screens out at 1280, 320 and 390 (the capture preload saves them), so a head that squeezes its title fails there.
 */
test("an event pill's line is the control's 32: 7 over and under its 18px line, one hairline on its left edge", async () => {
  const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
  const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
  expect(rule(".ac-eventpill__main")).toContain("padding: 7px 12px");
  expect(rule(".ac-eventpill__frame")).toContain("line-height: 18px");
  expect(rule(".ac-eventpill__frame")).toContain("min-height: var(--control-h-sm)");
  // Actions that went under the sentence start on the frame's edge: their first hairline, 1px out, is cut there.
  expect(rule(".ac-eventpill__frame")).toContain("overflow: hidden;");
  expect(rule(".ac-eventpill__actions")).toContain("margin-left: -1px;");
  expect(rule(".ac-eventpill__action")).toContain("border-left: 1px solid var(--line);");
  // The frame cuts what passes it: an action's focus ring is drawn inside it.
  expect(rule("html:not([data-pointer]) .ac-eventpill__action:focus-visible")).toContain("var(--focus-ring-inset)");
});

describe("worst cases: words and their actions", () => {
  test("a viewer's head: a file's 73-character name with no spaces, its facts, four buttons and the ⋯", () => {
    render(
      <DetailsDialog
        open
        onOpenChange={() => {}}
        closeLabel="Fechar"
        size="xl"
        icon={<span aria-hidden="true">📄</span>}
        title="relatorio_trimestral_de_incidentes_do_checkout_e_da_api_de_pagamentos.pdf"
        subtitle="Arquivo · Joana Albuquerque Figueiredo · #operacoes-financeiras · há 3 dias · 2,4 MB"
        actions={
          <>
            <Button size="sm">Baixar</Button>
            <Button size="sm">Copiar texto</Button>
            <Button size="sm">Enviar nova versão</Button>
          </>
        }
        more={<Button variant="ghost" size="sm" iconOnly icon="more" aria-label="Mais ações" />}
      >
        <p>Prévia</p>
      </DetailsDialog>,
    );
    const dialog = body().getByRole("dialog");
    expect(dialog.querySelector(".ac-details__lead.ac-actline > .ac-details__actions")).not.toBeNull();
    expect(
      dialog.querySelector(".ac-details__close > [aria-label='Mais ações'] + [aria-label='Fechar']"),
    ).not.toBeNull();
  });

  test("a document's 82-character title with Baixar, Editar and the ⋯", () => {
    render(
      <DetailsDialog
        open
        onOpenChange={() => {}}
        closeLabel="Fechar"
        title="Plano de migração do banco de dados de produção para a nova região com janela de manutenção"
        subtitle="Documento · Ada · #infra"
        actions={
          <>
            <Button variant="ghost" size="sm" iconOnly icon="download" aria-label="Baixar" />
            <Button variant="ghost" size="sm" iconOnly icon="edit" aria-label="Editar" />
          </>
        }
        more={<Button variant="ghost" size="sm" iconOnly icon="more" aria-label="Mais ações" />}
      >
        <p>Texto</p>
      </DetailsDialog>,
    );
    expect(body().getByRole("dialog").querySelectorAll(".ac-details__actions > .ac-btn")).toHaveLength(2);
  });

  test("a dialog's head: a long name and its line, a German action, the face and the ×", () => {
    render(
      <Dialog
        open
        onOpenChange={() => {}}
        title="Computador da Ada Lovelace Albuquerque"
        subtitle="Ao vivo · Assistiert gerade bei der Einrichtung"
        leading={<span className="ac-avatar">A</span>}
        actions={<Button size="sm">Steuerung übernehmen</Button>}
        closeLabel="Schließen"
      >
        <DialogBody>
          <p>Tela</p>
        </DialogBody>
      </Dialog>,
    );
    const head = body().getByRole("dialog").querySelector(".ac-dialog__head") as HTMLElement;
    expect(head.lastElementChild?.className).toBe("ac-dialog__close ac-acts");
  });

  test("a dialog's footer in German: a long note over three buttons that keep one group, a short note beside two", () => {
    render(
      <Dialog open onOpenChange={() => {}} title="MCP-Server verbinden" closeLabel="Schließen">
        <DialogBody>
          <p>Adresse</p>
        </DialogBody>
        <DialogFooter
          bar
          note="Beim Verbinden können alle Agenten ihn nutzen. Das änderst du in Schritt 3, bevor etwas geteilt wird."
        >
          <Button>Abbrechen</Button>
          <Button>Mit API-Schlüssel verbinden</Button>
          <Button variant="primary">Verbinden</Button>
        </DialogFooter>
        <DialogFooter note="Schritt 1 von 3">
          <Button>Abbrechen</Button>
          <Button variant="primary">Weiter</Button>
        </DialogFooter>
      </Dialog>,
    );
    const feet = [...body().getByRole("dialog").querySelectorAll(".ac-dialog__foot")];
    expect(feet.map((f) => f.querySelectorAll(":scope > .ac-dialog__foot-acts > .ac-btn").length)).toEqual([3, 2]);
  });

  test("a card's head: a long title with its key and an action, Japanese beside it", () => {
    const { container } = render(
      <>
        <Card>
          <CardHeader
            icon="computer"
            title="Outros computadores conectados a este espaço de trabalho"
            action={<Button size="sm">Baixar o app para macOS</Button>}
          />
        </Card>
        <Card>
          <CardHeader
            title="接続されている他のコンピューター"
            subtitle="この作業スペース"
            action={<Button size="sm">ダウンロード</Button>}
          />
        </Card>
      </>,
    );
    expect(container.querySelectorAll(".ac-card__head.ac-actline > .ac-card__action")).toHaveLength(2);
  });
});

describe("worst cases: facts", () => {
  test("a fact strip: each fact as wide as its words, a long one moved whole to a line of its own", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-facts")).toContain("flex-wrap: wrap");
    // Every fact has its hairline; the strip starts that far left and clips its first pixel, so no line starts with one.
    expect(rule(".ac-facts")).toContain("margin: 0 0 0 -17px");
    expect(rule(".ac-facts")).toContain("clip-path: inset(0 0 0 1px)");
    expect(rule(".ac-facts__item")).toContain("flex: 0 1 auto");
    expect(rule(".ac-facts__item")).toContain("max-width: 100%");
    const { container } = render(
      <FactStrip
        facts={[
          {
            key: "where",
            icon: "link",
            label: "Onde",
            value: "GitHub · agentes-chat/integracao-de-pagamentos-recorrentes-com-checkout #4821",
          },
          { key: "effect", icon: "cloud", label: "Efeito", value: "Vai para produção", tone: "waiting" },
          { key: "when", icon: "clock", label: "Prazo", value: "23 h 59 min" },
          { key: "who", icon: "person", label: "Wer entscheidet", value: "Wartet auf die Geschäftsführung" },
        ]}
      />,
    );
    expect(container.querySelectorAll(".ac-facts > .ac-facts__item")).toHaveLength(4);
  });
});
