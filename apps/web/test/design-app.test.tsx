import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { LiveWork, Run, RunStep } from "@agenteschat/client";
import { agentStateIn, agentStateOfRun, type LiveRun } from "@agenteschat/client";
import { workFromSteps, workHeader } from "@agenteschat/client/lib/work";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { LiveTools, SavedTools } from "@/components/ToolCalls";
import { createI18n } from "@/i18n";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) =>
  act(async () =>
    fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } }),
  );

const live = (over: Partial<LiveRun>): LiveRun => ({
  runId: "r",
  agentId: "a",
  channelId: "c",
  threadId: "t",
  status: "running",
  ...over,
});

describe("the living avatar follows the run", () => {
  test("queued/thinking → thinking; writing (running) → writing; done/failed/approval → idle", () => {
    expect(agentStateOfRun(live({ status: "queued" }))).toBe("thinking");
    expect(agentStateOfRun(live({ status: "thinking" }))).toBe("thinking");
    expect(agentStateOfRun(live({ status: "running" }))).toBe("writing");
    expect(agentStateOfRun(live({ status: "done" }))).toBe("idle");
    expect(agentStateOfRun(live({ status: "failed" }))).toBe("idle");
    expect(agentStateOfRun(live({ status: "waiting_approval" }))).toBe("idle");
    const state = {
      runs: {
        r1: live({ runId: "r1", status: "thinking" }),
        r2: live({ runId: "r2", status: "running", channelId: "other" }),
      },
      finished: {},
    };
    expect(agentStateIn(state, "a")).toBe("writing");
    expect(agentStateIn(state, "a", "c")).toBe("thinking");
    expect(agentStateIn(state, "b")).toBe("idle");
  });
});

describe("work summary", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 15, 22, 9, s)).toISOString();
  const steps: RunStep[] = [
    { seq: 1, kind: "context", data: {}, createdAt: at(0) },
    {
      seq: 2,
      kind: "tool_call",
      data: { toolUseId: "t1", name: "himetrica_get_summary", connector: "Himetrica" },
      createdAt: at(1),
    },
    { seq: 3, kind: "tool_result", data: { toolUseId: "t1", isError: false }, createdAt: at(4) },
    { seq: 4, kind: "tool_call", data: { toolUseId: "t2", name: "create_artifact" }, createdAt: at(5) },
    { seq: 5, kind: "tool_result", data: { toolUseId: "t2", isError: true }, createdAt: at(8) },
    { seq: 6, kind: "message", data: {}, createdAt: at(12) },
  ];
  test("from the run's steps: tool calls, apps used, duration", () => {
    const i18n = createI18n("pt-BR");
    const t = i18n.t.bind(i18n);
    const w = workFromSteps(steps, { createdAt: at(0), finishedAt: at(12) });
    expect(w.steps.map((s) => [s.kind, s.ms, s.failed])).toEqual([
      ["consulting", 3000, false],
      ["writingDrive", 3000, true],
    ]);
    expect(w.connectors).toEqual(["Himetrica", "Drive"]);
    expect(workHeader(t, { steps: w.steps.length, connectors: w.connectors, durationMs: w.durationMs })).toEqual({
      steps: "2 passos",
      connectors: "Himetrica e Drive",
      duration: "12 s",
    });
  });

  test("under an agent's message: opens on click and loads the steps", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const asked: string[] = [];
    api.agents.run = async (_orgId, runId) => {
      asked.push(runId);
      return {
        run: { id: runId, createdAt: at(0), finishedAt: at(12) } as Run,
        steps,
      };
    };
    const reply = state.messages.find((m) => m.id === "m-2");
    if (reply)
      reply.meta = {
        work: {
          steps: 2,
          calls: [{ name: "himetrica_get_summary", connector: "Himetrica" }, { name: "create_artifact" }],
          durationMs: 12_000,
        },
      };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const head = screen().getAllByRole("button", { name: /Usou 2 ferramentas/ })[0] as HTMLElement;
    expect(asked).toEqual([]);
    await click(head);
    await settle(4);
    expect(asked).toEqual(["r-1"]);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    // Once loaded, the block's line says how many tools and how long.
    expect(head.textContent).toContain("Usou 2 ferramentas");
    expect(head.textContent).toContain("12 s");
    const work = head.closest(".ac-tools") as HTMLElement;
    expect(within(work).getByText("Consultou o Himetrica")).toBeTruthy();
    // The one that failed says so, and doesn't read as done.
    expect(within(work).getByText("Deu erro escrevendo no Drive")).toBeTruthy();
  });

  test("a reply without meta.work (saved before it) keeps a block that loads its steps, gone if it called none", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    let runSteps = steps;
    api.agents.run = async (_orgId, runId) => ({
      run: { id: runId, createdAt: at(0), finishedAt: at(12) } as Run,
      steps: runSteps,
    });
    const reply = state.messages.find((m) => m.id === "m-2");
    if (reply) reply.meta = {};
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const head = screen().getAllByRole("button", { name: /O que ela fez/ })[0] as HTMLElement;
    await click(head);
    await settle(4);
    expect(head.textContent).toContain("Usou 2 ferramentas");
    cleanup();

    runSteps = [steps[0], steps[steps.length - 1]].filter((s) => s !== undefined);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const none = screen().getAllByRole("button", { name: /O que ela fez/ })[0] as HTMLElement;
    await click(none);
    await settle(4);
    expect(none.isConnected).toBe(false);
    expect(document.body.textContent).not.toContain("sem usar ferramentas");
  });

  test("a reaction already shows on the message: no block for a reply that only reacted, other tools count alone", async () => {
    const call = (id: string, tool: string): LiveWork => ({
      kind: "call",
      id,
      tool,
      connector: null,
      detail: null,
      code: null,
      output: [],
      running: false,
      ms: 1000,
    });
    const api = createFakeApi(seedState());
    await renderPage(<LiveTools work={[call("1", "react")]} agentName="Ada" done />, { api, org: true });
    expect(document.querySelector(".ac-tools")).toBeNull();
    cleanup();

    api.agents.run = async (_orgId, runId) => ({
      run: { id: runId, createdAt: at(0), finishedAt: at(4) } as Run,
      steps: [
        {
          seq: 1,
          kind: "tool_call",
          data: { toolUseId: "t1", name: "react", input: { emoji: "🙌" } },
          createdAt: at(1),
        },
        { seq: 2, kind: "tool_result", data: { toolUseId: "t1", isError: false }, createdAt: at(1) },
        { seq: 3, kind: "tool_call", data: { toolUseId: "t2", name: "create_issue" }, createdAt: at(2) },
        { seq: 4, kind: "tool_result", data: { toolUseId: "t2", isError: false }, createdAt: at(3) },
      ],
    });
    await renderPage(
      <>
        <LiveTools work={[call("1", "react"), call("2", "create_issue")]} agentName="Ada" done />
        <SavedTools runId="r-9" meta={{ work: { steps: 1, connectors: [], durationMs: 4000 } }} agentName="Ada" />
      </>,
      { api, org: true },
    );
    const [live, saved] = [...document.querySelectorAll<HTMLElement>(".ac-tools")];
    // Its one other call is its own line, no block to open.
    expect(live?.querySelector(".ac-tools__head")).toBeNull();
    expect(live?.querySelector(".ac-tools__row b")?.textContent).toBe("Criou uma tarefa");
    await click(saved?.querySelector(".ac-tools__head") as HTMLElement);
    await settle(4);
    expect(saved?.querySelector(".ac-tools__text")?.textContent).toBe("Usou 1 ferramenta");
    expect(within(saved as HTMLElement).getByText("Criou uma tarefa")).toBeTruthy();
    expect(within(saved as HTMLElement).queryByText("Reagiu à mensagem")).toBeNull();
  });
});

