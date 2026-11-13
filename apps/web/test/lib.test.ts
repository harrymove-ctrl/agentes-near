import { describe, expect, test } from "bun:test";
import { ApiError, handoffTimeLeft, type Me } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  clockAt,
  dayLabel,
  formatInt,
  formatPercent,
  formatTime,
  formatTokensShort,
  formatUsd,
  joinNames,
  namesText,
  nextLabel,
  parseDayInput,
  relativeTime,
  shortModel,
  timeLeft,
  whenAt,
} from "@agenteschat/client/lib/format";
import { agentGrammar, isFeminineName } from "@agenteschat/client/lib/grammar";
import {
  earlyAccessHeaders,
  earlyAccessState,
  INVITATION_MAIL_HEADER,
  INVITATION_TOKEN_HEADER,
  landingFor,
  membershipIn,
  safeRedirect,
  settingUp,
  webUrl,
} from "@agenteschat/client/lib/guards";
import { ONBOARDING_STEPS, stepIndex } from "@agenteschat/client/lib/onboarding";
import { can } from "@agenteschat/client/lib/permissions";
import {
  addressesIn,
  emailsFrom,
  handleFrom,
  isEmail,
  parseAmount,
  passwordState,
  slugify,
} from "@agenteschat/client/lib/text";
import { timeSpan } from "@agenteschat/client/lib/threads";
import { en, ptBR } from "@agenteschat/i18n";
import type { TFunction } from "i18next";
import { createBetterAuthClient } from "@/auth/better-auth";
import { createI18n } from "@/i18n";
import { announceConfirmation, emailConfirmedToast, sendNewLink } from "@/lib/email-confirmation";
import type { ToastAction } from "@/lib/toast";
import { createFakeAuth } from "./fake-auth";

const i18n = createI18n("pt-BR");
const t = i18n.t.bind(i18n) as TFunction;
const now = new Date(2026, 9, 14, 10, 44);
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

