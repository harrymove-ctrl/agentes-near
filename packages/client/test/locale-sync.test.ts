import { describe, expect, test } from "bun:test";
import { localeSync } from "../src/lib/locale-sync";

describe("the language once signed in (ADR 0122)", () => {
  test("a pick on this device the server hasn't heard wins and is sent", () => {
    expect(
      localeSync({
        state: { stored: "pt-BR", pending: true },
        detected: "en",
        server: { locale: "en", localeAuto: true },
      }),
    ).toEqual({ use: "pt-BR", store: "pt-BR", patch: { locale: "pt-BR", auto: false } });
  });

  test("a language picked on another device shows here, and nothing is sent", () => {
    expect(
      localeSync({
        state: { stored: "auto", pending: false },
        detected: "en",
        server: { locale: "pt-BR", localeAuto: false },
      }),
    ).toEqual({ use: "pt-BR", store: "pt-BR" });
  });

  test("Automático follows this device and tells the server when it differs", () => {
    expect(
      localeSync({
        state: { stored: null, pending: false },
        detected: "en",
        server: { locale: "pt-BR", localeAuto: true },
      }),
    ).toEqual({ use: "en", store: "auto", patch: { locale: "en", auto: true } });
    expect(
      localeSync({
        state: { stored: "auto", pending: false },
        detected: "en",
        server: { locale: "en", localeAuto: true },
      }),
    ).toEqual({ use: "en", store: "auto" });
  });

  test("Automático picked signed out undoes a language picked elsewhere", () => {
    expect(
      localeSync({
        state: { stored: "auto", pending: true },
        detected: "en",
        server: { locale: "pt-BR", localeAuto: false },
      }),
    ).toEqual({ use: "en", store: "auto", patch: { locale: "en", auto: true } });
  });

  test("a language kept on this device before the server kept picks stays, and is sent as picked", () => {
    expect(
      localeSync({
        state: { stored: "pt-BR", pending: false },
        detected: "en",
        server: { locale: "pt-BR", localeAuto: true },
      }),
    ).toEqual({ use: "pt-BR", store: "pt-BR", patch: { locale: "pt-BR", auto: false } });
  });

  test("a language picked on another device wins over an older one kept here", () => {
    expect(
      localeSync({
        state: { stored: "pt-BR", pending: false },
        detected: "en",
        server: { locale: "en", localeAuto: false },
      }),
    ).toEqual({ use: "en", store: "en" });
  });
});