describe("the block's logos are the services' own", () => {
  const call = (id: string, tool: string, over: Partial<LiveWork> = {}): LiveWork =>
    ({
      kind: "call",
      id,
      tool,
      connector: null,
      detail: null,
      code: null,
      output: [],
      running: false,
      ms: 1100,
      ...over,
    }) as LiveWork;
  /** What a logo draws: a service's mark (its file), a server's own image, or one of our icons. */
  const drawn = (logo: Element | null | undefined) => {
    const mark = logo?.querySelector<HTMLElement>(".connector-icon__mark")?.style.getPropertyValue("--connector-icon");
    if (mark) return mark.replace(/^url\("(.+)"\)$/, "$1");
    return (
      logo?.querySelector(".connector-icon__img")?.getAttribute("src") ??
      (logo?.querySelector(".tool-logo") ? "ours" : null)
    );
  };

  test("a Gmail search, a GitHub search and one of our tools: each row and the head show the real logos", async () => {
    const api = createFakeApi(seedState());
    await renderPage(
      <LiveTools
        work={[
          call("1", "mail_wnogueira_search", { connector: "Email", service: "gmail" }),
          call("2", "github_search_issues", { connector: "GitHub", service: "github" }),
          call("3", "create_issue"),
        ]}
        agentName="Ada"
        done
      />,
      { api, org: true },
    );
    await settle(4);
    const block = document.querySelector(".ac-tools") as HTMLElement;
    const head = block.querySelector(".ac-tools__head") as HTMLElement;
    expect(head.querySelector(".ac-tools__text")?.textContent).toBe("Usou 3 ferramentas");
    expect([...head.querySelectorAll(".ac-tools__logos > *")].map(drawn)).toEqual([
      "/connectors/gmail.svg",
      "/connectors/github.svg",
      "ours",
    ]);
    await click(head);
    const rows = [...block.querySelectorAll(".ac-tools__row")];
    expect(rows.map((r) => [r.querySelector("b")?.textContent, r.querySelector("small")?.textContent ?? null])).toEqual(
      [
        ["Consultou o Gmail", "wnogueira search"],
        ["Consultou o GitHub", "Buscar issues"],
        ["Criou uma tarefa", null],
      ],
    );
    expect(rows.map((r) => drawn(r.querySelector(".ac-tools__logo")))).toEqual([
      "/connectors/gmail.svg",
      "/connectors/github.svg",
      "ours",
    ]);
  });

  test("a server's icon that no longer loads leaves its monogram, not an empty tile", async () => {
    const api = createFakeApi(seedState());
    const icon = `/api/app/connector-icons/${ORG_ID}/00000000-0000-4000-8000-0000000000f1/0123456789abcdef.png`;
    await renderPage(
      <LiveTools
        work={[call("1", "acme_find_orders", { connector: "Acme Tools", serviceIcon: icon })]}
        agentName="Ada"
        done
      />,
      { api, org: true },
    );
    await settle(4);
    // One call: its line's logo.
    const logos = document.querySelector(".ac-tools__row .ac-tools__logo") as HTMLElement;
    const img = logos.querySelector(".connector-icon__img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(icon);
    await act(async () => {
      img.dispatchEvent(new Event("error"));
    });
    expect(logos.querySelector(".connector-icon__img")).toBeNull();
    expect(logos.querySelector(".connector-icon--initial")?.textContent).toBe("AT");
  });

  test("a saved reply's closed head shows its services' logos from meta.work, before any step loads", async () => {
    const api = createFakeApi(seedState());
    const asked: string[] = [];
    api.agents.run = async (_orgId, runId) => {
      asked.push(runId);
      throw new Error("not loaded while closed");
    };
    const work = {
      steps: 4,
      durationMs: 6000,
      calls: [
        { name: "mail_wnogueira_search", connector: "Email", service: "gmail" },
        { name: "create_issue" },
        { name: "pg_analytics_query", connector: "Analytics", service: "postgres" },
        { name: "github_get_pr", connector: "GitHub", service: "github" },
      ],
    };
    await renderPage(<SavedTools runId="r-7" meta={{ work }} agentName="Ada" />, { api, org: true });
    await settle(4);
    const head = document.querySelector(".ac-tools__head") as HTMLElement;
    expect(head.querySelector(".ac-tools__text")?.textContent).toBe("Usou 4 ferramentas");
    expect([...head.querySelectorAll(".ac-tools__logos > *")].map(drawn)).toEqual([
      "/connectors/gmail.svg",
      "ours",
      "/brands/postgresql.svg",
      "/connectors/github.svg",
    ]);
    expect(asked).toEqual([]);
  });
});

describe("⌘K palette", () => {
  const press = () =>
    act(async () => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });

  test("opens with ⌘K; filters settings sections; Enter goes there", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/issues`, { api: createFakeApi(seedState()) });
    await settle(6);
    await press();
    const input = screen().getByRole("combobox", { name: "Ir para, ou pedir a um agente" });
    await type(input, "conectores");
    const list = screen().getByRole("listbox", { name: "Resultados" });
    expect(within(list).getAllByRole("option")[0]?.textContent).toContain("Conectores");
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/connectors`);
  });

  test("ask an agent: opens its DM with the text in the composer", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/issues`, { api: createFakeApi(seedState()) });
    await settle(6);
    await press();
    const input = screen().getByRole("combobox", { name: "Ir para, ou pedir a um agente" });
    await type(input, "Ada, resume a semana");
    const ask = within(screen().getByRole("listbox", { name: "Resultados" })).getByRole("option", {
      name: /Ada, resume a semana/,
    });
    await click(ask);
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
    const composer = screen().getByRole("combobox", { name: "Mensagem para Ada" }) as HTMLTextAreaElement;
    expect(composer.value).toBe("resume a semana");
  });
});

describe("composer in a DM", () => {
  test("the target agent pill; '/' commands insert a ready request", async () => {
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const composer = screen().getByRole("combobox", { name: "Mensagem para Ada" }) as HTMLTextAreaElement;
    const card = composer.closest(".ac-composer") as HTMLElement;
    expect(card.querySelector(".ac-composer__agent")?.textContent).toContain("Ada");
    await type(composer, "/");
    const menu = screen().getByRole("listbox", { name: "Comandos" });
    expect(
      within(menu)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      expect.stringContaining("/relatório"),
      expect.stringContaining("/rotina"),
      expect.stringContaining("/pc"),
      expect.stringContaining("/mission"),
    ]);
    await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
    expect(composer.value).toBe("monte um relatório sobre ");
  });
});
