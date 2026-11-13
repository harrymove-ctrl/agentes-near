import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

type State = ReturnType<typeof seedState>;

// A made-up key in Anthropic's shape.
const KEY = "sk-ant-api03-Zq8xW2pL5mN7vR1tY4uI9oP3aS6dF0gH-jK2lZ8xC5vB1nM4qW7eR9tY2uI6oP0aS3dF";

const open = async (state: State = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(5);
  await act(async () => r.sockets.last().open());
  await settle(2);
  return { ...r, state };
};
const composer = () => screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
const send = async (text: string) => {
  await act(async () => fireEvent.change(composer(), { target: { value: text } }));
  await act(async () => fireEvent.keyDown(composer(), { key: "Enter" }));
  await settle(4);
};
const guard = () => screen().queryByRole("dialog", { name: "Isso parece uma chave de API" });
const click = async (el: HTMLElement) => {
  await act(async () => fireEvent.click(el));
  await settle(6);
};
const posts = (state: State) =>
  state.calls.filter((c) => c.method === "chat.post").map((c) => (c.args[2] as { body: string }).body);

describe("an API key in a message: nothing goes out until the person chooses", () => {
  test("Tirar do texto puts the message back without the key; Enviar mesmo assim sends it as written", async () => {
    const { state } = await open();
    await send(`@ada minha chave é ${KEY} conecta?`);
    const dialog = guard() as HTMLElement;
    expect(dialog.textContent).toContain("Tudo o que vai no chat fica visível para as pessoas e os agentes.");
    expect(posts(state)).toEqual([]);
    await click(within(dialog).getByRole("button", { name: "Tirar do texto" }));
    expect(guard()).toBeNull();
    expect(composer().value).toBe("@ada minha chave é conecta?");
    expect(posts(state)).toEqual([]);

    await send(`usa essa ${KEY}`);
    await click(within(guard() as HTMLElement).getByRole("button", { name: "Enviar mesmo assim" }));
    expect(posts(state)).toEqual([`usa essa ${KEY}`]);
    expect(composer().value).toBe("");
  });

  test("an admin saves it as the organization's key instead: Connect an AI opens on the key, with it", async () => {
    const { state } = await open();
    await send(`minha chave ${KEY}`);
    await click(within(guard() as HTMLElement).getByRole("button", { name: "Salvar como chave" }));
    const add = screen().getByRole("dialog", { name: "Conectar uma IA" });
    expect((within(add).getByLabelText("Cole aqui") as HTMLInputElement).value).toBe(KEY);
    expect(within(add).getByRole("combobox", { name: "Provedor" }).textContent).toBe("Claude");
    await click(within(add).getByRole("button", { name: "Salvar chave" }));
    expect(state.calls.find((c) => c.method === "agents.addCredential")?.args[1]).toMatchObject({
      provider: "anthropic",
    });
    expect(add.textContent).toContain("Salva. Todo agente sem plano pensa com ela.");
    await click(within(add).getByRole("button", { name: "Pronto" }));
    expect(composer().value).toBe("minha chave");
    expect(posts(state)).toEqual([]);
  });

  test("a member can't save keys: only remove it or send it", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await open(state);
    await send(`olha ${KEY}`);
    const dialog = guard() as HTMLElement;
    expect(within(dialog).queryByRole("button", { name: "Salvar como chave" })).toBeNull();
    expect(dialog.textContent).toContain("Uma chave é como uma senha.");
    expect(posts(state)).toEqual([]);
  });

  test("ordinary text with sk- words goes out at once", async () => {
    const { state } = await open();
    await send("o sk-learn resolve isso");
    expect(guard()).toBeNull();
    expect(posts(state)).toEqual(["o sk-learn resolve isso"]);
  });
});
