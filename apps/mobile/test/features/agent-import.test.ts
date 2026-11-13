import { describe, expect, test } from "bun:test";
import type { ImportItemResult, MigrationBundle } from "@agenteschat/client";
import { cardName, defaultMethod, IMPORT_CARDS, mcpClient } from "@agenteschat/client/lib/import/flow";
import { parseImport } from "@agenteschat/client/lib/import/index";
import {
  agentRows,
  arrivedAgents,
  isRequestCard,
  kindGroups,
  landingOf,
  pasteAction,
  phoneOffline,
  phonePicks,
  planIn,
  reportCounts,
  takesFiles,
  todoHref,
} from "../../src/features/agents/import";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";

const bundle = (over: Partial<MigrationBundle> = {}): MigrationBundle => ({
  format: "agenteschat.bundle",
  version: 1,
  source: { app: "openmausbot", ref: "team", name: "Equipe", files: [] },
  agents: [
    {
      key: "vera",
      name: "Vera",
      handle: "vera",
      role: "Vendas",
      instructions: "",
      model: null,
      appearance: { color: "rose" },
      skills: [],
    },
    { key: "otto", name: "Otto", handle: "otto", role: "", instructions: "", model: null, appearance: {}, skills: [] },
  ],
  skills: [],
  channels: [],
  routines: [{ key: "daily", name: "Resumo", agent: "otto", channel: null, schedule: "0 9 * * *", prompt: "x" }],
  notes: [],
  todo: [],
  leftOut: [],
  ...over,
});

const item = (kind: ImportItemResult["kind"], key: string, action: ImportItemResult["action"], more = {}) =>
  ({ kind, key, label: key, action, ...more }) as ImportItemResult;

describe("Importar agentes on the phone: which picked files are read", () => {
  test("text files the formats use are read; images, keys and big files go in empty", () => {
    const { read, archive } = phonePicks([
      { name: "team.json", size: 1200 },
      { name: "SOUL.md", size: 300 },
      { name: "photo.png", size: 10 },
      { name: ".env", size: 10 },
      { name: "huge.json", size: 5 * 1024 * 1024 },
    ]);
    expect(read).toEqual([true, true, false, false, false]);
    expect(archive).toBe(false);
  });

  test("only archives: the phone opens none, so it says so", () => {
    expect(phonePicks([{ name: "export.zip", size: 10 }]).archive).toBe(true);
    expect(phonePicks([{ name: "profile.tar.gz" }, { name: "b.tgz" }]).archive).toBe(true);
    expect(phonePicks([{ name: "export.zip" }, { name: "team.json" }]).archive).toBe(false);
    expect(phonePicks([]).archive).toBe(false);
  });

  test("the request cards are the apps that answer the export request", () => {
    expect(IMPORT_CARDS.filter(isRequestCard)).toEqual(["grok-bot", "chatgpt-dots", "other"]);
  });

  test("each source's way in on the phone, as on the web: MCP where the app takes it and the server is reachable", () => {
    expect(IMPORT_CARDS.map((c) => [c, defaultMethod(c, true), defaultMethod(c, false)])).toEqual([
      ["grok-bot", "mcp", "prompt"],
      ["chatgpt-dots", "prompt", "prompt"],
      ["openbotrun", "mcp", "prompt"],
      ["openmausbot", "mcp", "prompt"],
      ["hermes", "mcp", "prompt"],
      ["openclaw", "mcp", "prompt"],
      ["paperclip", "prompt", "prompt"],
      ["agenteschat", "prompt", "prompt"],
      ["other", "mcp", "prompt"],
    ]);
    // Everything the steps need is copied or opened from the phone: no step hands out a token.
    const url = "https://agentes.example/mcp";
    for (const c of IMPORT_CARDS)
      expect(
        mcpClient(c)
          ?.guide(url)
          .steps.some((s) => s.token) ?? false,
      ).toBe(false);
  });

  test("Choose files is hidden only for Grok Bot, which answers in chat (ChatGPT dots makes a file)", () => {
    expect(IMPORT_CARDS.filter((c) => !takesFiles(c))).toEqual(["grok-bot"]);
    expect(takesFiles(null)).toBe(true);
  });

  test("every other card has its phone how-to, in both languages", () => {
    const cards = IMPORT_CARDS.filter((c) => !isRequestCard(c));
    expect(Object.keys(featureKeysPtBR.newAgent.import.where).sort()).toEqual([...cards].sort());
    expect(Object.keys(featureKeysEn.newAgent.import.where).sort()).toEqual([...cards].sort());
  });

  test("card names: brands as they are, ours and any other app in words", () => {
    const t = ((k: string) => `t:${k}`) as never;
    expect(cardName(t, "grok-bot")).toBe("Grok Bot");
    expect(cardName(t, "hermes")).toBe("Hermes Agent");
    expect(cardName(t, "other")).toBe("t:onboarding.import.otherName");
  });

  test("a pasted reply in our format is read on the phone into a bundle", () => {
    const reply = JSON.stringify({
      format: "agenteschat.bundle",
      version: 1,
      source: { app: "agenteschat", ref: "grok-bot:x", name: "Bot", files: [] },
      agents: [{ key: "lia", name: "Lia", handle: "lia", role: "Pesquisa", instructions: "Oi", model: null }],
    });
    const parsed = parseImport([{ name: "pasted", text: reply }]);
    expect(parsed.agents.map((a) => a.name)).toEqual(["Lia"]);
  });
});

