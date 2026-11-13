import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readFileSync } from "node:fs";
import type { SecretBox, SecretRequest, SecretTarget } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { secretAad } from "@agenteschat/client/lib/secret-box";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
// The computer's side, from the server code: what the card seals must open there.
import { generateSecretKeyPair, openSecret } from "../../../packages/adapters/src/secret-box";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

async function withRequest(
  requestedForUserId: string,
  publicKey: string,
  target: SecretTarget = { kind: "env" },
  name = "NPM_TOKEN",
  expiresAt = Date.now() + 15 * 60_000,
  extra: Partial<SecretRequest> = {},
) {
  const state = seedState();
  const secretRequest = {
    id: "00000000-0000-4000-8000-0000000000e1",
    agentId: ADA_ID,
    channelId: ENG_ID,
    threadId: null,
    messageId: "msg-s",
    requestedForUserId,
    name,
    purpose: "publicar o pacote no npm",
    target,
    machineId: null,
    publicKey,
    status: "pending" as const,
    expiresAt: new Date(expiresAt).toISOString(),
    deliveredAt: null,
    removed: false,
    ...extra,
  };
  state.messages.push({
    id: "msg-s",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: `Pedido de segredo: ${name}`,
    mentionedAgentIds: [],
    agentRunId: "r-s",
    meta: { secretRequestId: secretRequest.id, secretRequest },
    createdAt: new Date().toISOString(),
  });
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  await act(async () => r.sockets.last().open());
  await settle(2);
  return { state, secretRequest, api, r };
}

const KEY_LABEL = "Chave para o computador de Ada";

