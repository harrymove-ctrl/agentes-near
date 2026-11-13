import { afterEach, describe, expect, test } from "bun:test";
import { and, asc, eq, schema } from "@agenteschat/db";
import {
  AUTO_MODEL,
  MODEL_TIERS,
  modelForTier,
  parseOpenRouterModels,
  setOpenRouterModels,
} from "@agenteschat/providers";
import { CODING_PLANS, planModel } from "@agenteschat/providers/plans";
import fixture from "../../providers/test/fixtures/openrouter-models.json";
import {
  agentBrainLines,
  answerQuestion,
  autoApplied,
  autoWanted,
  type BrainPlan,
  brainModelForTier,
  cheapModelForOrg,
  chooseAutoModel,
  createAgent,
  createCredential,
  createFakeJudge,
  drainOutbox,
  getAgent,
  isBrainEffortSetting,
  type Judge,
  NEW_AGENT_DEFAULTS,
  needsAutoChoice,
  normalizeBrainModel,
  postPersonMessage,
  updateAgent,
  updateOrgSettings,
  ValidationError,
  withAuto,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  setOpenRouterModels({}, 0);
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const input = {
  orgId: "o",
  agent: { name: "Ada", role: "Developer", instructions: "Answer briefly." },
  message: "refatora o módulo de cobrança e roda os testes",
  recent: ["person: a cobrança está falhando"],
  routine: false,
  mission: true,
  computer: true,
  tools: true,
};

describe("chooseAutoModel", () => {
  test("one judge request with two choices: the tier and the effort, with a one-line reason", async () => {
    const judge = createFakeJudge((kind, id) =>
      kind === "auto_model" ? (id === "tier" ? "large" : "high") : undefined,
    );
    const choice = await chooseAutoModel(judge, { ...input, agentId: "a", runId: "r" });
    expect(choice).toMatchObject({ tier: "large", effort: "high", source: "judge" });
    expect(choice.reason).toBe("Hard or long work (100%); high effort (100%).");
    expect(judge.calls).toHaveLength(1);
    const call = judge.calls[0];
    expect(call).toMatchObject({ kind: "auto_model", orgId: "o", agentId: "a", runId: "r" });
    expect(Object.keys(call?.questions ?? {})).toEqual(["tier", "effort"]);
    const { tier, effort } = call?.questions ?? {};
    expect(Object.keys((tier as { criteria: Record<string, string> }).criteria)).toEqual(["small", "medium", "large"]);
    expect(Object.keys((effort as { criteria: Record<string, string> }).criteria)).toEqual(["low", "medium", "high"]);
    expect(call?.state).toMatchObject({
      message: input.message,
      recent: "person: a cobrança está falhando",
      run: { started_by_a_routine: false, part_of_a_mission: true, works_on_a_computer: true, has_tools: true },
    });
    // Any judge answers (Jev, or the org's cheap model): only the choice is used, never a probability.
    expect(call?.calibrated).toBeUndefined();
  });

  test("acting for the person with tools is never the small tier: it only answers", async () => {
    const judge = createFakeJudge(() => "medium");
    await chooseAutoModel(judge, { ...input, message: "me manda um print do dinzo.com.br" });
    const tier = judge.calls[0]?.questions.tier as { criteria: Record<string, string> } | undefined;
    const acting =
      "acting for the person with tools (opening a site, taking a screenshot, clicking or filling in a page, running a command, changing files, sending something)";
    expect(tier?.criteria.small).toStartWith("A quick, simple turn that only answers: a greeting or thanks,");
    expect(tier?.criteria.small).toEndWith(`Never ${acting}.`);
    expect(tier?.criteria.medium).toContain(acting);
  });

  test("never blocks the run: a timeout, a failure or an answer off the list is medium/medium, and says why", async () => {
    const slow: Judge = { name: "slow", ask: () => new Promise(() => {}) };
    expect(await chooseAutoModel(slow, { ...input, timeoutMs: 5 })).toEqual({
      tier: "medium",
      effort: "medium",
      reason: "The judge didn't answer in time: medium tier, medium effort.",
      source: "timeout",
    });
    const broken: Judge = {
      name: "broken",
      ask: async () => {
        throw new Error("down");
      },
    };
    expect(await chooseAutoModel(broken, input)).toMatchObject({ tier: "medium", effort: "medium", source: "error" });
    const odd = createFakeJudge((_kind, id) => (id === "tier" ? "huge" : "low"));
    expect(await chooseAutoModel(odd, input)).toMatchObject({ tier: "medium", effort: "medium", source: "error" });
  });
});

describe("one decision, mapped per brain", () => {
  const agent = { model: AUTO_MODEL, brain: "model", brainModel: null, brainEffort: null };
  const choice = { tier: "small" as const, effort: "low" as const };

  test("the API line of each provider, the nearest smaller model when a line has no such tier", () => {
    expect(modelForTier("anthropic", "small")).toBe("claude-haiku-5-5");
    expect(modelForTier("anthropic", "medium")).toBe("claude-sonnet-5-5");
    expect(modelForTier("anthropic", "large")).toBe("claude-opus-5-5");
    expect(modelForTier("openai", "small")).toBe("gpt-6-luna");
    expect(modelForTier("openai", "large")).toBe("gpt-6.1-sol");
    expect(modelForTier("nobody", "large")).toBeNull();
  });

  test("Claude Code's aliases and Codex's models", () => {
    expect(brainModelForTier("claude_code", "small")).toBe("haiku");
    expect(brainModelForTier("claude_code", "medium")).toBe("sonnet");
    expect(brainModelForTier("claude_code", "large")).toBe("opus");
    expect(brainModelForTier("codex", "small")).toBe("gpt-6-luna");
    expect(brainModelForTier("codex", "large")).toBe("gpt-6.1-sol");
    expect(brainModelForTier("model", "large")).toBeUndefined();
  });

  test("on a coding plan the tier's alias runs the plan's model for it, whatever else the plan has", () => {
    const tiers = (plan: keyof typeof CODING_PLANS) =>
      MODEL_TIERS.map((tier) => planModel(CODING_PLANS[plan], brainModelForTier("claude_code", tier)).label);
    // Small, medium, large.
    expect(tiers("zai")).toEqual(["GLM-5.3 Flash", "GLM-5.3", "GLM-5.3"]);
    expect(tiers("kimi")).toEqual(["Kimi for Coding", "Kimi for Coding", "K3.1 Pro"]);
    expect(tiers("minimax")).toEqual(["MiniMax M3.1 Flash", "MiniMax M3.1 Flash", "MiniMax M3.1 Flash"]);
    expect(tiers("opencode")).toEqual(["Claude Haiku 5.5", "MiniMax M3", "MiniMax M3"]);
  });

  test("the API brain: the model of the tier from the agent's key's line, and the effort", () => {
    const plan: BrainPlan = { kind: "model" };
    expect(needsAutoChoice(agent, plan)).toBe(true);
    const applied = autoApplied(agent, plan, choice, "anthropic");
    expect(applied).toEqual({ apiModel: "claude-haiku-5-5", effort: "low" });
    expect(autoApplied(agent, plan, { tier: "large", effort: "high" }, "openai")).toEqual({
      apiModel: "gpt-6.1-sol",
      effort: "high",
    });
    const run = withAuto({ ...agent, id: "a" }, plan, applied);
    expect(run.agent).toEqual({ ...agent, id: "a", model: "claude-haiku-5-5" });
    expect(run.plan).toEqual({ kind: "model", effort: "low" });
    // A resumed run keeps the model it started with, whatever the keys say now.
    expect(autoApplied(agent, plan, { ...choice, apiModel: "claude-opus-5-5" }, "openai").apiModel).toBe(
      "claude-opus-5-5",
    );
  });

  test("a computer brain: its model and effort when they are auto; never another brain", () => {
    const cc = { model: "claude-sonnet-5-5", brain: "claude_code", brainModel: AUTO_MODEL, brainEffort: AUTO_MODEL };
    const plan: BrainPlan = {
      kind: "claude_code",
      model: AUTO_MODEL,
      session: { id: "s", resume: false, machineId: "m", cwd: "" },
    };
    expect(autoWanted(cc)).toBe(true);
    expect(needsAutoChoice(cc, plan)).toBe(true);
    const applied = autoApplied(cc, plan, { tier: "large", effort: "high" }, "anthropic");
    expect(applied).toEqual({ brainModel: "opus", effort: "high" });
    const run = withAuto(cc, plan, applied);
    expect(run.plan).toMatchObject({ kind: "claude_code", model: "opus", effort: "high", session: { id: "s" } });
    // The agent's own API model stays (its fallback answers with it).
    expect(run.agent.model).toBe("claude-sonnet-5-5");

    // Only the model on auto: the effort set by the person stays.
    const onlyModel = { ...cc, brainEffort: "max" };
    const codexPlan: BrainPlan = { kind: "codex", model: AUTO_MODEL, effort: "max" };
    const codex = { ...onlyModel, brain: "codex" };
    expect(withAuto(codex, codexPlan, autoApplied(codex, codexPlan, choice, "anthropic")).plan).toEqual({
      kind: "codex",
      model: "gpt-6-luna",
      effort: "max",
    });
    // A mission thinking with another brain than the agent's: the agent's effort doesn't apply there.
    expect(autoApplied(cc, { kind: "codex", model: "gpt-6-sol" }, choice, "anthropic")).toEqual({});
    expect(needsAutoChoice(cc, { kind: "codex", model: "gpt-6-sol" })).toBe(false);
  });

  test("an OpenRouter key: its good picks per tier, or the workspace's own while OpenRouter lists them", () => {
    setOpenRouterModels(parseOpenRouterModels(fixture));
    const plan: BrainPlan = { kind: "model" };
    const pick = (tier: "small" | "medium" | "large", tiers?: Record<string, string>) =>
      autoApplied(agent, plan, { tier, effort: "low" }, "openrouter", tiers).apiModel;
    expect([pick("small"), pick("medium"), pick("large")]).toEqual([
      "~deepseek/deepseek-flash-latest",
      "~z-ai/glm-latest",
      "~anthropic/claude-sonnet-latest",
    ]);
    expect(pick("medium", { medium: "tencent/hy3-preview" })).toBe("tencent/hy3-preview");
    // One OpenRouter no longer lists, or another provider's: the default stands.
    expect(pick("medium", { medium: "acme/retired" })).toBe("~z-ai/glm-latest");
    expect(pick("medium", { medium: "claude-sonnet-5-5" })).toBe("~z-ai/glm-latest");
  });

  test("an API model on auto with a computer brain: the API model is chosen too (a fallback thinks with it)", () => {
    const both = { model: AUTO_MODEL, brain: "codex", brainModel: "gpt-6-sol", brainEffort: null };
    const plan: BrainPlan = { kind: "codex", model: "gpt-6-sol" };
    expect(needsAutoChoice(both, plan)).toBe(true);
    expect(autoApplied(both, plan, choice, "anthropic")).toEqual({ apiModel: "claude-haiku-5-5" });
  });

  test("nothing on auto: nothing to choose (a stale computer setting on the API brain asks nobody)", () => {
    const fixed = { model: "claude-sonnet-5-5", brain: "model", brainModel: AUTO_MODEL, brainEffort: AUTO_MODEL };
    expect(autoWanted(fixed)).toBe(false);
    expect(needsAutoChoice(fixed, { kind: "model" })).toBe(false);
  });

  test("the settings take auto: the agent's model, a computer brain's model and effort", () => {
    expect(normalizeBrainModel("claude_code", "auto")).toBe("auto");
    expect(normalizeBrainModel("codex", "Auto")).toBe("auto");
    expect(() => normalizeBrainModel("model", "auto")).toThrow(ValidationError);
    expect(isBrainEffortSetting("auto")).toBe(true);
    expect(isBrainEffortSetting("high")).toBe(true);
    expect(isBrainEffortSetting("turbo")).toBe(false);
  });
});

describe("the maker beside an agent on Automático", () => {
  test("its own key's, else the workspace's: the logo the app shows, never a generic mark", async () => {
    f = await setup();
    const line = async () => {
      const agent = await getAgent(f.db, f.org.id, f.agent.id);
      return agent ? (await agentBrainLines(f.db, f.owner.id, f.org.id, [agent])).get(agent.id) : undefined;
    };
    // A fixed model: its provider is the model's, read beside it.
    expect((await line())?.maker).toBeUndefined();
    const key = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "openai",
      label: "oa",
      apiKey: "sk-test-openai-key-1234567890",
    });
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: AUTO_MODEL, credentialId: key.id });
    expect(await line()).toMatchObject({ kind: "model", maker: "openai" });
    // No key of its own: the workspace's newest key, as its runs pick (`autoProvider`).
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { credentialId: null });
    await f.db
      .update(schema.providerCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(schema.providerCredentials.id, key.id));
    expect((await line())?.maker).toBe("anthropic");
  });
});

