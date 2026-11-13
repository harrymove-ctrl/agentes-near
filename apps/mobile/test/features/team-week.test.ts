import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { teamWeekCardOf, teamWeekRowText, teamWeekWhen } from "@agenteschat/client/lib/team-week";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";

/** Lodi's weekly card on the phone (ADR 0137 §9), as on the web: the same card, stacked, and its schedule in Settings. */

const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");

const tOf = (lng: string) => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as unknown as TFunction;
};

test("an agent's message with the week's card draws it under its words, after the settings cards", () => {
  const row = src("chat/MessageRow.tsx");
  const settings = row.indexOf("<SettingsProposals message={m} />");
  const week = row.indexOf("<TeamWeek message={m} />");
  expect(settings).toBeGreaterThan(0);
  expect(week).toBeGreaterThan(settings);
  // Its week ("Como foi a semana do time…") is the message's own text on the phone: the card doesn't repeat it.
  expect(src("right-hand/TeamWeekCard.tsx")).not.toContain('t("chat.body.team_week"');
});

test("stacked rows: every fix's button under its words, full width, and the footer's day and hour open Settings", () => {
  const card = src("right-hand/TeamWeekCard.tsx");
  expect(card).toMatch(/variant="secondary"\s+size="sm"\s+wide/);
  expect(card).toContain('t("teamWeek.applyAll", { count: bulk.length })');
  expect(card).toContain("onPress={openRightHandSettings}");
  // Approvals open the phone's own approval screen, as the approvals card does.
  expect(card).toContain("router.push(`/approval/");
});

test("Configurações › Lodi: on or off, the day and the hour for admins, Resumo do dia for anyone", () => {
  const screen = src("right-hand/SettingsScreen.tsx");
  expect(screen).toContain("<TeamWeekRows name={agent.name} />");
  expect(screen).toContain('can(org, "administrator")');
  expect(screen).toContain("toggle={on}");
  expect(screen).toContain("teamWeekOn(prefs, admin)");
  expect(screen).toContain('"teamWeek.settings.dayLabel"');
});

test("the phone reads the same card and says its rows in the person's language", () => {
  const meta = {
    actionCard: {
      kind: "team_week",
      forUserId: "u1",
      from: "2026-10-30",
      to: "2026-11-06",
      timezone: "UTC",
      stats: { done: 1, stuck: 0, waiting: 0, spentNanoUsd: 0, budgetNanoUsd: 0 },
      rows: [{ id: "u", kind: "unanswered", channelId: "c", count: 1 }],
    },
  };
  const card = teamWeekCardOf(meta);
  expect(card?.rows).toHaveLength(1);
  const t = tOf("pt-BR");
  const names = {
    agent: () => "Ada",
    handle: () => null,
    channel: () => "atendimento",
    usd: () => "US$ 0",
    join: (l: string[]) => l.join(", "),
    since: () => "",
  };
  expect(teamWeekRowText(t, "pt-BR", card?.rows[0] as never, names).line).toBe(
    "1 pergunta ficou sem resposta em #atendimento esta semana.",
  );
  expect(teamWeekWhen(tOf("en"), "en", { day: 5, hour: 17 })).toMatch(/^Every Friday at 5:00\sPM$/);
});
