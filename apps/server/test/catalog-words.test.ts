import { describe, expect, test } from "bun:test";
import { CONNECTOR_CATALOG } from "@agenteschat/engine";
import { en, ptBR } from "@agenteschat/i18n";
import { TOOL_LABELS, toolKey } from "../../../packages/client/src/lib/tool-labels";

type ScopeWords = Record<string, { label?: string; description?: string } | undefined>;

describe("the connector catalog and the words people read", () => {
  test("every tool has one of its connector's scopes and the catalog's words", () => {
    const missing = Object.values(CONNECTOR_CATALOG).flatMap((def) =>
      Object.entries(def.tools).flatMap(([name, tool]) => [
        ...(def.scopes[tool.scope] ? [] : [`${def.id}.${name}: no scope ${tool.scope}`]),
        ...(TOOL_LABELS[toolKey(name).key] ? [] : [`${def.id}.${name}: no words`]),
        ...(tool.sensitive && !tool.title ? [`${def.id}.${name}: asks a person with no title`] : []),
      ]),
    );
    expect(missing).toEqual([]);
  });

  test("every scope has its label and description in English and pt-BR", () => {
    const missing: string[] = [];
    for (const def of Object.values(CONNECTOR_CATALOG)) {
      for (const id of Object.keys(def.scopes)) {
        const key = `${def.id}_${id}`.replace(/[^a-zA-Z0-9]/g, "_");
        for (const [code, tree] of [
          ["en", en],
          ["pt-BR", ptBR],
        ] as const) {
          const words = (tree.scopes as ScopeWords)[key];
          if (!words?.label || !words.description) missing.push(`${code} scopes.${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
