import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** The seed's first request (Ada's card in #eng), changed by `change`. */
async function openCard(change: (a: FakeState["approvals"][number]) => void) {
  const state = seedState();
  const first = state.approvals[0];
  if (!first) throw new Error("no approval");
  change(first);
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(4);
  return screen().getByRole("group", { name: "Pedido de aprovação" });
}

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};

describe("an approval's preview: what will happen, drawn as an attachment's cover", () => {
  test("an email as it will go out: the subject, to whom, its words; its line doesn't say them again", async () => {
    const card = await openCard((a) => {
      a.email = {
        verb: "send",
        mailbox: "suporte@acme.com",
        provider: "Gmail",
        from: "suporte@acme.com",
        to: ["cliente@exemplo.com"],
        cc: [],
        bcc: [],
        subject: "Seu reembolso foi aprovado",
        body: "Olá! O reembolso do pedido 4821 foi aprovado hoje.",
        original: null,
      };
    });
    const preview = card.querySelector(".rq__preview") as HTMLElement;
    expect(preview.querySelector(".rq-mail__subject")?.textContent).toBe("Seu reembolso foi aprovado");
    expect(preview.querySelector(".rq-mail__to")?.textContent).toBe("cliente@exemplo.com");
    expect(preview.querySelector(".rq-mail__body")?.textContent).toBe(
      "Olá! O reembolso do pedido 4821 foi aprovado hoje.",
    );
    // No label beside a value, and the action's line under it says only what it is.
    expect(preview.querySelector("dt")).toBeNull();
    expect(card.querySelector(".rq__well small")).toBeNull();
    // "Ver o e-mail" shows it whole in the preview's place.
    await click(within(card).getByRole("button", { name: "Ver o e-mail" }));
    expect(card.querySelector(".rq__preview")).toBeNull();
    expect(card.querySelector(".rq__details .email-letter")).not.toBeNull();
  });

  test("an action's values stay on its line: no preview (their names are the tool's own)", async () => {
    const card = await openCard((a) => {
      a.params = { repo: "agentes-chat/app", pull_number: 42 };
    });
    expect(card.querySelector(".rq__preview")).toBeNull();
    expect(card.querySelector(".rq__well")).not.toBeNull();
  });

  test("nothing to draw: no preview, the action's line", async () => {
    const card = await openCard((a) => {
      a.params = {};
    });
    expect(card.querySelector(".rq__preview")).toBeNull();
    expect(card.querySelector(".rq__well")).not.toBeNull();
  });
});
