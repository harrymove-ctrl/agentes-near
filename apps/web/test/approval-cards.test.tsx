import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const row = (id: string) => document.querySelector(`.ap-li[data-id="${id}"]`) as HTMLElement;
const review = () => document.querySelector(".ap-review") as HTMLElement;
const title = () => review().querySelector(".ap-review__title")?.textContent;
const ids = (el: Element) => [...el.querySelectorAll(".ap-li")].map((li) => li.getAttribute("data-id"));

describe("Aprovações: requests sharing a card", () => {
  test("come together under one head with 'Approve all', which decides exactly them", async () => {
    const state = seedState();
    const [merge] = state.approvals;
    if (!merge) throw new Error("no approval");
    const goal = (id: string, month: string, minutes: number) => ({
      ...merge,
      id,
      tool: "goal_upsert",
      title: `Meta de ${month}`,
      detail: `panel.goal_upsert · month=${month}`,
      params: { month },
      createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    });
    state.approvals.splice(0, 1, goal("ap-g1", "2026-11", 3), goal("ap-g2", "2026-12", 2));
    await renderApp(`/org/${ORG_ID}/approvals`, { api: createFakeApi(state) });
    await settle(4);
    const group = document.querySelector(".ap-group") as HTMLElement;
    expect(group.textContent).toContain("Ada pediu 2 coisas de uma vez");
    expect(ids(group)).toEqual(["ap-g1", "ap-g2"]);
    // The request without a card stands alone.
    expect(row("ap-deploy").closest(".ap-group")).toBeNull();
    // Its two buttons are one group: at the head's end, or together under its words, never one under the other.
    const acts = group.querySelector(".ap-group__head > .ap-group__acts") as HTMLElement;
    expect(within(acts).getByRole("button", { name: "Aprovar tudo" })).toBeTruthy();
    expect(within(acts).getByRole("button", { name: "Agora não para todos" })).toBeTruthy();
    // Each request a MediaRow: what it wants on the face's line, where and when under them.
    const first = row("ap-g1");
    expect(first.classList.contains("ac-mediarow")).toBe(true);
    expect(first.querySelector(":scope > .ac-mediarow__head .ap-li__line")).toBeTruthy();
    expect(first.querySelector(":scope > .ac-mediarow__body .ap-li__meta")).toBeTruthy();
    await click(within(group).getByRole("button", { name: "Aprovar tudo" }));
    expect(state.calls.find((c) => c.method === "approvals.decideMany")?.args).toEqual([
      ORG_ID,
      ["ap-g1", "ap-g2"],
      "approve",
    ]);
    expect(state.approvals.filter((a) => a.id.startsWith("ap-g")).map((a) => a.status)).toEqual([
      "approved",
      "approved",
    ]);
  });

  test("waiting requests of one kind in a row: one row, 'Approve all', unfolding into each", async () => {
    const state = seedState();
    const [merge] = state.approvals;
    if (!merge) throw new Error("no approval");
    const sql = (id: string, query: string, minutes: number) => ({
      ...merge,
      id,
      tool: "supabase_execute_sql",
      title: "Supabase: Execute sql",
      detail: `execute_sql · query=${query}`,
      params: { query },
      createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    });
    state.approvals.splice(0, 1, sql("ap-s1", "select 1", 4), sql("ap-s2", "select 2", 3), sql("ap-s3", "select 3", 2));
    await renderApp(`/org/${ORG_ID}/approvals`, { api: createFakeApi(state) });
    await settle(4);
    const run = document.querySelector(".ap-run") as HTMLElement;
    expect(run.getAttribute("aria-label")).toMatch(/^3 pedidos de Ada para /);
    // The row is the run: no group head over it, and its requests folded.
    expect(run.closest(".ap-group")).toBeNull();
    expect(ids(run)).toEqual([]);
    // The run is no one request (no `data-id`); "See each one" unfolds it.
    expect(run.dataset.id).toBeUndefined();
    await click(within(run).getByRole("button", { name: "Ver cada um" }));
    expect(within(run).getByRole("button", { name: "Ver cada um" }).getAttribute("aria-expanded")).toBe("true");
    expect(ids(run)).toEqual(["ap-s1", "ap-s2", "ap-s3"]);
    // Deciding its first request beside the list keeps the rest unfolded.
    await click(row("ap-s1"));
    expect(review().getAttribute("aria-label")).toBe("Fazer um merge");
    await click(review().querySelector('[data-approve="ap-s1"]') as HTMLElement);
    expect(state.calls.find((c) => c.method === "approvals.approve")?.args.slice(0, 2)).toEqual([ORG_ID, "ap-s1"]);
    const rest = document.querySelector(".ap-run") as HTMLElement;
    expect(ids(rest)).toEqual(["ap-s2", "ap-s3"]);
    await click(within(rest).getAllByRole("button", { name: "Aprovar todos" })[0] as HTMLElement);
    expect(state.calls.find((c) => c.method === "approvals.decideMany")?.args).toEqual([
      ORG_ID,
      ["ap-s2", "ap-s3"],
      "approve",
    ]);
  });
});

