import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, keys, type OrgStanding, type Role } from "@agenteschat/client";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { setNavigateAway } from "@/lib/navigate";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const STATUS = "Status do workspace";
const OTHER_ID = "00000000-0000-4000-8000-0000000000b2";
const meEvery = (qc: QueryClient) =>
  qc
    .getQueryCache()
    .find({ queryKey: keys.me })
    ?.observers.map((o) => o.options.refetchInterval);

/** #eng of Acme (or `path`) with the standing `/me` says, and its socket open to push what the operator changes. */
async function open(
  standing?: OrgStanding,
  other = false,
  supportEmail: string | null = null,
  {
    role = "owner",
    billingUrl = null,
    state = seedState(),
    cloud = false,
    path = `/org/${ORG_ID}/c/${ENG_ID}`,
  }: {
    role?: Role;
    billingUrl?: string | null;
    state?: ReturnType<typeof seedState>;
    cloud?: boolean;
    path?: string;
  } = {},
) {
  state.authConfig = { ...state.authConfig, supportEmail, billingUrl, ...(cloud ? { workspaceComputer: true } : {}) };
  if (state.me) {
    state.me.organizations = [
      { id: ORG_ID, name: "Acme", role, ...(standing ? { standing } : {}) },
      ...(other ? [{ id: OTHER_ID, name: "Beta", role: "member" as const }] : []),
    ];
  }
  const r = await renderApp(path, { api: createFakeApi(state) });
  await settle(8);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  const set = async (next: OrgStanding) => {
    await act(async () =>
      socket.push({ type: "event", scope: "org", event: { type: "org.standing", orgId: ORG_ID, ...next } }),
    );
    await settle(6);
  };
  const channel = async (event: Record<string, unknown>) => {
    await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    await settle(4);
  };
  return { ...r, state, set, channel };
}

describe("on hold: a line on top of the work area", () => {
  test("the reason when the workspace is told one, only 'paused for review' when not; gone once active", async () => {
    const { set } = await open({ state: "hold", reason: "verificação de pagamento" });
    const banner = () => screen().getByRole("region", { name: STATUS });
    expect(banner().textContent).toContain("Este workspace está em espera: verificação de pagamento");
    expect(banner().textContent).toContain(
      "Dá para ler e escrever normalmente. Os agentes não respondem nem trabalham enquanto ele estiver em espera.",
    );
    // Where to ask: nobody named on this server, so whoever runs it.
    expect(banner().textContent).toContain("Precisa de ajuda? Fale com quem cuida deste servidor.");
    // People still read and write: the chat is there under it.
    expect(screen().getByRole("combobox", { name: "Mensagem para #eng" })).toBeTruthy();

    await set({ state: "hold", reason: null });
    expect(banner().textContent).toContain("Os agentes deste workspace estão pausados para uma revisão.");
    expect(banner().textContent).not.toContain("pagamento");

    await set({ state: "active", reason: null });
    expect(screen().queryByRole("region", { name: STATUS })).toBeNull();
  });

  test("where to write when the server names an address", async () => {
    await open({ state: "hold", reason: null }, false, "ajuda@acme.test");
    const banner = screen().getByRole("region", { name: STATUS });
    expect(banner.textContent).toContain("Precisa de ajuda? Escreva para ajuda@acme.test.");
    expect(within(banner).getByRole("link", { name: "ajuda@acme.test" }).getAttribute("href")).toBe(
      "mailto:ajuda@acme.test",
    );
  });

  test("on the Cloud with no address: no line, since nobody else runs that server; with one, where to write", async () => {
    await open({ state: "hold", reason: null }, false, null, { cloud: true });
    const banner = () => screen().getByRole("region", { name: STATUS });
    expect(banner().textContent).toContain("Os agentes deste workspace estão pausados para uma revisão.");
    expect(banner().textContent).not.toContain("Precisa de ajuda");
    expect(banner().querySelector(".support-line")).toBeNull();
    cleanup();
    await open({ state: "suspended", reason: null }, false, null, { cloud: true });
    expect(document.body.textContent).toContain("As conversas e os agentes dele estão fechados por enquanto.");
    expect(document.body.textContent).not.toContain("Precisa de ajuda");
    cleanup();
    await open({ state: "hold", reason: null }, false, "suporte@agentes.chat", { cloud: true });
    expect(banner().textContent).toContain("Precisa de ajuda? Escreva para suporte@agentes.chat.");
  });

  test("an active workspace shows nothing", async () => {
    await open({ state: "active", reason: null });
    expect(screen().queryByRole("region", { name: STATUS })).toBeNull();
    await cleanup();
    await open();
    expect(screen().queryByRole("region", { name: STATUS })).toBeNull();
  });

  test("a run refused by the standing says so plainly, in the person's language", async () => {
    const { channel } = await open({ state: "hold", reason: "verificação de pagamento" });
    const run = { threadId: null, runId: "r-held", agentId: ADA_ID };
    await channel({ type: "agent.thinking", ...run });
    await channel({
      type: "run.finished",
      ...run,
      status: "failed",
      error: "This workspace is on hold: verificação de pagamento",
      errorCode: "run.org_paused",
      errorParams: { reason: "verificação de pagamento" },
    });
    const alert = screen().getByRole("alert");
    expect(alert.textContent).toBe("Ada não respondeu. Este workspace está em espera: verificação de pagamento");
    expect(document.body.textContent).not.toContain("This workspace is on hold");
  });
});

