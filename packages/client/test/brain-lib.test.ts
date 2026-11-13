import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AgentBrain } from "../src/api/types";
import { brainLine, engineOfBrain, engineOfExecutor, engineStateOfOption, thinksWith } from "../src/lib/brain";
import {
  ADVANCED_DEFAULTS,
  advancedContents,
  advancedParts,
  isAdvancedDefault,
  viewSpeedFits,
} from "../src/lib/brain-advanced";

describe("the engine an agent thinks with", () => {
  test("agents.brain maps to its engine; the API and anything unknown is the agent itself", () => {
    expect(engineOfBrain("claude_code")).toBe("claude_code");
    expect(engineOfBrain("codex")).toBe("codex");
    expect(engineOfBrain("model")).toBe("agent");
    expect(engineOfBrain("something_new")).toBe("agent");
    expect(engineOfBrain(null)).toBe("agent");
    expect(engineOfBrain(undefined)).toBe("agent");
  });

  test("a mission's executor maps to the same engines", () => {
    expect(engineOfExecutor("claude")).toBe("claude_code");
    expect(engineOfExecutor("codex")).toBe("codex");
    expect(engineOfExecutor("agent")).toBe("agent");
    expect(engineOfExecutor(null)).toBe("agent");
  });

  test("an option is off when it can't run now or its computer is offline; the API never is", () => {
    const online = { online: true };
    const offline = { online: false };
    expect(engineStateOfOption({ kind: "claude_code", available: true }, online)).toBe("idle");
    expect(engineStateOfOption({ kind: "claude_code", available: true }, offline)).toBe("off");
    expect(engineStateOfOption({ kind: "codex", available: false }, online)).toBe("off");
    expect(engineStateOfOption({ kind: "codex", available: true }, null)).toBe("idle");
    expect(engineStateOfOption({ kind: "model", available: true }, offline)).toBe("idle");
    expect(engineStateOfOption({ kind: "model", available: false })).toBe("idle");
  });
});

describe("what thinks, in one sentence", () => {
  const WORDS: Record<string, string> = {
    "brain.line.claude": "{{model}} pelo plano do Claude",
    "brain.line.chatgpt": "{{model}} pelo plano do ChatGPT",
    "brain.line.coding": "{{model}} pelo {{plan}}",
    "brain.line.claudeOf": "{{model}} pelo plano do Claude de {{owner}}",
    "brain.line.chatgptOf": "{{model}} pelo plano do ChatGPT de {{owner}}",
    "brain.line.codingOf": "{{model}} pelo {{plan}} de {{owner}}",
    "aiAccounts.connect.claude_code": "Claude",
    "aiAccounts.connect.codex": "ChatGPT",
    "brain.line.chatgptAuto": "Plano do ChatGPT",
    "brain.line.on": "{{line}} no {{computer}}",
  };
  const t = ((key: string, o: Record<string, string> = {}) =>
    (WORDS[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k: string) => o[k] ?? "")) as unknown as TFunction;

  test("the model by the plan that pays for it, and whose plan for someone who doesn't see its computer", () => {
    expect(thinksWith(t, "claude", "Sonnet")).toBe("Sonnet pelo plano do Claude");
    expect(thinksWith(t, "chatgpt", "GPT-6.1 Terra")).toBe("GPT-6.1 Terra pelo plano do ChatGPT");
    expect(thinksWith(t, "opencode", "DeepSeek V4.1 Flash")).toBe("DeepSeek V4.1 Flash pelo OpenCode Go");
    expect(thinksWith(t, "claude", "Sonnet", "João")).toBe("Sonnet pelo plano do Claude de João");
    expect(thinksWith(t, "chatgpt", "GPT-6 Sol", "João")).toBe("GPT-6 Sol pelo plano do ChatGPT de João");
    expect(thinksWith(t, "zai", "GLM-5.3", "João")).toBe("GLM-5.3 pelo GLM Coding de João");
  });

  test("an agent's line names the computer only beside another; the maker's mark stays, the API is its model's label", () => {
    expect(brainLine(t, { kind: "claude_code", model: "Sonnet", computer: "MacBook" }, "", { owner: "João" })).toEqual({
      text: "Sonnet pelo plano do Claude",
      kind: "claude_code",
      mark: "claude_code",
    });
    expect(brainLine(t, { kind: "claude_code", model: "Sonnet" }, "", { owner: "João" }).text).toBe(
      "Sonnet pelo plano do Claude de João",
    );
    expect(
      brainLine(
        t,
        { kind: "claude_code", model: "DeepSeek V4.1 Flash", provider: "opencode", computer: "MacBook" },
        "",
      ),
    ).toEqual({ text: "DeepSeek V4.1 Flash pelo OpenCode Go", kind: "claude_code", mark: "opencode" });
    expect(brainLine(t, { kind: "codex", model: "auto" }, "").text).toBe("Plano do ChatGPT");
    const two = [{ brain: { computer: "MacBook" } }, { brain: { computer: "Servidor" } }];
    expect(brainLine(t, { kind: "claude_code", model: "Sonnet", computer: "MacBook" }, "", { agents: two }).text).toBe(
      "Sonnet pelo plano do Claude no MacBook",
    );
    expect(brainLine(t, { kind: "model", model: null }, "Claude Sonnet 5.5")).toEqual({
      text: "Claude Sonnet 5.5",
      kind: "agent",
      mark: null,
    });
    // Automático on the API: the maker its models come from, never a generic mark.
    expect(brainLine(t, { kind: "model", model: null, maker: "openai" }, "Automático").mark).toBe("openai");
  });
});

