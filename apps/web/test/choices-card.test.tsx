import { afterEach, expect, test } from "bun:test";
import { ApiError, type ArtifactDetail } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { ChoicesCard } from "@/components/blocks/ChoicesCard";
import { ADA_ID, createFakeApi } from "./fake-api";
import { renderPage, settle } from "./render";

afterEach(cleanup);

const QUESTIONS = [
  { question: "Quando?", options: [{ label: "Hoje" }, { label: "Amanhã" }] },
  { question: "Quem revisa?", options: [{ label: "Lia" }, { label: "Theo" }] },
];

async function card(questions = QUESTIONS, answer?: () => Promise<never>) {
  const api = createFakeApi();
  api.artifacts.get = async (_orgId, id) =>
    ({
      id,
      title: "Revisão",
      kind: "choices",
      createdBy: { type: "agent", id: ADA_ID },
      shownVersion: 1,
      content: { kind: "choices", questions },
    }) as unknown as ArtifactDetail;
  if (answer) api.artifacts.answerChoices = answer;
  await renderPage(<ChoicesCard id="card-1" />, { api, org: true });
  await settle(6);
}

const focused = () => document.activeElement as HTMLElement;
const key = async (k: string) => {
  await act(async () => fireEvent.keyDown(focused(), { key: k }));
  await settle(4);
};

test("Left and Right keep the focus on the card's options, so letter keys keep answering", async () => {
  await card();
  (document.querySelector(".choices__option") as HTMLElement).focus();
  await key("a");
  expect(focused().textContent).toContain("Lia");
  await key("ArrowLeft");
  expect(focused().className).toContain("choices__option");
  expect(focused().textContent).toContain("Hoje");
  await key("ArrowRight");
  expect(focused().textContent).toContain("Lia");
});

test("someone answering first is no failure: no 'try again'; another error still says it", async () => {
  const one = [QUESTIONS[0] as (typeof QUESTIONS)[number]];
  await card(one, async () => {
    throw new ApiError(409, "choices.answered", "This card was already answered");
  });
  await act(async () => fireEvent.click(document.querySelector(".choices__option") as HTMLElement));
  await settle(6);
  expect(document.querySelector(".ac-toast")?.textContent ?? null).toBeNull();
  cleanup();
  await card(one, async () => {
    throw new ApiError(500, "internal", "boom");
  });
  await act(async () => fireEvent.click(document.querySelector(".choices__option") as HTMLElement));
  await settle(6);
  const toasts = [...document.querySelectorAll(".ac-toast")].map((t) => t.textContent);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toContain("Não deu para mandar sua escolha");
});

test("Outra resposta: the last row opens a field; Enter sends what was written, and the card shows it", async () => {
  const sent: unknown[] = [];
  const one = [{ question: "Qual cor?", options: [{ label: "Azul" }, { label: "Verde" }] }];
  const api = createFakeApi();
  api.artifacts.get = async (_orgId, id) =>
    ({
      id,
      title: "Teste do cartão",
      kind: "choices",
      createdBy: { type: "agent", id: ADA_ID },
      shownVersion: 1,
      content: { kind: "choices", questions: one },
    }) as unknown as ArtifactDetail;
  const answer = api.artifacts.answerChoices;
  api.artifacts.answerChoices = (...args) => {
    sent.push(args.slice(2));
    return answer(...args);
  };
  await renderPage(<ChoicesCard id="card-1" />, { api, org: true });
  await settle(6);
  const rows = [...document.querySelectorAll(".choices__option")];
  expect(rows.map((r) => r.textContent)).toEqual(["AAzul", "BVerde", "COutra resposta"]);
  await act(async () => fireEvent.click(rows[2] as HTMLElement));
  await settle(2);
  // Opening it sends nothing: the person writes first.
  expect(sent).toEqual([]);
  const field = document.querySelector(".choices__write textarea") as HTMLTextAreaElement;
  expect(document.activeElement).toBe(field);
  await act(async () => fireEvent.change(field, { target: { value: "  Um vermelho bem escuro  " } }));
  await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
  await settle(6);
  expect(sent).toHaveLength(1);
  expect((sent[0] as unknown[])[0]).toEqual([2]);
  expect((sent[0] as unknown[])[2]).toEqual(["Um vermelho bem escuro"]);
  const picked = document.querySelector(".choices__picked") as HTMLElement;
  expect(picked.textContent).toBe("CUm vermelho bem escuro");
});

test("Outra resposta by its letter key; Cancelar closes the field and sends nothing", async () => {
  await card();
  (document.querySelector(".choices__option") as HTMLElement).focus();
  await key("c");
  const field = document.querySelector(".choices__write textarea") as HTMLTextAreaElement;
  expect(field).toBeTruthy();
  const cancel = [...document.querySelectorAll(".choices__write button")].find((b) => b.textContent === "Cancelar");
  await act(async () => fireEvent.click(cancel as HTMLElement));
  await settle(2);
  expect(document.querySelector(".choices__write")).toBeNull();
  expect(document.querySelector(".choices__picked")).toBeNull();
});

test("an agent's code between backticks stays code: in the question and in the summary once answered", async () => {
  await card([
    { question: "Rodo `bun test` antes do merge?", options: [{ label: "Sim" }, { label: "Não" }] },
    QUESTIONS[1] as (typeof QUESTIONS)[number],
  ]);
  expect(document.querySelector(".choices__question code.ac-inlinecode")?.textContent).toBe("bun test");
  await act(async () => fireEvent.click(document.querySelector(".choices__option") as HTMLElement));
  await settle(4);
  await act(async () => fireEvent.click(document.querySelector(".choices__option") as HTMLElement));
  await settle(6);
  expect(document.querySelector(".choices__asked code.ac-inlinecode")?.textContent).toBe("bun test");
});
