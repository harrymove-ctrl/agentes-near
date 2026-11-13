import { describe, expect, test } from "bun:test";
import { en, ptBR } from "@agenteschat/i18n";
import { nextOccurrences } from "@agenteschat/ui/recurrence";
import type { TFunction } from "i18next";
import type { ConnectorDef } from "../src/api/types";
import type { ConnectedItem } from "../src/lib/connected";
import {
  blankLeft,
  noAppWorks,
  ownWords,
  ROUTINE_TEMPLATE_AREAS,
  ROUTINE_TEMPLATES,
  routineTemplateOptions,
  templateRule,
} from "../src/lib/routine-templates";

const t = ((key: string, values?: Record<string, string>) =>
  values?.defaultValue ?? (values ? `${key} ${Object.values(values).join("")}` : key)) as unknown as TFunction;
const def = (id: string, label: string, available = true) => ({ id, label, available }) as ConnectorDef;

describe("the templates", () => {
  test("each area is one run, in the areas' order, with the plain work first and technology last", () => {
    const runs = ROUTINE_TEMPLATES.map((x) => x.area).filter((a, i, all) => a !== all[i - 1]);
    expect(runs).toEqual([...ROUTINE_TEMPLATE_AREAS]);
    expect(runs.at(-1)).toBe("tech");
  });

  test("every one has its words, in the source and in pt-BR", () => {
    expect(new Set(ROUTINE_TEMPLATES.map((x) => x.key)).size).toBe(ROUTINE_TEMPLATES.length);
    for (const { presets } of [en.routines, ptBR.routines])
      for (const { key } of ROUTINE_TEMPLATES)
        expect(Object.keys(presets[key]).sort()).toEqual(["name", "prompt", "text"]);
  });

  test("every schedule has a next run, on the day its line says", () => {
    const from = new Date("2026-11-06T12:00:00Z");
    for (const x of ROUTINE_TEMPLATES) {
      if (x.kind !== "schedule") continue;
      const rule = templateRule(x, { start: "2026-11-06", timezone: "America/Sao_Paulo" });
      expect(nextOccurrences(rule, from, 1)).toHaveLength(1);
    }
    const friday = ROUTINE_TEMPLATES.find((x) => x.key === "week");
    expect(friday).toMatchObject({ rule: { freq: "weekly", byWeekday: ["FR"], times: ["17:00"] } });
  });

  test("a rule takes the form's zone and first day, and nothing of the rule it replaces", () => {
    const week = ROUTINE_TEMPLATES.find((x) => x.key === "week");
    if (week?.kind !== "schedule") throw new Error("a schedule");
    expect(templateRule(week, { start: "2026-11-06", timezone: "Asia/Tokyo" })).toEqual({
      freq: "weekly",
      interval: 1,
      byWeekday: ["FR"],
      times: ["17:00"],
      start: "2026-11-06",
      timezone: "Asia/Tokyo",
      until: null,
      count: null,
    });
  });
});

describe("the options", () => {
  const option = (key: string, catalog: ConnectorDef[] | undefined) =>
    routineTemplateOptions(t, catalog).find((o) => o.value === key);

  test("one app, several apps, a mailbox, or nothing to say", () => {
    const catalog = [def("sentry", "Sentry"), def("hubspot", "HubSpot"), def("attio", "Attio")];
    expect(option("errors", catalog)?.needs).toBe("routines.presets.needsApp Sentry");
    expect(option("leads", catalog)?.needs).toBe("routines.presets.needsApps HubSpot, Attio");
    expect(option("newEmail", catalog)?.needs).toBe("routines.presets.needsMailbox");
    expect(option("digest", catalog)?.needs).toBeNull();
  });

  test("what it needs, its line and its instructions are searched too", () => {
    const keywords = option("errors", [def("sentry", "Sentry")])?.keywords;
    expect(keywords).toContain("Sentry");
    expect(keywords).toContain("routines.presets.errors.text");
    expect(keywords).toContain("routines.presets.errors.prompt");
  });

  test("what a chosen template lacks: an app that needs Reconectar works no more than one never connected", () => {
    const sentry = def("sentry", "Sentry");
    const item = (id: string, needsReconnect = false) => ({ def: def(id, id), needsReconnect }) as ConnectedItem;
    expect(noAppWorks([sentry], [])).toBe(true);
    expect(noAppWorks([sentry], [item("sentry", true)])).toBe(true);
    expect(noAppWorks([sentry], [item("sentry")])).toBe(false);
    expect(noAppWorks([sentry, def("github", "GitHub")], [item("github")])).toBe(false);
  });

  test("a template asks before writing over the person's words, and an untouched one doesn't", () => {
    const picked = { prompt: "Do this", blank: false };
    expect(ownWords("", undefined)).toBe(false);
    expect(ownWords("  ", picked)).toBe(false);
    expect(ownWords("Do this ", picked)).toBe(false);
    expect(ownWords("My own words", undefined)).toBe(true);
    expect(ownWords("Do this and that", picked)).toBe(true);
  });

  test("a part in brackets holds the routine back until the person changes it", () => {
    const page = { prompt: "Open (paste it here)", blank: true };
    expect(blankLeft("Open (paste it here)", page)).toBe(true);
    expect(blankLeft("Open example.com", page)).toBe(false);
    expect(blankLeft("Do this", { prompt: "Do this", blank: false })).toBe(false);
    expect(blankLeft("Do this", undefined)).toBe(false);
    expect(option("sheet", undefined)?.blank).toBe(true);
    expect(option("late", undefined)?.blank).toBe(false);
  });

  test("an app that can't connect here isn't offered, and a template with none left leaves the list", () => {
    const catalog = [def("hubspot", "HubSpot"), def("salesforce", "Salesforce", false)];
    expect(option("leads", catalog)?.apps.map((d) => d.id)).toEqual(["hubspot"]);
    expect(option("failed", catalog)).toBeUndefined();
    expect(option("digest", catalog)).toBeDefined();
  });

  test("before the catalog comes, every template shows", () => {
    expect(routineTemplateOptions(t, undefined)).toHaveLength(ROUTINE_TEMPLATES.length);
  });

  test("what it posts: its own answer, else only with something new", () => {
    expect(option("week", undefined)?.report).toBe("always");
    expect(option("late", undefined)?.report).toBe("when_new");
  });
});
