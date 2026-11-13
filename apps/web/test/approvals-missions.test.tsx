import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { MissionCommand, MissionDecision } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

async function setup() {
  const api = createFakeApi(seedState());
  const mission = await api.missions.create(ORG_ID, { agentId: ADA_ID, goal: "App mobile", channelId: ENG_ID });
  const command: MissionCommand = {
    id: "00000000-0000-4000-8000-00000000cc01",
    missionId: mission.id,
    taskId: "00000000-0000-4000-8000-00000000aa01",
    tool: "Bash",
    command: "swift build -c release",
    state: "pending",
    rules: ["Bash(swift build *)"],
    decidedBy: null,
    decidedAt: null,
    always: false,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  const decision: MissionDecision = {
    id: "00000000-0000-4000-8000-00000000dd01",
    missionId: mission.id,
    taskId: null,
    messageId: "msg-decision-1",
    question: "Expo ou React Native puro?",
    options: ["Expo", "React Native"],
    recommendation: "Expo",
    why: null,
    impact: null,
    blocking: true,
    status: "pending",
    chosen: null,
    chosenBy: null,
    chosenAt: null,
    opinions: [],
    createdAt: new Date().toISOString(),
  };
  const decided: string[] = [];
  const waiting = {
    ...mission,
    canAct: true,
    pending: { ...mission.pending, commands: 1, decisions: 1 },
  };
  api.missions.list = async (_org, query) =>
    query?.status === "waiting_you"
      ? { missions: [waiting], counts: { active: 1, waitingYou: 1, closed: 0 } }
      : { missions: [], counts: { active: 1, waitingYou: 1, closed: 0 } };
  api.missions.get = async () => ({ ...waiting });
  api.missions.commands = async () => ({ commands: [{ ...command }], rules: [] });
  api.missions.decisions = async () => [{ ...decision }];
  api.missions.decideCommand = async (_org, _mission, _id, d) => {
    decided.push(d);
    Object.assign(command, { state: d === "deny" ? "denied" : "allowed", always: d === "always" });
    return { ...command };
  };
  return { api, mission, decided };
}

describe("Aprovações: missions", () => {
  test("a pending command card with its mission, Aprovar / Recusar / Aprovar sempre, counted in Esperando você", async () => {
    const { api, decided } = await setup();
    const approvals = (await api.approvals.list(ORG_ID)).filter((a) => a.status === "pending").length;
    await renderApp(`/org/${ORG_ID}/approvals`, { api });
    await settle(8);
    const section = screen().getByRole("region", { name: "Comandos para aprovar" });
    expect(section.textContent).toContain("swift build -c release");
    expect(section.textContent).toContain("App mobile");
    expect(within(section).getByRole("link", { name: "App mobile" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Recusar" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: /Aprovar sempre/ })).toBeTruthy();
    const pill = within(screen().getByRole("radiogroup", { name: "Filtro" })).getByRole("radio", {
      name: /^Esperando você/,
    });
    expect(pill.textContent).toBe(`Esperando você${approvals + 1}`);
    // Listed under the requests, the missions would sit under columns that fill the window: the page scrolls as one.
    const split = document.querySelector(".ap-split");
    expect(split?.compareDocumentPosition(section)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(split?.classList.contains("page-split")).toBe(false);
    await act(async () => fireEvent.click(within(section).getByRole("button", { name: "Aprovar" })));
    await settle(4);
    expect(decided).toEqual(["allow"]);
  });

  test("Esperando você em missões: a pending decision links to its card in the thread", async () => {
    const { api, mission } = await setup();
    await renderApp(`/org/${ORG_ID}/approvals`, { api });
    await settle(8);
    const list = screen().getByRole("region", { name: "Esperando você em missões" });
    expect(list.textContent).toContain("Expo ou React Native puro?");
    expect(list.textContent).toContain("Decisão");
    const open = within(list).getByRole("link", { name: "Abrir" });
    expect(open.getAttribute("href")).toBe(`/org/${ORG_ID}/threads/${mission.threadId}?m=msg-decision-1`);
  });
});

describe("Approvals: the open request", () => {
  test("how it got here: the run's steps before the ask, then the ask itself, on one track", async () => {
    const state = seedState();
    const merge = state.approvals.find((a) => a.id === "ap-merge");
    if (!merge?.runId) throw new Error("no approval");
    const asked = Date.parse(merge.createdAt);
    const at = (seconds: number) => new Date(asked + seconds * 1000).toISOString();
    state.runSteps = {
      [merge.runId]: [
        { seq: 1, kind: "tool_call", data: { toolUseId: "c1", name: "search_context", input: {} }, createdAt: at(-60) },
        { seq: 2, kind: "tool_result", data: { toolUseId: "c1", content: "ok" }, createdAt: at(-59) },
        { seq: 3, kind: "tool_call", data: { toolUseId: "c2", name: "read_wiki_page", input: {} }, createdAt: at(-30) },
        { seq: 4, kind: "tool_result", data: { toolUseId: "c2", content: "ok" }, createdAt: at(-29) },
        // The call that waits on the decision: the ask stands for it.
        {
          seq: 5,
          kind: "tool_call",
          data: { toolUseId: "c3", name: "github_merge_pull_request", connector: "github", input: {} },
          createdAt: at(0),
        },
      ],
    };
    await renderApp(`/org/${ORG_ID}/approvals?open=ap-merge`, { api: createFakeApi(state) });
    await settle(8);
    const pane = screen().getByRole("region", { name: "Fazer um merge" });
    const track = within(pane).getByRole("list", { name: "Como chegou aqui" });
    const steps = [...track.querySelectorAll(".ac-track__step")];
    expect(steps.map((li) => [...li.classList].find((c) => c.startsWith("is-")))).toEqual([
      "is-done",
      "is-done",
      "is-now",
    ]);
    expect(steps.at(-1)?.querySelector(".ac-track__label")?.textContent).toBe("Pediu aprovação");
    // "See each step" unfolds them as the reply's tool block.
    await act(async () => fireEvent.click(within(pane).getByRole("button", { name: "Ver cada passo" })));
    await settle(4);
    expect(within(pane).getByRole("button", { name: "Esconder os passos" }).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("Aprovações: asked of a role (request_approval)", () => {
  test("waits for the role, not the agent's owner; the role decides, and the requester who approves by role is said", async () => {
    const state = seedState();
    const merge = state.approvals.find((a) => a.id === "ap-merge");
    if (!merge) throw new Error("no approval");
    Object.assign(merge, {
      tool: "request_approval",
      canDecide: false,
      approvers: { label: "Diretoria", requestedByUserId: "u-requester", requesterDecides: true },
    });
    await renderApp(`/org/${ORG_ID}/approvals?open=ap-merge`, { api: createFakeApi(state) });
    await settle(8);
    const row = document.querySelector('.ap-li[data-id="ap-merge"]');
    expect(row?.querySelector(".ap-li__left")?.textContent).toBe("Aguardando Diretoria");
    // Beside the list: who decides is the role, and the bar says the requester may decide too, without buttons.
    const pane = document.querySelector(".ap-review") as HTMLElement;
    const facts = [...pane.querySelectorAll(".ac-facts__item")].map((f) => [
      f.querySelector(".ac-facts__label")?.textContent,
      f.querySelector(".ac-facts__value")?.textContent,
    ]);
    expect(facts).toContainEqual(["Quem decide", "Aguardando Diretoria"]);
    expect(pane.querySelector(".ap-bar__text")?.textContent).toContain("Pedido por quem também aprova pela função");
    expect(pane.querySelector("[data-approve]")).toBeNull();
  });
});
