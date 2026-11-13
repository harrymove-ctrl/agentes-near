import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type Agent, ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { changedKeys, type Saved } from "@/lib/agent-edit";
import { handleAfterRename } from "@/lib/new-agent";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
/** The name and the @ edit in place: their button opens the field, Enter keeps what was typed. */
const EDIT = { Nome: /^Editar nome/, Menções: /^Editar menções/ } as const;
const type = async (label: keyof typeof EDIT, value: string) => {
  await click(screen().getByRole("button", { name: EDIT[label] }));
  const field = screen().getByLabelText(label);
  await act(async () => fireEvent.change(field, { target: { value } }));
  await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
};
/** The @ as the card reads it ("@ada"). */
const handleShown = () => screen().getByRole("button", { name: EDIT.Menções }).textContent;
const saveBar = () => screen().getByRole("region", { name: "Alterações não salvas" });
const text = () => document.body.textContent ?? "";

/** Ada as an earlier rename left her: Claudio, @claudio, still named by @ada. */
function renamedState() {
  const state = seedState();
  const ada = state.agents.find((a) => a.id === ADA_ID) as Agent;
  Object.assign(ada, { name: "Claudio", handle: "claudio", previousHandles: ["ada"] });
  return state;
}

async function settings(state = seedState(), api = createFakeApi(state)) {
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, { api });
  await settle(8);
  return state;
}

describe("renaming an agent on its page", () => {
  test("Menções follows the new name as it is typed, the hint says the old @ keeps working, Salvar sends both", async () => {
    const state = await settings();
    expect(handleShown()).toBe("@ada");
    expect(text()).toContain("É como todo mundo vê o agente. O @ acompanha o nome.");

    await type("Nome", "Claudio");
    expect(handleShown()).toBe("@claudio");
    expect(text()).toContain("As menções passam a ser por @claudio. @ada continua funcionando.");
    expect(saveBar().textContent).toContain("Nome e Menções");
    // The page's title and the @ under it follow the draft.
    expect(document.querySelector(".agp-handle")?.textContent).toBe("@claudio · Dev");

    await click(within(saveBar()).getByRole("button", { name: /^Salvar/ }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({
      name: "Claudio",
      handle: "claudio",
    });
    const ada = state.agents.find((a) => a.id === ADA_ID);
    expect(ada?.handle).toBe("claudio");
    expect(ada?.previousHandles).toEqual(["ada"]);
    expect(text()).toContain("O @ acompanha o nome.");
  });

  test("an @ typed in Menções wins over the name", async () => {
    const state = await settings();
    await type("Menções", "Clau Dio!");
    expect(handleShown()).toBe("@claudio");
    await type("Menções", "clau");
    await type("Nome", "Claudio");
    expect(handleShown()).toBe("@clau");
    await click(within(saveBar()).getByRole("button", { name: /^Salvar/ }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({ name: "Claudio", handle: "clau" });
  });

  test("an @ taken by another agent, one it had, or a person is refused with a free one; Salvar waits", async () => {
    const state = seedState();
    // Atlas was Zeus: @zeus still names it.
    Object.assign(state.agents.find((a) => a.id === ATLAS_ID) as Agent, { previousHandles: ["zeus"] });
    await settings(state);

    await type("Nome", "Atlas");
    expect(handleShown()).toBe("@atlas");
    expect(text()).toContain("@atlas já é de outro agente ou pessoa. Que tal @atlas-2?");
    expect(text()).not.toContain("As menções passam a ser por @atlas.");
    for (const [taken, free] of [
      ["zeus", "zeus-2"],
      ["walter", "walter-2"],
    ]) {
      await type("Menções", taken as string);
      expect(text()).toContain(`@${taken} já é de outro agente ou pessoa. Que tal @${free}?`);
    }
    await click(within(saveBar()).getByRole("button", { name: /^Salvar/ }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "agents.update")).toBe(false);

    await type("Menções", "atlas-2");
    expect(text()).toContain("As menções passam a ser por @atlas-2. @ada continua funcionando.");
    await click(within(saveBar()).getByRole("button", { name: /^Salvar/ }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({
      name: "Atlas",
      handle: "atlas-2",
    });
  });

  test("renaming back to the old name gives the old @ back", async () => {
    const state = await settings(renamedState());
    expect(handleShown()).toBe("@claudio");
    await type("Nome", "Ada");
    expect(handleShown()).toBe("@ada");
    expect(text()).toContain("As menções passam a ser por @ada. @claudio continua funcionando.");
    expect(text()).not.toContain("já é de outro agente");
    await click(within(saveBar()).getByRole("button", { name: /^Salvar/ }));
    await settle(6);
    const ada = state.agents.find((a) => a.id === ADA_ID);
    expect(ada?.handle).toBe("ada");
    expect(ada?.previousHandles).toEqual(["claudio"]);
  });

  test("the server refusing an @ the page couldn't know (an archived agent's) says so in words", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.agents.update = async () => {
      throw new ApiError(409, "agent.handle_taken", "@nina is already taken", { handle: "nina", suggestion: "nina-2" });
    };
    await settings(state, api);
    await type("Nome", "Nina");
    await click(within(saveBar()).getByRole("button", { name: /^Salvar/ }));
    await settle(6);
    expect(text()).toContain("@nina já é de outro agente ou pessoa. Que tal @nina-2?");
  });

  test("the draft: the @ follows a new name, a typed one, or the saved one kept", () => {
    const saved: Saved = {
      name: "Ada",
      handle: "ada",
      role: "Dev",
      look: { color: "sky", eyes: "round", accessory: "none" },
      instructions: "",
      model: "m",
      owner: "u1",
      audience: { mode: "everyone", userIds: [] },
    };
    expect(handleAfterRename(saved, "Ada")).toBe("ada");
    expect(handleAfterRename(saved, " Ada ")).toBe("ada");
    expect(handleAfterRename(saved, "Cláudio Bot")).toBe("claudiobot");
    expect(handleAfterRename(saved, "🙂")).toBe("ada");
    expect(handleAfterRename(saved, "Claudio", "clau")).toBe("clau");
    expect(changedKeys(saved, { name: "Claudio" }).map((c) => c.key)).toEqual(["name", "handle"]);
    // Desfazer on Menções keeps the @ it has while the name changes.
    expect(changedKeys(saved, { name: "Claudio", handle: "ada" }).map((c) => c.key)).toEqual(["name"]);
  });
});

test("an old message's @ada shows the agent now called Claudio", async () => {
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(renamedState()) });
  await settle(8);
  const chip = Array.from(document.querySelectorAll(".profile-trigger--mention")).find((b) =>
    b.textContent?.includes("@Claudio"),
  ) as HTMLElement | undefined;
  expect(chip?.getAttribute("aria-label")).toBe("Perfil de Claudio");
  expect(text()).not.toContain("@ada o login");
});
