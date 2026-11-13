import { describe, expect, test } from "bun:test";
import { appLocale, intlLocale, isAppLocale, LOCALE_CODES, LOCALES, localeInfo } from "../src/locale";

describe("appLocale", () => {
  test("each tag's language, most preferred first", () => {
    expect(appLocale(["pt-PT"])).toBe("pt-BR");
    expect(appLocale(["pt"])).toBe("pt-BR");
    expect(appLocale(["en-GB"])).toBe("en");
    expect(appLocale([null, "en-US"])).toBe("en");
    expect(appLocale(["xx", "pt_BR"])).toBe("pt-BR");
    expect(appLocale(["xx"])).toBeNull();
  });

  test("only languages people can pick, unless `all`", () => {
    // Every language is ready today: switch one off to test the gate.
    const ja = LOCALES.find((l) => l.code === "ja") as { ready: boolean };
    ja.ready = false;
    try {
      expect(appLocale(["ja"])).toBeNull();
      expect(appLocale(["ja-JP"], true)).toBe("ja");
      expect(appLocale(["ja-JP", "en"])).toBe("en");
    } finally {
      ja.ready = true;
    }
    expect(appLocale(["ja-JP", "en"])).toBe("ja");
    expect(appLocale(["es-MX"], true)).toBe("es");
    expect(appLocale(["fr-CA"], true)).toBe("fr");
    expect(appLocale(["zh-CN"], true)).toBe("zh-Hans");
    expect(appLocale(["zh-Hans-SG"], true)).toBe("zh-Hans");
    // Traditional Chinese has no translation of its own: Simplified reads closer than English.
    expect(appLocale(["zh-TW"], true)).toBe("zh-Hans");
    expect(appLocale(["in"], true)).toBe("id");
    expect(appLocale(["in-ID"], true)).toBe("id");
  });
});

describe("the registry", () => {
  test("14 languages, English first, codes unique", () => {
    expect(LOCALE_CODES).toEqual([
      "en",
      "pt-BR",
      "es",
      "fr",
      "de",
      "it",
      "nl",
      "ja",
      "ko",
      "zh-Hans",
      "id",
      "tr",
      "pl",
      "ru",
    ]);
    expect(isAppLocale("ja")).toBe(true);
    expect(isAppLocale("xx")).toBe(false);
  });

  test("every Intl tag works, and the week starts as CLDR says", () => {
    for (const l of LOCALES) expect(Intl.getCanonicalLocales(l.intl)).toEqual([l.intl]);
    expect(LOCALES.filter((l) => l.weekStart === 0).map((l) => l.code)).toEqual([
      "en",
      "pt-BR",
      "ja",
      "ko",
      "zh-Hans",
      "id",
    ]);
    expect(localeInfo("ru").script).toBe("cyrillic");
  });
});

describe("intlLocale", () => {
  test("the browser's own tag when it is the same language", () => {
    expect(intlLocale("en", ["en-GB"])).toBe("en-GB");
    expect(intlLocale("en", ["fr-FR", "en-AU"])).toBe("en-AU");
    expect(intlLocale("en", ["fr-FR"])).toBe("en-US");
    expect(intlLocale("zh-Hans")).toBe("zh-CN");
  });
});
