import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { CustomServer, CustomTool } from "@agenteschat/client";
import type { AccessResource } from "@agenteschat/client/lib/access-levels";
import type { ConnectedItem } from "@agenteschat/client/lib/connected";
import {
  matchTool,
  partsOf,
  reviewDecisions,
  reviewToolsOf,
  subjectLabel,
  toolName,
} from "@agenteschat/client/lib/tool-review";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolReview, type ToolReviewState } from "@/components/ToolReview";
import { createI18n } from "@/i18n";
import { AgentAsksLine, agentConnectorTools } from "@/pages/agent/AgentTools";
import { createFakeApi, seedState } from "./fake-api";
import { renderPage, screen } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

const pt = createI18n("pt-BR").t as TFunction;
const en = createI18n("en").t as TFunction;

/** A tool as the backend lists it (classified). */
function tool(name: string, level: "read" | "write" | "approval", extra: Partial<CustomTool> = {}): CustomTool {
  const { subject, ...nameParts } = partsOf(name);
  return {
    name,
    description: `${name} (from the server)`,
    readOnlyHint: null,
    suggestedAccess: level,
    access: null,
    level,
    suggestionSource: "verb",
    suggestionReason: null,
    sensitive: level === "approval",
    pending: false,
    off: false,
    nameParts,
    subject,
    label: name,
    firstSeenAt: "2026-10-16T00:00:00.000Z",
    ...extra,
  };
}

const SERVER: CustomServer = {
  id: "srv-ads",
  serverUrl: "https://ads.example.com/mcp",
  label: "Ads",
  authType: "oauth",
  reviewedAt: null,
  createdAt: "2026-10-16T00:00:00.000Z",
  tools: [
    tool("campaign_list", "read"),
    tool("campaign_budget_update", "write"),
    tool("campaign_delete", "approval"),
    tool("ad_get", "read"),
    tool("ad_copy", "write"),
    tool("pixel_track", "write", {
      suggestionSource: "judge",
      suggestionReason: "changes_undoable",
      sensitive: false,
      pending: true,
    }),
    tool("report_task_run", "approval", {
      suggestionSource: "judge_failed",
      suggestionReason: "unknown",
      sensitive: false,
      pending: true,
    }),
  ],
};

function Harness({ onState, moved }: { onState: (s: ToolReviewState) => void; moved: string[] }) {
  const { t } = useTranslation();
  const tools = reviewToolsOf(t, SERVER);
  const [state, setState] = useState<ToolReviewState>({ levels: {}, decided: new Set() });
  return (
    <ToolReview
      name="Ads"
      tools={tools}
      state={state}
      onChange={(s) => {
        setState(s);
        onState(s);
      }}
      onMoved={(m) => moved.push(m)}
    />
  );
}

async function mount() {
  const ref: { state: ToolReviewState } = { state: { levels: {}, decided: new Set() } };
  const moved: string[] = [];
  await renderPage(<Harness onState={(s) => (ref.state = s)} moved={moved} />, {
    api: createFakeApi(seedState()),
  });
  return { ref, moved };
}

const group = () => screen().queryByRole("region", { name: /Precisam da sua decisão/ });
const row = (name: string) => document.querySelector(`[data-row="${name}"]`) as HTMLElement | null;
const checked = (radiogroup: HTMLElement) =>
  within(radiogroup)
    .getAllByRole("radio")
    .find((r) => r.getAttribute("aria-checked") === "true")?.textContent;

describe("readable names, subjects and search", () => {
  test("names in the person's language from the parts; the technical name only for search", () => {
    expect(toolName(pt, { verb: "get", words: ["campaign", "budget"] }, "campaign_budget_get")).toBe(
      "Ver orçamento da campanha",
    );
    expect(toolName(en, { verb: "get", words: ["campaign", "budget"] }, "campaign_budget_get")).toBe(
      "Get campaign budget",
    );
    expect(toolName(pt, { verb: "list", words: ["tickets"] }, "list_tickets")).toBe("Listar chamados");
    expect(toolName(pt, { verb: "list", words: ["adgroup"] }, "adgroup_list")).toBe("Listar grupos de anúncios");
    // Words we don't know stay as the server wrote them; no verb: the name, readable.
    expect(toolName(pt, { verb: "track", words: ["pixel", "zorb"] }, "pixel_zorb_track")).toBe("Registrar pixel zorb");
    expect(toolName(pt, { verb: null, words: ["ping"] }, "ping")).toBe("Ping");
    expect(subjectLabel(pt, "campaign")).toBe("Campanhas");
    expect(subjectLabel(en, "adgroup")).toBe("Ad groups");
    expect(subjectLabel(pt, "zorb")).toBe("Zorb");
    expect(subjectLabel(pt, "other")).toBe("Outras");
    expect(partsOf("bc_member_remove")).toEqual({ verb: "remove", words: ["bc", "member"], subject: "bc" });
    expect(matchTool({ label: "Ver orçamento da campanha", name: "campaign_budget_get" }, "orcamento")).toEqual({
      ok: true,
      tech: false,
    });
    expect(matchTool({ label: "Ver orçamento da campanha", name: "campaign_budget_get" }, "budget get")).toEqual({
      ok: true,
      tech: true,
    });
    expect(matchTool({ label: "Ver orçamento", name: "x_get" }, "zzz").ok).toBe(false);
  });

  test("what Continuar saves: each level; pending tools nobody decided stay pending", () => {
    const tools = reviewToolsOf(pt, SERVER);
    const body = reviewDecisions(tools, { campaign_list: "off", pixel_track: "approval" }, new Set(["pixel_track"]));
    const by = Object.fromEntries(body.map((b) => [b.name, b]));
    expect(by.campaign_list).toMatchObject({ access: "off", confirmed: true });
    expect(by.pixel_track).toMatchObject({ access: "approval", confirmed: true });
    expect(by.report_task_run).toMatchObject({ access: "approval", confirmed: false });
    expect(by.campaign_delete).toMatchObject({ access: "approval", confirmed: true });
  });
});

