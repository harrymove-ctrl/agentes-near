import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { LOCALE_CODES } from "@agenteschat/i18n/locale";
import { type EmailTemplate, queueBudgetEmail, renderEmail } from "../src";
import { EMAIL_SAMPLES, PERSONAL_EMAIL_SAMPLES } from "./email-samples";
import { type Fixture, setup } from "./fixtures";

/** A personal workspace's emails (ADR 0159): the same emails, to the same people, in words for one person. */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** Words a personal workspace's email never says: a team, an admin, colleagues, its name ("Personal") as a place. */
const TEAM_WORDS = {
  en: /\b(team|admins?|colleagues?)\b|\b(in|at|of) Personal\b|Personal's|#general/i,
  "pt-BR": /\b(time|equipe|admin)\b|\b(na|da|de) Pessoal\b|#general/i,
};

const render = (id: string, more: Partial<EmailTemplate> = {}) =>
  renderEmail({ ...(PERSONAL_EMAIL_SAMPLES[id] as EmailTemplate), ...more } as EmailTemplate);

describe("a personal workspace's emails (ADR 0159)", () => {
  test("every one in every language: whole words, nothing left unfilled", () => {
    for (const locale of LOCALE_CODES)
      for (const [id, sample] of Object.entries(PERSONAL_EMAIL_SAMPLES)) {
        const e = renderEmail({ ...sample, locale } as EmailTemplate);
        const all = `${e.subject}\n${e.preheader}\n${e.html}\n${e.text}`;
        expect({ id, locale, bad: all.match(/undefined|NaN|\{\{|\[object Object\]/)?.[0] ?? null }).toEqual({
          id,
          locale,
          bad: null,
        });
      }
  });

  test("in English and pt-BR: one person and their own agents, never a team or an admin", () => {
    for (const [id, sample] of Object.entries(PERSONAL_EMAIL_SAMPLES))
      for (const locale of ["en", "pt-BR"] as const) {
        // Typed words aside (a denial's reason may say anything): only ours.
        const orgName = locale === "en" ? "Personal" : "Pessoal";
        const e = renderEmail({ ...sample, locale, orgName, reason: null } as EmailTemplate);
        const said = `${e.subject}\n${e.preheader}\n${e.text}`;
        expect({ id, locale, team: said.match(TEAM_WORDS[locale])?.[0] ?? null }).toEqual({ id, locale, team: null });
        // No em dashes or semicolons in our words.
        expect({ id, locale, mark: said.match(/—|;/)?.[0] ?? null }).toEqual({ id, locale, mark: null });
      }
  });

  test("the words a person reads about their own agents", () => {
    expect(render("budget-warning-personal.en").text).toContain(
      "At 100% it stops and tells you. You can change the limit on the agent's page.",
    );
    expect(render("computer_ready-task-personal.en").text).toContain(
      "Open a conversation with one of your agents and say what you need.",
    );
    expect(render("computer_ready-task-personal.en").text).toContain("Your agents' computer is on and set up");
    // The address is made inert in the text (no link a mail app would make of it), so only the words around it here.
    expect(render("invitation-personal.en").text).toContain("invited you to their personal workspace on agentes.chat.");
    expect(render("approval_digest-one-personal.en").text).toContain(
      "One of your agents asked to do something that needs your approval.",
    );
    const waiting = render("plan_waiting-personal.pt-BR");
    expect(waiting.subject).toBe("Seus agentes estão esperando");
    expect(waiting.text).not.toMatch(/canal|canais/);
    // The other steps stay the team's own words: only those that would read wrong change.
    expect(render("computer_ready-task-personal.en").text).toContain("Watch them work.");
  });

  test("a job with no stamp, as every one queued before the mode, reads as a team's", () => {
    const team = renderEmail({ ...EMAIL_SAMPLES["budget-warning.en"], orgName: "Personal" } as EmailTemplate).text;
    expect(team).toContain("An admin can change the limit on the agent's page.");
    expect(render("budget-warning-personal.en", { personal: undefined }).text).toBe(team);
  });

  test("stamped where it is queued: a personal workspace's job carries it, a team's doesn't", async () => {
    f = await setup();
    const fx = f;
    const budget = async () => {
      await fx.db.delete(schema.outbox).where(eq(schema.outbox.kind, "email.send"));
      const e = { agent: { ...fx.agent }, level: "exhausted" as const, spentNanoUsd: 10e9, budgetNanoUsd: 10e9 };
      await queueBudgetEmail(fx.db, "https://chat.example.com", e);
      const [job] = (await fx.db.select().from(schema.outbox)).filter((j) => j.kind === "email.send");
      return (job?.payload as { template: EmailTemplate } | undefined)?.template;
    };
    expect(await budget()).not.toHaveProperty("personal");
    await fx.db
      .insert(schema.organizationSettings)
      .values({ orgId: fx.org.id, mode: "personal" })
      .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { mode: "personal" } });
    const personal = await budget();
    expect(personal).toMatchObject({ kind: "budget", personal: true });
    // In the owner's language (pt-BR here): the limit is theirs to raise.
    expect(renderEmail(personal as NonNullable<typeof personal>).text).toContain(
      "até você subir o limite na página do agente",
    );
  });
});
