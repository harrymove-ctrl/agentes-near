import { afterAll, beforeAll, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import { LOCALES } from "@agenteschat/i18n/locale";
import i18next, { type TFunction } from "i18next";
import { delegateUndoLine } from "../src/lib/approval-words";
import { nthText } from "../src/lib/computer-queue";
import { dueLabel, ordinalForm, relativeDay, relativeTime, toYmd } from "../src/lib/format";

const tFor = (lng: string) => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as TFunction;
};

const NativeRtf = Intl.RelativeTimeFormat;
const NativePlural = Intl.PluralRules;
const native = LOCALES.map((l) => [-1, 0, 1].map((n) => new NativeRtf(l.intl, { numeric: "auto" }).format(n, "day")));
const nativeOrdinal = (locale: string, n: number) => new NativePlural(locale, { type: "ordinal" }).select(n);

// The phone's Hermes has only Collator, DateTimeFormat and NumberFormat.
beforeAll(() => {
  Reflect.deleteProperty(Intl, "RelativeTimeFormat");
  Reflect.deleteProperty(Intl, "PluralRules");
});
afterAll(() => {
  Object.assign(Intl, { RelativeTimeFormat: NativeRtf, PluralRules: NativePlural });
});

test("without Intl.RelativeTimeFormat, yesterday/today/tomorrow match Intl's own words in every language, by code or Intl tag", () => {
  expect(typeof Intl.RelativeTimeFormat).toBe("undefined");
  LOCALES.forEach((l, i) => {
    expect([-1, 0, 1].map((n) => relativeDay(l.code, n as -1 | 0 | 1))).toEqual(native[i] as string[]);
    expect(relativeDay(l.intl, 0)).toBe(native[i]?.[1] as string);
  });
});

test("the board's due label, relative time and the undo line still read without it", () => {
  const now = new Date();
  expect(dueLabel(tFor("pt-BR"), "pt-BR", toYmd(now), now)).toBe("hoje");
  const yesterday = new Date(now.getTime() - 86_400_000);
  expect(relativeTime(tFor("en"), "en-US", yesterday.toISOString(), now)).toBe("yesterday");
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString();
  expect(delegateUndoLine(tFor("pt-BR"), "pt-BR", { undoUntil: tomorrow } as never, "Triagem")).toContain("amanhã, ");
});

test("without Intl.PluralRules, ordinals follow each language's rule", () => {
  for (const l of LOCALES)
    for (const n of [1, 2, 3, 4, 8, 11, 12, 13, 21, 22, 23, 101, 111])
      expect([l.code, n, ordinalForm(l.intl, n)]).toEqual([
        l.code,
        n,
        // Italian's "many" (8°, 11°) is written as "other" in the strings.
        l.code === "it" ? "other" : nativeOrdinal(l.intl, n),
      ]);
  expect([1, 2, 3, 11, 22].map((n) => nthText(tFor("en"), "en", n))).toEqual(["1st", "2nd", "3rd", "11th", "22nd"]);
});
