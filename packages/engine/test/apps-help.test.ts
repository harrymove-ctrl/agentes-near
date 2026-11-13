import { describe, expect, test } from "bun:test";
import { helpDocument } from "@agenteschat/i18n/help";
import { APP_TOOL_NAMES } from "../src/apps/tools";

describe("the AI apps help page (ADR 0119)", () => {
  test("lists exactly the tools the MCP server registers, in both languages", () => {
    for (const locale of ["pt-BR", "en"]) {
      const tools = helpDocument("apps-de-ia", locale).sections.find((s) => s.id === "tools");
      const listed = (tools?.blocks ?? [])
        .flatMap((b) => (typeof b === "object" && "list" in b ? b.list : []))
        .map((line) => /^`([a-z_]+)`/.exec(line)?.[1]);
      expect({ locale, listed }).toEqual({ locale, listed: [...APP_TOOL_NAMES] });
    }
  });
});