describe("format (pt-BR, machine numbers precise)", () => {
  test("money", () => {
    expect(formatUsd("pt-BR", 12.3)).toBe("US$\u00a012,30");
    expect(formatUsd("pt-BR", 0.004)).toBe("US$\u00a00,004");
    expect(formatUsd("pt-BR", 0.0003)).toBe("US$\u00a00,0003");
    // A real spend too small for 4 decimals (a few thousand tokens of a cheap model) never reads as zero.
    expect(formatUsd("pt-BR", 0.00003)).toBe("<US$\u00a00,0001");
    expect(formatUsd("pt-BR", 0.00005)).toBe("US$\u00a00,0001");
    expect(formatUsd("pt-BR", 0)).toBe("US$\u00a00,00");
    expect(formatUsd("pt-BR", 1234.5)).toBe("US$\u00a01.234,50");
    // Budget use: whole percents from 10%, one decimal below, "<1%" for a tiny share.
    expect(formatPercent("pt-BR", 30.8)).toBe("31%");
    expect(formatPercent("pt-BR", 2.5)).toBe("2,5%");
    expect(formatPercent("pt-BR", 0)).toBe("0%");
    expect(formatPercent("pt-BR", 0.006)).toBe("<1%");
    expect(formatPercent("en", 120)).toBe("120%");
  });
  test("tokens", () => {
    expect(formatInt("pt-BR", 1240)).toBe("1.240");
    expect(formatTokensShort(t, "pt-BR", 3_100_000)).toBe("3,1 mi");
    expect(formatTokensShort(t, "pt-BR", 940)).toBe("940");
  });
  test("relative times", () => {
    expect(relativeTime(t, "pt-BR", at(0.2), now)).toBe("agora");
    expect(relativeTime(t, "pt-BR", at(2), now)).toBe("há 2 min");
    expect(relativeTime(t, "pt-BR", at(180), now)).toBe("há 3 h");
    expect(relativeTime(t, "pt-BR", at(24 * 60), now)).toBe("ontem");
    expect(dayLabel(t, "pt-BR", at(5), now)).toBe("Hoje");
    expect(dayLabel(t, "pt-BR", at(24 * 60), now)).toBe("Ontem");
    expect(whenAt(t, "pt-BR", at(1), now)).toBe("hoje 10:43");
  });
  test("12-hour clocks have no leading zero; 24-hour ones keep theirs", () => {
    const morning = new Date(2026, 9, 14, 8, 39).toISOString();
    const evening = new Date(2026, 9, 14, 20, 39).toISOString();
    // ICU puts a narrow no-break space before AM/PM in some versions, a plain one in others.
    const read = (s: string) => s.replace(/\s/g, " ");
    expect(read(formatTime("en-US", morning))).toBe("8:39 AM");
    expect(read(formatTime("en-US", evening))).toBe("8:39 PM");
    expect(formatTime("pt-BR", morning)).toBe("08:39");
    expect(formatTime("pt-BR", evening)).toBe("20:39");
    expect(formatTime("en-GB", morning)).toBe("08:39");
    // Every clock built from it, and the ones beside it: a thread's span, a pause's end, the next run.
    expect(read(timeSpan("en-US", morning, evening))).toBe("8:39 AM–8:39 PM");
    expect(read(clockAt("en-US", morning, new Date(morning)))).toBe("8:39 AM");
    expect(nextLabel("en-US", morning)).not.toMatch(/\b0\d:/);
    expect(nextLabel("pt-BR", morning)).toContain("08:39");
  });
  test("time left", () => {
    expect(timeLeft(t, new Date(now.getTime() + 23 * 3_600_000).toISOString(), now)).toBe("23 h");
    expect(timeLeft(t, new Date(now.getTime() + 5 * 86_400_000).toISOString(), now)).toBe("5 dias");
    expect(timeLeft(t, at(1), now)).toBeNull();
  });
  test("a request for help counts down in hours, then minutes, in both languages", () => {
    const english = createI18n("en");
    const te = english.t.bind(english) as TFunction;
    const left = (ms: number) => ({ expiresAt: new Date(now.getTime() + ms).toISOString() });
    // Just asked: the whole day, not "23 h".
    expect(handoffTimeLeft(t, left(24 * 3_600_000 - 1000), now.getTime())).toBe("24 h");
    expect(handoffTimeLeft(t, left(3 * 3_600_000 + 10 * 60_000), now.getTime())).toBe("3 h");
    expect(handoffTimeLeft(t, left(45 * 60_000), now.getTime())).toBe("45 min");
    expect(handoffTimeLeft(t, left(20_000), now.getTime())).toBe("1 min");
    expect(handoffTimeLeft(t, left(-1000), now.getTime())).toBeNull();
    expect(handoffTimeLeft(t, { expiresAt: null }, now.getTime())).toBeNull();
    expect(t("browser.card.left", { time: handoffTimeLeft(t, left(24 * 3_600_000), now.getTime()) })).toBe(
      "24 h restantes",
    );
    expect(te("browser.card.left", { time: handoffTimeLeft(te, left(45 * 60_000), now.getTime()) })).toBe(
      "45 min left",
    );
  });
  test("a typed day in the language's order", () => {
    const now = new Date(2026, 0, 5);
    expect(parseDayInput("24/10", now, "pt-BR")).toBe("2026-10-24");
    expect(parseDayInput("10/24", now, "en")).toBe("2026-10-24");
    expect(parseDayInput("24/10", now, "en")).toBeNull();
    expect(parseDayInput("24.10.", now, "de")).toBe("2026-10-24");
    expect(parseDayInput("31/02/2027", now, "pt-BR")).toBeNull();
  });

  test("names and models", () => {
    expect(joinNames(["Ada"], t)).toBe("Ada");
    expect(joinNames(["Ada", "Atlas"], t)).toBe("Ada e Atlas");
    expect(joinNames(["Ada", "Atlas", "Theo"], t)).toBe("Ada, Atlas e Theo");
    expect(namesText(t, ["Ada", "Atlas", "Theo", "Lia"])).toBe("Ada, Atlas e mais 2");
    // Each language's own separators: the instance's language, or a page's fixed one.
    for (const [lng, list, more] of [
      ["en", "Ada, Atlas, and Theo", "Ada, Atlas, and 2 more"],
      ["ja", "Ada、Atlas、Theo", null],
      ["zh-Hans", "Ada、Atlas和Theo", null],
    ] as const) {
      const tl = i18n.getFixedT(lng) as TFunction;
      expect(joinNames(["Ada", "Atlas", "Theo"], tl)).toBe(list);
      if (more) expect(namesText(tl, ["Ada", "Atlas", "Theo", "Lia"])).toBe(more);
    }
    expect(shortModel("Claude Sonnet 5.5")).toBe("sonnet 5.5");
  });
});

