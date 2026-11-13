import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { ApiError } from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { planHoldPhoneLine } from "@agenteschat/client/lib/no-ai";
import { railState } from "@agenteschat/client/lib/onboarding";
import { isInviteToken } from "../../src/features/auth/links";
import { PURPOSES, stepFailedText, workspaceAnswer, zoneCity, zoneLabel } from "../../src/features/onboarding/logic";
import { translator } from "./fixtures";

test("the time zone reads as its city; invitation tokens only url-safe", () => {
  expect(zoneCity("America/Sao_Paulo")).toBe("Sao Paulo");
  // Its name in the person's language where the engine has one, else the city.
  expect(zoneLabel("America/Sao_Paulo", "pt-BR")).toMatch(/Brasília|Sao Paulo/);
  expect(zoneLabel("Not/A_Zone", "pt-BR")).toBe("A Zone");
  expect(isInviteToken("a".repeat(43))).toBe(true);
  expect(isInviteToken("../etc")).toBe(false);
  expect(isInviteToken(undefined)).toBe(false);
});

test("the import logos are the web's marks, each rendered for the phone at 96 px", async () => {
  const brands = new URL("../../assets/images/brands/", import.meta.url).pathname;
  const web = (name: string) => Bun.file(new URL(`../../../web/public/brands/${name}`, import.meta.url).pathname);
  // Each mark is the web's SVG (a dark one where the maker has one), rendered for the phone at 96 px (the PNG
  // header's width and height). No other import logo is left in the folder (Gemini's mark there is the AI
  // pickers', VS Code's the AI apps').
  const notImports = new Set(["gemini.png", "soniox.png", "vscode.png"]);
  const rendered: [phone: string, web: string][] = [
    ["chatgpt-dots.png", "chatgpt-dots.svg"],
    ["grok-bot-dark.png", "grok-bot-dark.svg"],
    ["grok-bot.png", "grok-bot.svg"],
    ["hermes-dark.png", "hermes-dark.svg"],
    ["hermes.png", "hermes.svg"],
    ["openbotrun.png", "openbotrun.svg"],
    ["openclaw.png", "openclaw.svg"],
    ["openmausbot.png", "openmausbot.svg"],
    ["paperclip-dark.png", "paperclip-dark.svg"],
    ["paperclip.png", "paperclip.svg"],
  ];
  const pngs = readdirSync(brands).filter((f) => f.endsWith(".png") && !notImports.has(f));
  expect(pngs.sort()).toEqual(rendered.map(([png]) => png));
  for (const [png, svg] of rendered) {
    expect(await web(svg).exists()).toBe(true);
    const header = new DataView(await Bun.file(brands + png).arrayBuffer());
    expect([png, header.getUint32(16), header.getUint32(20)]).toEqual([png, 96, 96]);
  }
});

test("a second workspace refused while one isn't active: the facts, with no plan or way to pay (store rules)", async () => {
  const refused = new ApiError(403, "org.create_unpaid", "You already have a workspace waiting for a plan", {
    orgId: "o1",
  });
  for (const lng of ["pt-BR", "en"] as const) {
    const t = await translator(lng);
    const said = knownErrorText(t, refused, lng);
    expect(said).toBe(t("standing.createInactive"));
    expect(said).not.toMatch(/plan|pag|pay|escolh|choose/i);
  }
});

test("a step that failed says why the server refused it, else that it didn't save", async () => {
  const pt = await translator("pt-BR");
  const refused = (params?: Record<string, unknown>) =>
    new ApiError(403, "org.create_refused", "You can't create a workspace right now", params);
  expect(stepFailedText(pt, refused({ cloud: true }))).toBe(
    "Você não pode criar um workspace enquanto a sua conta ou um dos seus workspaces estiver com restrição. Para contestar, escreva para legal@agentes.chat.",
  );
  expect(stepFailedText(pt, refused())).toBe("Você não pode criar um workspace agora.");
  const inviteOnly = new ApiError(403, "org.create_invite_only", "New workspaces need an invitation for now");
  expect(stepFailedText(pt, inviteOnly)).toBe("Novos workspaces precisam de convite por enquanto.");
  expect(stepFailedText(await translator("en"), inviteOnly)).toBe("New workspaces need an invitation for now.");
  expect(stepFailedText(pt, new ApiError(500, "internal", "x"))).toBe(pt("mobile.onb.failed"));
  expect(stepFailedText(pt, new TypeError("Network request failed"))).toBe(pt("mobile.onb.failed"));
});

const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");

