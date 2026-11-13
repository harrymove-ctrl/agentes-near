import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("pickers are the app's sheet, never the system's alert list", () => {
  test("one host at the root serves every picker and Android's action menus", () => {
    expect(src("providers/AppProviders.tsx")).toContain("<PickerHost />");
    expect(existsSync(join(import.meta.dir, "../../src/ui/ChoiceHost.tsx"))).toBe(false);
    expect(src("features/settings/parts.tsx")).toContain("if (showActionSheet(title, options)) return;");
    const sheet = src("features/shared/PickerSheet.tsx");
    // Faces for people and agents, a tile for icons, the check on the one in use, a search on long lists.
    expect(sheet).toContain('<Face who={{ type: "person", id: lead.userId }} size={36} />');
    expect(sheet).toContain("<AgentFace agentId={lead.agentId} size={36} framed live={live} />");
    expect(sheet).toContain("const SEARCH_FROM = 9;");
    expect(sheet).toContain("haptics.selection();");
  });

  test("the pickers go through pickOne, with who or what each option is", () => {
    const sector = src("features/team/SectorScreen.tsx");
    expect(sector).toContain("pickOne({");
    expect(sector).toContain('leading: { kind: "person" as const, userId: m.userId }');
    expect(sector).not.toContain("chooseAction");
    for (const file of [
      "features/me/MeScreen.tsx",
      "features/routines/RoutineForm.tsx",
      "features/settings/AuditScreen.tsx",
      "features/computer/usePickComputer.ts",
      "features/vault/VaultConnectScreen.tsx",
      "features/connectors/ToolReview.tsx",
      "features/dashboards/menu.tsx",
    ]) {
      expect({ file, picks: src(file).includes("pickOne({") }).toEqual({ file, picks: true });
    }
    for (const file of ["features/connectors/Access.tsx", "features/connectors/MailboxSheet.tsx"]) {
      expect({ file, picks: src(file).includes("pickLevel(t,") }).toEqual({ file, picks: true });
    }
  });
});
