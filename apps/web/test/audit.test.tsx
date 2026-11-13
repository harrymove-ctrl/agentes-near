import { afterAll, afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AuditRow } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle, showIn } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
/**
 * The rows are minutes and a day old, and the list groups them by day: at noon, so they never straddle midnight (a
 * run just past it put them all on Ontem). Only the clock the app reads; timers still run.
 */
const NOON = new Date();
NOON.setHours(12, 0, 0, 0);
setSystemTime(NOON);
afterAll(() => setSystemTime());
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const row = (over: Partial<AuditRow> & Pick<AuditRow, "id">): AuditRow => ({
  at: at(5),
  actor: { type: "agent", id: ADA_ID, name: "Ada" },
  action: "tool.call",
  target: { type: "tool", id: "create_issue" },
  details: { kind: "internal", behind: "person", input: {} },
  runId: "run-1",
  channelId: GENERAL_ID,
  channel: { id: GENERAL_ID, name: "general", kind: "channel" },
  onBehalfOf: { id: "u-walter", name: "Walter" },
  outcome: "done",
  approval: null,
  secret: null,
  ...over,
});

const AUDIT: AuditRow[] = [
  row({
    id: "a5",
    actor: { type: "agent", id: ATLAS_ID, name: "Atlas" },
    target: { type: "tool", id: "railway_deploy" },
    details: {
      kind: "external",
      connector: "Railway",
      title: "Railway: Deploy api",
      behind: "person",
      reason: "The login broke after the last deploy.",
      approvalId: "ap-1",
      input: { service: "api" },
    },
    outcome: "pending",
    approval: { id: "ap-1", status: "pending", decidedBy: null },
  }),
  row({
    id: "a4",
    target: { type: "tool", id: "drive_delete" },
    details: {
      kind: "internal",
      behind: "person",
      reason: "Not allowed: Ada lacks the scope drive:write",
      refusal: "noAccess",
      input: { file: "contratos-2025.pdf", apiKey: "***" },
    },
    outcome: "refused",
  }),
  row({
    id: "a3",
    target: { type: "tool", id: "sentry_list_issues" },
    details: { kind: "read", connector: "Sentry", title: "Sentry: List issues", behind: "person", input: {} },
  }),
  row({
    id: "a2",
    details: { kind: "internal", behind: "routine", routine: { id: "r1", name: "Follow-up" }, input: {} },
  }),
  row({
    id: "a1",
    at: at(60 * 24),
    actor: { type: "person", id: "u-walter", name: "Walter" },
    action: "routine.created",
    target: { type: "routine", id: "r1" },
    details: { name: "Follow-up" },
    runId: null,
    channelId: null,
    channel: null,
    onBehalfOf: null,
    outcome: null,
  }),
];