describe("text", () => {
  test("slug and handle", () => {
    expect(slugify("Acme Saúde")).toBe("acme-saude");
    expect(handleFrom("Íris")).toBe("iris");
    expect(handleFrom("A")).toBe("a0");
  });
  test("emails", () => {
    expect(isEmail("nome@empresa.com.br")).toBe(true);
    expect(isEmail("nome@empresa")).toBe(false);
    expect(emailsFrom("A@x.com, b@x.com ,bad, a@x.com")).toEqual({ valid: ["a@x.com", "b@x.com"], invalid: ["bad"] });
    expect(emailsFrom("a@x.com, c@x.com", ["A@x.com"])).toEqual({ valid: ["c@x.com"], invalid: [] });
  });
  test("emails as mail apps and spreadsheets paste them: the address, never its wrapping", () => {
    // Bracketed, quoted or `mailto:`: none of it ends up in an invitation nobody could accept.
    expect(isEmail("<ana@x.com>")).toBe(false);
    expect(isEmail('"ana@x.com"')).toBe(false);
    expect(emailsFrom('Ana Silva <Ana@x.com>, "Silva, Bia" <bia@x.com>; mailto:caio@x.com')).toEqual({
      valid: ["ana@x.com", "bia@x.com", "caio@x.com"],
      invalid: [],
    });
    // A spreadsheet column: quoted cells, one per line, a sentence's full stop.
    expect(emailsFrom('"dani@x.com"\n"edu@x.com"\nfabi@x.com.')).toEqual({
      valid: ["dani@x.com", "edu@x.com", "fabi@x.com"],
      invalid: [],
    });
    // With no names in brackets, a word is a typo to fix; in order, once each.
    expect(addressesIn("gil@x.com gil gil@x.com <>")).toEqual([
      { email: "gil@x.com", valid: true },
      { email: "gil", valid: false },
    ]);
    expect(addressesIn("Ana <ana@x.com>, ana@x")).toEqual([
      { email: "ana@x.com", valid: true },
      { email: "ana@x", valid: false },
    ]);
  });
  test("onboarding: typed or pasted e-mails are read apart (commas, spaces, new lines); invalid ones stay", () => {
    expect(addressesIn(" A@x.com,b@x.com\n\nc@x.com;  bad  a@x.com ").map((a) => a.email)).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "bad",
    ]);
  });
  test("onboarding steps: ordered, the optional ones marked, each by its place", () => {
    expect(stepIndex("context")).toBe(1);
    expect(stepIndex("done")).toBe(ONBOARDING_STEPS.length - 1);
    expect(ONBOARDING_STEPS.map((s) => s.id)).toEqual([
      "workspace",
      "context",
      "import",
      "agents",
      "computer",
      "ai",
      "team",
      "done",
    ]);
    expect(ONBOARDING_STEPS.filter((s) => s.optional).map((s) => s.id)).toEqual(["import", "computer", "team"]);
  });
  test("password and amounts", () => {
    expect(passwordState("")).toBe("empty");
    expect(passwordState("curta")).toBe("short");
    expect(passwordState("12345678")).toBe("ok");
    expect(passwordState("x".repeat(129))).toBe("long");
    expect(parseAmount("40")).toBe(40);
    expect(parseAmount("40,5")).toBe(40.5);
    expect(Number.isNaN(parseAmount("abc"))).toBe(true);
    expect(Number.isNaN(parseAmount("-3"))).toBe(true);
  });
});

