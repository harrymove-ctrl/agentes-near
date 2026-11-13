import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const agentLine = (id: string, meta: Record<string, unknown>, body = "Deixei o recado para a equipe.") => ({
  id,
  channelId: ENG_ID,
  threadId: null,
  author: { type: "agent" as const, id: ADA_ID },
  body,
  mentionedAgentIds: [],
  agentRunId: null,
  meta,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
});

// The geometry guard lays these out at phone widths too: a sentence beside its action must never wrap a word a line.
test("a mention that woke nobody: the event pill and the reach row with its action, both through the shared row", async () => {
  const state = seedState();
  const atlas = state.agents.find((a) => a.id === ATLAS_ID);
  if (atlas) atlas.audience = { mode: "people", userIds: [], roleIds: [] };
  state.messages.push(
    agentLine("m-reach", { reach: [{ agentId: ATLAS_ID, handle: "atlas", reason: "audience", userId: "u-joao" }] }),
    agentLine(
      "m-skip",
      { notice: { kind: "wake_skipped", text: "A menção não chamou ninguém.", refs: { agentHandles: "atlas" } } },
      "",
    ),
  );
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);

  const row = screen()
    .getByText(/Não consegui chamar o/)
    .closest(".ag-rc") as HTMLElement;
  // The sentence and its action in the kit's action line, after the icon: the action goes under the sentence when
  // they don't fit side by side.
  const line = row.querySelector(":scope > .ac-actline") as HTMLElement;
  expect(line.firstElementChild?.textContent).toContain("só quem cuida dele pode");
  expect(line.querySelector(".ag-rc__btn")?.textContent).toBe("Deixar João falar com ele");
  expect(screen().getByText("A menção de Ada não chamou Atlas")).toBeTruthy();
});
