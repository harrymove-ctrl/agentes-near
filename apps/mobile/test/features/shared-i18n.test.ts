import { describe, expect, test } from "bun:test";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";
import {
  agentLook,
  firstName,
  fuseRemaining,
  genderOf,
  greetingKey,
  initialOf,
  isSafeId,
  minutesLeft,
  previewOf,
  whenKind,
} from "../../src/features/shared/logic";
import { mobilePtBR } from "../../src/i18n/keys.pt-BR";

describe("shared helpers", () => {
  test("an agent's look: known values only, the default agent otherwise", () => {
    expect(agentLook({ appearance: { color: "rose", eyes: "dots", accessory: "flower" } })).toEqual({
      color: "rose",
      eyes: "dots",
      accessory: "flower",
    });
    expect(agentLook({ appearance: { color: "pink", eyes: 3, accessory: "none" } })).toEqual({
      color: "sky",
      eyes: "round",
    });
    expect(agentLook(undefined)).toEqual({ color: "sky", eyes: "round" });
  });

  test("Portuguese grammar by the name", () => {
    expect(genderOf("Iris")).toBe("F");
    expect(genderOf("Nina")).toBe("F");
    expect(genderOf("Luíza")).toBe("F");
    expect(genderOf("Infra")).toBe("F");
    expect(genderOf("Dev")).toBe("M");
    expect(genderOf("Theo")).toBe("M");
  });

  test("names and initials", () => {
    expect(initialOf(" walter")).toBe("W");
    expect(initialOf("")).toBe("?");
    expect(firstName("Walter Nogueira")).toBe("Walter");
  });

  test("times in lists", () => {
    const now = new Date(2026, 9, 17, 15, 0);
    expect(whenKind(new Date(2026, 9, 17, 9, 41).toISOString(), now)).toBe("time");
    expect(whenKind(new Date(2026, 9, 16, 23, 0).toISOString(), now)).toBe("yesterday");
    expect(whenKind(new Date(2026, 9, 13, 9, 0).toISOString(), now)).toBe("weekday");
    expect(whenKind(new Date(2026, 8, 1, 9, 0).toISOString(), now)).toBe("date");
    expect(greetingKey(new Date(2026, 9, 17, 9))).toBe("morning");
    expect(greetingKey(new Date(2026, 9, 17, 14))).toBe("afternoon");
    expect(greetingKey(new Date(2026, 9, 17, 22))).toBe("evening");
  });

  test("the fuse of a request", () => {
    const start = Date.parse("2026-10-17T10:00:00.000Z");
    const created = new Date(start).toISOString();
    const expires = new Date(start + 60 * 60_000).toISOString();
    expect(fuseRemaining(created, expires, start + 15 * 60_000)).toBeCloseTo(0.75);
    expect(fuseRemaining(created, expires, start + 90 * 60_000)).toBe(0);
    expect(fuseRemaining(expires, created, start)).toBe(0);
    expect(minutesLeft(expires, start + 59 * 60_000 + 1)).toBe(1);
    expect(minutesLeft(expires, start + 61 * 60_000)).toBe(0);
  });

  test("ids safe for routes, previews without Markdown", () => {
    expect(isSafeId("0b7c6a2e-1f0e-4b7a-9d8c-2f3e4a5b6c7d")).toBe(true);
    expect(isSafeId("../x")).toBe(false);
    expect(isSafeId(undefined)).toBe(false);
    expect(previewOf("**Feito!**\n\n```ts\nx\n```\nVeja [aqui](https://x).")).toBe("Feito! x Veja aqui.");
  });
});

function leaves(o: object, prefix = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === "string" ? [`${prefix}${k}`] : leaves(v as object, `${prefix}${k}.`),
  );
}
const get = (o: object, path: string) =>
  path.split(".").reduce<unknown>((a, k) => (a as Record<string, unknown>)[k], o);

describe("the screens' strings", () => {
  test("pt-BR and en have the same keys and the same placeholders", () => {
    expect(leaves(featureKeysEn).sort()).toEqual(leaves(featureKeysPtBR).sort());
    const vars = (s: string) => (s.match(/{{\w+}}/g) ?? []).sort();
    for (const key of leaves(featureKeysPtBR))
      expect([key, vars(get(featureKeysEn, key) as string)]).toEqual([key, vars(get(featureKeysPtBR, key) as string)]);
  });

  test("an agent's profile, which says she or he, never calls the agent it", () => {
    const profile = featureKeysEn.intentAgents;
    expect(leaves(profile).filter((key) => /\b(it|its)\b/i.test(get(profile, key) as string))).toEqual([]);
  });

  test("they never repeat a group of the foundation's strings (both merge under `mobile`)", () => {
    const mine = Object.keys(featureKeysPtBR);
    for (const group of Object.keys(mobilePtBR)) expect(mine).not.toContain(group);
  });

  test("a path to a setting stays on one line: no-break spaces around its ›", () => {
    for (const tree of [featureKeysPtBR, featureKeysEn]) {
      const paths = leaves(tree)
        .map((key) => get(tree, key) as string)
        .filter((s) => s.includes("›"));
      expect(paths.length).toBeGreaterThanOrEqual(1);
      for (const s of paths)
        expect({ s, alone: s.split("\u00a0›\u00a0").join("").includes("›") }).toEqual({ s, alone: false });
    }
  });

  test("plural keys come in pairs", () => {
    const keys = new Set(leaves(featureKeysPtBR));
    for (const key of keys) {
      if (key.endsWith("_one")) expect(keys.has(`${key.slice(0, -4)}_other`)).toBe(true);
      if (key.endsWith("_other")) expect(keys.has(`${key.slice(0, -6)}_one`)).toBe(true);
    }
  });
});