describe("grammar", () => {
  test("gender of agent names drives Portuguese articles", () => {
    expect(isFeminineName("Ada")).toBe(true);
    expect(isFeminineName("Theo")).toBe(false);
    expect(t("agent.howWorks", agentGrammar("Ada"))).toBe("Como a Ada trabalha");
    expect(t("agentPage.overview.does", agentGrammar("Atlas"))).toBe("O que o Atlas faz");
    expect(t("memory.subtitle", agentGrammar("Ada"))).toBe(
      "O que a Ada aprendeu com as conversas e as correções do time.",
    );
    expect(t("agent.instructionsHelp", { ...agentGrammar("Atlas"), org: "Acme" })).toEndWith(
      "escreva aqui só o que é do Atlas.",
    );
  });

  test("one agent, one pronoun: she or he in English as in Portuguese, never it", () => {
    const english = createI18n("en");
    const te = english.t.bind(english) as TFunction;
    const ada = agentGrammar("Ada");
    const theo = agentGrammar("Theo");
    // Her page says "her" in both lines it has for her.
    expect(te("noAi.agent", ada)).toBe("Ada won't reply because she has no AI\u00a0connected.");
    expect(te("dm.emptyAgent", ada)).toBe("Ask her to remember, forget or work differently.");
    expect(te("agentPage.work.cell.label", ada)).toBe("How she works");
    expect(te("agentPage.overview.proposes", ada)).toBe("Ada proposes changing her instructions");
    expect(te("chat.work.block", theo)).toBe("What he did");
    expect(te("chat.joined.tip", theo)).toBe("Nobody called Theo. He joined to help.");
    expect(te("channelMembers.removeAgentBody", ada)).toBe(
      "She stops reading and answering in this channel. You can add her back later.",
    );
    // Where Portuguese needs no pronoun, English has none either.
    expect(te("agent.budgetHelp", { ...ada, ownerNote: "" }).trim()).toBe(
      "At the limit, Ada stops and says so in the channel.",
    );
    expect(te("newAgent.budgetHelp", ada)).toBe("At the limit, Ada stops and says so.");
    expect(te("look.onHead")).toBe("On the head");
    expect(te("database.agent.levelText")).toBe("Queries the tables the rules allow, read-only.");
    expect(te("agentPage.memory.counts")).toBe("What's in memory");
    // Her Access tab says what each level gives her in her own words.
    expect(te("access.areaText.context.read", ada)).toBe("Searches messages, summaries and facts in the channels.");
    expect(te("access.areaText.context.write", ada)).toBe("Searches the context and keeps her own notes.");
    expect(te("access.areaText.browser.write", theo)).toBe(
      "Browses websites in his own browser, on his computer. Logins are kept per agent.",
    );
    // Settings › Computers names each agent's own folder as her page does.
    expect(te("agentPage.computer.foldersOwn", ada)).toBe("Only uses her own folder.");
    expect(te("machines.page.agentOwnFolder", ada)).toBe("Only her own folder");
    expect(te("machines.page.agentFolders", { ...theo, folders: "Desktop" })).toBe("Uses Desktop and his own folder");
    // Portuguese says each one's own words, articles and forms too.
    expect(t("chat.joined.tip", agentGrammar("Ada"))).toBe("Ninguém chamou a Ada. Ela entrou para ajudar.");
    expect(t("missions.settings.defaults.title", agentGrammar("Ada"))).toBe("Próximas missões da Ada");
    expect(t("access.areaText.desktop.write", agentGrammar("Ada"))).toStartWith(
      "Usa qualquer app na própria tela, no computador dela,",
    );
    expect(t("browser.agent.signedIn", agentGrammar("Ada"))).toBe(
      "A Ada fica com o login feito nos sites em que entrar, neste computador.",
    );
  });

  test("the app's starter agents get their names' own pronoun and article", () => {
    const english = createI18n("en");
    const te = english.t.bind(english) as TFunction;
    const feminine = ["Ada", "Iris", "Nina", "Mila", "Dora", "Clara", "Eva"];
    const masculine = ["Atlas", "Theo", "Leo", "Bento", "Otto", "Hugo"];
    for (const dict of [ptBR, en]) {
      const roles = Object.values(dict.newAgent.roles as Record<string, { agent?: string }>);
      expect(roles.flatMap((r) => (r.agent ? [r.agent] : [])).toSorted()).toEqual(
        [...feminine, ...masculine].toSorted(),
      );
    }
    for (const name of feminine) expect(agentGrammar(name)).toEqual({ name, context: "female" });
    for (const name of masculine) expect(agentGrammar(name)).toEqual({ name, context: undefined });
    expect(te("noAi.agent", agentGrammar("Iris"))).toBe("Iris won't reply because she has no AI\u00a0connected.");
    expect(t("chat.joined.tip", agentGrammar("Iris"))).toBe("Ninguém chamou a Iris. Ela entrou para ajudar.");
  });

  test("providers by name, with no article to agree with", () => {
    expect(t("newAgent.noKeyFor", { provider: "Claude" })).toBe("Sem chave Claude");
    expect(t("newAgent.modelNeedsKey", { provider: "OpenAI" })).toBe("Precisa de uma chave de API OpenAI");
    expect(t("agentPage.activity.errors.missing_credential", { provider: "Claude" })).toBe(
      "Falta uma chave Claude no workspace.",
    );
    expect(
      t("agentPage.activity.errors.credential_wrong_provider", { modelProvider: "Claude", keyProvider: "DeepSeek" }),
    ).toBe("O modelo usa Claude, mas a chave é para DeepSeek.");
  });
});

