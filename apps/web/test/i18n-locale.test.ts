import { beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { chooseLocale, createI18n, detectedLocale, readLocaleState, savedLocale } from "../src/i18n";

beforeEach(() => localStorage.clear());

describe("the language to start in (ADR 0122)", () => {
  test("this browser's pick, else the landing's cookie, else the browser's own, else English", () => {
    expect(savedLocale(["pt-PT"], "agentes_locale=en")).toBe("en");
    expect(savedLocale(["sv-SE"], "")).toBe("en");
    expect(savedLocale(["sv-SE", "pt-BR"], "")).toBe("pt-BR");
    expect(savedLocale(["fr-CA", "pt-BR"], "")).toBe("fr");
    expect(savedLocale(["en-US"], "agentes_locale=zh-Hans")).toBe("zh-Hans");
    expect(savedLocale(["en-US"], "a=1; agentes_locale=pt")).toBe("pt-BR");
    localStorage.setItem("agentes.locale", "pt-BR");
    expect(savedLocale(["en-US"], "agentes_locale=en")).toBe("pt-BR");
    // Automático: the browser's own, whatever the landing said.
    localStorage.setItem("agentes.locale", "auto");
    expect(savedLocale(["en-US"], "agentes_locale=pt")).toBe("en");
  });

  test("a pick made signed out waits for the next sign-in; one made signed in doesn't", () => {
    const i18n = createI18n("en");
    chooseLocale("pt-BR", i18n, false);
    expect(readLocaleState()).toEqual({ stored: "pt-BR", pending: true });
    chooseLocale("auto", i18n, true);
    expect(readLocaleState()).toEqual({ stored: "auto", pending: false });
    expect(detectedLocale(["sv-SE", "en"])).toBe("en");
    expect(detectedLocale(["zh-TW", "en"])).toBe("zh-Hans");
  });
});
