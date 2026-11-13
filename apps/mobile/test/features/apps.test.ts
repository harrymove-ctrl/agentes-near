import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectedApp, PersonalToken } from "@agenteschat/client";
import {
  aiAppImport,
  appCreatedLine,
  appFacts,
  appMark,
  appsSettingsUrl,
  requestedAccess,
  tokenFacts,
} from "@agenteschat/client/lib/apps";
import { openTarget } from "@agenteschat/client/lib/notifications";
import { appVia } from "@agenteschat/client/lib/via";
import { markOf } from "@agenteschat/ui/brand/marks";
import { notificationHref } from "../../src/features/links/logic";
import { visibleSections } from "../../src/features/settings/logic";
import { notification, translator } from "./fixtures";

const NOW = new Date("2026-11-01T12:00:00Z");
const app = (over: Partial<ConnectedApp> = {}): ConnectedApp => ({
  id: "a",
  kind: "oauth",
  displayKind: "verified",
  name: "Claude",
  host: "claude.ai",
  brand: "claude",
  access: "write",
  connectedAt: "2026-10-20T12:00:00Z",
  lastUsedAt: "2026-11-01T11:30:00Z",
  ...over,
});

describe("Apps de IA on the phone (ADR 0119)", () => {
  test("everyone opens it, among the connectors", () => {
    const apps = visibleSections(undefined).find((s) => s.id === "apps");
    expect([apps?.group, apps?.href]).toEqual(["connectors", "/settings/apps"]);
  });

  test("each row's mark: the brand's own, the computer, or one letter that is never a mark", () => {
    const brand = appMark(app());
    expect(brand).toEqual({ kind: "brand", id: "claude" });
    expect(appMark(app({ brand: null, displayKind: "loopback" }))).toEqual({ kind: "computer" });
    const fake = appMark(app({ brand: null, displayKind: "https", name: "claude" }));
    expect(fake).toEqual({ kind: "initial", letter: "C" });
    expect(markOf(fake.kind === "initial" ? fake.letter : "")).toBeNull();
    expect(markOf("vscode")).toBe("vscode");
    expect(markOf("cursor")).toBe("cursor");
  });

  test("the line under each name, in both languages", async () => {
    const pt = await translator("pt-BR");
    const en = await translator("en");
    expect(appFacts(pt, "pt-BR", app(), NOW)).toBe("claude.ai · Conectado 20 out · Usado há 30 min");
    expect(appFacts(en, "en", app({ displayKind: "loopback", host: null, lastUsedAt: null }), NOW)).toBe(
      "on this computer · Connected Oct 20 · Never used",
    );
    const token: PersonalToken = {
      id: "t",
      name: "Blender",
      access: "read",
      createdAt: "2026-10-01T00:00:00Z",
      expiresAt: null,
      lastUsedAt: null,
    };
    expect(tokenFacts(pt, "pt-BR", token, NOW)).toBe("Sem validade · Nunca usado");
  });

  test("Conectar um app opens the web's section; the via tag reads only an app's meta", () => {
    expect(appsSettingsUrl("https://agentes.chat", "o-1")).toBe("https://agentes.chat/org/o-1/settings/apps");
    expect(appVia({ via: { kind: "app", name: " Cursor ", brand: "cursor" } })).toEqual({
      name: "Cursor",
      brand: "cursor",
    });
    expect(appVia({ via: { kind: "app", name: "" } })).toBeNull();
    expect(appVia(null)).toBeNull();
  });

  test("the screen is in the stack, pushed", () => {
    const layout = readFileSync(join(import.meta.dir, "..", "..", "app", "(app)", "_layout.tsx"), "utf8");
    expect(layout).toContain(`name="settings/apps" options={{ ...pushed, ...scrollUnder }}`);
  });

  test("what an AI app created, in one line in both languages, opening the newest agent or routine", async () => {
    const pt = await translator("pt-BR");
    const en = await translator("en");
    const n = notification({
      id: "n",
      kind: "app_created",
      latest: { title: "Claude", created: { agent: 3, routine: 2 } },
      source: { agentId: "0192f0a0-0000-7000-8000-0000000000aa" },
    });
    expect(appCreatedLine(pt, n)).toBe("Claude criou 3 agentes e 2 rotinas pelo app");
    expect(appCreatedLine(en, { latest: { title: "Claude", created: { skill: 1 } } })).toBe(
      "Claude created 1 skill through the app",
    );
    expect(openTarget(n)).toEqual({ to: "/org/$orgId/agents/$agentId", params: { agentId: n.source.agentId ?? "" } });
    expect(notificationHref(n)).toBe(`/agent/${n.source.agentId}`);
    expect(openTarget({ ...n, source: { routineId: "r-1" } })).toEqual({
      to: "/org/$orgId/routines",
      search: { open: "r-1" },
    });
  });

  test("the import's AI app option: the address and the request, or unavailable on a private server or a held workspace", async () => {
    const pt = await translator("pt-BR");
    const open = { serverUrl: "https://app.agentes.chat/mcp", serverPublic: true };
    expect(aiAppImport(pt, undefined, undefined)).toBeNull();
    expect(aiAppImport(pt, { serverUrl: "http://10.0.0.5/mcp", serverPublic: false }, undefined)).toEqual({
      available: false,
      note: "Conectar com MCP não está disponível neste servidor, porque apps na internet só alcançam um endereço https público.",
    });
    // A hold refuses an app's sign-in and its calls (`workRefusal`): a new Cloud workspace waits for its first plan.
    expect(aiAppImport(pt, open, { state: "hold", reason: "payment" })).toEqual({
      available: false,
      note: "Conectar com MCP funciona quando o plano do workspace estiver ativo. Por enquanto, traga os agentes por aqui.",
    });
    expect(aiAppImport(pt, open, { state: "suspended", reason: null })).toEqual({
      available: false,
      note: "Conectar com MCP fica desligado enquanto este workspace está pausado. Por enquanto, traga os agentes por aqui.",
    });
    const ready = aiAppImport(pt, open, { state: "active", reason: null });
    expect(ready?.available && ready.prompt).toStartWith(
      "Use o servidor MCP do agentes.chat que você acabou de conectar (https://app.agentes.chat/mcp)",
    );
    // The phone shows the request itself, selectable, not only a Copiar button.
    const card = readFileSync(
      join(import.meta.dir, "..", "..", "src", "features", "agents", "ImportAgents.tsx"),
      "utf8",
    );
    expect(card).toContain('{ text: t("onboarding.import.aiApp.paste"), copy: prompt }');
    // A command carried in the step's words (Hermes' `hermes mcp login`, `/reload-mcp`) is copied from under it too.
    expect(card).toContain("copy: s.address ? url : (s.code ?? s.vars?.command)");
    expect(card).toMatch(/<Text selectable[^>]*>\s*\{text\}/);
  });

  test("the consent picks write when asked, never manage: that one is opt-in", () => {
    const consent = (requested: ("read" | "write" | "manage")[]) =>
      ({ request: { access: { requested } } }) as Parameters<typeof requestedAccess>[0];
    expect(requestedAccess(consent(["read", "write", "manage"]))).toBe("write");
    expect(requestedAccess(consent(["read", "write"]))).toBe("write");
    expect(requestedAccess(consent(["read"]))).toBe("read");
  });
});