describe("guards and permissions", () => {
  const me = {
    user: { id: "u", name: "W", email: "w@x.com", image: null },
    organizations: [
      { id: "a", name: "A", role: "owner" as const },
      { id: "b", name: "B", role: "member" as const },
    ],
  };
  test("an early-access token as every app sends it: a header signing up in place, the state through a provider", () => {
    const token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v";
    // What apps/server auth.ts `accessOf` reads.
    expect(earlyAccessHeaders(token)).toEqual({ "x-early-access": token });
    expect(earlyAccessState(token)).toEqual({ additionalData: { earlyAccess: token } });
    expect([earlyAccessHeaders(), earlyAccessState()]).toEqual([{}, {}]);
  });
  test("safe redirects only", () => {
    expect(safeRedirect("/org/a")).toBe("/org/a");
    expect(safeRedirect("//evil.com")).toBeUndefined();
    expect(safeRedirect("https://evil.com")).toBeUndefined();
    expect(safeRedirect("/\\evil.com")).toBeUndefined();
    expect(safeRedirect("/org/a/issues?view=board#top")).toBe("/org/a/issues?view=board#top");
    // Browsers drop tabs and newlines and read a backslash as a slash: each would leave the site.
    for (const bypass of [
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r/evil.com",
      "/%09/evil.com",
      "/%0a/evil.com",
      "/%2F/evil.com",
      "/%2f%2fevil.com",
      "/%5Cevil.com",
      "\\\\evil.com",
      "/.//evil.com",
      "///evil.com",
      "javascript:alert(1)",
    ])
      expect(safeRedirect(bypass)).toBeUndefined();
  });
  test("web links: only http(s)", () => {
    expect(webUrl("https://github.com/acme/app/pull/3")).toBe("https://github.com/acme/app/pull/3");
    expect(webUrl("http://example.com")).toBe("http://example.com");
    expect(webUrl("javascript:alert(1)")).toBeUndefined();
    expect(webUrl("data:text/html,x")).toBeUndefined();
    expect(webUrl("/relative")).toBeUndefined();
  });
  test("landing: last org, first org, onboarding", () => {
    expect(landingFor(me, "b")).toEqual({ orgId: "b" });
    expect(landingFor(me, "zzz")).toEqual({ orgId: "a" });
    expect(landingFor({ ...me, organizations: [] }, null)).toEqual({ to: "/onboarding" });
    expect(membershipIn(me, "b")?.role).toBe("member");
    expect(membershipIn(me, "c")).toBeNull();
  });
  test("landing: a workspace its owner hasn't finished setting up is the onboarding, never a place to land", () => {
    const onboarding = { step: "agents" as const, generalChannelId: "g" };
    const mine = { id: "n", name: "N", role: "owner" as const, onboarding };
    expect(settingUp(mine)).toBe(true);
    expect(landingFor({ ...me, organizations: [mine] }, "n")).toEqual({ to: "/onboarding" });
    // Another of theirs is set up: that one opens, last visited or not.
    expect(landingFor({ ...me, organizations: [mine, ...me.organizations] }, "n")).toEqual({ orgId: "a" });
    // Invited into one being set up, or finished: no onboarding of theirs.
    expect(settingUp({ ...mine, role: "member" })).toBe(false);
    expect(landingFor({ ...me, organizations: [{ ...mine, role: "member" }] }, null)).toEqual({ orgId: "n" });
    expect(settingUp({ id: "n", name: "N", role: "owner" })).toBe(false);
  });
  test("what a membership may do is what the server resolved from its roles", () => {
    const member = { id: "b", name: "B", role: "member" as const, permissions: ["read", "post"] };
    expect(can(member, "post")).toBe(true);
    expect(can(member, "manage_agents")).toBe(false);
    const owner = { id: "a", name: "A", role: "owner" as const, permissions: ["read", "manage_owners", "configure"] };
    expect(can(owner, "manage_owners")).toBe(true);
    // No list: nothing (the server checks every request anyway).
    const unresolved: { role: "owner"; permissions?: string[] } = { role: "owner" };
    expect(can(unresolved, "read")).toBe(false);
    expect(can(undefined, "read")).toBe(false);
  });
});

