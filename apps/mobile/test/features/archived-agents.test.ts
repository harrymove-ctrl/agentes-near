import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
const src = (path: string) => readFileSync(join(SRC, path), "utf8");

describe("an archived agent, on the phone too", () => {
  test("an archived agent comes back from Agentes, as on the web's Equipe", () => {
    const screen = src("features/agents/AgentsScreen.tsx");
    expect(screen).toContain("useUnarchiveAgent");
    expect(screen).toContain('t("team.restore")');
    expect(screen).toContain("chooseAction(");
  });
});