describe("a billing hold (ADR 0079): its own words, and its fix for whoever runs the workspace", () => {
  const BILLING = "https://billing.example.com";

  test("owners and admins get the button of its code: it opens the billing service, signed in", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const { state, set, services } = await open({ state: "hold", reason: "payment" }, false, null, {
      billingUrl: BILLING,
    });
    const banner = () => screen().getByRole("region", { name: STATUS });
    // A team, waiting for its first plan: one line, no pause, no second line.
    expect(banner().textContent).toBe(
      "Seu time está pronto. Falta um plano do agentes.chat para ele começar.Ver planos do agentes.chat",
    );
    expect(banner().querySelector(".outage__icon")).toBeNull();
    // Not back from paying: nothing to wait for, so `/me` isn't asked again.
    expect(meEvery(services.queryClient)).not.toContain(5000);
    await act(async () =>
      fireEvent.click(within(banner()).getByRole("button", { name: "Ver planos do agentes.chat" })),
    );
    await settle(4);
    expect(state.calls.find((c) => c.method === "orgs.billingLink")?.args).toEqual([ORG_ID, "hold"]);
    expect(left).toEqual(["https://billing.example.com/link?t=hold"]);

    await set({ state: "hold", reason: "unpaid" });
    expect(banner().textContent).toContain(
      "Dá para ler e escrever aqui. Os agentes voltam quando o plano do agentes.chat estiver em dia.",
    );
    expect(within(banner()).getByRole("button", { name: "Atualizar o pagamento" })).toBeTruthy();
    await set({ state: "hold", reason: "ended" });
    expect(banner().textContent).toContain("O plano do agentes.chat deste workspace terminou, e os agentes pararam.");
    expect(within(banner()).getByRole("button", { name: "Assinar de novo" })).toBeTruthy();
  });

  test("waiting for its first plan with only the right hand: no banner, its own words say it", async () => {
    const state = seedState();
    state.agents = [];
    withRightHand(state);
    await open({ state: "hold", reason: "payment" }, false, null, { billingUrl: BILLING, state });
    expect(screen().queryByRole("region", { name: STATUS })).toBeNull();
  });

  test("back from paying (`?paid=1`): the payment received and nothing to click, until the hold lifts", async () => {
    const { set } = await open({ state: "hold", reason: "payment" }, false, null, {
      billingUrl: BILLING,
      path: `/org/${ORG_ID}?paid=1`,
    });
    const banner = () => screen().queryByRole("region", { name: STATUS });
    expect(banner()?.textContent).toBe("Pagamento recebido. O plano do agentes.chat começa em instantes.");
    expect(within(banner() as HTMLElement).queryByRole("button")).toBeNull();
    await set({ state: "active", reason: null });
    expect(banner()).toBeNull();
  });

  test("back from paying, a lift this tab never heard of: `/me` is asked again every 5 s until the hold is gone", async () => {
    const { state, services } = await open({ state: "hold", reason: "payment" }, false, null, {
      billingUrl: BILLING,
      path: `/org/${ORG_ID}?paid=1`,
    });
    const qc = services.queryClient;
    expect(meEvery(qc)).toContain(5000);
    // Lifted before this tab's socket opened: no `org.standing` comes, the next ask brings it.
    const me = state.me;
    if (!me) throw new Error("no me");
    state.me = { ...me, organizations: [{ id: ORG_ID, name: "Acme", role: "owner" }] };
    await act(async () => qc.refetchQueries({ queryKey: keys.me, type: "active" }));
    await settle(6);
    expect(screen().queryByRole("region", { name: STATUS })).toBeNull();
    expect(meEvery(qc)).not.toContain(5000);
  });

  test("a link that can't be made says so; members read who can fix it, with no button", async () => {
    const state = seedState();
    state.billingLinkError = new ApiError(500, "internal_error", "Something went wrong on our side");
    await open({ state: "hold", reason: "unpaid" }, false, null, { billingUrl: BILLING, state });
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Atualizar o pagamento" })));
    await settle(4);
    expect(document.body.textContent).toContain("Não deu para abrir agora. Tente de novo em instantes.");

    cleanup();
    await open({ state: "hold", reason: "unpaid" }, false, null, { billingUrl: BILLING, role: "member" });
    const banner = screen().getByRole("region", { name: STATUS });
    expect(banner.textContent).toContain("Quem administra o workspace pode resolver isso.");
    expect(within(banner).queryByRole("button")).toBeNull();
  });

  test("a refused run says the hold's words, never its code", async () => {
    const { channel } = await open({ state: "hold", reason: "payment" }, false, null, { billingUrl: BILLING });
    const run = { threadId: null, runId: "r-billing", agentId: ADA_ID };
    await channel({ type: "agent.thinking", ...run });
    await channel({
      type: "run.finished",
      ...run,
      status: "failed",
      error: "This workspace is on hold: payment",
      errorCode: "run.org_paused",
      errorParams: { reason: "payment" },
    });
    expect(screen().getByRole("alert").textContent).toBe(
      "Ada não respondeu. Este workspace ainda não tem um plano do agentes.chat. Os agentes começam a trabalhar quando ele tiver.",
    );
  });

  test("an invitation to a workspace on one says the hold's words, never its code", async () => {
    const state = seedState({ previews: { held: { orgName: "Acme", email: "walter@acme.com.br", role: "member" } } });
    const api = createFakeApi(state);
    api.orgs.acceptInvitation = async () => {
      throw new ApiError(403, "org.paused", "This workspace is on hold: unpaid", { reason: "unpaid" });
    };
    await renderApp("/invite/held", { api });
    await settle(4);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Entrar na Acme" })));
    await settle(4);
    expect(screen().getByRole("alert").textContent).toBe(
      "O pagamento do plano do agentes.chat deste workspace não passou, e os agentes pararam.",
    );
  });
});