describe("the tools step", () => {
  test("the pending group comes first: illustration, suggestion preselected, reason and OK", async () => {
    await mount();
    const g = group() as HTMLElement;
    expect(g.getAttribute("aria-label")).toBe("Precisam da sua decisão · 2");
    expect(g.querySelector(".ac-toolpx-ask")).toBeTruthy();
    expect(g.textContent).toContain("O nome não diz o que fazem.");
    // First in the list, before the subjects.
    expect(document.querySelector(".tr-subjects")?.firstElementChild).toBe(g);
    const track = within(g).getByRole("radiogroup", { name: "Nível de Registrar pixel" });
    expect(checked(track)).toBe("Muda");
    expect(row("pixel_track")?.textContent).toContain("Sugestão: muda coisas (não apaga nada nem gasta dinheiro)");
    expect(row("report_task_run")?.textContent).toContain("Sugestão: pede aprovação (não deu para saber pelo nome)");
    // The sparkle sits in the reason; the technical name only on hover.
    expect(row("pixel_track")?.querySelector(".tr-row__why .ac-toolpx-spark")).toBeTruthy();
    expect(row("pixel_track")?.textContent).not.toContain("pixel_track");
    expect(row("pixel_track")?.getAttribute("title")).toContain("pixel_track");
    expect(within(g).getByRole("button", { name: "Confirmar Registrar pixel" }).textContent).toBe("OK");
    // Nothing is done while something waits.
    expect(screen().queryByRole("region", { name: "Pronto. Tudo revisado." })).toBeNull();
  });

  test("choosing a level moves the tool to its subject; OK keeps the suggestion", async () => {
    const { ref, moved } = await mount();
    const g = group() as HTMLElement;
    await click(
      within(within(g).getByRole("radiogroup", { name: "Nível de Registrar pixel" })).getByRole("radio", {
        name: "Aprovação",
      }),
    );
    expect(moved).toEqual(["“Registrar pixel” foi para Pixels"]);
    expect((group() as HTMLElement).getAttribute("aria-label")).toBe("Precisam da sua decisão · 1");
    expect(ref.state.levels.pixel_track).toBe("approval");
    // In its subject now, with the chosen level.
    await click(screen().getByRole("button", { name: /^Pixels/ }));
    const subject = screen().getByRole("region", { name: "Pixels" });
    expect(checked(within(subject).getByRole("radiogroup", { name: "Nível de Registrar pixel" }))).toBe("Aprovação");

    await click(screen().getByRole("button", { name: "Confirmar Gerar tarefa do relatório" }));
    expect(ref.state.decided.has("report_task_run")).toBe(true);
    expect(ref.state.levels.report_task_run).toBe("approval");
    expect(group()).toBeNull();
  });

  test("accept all: the done card with the agent, the proportion bar and its legend; review brings them back", async () => {
    const { moved } = await mount();
    await click(within(group() as HTMLElement).getByRole("button", { name: "Aceitar as sugestões" }));
    expect(moved).toEqual(["2 sugestões aceitas"]);
    expect(group()).toBeNull();
    const done = screen().getByRole("region", { name: "Pronto. Tudo revisado." });
    expect(done.querySelector(".ac-toolpx-agent")).toBeTruthy();
    expect(done.textContent).toContain("O agente já sabe o que pode fazer sozinho no Ads.");
    const bar = within(done).getByRole("img");
    expect(bar.getAttribute("aria-label")).toBe("2 consultam · 3 mudam · 2 pedem aprovação");
    expect(done.textContent).toContain("2 só consultam");
    expect(done.textContent).toContain("3 mudam coisas");
    expect(done.textContent).toContain("2 pedem sua aprovação");
    await click(within(done).getByRole("button", { name: "Rever as 2 sugestões" }));
    expect((group() as HTMLElement).getAttribute("aria-label")).toBe("Precisam da sua decisão · 2");
  });

  test("subjects: strip and summary; four options, two for sensitive tools", async () => {
    await mount();
    const head = screen().getByRole("button", { name: /^Campanhas/ });
    expect(head.textContent).toContain("3 ferramentas · 1 consulta · 1 muda · 1 pede aprovação");
    expect(within(head).getByRole("img").getAttribute("aria-label")).toBe("1 consulta · 1 muda · 1 pede aprovação");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    await click(head);
    const subject = screen().getByRole("region", { name: "Campanhas" });
    const budget = within(subject).getByRole("radiogroup", { name: "Nível de Alterar orçamento da campanha" });
    expect(
      within(budget)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Consulta", "Muda", "Aprovação", "Desligada"]);
    const del = within(subject).getByRole("radiogroup", { name: "Nível de Apagar campanha" });
    expect(
      within(del)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Aprovação", "Desligada"]);
    await click(within(budget).getByRole("radio", { name: "Desligada" }));
    expect(screen().getByRole("button", { name: /^Campanhas/ }).textContent).toContain("1 desligada");
    expect(row("campaign_budget_update")?.hasAttribute("data-off")).toBe(true);
  });

  test("one search across subjects: readable names, technical names (then shown), nothing found", async () => {
    await mount();
    const search = screen().getByRole("searchbox", { name: "Buscar ferramenta" });
    await type(search, "duplicar");
    expect(row("ad_copy")?.textContent).toContain("Duplicar anúncio");
    expect(row("ad_copy")?.textContent).not.toContain("ad_copy");
    expect(screen().getByRole("button", { name: /^Anúncios/ }).textContent).toContain("1 de 2 ferramentas");
    expect(row("campaign_list")).toBeNull();
    await type(search, "budget_update");
    expect(row("campaign_budget_update")?.textContent).toContain("campaign_budget_update");
    await type(search, "zzz");
    expect(document.body.textContent).toContain("Nada encontrado para “zzz”.");
  });
});

describe("the agent page: one line, never a paragraph of tool names", () => {
  test("how many actions ask, and 'Ver' opens the read-only review per connector", async () => {
    const item: ConnectedItem = {
      id: "srv-ads",
      custom: true,
      label: "Ads",
      def: null,
      account: "ads.example.com",
      viaComposio: false,
      needsReconnect: false,
      reconnectAdds: [],
      toolsError: null,
      createdAt: SERVER.createdAt,
      tools: 7,
      pending: 0,
      needsReview: false,
      server: { ...SERVER, tools: SERVER.tools.map((x) => ({ ...x, access: x.level ?? null, pending: false })) },
    };
    const resource: AccessResource = {
      id: "connector:srv-ads",
      kind: "connector",
      connectionId: "srv-ads",
      connector: "custom:srv-ads",
      area: null,
      label: "Ads",
      custom: true,
      levels: ["none", "read", "write"],
      readScopes: ["custom:srv-ads:read"],
      writeScopes: [],
      scopes: ["custom:srv-ads:read", "custom:srv-ads:write"],
      tools: SERVER.tools.map((x) => ({
        name: `ads_${x.name}`,
        label: x.name,
        description: x.description,
        readOnly: x.level === "read",
        connectionId: "srv-ads",
        scope: x.level === "read" ? "custom:srv-ads:read" : "custom:srv-ads:write",
        sensitive: x.level === "approval",
        state: "inherited" as const,
      })),
      whole: true,
      notInAll: false,
    };
    const items = new Map([["srv-ads", item]]);
    const groups = agentConnectorTools(pt, [resource], { "connector:srv-ads": "write" }, items);
    expect(groups[0]?.asks).toBe(2);
    expect(groups[0]?.tools.find((x) => x.name === "campaign_budget_update")?.label).toBe(
      "Alterar orçamento da campanha",
    );
    let changed = 0;
    await renderPage(
      <AgentAsksLine agentName="Dev" groups={groups} items={items} canChange onChange={() => changed++} />,
      { api: createFakeApi(seedState()) },
    );
    const line = document.querySelector(".agp-asks") as HTMLElement;
    expect(line.textContent).toBe("2 ações pedem sua aprovação antes Ver");
    expect(line.textContent).not.toContain(",");
    await click(screen().getByRole("button", { name: "Ver o que pede aprovação" }));
    const dialog = screen().getByRole("dialog", { name: "O que Dev pode usar" });
    const conn = within(dialog).getByRole("region", { name: "Ads" });
    expect(conn.textContent).toContain("2 pedem aprovação");
    // Read-only: levels shown, no controls; technical names on hover.
    await click(within(conn).getByRole("button", { name: /^Campanhas/ }));
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
    const del = dialog.querySelector('[data-row="campaign_delete"]') as HTMLElement;
    expect(del.textContent).toContain("Apagar campanha");
    expect(del.textContent).toContain("Pede sua aprovação");
    expect(del.getAttribute("title")).toContain("campaign_delete");
    await click(within(dialog).getByRole("button", { name: "Mudar acessos" }));
    expect(changed).toBe(1);
  });
});
