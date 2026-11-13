import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { cleanup } from "@testing-library/react";
import { MissionPlanChangeLine } from "@/components/missions/MissionCards";
import { ADA_ID, createFakeApi, ENG_ID, seedState } from "./fake-api";
import { renderPage, settle } from "./render";

afterEach(() => cleanup());

const line = (change: Record<string, unknown>): Message => ({
  id: "m-plan",
  channelId: ENG_ID,
  threadId: "root",
  author: { type: "agent", id: ADA_ID },
  body: "Plan updated",
  mentionedAgentIds: [],
  agentRunId: null,
  meta: { missionPlanChange: { missionId: "mission_1", ...change } },
  createdAt: new Date().toISOString(),
});

describe("Plano atualizado", () => {
  test("one pill: the icon beside the text in its frame, short changes listed whole", async () => {
    await renderPage(
      <MissionPlanChangeLine message={line({ added: [{ id: "i1", title: "Login" }], removed: [], changed: [] })} />,
      {
        api: createFakeApi(seedState()),
        org: true,
      },
    );
    await settle(2);
    const row = document.querySelector(".mi-evt") as HTMLElement;
    // The icon and the words in one row of the pill's frame.
    const main = row.querySelector(".ac-eventpill__main") as HTMLElement;
    expect(main.children[0]?.querySelector("svg")).not.toBeNull();
    expect(main.querySelector(".mi-evt__text")?.textContent).toContain("Plano atualizado: + Login");
  });

  test("a long change folds into '+N itens editados'", async () => {
    await renderPage(
      <MissionPlanChangeLine
        message={line({
          added: ["Telas", "Login", "Fotos", "Pagamentos", "Notificações"].map((title, i) => ({ id: `i${i}`, title })),
          removed: [],
          changed: [],
        })}
      />,
      { api: createFakeApi(seedState()), org: true },
    );
    await settle(2);
    const text = (document.querySelector(".mi-evt") as HTMLElement).textContent ?? "";
    expect(text).toContain("+ Telas · + Login");
    expect(text).toContain("+3 itens editados");
    expect(text).not.toContain("Notificações");
  });
});
