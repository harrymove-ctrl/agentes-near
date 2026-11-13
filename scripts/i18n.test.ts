import { describe, expect, test } from "bun:test";
import { flatten } from "../packages/i18n/test/check-locale";
import { outdatedKeys, SURFACES } from "./i18n";

describe("what the apps say", () => {
  test("no surface sends people to write in: there is no support channel to write to", () => {
    const writeIn =
      /send us|contact us|write to us|let us know|reach out|our support|support team|pra gente|fale com a gente|nos avise|entre em contato|contate o suporte/i;
    const said = Object.entries(SURFACES).flatMap(([surface, s]) =>
      [...flatten(s.en), ...flatten(s.ptBR)].map(([key, text]) => ({ surface, key, text })),
    );
    expect(said.filter((s) => writeIn.test(s.text))).toEqual([]);
  });
});

describe("translation tools", () => {
  test("a translated key whose English changed since is outdated, with the English it was translated from", () => {
    const en = { approve: "Approve and run", files_one: "One file", files_other: "{{count}} files", cancel: "Cancel" };
    const es = { approve: "Aprobar", files_one: "Un archivo", files_other: "{{count}} archivos", cancel: "Cancelar" };
    const sources = {
      approve: { value: "Approve" },
      files: { value: { one: "One file", other: "{{count}} files" } },
    };
    expect([...outdatedKeys(en, es, sources)]).toEqual([
      ["approve", { value: "Approve" }],
      // Translated before the English was kept: nobody knows what from.
      ["cancel", undefined],
    ]);
  });
});
