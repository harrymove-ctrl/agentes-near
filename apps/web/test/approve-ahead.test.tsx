import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ApiClient, Routine } from "@agenteschat/client";
import { nextLabel } from "@agenteschat/client/lib/format";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const EXEC = "composio_COMPOSIO_MULTI_EXECUTE_TOOL";
const TITLE = "Composio: LINKEDIN_PUBLISH_POST";
/** The same action in the person's words, as the app shows it. */
const SHOWN = "Publicar post (LinkedIn)";
const RUN_AT = new Date(Date.now() + 26 * 3_600_000).toISOString();
const WHEN = nextLabel("pt-BR", RUN_AT);

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

/**
 * The seed's request in #eng as a post prepared for later (`schedule_action`), in `status`; `lapsed`: approved, and
 * its time and grace went by without its run doing it.
 */
function withAhead(status: "pending" | "approved" | "lapsed") {
  const state = seedState();
  const first = state.approvals[0];
  if (!first) throw new Error("no approval");
  Object.assign(first, {
    tool: EXEC,
    scope: "custom:conn-composio:write",
    title: TITLE,
    detail: 'COMPOSIO_MULTI_EXECUTE_TOOL · tools=[{"tool_slug":"LINKEDIN_PUBLISH_POST"}]',
    connector: "custom:conn-composio",
    status: status === "lapsed" ? "expired" : status,
    runAt: status === "lapsed" ? new Date(Date.now() - 3 * 3_600_000).toISOString() : RUN_AT,
    routineId: "rt-post",
    ...(status === "pending"
      ? {}
      : {
          canDecide: false,
          canCancel: status === "approved",
          decidedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
          decidedByUserId: "u-joao",
        }),
  });
  return state;
}

describe("an action approved ahead, in the conversation", () => {
  test("its request says it approves a future action, and when it runs by itself", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(withAhead("pending")) });
    await settle(4);
    const card = screen().getByRole("group", { name: "Pedido de aprovação" });
    expect(card.querySelector(".ap-ask__ahead")?.textContent).toBe(
      `Aprova uma ação futura: roda sozinha ${WHEN}, sem pedir de novo`,
    );
    expect(within(card).getByRole("button", { name: "Aprovar" })).toBeTruthy();
  });

  test("approved, it says when it goes out, and Cancelar withdraws it", async () => {
    const state = withAhead("approved");
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    const card = screen().getByRole("group", { name: "Aprovação concluída" });
    expect(card.textContent).toContain(`Agendado para ${WHEN}`);
    await click(within(card).getByRole("button", { name: "Cancelar" }));
    expect(state.calls.filter((c) => c.method === "approvals.cancel").map((c) => c.args)).toEqual([
      [ORG_ID, "ap-merge"],
    ]);
    expect(screen().getByRole("status").textContent).toContain("Cancelado. A ação não vai rodar.");
  });
});

describe("actions approved ahead, on one shared card", () => {
  /** Two posts prepared for later on the seed's card: the first in `firstStatus`, the second waiting. */
  function twoAhead(firstStatus: "pending" | "approved") {
    const state = withAhead(firstStatus);
    const [first] = state.approvals;
    if (!first) throw new Error("no approval");
    state.approvals.splice(1, 0, {
      ...first,
      id: "ap-ahead-2",
      status: "pending",
      canDecide: true,
      canCancel: false,
      decidedAt: null,
      decidedByUserId: null,
      createdAt: new Date(Date.parse(first.createdAt) + 60_000).toISOString(),
    });
    return state;
  }
  const items = () =>
    [...screen().getByRole("group", { name: "Pedido de aprovação" }).querySelectorAll(".rq__item")] as HTMLElement[];

  test("each waiting item says it approves a future action, and when", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(twoAhead("pending")) });
    await settle(4);
    // Two waiting requests of one kind fold into one run; unfolded, each still says it for itself.
    await click(
      within(screen().getByRole("group", { name: "Pedido de aprovação" })).getByRole("button", { name: "Ver cada um" }),
    );
    expect(items()).toHaveLength(2);
    for (const item of items()) {
      expect(item.textContent).toContain(`Aprova uma ação futura: roda sozinha ${WHEN}, sem pedir de novo`);
    }
  });

  test("an approved item says when it goes out, and Cancelar withdraws it", async () => {
    const state = twoAhead("approved");
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    const [done] = items();
    if (!done) throw new Error("no item");
    expect(done.textContent).toContain(`Agendado para ${WHEN}`);
    await click(within(done).getByRole("button", { name: "Cancelar" }));
    expect(state.calls.filter((c) => c.method === "approvals.cancel").map((c) => c.args)).toEqual([
      [ORG_ID, "ap-merge"],
    ]);
  });
});

