import { expect, test } from "bun:test";
import glossary from "../glossary.json";
import { LOCALE_CODES } from "../src/locale";

test("every term has all 13 other languages, and some names stay as they are", () => {
  const others = LOCALE_CODES.filter((c) => c !== "en");
  for (const term of glossary.terms as Record<string, string>[])
    expect({ term: term.en, missing: others.filter((c) => !term[c]?.trim()) }).toEqual({ term: term.en, missing: [] });
  expect(glossary.keep).toContain("agentes.chat");
  expect(Object.keys(glossary.tone).sort()).toEqual([...LOCALE_CODES].sort());
});