describe("secret requests (ADR 0027)", () => {
  test("the person asked types it; it leaves the browser sealed to the computer's key and opens there", async () => {
    const pair = await generateSecretKeyPair();
    const { state, secretRequest } = await withRequest("u-walter", pair.publicKey);
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    // The request card: what kind of request and the secret it names (waiting for me needs no words).
    expect(card.getAttribute("data-ask-kind")).toBe("secret");
    expect(card.textContent).toContain("Pede um segredo");
    expect(card.hasAttribute("data-ask-mine")).toBe(true);
    expect(card.textContent).toContain("publicar o pacote no npm");
    expect(card.textContent).not.toContain("NPM_TOKEN");
    expect(card.textContent).toContain("Chave para o computador de Ada");
    expect(card.textContent).toContain("Vai para o computador de Ada, para os comandos.");
    const field = within(card).getByLabelText(KEY_LABEL) as HTMLInputElement;
    expect(field.type).toBe("password");
    await type(field, "npm_live_abc123");
    await click(within(card).getByRole("button", { name: "Enviar" }));
    await settle(6);

    const call = state.calls.find((c) => c.method === "secrets.deliver");
    expect(call?.args.slice(0, 2)).toEqual([ORG_ID, secretRequest.id]);
    const box = call?.args[2] as SecretBox;
    // What went to the server is a box, never the value.
    expect(JSON.stringify(call?.args)).not.toContain("npm_live_abc123");
    const aad = secretAad({ requestId: secretRequest.id, orgId: ORG_ID, name: "NPM_TOKEN", target: { kind: "env" } });
    expect(await openSecret(pair.privateKey, box, aad)).toBe("npm_live_abc123");

    // Once sent, one line takes its place (another element): look it up again.
    const done = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(done.querySelector(".rq-done__mark[data-done]")).not.toBeNull();
    expect(done.textContent).toContain(`${KEY_LABEL} · Entregue por você`);
    expect(done.textContent).not.toContain("NPM_TOKEN");
    expect(within(done).queryByLabelText(KEY_LABEL)).toBeNull();
    expect(done.hasAttribute("data-ask-id")).toBe(false);
  });

  test("a site's password: only the agent's browser types it, on its site, and it is sealed to that site", async () => {
    const pair = await generateSecretKeyPair();
    const site = { kind: "site" as const, site: "https://shop.example.com" };
    const { state, secretRequest } = await withRequest("u-walter", pair.publicKey, site, "SHOP_PASSWORD");
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(card.textContent).toContain(
      "Só o navegador de Ada digita, em shop.example.com. Fica fora dos comandos de Ada.",
    );
    expect(card.textContent).not.toContain("variável");
    await type(within(card).getByLabelText("Senha de shop.example.com"), "hunter2-for-real");
    await click(within(card).getByRole("button", { name: "Enviar" }));
    await settle(6);
    const box = state.calls.find((c) => c.method === "secrets.deliver")?.args[2] as SecretBox;
    const aad = (target: SecretTarget) =>
      secretAad({ requestId: secretRequest.id, orgId: ORG_ID, name: "SHOP_PASSWORD", target });
    expect(await openSecret(pair.privateKey, box, aad(site))).toBe("hunter2-for-real");
    await expect(openSecret(pair.privateKey, box, aad({ kind: "env" }))).rejects.toThrow();
  });

  test("someone else sees who was asked, and no field", async () => {
    const pair = await generateSecretKeyPair();
    await withRequest("u-joao", pair.publicKey);
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(card.textContent).toContain("esperando João");
    expect(card.textContent).not.toContain("esperando você");
    expect(within(card).queryByLabelText(KEY_LABEL)).toBeNull();
    expect(within(card).queryByRole("button", { name: "Enviar" })).toBeNull();
    // Not the viewer's to answer: the activity bar never brings it back.
    expect(card.hasAttribute("data-ask-mine")).toBe(false);
  });

  test("Recusar closes it", async () => {
    const pair = await generateSecretKeyPair();
    const { state } = await withRequest("u-walter", pair.publicKey);
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    await click(within(card).getByRole("button", { name: "Recusar" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "secrets.decline")).toBe(true);
    const done = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(done.textContent).toContain("Recusado. Ada segue sem isso.");
    expect(done.querySelector(".rq-done__mark[data-done]")).toBeNull();
  });

  // Real time passes in it (the request's own timer), so it gets more than the default 5 s.
  test("past its time with no event: the field goes and it reads as expired", async () => {
    const pair = await generateSecretKeyPair();
    const expiresAt = Date.now() + 3_000;
    await withRequest("u-walter", pair.publicKey, { kind: "env" }, "NPM_TOKEN", expiresAt);
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(card.hasAttribute("data-ask-mine")).toBe(true);
    // Nothing comes from the server: the card's own timer closes it at that moment.
    await act(() => new Promise((r) => setTimeout(r, Math.max(0, expiresAt - Date.now()) + 50)));
    await settle(2);
    const done = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(done.hasAttribute("data-ask-id")).toBe(false);
    expect(within(done).queryByLabelText(KEY_LABEL)).toBeNull();
    expect(done.textContent).toContain("Ninguém respondeu a tempo. Ada segue sem isso e pode pedir de novo.");
  }, 15_000);

  test("the agent's label is what people read, with the account it knows, and its internal name shows nowhere", async () => {
    const pair = await generateSecretKeyPair();
    const site = { kind: "site" as const, site: "https://accounts.google.com" };
    await withRequest("u-walter", pair.publicKey, site, "LIA_GOOGLE_PASSWORD", undefined, {
      label: "Senha da Conta Google",
      username: "lia@agentes.chat",
      site: site.site,
      purpose: "Preciso entrar na minha Conta Google.",
    });
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(card.textContent).not.toContain("LIA_GOOGLE_PASSWORD");
    // The reason, then right under it what is asked: nothing between them.
    const lead = card.querySelector(".rq__lead");
    expect(lead?.textContent).toBe("Preciso entrar na minha Conta Google.");
    expect(lead?.nextElementSibling?.querySelector("b")?.textContent).toBe("Senha da Conta Google");
    expect(card.textContent).toContain("Conta: lia@agentes.chat.");
    expect(within(card).getByLabelText("Senha da Conta Google")).not.toBeNull();
    // The Vault part comes filled in with it.
    expect((within(card).getByLabelText("Usuário") as HTMLInputElement).value).toBe("lia@agentes.chat");
  });

  test("what the card says isn't cut: its title, where it goes and its ended line wrap", () => {
    const css = readFileSync(new URL("../src/components/request-card.css", import.meta.url), "utf8");
    for (const selector of [".rq__wt b,\n.rq__wt small", ".rq-done__text"]) {
      const rule = css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));
      expect(rule).toContain("overflow-wrap: anywhere");
      expect(rule).not.toContain("ellipsis");
      expect(rule).not.toContain("nowrap");
    }
  });

  test("an event ends it where it stands, with no click: the reason, and nothing left to fill in", async () => {
    const pair = await generateSecretKeyPair();
    const { r, secretRequest } = await withRequest("u-walter", pair.publicKey);
    const push = (over: Partial<SecretRequest>) =>
      act(async () =>
        r.sockets.last().push({
          type: "event",
          channelId: ENG_ID,
          event: {
            type: "secret.updated",
            channelId: ENG_ID,
            threadId: null,
            secretRequest: { ...secretRequest, publicKey: null, ...over },
          },
        }),
      );
    await push({ status: "canceled", endReason: "run_stopped" });
    await settle(2);
    const done = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(done.textContent).toContain("A tarefa de Ada parou antes da resposta.");
    for (const gone of ["esperando você", "Vale até"]) expect(done.textContent).not.toContain(gone);
    expect(within(done).queryByRole("button", { name: "Enviar" })).toBeNull();
    expect(within(done).queryByRole("button", { name: "Recusar" })).toBeNull();
    expect(within(done).queryByLabelText(KEY_LABEL)).toBeNull();
  });

  test("a newer request took its place: the card says so and leads to it", async () => {
    const pair = await generateSecretKeyPair();
    const newer = "00000000-0000-4000-8000-0000000000e2";
    await withRequest("u-walter", pair.publicKey, { kind: "env" }, "NPM_TOKEN", undefined, {
      status: "canceled",
      endReason: "superseded",
      supersededBy: newer,
      publicKey: null,
    });
    const done = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(done.textContent).toContain("Ada pediu de novo, num pedido mais novo.");
    expect(within(done).getByRole("button", { name: "Ver o pedido novo" })).not.toBeNull();
  });

  test("sending what already ended: a 409 turns the card into how it ended, and the typed value goes", async () => {
    const pair = await generateSecretKeyPair();
    const { state, secretRequest } = await withRequest("u-walter", pair.publicKey);
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    await type(within(card).getByLabelText(KEY_LABEL), "npm_live_abc123");
    // It closed on the server and no event reached this card.
    const kept = state.messages.find((m) => m.id === "msg-s")?.meta?.secretRequest as SecretRequest;
    Object.assign(kept, { ...secretRequest, status: "canceled", endReason: "withdrawn", publicKey: null });
    await click(within(card).getByRole("button", { name: "Enviar" }));
    await settle(6);
    const done = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(done.textContent).toContain("Ada não precisa mais disso.");
    expect(within(done).queryByLabelText(KEY_LABEL)).toBeNull();
    expect(screen().queryByDisplayValue("npm_live_abc123")).toBeNull();
  });

  test("the request can't be read again: the 409 itself says how it ended", async () => {
    const pair = await generateSecretKeyPair();
    const { api } = await withRequest("u-walter", pair.publicKey);
    api.secrets.deliver = () =>
      Promise.reject(
        new ApiError(409, "secret.closed", "closed", { status: "canceled", endReason: "computer_changed" }),
      );
    api.secrets.get = () => Promise.reject(new TypeError("Failed to fetch"));
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    await type(within(card).getByLabelText(KEY_LABEL), "npm_live_abc123");
    await click(within(card).getByRole("button", { name: "Enviar" }));
    await settle(6);
    const done = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(done.textContent).toContain("o computador que pediu mudou");
    expect(done.textContent).not.toContain("fechou antes da resposta");
  });

  test("a 409 on a request still open keeps it open and says to send again, never that it closed", async () => {
    const pair = await generateSecretKeyPair();
    const { api } = await withRequest("u-walter", pair.publicKey);
    api.secrets.deliver = () => Promise.reject(new ApiError(409, "conflict", "conflict"));
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    const field = within(card).getByLabelText(KEY_LABEL) as HTMLInputElement;
    await type(field, "npm_live_abc123");
    await click(within(card).getByRole("button", { name: "Enviar" }));
    await settle(6);
    expect(card.textContent).toContain("Este pedido mudou enquanto você respondia.");
    expect(field.value).toBe("npm_live_abc123");
  });

  test("its computer is away: the request stays open and says so, with the typed value kept to send again", async () => {
    const pair = await generateSecretKeyPair();
    const { api } = await withRequest("u-walter", pair.publicKey);
    api.secrets.deliver = () => Promise.reject(new ApiError(409, "machine.offline", "offline"));
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    const field = within(card).getByLabelText(KEY_LABEL) as HTMLInputElement;
    await type(field, "npm_live_abc123");
    await click(within(card).getByRole("button", { name: "Enviar" }));
    // The value is sealed (WebCrypto, off the JS thread) before it is sent: no number of ticks waits for that.
    await waitFor(() => expect(card.textContent).toContain("O computador de Ada não está respondendo agora."), {
      timeout: 10_000,
    });
    expect(card.textContent).not.toContain("respondido ou expirou");
    expect(field.value).toBe("npm_live_abc123");
    expect(within(card).getByRole("button", { name: "Enviar" })).not.toBeNull();
  });
});