describe("Approvals: the request beside the list", () => {
  /** The seed's first request as a GitHub comment whose server title is only the tool's name. */
  function withComment() {
    const state = seedState();
    const merge = state.approvals.find((a) => a.id === "ap-merge");
    if (!merge) throw new Error("no approval");
    Object.assign(merge, {
      tool: "add_issue_comment",
      scope: "github:issues.write",
      title: "GitHub: add_issue_comment",
      detail: "add_issue_comment · acme/loja · issue 45",
      connector: "github",
      params: { owner: "acme", repo: "loja", issue_number: 45, body: "Os testes passaram. Pode revisar?" },
    });
    return state;
  }

  test("one row per request; the selected one opens beside it with its facts, its text and the decision bar", async () => {
    const state = withComment();
    await renderApp(`/org/${ORG_ID}/approvals`, { api: createFakeApi(state) });
    await settle(6);
    const list = screen().getByRole("navigation", { name: "Pedidos" });
    expect(list.contains(row("ap-merge"))).toBe(true);
    expect(row("ap-merge").querySelector(".ap-li__line")?.textContent).toBe("Ada quer comentar numa issue");
    expect(row("ap-merge").querySelector(".ap-li__where")?.textContent).toBe("acme/loja #45");
    // Nothing chosen: the first row (closest to expiring) is open.
    expect(row("ap-deploy").getAttribute("aria-current")).toBe("true");
    expect(title()).toBe("Fazer um deploy");

    await click(row("ap-merge"));
    expect(row("ap-merge").getAttribute("aria-current")).toBe("true");
    expect(row("ap-deploy").getAttribute("aria-current")).toBeNull();
    // The server's title was only the tool's name: the tool in words.
    expect(title()).toBe("Comentar numa issue");
    const facts = review().querySelector(".ac-facts") as HTMLElement;
    expect([...facts.querySelectorAll(".ac-facts__label")].map((d) => d.textContent)).toEqual([
      "Onde",
      "Efeito",
      "Prazo",
    ]);
    const values = [...facts.querySelectorAll(".ac-facts__value")].map((d) => d.textContent ?? "");
    expect(values[0]).toContain("acme/loja #45");
    expect(values[1]).toBe("Sai da empresa");
    // The comment it will publish, as it will read.
    expect(review().textContent).toContain("O que vai ser publicado");
    expect(review().querySelector(".ap-review__text")?.textContent).toContain("Os testes passaram. Pode revisar?");
    const bar = review().querySelector(".ap-bar") as HTMLElement;
    expect(bar.querySelector("p")).toBeNull();
    expect(bar.querySelector('[data-approve="ap-merge"]')?.getAttribute("aria-description")).toBe(
      "Ada vai comentar numa issue, só desta vez e com estes valores.",
    );
    await click(bar.querySelector('[data-approve="ap-merge"]') as HTMLElement);
    expect(state.calls.find((c) => c.method === "approvals.approve")?.args).toEqual([ORG_ID, "ap-merge", undefined]);
  });

  test("J and K walk the requests; R opens the reason and Escape backs out of it", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/approvals`, { api: createFakeApi(withComment()) });
    await settle(6);
    const key = async (target: Element, k: string) => {
      await act(async () => fireEvent.keyDown(target, { key: k }));
      await settle(4);
    };
    expect(title()).toBe("Fazer um deploy");
    await key(document.body, "j");
    expect(title()).toBe("Comentar numa issue");
    expect(router.state.location.search).toMatchObject({ open: "ap-merge" });
    expect(document.activeElement).toBe(row("ap-merge"));
    await key(document.body, "k");
    expect(title()).toBe("Fazer um deploy");
    await key(document.body, "j");
    await key(document.body, "r");
    const reason = within(review()).getByLabelText("Por que não?");
    // Escape inside the reason backs out of refusing.
    await key(reason, "Escape");
    expect(within(review()).queryByLabelText("Por que não?")).toBeNull();
    expect(review().querySelector('[data-approve="ap-merge"]')).not.toBeNull();
  });
});

describe("Aprovações: the open request's column", () => {
  test("another request opens at its top, not where the last one was scrolled to", async () => {
    await renderApp(`/org/${ORG_ID}/approvals`, { api: createFakeApi(seedState()) });
    await settle(4);
    const [first, second] = [...document.querySelectorAll<HTMLElement>(".ap-li")];
    if (!first || !second) throw new Error("two requests");
    const before = title();
    review().scrollTop = 400;
    expect(review().scrollTop).toBe(400);
    await click(second);
    expect(title()).not.toBe(before);
    expect(review().scrollTop).toBe(0);
  });
});