describe("an action approved ahead, on Aprovações", () => {
  /** The request, open beside the list. */
  const review = async (state: ReturnType<typeof seedState>) => {
    await renderApp(`/org/${ORG_ID}/approvals?open=ap-merge`, { api: createFakeApi(state) });
    await settle(8);
    const pane = screen().getByRole("region", { name: SHOWN });
    expect(pane.classList.contains("ap-review")).toBe(true);
    return pane;
  };

  test("the open request says it approves a future action, and what approving now covers", async () => {
    const pane = await review(withAhead("pending"));
    expect(pane.querySelector(".ap-card__ahead")?.textContent).toBe(
      `Aprova uma ação futura: roda sozinha ${WHEN}, sem pedir de novo`,
    );
    expect(pane.querySelector(".ap-bar p")).toBeNull();
    expect(pane.querySelector("[data-approve]")?.getAttribute("aria-description")).toBe(
      `Aprovar agora vale para ${WHEN}.`,
    );
    expect(pane.textContent).not.toContain("Aprovar roda a ação na hora.");
  });

  test("approved, the open request says when it runs, and Cancel withdraws it", async () => {
    const state = withAhead("approved");
    const outcome = (await review(state)).querySelector(".ap-outcome") as HTMLElement;
    expect(outcome.textContent).toContain(`Agendado para ${WHEN}`);
    await click(within(outcome).getByRole("button", { name: "Cancelar" }));
    expect(state.calls.filter((c) => c.method === "approvals.cancel").map((c) => c.args)).toEqual([
      [ORG_ID, "ap-merge"],
    ]);
  });

  test("approved but not done by its run in time, it says so, not that nobody decided", async () => {
    const pane = await review(withAhead("lapsed"));
    expect(pane.querySelector(".ap-outcome")?.textContent).toContain(
      "Aprovada, mas não rodou a tempo. Nada foi feito.",
    );
    expect(document.body.textContent).not.toContain("Ninguém decidiu em 24 h");
    expect(within(pane).queryByRole("button", { name: "Pedir de novo" })).toBeNull();
  });
});

describe("an action approved ahead, on its routine's page", () => {
  test("listed with when it runs, and Cancelar withdraws it", async () => {
    const state = seedState();
    const base = createFakeApi(state);
    const canceled: string[] = [];
    const routine: Routine = {
      id: "rt-post",
      name: "Post de lançamento",
      agentId: ATLAS_ID,
      prompt: "Post de lançamento",
      target: { type: "conversation", channelId: ENG_ID, threadId: null, reminder: false },
      trigger: { type: "once", at: RUN_AT, timezone: "America/Sao_Paulo", description: "" },
      active: true,
      nextRunAt: RUN_AT,
      createdAt: new Date().toISOString(),
      access: "act",
      report: "when_new",
      pausedReason: null,
      failuresInRow: 0,
      state: "active",
      waitingFor: null,
      brain: { kind: "model", machineName: null },
      health: { ok: 0, silent: 0, failed: 0, skipped: 0, missed: 0, total: 0 },
      canSeeDetails: true,
      canManage: true,
      lastRun: null,
      recentRuns: [],
      usage: { runs: 0, tokens: 0, costNanoUsd: 0, billedTo: "api" },
      ahead: [
        {
          id: "ap-post",
          tool: EXEC,
          scope: "custom:conn-composio:write",
          title: TITLE,
          params: {},
          status: "approved",
          runAt: RUN_AT,
          canCancel: true,
        },
      ],
    };
    const api: ApiClient = {
      ...base,
      routines: { ...base.routines, list: async () => [structuredClone(routine)], runs: async () => [] },
      approvals: {
        ...base.approvals,
        cancel: async (_orgId, id) => {
          canceled.push(id);
          routine.ahead = [];
          return { ...state.approvals[0], id, status: "canceled" } as Awaited<
            ReturnType<ApiClient["approvals"]["cancel"]>
          >;
        },
      },
    };
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    await click(
      within(screen().getByRole("article", { name: "Post de lançamento" })).getByRole("button", {
        name: "Post de lançamento",
      }),
    );
    const panel = screen().getByRole("dialog", { name: "Post de lançamento" });
    const section = within(panel).getByText("Preparado para depois").closest("section") as HTMLElement;
    expect(section.textContent).toContain(SHOWN);
    expect(section.textContent).toContain(`Aprovada · roda ${WHEN}`);
    // A ghost at the row's end, in an actions row: its word on the box's padding line, as the tile's on the left.
    const cancel = within(section).getByRole("button", { name: "Cancelar" });
    expect(cancel.parentElement?.classList.contains("ac-acts")).toBe(true);
    await click(cancel);
    expect(canceled).toEqual(["ap-post"]);
  });
});