describe("Importar agentes on the phone: the preview", () => {
  test("agents: new ones first, the @ they get here, and what can't be picked", () => {
    const b = bundle();
    const items = [
      item("agent", "otto", "unchanged"),
      item("agent", "vera", "create", { renamedTo: "vera2", reason: "model_not_in_catalog" }),
    ];
    const rows = agentRows(b, items, new Set(["agent:vera"]), new Map());
    expect(rows.map((r) => [r.name, r.handle, r.status, r.free, r.on, r.reason])).toEqual([
      ["Vera", "vera2", "create", true, true, "model_not_in_catalog"],
      ["Otto", "otto", "unchanged", false, true, null],
    ]);
    expect(rows[0]?.role).toBe("Vendas");
    expect(rows.map((r) => r.wanted)).toEqual(["vera", null]);
    expect(agentRows(b, items, new Set(), new Map())[0]?.on).toBe(false);
  });

  test("an id another app gave an agent is no handle and no rename", () => {
    const id = "0f8e2a1c-4b3d-4e5f-9a7b-1c2d3e4f5a6b";
    const b = bundle({
      agents: [
        { key: "x", name: "X", handle: id, role: "", instructions: "", model: null, appearance: {}, skills: [] },
      ],
    });
    expect(agentRows(b, [item("agent", "x", "create")], new Set(), new Map())[0]).toMatchObject({
      handle: null,
      wanted: null,
    });
    expect(agentRows(b, [item("agent", "x", "create", { renamedTo: "x2" })], new Set(), new Map())[0]).toMatchObject({
      handle: "x2",
      wanted: null,
    });
  });

  test("the rest by kind: one switch over what can be picked, skipped ones left out", () => {
    const items = [
      item("agent", "otto", "create"),
      item("routine", "daily", "create"),
      item("skill", "a", "unchanged"),
      item("skill", "b", "create"),
      item("note", "n", "skip", { reason: "secret_like" }),
    ];
    const pick = new Set(["agent:otto", "routine:daily"]);
    expect(kindGroups(items, pick, new Map())).toEqual([
      { kind: "skill", coming: 1, total: 2, free: ["skill:b"], on: false },
      { kind: "routine", coming: 1, total: 1, free: ["routine:daily"], on: true },
    ]);
    // A routine whose agent was unchecked can't come: nothing to switch.
    const blocked = new Map([["routine:daily", "agent_not_picked" as const]]);
    expect(kindGroups(items, new Set(), blocked)[1]).toEqual({
      kind: "routine",
      coming: 0,
      total: 1,
      free: [],
      on: false,
    });
  });
});

describe("Importar agentes on the phone: after the import", () => {
  test("lands on the one agent's page, else on the agents tab", () => {
    expect(landingOf(["a1"])).toEqual({ href: "/agent/a1", how: "replace" });
    expect(landingOf(["a1", "a2"])).toEqual({ href: "/agents", how: "dismissTo" });
    expect(landingOf([])).toEqual({ href: "/agents", how: "dismissTo" });
    expect(landingOf(["a1"], { left: true })).toBeNull();
    expect(landingOf(["a1", "a2"], { left: true })).toBeNull();
  });

  test("the agents that arrived, and whether everything did", () => {
    const report = [
      item("agent", "vera", "create", { targetId: "a1" }),
      item("agent", "otto", "skip", { reason: "failed" }),
      item("routine", "daily", "create", { targetId: "r1" }),
    ];
    expect(arrivedAgents(report)).toEqual(["a1"]);
    expect(reportCounts(report, 3)).toEqual({ done: 2, total: 3, partial: true, capped: 0 });
    expect(reportCounts(report.slice(0, 1), 1).partial).toBe(false);
  });

  test("routines that arrived paused at their agent's limit are counted for the toast", () => {
    const report = [
      item("routine", "daily", "create", { targetId: "r1" }),
      item("routine", "extra", "create", { targetId: "r2", reason: "too_many_routines" }),
    ];
    expect(reportCounts(report, 2)).toEqual({ done: 2, total: 2, partial: false, capped: 1 });
  });

  test("offline is a request that never got an answer", () => {
    expect(phoneOffline(new TypeError("Network request failed"))).toBe(true);
    expect(phoneOffline(new Error("500"))).toBe(false);
  });
});

describe("planIn", () => {
  test("a plan shows and applies only in the workspace it was planned for", () => {
    const plan = { orgId: "org-a", items: [] };
    expect(planIn(plan, "org-a")).toBe(plan);
    expect(planIn(plan, "org-b")).toBeNull();
    expect(planIn(null, "org-a")).toBeNull();
  });
});

describe("pasteAction", () => {
  test("a link goes in the field, anything else is read without showing it", () => {
    expect(pasteAction("  https://github.com/acme/agents ")).toBe("field");
    expect(pasteAction('{"format":"agenteschat.bundle"}')).toBe("read");
    expect(pasteAction("x".repeat(3_000_000))).toBe("read");
    expect(pasteAction("  \n ")).toBeNull();
  });
});

describe("todoHref", () => {
  test("Connect opens Conectores, a file the Drive; a key or a model has no page on the phone", () => {
    expect(todoHref("connection")).toBe("/connectors");
    expect(todoHref("app")).toBe("/connectors");
    expect(todoHref("file")).toBe("/drive");
    expect(todoHref("secret")).toBeNull();
    expect(todoHref("model")).toBeNull();
  });
});