describe("i18n", () => {
  test("pt-BR is the default; copy follows the screens", () => {
    expect(i18n.language).toBe("pt-BR");
    expect(t("auth.flow.password")).toBe("Bom te ver de novo.");
    expect(t("approval.approve.merge")).toBe("Aprovar merge");
    expect(t("auth.passwordMissing", { count: 3 })).toBe("Faltam 3 caracteres (mínimo de 8).");
  });
  test("a form's own refusals say what to change: an @ that's taken or wrong, a wiki page's title", () => {
    const said = (code: string, params?: Record<string, unknown>) =>
      errorText(t, new ApiError(409, code, "The server's English", params));
    expect(said("handle.taken", { handle: "bia" })).toBe("O @bia já é de outra pessoa.");
    expect(said("handle.taken_by_agent", { handle: "atlas" })).toBe("O @atlas é de um agente.");
    expect(said("handle.invalid", { min: 2, max: 32 })).toBe("O @ tem de 2 a 32 letras minúsculas, números, - ou _.");
    expect(said("slug_taken", { title: "Onboarding" })).toBe("Já existe uma página “Onboarding”.");
    expect(said("wiki.title_characters")).toBe("O título não pode ter [ ] | ou #.");
    expect(said("wiki.title_empty_slug")).toBe("O título precisa de letras ou números.");
  });
  test("no exclamation marks in the interface copy (voice rules)", () => {
    const strings: string[] = [];
    const walk = (o: object) => {
      for (const v of Object.values(o)) typeof v === "string" ? strings.push(v) : walk(v);
    };
    walk(ptBR);
    expect(strings.filter((s) => s.includes("!"))).toEqual([]);
  });
});

