import { describe, expect, test } from "bun:test";
import type { AgentBrainLine } from "@agenteschat/client";
import { brainLine } from "@agenteschat/client/lib/brain";
import { KEY_MARKS, PLAN_MARKS } from "@agenteschat/client/lib/no-ai";
import { keyStepHint, PROVIDERS } from "@agenteschat/client/lib/providers";
import { resources } from "@agenteschat/i18n";
import { markOf, PROVIDER_MARKS } from "@agenteschat/ui/brand/marks";
import i18next, { type TFunction } from "i18next";
import { featureKeysEn } from "../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../src/features/i18n/keys.pt-BR";
import { withMobileKeys } from "../src/i18n/merge";
import { LOGO_SIZES, MARK_GRADIENT, markShapes, STACK_RING, stackChips } from "../src/ui/provider-marks";

async function translator(lng: "pt-BR" | "en"): Promise<TFunction> {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng,
    fallbackLng: "pt-BR",
    resources: withMobileKeys(resources, { "pt-BR": featureKeysPtBR, en: featureKeysEn }),
    interpolation: { escapeValue: false },
  });
  return i18n.t;
}

/** What the phone's ProviderLogo draws for a brain line: the mark's id, or null (no logo). */
const drawn = (line: { mark: string | null }) => (line.mark ? markOf(line.mark) : null);

describe("Outro provedor", () => {
  test("a workspace's own endpoint draws the generic server mark, never a letter", () => {
    expect(markOf("custom")).toBe("custom");
    expect(markShapes("custom", "light", "#111")?.shapes.length).toBeGreaterThan(0);
  });
});

describe("Pensa com: the brain by its maker's mark", () => {
  test("each computer brain or plan account draws its maker's mark; the API draws none", async () => {
    const t = await translator("pt-BR");
    const line = (brain: AgentBrainLine) => brainLine(t, brain, "Claude Sonnet 5.5");
    expect(drawn(line({ kind: "claude_code", model: "Sonnet" }))).toBe("claude");
    expect(drawn(line({ kind: "codex", model: "GPT-6 Sol" }))).toBe("openai");
    expect(drawn(line({ kind: "claude_code", model: "GLM-5.3", provider: "zai" }))).toBe("zai");
    expect(drawn(line({ kind: "claude_code", model: "Kimi K3", provider: "kimi" }))).toBe("kimi");
    expect(line({ kind: "model", model: null })).toEqual({ text: "Claude Sonnet 5.5", kind: "agent", mark: null });
    // A plan this phone has no mark for yet still shows (its initial), never another maker's mark.
    expect(line({ kind: "claude_code", model: "x", provider: "newplan" }).mark).toBe("newplan");
    expect(markOf("newplan")).toBeNull();
    // The waiting card and the switch sheet name the brains by the same marks.
    expect(markOf("claude_code")).toBe("claude");
    expect(markOf("codex")).toBe("openai");
    for (const id of Object.keys(PROVIDER_MARKS)) expect(markOf(id)).toBe(id as keyof typeof PROVIDER_MARKS);
  });

  test("the model by the plan that pays for it; where it runs only when the agents think on two computers; whose plan for who doesn't see that computer", async () => {
    const pt = await translator("pt-BR");
    const en = await translator("en");
    // The server sends `computer` only to the agent's owner and the admins.
    const owner: AgentBrainLine = { kind: "claude_code", model: "Sonnet", computer: "MacBook do Walter" };
    const others: AgentBrainLine = { kind: "claude_code", model: "Sonnet" };
    const one = [{ brain: owner }, { brain: { kind: "codex", model: "GPT-6 Sol", computer: "MacBook do Walter" } }];
    const two = [...one, { brain: { kind: "codex", model: "GPT-6 Sol", computer: "Servidor" } }];
    // The workspace's one computer (the Cloud's, or a server's only one) tells nothing apart.
    expect(brainLine(pt, owner, "", { agents: one }).text).toBe("Sonnet pelo plano do Claude");
    expect(brainLine(pt, owner, "", { agents: two }).text).toBe("Sonnet pelo plano do Claude no MacBook do Walter");
    expect(brainLine(en, owner, "", { agents: two }).text).toBe("Sonnet on the Claude plan on MacBook do Walter");
    expect(brainLine(pt, others, "", { agents: two }).text).toBe("Sonnet pelo plano do Claude");
    expect(brainLine(pt, others, "", { owner: "Walter" }).text).toBe("Sonnet pelo plano do Claude de Walter");
    expect(brainLine(en, owner, "").text).toBe("Sonnet on the Claude plan");
    expect(brainLine(en, others, "", { owner: "Walter" }).text).toBe("Sonnet on Walter's Claude plan");
    // Nobody chose a model: the plan alone, no "Automático".
    expect(brainLine(pt, { kind: "codex", model: "auto" }, "").text).toBe("Plano do ChatGPT");
    expect(brainLine(en, { ...owner, model: "auto" }, "", { agents: two }).text).toBe(
      "Claude plan on MacBook do Walter",
    );
    const opencode: AgentBrainLine = { kind: "claude_code", model: "DeepSeek V4.1 Flash", provider: "opencode" };
    expect(brainLine(pt, opencode, "").text).toBe("DeepSeek V4.1 Flash pelo OpenCode Go");
    expect(brainLine(en, opencode, "", { owner: "Walter" }).text).toBe("DeepSeek V4.1 Flash on Walter's OpenCode Go");
    expect(pt("mobile.intentAgents.thinks")).toBe("Pensa com");
    expect(en("mobile.intentAgents.thinks")).toBe("Thinks with");
  });
});

