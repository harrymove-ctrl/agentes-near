import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { MessageBody } from "@/chat/MessageBody";
import { createFakeApi, type FakeState, LODI_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** How agents talk to you (ADR 0147): Sua conta's choice, the right hand's one-time question, collapsed details. */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const unpicked = (state: FakeState) => {
  const org = state.me?.organizations[0];
  if (org) org.agentStyle = null;
  return { state, org };
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

describe("Sua conta", () => {
  test("Simples until the person picks; Técnico saves it for this workspace", async () => {
    const { state, org } = unpicked(seedState());
    await renderApp(`/org/${ORG_ID}/settings/account`, { api: createFakeApi(state) });
    await settle(8);
    const group = screen().getByRole("radiogroup", { name: "Como os agentes falam com você" });
    expect(within(group).getByRole("radio", { name: "Simples" }).getAttribute("aria-checked")).toBe("true");
    await click(within(group).getByRole("radio", { name: "Técnico" }));
    expect(state.calls).toContainEqual({ method: "orgs.setAgentStyle", args: [ORG_ID, "technical"] });
    expect(org?.agentStyle).toBe("technical");
  });

  test("a server from before the choice shows no row", async () => {
    await renderApp(`/org/${ORG_ID}/settings/account`, { api: createFakeApi(seedState()) });
    await settle(8);
    expect(screen().queryByRole("radiogroup", { name: "Como os agentes falam com você" })).toBeNull();
  });
});

describe("the right hand asks once", () => {
  const question = "Como prefere que eu fale com você?";

  test("under its greeting while the person never picked: a tap saves it and the question goes", async () => {
    const { state, org } = unpicked(withRightHand(seedState()));
    await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
    await settle(8);
    expect(document.body.textContent).toContain(question);
    await click(screen().getByRole("button", { name: "Simples, sem termos técnicos" }));
    expect(state.calls).toContainEqual({ method: "orgs.setAgentStyle", args: [ORG_ID, "simple"] });
    expect(org?.agentStyle).toBe("simple");
    expect(document.body.textContent).not.toContain(question);
  });

  test("picked already (or an older server): never asked", async () => {
    const state = withRightHand(seedState());
    const org = state.me?.organizations[0];
    if (org) org.agentStyle = "technical";
    await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
    await settle(8);
    expect(document.body.textContent).not.toContain(question);
  });
});

describe("a collapsed block in a message", () => {
  test("<details> shows its summary closed, the Markdown inside it rendered; other HTML stays text", () => {
    const el = render(
      <MessageBody
        body={[
          "Falta dar acesso ao repositório. Clique em **Permitir**.",
          "<details><summary>Detalhes</summary>",
          "",
          "O app recebeu `403` em `repos/acme/site`.",
          "",
          "- commit `a1b2c3d`",
          "</details>",
          "<b>não</b>",
        ].join("\n")}
      />,
    ).container;
    const details = el.querySelector("details.md__details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Detalhes");
    expect(details.querySelector("code")?.textContent).toBe("403");
    expect(details.querySelector("li")?.textContent).toBe("commit a1b2c3d");
    expect(el.querySelector("strong")?.textContent).toBe("Permitir");
    expect(el.querySelector("b")).toBeNull();
    expect(el.textContent).toContain("<b>não</b>");
  });
});
