import { describe, expect, test } from "bun:test";
import { en, ptBR, resources, STRINGS } from "../src/index";
import { loadStrings } from "../src/load";
import { LOCALE_CODES, LOCALES } from "../src/locale";
import { checkLocale, flatten } from "./check-locale";
import identical from "./identical.json";

const SAME_AS_EN: Record<string, string[]> = identical.app;

describe("every language against English", () => {
  for (const { code, ready } of LOCALES.filter((l) => l.code !== "en")) {
    test(code, () => {
      expect(checkLocale({ source: en, target: STRINGS[code], code, ready, identical: SAME_AS_EN[code] })).toEqual([]);
    });
  }
});

describe("the check itself", () => {
  const source = { files_one: "One file from {{name}}", files_other: "{{count}} files from {{name}}" };
  test("every plural form keeps its English form's placeholders", () => {
    const target = {
      files_one: "{{count}} файл от {{name}}",
      files_few: "файла",
      files_many: "{{count}} файлов от {{name}}",
      files_other: "{{count}} файла от {{name}}",
    };
    expect(checkLocale({ source, target, code: "ru", ready: true })).toEqual([
      "files_few: placeholders none ≠ English {{name}} {{count}}",
    ]);
  });
  test("the number may be a word only where `_one` means 1 alone", () => {
    const target = (one: string) => ({ files_one: one, files_other: "{{count}} Dateien von {{name}}" });
    expect(checkLocale({ source, target: target("Eine Datei von {{name}}"), code: "de", ready: true })).toEqual([]);
    expect(
      checkLocale({
        source,
        target: {
          ...target("один файл от {{name}}"),
          files_few: "{{count}} файла от {{name}}",
          files_many: "{{count}} файлов от {{name}}",
        },
        code: "ru",
        ready: true,
      }),
    ).toEqual(["files_one: placeholders {{name}} ≠ English {{name}} {{count}}"]);
  });
});

describe("English, the source", () => {
  test("no empty values (the custom role starts with no instructions)", () => {
    expect(flatten(en).filter(([k, v]) => !v.trim() && k !== "newAgent.roles.custom.instructions")).toEqual([]);
  });

  test("the identical lists name only keys English has", () => {
    const keys = new Set(flatten(en).map(([k]) => k.replace(/_(female)?(_?(zero|one|two|few|many|other))?$/, "")));
    for (const list of Object.values(SAME_AS_EN)) expect(list.filter((k) => !keys.has(k))).toEqual([]);
  });
});

describe("proposal evidence", () => {
  test("every evidence type has a label (mirror of ContextEvidence in packages/db/src/schema/context.ts)", () => {
    for (const tree of [ptBR, en]) {
      expect(Object.keys(tree.proposals.evidence).sort()).toEqual(["agent", "app", "human", "outcome", "self"]);
    }
  });
});

describe("menu paths", () => {
  test("a path to a setting stays on one line: no-break spaces around its ›", () => {
    for (const tree of [ptBR, en]) {
      const paths = flatten(tree)
        .map(([, v]) => v)
        .filter((s) => s.includes("›"));
      expect(paths.length).toBeGreaterThanOrEqual(4);
      for (const s of paths) expect({ s, alone: s.split(" › ").join("").includes("›") }).toEqual({ s, alone: false });
    }
  });
});

describe("closing words", () => {
  test("the chat's no-AI lines end on two words held together, never on one alone", () => {
    for (const tree of [ptBR, en])
      for (const s of [tree.noAi.agent, tree.noAi.signedOut, tree.noAi.banner.org, tree.noAi.card.stillMissing])
        expect({ s, together: / \S+$/.test(s) }).toEqual({ s, together: true });
  });
});

describe("examples in one-line fields", () => {
  test("fit a 360px phone's field: one email address, a short database address", () => {
    for (const code of LOCALE_CODES) {
      const tree = resources[code].translation as { onboarding?: { team?: { placeholder?: string } } } & Record<
        string,
        unknown
      >;
      const leaves = new Map(flatten(tree as never));
      for (const key of ["onboarding.team.placeholder", "members.emailsPlaceholder"])
        expect(leaves.get(key) ?? "").not.toContain(",");
      // The database field holds about 38 characters of its 16px text at 360px.
      expect((leaves.get("database.urlPlaceholder") ?? "").length).toBeLessThanOrEqual(36);
    }
  });
});

describe("loading", () => {
  test("one loader and one i18next namespace per language", async () => {
    expect(Object.keys(loadStrings).sort()).toEqual([...LOCALE_CODES].sort());
    expect(Object.keys(resources).sort()).toEqual([...LOCALE_CODES].sort());
    expect(await loadStrings.en()).toBe(en);
    expect((await loadStrings["pt-BR"]()).common).toEqual(resources["pt-BR"].translation.common);
    expect(await loadStrings.ja()).toEqual((await import("../src/locales/ja.json")).default);
  });
});
