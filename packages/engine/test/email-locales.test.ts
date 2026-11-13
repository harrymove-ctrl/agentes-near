import { describe, expect, test } from "bun:test";
import { LOCALE_CODES } from "@agenteschat/i18n/locale";
import { deepMerge } from "@agenteschat/i18n/tree";
import { type EmailTemplate, emailLocale, renderEmail } from "../src";
import { wordsFor } from "../src/email/words";
import { en } from "../src/email/words/en";
import { EMAIL_SAMPLES } from "./email-samples";

/** Each sample once (its English variant), in every language of the app. */
const SAMPLES = Object.entries(EMAIL_SAMPLES).filter(([id]) => !id.includes(".pt-BR"));

describe("every email in every language (ADR 0122)", () => {
  for (const locale of LOCALE_CODES) {
    test(locale, () => {
      for (const [id, sample] of SAMPLES) {
        const e = renderEmail({ ...sample, locale } as EmailTemplate);
        const all = `${e.subject}\n${e.preheader}\n${e.html}\n${e.text}`;
        expect({ id, bad: all.match(/undefined|NaN|\{\{|\[object Object\]/)?.[0] ?? null }).toEqual({ id, bad: null });
        expect(e.html).toContain(`<html lang="${locale}"`);
      }
    });
  }

  test("counts read right at 0, 1, 2, 5 and 21 in every language", () => {
    for (const locale of LOCALE_CODES) {
      const w = wordsFor(locale);
      for (const n of [0, 1, 2, 5, 21]) {
        for (const s of [w.digest.subject(n), w.digest.headline(n), w.digest.button(n)])
          expect(s).not.toMatch(/undefined|\{\{/);
      }
    }
    expect(wordsFor("en").digest.subject(1)).toBe("A request is waiting for your approval");
    expect(wordsFor("en").digest.subject(2)).toBe("2 requests are waiting for your approval");
  });

  test("a language without a word falls back to English's", () => {
    const partial = deepMerge(en, { verify: { headline: "Bestätige" } });
    expect(partial.verify.subject).toBe(en.verify.subject);
    expect(wordsFor("pt-BR").verify.subject).not.toBe(wordsFor("en").verify.subject);
  });

  test("the recipient's language: any of the app's, else English", () => {
    expect(emailLocale("ja")).toBe("ja");
    expect(emailLocale("pt-PT")).toBe("pt-BR");
    expect(emailLocale("xx")).toBe("en");
    expect(emailLocale(null)).toBe("en");
  });
});