test("the phone's steps are the web's, read from the workspace's data (ADR 0162)", () => {
  // The phone keeps its rail (`funnel: null`): no AI step, and a personal workspace opens once made.
  const base = {
    orgId: "o1",
    standing: undefined,
    billingUrl: null,
    context: "",
    team: 0,
    picked: null,
    funnel: null,
  };
  // agentes.chat Cloud, before the workspace exists: its billing service is there, so the plan step will come.
  expect(railState({ ...base, orgId: null, billingUrl: "https://billing.example.com" }).steps).toEqual([
    "name",
    "business",
    "team",
    "plan",
  ]);
  // A server of one's own: no plan step, and the team made opens the workspace.
  expect(railState({ ...base, orgId: null }).steps).toEqual(["name", "business", "team"]);
  expect(railState({ ...base, context: "Loja online", team: 3 }).at).toBe("open");
  // Waiting for its plan with its team made: the plan step, resumed there from any visit.
  const held = { ...base, standing: { state: "hold" as const, reason: "payment" }, context: "Loja online", team: 3 };
  expect(railState(held)).toMatchObject({ step: "plan", index: 3 });
  // A team made with no AI still opens: the phone's card connects it.
  expect(railState({ ...base, context: "Loja online", team: 3 }).steps).not.toContain("ai");
  expect(railState({ ...base, personal: true }).at).toBe("open");
  const flow = src("onboarding/OnboardingFlow.tsx");
  expect(flow).toContain("railState({");
  expect(flow).toContain("funnel: null,");
  // Nothing is finished behind the person's back: only an answered workspace with no plan to wait for opens by itself.
  expect(flow).toContain('if (!known || at !== "open" || opening.current) return;');
  expect(flow).toContain('void open("done");');
  expect(flow).toContain('onEnter={() => void open("skipped")}');
  // A step answered on the web meanwhile moves this one on as the app comes back, so it never makes a second team.
  expect(flow.match(/refetchOnWindowFocus: "always"/g)).toHaveLength(3);
  // Another business on step 2 starts the team step on its template again; the same one keeps the template picked.
  expect(flow).toContain("if (picked !== kind) setTemplate(null);");
  // Back on step 1, the workspace's own zone, sent again only when picked here.
  expect(flow).toContain("const zone = pickedZone ?? settings.data?.timezone ?? phoneTimezone();");
  expect(flow).toContain("...(pickedZone ? { timezone: pickedZone } : {})");
});

test("the phone's plan step: the team asleep and where to turn it on, with no price, no plan's name and no link", async () => {
  const step = src("onboarding/steps.tsx");
  expect(step).toContain('planHoldPhoneLine(t, mayPay, "team")');
  expect(step).toContain('t("mobile.onb.enter")');
  expect(src("onboarding/OnboardingFlow.tsx")).toContain('mode: "sleep" as const');
  for (const lng of ["pt-BR", "en"] as const) {
    const t = await translator(lng);
    const said = [
      t("onboarding.flow.plan.title"),
      t("onboarding.flow.lodi.plan"),
      planHoldPhoneLine(t, true, "team"),
      planHoldPhoneLine(t, false, "team"),
      t("mobile.onb.enter"),
    ];
    for (const line of said) {
      expect(line).not.toMatch(/[$€£¥]|\d|https?:|\//);
      expect(line).not.toMatch(/Pessoal|Equipe|Empresa|Personal plan|Team plan|Business plan/);
    }
  }
  // No way to pay from the phone: no billing link, no plan list, no price, no web page opened for it.
  const banned = [
    "billingLink",
    "BillingLink",
    "planOffer",
    "plans.json",
    "onboarding.flow.plan.price",
    "onboarding.flow.plan.cta",
    "onboarding.flow.plan.all",
  ];
  for (const file of ["onboarding/steps.tsx", "onboarding/OnboardingFlow.tsx"]) {
    const code = src(file);
    expect({ file, found: banned.filter((b) => code.includes(b)) }).toEqual({ file, found: [] });
  }
});

test("the first question makes a personal workspace at once, named in the person's language (ADR 0159)", async () => {
  expect(PURPOSES).toEqual(["personal", "team"]);
  const pt = await translator("pt-BR");
  const en = await translator("en");
  // "For me": no name asked, the word for it; whatever was in the name field doesn't count.
  expect(workspaceAnswer(en, "personal", "Acme")).toEqual({ name: "Personal", mode: "personal" });
  expect(workspaceAnswer(pt, "personal", "")).toEqual({ name: pt("onboarding.personal.name"), mode: "personal" });
  // A company or team: the name typed, trimmed.
  expect(workspaceAnswer(pt, "team", "  Acme ")).toEqual({ name: "Acme", mode: "team" });
  // Add workspace asks the same question; the footer stays the quiet Sign out (workspace-computer.test.ts).
  const flow = readFileSync(new URL("../../src/features/onboarding/OnboardingFlow.tsx", import.meta.url), "utf8");
  expect(flow).toContain('t("mobile.onb.anotherPurpose")');
  expect(flow).toContain("PURPOSES.map((mode) => {");
  expect(flow).toContain('workspaceAnswer(t, purpose ?? "team", orgName)');
});

test("step 1 is one call, the workspace with its zones; the finish and the DM it opens say the rest themselves (#1)", () => {
  const flow = src("onboarding/OnboardingFlow.tsx");
  expect(flow).toContain("...(zone ? { timezone: zone, memberTimezone: zone } : {})");
  // Nothing after them asks the server again: no zone of the person's own, no lists read before the DM opens.
  expect(flow).not.toMatch(/orgs\.updateMe|refetchType/);
  expect(flow).toContain("if (res.me) qc.setQueryData(keys.me, res.me);");
  expect(flow).toContain("if (done.me) qc.setQueryData(keys.me, done.me);");
  expect(flow).toContain("if (dm?.dm) addDm(qc, id, dm.dm);");
  // An older self-hosted server's open says no DM: its list is read again, never waited for.
  expect(flow).toContain("else if (dm) void qc.invalidateQueries({ queryKey: keys.dms(id) });");
});
