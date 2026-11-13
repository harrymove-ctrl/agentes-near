import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { LEAVE_MS } from "@/pages/AuthorizePage";
import { createFakeApi, type FakeState, fakeAppsOf, ORG_ID, seedState } from "./fake-api";
import type { FakeApps } from "./fakes/apps";
import { pick } from "./new-agent-flow";
import { renderApp, settle } from "./render";

const REQ = "0192f0a0-0000-7000-8000-000000000001";
let assign: Mock<(url: string | URL) => void>;
beforeEach(() => {
  assign = spyOn(window.location, "assign").mockImplementation(() => {});
});
afterEach(() => {
  assign.mockRestore();
  cleanup();
});

const open = async (
  setup?: (apps: FakeApps) => void,
  state: FakeState = seedState(),
  path = `/autorizar?req=${REQ}`,
) => {
  const api = createFakeApi(state);
  const apps = fakeAppsOf.get(api) as FakeApps;
  setup?.(apps);
  const r = await renderApp(path, { api });
  await settle(6);
  return { ...r, state, apps };
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const page = () => document.querySelector(".consent-page") as HTMLElement;
const title = () => within(page()).getByRole("heading", { level: 1 });
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method).map((c) => c.args);
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("/autorizar: an AI app asks to act as this person (ADR 0119)", () => {
  test("signed out: sign in first, then come back to the same request", async () => {
    const { router } = await renderApp(`/autorizar?req=${REQ}`, { api: createFakeApi(seedState({ me: null })) });
    expect(router.state.location.pathname).toBe("/login");
    expect(String((router.state.location.search as { redirect?: string }).redirect)).toContain(`req=${REQ}`);
  });

  test("a verified app: its mark, its name in bold, where it proved itself, the account, the access and the lists", async () => {
    await open((apps) => apps.addConsent(REQ));
    expect(title().textContent).toBe("Claude quer acessar sua conta");
    expect(title().querySelector("b")?.textContent).toBe("Claude");
    expect(page().querySelector(".consent__app .ac-brand")?.getAttribute("data-mark")).toBe("claude");
    expect(page().textContent).toContain("Identidade confirmada em claude.ai");
    expect(page().textContent).toContain("Entrando como Walter (walter@acme.test)");
    expect(within(page()).getByRole("button", { name: "Trocar de conta" })).toBeTruthy();
    // One workspace: its name, no picker.
    expect(within(page()).queryByRole("combobox", { name: "Workspace" })).toBeNull();
    expect(page().textContent).toContain("Acme");
    expect(
      within(page())
        .getByRole("radio", { name: /Ler e mandar tarefas aos agentes/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const can = page().querySelector(".consent__list--can") as HTMLElement;
    expect([...can.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Ver os agentes e os canais que você vê.",
      "Mandar mensagens como você, marcadas com via Claude.",
      "Ler as respostas e o que os agentes estão fazendo.",
    ]);
    const never = page().querySelector(".consent__list--never") as HTMLElement;
    expect(never.textContent).toContain("Aprovar ações dos agentes. Aprovações ficam com pessoas no agentes.chat.");
    expect(page().textContent).toContain("Volta para claude.ai");
    expect(page().textContent).toContain("Continue só se você começou esta conexão agora.");
    expect(within(page()).queryByRole("alert")).toBeNull();
  });

  test("Permitir: the chosen workspace and access go once; Pronto, then back to the app once, even after a re-render", async () => {
    const { state, rerender } = await open((apps) => apps.addConsent(REQ));
    await click(within(page()).getByRole("radio", { name: /Só ler/ }));
    // Read only: sending leaves the list.
    expect(page().querySelector(".consent__list--can")?.textContent).not.toContain("Mandar mensagens");
    await click(within(page()).getByRole("button", { name: "Permitir" }));
    expect(calls(state, "apps.decide")).toEqual([[REQ, { decision: "allow", orgId: ORG_ID, access: "read" }]]);
    expect(page().textContent).toContain("Pronto");
    expect(page().textContent).toContain("Pode voltar ao Claude.");
    expect(assign).not.toHaveBeenCalled();
    await wait(LEAVE_MS + 50);
    expect(assign).toHaveBeenCalledTimes(1);
    const to = new URL(String(assign.mock.calls[0]?.[0]));
    expect([to.searchParams.get("code"), to.searchParams.get("state"), to.searchParams.get("iss")]).toEqual([
      "c0de",
      "st4te",
      "https://agentes.example",
    ]);
    // A custom scheme leaves the page open: nothing goes twice.
    rerender(<div />);
    await wait(LEAVE_MS + 50);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  test("Cancelar: the app hears access_denied at once; nothing was shared", async () => {
    const { state } = await open((apps) => apps.addConsent(REQ));
    await click(within(page()).getByRole("button", { name: "Cancelar" }));
    expect(calls(state, "apps.decide")).toEqual([[REQ, { decision: "deny" }]]);
    expect(page().textContent).toContain("Conexão cancelada");
    expect(page().textContent).toContain("Nada foi compartilhado.");
    await wait(10);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(new URL(String(assign.mock.calls[0]?.[0])).searchParams.get("error")).toBe("access_denied");
  });

  test("an unverified site: its address in bold, the name it gives itself, and a warning when it borrows a known one", async () => {
    await open((apps) =>
      apps.addConsent(REQ, {
        displayKind: "https",
        name: "Claude",
        host: "claude-mcp.example",
        brand: null,
        returnsTo: "claude-mcp.example",
        reservedNameWarning: true,
      }),
    );
    expect(title().textContent).toBe("Um app em claude-mcp.example quer acessar sua conta");
    expect(title().querySelector("b")?.textContent).toBe("claude-mcp.example");
    expect(page().textContent).toContain("Ele se apresenta como Claude, sem verificação");
    expect(within(page()).getByRole("alert").textContent).toBe(
      "Este nome não foi confirmado. Confira o endereço acima.",
    );
    // No mark from a name: the initial.
    expect(page().querySelector(".consent__app .ac-brand")?.getAttribute("data-mark")).toBeNull();
    expect(page().querySelector(".consent__app .ac-brand__initial")?.textContent).toBe("C");
  });

  test("a hostile name is text, never markup; a long one is cut with the whole of it on hover", async () => {
    const hostile = "**Claude**<b>oi</b><img src=x onerror=alert(1)>";
    await open((apps) =>
      apps.addConsent(REQ, {
        displayKind: "https",
        name: hostile,
        host: "x.example",
        brand: null,
        returnsTo: "x.example",
      }),
    );
    expect(page().querySelector("img[src='x']")).toBeNull();
    const second = [...page().querySelectorAll(".consent__app .small")].map((e) => e as HTMLElement);
    expect(second[0]?.textContent).toContain("**Claude**<b>oi</b><img src=x onerror=al…");
    expect(second[0]?.getAttribute("title")).toBe(hostile);
    expect(title().querySelectorAll("b")).toHaveLength(1);
  });

  test("a program on this computer: the computer, a loopback warning and its port in where it returns", async () => {
    await open((apps) =>
      apps.addConsent(REQ, {
        displayKind: "loopback",
        name: "Claude Code",
        host: null,
        brand: null,
        returnsTo: "localhost:33418\u200b",
        reservedNameWarning: true,
      }),
    );
    expect(title().textContent).toBe("Um programa neste computador quer acessar sua conta");
    expect(page().textContent).toContain("Ele se apresenta como Claude Code");
    expect(page().textContent).toContain("Qualquer programa neste computador pode receber este acesso.");
    expect(page().querySelector(".consent__app .ac-brand svg")).not.toBeNull();
    expect(page().textContent).toContain("Volta para localhost:33418\\u{200b}");
    // No address above to check: the warning says what is unproven instead.
    expect(within(page()).getByRole("alert").textContent).toBe(
      "Este nome não foi confirmado. Nada prova que este programa é mesmo Claude Code.",
    );
  });

  test("Cursor's own scheme: Cursor, its mark, and back to the app on this computer", async () => {
    await open((apps) =>
      apps.addConsent(REQ, {
        displayKind: "app_scheme",
        name: "Cursor",
        host: null,
        brand: "cursor",
        returnsTo: "cursor://anysphere.cursor-mcp",
      }),
    );
    expect(title().textContent).toBe("Cursor quer acessar sua conta");
    expect(page().textContent).toContain("Volta para o app Cursor neste computador");
    expect(page().querySelector(".consent__app .ac-brand")?.getAttribute("data-mark")).toBe("cursor");
    // Said once, in words: the raw scheme never shows.
    expect(page().textContent?.match(/Volta para/g)).toHaveLength(1);
    expect(page().textContent).not.toContain("cursor://");
  });

  test("an app that asks only to read: no sending to choose", async () => {
    await open((apps) =>
      apps.addConsent(
        REQ,
        {},
        {
          request: {
            id: REQ,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            access: { requested: ["read"] },
            client: {
              displayKind: "verified",
              name: "Claude",
              host: "claude.ai",
              brand: "claude",
              returnsTo: "claude.ai",
              reservedNameWarning: false,
            },
          },
        },
      ),
    );
    expect(within(page()).queryByRole("radio", { name: /Ler e mandar/ })).toBeNull();
    expect(
      within(page())
        .getByRole("radio", { name: /Só ler/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("an app that asks to manage: creating agents, routines and skills is offered but not picked, said plainly, and goes once", async () => {
    const { state } = await open((apps) =>
      apps.addConsent(
        REQ,
        {},
        {
          request: {
            id: REQ,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            access: { requested: ["read", "write", "manage"] },
            client: {
              displayKind: "verified",
              name: "Claude",
              host: "claude.ai",
              brand: "claude",
              returnsTo: "claude.ai",
              reservedNameWarning: false,
            },
          },
        },
      ),
    );
    expect(
      within(page())
        .getByRole("radio", { name: /Ler e mandar tarefas/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const can = page().querySelector(".consent__list--can") as HTMLElement;
    expect(can.textContent).toContain("Mandar mensagens como você");
    expect(can.textContent).not.toContain("Criar e editar");
    await click(within(page()).getByRole("radio", { name: /Criar e editar agentes, rotinas e skills/ }));
    expect(can.textContent).toContain("Criar e editar agentes, rotinas e skills como você.");
    await click(within(page()).getByRole("button", { name: "Permitir" }));
    expect(calls(state, "apps.decide")).toEqual([[REQ, { decision: "allow", orgId: ORG_ID, access: "manage" }]]);
  });

  test("several workspaces: a picker, paused ones shown and not choosable; a workspace paused meanwhile says so", async () => {
    const OTHER = "00000000-0000-4000-8000-0000000000f2";
    const PAUSED = "00000000-0000-4000-8000-0000000000f3";
    const { state, apps } = await open((fake) =>
      fake.addConsent(
        REQ,
        {},
        {
          workspaces: [
            { id: ORG_ID, name: "Acme", logo: null, paused: false, current: true },
            { id: OTHER, name: "Estúdio", logo: null, paused: false, current: false },
            { id: PAUSED, name: "Antiga", logo: null, paused: true, current: false },
          ],
        },
      ),
    );
    const picker = within(page()).getByRole("combobox", { name: "Workspace" });
    expect(picker.textContent).toContain("Acme");
    const consent = apps.consents.get(REQ);
    if (consent) consent.workspaces[0] = { ...consent.workspaces[0], paused: true } as (typeof consent.workspaces)[0];
    await click(within(page()).getByRole("button", { name: "Permitir" }));
    expect(calls(state, "apps.decide")).toHaveLength(1);
    expect(within(page()).getByRole("alert").textContent).toBe("Este workspace está pausado. Escolha outro.");
    expect(assign).not.toHaveBeenCalled();
  });

  test("one being deleted says so with its date, not that it's paused", async () => {
    const dueAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await open((fake) =>
      fake.addConsent(
        REQ,
        {},
        { workspaces: [{ id: ORG_ID, name: "Acme", logo: null, paused: true, current: true, deletion: { dueAt } }] },
      ),
    );
    expect(page().textContent).toContain("Acme (Sendo apagado, some em");
    expect(page().textContent).not.toContain("Acme (pausado)");
  });

  test("the only workspace paused: says so and links to it; Permitir stays off", async () => {
    await open((apps) =>
      apps.addConsent(REQ, {}, { workspaces: [{ id: ORG_ID, name: "Acme", logo: null, paused: true, current: true }] }),
    );
    expect(page().textContent).toContain("Acme (pausado)");
    expect(within(page()).getByRole("alert").textContent).toContain(
      "Este workspace está pausado. Ative-o para conectar apps.",
    );
    expect(within(page()).getByRole("link", { name: "Abrir o workspace" }).getAttribute("href")).toBe(`/org/${ORG_ID}`);
    expect(within(page()).getByRole("button", { name: "Permitir" }).hasAttribute("disabled")).toBe(true);
  });

  test("every workspace paused: says so above the picker", async () => {
    await open((apps) =>
      apps.addConsent(
        REQ,
        {},
        {
          workspaces: [
            { id: ORG_ID, name: "Acme", logo: null, paused: true, current: true },
            { id: "00000000-0000-4000-8000-0000000000f2", name: "Estúdio", logo: null, paused: true, current: false },
          ],
        },
      ),
    );
    expect(within(page()).getByRole("alert").textContent).toContain("Todos os seus workspaces estão pausados.");
  });

  test("no workspace yet: says so, with Criar workspace", async () => {
    await open((apps) => apps.addConsent(REQ, {}, { workspaces: [] }));
    expect(page().textContent).toContain("Você ainda não está em um workspace");
    expect(within(page()).getByRole("link", { name: "Criar workspace" }).getAttribute("href")).toBe("/onboarding");
  });

  test("a request unknown, already answered or expired: back to the app; it never revokes anything", async () => {
    const { state } = await open();
    expect(page().textContent).toContain("Este pedido expirou");
    expect(within(page()).getByRole("link", { name: "Ir para o agentes.chat" }).getAttribute("href")).toBe("/");
    expect(page().querySelector(".ac-empty:not(.consent__state)")).toBeNull();
    expect(page().textContent).toContain("Volte ao app e conecte de novo.");
    expect(calls(state, "apps.decide")).toEqual([]);
    cleanup();

    await open((apps) => {
      apps.addConsent(REQ);
      apps.nextError = new ApiError(410, "request_expired", "Expired");
    });
    expect(page().textContent).toContain("Este pedido expirou");
  });

  test("the server out of reach: Tentar de novo asks again", async () => {
    await open((apps) => {
      apps.addConsent(REQ);
      apps.nextError = new ApiError(503, "unavailable", "Down");
    });
    expect(page().textContent).toContain("Não foi possível continuar agora");
    await click(within(page()).getByRole("button", { name: "Tentar de novo" }));
    expect(title().textContent).toBe("Claude quer acessar sua conta");
  });

  test("the server's own refusals before a request: shown without signing in, nothing of the request echoed", async () => {
    const cases: [string, string][] = [
      ["app_desconhecido", "No Claude Code, digite /mcp, escolha agentes e Clear authentication."],
      ["pedido_invalido", "O app mandou um pedido de conexão incompleto."],
      [
        "endereco_de_retorno",
        "Este app pediu para voltar a um endereço que ele não registrou. Por segurança, paramos aqui.",
      ],
      ["muitas_tentativas", "Muitas tentativas"],
      ["indisponivel", "Não foi possível continuar agora"],
      ["<script>", "Não foi possível continuar agora"],
    ];
    for (const [code, says] of cases) {
      const { router } = await open(undefined, seedState({ me: null }), `/autorizar?erro=${encodeURIComponent(code)}`);
      expect(router.state.location.pathname).toBe("/autorizar");
      expect(page().textContent).toContain(says);
      expect(page().textContent).not.toContain("<script>");
      cleanup();
    }
  });

  test("the language switch changes this page only", async () => {
    await open((apps) => apps.addConsent(REQ));
    // The app's own language on this browser (matched with the server's at sign-in) stays as it was.
    const kept = localStorage.getItem("agentes.locale");
    await pick(within(page()).getByRole("combobox", { name: "Idioma" }), "English");
    await settle(6);
    expect(title().textContent).toBe("Claude wants to access your account");
    expect(within(page()).getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(localStorage.getItem("agentes.locale")).toBe(kept);
  });
});