const go = async (state = seedState({ audit: AUDIT })) => {
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/settings/audit`, { api });
  await settle(6);
  return { api, r, state };
};
const section = () => screen().getByRole("region", { name: "Auditoria" });
const titles = () => [...section().querySelectorAll(".audit-row__title")].map((e) => e.textContent);

describe("Configurações → Auditoria", () => {
  test("one list by day: who did what, asked by whom, where, and how it ended", async () => {
    await go();
    expect(titles()).toEqual([
      "Atlas usou o Railway",
      "Ada usou a ferramenta drive delete",
      "Ada consultou o Sentry",
      "Ada criou uma tarefa",
      "Walter criou uma rotina",
    ]);
    const first = section().querySelector(".audit-row") as HTMLElement;
    // About what in words, as the call's approval card says it, never "Railway: Deploy api".
    expect(first.textContent).toContain("Fazer um deploy · pedido por Walter · #general");
    expect(first.textContent).toContain("Esperando aprovação");
    expect(section().textContent).toContain("rotina Follow-up");
    expect([...section().querySelectorAll(".ac-grouphead")].map((d) => d.textContent)).toEqual(["Hoje", "Ontem"]);
  });

  // The worst case for CI's geometry check: the toolbar's view and agent and the days' headings in German, then in
  // Japanese. On a phone each control fills its line, never alone beside an empty stretch.
  test("in German and Japanese the toolbar and the days' headings keep their places", async () => {
    const { r } = await go();
    for (const [lang, problems] of [
      ["de", "Abgelehnt und fehlgeschlagen"],
      ["ja", "却下と失敗"],
    ] as const) {
      await showIn(r.services, lang);
      const audit = document.querySelector(".audit") as HTMLElement;
      expect(audit.querySelectorAll(":scope > .ac-toolbar")).toHaveLength(1);
      expect(audit.querySelector(".ac-toolbar")?.textContent).toContain(problems);
      expect(audit.querySelectorAll(".ac-grouphead")).toHaveLength(2);
    }
  });

  test("a row that didn't end in anything keeps its time in the last column, on a phone too", async () => {
    await go();
    const change = [...section().querySelectorAll(".audit-row")].at(-1) as HTMLElement;
    expect(change.textContent).toContain("Walter criou uma rotina");
    // An empty box in the outcome's place takes the time's cell on a phone's three columns.
    expect([...change.children].filter((c) => c.childElementCount === 0 && !c.textContent?.trim())).toHaveLength(0);
    const css = (await Bun.file(new URL("../src/components/audit.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(css).toMatch(/\.audit-row__time \{[^}]*grid-column: -2;/);
  });

  test("the shortcuts: what went wrong, what waits, people's changes", async () => {
    await go();
    await click(within(section()).getByRole("radio", { name: "Recusadas e falhas" }));
    await settle(4);
    expect(titles()).toEqual(["Ada usou a ferramenta drive delete"]);
    await click(within(section()).getByRole("radio", { name: "Esperando" }));
    await settle(4);
    expect(titles()).toEqual(["Atlas usou o Railway"]);
    await click(within(section()).getByRole("radio", { name: "Mudanças de pessoas" }));
    await settle(4);
    expect(titles()).toEqual(["Walter criou uma rotina"]);
  });

  test("a row opens the thread's panel: the reason, what was sent (secrets hidden), the conversation", async () => {
    await go();
    const refused = [...section().querySelectorAll<HTMLElement>(".audit-row")][1] as HTMLElement;
    await click(refused);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    expect(panel.classList.contains("thread-panel")).toBe(true);
    // Why, in words; what the gateway said is the agent's English, in the technical part only.
    expect(panel.textContent).toContain("Por que foi recusado: O agente não tem acesso a isso");
    expect(panel.querySelector(".audit-panel__reason")?.textContent).not.toContain("drive:write");
    expect(panel.querySelector(".audit-panel__tech")?.textContent).toContain(
      "O que respondeuNot allowed: Ada lacks the scope drive:write",
    );
    expect(panel.textContent).toContain("contratos-2025.pdf");
    expect(panel.textContent).toContain("escondido");
    expect(panel.textContent).not.toContain("***");
    expect(within(panel).getByRole("link", { name: "Abrir conversa" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/c/${GENERAL_ID}`,
    );
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    expect(screen().queryByRole("complementary", { name: "Detalhe da auditoria" })).toBeNull();
  });

  test("a change's details never list ids, and say each field in words", async () => {
    const change = row({
      id: "c1",
      actor: { type: "person", id: "u-walter", name: "Walter" },
      action: "connector.connected",
      target: { type: "connector", id: "conn-1" },
      details: { label: "GitHub da Acme", connectionId: "conn-1", machineId: "m-9", scopeCount: 3 },
      runId: null,
      onBehalfOf: null,
      outcome: null,
    });
    await go(seedState({ audit: [change] }));
    await click(section().querySelector(".audit-row") as HTMLElement);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    const details = panel.querySelector(".audit-panel__sent")?.textContent ?? "";
    expect(details).toContain("GitHub da Acme");
    expect(details).not.toMatch(/conn-1|m-9|connectionId|machineId/);
    expect(details).toContain("Scope count");
  });

  test("the panel hangs from <body>, so it stays put while the list scrolls", async () => {
    await go();
    await click(section().querySelector(".audit-row") as HTMLElement);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    expect(panel.closest(".shell__main")).toBeNull();
    expect(panel.parentElement).toBe(document.body);
  });

  test("a waiting call links to its request", async () => {
    await go();
    await click(section().querySelector(".audit-row") as HTMLElement);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    expect(panel.textContent).toContain("Ainda ninguém respondeu");
    expect(within(panel).getByRole("link", { name: "Ver o pedido" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/approvals?open=ap-1`,
    );
  });

  test("the request opens over Auditoria, not on Aprovações", async () => {
    const audit = AUDIT.map((x) => (x.approval ? { ...x, approval: { ...x.approval, id: "ap-deploy" } } : x));
    const { r } = await go(seedState({ audit }));
    await click(section().querySelector(".audit-row") as HTMLElement);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    await click(within(panel).getByRole("link", { name: "Ver o pedido" }));
    await settle(4);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/audit`);
    expect(document.querySelector(".ap-dialog")?.textContent).toContain("Fazer um deploy");
    // Escape dismisses the request alone; the row stays open under it.
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    expect(document.querySelector(".ap-dialog")).toBeNull();
    expect(screen().getByRole("complementary", { name: "Detalhe da auditoria" })).toBeTruthy();
  });

  test("a call waiting for a secret says what became of it", async () => {
    const asked = (status: NonNullable<AuditRow["secret"]>["status"]) =>
      row({
        id: `s-${status}`,
        target: { type: "tool", id: "request_secret" },
        details: { kind: "elsewhere", behind: "person", secretRequestId: "sr-1", input: { name: "GITHUB_TOKEN" } },
        outcome: "pending",
        secret: { id: "sr-1", status },
      });
    await go(seedState({ audit: [asked("pending")] }));
    expect(section().querySelector(".audit-row")?.textContent).toContain("Esperando um segredo");
    cleanup();
    await go(seedState({ audit: [asked("delivered")] }));
    const delivered = section().querySelector(".audit-row") as HTMLElement;
    expect(delivered.textContent).toContain("Segredo entregue");
    await click(delivered);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    expect(panel.textContent).toContain("SegredoEntregue");
  });

  test("members don't see it", async () => {
    const state = seedState({ audit: AUDIT });
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(state);
    expect(screen().queryByRole("region", { name: "Auditoria" })).toBeNull();
  });
});