const CONTEST = "Para contestar, escreva para legal@agentes.chat.";

describe("on agentes.chat Cloud: what it is, the Terms section and how to contest it", () => {
  test("the automatic hold reads the review line, an operator's reason how to contest it, a silent hold neither", async () => {
    const { set } = await open({ state: "hold", reason: "review", cloud: true }, false, null, { cloud: true });
    const banner = () => screen().getByRole("region", { name: STATUS });
    expect(banner().textContent).toContain(
      `Pausado para uma análise de segurança, até a nossa equipe olhar o caso. As nossas verificações automáticas detectaram uma atividade que pode violar os nossos Termos (seção 5). ${CONTEST}`,
    );
    expect(banner().textContent).not.toContain("em espera: review");

    await set({ state: "hold", reason: "Termos 5: phishing", cloud: true });
    expect(banner().textContent).toContain(`Este workspace está em espera: Termos 5: phishing. ${CONTEST}`);

    await set({ state: "hold", reason: null, cloud: true });
    expect(banner().textContent).toContain("Os agentes deste workspace estão pausados para uma revisão.");
    expect(banner().textContent).not.toContain("contestar");
  });

  test("the automatic hold names what was flagged, and a category the app doesn't know reads the plain review line", async () => {
    const reason = "review.phishing_impersonation";
    const { set } = await open({ state: "hold", reason, cloud: true }, false, null, { cloud: true });
    const banner = () => screen().getByRole("region", { name: STATUS });
    expect(banner().textContent).toContain(
      `Pausado para uma análise de segurança, até a nossa equipe olhar o caso. As nossas verificações automáticas detectaram uma atividade que parece envolver phishing ou imitação de uma marca, o que os nossos Termos não permitem (seção 5). ${CONTEST}`,
    );
    expect(banner().textContent).not.toContain("review");

    await set({ state: "hold", reason: "review.something_new", cloud: true });
    expect(banner().textContent).toContain(
      `Pausado para uma análise de segurança, até a nossa equipe olhar o caso. As nossas verificações automáticas detectaram uma atividade que pode violar os nossos Termos (seção 5). ${CONTEST}`,
    );
    expect(banner().textContent).not.toContain("review");
  });

  test("suspended with a reason: why, then how to contest it", async () => {
    await open({ state: "suspended", reason: "Termos 5: spam", cloud: true }, false, null, { cloud: true });
    expect(document.body.textContent).toContain(`Este workspace está suspenso: Termos 5: spam. ${CONTEST}`);
  });

  test("a run of a held agent says the hold's kind, never its reason", async () => {
    const { channel } = await open(undefined, false, null, { cloud: true });
    const says = {
      network: `Este agente está pausado. As nossas regras de rede viram sinais de abuso no tráfego dele (Termos, seção 5). ${CONTEST}`,
      operator: `Este agente está pausado enquanto a nossa equipe analisa a atividade dele (Termos, seção 5). ${CONTEST}`,
    };
    for (const kind of ["network", "operator"] as const) {
      const run = { threadId: null, runId: `r-${kind}`, agentId: ADA_ID };
      await channel({ type: "agent.thinking", ...run });
      await channel({
        type: "run.finished",
        ...run,
        status: "failed",
        error: `This agent is paused: ${kind}`,
        errorCode: "run.agent_paused",
        errorParams: { kind, cloud: "true" },
      });
      expect(
        screen()
          .getAllByRole("alert")
          .map((a) => a.textContent),
      ).toContain(`Ada não respondeu. ${says[kind]}`);
    }
  });

  test("a self-hosted server reads what it always read, whatever the reason", async () => {
    await open({ state: "hold", reason: "review" });
    const banner = screen().getByRole("region", { name: STATUS });
    expect(banner.textContent).toContain("Este workspace está em espera: review");
    expect(banner.textContent).not.toContain("contestar");
  });
});