describe("new agents start on Automático", () => {
  test("no model chosen: auto for the API and for any computer brain; a fixed model leaves the brain's default", async () => {
    f = await setup();
    const born = await createAgent(f.db, f.owner.id, f.org.id, { name: "Eva", handle: "eva" }, NEW_AGENT_DEFAULTS);
    expect(born).toMatchObject({ model: "auto", brain: "model", brainModel: "auto", brainEffort: "auto" });
    const fixed = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Leo", handle: "leo", model: "claude-sonnet-5-5" },
      NEW_AGENT_DEFAULTS,
    );
    expect(fixed).toMatchObject({ model: "claude-sonnet-5-5", brainModel: null, brainEffort: null });
    // Callers with a default of their own (scripts, evals) keep it: only `auto` makes the brain settings automatic.
    const own = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Bia", handle: "bia" },
      { model: "claude-haiku-5-5" },
    );
    expect(own).toMatchObject({ model: "claude-haiku-5-5", brainModel: null, brainEffort: null });
  });
});

describe("a run of an agent on Automático", () => {
  const judgeAnswers = (tier: { current: string }) => (kind: string, id: string) =>
    kind === "auto_model" ? (id === "tier" ? tier.current : "high") : undefined;

  test("asks once, thinks with the chosen model and effort, bills and records it; a resume keeps it", async () => {
    const tier = { current: "large" };
    f = await setup({
      askUser: true,
      judge: judgeAnswers(tier),
      reply: (req) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (last.includes("tool_result")) return { chunks: ["Pronto."] };
        return {
          chunks: [],
          toolUses: [
            {
              name: "ask_user",
              input: {
                why: "I need a person's answer before I go on: this decides what I change next.",
                question: "Qual ambiente?",
                choices: ["staging", "production"],
              },
            },
          ],
        };
      },
    });
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: AUTO_MODEL });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev faz o deploy da cobrança",
    });
    await drainOutbox(f.db, f.handlers);

    const first = f.provider.calls[0]?.request;
    expect(first?.model).toBe("claude-opus-5-5");
    expect(first?.effort).toBe("high");
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id));
    expect(run?.status).toBe("waiting_input");
    expect((run?.transcript as { autoModel?: unknown } | null)?.autoModel).toMatchObject({
      tier: "large",
      effort: "high",
      apiModel: "claude-opus-5-5",
      source: "judge",
    });
    const contexts = await f.db
      .select()
      .from(schema.agentRunSteps)
      .where(eq(schema.agentRunSteps.kind, "context"))
      .orderBy(asc(schema.agentRunSteps.seq));
    expect(contexts.find((s) => s.data.autoModel)?.data.autoModel).toMatchObject({
      tier: "large",
      effort: "high",
      brain: "model",
      model: "claude-opus-5-5",
      source: "judge",
    });
    // The usage is the chosen model's (priced and reserved at it), as for any agent.
    const usage = await f.db
      .select()
      .from(schema.usageRecords)
      .where(and(eq(schema.usageRecords.agentId, f.agent.id), eq(schema.usageRecords.kind, "agent")));
    expect(usage.map((u) => [u.model, u.requestedModel])).toEqual([["claude-opus-5-5", "claude-opus-5-5"]]);

    // The judge would say small now: the resumed run keeps its model and isn't asked again.
    tier.current = "small";
    const [q] = await f.db.select().from(schema.agentQuestions);
    await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, q?.id ?? "", { choice: "staging" });
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.at(-1)?.request.model).toBe("claude-opus-5-5");
    expect(f.provider.calls.at(-1)?.request.effort).toBe("high");
    const asked = (f.context.judge as ReturnType<typeof createFakeJudge>).calls.filter((c) => c.kind === "auto_model");
    expect(asked).toHaveLength(1);

    // A new run decides again.
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev obrigado!",
    });
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.at(-1)?.request.model).toBe("claude-haiku-5-5");
  });

  test("the judge fails: the run still answers, on the medium tier with medium effort, and says why", async () => {
    f = await setup({
      judge: (kind) => {
        if (kind === "auto_model") throw new Error("judge down");
        return undefined;
      },
      reply: () => ({ chunks: ["Oi!"] }),
    });
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: AUTO_MODEL });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls[0]?.request).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium" });
    const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.kind, "context"));
    expect(steps.find((s) => s.data.autoModel)?.data.autoModel).toMatchObject({
      tier: "medium",
      model: "claude-sonnet-5-5",
      source: "error",
      reason: "The judge failed: medium tier, medium effort.",
    });
  });

  test("an agent with an OpenAI key picks from OpenAI's line", async () => {
    f = await setup({ judge: judgeAnswers({ current: "small" }), reply: () => ({ chunks: ["ok"] }) });
    const key = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "openai",
      label: "oa",
      apiKey: "sk-test-openai-key-1234567890",
    });
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: AUTO_MODEL, credentialId: key.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(0);
    expect(f.openaiProvider.calls[0]?.request).toMatchObject({ model: "gpt-6-luna", effort: "high" });
  });

  test("a workspace whose only key is DeepSeek's: an agent without a key of its own picks from DeepSeek's line", async () => {
    f = await setup({ judge: judgeAnswers({ current: "large" }), reply: () => ({ chunks: ["ok"] }) });
    await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
    await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "deepseek",
      label: "ds",
      apiKey: "sk-deepseek-test-1234567890",
      makeDefault: true,
    });
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: AUTO_MODEL, credentialId: null });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls[0]).toMatchObject({
      apiKey: "sk-deepseek-test-1234567890",
      request: { model: "deepseek-v4-pro", effort: "high" },
    });
  });

  test("a workspace on an OpenRouter key: the tier's model is the one it chose in Settings", async () => {
    f = await setup({ judge: judgeAnswers({ current: "large" }), reply: () => ({ chunks: ["ok"] }) });
    setOpenRouterModels(parseOpenRouterModels(fixture));
    await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
    const keyCheck = (async () => new Response("{}")) as unknown as typeof fetch;
    await createCredential(
      f.db,
      f.keyWrapper,
      f.owner.id,
      f.org.id,
      { provider: "openrouter", label: "or", apiKey: "or-test-key-12345678", makeDefault: true },
      { fetch: keyCheck },
    );
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: AUTO_MODEL, credentialId: null });
    await expect(
      updateOrgSettings(f.db, f.owner.id, f.org.id, { autoModels: { openrouter: { large: "claude-opus-5-5" } } }),
    ).rejects.toBeInstanceOf(ValidationError);
    const saved = await updateOrgSettings(f.db, f.owner.id, f.org.id, {
      autoModels: { openrouter: { large: "anthropic/claude-sonnet-5.5", small: "tencent/hy3-preview" } },
    });
    expect(saved.autoModels).toEqual({
      openrouter: { large: "anthropic/claude-sonnet-5.5", small: "tencent/hy3-preview" },
    });
    // Null puts a tier back on the default; the others stay.
    const cleared = await updateOrgSettings(f.db, f.owner.id, f.org.id, {
      autoModels: { openrouter: { small: null } },
    });
    expect(cleared.autoModels).toEqual({ openrouter: { large: "anthropic/claude-sonnet-5.5" } });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls[0]).toMatchObject({
      apiKey: "or-test-key-12345678",
      request: { model: "anthropic/claude-sonnet-5.5", effort: "high" },
    });
  });

  test("OpenRouter's list not read yet: the run waits it out on its OpenRouter key, never on another provider's model", async () => {
    f = await setup({ judge: judgeAnswers({ current: "large" }), reply: () => ({ chunks: ["ok"] }) });
    await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
    const keyCheck = (async () => new Response("{}")) as unknown as typeof fetch;
    const key = await createCredential(
      f.db,
      f.keyWrapper,
      f.owner.id,
      f.org.id,
      { provider: "openrouter", label: "or", apiKey: "or-test-key-12345678", makeDefault: true },
      { fetch: keyCheck },
    );
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: AUTO_MODEL, credentialId: key.id });
    // Summaries on that key wait for the list too.
    await expect(cheapModelForOrg(f.db, f.org.id, { anthropic: "claude-haiku-5-5" })).rejects.toMatchObject({
      retryable: true,
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    const run = async () =>
      (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id)))[0];
    expect(f.provider.calls).toHaveLength(0);
    expect(await run()).toMatchObject({ status: "running", error: null });
    // The next attempt has the list: the tier the judge chose, on OpenRouter's line.
    setOpenRouterModels(parseOpenRouterModels(fixture));
    await drainOutbox(f.db, f.handlers, { now: new Date(Date.now() + 60_000) });
    expect(f.provider.calls[0]).toMatchObject({
      apiKey: "or-test-key-12345678",
      request: { model: "~anthropic/claude-sonnet-latest", effort: "high" },
    });
    expect((await run())?.status).toBe("done");
    expect(await cheapModelForOrg(f.db, f.org.id, { anthropic: "claude-haiku-5-5" })).toBe(
      "~deepseek/deepseek-flash-latest",
    );
  });

  test("an agent without auto never asks the judge about its model", async () => {
    f = await setup({ judge: judgeAnswers({ current: "large" }), reply: () => ({ chunks: ["ok"] }) });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls[0]?.request.model).toBe("claude-sonnet-5-5");
    expect(f.provider.calls[0]?.request.effort).toBeUndefined();
    const judge = f.context.judge as ReturnType<typeof createFakeJudge>;
    expect(judge.calls.some((c) => c.kind === "auto_model")).toBe(false);
  });

  test("the agent's model takes auto, and still refuses a model outside the catalog", async () => {
    f = await setup();
    const saved = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: AUTO_MODEL });
    expect(saved.model).toBe("auto");
    await expect(updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: "gpt-9000" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
