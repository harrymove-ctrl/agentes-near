import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { AddressBar } from "../src/components/browser/AddressBar";
import { RequestCard } from "../src/components/RequestCard";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** happy-dom's `:disabled` doesn't see a fieldset's. */
const off = (el: Element) => (el as HTMLButtonElement).disabled || el.closest("fieldset[disabled]") !== null;

describe("a form whose action is on its way", () => {
  test("what the CSS reached as a child it still reaches through the lock's fieldset", async () => {
    const read = (path: string) => Bun.file(new URL(path, import.meta.url).pathname).text();
    expect(await read("../src/components/tasks/tasks.css")).toMatch(/\.tm-saywhy \.tm-why \{\s*flex: 1;/);
    expect(await read("../src/layout.css")).toContain(".rq > .ac-locked > .waitcard__lines {");
  });

  test("the kit's small buttons with no disabled look of their own dim with the form", async () => {
    const css = await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text();
    for (const name of [".ac-recur__day", ".ac-token__remove", ".ac-searchfield__clear", ".ac-setmore__toggle"])
      expect(css).toMatch(new RegExp(`\\.ac-locked:disabled :is\\([^)]*\\${name}`));
  });

  test("what a fieldset can't stop waits on the flag itself: a dropped file, the photo's crop", async () => {
    const read = (path: string) => Bun.file(new URL(path, import.meta.url).pathname).text();
    expect(await read("../src/components/vault/VaultImportDialog.tsx")).toContain("return !importer.busy;");
    const photo = await read("../src/components/ProfilePhoto.tsx");
    expect(photo).toContain("if (busy) return;");
    expect(photo).toContain("if (!busy) void choose(");
  });

  test("the island's reply and a mission's join role lock with their send", async () => {
    const read = (path: string) => Bun.file(new URL(path, import.meta.url).pathname).text();
    const island = await read("../src/components/NoticeIsland.tsx");
    expect(island).toMatch(/<Locked when=\{reply\.isPending\}>\s*<input/);
    const mission = await read("../src/components/missions/MissionDialogs.tsx");
    expect(mission).toMatch(/<Locked when=\{decide\.isPending\}>\s*<Select/);
  });

  const card = (locked: boolean) => (
    <RequestCard
      id="r1"
      kind="question"
      agent={undefined}
      label="Pedido"
      mine
      lead="Qual?"
      object={{ logo: null, title: "Objeto", more: "Ver" }}
      details={<input aria-label="detalhe" defaultValue="d" />}
      body={<input aria-label="campo" defaultValue="escrito" />}
      actions={<button type="button">Enviar</button>}
      end={<button type="button">Pular</button>}
      what="Pedido"
      locked={locked}
    />
  );

  test("a request card turns off what it holds and keeps it, while Ver still opens", () => {
    const { rerender } = render(card(false));
    fireEvent.click(screen().getByRole("button", { name: "Ver" }));
    rerender(card(true));
    const field = screen().getByLabelText("campo") as HTMLInputElement;
    for (const el of [field, screen().getByLabelText("detalhe")]) expect(off(el)).toBe(true);
    for (const name of ["Enviar", "Pular"]) expect(off(screen().getByRole("button", { name }))).toBe(true);
    expect(field.value).toBe("escrito");
    expect(off(screen().getByRole("button", { name: "Ver" }))).toBe(false);
    rerender(card(false));
    expect(off(field)).toBe(false);
  });

  test("one button deciding a request turns off the others on it, whichever mutation each runs", async () => {
    const state = seedState();
    // One click decides it, with no hold.
    state.approvals = state.approvals.filter((a) => a.id === "ap-merge");
    const api = createFakeApi(state);
    let finish = () => {};
    const approve = api.approvals.approve;
    api.approvals.approve = async (...args) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return approve(...args);
    };
    await renderApp(`/org/${ORG_ID}/approvals`, { api });
    await settle(4);
    const bar = document.querySelector(".ap-bar__acts") as HTMLElement;
    const refuse = within(bar).getByRole("button", { name: /Recusar/ });
    const approveButton = bar.querySelector("[data-approve]") as HTMLElement;
    expect(off(refuse)).toBe(false);
    await act(async () => fireEvent.click(approveButton));
    await settle(2);
    expect(off(refuse)).toBe(true);
    await act(async () => finish());
    await settle(4);
  });

  const failing = (open: () => Promise<void>) => (
    <AddressBar url="https://a.test" host="a.test" grammar={{ name: "Lia" } as never} onOpen={open} />
  );
  const typeAndSend = async (input: HTMLInputElement) => {
    input.focus();
    fireEvent.change(input, { target: { value: "b.test" } });
    await act(async () => fireEvent.submit(input.closest("form") as HTMLFormElement));
  };

  test("the address bar: refused, it opens up with the words typed and the focus back; opened, the bar lets go", async () => {
    let settleOpen: (fail: boolean) => void = () => {};
    const open = () =>
      new Promise<void>((resolve, reject) => {
        settleOpen = (fail) => (fail ? reject(new Error("no")) : resolve());
      });
    const { container } = render(failing(open));
    const input = container.querySelector("input") as HTMLInputElement;
    await typeAndSend(input);
    expect(off(input)).toBe(true);
    input.blur();
    await act(async () => settleOpen(true));
    await settle(1);
    expect(off(input)).toBe(false);
    expect(input.value).toBe("b.test");
    expect(document.activeElement === input).toBe(true);
    await act(async () => fireEvent.submit(input.closest("form") as HTMLFormElement));
    input.blur();
    await act(async () => settleOpen(false));
    await settle(1);
    expect(document.activeElement === input).toBe(false);
    expect(input.value).toBe("a.test");
  });
});
