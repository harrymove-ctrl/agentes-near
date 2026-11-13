import type { TFunction } from "i18next";
import type { ConnectorDef, RoutineEvent, RoutineReport } from "../api/types";
import { type ConnectedItem, connectedIds } from "./connected";
import { connectorName } from "./scopes";

/** "Começar de um modelo" in sections, plain work first and technology last, for people who aren't technical. */
export const ROUTINE_TEMPLATE_AREAS = [
  "team",
  "sales",
  "support",
  "marketing",
  "finance",
  "ops",
  "people",
  "tech",
] as const;
export type RoutineTemplateArea = (typeof ROUTINE_TEMPLATE_AREAS)[number];

/**
 * A template's schedule: part of `@agenteschat/ui`'s `RecurrenceRule`, written out because the shared client stays free
 * of the web's package (`no-dom.test.ts`). What `templateRule` returns is a whole `RecurrenceRule`.
 */
type Day = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
interface TemplateRule {
  freq: "hourly" | "daily" | "weekly" | "monthly";
  interval: number;
  times: string[];
  byWeekday?: Day[];
  byMonthDay?: number[];
}

const weekdays = (...times: string[]): TemplateRule => ({
  freq: "daily",
  interval: 1,
  byWeekday: ["MO", "TU", "WE", "TH", "FR"],
  times,
});
const everyDay = (time: string): TemplateRule => ({ freq: "daily", interval: 1, times: [time] });
const weekly = (day: Day, time: string): TemplateRule => ({
  freq: "weekly",
  interval: 1,
  byWeekday: [day],
  times: [time],
});
const firstOfMonth = (time: string): TemplateRule => ({ freq: "monthly", interval: 1, byMonthDay: [1], times: [time] });

/** Connector ids (the catalog's): having any one of them is enough. */
const CRM = ["hubspot", "salesforce", "attio", "close"];
const HELP_DESK = ["zendesk", "intercom"];
const PAYMENTS = ["stripe", "mercadopago", "paypal", "square"];
const ANALYTICS = ["posthog", "mixpanel", "amplitude"];
const SHEETS = ["google-sheets", "airtable"];

export type RoutineTemplate = {
  key: string;
  area: RoutineTemplateArea;
  /** When it posts; default: only with something new, as a blank form does. */
  report?: RoutineReport;
  /** What it can't work without. */
  apps?: readonly string[];
  /** Its prompt has a part in brackets only the person can write. */
  blank?: true;
} & ({ kind: "schedule"; rule: TemplateRule } | { kind: "event"; event: RoutineEvent } | { kind: "email" });

/**
 * Starting points for "Nova rotina", each area's together (the select's sections are runs of one area). Their words
 * are `routines.presets.{key}` in i18n; a schedule is a rule, not a phrase, so it means the same in every language.
 * One on a GitHub or Sentry event shows that service's webhook setup in the form (`EventWebhookSetup`).
 */
export const ROUTINE_TEMPLATES = [
  { key: "digest", area: "team", kind: "schedule", rule: weekdays("09:00") },
  { key: "dayPlan", area: "team", kind: "schedule", rule: weekdays("08:30"), report: "always" },
  { key: "late", area: "team", kind: "schedule", rule: weekdays("10:00") },
  { key: "unanswered", area: "team", kind: "schedule", rule: weekdays("16:00") },
  { key: "week", area: "team", kind: "schedule", rule: weekly("FR", "17:00"), report: "always" },
  { key: "leads", area: "sales", kind: "schedule", rule: weekdays("09:00"), apps: CRM },
  { key: "stalled", area: "sales", kind: "schedule", rule: weekly("MO", "09:00"), apps: CRM },
  { key: "prospects", area: "sales", kind: "schedule", rule: weekly("MO", "08:00"), report: "always" },
  { key: "newEmail", area: "support", kind: "email", report: "always" },
  { key: "tickets", area: "support", kind: "schedule", rule: weekdays("09:00", "14:00"), apps: HELP_DESK },
  { key: "themes", area: "support", kind: "schedule", rule: weekly("FR", "16:00"), report: "always", apps: HELP_DESK },
  { key: "mentions", area: "marketing", kind: "schedule", rule: weekdays("09:00") },
  { key: "rivals", area: "marketing", kind: "schedule", rule: weekly("MO", "09:00") },
  { key: "ideas", area: "marketing", kind: "schedule", rule: weekly("MO", "10:00"), report: "always" },
  {
    key: "traffic",
    area: "marketing",
    kind: "schedule",
    rule: weekly("MO", "08:30"),
    report: "always",
    apps: ANALYTICS,
  },
  { key: "revenue", area: "finance", kind: "schedule", rule: everyDay("08:00"), report: "always", apps: PAYMENTS },
  { key: "failed", area: "finance", kind: "schedule", rule: weekdays("10:00"), apps: PAYMENTS },
  {
    key: "monthClose",
    area: "finance",
    kind: "schedule",
    rule: firstOfMonth("09:00"),
    report: "always",
    apps: PAYMENTS,
  },
  { key: "sheet", area: "ops", kind: "schedule", rule: weekdays("11:00"), apps: SHEETS, blank: true },
  { key: "page", area: "ops", kind: "schedule", rule: everyDay("09:00"), blank: true },
  { key: "newTask", area: "ops", kind: "event", event: "issue.created", report: "always" },
  { key: "pulse", area: "people", kind: "schedule", rule: weekly("TH", "16:00"), report: "always" },
  { key: "away", area: "people", kind: "schedule", rule: weekly("MO", "08:30"), apps: ["google-calendar"] },
  {
    key: "errors",
    area: "tech",
    kind: "schedule",
    rule: { freq: "hourly", interval: 1, times: ["00:00"] },
    apps: ["sentry"],
  },
  { key: "prs", area: "tech", kind: "event", event: "github.pr_opened", report: "always", apps: ["github"] },
] as const satisfies readonly RoutineTemplate[];

