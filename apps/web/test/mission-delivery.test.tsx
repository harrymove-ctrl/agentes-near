import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message, Mission, MissionDelivery } from "@agenteschat/client";
import { isOpenMission, waitingText } from "@agenteschat/client/lib/missions";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { MissionStatusChip, missionStatusKey, missionSummaryStatusKey } from "@/components/missions/MissionBits";
import { MissionDeliveryCard } from "@/components/missions/MissionCards";
import { createI18n } from "@/i18n";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

async function withDelivery(patch: Partial<MissionDelivery> = {}, missionPatch: Partial<Mission> = {}) {
  const state = seedState();
  const api = createFakeApi(state);
  const mission = await api.missions.create(ORG_ID, {
    agentId: ADA_ID,
    goal: "Fotos",
    title: "Fotos",
    channelId: ENG_ID,
  });
  const me = (await api.account.me())?.user.id ?? "";
  const delivery: MissionDelivery = {
    id: "00000000-0000-4000-8000-0000000000d1",
    missionId: mission.id,
    taskId: null,
    messageId: "msg-delivery",
    auto: false,
    summary: "Redimensionei as 40 fotos e subi o zip no Drive.",
    artifactIds: [],
    paths: [],
    checklist: [
      { id: "c1", text: "Abrir o zip e ver 3 fotos", checkedBy: [] },
      { id: "c2", text: "Conferir os nomes dos arquivos", checkedBy: [] },
    ],
    status: "pending",
    note: null,
    saveToWiki: false,
    decidedBy: null,
    decidedAt: null,
    createdAt: new Date().toISOString(),
    ...patch,
  };
  const live: Mission = { ...mission, status: "awaiting_close", startedAt: new Date().toISOString(), ...missionPatch };
  const calls: { method: string; args: unknown[] }[] = [];
  api.missions.get = async () => ({ ...live });
  api.missions.deliveries = async () => [structuredClone(delivery)];
  api.missions.checkDelivery = async (_o, _m, _d, itemId, checked) => {
    calls.push({ method: "check", args: [itemId, checked] });
    const item = delivery.checklist.find((c) => c.id === itemId);
    if (item) item.checkedBy = checked ? [me] : [];
    return structuredClone(delivery);
  };
  api.missions.acceptDelivery = async (_o, _m, _d, input) => {
    calls.push({ method: "accept", args: [input] });
    Object.assign(delivery, { status: "accepted", decidedBy: me, decidedAt: new Date().toISOString() });
    Object.assign(live, { status: "done" });
    return { ...live };
  };
  api.missions.requestDeliveryChanges = async (_o, _m, _d, note) => {
    calls.push({ method: "changes", args: [note] });
    Object.assign(delivery, { status: "changes_requested", note, decidedBy: me, decidedAt: new Date().toISOString() });
    Object.assign(live, { status: "active" });
    return { ...live };
  };
  const message: Message = {
    id: "msg-delivery",
    channelId: ENG_ID,
    threadId: mission.threadId,
    author: { type: "agent", id: ADA_ID },
    body: "Delivered",
    mentionedAgentIds: [],
    agentRunId: null,
    meta: { missionDelivery: { missionId: mission.id, id: delivery.id } },
    createdAt: new Date().toISOString(),
  };
  await renderPage(<MissionDeliveryCard message={message} />, { api, org: true });
  await settle(6);
  return { calls, delivery };
}

const card = () => screen().getByRole("region", { name: "Entrega da missão" });

describe("the delivery card", () => {
  test("summary, O que conferir checked per person, Concluir missão with Salvar na wiki", async () => {
    const { calls } = await withDelivery();
    expect(card().textContent).toContain("Fotos: pronto para você conferir");
    expect(card().textContent).toContain("Redimensionei as 40 fotos");
    expect(card().textContent).toContain("Esperando você concluir");
    const check = within(card()).getByRole("region", { name: "O que conferir" });
    expect(check.textContent).toContain("0 de 2");
    await act(async () => fireEvent.click(within(check).getByLabelText("Abrir o zip e ver 3 fotos")));
    await settle(4);
    expect(calls[0]).toEqual({ method: "check", args: ["c1", true] });
    expect(within(card()).getByRole("region", { name: "O que conferir" }).textContent).toContain("1 de 2");
    expect(within(card()).getByRole("switch", { name: "Salvar decisões e lições na wiki" })).toBeTruthy();
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Concluir missão" })));
    await settle(4);
    expect(calls.at(-1)).toEqual({ method: "accept", args: [{ saveToWiki: true }] });
    expect(card().textContent).toContain("Missão concluída");
  });

  test("its summary reads as Markdown", async () => {
    await withDelivery({ summary: "- **Fotos:** 40 em `zip`" });
    expect(card().querySelector("li strong")?.textContent).toBe("Fotos:");
    expect(card().querySelector("code")?.textContent).toBe("zip");
  });

  test("Pedir ajustes: an inline note that resumes the work", async () => {
    const { calls } = await withDelivery();
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Pedir ajustes" })));
    const box = within(card()).getByRole("textbox", { name: "O que ajustar" });
    await act(async () => fireEvent.change(box, { target: { value: "Faltou a foto da capa" } }));
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: "Enviar ajustes" })));
    await settle(4);
    expect(calls.at(-1)).toEqual({ method: "changes", args: ["Faltou a foto da capa"] });
    expect(card().textContent).toContain("Ajustes pedidos");
  });

  test("the automatic 'Tudo pronto' card; read-only for who doesn't decide", async () => {
    await withDelivery({ auto: true, summary: "", checklist: [] }, { canAct: false, role: "comment" });
    expect(card().textContent).toContain("Tudo pronto");
    expect(card().textContent).toContain("Pronta para concluir");
    expect(within(card()).queryByRole("button", { name: "Concluir missão" })).toBeNull();
  });
});

describe("awaiting_close", () => {
  test("open, waiting on whoever concludes, its own words and no pause icon", async () => {
    const m = {
      status: "awaiting_close" as const,
      runningTasks: 0,
      canAct: true,
      agentId: ADA_ID,
      pending: {
        decisions: 0,
        provisional: 0,
        reviews: 0,
        suggestions: 0,
        joinRequests: 0,
        commands: 0,
        deliveries: 1,
      },
    };
    expect(isOpenMission(m)).toBe(true);
    expect(missionStatusKey(m)).toBe("awaitingClose");
    expect(missionStatusKey({ ...m, canAct: false })).toBe("readyToClose");
    expect(missionSummaryStatusKey({ status: "awaiting_close", waitingYou: 1 }, false)).toBe("awaitingClose");
    const i18n = createI18n("pt-BR");
    expect(waitingText(i18n.t, m)).toBe("1 entrega para concluir");
    await renderPage(<MissionStatusChip mission={m} />, { api: createFakeApi(seedState()), org: true });
    expect(document.body.textContent).toContain("Esperando você concluir");
    expect(document.querySelector(".ac-chip--waiting")).toBeTruthy();
  });
});