describe("the confirmation email", () => {
  test("its link lands back here: confirmed, or a link that no longer works; anything else is no toast", () => {
    expect(emailConfirmedToast("?email_confirmed=1")).toEqual({ key: "auth.emailConfirmed", tone: "info" });
    expect(emailConfirmedToast("?email_confirmed=1&error=TOKEN_EXPIRED")).toEqual({
      key: "auth.emailLinkExpired",
      tone: "error",
    });
    expect(emailConfirmedToast("?connector_error=x")).toBeNull();
    expect(emailConfirmedToast("")).toBeNull();
  });

  test("a link that no longer works offers a new one to whoever is signed in here with the address unconfirmed", async () => {
    const shown: { text: string; tone?: string; action?: ToastAction | ToastAction[] }[] = [];
    const show = (text: string, tone?: "info" | "error", action?: ToastAction | ToastAction[]) => {
      shown.push({ text, tone, action });
    };
    const { auth, calls } = createFakeAuth();
    const signedIn = (emailVerified: boolean | null) => async () =>
      emailVerified === null ? null : ({ user: { email: "bia@example.com", emailVerified } } as Me);
    const expired = { key: "auth.emailLinkExpired", tone: "error" } as const;

    await announceConfirmation(expired, { auth, t, show, me: signedIn(false) });
    expect(shown).toMatchObject([
      { text: "Este link de confirmação não vale mais. Sua conta funciona normalmente.", tone: "error" },
    ]);
    const action = shown[0]?.action as ToastAction;
    expect(action.label).toBe("Mandar outro link");
    action.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([{ method: "sendVerificationEmail", args: ["bia@example.com"] }]);
    expect(shown[1]).toMatchObject({ text: "Mandamos outro link para bia@example.com." });

    // Signed out, or confirmed meanwhile: nothing to send. A link that worked only says so.
    shown.length = 0;
    await announceConfirmation(expired, { auth, t, show, me: signedIn(null) });
    await announceConfirmation(expired, { auth, t, show, me: signedIn(true) });
    await announceConfirmation({ key: "auth.emailConfirmed", tone: "info" }, { auth, t, show, me: signedIn(false) });
    expect(shown).toEqual([
      {
        text: "Este link de confirmação não vale mais. Sua conta funciona normalmente.",
        tone: "error",
        action: undefined,
      },
      {
        text: "Este link de confirmação não vale mais. Sua conta funciona normalmente.",
        tone: "error",
        action: undefined,
      },
      { text: "E-mail confirmado.", tone: "info", action: undefined },
    ]);
  });

  test("a new link that didn't go out says why in the person's words, else a plain line in their language, never English", async () => {
    const shown: string[] = [];
    const show = (text: string) => void shown.push(text);
    const refusals = [
      { ok: false, status: 0, code: "network", message: "" },
      { ok: false, status: 429, message: "Too many requests. Please try again later." },
      { ok: false, status: 400, code: "EMAIL_ALREADY_VERIFIED", message: "Email is already verified" },
    ] as const;
    for (const verification of refusals) {
      expect(await sendNewLink({ auth: createFakeAuth({ verification }).auth, t, show }, "bia@example.com")).toBe(
        false,
      );
    }
    expect(shown).toEqual([
      "Sem conexão com o agentes.chat agora. Tente de novo em instantes.",
      "Muitas tentativas. Espere alguns minutos e tente de novo.",
      "Não deu certo. Confira o que preencheu e tente de novo.",
    ]);
  });

  test("the auth client says the app's language on every request; the server picks where a link lands", async () => {
    const sent: { path: string; language: string | null; body: Record<string, unknown> | null }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({
        path: new URL(String(url)).pathname,
        language: new Headers(init?.headers).get("accept-language"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ token: null, user: { id: "u", name: "Bia", email: "bia@example.com" } });
    }) as typeof fetch;
    try {
      let language = "en";
      const auth = createBetterAuthClient("http://localhost:3000", () => language);
      await auth.signUp({ name: "Bia", email: "bia@example.com", password: "senha-longa" });
      language = "pt-BR";
      await auth.requestPasswordReset({ email: "bia@example.com", redirectTo: "/reset-password" });
      expect(await auth.sendVerificationEmail("bia@example.com")).toEqual({ ok: true });
      const signUp = sent.find((r) => r.path === "/api/auth/sign-up/email");
      expect(signUp?.language).toBe("en");
      expect(signUp?.body).not.toHaveProperty("callbackURL");
      expect(sent.find((r) => r.path === "/api/auth/request-password-reset")?.language).toBe("pt-BR");
      expect(sent.find((r) => r.path === "/api/auth/send-verification-email")).toEqual({
        path: "/api/auth/send-verification-email",
        language: "pt-BR",
        body: { email: "bia@example.com" },
      });
    } finally {
      globalThis.fetch = real;
    }
  });

  test("the auth client settles when the request gets no answer: status 0, never a page spinning forever", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    try {
      const auth = createBetterAuthClient("http://localhost:3000");
      const none = { ok: false, status: 0, code: "network", message: "" };
      expect(await auth.signIn({ email: "bia@example.com", password: "senha-longa" })).toEqual(none);
      expect(await auth.signUp({ name: "Bia", email: "bia@example.com", password: "senha-longa" })).toEqual(none);
      expect(await auth.requestPasswordReset({ email: "bia@example.com", redirectTo: "/reset-password" })).toEqual(
        none,
      );
      expect(await auth.resetPassword({ token: "t", newPassword: "senha-longa" })).toEqual(none);
      expect(await auth.sendVerificationEmail("bia@example.com")).toEqual(none);
      expect(await auth.signInSocial("github", "/")).toEqual(none);
      expect(await auth.ownerClaim({ token: "t", name: "Bia", email: "bia@example.com", password: "x" })).toEqual(none);
      expect(await auth.signInOneTime("t")).toEqual(none);
      expect(await auth.desktopHandoff("r")).toEqual(none);
      expect(await auth.desktopOpen("c")).toBeNull();
      expect(await auth.desktopRequestCode("r")).toBeNull();
      expect(await auth.desktopRedeem("v")).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
  });

  test("an email invitation's sign-up carries its token and its email's proof in headers, never in the body (ADR 0090)", async () => {
    type Sent = { path: string; invitation: string | null; mail: string | null; body: Record<string, unknown> | null };
    const sent: Sent[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sent.push({
        path: new URL(String(url)).pathname,
        invitation: headers.get(INVITATION_TOKEN_HEADER),
        mail: headers.get(INVITATION_MAIL_HEADER),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ token: null, user: { id: "u", name: "Bia", email: "bia@example.com" } });
    }) as typeof fetch;
    try {
      const auth = createBetterAuthClient("http://localhost:3000");
      const bia = { name: "Bia", email: "bia@example.com", password: "senha-longa" };
      await auth.signUp({ ...bia, invitation: { token: "inv-token", mail: "inv-proof" } });
      await auth.signUp({ ...bia, invitation: { token: "copied-token" } });
      await auth.signUp(bia);
      const signUps = sent.filter((r) => r.path === "/api/auth/sign-up/email");
      expect(INVITATION_TOKEN_HEADER).toBe("x-invitation-token");
      expect(INVITATION_MAIL_HEADER).toBe("x-invitation-mail");
      expect(signUps.map((r) => [r.invitation, r.mail])).toEqual([
        ["inv-token", "inv-proof"],
        ["copied-token", null],
        [null, null],
      ]);
      expect(signUps[0]?.body).toMatchObject(bia);
      expect(signUps[0]?.body).not.toHaveProperty("invitation");
    } finally {
      globalThis.fetch = real;
    }
  });
});