describe("the marks as the phone draws them", () => {
  const INK = "#1c1c1e";

  test("in the maker's own colors: a second color as its own shape, the gradient, the dark files' parts", () => {
    // Claude for the `anthropic` provider, in Clay.
    expect(markShapes("anthropic", "light", INK)).toEqual({
      key: "claude",
      image: false,
      gradient: null,
      shapes: [{ d: PROVIDER_MARKS.claude.path, fill: "#D97757" }],
    });
    // Kimi's K in ink, its dot always blue.
    expect(markShapes("moonshot", "dark", INK)?.shapes.map((s) => s.fill)).toEqual([INK, "#1783FF"]);
    // OpenCode's block is darker on a dark theme, as in its own dark file.
    expect(markShapes("opencode", "light", INK)?.shapes.map((s) => s.fill)).toEqual([INK, "#CFCECD"]);
    expect(markShapes("opencode", "dark", INK)?.shapes.map((s) => s.fill)).toEqual([INK, "#4B4646"]);
    // MiniMax: its gradient, never a flat color.
    const minimax = markShapes("minimax", "light", INK);
    expect(minimax?.gradient).toEqual(["#E21680", "#FF633A"]);
    expect(minimax?.shapes[0]?.fill).toBe(`url(#${MARK_GRADIENT})`);
    // A one-color mark takes the ink it is given, with no color of its own.
    expect(markShapes("codex", "light", INK)?.shapes).toEqual([{ d: PROVIDER_MARKS.openai.path, fill: INK }]);
    // OpenRouter's glyph too, in Ink on a light theme and Cloud on a dark one, as its brand page gives it.
    expect(markShapes("openrouter", "dark", INK)?.shapes).toEqual([{ d: PROVIDER_MARKS.openrouter.path, fill: INK }]);
    expect(markShapes("newplan", "light", INK)).toBeNull();
  });

  test("the key page lists OpenRouter: its mark, where its keys are made, and who may keep what is sent", async () => {
    const openrouter = PROVIDERS.find((p) => p.id === "openrouter");
    expect(openrouter).toMatchObject({ label: "OpenRouter", site: "openrouter.ai/keys", placeholder: "sk-or-v1-…" });
    expect(markOf(openrouter?.id)).toBe("openrouter");
    const hint = openrouter && keyStepHint(openrouter);
    expect(hint).toBe("connectAi.key.privacy");
    const pt = await translator("pt-BR");
    const en = await translator("en");
    expect(pt(hint ?? "")).toBe(
      "As configurações de privacidade da OpenRouter decidem quais provedores podem guardar o que seus agentes enviam.",
    );
    expect(en(hint ?? "")).toBe(
      "Your OpenRouter privacy settings decide which providers may keep what your agents send.",
    );
    expect(pt("onboarding.keyInvalid.openrouter")).toBe(
      "As chaves da OpenRouter começam com sk-or-v1-. Confira e cole de novo.",
    );
    expect(pt("connectAi.key.create", { provider: "OpenRouter" })).toBe("Crie a sua chave de API OpenRouter");
  });

  test("an image mark has no shapes: ProviderLogo draws the phone's own copy of the web's file", async () => {
    const images = Object.entries(PROVIDER_MARKS).flatMap(([id, mark]) =>
      "image" in mark ? [{ id, image: mark.image }] : [],
    );
    expect(images).toEqual([
      { id: "soniox", image: "/brands/soniox.png" },
      { id: "gemini", image: "/brands/gemini.png" },
      { id: "vscode", image: "/brands/vscode.png" },
    ]);
    const source = await Bun.file(new URL("../src/ui/ProviderLogo.tsx", import.meta.url).pathname).text();
    for (const { id, image } of images) {
      expect(markShapes(id, "dark", INK)).toEqual({ key: id, image: true, gradient: null, shapes: [] });
      const file = image.slice("/brands/".length);
      const phone = await Bun.file(new URL(`../assets/images/brands/${file}`, import.meta.url).pathname).bytes();
      const web = await Bun.file(new URL(`../../web/public${image}`, import.meta.url).pathname).bytes();
      expect(phone).toEqual(web);
      // Bundled under the mark's id: the file just compared.
      expect(source).toContain(`${id}: require("../../assets/images/brands/${file}")`);
    }
  });

  test("a stack: 20 pt chips with a 12 pt mark, in the order given, each over the one before", () => {
    const [chip, mark] = LOGO_SIZES.chip;
    expect([chip, mark]).toEqual([20, 12]);
    const chips = stackChips(["claude_code", "codex", "zai", "kimi"]);
    expect(chips.map((c) => markOf(c.id))).toEqual(["claude", "openai", "zai", "kimi"]);
    expect(chips.map((c) => c.marginLeft)).toEqual([0, -2, -2, -2]);
    // The next chip and its ring cover only the space around a mark, never the mark itself.
    for (const c of chips.slice(1)) expect(-c.marginLeft + STACK_RING).toBeLessThanOrEqual((chip - mark) / 2);
    // The computer's plan line, as on the web.
    expect(stackChips(PLAN_MARKS).map((c) => markOf(c.id))).toEqual(["claude", "openai", "zai", "kimi"]);
    // The API key row's quad: Gemini's sparkle is its third mark, drawn from the phone's own file.
    expect(stackChips(KEY_MARKS).map((c) => markOf(c.id))).toEqual(["claude", "openai", "gemini", "openrouter"]);
    expect(markShapes("gemini", "light", INK)?.image).toBe(true);
  });
});
