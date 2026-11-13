import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { Approval } from "../src/index";
import {
  actionName,
  approvalDetail,
  approvalRuleWords,
  approvalTitle,
  approveAlwaysWords,
} from "../src/lib/approval-words";
import { catalogLabel, labelIsName, TOOL_LABELS, toolKey } from "../src/lib/tool-labels";
import { partsOf, toolName } from "../src/lib/tool-review";
import { toolLineHint } from "../src/lib/work";

const tOf = (lng: string): TFunction => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
  return instance.t;
};
const pt = tOf("pt-BR");
const en = tOf("en");
const es = tOf("es");

const approval = (over: Partial<Approval>): Approval =>
  ({
    tool: "merge_pull_request",
    scope: "github:pr.merge",
    title: "Merge PR #42 into main",
    detail: "",
    params: {},
    email: null,
    connector: null,
    ...over,
  }) as Approval;

describe("the catalog of tool names", () => {
  test("every key is a name as written once its app is off; every label a verb phrase in plain copy", () => {
    const bad: string[] = [];
    for (const [key, labels] of Object.entries(TOOL_LABELS)) {
      if (toolKey(key).key !== key) bad.push(`${key}: key reads as ${toolKey(key).key}`);
      for (const label of labels) {
        if (!/^\p{Lu}/u.test(label)) bad.push(`${key}: "${label}" starts in lower case`);
        if (/[;"“”«»]|\.$/.test(label)) bad.push(`${key}: "${label}" has a semicolon, a quote or a full stop`);
        if (/_/.test(label)) bad.push(`${key}: "${label}" reads like code`);
      }
    }
    expect(bad).toEqual([]);
    expect(Object.keys(TOOL_LABELS).length).toBeGreaterThan(400);
  });

  test("found however the server writes the name, without its app, account or articles", () => {
    const cases: [string, string, string][] = [
      ["github.merge_pull_request", "Merge a pull request", "Fazer merge de um PR"],
      ["github_merge_pull_request", "Merge a pull request", "Fazer merge de um PR"],
      ["GITHUB_CREATE_AN_ISSUE", "Create issue", "Criar issue"],
      ["mcp__higgsfield__generate_image", "Generate image", "Gerar imagem"],
      ["higgsfield-generate-image", "Generate image", "Gerar imagem"],
      ["ONE_DRIVE_ONEDRIVE_LIST_ITEMS", "List files", "Listar arquivos"],
      ["MICROSOFT_TEAMS_TEAMS_LIST", "List teams", "Listar equipes"],
      ["stripe_2_list_customers", "List customers", "Listar clientes"],
      ["getJiraIssue", "See Jira issue", "Ver issue do Jira"],
      ["SLACK_SEND_MESSAGE", "Send message", "Enviar mensagem"],
      ["browser_click", "Click on the page", "Clicar na página"],
    ];
    for (const [name, english, portuguese] of cases) {
      expect({ name, en: catalogLabel(en, name), pt: catalogLabel(pt, name) }).toEqual({
        name,
        en: english,
        pt: portuguese,
      });
    }
    expect(toolKey("GITHUB_CREATE_AN_ISSUE")).toEqual({ app: "GitHub", key: "create_issue" });
    expect(catalogLabel(pt, "frobnicate_widget")).toBeNull();
  });

  test("another language builds the name from its own verbs and nouns", () => {
    expect(catalogLabel(es, "create_issue")).toBeNull();
    expect(toolName(es, partsOf("create_issue"), "create_issue")).toStartWith(es("toolNames.verb.create"));
    expect(es("toolNames.verb.create")).not.toBe("Create");
  });

  test("a name the catalog doesn't know reads as words, its verb in the language, without the app beside it", () => {
    expect(toolName(pt, partsOf("frobnicate_widget"), "frobnicate_widget")).toBe("Frobnicate widget");
    expect(toolName(pt, partsOf("higgsfield.magic_tool"), "higgsfield.magic_tool")).toBe("Magic tool");
    expect(toolName(pt, partsOf("list_widgets"), "list_widgets")).toBe("Listar widgets");
  });
});

describe("tool names where people see them", () => {
  test("an approval card: a risky kind keeps its own words, and the line under it drops the code name", () => {
    const merge = approval({ detail: "github.merge_pull_request · agentes-chat/app · PR 42" });
    expect(approvalTitle(pt, merge)).toBe("Fazer um merge");
    expect(approvalDetail(merge, "pt-BR")).toBe("agentes-chat/app · PR 42");
    expect(approvalTitle(pt, approval({ params: { owner: "agentes-chat", repo: "app", pullNumber: 42 } }))).toBe(
      "Fazer merge do PR #42 em agentes-chat/app",
    );
    // A call kept after its connection went: its values in words, never `key=value`.
    const raw = approval({
      detail: "github.merge_pull_request · owner=acme · pullNumber=7",
      params: { owner: "acme", pullNumber: 7 },
    });
    expect(approvalDetail(raw, "pt-BR")).toBe("Owner: acme · Pull number: 7");
    // Anything else keeps its own detail (code, a text).
    expect(approvalDetail(approval({ tool: "run_code", detail: "print(1) · 2" }), "pt-BR")).toBe("print(1) · 2");
  });

  test("GitHub's newer tools in words; a repository's deletion says which repository", () => {
    const deletion = approval({
      tool: "github_delete_repository",
      scope: "github:repo.admin",
      title: "Delete acme/old",
      connector: "github",
      params: { owner: "acme", repo: "old" },
    });
    expect(approvalTitle(pt, deletion)).toBe("Apagar o repositório acme/old");
    expect(approvalTitle(en, deletion)).toBe("Delete the repository acme/old");
    expect(catalogLabel(pt, "github_discussion_comment_write")).toBe("Comentar numa discussão");
    expect(catalogLabel(en, "github_get_secret_scanning_alert")).toBe("See leaked secret alert");
    // A language without a column builds them from its own verbs and nouns, none left in English.
    const name = "list_repository_security_advisories";
    expect(toolName(es, partsOf(name), name)).toBe("Listar avisos de seguridad del repositorio");
    expect(toolName(es, partsOf("get_dependabot_alert"), "get_dependabot_alert")).toBe("Obtener alerta de Dependabot");
  });

  test("a custom server's tool: worded unless someone named it on the review", () => {
    const image = approval({
      tool: "higgsfield_generate_image",
      scope: "custom:c1:approval",
      title: "Higgsfield: Generate image",
      connector: "custom:c1",
      params: { prompt: "capa" },
    });
    expect(approvalTitle(pt, image)).toBe("Gerar imagem");
    expect(approvalTitle(pt, { ...image, title: "Higgsfield: Gerar capa do episódio" })).toBe(
      "Higgsfield: Gerar capa do episódio",
    );
    expect(labelIsName("Generate image", "generate_image")).toBe(true);
    expect(labelIsName("Gerar capa", "generate_image")).toBe(false);
  });

  test("Aprovar sempre and its rules, Composio's actions, a step's grey words", () => {
    expect(approveAlwaysWords(pt, { approveAlways: { tool: "generate_image", actions: [] } })).toBe("Gerar imagem");
    const rule = { tool: "generate_image", action: "", toolLabel: "Generate image", connectionId: "c1" };
    expect(approvalRuleWords(pt, rule)).toBe("Gerar imagem");
    expect(approvalRuleWords(pt, { ...rule, toolLabel: "Gerar capa" })).toBe("Gerar capa");
    expect(actionName(pt, "GITHUB_CREATE_AN_ISSUE_COMMENT")).toBe("Comentar numa issue (GitHub)");
    expect(actionName(pt, "ONE_DRIVE_ONEDRIVE_LIST_ITEMS")).toBe("Listar arquivos (OneDrive)");
    expect(toolLineHint(pt, { kind: "consulting", hint: "search issues", code: undefined, autoApproved: null })).toBe(
      "Buscar issues",
    );
    // A built-in's own detail stays as it is.
    expect(toolLineHint(pt, { kind: "openingSkill", hint: "relatorio", code: undefined, autoApproved: null })).toBe(
      "relatorio",
    );
  });
});
