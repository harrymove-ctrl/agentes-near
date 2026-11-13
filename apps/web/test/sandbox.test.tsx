import { describe, expect, test } from "bun:test";
import type { AgentAccess } from "@agenteschat/client";
import { inputWithLevels, levelsOf, resourcesOf } from "@agenteschat/client/lib/access-levels";
import { activityText, toolActivity } from "@agenteschat/client/lib/activity";
import { createI18n } from "@/i18n";

describe("Rodar código is not covered by 'Todas as ferramentas'", () => {
  test("all tools on: the sandbox tools stay off until granted on their own", () => {
    const access: AgentAccess = {
      all: true,
      builtins: [
        {
          scope: "issues:write",
          label: "Issues",
          state: "inherited",
          tools: [
            {
              name: "create_issue",
              label: "Criar e editar issues",
              description: "",
              connectionId: null,
              scope: "issues:write",
              sensitive: false,
              readOnly: false,
              state: "inherited",
            },
          ],
        },
        {
          scope: "sandbox:run",
          label: "Rodar código",
          state: "off",
          tools: [
            {
              name: "run_code",
              label: "Rodar código",
              description: "",
              connectionId: null,
              scope: "sandbox:run",
              sensitive: false,
              readOnly: false,
              state: "off",
            },
          ],
        },
      ],
      connectors: [],
    };
    expect(resourcesOf(access).map((r) => [r.id, r.levels.join("/"), r.notInAll])).toEqual([
      ["area:issues", "none/write", false],
      ["area:sandbox", "none/write", true],
    ]);
    expect(levelsOf(access)).toEqual({ "area:issues": "write", "area:sandbox": "none" });
    // Lowering another area spells "all tools" out, and running code stays off.
    const put = inputWithLevels(access, [], { "area:issues": "none" });
    expect(put.all).toBe(false);
    expect(put.scopes).toEqual([]);
  });
});

describe("activity bar: the PC", () => {
  test("verbs for the sandbox tools", () => {
    const i18n = createI18n("pt-BR");
    const t = i18n.t.bind(i18n);
    const say = (tool: string, detail?: string) =>
      activityText(t, [{ id: "a", type: "agent", name: "Theo", activity: toolActivity(tool, null, detail) }]);
    expect(say("run_code")).toBe("Theo está rodando código…");
    expect(say("write_file")).toBe("Theo está mexendo nos arquivos do PC…");
    expect(say("export_file")).toBe("Theo está salvando um arquivo no Drive…");
    expect(say("import_file")).toBe("Theo está trazendo um arquivo do Drive…");
    expect(say("run_skill_script", "Revisão de PR")).toBe("Theo está rodando um script da skill Revisão de PR…");
    expect(say("run_skill_script")).toBe("Theo está rodando um script de skill…");
    expect(say("share_artifact")).toBe("Theo está trazendo um arquivo…");
  });
});