describe("Velocidade (ADR 0149)", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  type Fits = Parameters<typeof viewSpeedFits>[0];
  const view = (over: Partial<Fits> = {}): Fits => ({
    brain: "codex",
    effectiveModel: "gpt-6.1-sol",
    account: null,
    accounts: [],
    ...over,
  });

  test("shows on a ChatGPT sign-in with a model that has it, Automático included", () => {
    expect(viewSpeedFits(view())).toBe(true);
    expect(viewSpeedFits(view({ effectiveModel: "auto" }))).toBe(true);
    expect(
      viewSpeedFits(view({ account: "a", accounts: [{ id: "a", provider: null } as AgentBrain["accounts"][number]] })),
    ).toBe(true);
  });

  test("hides on any other model, brain or sign-in, and on the right hand", () => {
    expect(viewSpeedFits(view({ effectiveModel: "gpt-5.5" }))).toBe(false);
    expect(viewSpeedFits(view({ brain: "claude_code", effectiveModel: "sonnet" }))).toBe(false);
    expect(viewSpeedFits(view({ brain: "model", effectiveModel: null }))).toBe(false);
    expect(viewSpeedFits(view({ scope: "workspace" }))).toBe(false);
    expect(viewSpeedFits(view({ scope: "mine" }))).toBe(false);
  });

  test("Rápida counts as a change from the defaults and is named wherever they are", () => {
    const now = { ...ADVANCED_DEFAULTS, speed: "fast" as const };
    expect(isAdvancedDefault("codex", now)).toBe(false);
    expect(advancedParts(t, "pt-BR", { kind: "codex", autoModel: false, apiKey: false, now })).toEqual([
      "agentPage.work.brain.advanced.speed",
    ]);
    expect(
      advancedParts(t, "pt-BR", { kind: "codex", autoModel: false, apiKey: false, now: ADVANCED_DEFAULTS }),
    ).toEqual([]);
    expect(advancedContents(t, { kind: "codex", autoModel: false, speed: true })).toBe(
      "agentPage.work.brain.advanced.contents.fixedSpeed",
    );
    expect(advancedContents(t, { kind: "codex", autoModel: true, speed: true })).toBe(
      "agentPage.work.brain.advanced.contents.autoSpeed",
    );
    expect(advancedContents(t, { kind: "codex", autoModel: false })).toBe(
      "agentPage.work.brain.advanced.contents.fixed",
    );
  });
});
