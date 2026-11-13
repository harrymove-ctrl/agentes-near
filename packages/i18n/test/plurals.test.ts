import { describe, expect, test } from "bun:test";
import i18next from "i18next";
import { fillPluralGaps } from "../src/plurals";

const people = { people_one: "{{count}} pessoa", people_other: "{{count}} pessoas" };

function t(lng: string, strings: Record<string, string>) {
  const instance = i18next.createInstance();
  void instance.init({
    lng,
    fallbackLng: "en",
    resources: {
      en: { translation: { people_one: "{{count}} person", people_other: "{{count}} people" } },
      [lng]: { translation: strings },
    },
    initAsync: false,
  });
  return instance.t.bind(instance) as (key: string, o: { count: number }) => string;
}

describe("plural forms through i18next", () => {
  test("pt-BR: 0 pessoas, and a million is never the raw key", () => {
    const pt = t("pt-BR", fillPluralGaps("pt-BR", people) as Record<string, string>);
    expect(pt("people", { count: 0 })).toBe("0 pessoas");
    expect(pt("people", { count: 1 })).toBe("1 pessoa");
    expect(pt("people", { count: 1_000_000 })).toBe("1000000 pessoas");
  });

  test("ru: its own few and many forms, never English", () => {
    const ru = t(
      "ru",
      fillPluralGaps("ru", {
        people_one: "{{count}} человек",
        people_few: "{{count}} человека",
        people_many: "{{count}} человек",
        people_other: "{{count}} человека",
      }) as Record<string, string>,
    );
    expect([2, 5, 21].map((count) => ru("people", { count }))).toEqual(["2 человека", "5 человек", "21 человек"]);
  });

  test("ja: one form, `_other`, for every count", () => {
    const ja = t("ja", { people_other: "{{count}}人" });
    expect([1, 2].map((count) => ja("people", { count }))).toEqual(["1人", "2人"]);
  });

  test("fr and es get `_many` from `_other`; ru and pl get nothing", () => {
    expect(fillPluralGaps("fr", { a_one: "x", a_other: "y" })).toEqual({ a_one: "x", a_other: "y", a_many: "y" });
    expect(fillPluralGaps("ru", { a_one: "x", a_other: "y" })).toEqual({ a_one: "x", a_other: "y" });
    expect(fillPluralGaps("pl", { a: { b_other: "y" } })).toEqual({ a: { b_other: "y" } });
  });
});