export type RoutineTemplateItem = (typeof ROUTINE_TEMPLATES)[number];

/** A template's rule, starting where the form's does and in its zone. */
export const templateRule = (template: { rule: TemplateRule }, from: { start: string; timezone: string }) => ({
  ...template.rule,
  start: from.start,
  timezone: from.timezone,
  until: null,
  count: null,
});

export interface RoutineTemplateOption {
  value: string;
  label: string;
  /** What it does and when, in one line. */
  text: string;
  /** What a routine made from it must have, in words; null for one that needs nothing. */
  needs: string | null;
  group: string;
  /** Searched besides the name: its line, what it needs and its instructions. */
  keywords: string;
  prompt: string;
  blank: boolean;
  report: RoutineReport;
  /** The apps it can use on this server, each with its mark. */
  apps: ConnectorDef[];
  template: RoutineTemplateItem;
}

function needsText(t: TFunction, template: RoutineTemplateItem, apps: ConnectorDef[]) {
  if (template.kind === "email") return t("routines.presets.needsMailbox");
  if (apps.length === 0) return null;
  const names = apps.map((d) => connectorName(t, d)).join(", ");
  return apps.length === 1
    ? t("routines.presets.needsApp", { app: names })
    : t("routines.presets.needsApps", { apps: names });
}

/**
 * The select's options, in the person's language. One whose apps can't connect on this server (a self-host without
 * Composio) leaves the list: nothing there could make it work.
 */
export function routineTemplateOptions(t: TFunction, catalog: ConnectorDef[] | undefined): RoutineTemplateOption[] {
  return ROUTINE_TEMPLATES.flatMap((template) => {
    const wanted: readonly string[] = "apps" in template ? template.apps : [];
    const apps = wanted.flatMap((id) => catalog?.find((d) => d.id === id && d.available) ?? []);
    if (catalog && wanted.length > 0 && apps.length === 0) return [];
    const text = t(`routines.presets.${template.key}.text`);
    const needs = needsText(t, template, apps);
    const prompt = t(`routines.presets.${template.key}.prompt`);
    return [
      {
        value: template.key,
        label: t(`routines.presets.${template.key}.name`),
        text,
        needs,
        group: t(`routines.presets.areas.${template.area}`),
        keywords: `${text} ${needs ?? ""} ${prompt}`,
        prompt,
        blank: "blank" in template,
        report: "report" in template ? template.report : "when_new",
        apps,
        template,
      },
    ];
  });
}

/** Whether none of a template's apps works here: not connected, or connected and waiting for Reconectar. */
export function noAppWorks(apps: ConnectorDef[], items: ConnectedItem[]) {
  const working = connectedIds(items.filter((i) => !i.needsReconnect));
  return apps.every((d) => !working.has(d.id));
}

/** Whether the form's instructions are the person's own words, which a template must not write over unasked. */
export const ownWords = (prompt: string, template: Pick<RoutineTemplateOption, "prompt"> | undefined) =>
  prompt.trim() !== "" && prompt.trim() !== template?.prompt.trim();

/** Whether the template's part in brackets is still there to fill: such a routine would have nothing to work on. */
export const blankLeft = (prompt: string, template: Pick<RoutineTemplateOption, "prompt" | "blank"> | undefined) =>
  Boolean(template?.blank) && prompt.trim() === template?.prompt.trim();
