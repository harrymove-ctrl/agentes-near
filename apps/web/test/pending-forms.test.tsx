import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { NetworkError, type SignInOptions } from "@agenteschat/client";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { KeyPanel } from "../src/components/ai/ConnectAiSteps";
import { createFakeApi, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** happy-dom's `:disabled` doesn't see a fieldset's, as a browser does. */
const off = (el: Element) => el.hasAttribute("disabled") || el.closest("fieldset[disabled]") !== null;
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

/** A call that stays open until the test settles it. */
const held = <T,>() => {
  let fail = (_: unknown) => {};
  const answer = new Promise<T>((_, reject) => {
    fail = reject;
  });
  return { answer, fail: (error: unknown) => act(async () => fail(error)) };
};

describe("a form whose action is on its way", () => {
  test("sign-in: the field is off with its words, and a failure gives it back", async () => {
    const api = createFakeApi(seedState({ me: null }));
    const call = held<SignInOptions>();
    api.account.signInOptions = () => call.answer;
    await renderApp("/login", { api });
    await settle(5);
    const email = screen().getByLabelText("E-mail") as HTMLInputElement;
    await type(email, "ada@acme.com");
    await click(screen().getByRole("button", { name: /^Continuar(?! com)/ }));
    expect(off(email)).toBe(true);
    expect(email.value).toBe("ada@acme.com");
    await call.fail(new NetworkError(new TypeError("Failed to fetch")));
    await settle(3);
    expect(off(email)).toBe(false);
    expect(email.value).toBe("ada@acme.com");
  });

  test("a key being tried: its field is off, so what is saved stays what the person sees", () => {
    const panel = (saving: boolean) => (
      <KeyPanel
        draft={{ provider: "anthropic", apiKey: "sk-ant-api03-abcdefghijklmnop" }}
        onDraft={() => {}}
        saving={saving}
        onSave={() => {}}
      />
    );
    const { container, rerender } = render(panel(true));
    const field = container.querySelector("input") as HTMLInputElement;
    expect(off(field)).toBe(true);
    rerender(panel(false));
    expect(off(field)).toBe(false);
  });

  test("a dialog: its fields are off, Cancelar and × stay, and a failure gives them back", async () => {
    const api = createFakeApi(seedState());
    const call = held<never>();
    api.chat.createChannel = () => call.answer;
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api });
    await settle(8);
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    const plus = within(nav).getByRole("button", { name: "Novo canal ou categoria" });
    await act(async () => {
      fireEvent.keyDown(plus, { key: "Enter" });
      fireEvent.keyUp(plus, { key: "Enter" });
    });
    await settle(2);
    await click(screen().getByRole("menuitem", { name: "Novo canal" }));
    await settle(2);
    const dialog = within(screen().getByRole("dialog", { name: "Criar canal" }));
    const name = dialog.getByLabelText("Nome") as HTMLInputElement;
    await type(name, "lancamento");
    await act(async () => fireEvent.submit(name.closest("form") as HTMLFormElement));
    expect(off(name)).toBe(true);
    expect(name.value).toBe("lancamento");
    expect(off(dialog.getByRole("button", { name: "Cancelar" }))).toBe(false);
    expect(off(dialog.getByRole("button", { name: "Fechar" }))).toBe(false);
    await call.fail(new Error("no"));
    await settle(3);
    expect(off(name)).toBe(false);
    expect(name.value).toBe("lancamento");
  });
});
