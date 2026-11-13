import { afterEach, describe, expect, test } from "bun:test";
import type { FeedbackInput } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { describeElement, openFeedback } from "@/lib/feedback";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const BETA = "Você chegou cedo. Que bom.";
const CONNECT = "Conecte uma IA para o seu time pensar";

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const open = async (state = seedState(), search = "") => {
  const r = await renderApp(`/org/${ORG_ID}${search}`, { api: createFakeApi(state) });
  await settle(6);
  return { ...r, state };
};
/** Every agent without an AI, as a workspace is right after its onboarding. */
const withoutAi = () => {
  const state = seedState();
  state.aiStatus = {
    any: false,
    agents: state.agents.map((a) => ({ agentId: a.id, state: "no_ai", reason: "no_key" })),
  };
  return state;
};

describe("the arrival, right after the onboarding", () => {
  test("the beta notice opens from the address once, then Connect an AI with its choices as cards", async () => {
    const { router } = await open(withoutAi(), "?arrival=1");
    const beta = screen().getByRole("dialog", { name: BETA });
    expect(within(beta).getByText("Às vezes algo falha")).toBeTruthy();
    // The mark is dropped as it opens: a reload shows nothing again.
    expect(router.state.location.search).not.toHaveProperty("arrival");
    // This server takes no feedback: nothing says where to send it.
    expect(within(beta).queryByText("O seu feedback decide o que vem")).toBeNull();
    await click(within(beta).getByRole("button", { name: /Continuar/ }));
    await settle(6);
    expect(screen().queryByRole("dialog", { name: BETA })).toBeNull();
    const connect = screen().getByRole("dialog", { name: CONNECT });
    expect(within(connect).getByText("O seu time está pronto")).toBeTruthy();
    for (const name of ["Claude", "ChatGPT", "Outro plano", "Começar grátis"])
      expect(within(connect).getByRole("button", { name: new RegExp(`^${name}`) })).toBeTruthy();
    // Not now: the dialog closes and nothing was connected.
    await click(within(connect).getByRole("button", { name: "Agora não" }));
    await settle(2);
    expect(screen().queryByRole("dialog", { name: CONNECT })).toBeNull();
  });

  test("with every agent already thinking, the beta notice is all there is", async () => {
    await open(seedState(), "?arrival=1");
    await click(within(screen().getByRole("dialog", { name: BETA })).getByRole("button", { name: /Continuar/ }));
    await settle(6);
    expect(screen().queryByRole("dialog", { name: BETA })).toBeNull();
    expect(screen().queryByRole("dialog", { name: CONNECT })).toBeNull();
  });

  test("after the onboarding's own AI step (beta): the notice alone, even with agents that don't think", async () => {
    const { router } = await open(withoutAi(), "?arrival=beta");
    const beta = screen().getByRole("dialog", { name: BETA });
    expect(router.state.location.search).not.toHaveProperty("arrival");
    await click(within(beta).getByRole("button", { name: /Continuar/ }));
    await settle(6);
    expect(screen().queryByRole("dialog", { name: BETA })).toBeNull();
    expect(screen().queryByRole("dialog", { name: CONNECT })).toBeNull();
  });

  test("no mark in the address, no notice", async () => {
    await open(withoutAi());
    expect(screen().queryByRole("dialog", { name: BETA })).toBeNull();
    expect(screen().queryByRole("dialog", { name: CONNECT })).toBeNull();
  });
});

describe("feedback", () => {
  test("no Beta mark where the server takes no feedback", async () => {
    await open();
    expect(screen().queryByRole("button", { name: "Enviar feedback" })).toBeNull();
  });

  test("the Beta mark opens the form, and what was typed is sent with the workspace and the screen", async () => {
    const { state } = await open(seedState({ authConfig: { feedback: true } }));
    await click(screen().getByRole("button", { name: "Enviar feedback" }));
    const form = screen().getByRole("dialog", { name: "O que faltou, quebrou ou incomodou?" });
    const send = within(form).getByRole("button", { name: /^Enviar/ });
    expect(send.hasAttribute("disabled")).toBe(true);
    await type(within(form).getByRole("textbox"), "  O botão de anexar sumiu  ");
    await click(send);
    await settle(4);
    const sent = state.calls.find((c) => c.method === "system.sendFeedback")?.args[0];
    expect(sent).toMatchObject({ text: "O botão de anexar sumiu", orgId: ORG_ID, app: "web" });
    expect(screen().getByRole("dialog", { name: "Recado entregue. Obrigado." })).toBeTruthy();
    await click(screen().getByRole("button", { name: "Enviar outro" }));
    const again = screen().getByRole("dialog", { name: "O que faltou, quebrou ou incomodou?" });
    expect(within(again).getByRole("textbox")).toHaveProperty("value", "");
  });
});

