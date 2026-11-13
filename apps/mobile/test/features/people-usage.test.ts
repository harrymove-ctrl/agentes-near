import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { waitingCardOf } from "@agenteschat/client/lib/notifications";
import { personAmount, usageLimitLine } from "@agenteschat/client/lib/person-usage";
import { notificationHref } from "../../src/features/links/logic";
import { peopleMonthLine } from "../../src/features/usage/logic";
import { notification, translator } from "./fixtures";

// The words as keys with their values, so the line's pieces show without the strings loaded.
const t = ((key: string, o?: Record<string, unknown>) => `${key}${o ? JSON.stringify(o) : ""}`) as never;

describe("a person's limit in Atividade (ADR 0141)", () => {
  const request = notification({
    id: "n",
    kind: "usage_limit",
    waiting: true,
    actors: [{ type: "user", id: "u-mateus" }],
    source: { userId: "u-mateus", label: "Vendas" },
    latest: {
      statusTo: "request",
      limitUsd: 30,
      raiseToUsd: 45,
      limitFrom: "role",
      runs: 64,
      title: "Zara",
      share: 80,
    },
  });

  test("a request for more waits as a limit card, answered there, and opens Uso", () => {
    expect(waitingCardOf(request)).toMatchObject({ kind: "limit", action: "review" });
    expect(notificationHref(request)).toBe("/usage");
  });

  test("who decides reads the requests, the agent most used and where the limit comes from; the person, nothing more", () => {
    const line = usageLimitLine(t, request);
    expect(line).toContain("notifications.usageLimit.line");
    expect(line).toContain('notifications.usageLimit.fromRole{\\"role\\":\\"Vendas\\"}');
    expect(line).toContain("Zara");
    const mine = notification({
      id: "m",
      kind: "usage_limit",
      source: { userId: "u-mateus" },
      latest: { statusTo: "raised", percent: 40 },
    });
    expect(usageLimitLine(t, mine)).toBe("");
  });
});

describe("Uso por pessoa's amounts on plans (#24)", () => {
  const month = { month: "2026-11", totalUsd: 12.51, people: [{}, {}] };
  const plain = (s: string) => s.replace(/\s/g, " ");

  test("on plans only, the month says once that it is the API's price and a person's row is its estimate", async () => {
    const pt = await translator("pt-BR");
    const line = plain(peopleMonthLine(pt, "pt-BR", { ...month, plansOnly: true }));
    expect(line).toBe("Novembro · 2 pessoas · ≈ US$ 12,51 pelo preço da API");
    expect(line).not.toContain("de IA");
    expect(plain(personAmount(pt, "pt-BR", true, 3.1))).toBe("≈ US$ 3,10");
    const en = await translator("en");
    expect(plain(peopleMonthLine(en, "en", { ...month, plansOnly: true }))).toBe(
      "November · 2 people · ≈ $12.51 at API prices",
    );
  });

  test("use paid through the API keeps its amount, with no estimate", async () => {
    const pt = await translator("pt-BR");
    expect(plain(peopleMonthLine(pt, "pt-BR", { ...month, plansOnly: false }))).toBe(
      "Novembro · 2 pessoas · US$ 12,51 de IA",
    );
    expect(plain(personAmount(pt, "pt-BR", false, 3.1))).toBe("US$ 3,10");
  });

  test("with plans and API keys in one month, each person's amount is marked by their own use, the ⓘ by anyone's", () => {
    const list = readFileSync(join(import.meta.dir, "../../src/features/usage/people.tsx"), "utf8");
    expect(list).toContain("personAmount(t, i18n.language, p.estimated, p.monthUsd)");
    expect(list).toContain("data.people.some((p) => p.estimated) ? (");
    expect(list).not.toContain("data.plansOnly");
  });
});
