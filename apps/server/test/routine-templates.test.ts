import { expect, test } from "bun:test";
import { ROUTINE_TEMPLATES, templateRule } from "@agenteschat/client/lib/routine-templates";
import { eventWebhook } from "@agenteschat/client/lib/routine-view";
import {
  type ConnectorListingEntry,
  connectorListing,
  EVENT_WEBHOOK,
  normalizeRule,
  ROUTINE_EVENTS,
  ruleToCron,
  type ScheduleRule,
} from "@agenteschat/engine";

const catalog = connectorListing({ oauthApps: {}, composio: {} as never }) as ConnectorListingEntry[];

test("every app a routine template names is in the connector catalog", () => {
  const ids = new Set(catalog.map((d) => d.id));
  for (const x of ROUTINE_TEMPLATES)
    if ("apps" in x)
      expect({ key: x.key, missing: x.apps.filter((id) => !ids.has(id)) }).toEqual({ key: x.key, missing: [] });
});

test("the server takes every template's schedule as it is", () => {
  for (const x of ROUTINE_TEMPLATES) {
    if (x.kind !== "schedule") continue;
    const rule = templateRule(x, { start: "2026-11-06", timezone: "America/Sao_Paulo" }) as ScheduleRule;
    expect({ key: x.key, cron: ruleToCron(normalizeRule(rule)) === null }).toEqual({ key: x.key, cron: false });
  }
});

test("the apps know which service's webhook each event comes through, as the server does", () => {
  for (const event of ROUTINE_EVENTS)
    if (event !== "email.received" && event !== "webhook.received")
      expect({ event, provider: eventWebhook(event) }).toEqual({ event, provider: EVENT_WEBHOOK[event] ?? null });
  // Revisar PRs novos waits on GitHub's webhook, which its form sets up.
  expect(ROUTINE_TEMPLATES.find((x) => x.key === "prs")).toMatchObject({ kind: "event", event: "github.pr_opened" });
});