describe("feedback about what was clicked", () => {
  const page = () => {
    const host = document.createElement("div");
    host.innerHTML =
      '<div data-message-id="m1"><article class="ac-msg ac-msg--agent"><span class="ac-msg__author">Ada</span>' +
      '<div class="ac-msg__body"><p>Deploy   done.</p><p>All green.</p></div></article></div>' +
      "<section><h2>Plano</h2><button>Assinar</button></section>";
    document.body.append(host);
    return host;
  };

  test("a message says who wrote it and what it says; a selection, only itself; anything else, its role and words", () => {
    const host = page();
    const said = describeElement(host.querySelector("p"));
    expect(said).toMatchObject({
      message: true,
      about: { kind: "agent message", label: "Ada", text: "Deploy done.\nAll green." },
    });
    expect(said?.facts[0]).toEqual(["Message id", "m1"]);
    expect(describeElement(host.querySelector("p"), "All green")?.about.text).toBe("All green");
    expect(describeElement(host.querySelector("button"))).toMatchObject({
      message: false,
      about: { kind: "button", text: "Assinar" },
    });
    expect(describeElement(null)).toBeNull();
    host.remove();
  });

  test("the form shows the excerpt, sends it with where the person is, and leaves it out when asked", async () => {
    const { state } = await open(seedState({ authConfig: { feedback: true } }));
    const host = page();
    await act(async () => openFeedback(describeElement(host.querySelector("p"))));
    let form = screen().getByRole("dialog", { name: "O que faltou, quebrou ou incomodou?" });
    expect(within(form).getByText("Sobre a mensagem de Ada")).toBeTruthy();
    expect(within(form).getByText(/Deploy done\./)).toBeTruthy();
    await type(within(form).getByRole("textbox"), "Resposta errada");
    await click(within(form).getByRole("button", { name: /^Enviar/ }));
    await settle(4);
    const sent = state.calls.findLast((c) => c.method === "system.sendFeedback")?.args[0] as FeedbackInput;
    expect(sent.about).toEqual({ kind: "agent message", label: "Ada", text: "Deploy done.\nAll green." });
    expect(sent.facts?.map(([k]) => k)).toEqual(expect.arrayContaining(["Route", "Message id", "Browser"]));

    await act(async () => openFeedback(describeElement(host.querySelector("p"))));
    form = screen().getByRole("dialog", { name: "O que faltou, quebrou ou incomodou?" });
    await click(within(form).getByRole("button", { name: "Não enviar este trecho" }));
    expect(within(form).queryByText(/Deploy done\./)).toBeNull();
    await type(within(form).getByRole("textbox"), "Só o aviso");
    await click(within(form).getByRole("button", { name: /^Enviar/ }));
    await settle(4);
    const bare = state.calls.findLast((c) => c.method === "system.sendFeedback")?.args[0] as FeedbackInput;
    expect(bare.about).toMatchObject({ kind: "agent message", label: "Ada" });
    expect(bare.about?.text).toBeUndefined();
    host.remove();
  });

  test("a picture is added, listed and sent by its id; anything else is refused before it is uploaded", async () => {
    const { state } = await open(seedState({ authConfig: { feedback: true } }));
    await click(screen().getByRole("button", { name: "Enviar feedback" }));
    const form = screen().getByRole("dialog", { name: "O que faltou, quebrou ou incomodou?" });
    const picker = form.querySelector('input[type="file"]') as HTMLInputElement;
    const choose = (files: File[]) => act(async () => fireEvent.change(picker, { target: { files } }));
    await choose([new File(["x"], "notas.pdf", { type: "application/pdf" })]);
    expect(state.calls.some((c) => c.method === "system.uploadFeedbackFile")).toBe(false);
    await choose([new File(["x"], "tela.png", { type: "image/png" })]);
    await settle(4);
    expect(within(form).getByText("tela.png")).toBeTruthy();
    await type(within(form).getByRole("textbox"), "Olha a tela");
    await click(within(form).getByRole("button", { name: /^Enviar/ }));
    await settle(4);
    const sent = state.calls.findLast((c) => c.method === "system.sendFeedback")?.args[0] as FeedbackInput;
    expect(sent.files).toHaveLength(1);
  });
});
