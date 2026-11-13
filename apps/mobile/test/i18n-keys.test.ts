import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { resources } from "@agenteschat/i18n";
import { LOCALES } from "@agenteschat/i18n/locale";
import { checkLocale } from "@agenteschat/i18n/testing";
import identical from "../../../packages/i18n/test/identical.json";
import { leaves as entries } from "../../../packages/i18n/test/leaves";
import { filesNamingMakers } from "../../../packages/i18n/test/maker-words";
import { unplainLeaves } from "../../../packages/i18n/test/plain-marks";
import { misplaced, staleLines } from "../../../packages/i18n/test/setups";
import appConfig from "../app.config";
import nativeEn from "../assets/locales/en.json";
import nativePtBR from "../assets/locales/pt-BR.json";
import { featureKeysEn } from "../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../src/features/i18n/keys.pt-BR";
import { FEATURES } from "../src/features/i18n/locales";
import { mobileEn } from "../src/i18n/keys.en";
import { mobilePtBR } from "../src/i18n/keys.pt-BR";
import { MOBILE, pickLocale, withMobileKeys } from "../src/i18n/merge";

/** Words a language writes as English does ("Online", "PDF"), by surface and language. */
const same = (surface: "mobile-base" | "mobile-features", code: string) =>
  (identical[surface] as Record<string, string[]>)[code] ?? [];

function leaves(o: object, prefix = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === "string" ? [`${prefix}${k}`] : leaves(v as object, `${prefix}${k}.`),
  );
}

test("every language against English: keys, plural forms, placeholders, tags (ADR 0122)", () => {
  for (const { code, ready } of LOCALES.filter((l) => l.code !== "en")) {
    const problems = [
      ...checkLocale({ source: mobileEn, target: MOBILE[code], code, ready, identical: same("mobile-base", code) }),
      ...checkLocale({
        source: featureKeysEn,
        target: FEATURES[code],
        code,
        ready,
        identical: same("mobile-features", code),
      }),
    ];
    expect({ code, problems }).toEqual({ code, problems: [] });
  }
});

test("the stores and the system list only ready languages, each with its iOS permission texts", () => {
  const ready = LOCALES.filter((l) => l.ready).map((l) => l.code);
  const config = appConfig({ config: {} } as never);
  const localization = config.plugins?.find((p) => Array.isArray(p) && p[0] === "expo-localization") as
    | [string, { supportedLocales: string[] }]
    | undefined;
  expect(localization?.[1].supportedLocales).toEqual(ready);
  expect(Object.keys(config.locales ?? {})).toEqual(ready);
  const keys = (o: object) => leaves(o).sort();
  for (const code of ready)
    expect(keys(JSON.parse(readFileSync(join(import.meta.dir, `../assets/locales/${code}.json`), "utf8")))).toEqual(
      keys(nativeEn),
    );
});

test("every key the phone reads by name exists in both languages, so a deleted line can't come back empty", () => {
  const app = join(import.meta.dir, "..");
  const read = ["src", "app"].flatMap((dir) =>
    readdirSync(join(app, dir), { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/.test(f))
      .flatMap((f) =>
        [...readFileSync(join(app, dir, f), "utf8").matchAll(/\bt\(\s*["'`]([A-Za-z][\w-]*(?:\.[\w-]+)+)["'`]/g)].map(
          (m) => [`${dir}/${f}`, m[1] ?? ""] as const,
        ),
      ),
  );
  expect(read.length).toBeGreaterThan(500);
  const merged = withMobileKeys(resources, { "pt-BR": featureKeysPtBR, en: featureKeysEn });
  for (const lng of ["pt-BR", "en"]) {
    const have = new Set(leaves(merged[lng]?.translation ?? {}));
    const exists = (key: string) => have.has(key) || have.has(`${key}_one`) || have.has(`${key}_other`);
    expect(read.filter(([, key]) => !exists(key))).toEqual([]);
  }
});

test("Claude and ChatGPT, not their makers, in what the phone shows", () => {
  const app = join(import.meta.dir, "..");
  expect(filesNamingMakers([join(app, "src"), join(app, "app")]).map((f) => relative(app, f))).toEqual([]);
});

test("no semicolon, no em dash in what the phone shows", () => {
  const trees = [featureKeysEn, featureKeysPtBR, mobileEn, mobilePtBR, nativeEn, nativePtBR];
  expect(trees.flatMap((tree) => unplainLeaves(tree))).toEqual([]);
});

test("the phone's words are true in every setup", () => {
  const phone = (...trees: object[]) =>
    trees.flatMap((tree) => entries(tree).map(([k, v]): [string, string] => [`mobile.${k}`, String(v)]));
  const en = phone(mobileEn, featureKeysEn);
  const pt = phone(mobilePtBR, featureKeysPtBR);
  expect([...misplaced(en, "en"), ...misplaced(pt, "pt-BR")]).toEqual([]);
  const keys = [...en, ...pt].map(([k]) => k);
  expect(staleLines(keys, "mobile.")).toEqual([]);
});

test("the app's strings are added under `mobile` in every namespace", () => {
  const merged = withMobileKeys({ "pt-BR": { translation: { a: "1" } }, en: { translation: { a: "2" } } });
  expect(merged["pt-BR"]?.translation?.a).toBe("1");
  expect(merged["pt-BR"]?.translation?.mobile).toMatchObject(mobilePtBR);
  expect(merged.en?.translation?.mobile).toMatchObject(mobileEn);
});

test("the phone's language: the first one people can pick, else English", () => {
  expect(pickLocale(["pt-PT"])).toBe("pt-BR");
  expect(pickLocale(["en-GB", "pt-BR"])).toBe("en");
  expect(pickLocale(["xx-XX"])).toBe("en");
  expect(pickLocale([null, "en-US"])).toBe("en");
});

test("extra keys merge deeply into the app's strings", () => {
  const merged = withMobileKeys(
    { "pt-BR": { translation: {} } },
    { "pt-BR": { auth: { extra: "x" }, home: { a: "b" } } },
  );
  const mobile = merged["pt-BR"]?.translation?.mobile as Record<string, Record<string, unknown>>;
  expect(mobile.home?.a).toBe("b");
  expect(mobile.auth?.extra).toBe("x");
  expect((mobile.auth?.social as Record<string, string> | undefined)?.failed).toBe(mobilePtBR.auth.social.failed);
});

test("the plan's notifications have their own Activity line in both languages, not the agent's name alone", () => {
  for (const keys of [featureKeysEn, featureKeysPtBR]) {
    const kind = keys.activity.kind as Record<string, string>;
    for (const k of [
      "plan_reset_unknown",
      "routine_waiting_plan",
      "browser_profile_request",
      "computer_disk_full",
      "computer_no_chrome",
      "desktop_taken",
      "plan_lent",
      "plan_model_dropped",
      "catch_up_closed",
      "catch_up_closed_asker",
      "catch_up_closed_asker_task",
    ]) {
      expect(kind[`${k}_one`]).toBeString();
      expect(kind[`${k}_other`]).toBeString();
    }
  }
});
