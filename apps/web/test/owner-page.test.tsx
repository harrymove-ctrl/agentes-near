import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, screen, settle } from "./render";

/**
 * The installation's first account when an owner link holds it (ADR 0060 §6), and the
 * account that signs in only through the app on the server's computer.
 */

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const heading = () => screen().getByRole("heading").textContent;
const CLAIM = "Qm9vd25lci1jbGFpbS10b2tlbi0wMTIzNDU2Nzg5";

async function openOwnerLink(result?: Parameters<typeof createFakeAuth>[0]) {
  window.history.replaceState(null, "", `/owner#claim=${CLAIM}`);
  const signedIn = seedState().me;
  const state = seedState({ me: null });
  const { auth, calls } = createFakeAuth(result);
  const claim = auth.ownerClaim;
  auth.ownerClaim = async (input) => {
    const answer = await claim(input);
    if (answer.ok) state.me = signedIn;
    return answer;
  };
  const view = await renderApp("/owner", { api: createFakeApi(state), auth });
  return { ...view, calls };
}

async function fillOwnerForm() {
  await type(screen().getByRole("textbox", { name: "Seu nome" }), "Ana Souza");
  await type(screen().getByRole("textbox", { name: "E-mail" }), "ana@acme.com");
  await type(screen().getByLabelText("Crie uma senha"), "correct horse battery");
  await click(screen().getByRole("button", { name: /Criar a conta de dono/ }));
  await settle(6);
}

describe("the owner link", () => {
  test("the claim leaves the address at once; the owner is made with a password, then the onboarding", async () => {
    const { calls, router } = await openOwnerLink();
    expect(window.location.hash).toBe("");
    expect(heading()).toBe("Configurar este servidor");
    await fillOwnerForm();
    expect(calls.find((c) => c.method === "ownerClaim")?.args[0]).toEqual({
      token: CLAIM,
      name: "Ana Souza",
      email: "ana@acme.com",
      password: "correct horse battery",
    });
    expect(router.state.location.pathname).toBe("/onboarding");
  });

  test("a password equal to the name makes no owner: the password is cleared and the line says why", async () => {
    const { calls } = await openOwnerLink();
    await type(screen().getByRole("textbox", { name: "Seu nome" }), "Fake#Pass1x");
    expect(screen().getByRole("status").textContent).toBe("Isso parece uma senha. Aqui vai o seu nome.");
    await type(screen().getByRole("textbox", { name: "E-mail" }), "ana@acme.com");
    await type(screen().getByLabelText("Crie uma senha"), " Fake#Pass1x ");
    await click(screen().getByRole("button", { name: /Criar a conta de dono/ }));
    await settle(6);
    expect(calls.some((c) => c.method === "ownerClaim")).toBe(false);
    expect(screen().getByRole("alert").textContent).toBe("Esse é o seu nome? É igual à senha que você digitou.");
    expect((screen().getByLabelText("Crie uma senha") as HTMLInputElement).value).toBe("");
  });

  test("without the claim it says where the link is", async () => {
    await renderApp("/owner", { api: createFakeApi(seedState({ me: null })) });
    expect(heading()).toBe("Abra o link de dono deste servidor");
    expect(screen().queryByRole("textbox")).toBeNull();
  });

  test("another server's link, or a server that already has its owner", async () => {
    await openOwnerLink({ claim: { ok: false, status: 401, message: "" } });
    await fillOwnerForm();
    expect(heading()).toBe("Este link não é deste servidor.");
    cleanup();
    await openOwnerLink({ claim: { ok: false, status: 409, message: "" } });
    await fillOwnerForm();
    expect(heading()).toBe("Este servidor já tem dono.");
    expect(screen().getByRole("link", { name: "Entrar" }).getAttribute("href")).toBe("/login");
  });
});

describe("signing in", () => {
  test("a server waiting for its owner says how it gets one, with nothing to fill in", async () => {
    const api = createFakeApi(
      seedState({ me: null, authConfig: { ownerClaim: true, firstRun: false, signupOpen: false } }),
    );
    await renderApp("/login", { api });
    expect(heading()).toBe("Este servidor espera o seu dono.");
    expect(screen().queryByRole("textbox")).toBeNull();
  });

  test("an account with neither a password nor Google or Apple is told where it signs in", async () => {
    const api = createFakeApi(
      seedState({ me: null, signInOptions: { account: true, password: false, providers: [], canSignUp: false } }),
    );
    await renderApp("/login", { api });
    await type(screen().getByRole("textbox", { name: "E-mail" }), "ana@acme.com");
    await click(screen().getByRole("button", { name: /^Continuar(?! com)/ }));
    await settle(4);
    expect(heading()).toBe("Esta conta entra pelo app do agentes.chat.");
    expect(document.querySelector(".auth__lead")?.textContent).toBe(
      "No computador onde este servidor roda, abra o app e escolha Adicionar uma senha em Configurações\u00a0›\u00a0Sua conta.",
    );
    expect(screen().getByRole("button", { name: "Usar outro e-mail" })).toBeTruthy();
  });
});

describe("Adicionar uma senha (Configurações › Sua conta)", () => {
  async function yourAccount(state: ReturnType<typeof seedState>) {
    await renderApp(`/org/${ORG_ID}/settings/account`, { api: createFakeApi(state) });
    await settle(6);
  }

  test("only for an account without a password; saves one", async () => {
    const state = seedState();
    if (!state.me) throw new Error("signed in");
    state.me.user.hasPassword = false;
    await yourAccount(state);
    await click(screen().getByRole("button", { name: /^Adicionar uma senha/ }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Adicionar uma senha" });
    // The menu item already says what it's for: the dialog goes straight to the field.
    expect(dialog.querySelector(".ac-dialog__body > p")).toBeNull();
    const save = within(dialog).getByRole("button", { name: "Salvar senha" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Nova senha"), "correct horse battery");
    await click(save);
    await settle(4);
    expect(state.calls.filter((c) => c.method === "account.addPassword")).toHaveLength(1);
    expect(screen().queryByRole("dialog", { name: "Adicionar uma senha" })).toBeNull();
  });

  test("an account with a password creates a new one instead (ADR 0158), and says what it ends", async () => {
    const state = seedState();
    await yourAccount(state);
    expect(screen().getByRole("button", { name: /^Perfil/ })).toBeTruthy();
    expect(screen().queryByRole("button", { name: /^Adicionar uma senha/ })).toBeNull();
    await click(screen().getByRole("button", { name: /^Criar uma senha nova/ }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Criar uma senha nova" });
    expect(within(dialog).getByText(/As outras sessões saem/)).toBeTruthy();
    await type(within(dialog).getByLabelText("Nova senha"), "correct horse battery");
    await click(within(dialog).getByRole("button", { name: "Salvar senha" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "account.addPassword")).toHaveLength(1);
  });
});