describe("suspended: a screen of its own", () => {
  test("opening a suspended workspace shows the screen at once", async () => {
    await open({ state: "suspended", reason: null });
    expect(screen().getByRole("heading", { name: "Acme está indisponível" })).toBeTruthy();
    expect(document.body.textContent).toContain("As conversas e os agentes dele estão fechados por enquanto.");
    expect(document.body.textContent).toContain("Precisa de ajuda? Fale com quem cuida deste servidor.");
    expect(screen().queryByRole("combobox", { name: "Mensagem para #eng" })).toBeNull();
  });

  test("in place of the shell, live: why when told, where to ask, the other workspaces, Sair; back once lifted", async () => {
    const { set } = await open(undefined, true, "ajuda@acme.test");
    expect(screen().queryByRole("heading", { name: "Acme está indisponível" })).toBeNull();

    await set({ state: "suspended", reason: "uso fora dos termos" });
    expect(screen().getByRole("heading", { name: "Acme está indisponível" })).toBeTruthy();
    expect(document.body.textContent).toContain("Este workspace está suspenso: uso fora dos termos");
    expect(screen().getByRole("link", { name: "ajuda@acme.test" }).getAttribute("href")).toBe("mailto:ajuda@acme.test");
    // No sidebar, no chat: nothing of the workspace is open.
    expect(screen().queryByRole("combobox", { name: "Mensagem para #eng" })).toBeNull();
    const others = screen().getByRole("navigation", { name: "Seus outros workspaces" });
    expect(within(others).getByRole("link", { name: "Beta" }).getAttribute("href")).toBe(`/org/${OTHER_ID}`);
    expect(screen().getByRole("button", { name: "Sair" })).toBeTruthy();

    // Silent: only that it is unavailable.
    await set({ state: "suspended", reason: null });
    expect(document.body.textContent).toContain("As conversas e os agentes dele estão fechados por enquanto.");
    expect(document.body.textContent).not.toContain("uso fora dos termos");

    await set({ state: "active", reason: null });
    expect(screen().queryByRole("heading", { name: "Acme está indisponível" })).toBeNull();
    expect(screen().getByRole("combobox", { name: "Mensagem para #eng" })).toBeTruthy();
  });
});
