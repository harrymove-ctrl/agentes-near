import { afterEach, describe, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL } from "@agenteschat/adapters";
import { and, eq, inArray, schema, sql } from "@agenteschat/db";
import {
  type AgentSetupInput,
  applyAgentSetup,
  createAgent,
  createSetupToolSource,
  ForbiddenError,
  getNewAgentSetup,
  NEW_AGENT_DEFAULTS,
  PLAN_OPENED_JOB,
  PROPOSE_AGENT_TOOL,
  releaseAgents,
  type SetupResult,
  setAgentBrain,
  type ToolContext,
  updateAgent,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/*
 * ADR 0094: one agent's "Quem pensa" used on others, each by its own rules, and the setup new agents start with.
 */
let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const ANAS = "0193dddd-0000-4000-8000-0000000000a1";
const BIAS = "0193dddd-0000-4000-8000-0000000000b1";

/**
 * Ana's MacBook (Claude Code) with her account for all of her agents there, and Bia's GLM Coding plan; a PC of Ana's.
 * Dev and Theo are Ana's on the MacBook (the API), Lia hers on the PC; Zoe is Bia's, on her plan. Caio is an admin.
 */
async function world() {
  const fx = await setup();
  f = fx;
  const pair = async (name: string) => {
    const { machineId } = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
      name,
      protocol: ACCOUNTS_PROTOCOL,
      exec: true,
    });
    await fx.db
      .update(schema.machines)
      .set({ executors: { claude: { version: "2.1.304", loggedIn: true }, detectedAt: new Date().toISOString() } })
      .where(eq(schema.machines.id, machineId));
    return machineId;
  };
  const mac = await pair("MacBook");
  const pc = await pair("PC");
  const bia = await addMember(fx.db, fx.org.id, "member", "bia");
  const caio = await addMember(fx.db, fx.org.id, "admin", "caio");
  await fx.db.insert(schema.machineAccounts).values([
    {
      id: ANAS,
      orgId: fx.org.id,
      machineId: mac,
      kind: "claude_code",
      label: "Claude",
      status: "active",
      createdBy: fx.owner.id,
      shared: true,
    },
    {
      id: BIAS,
      orgId: fx.org.id,
      machineId: mac,
      kind: "claude_code",
      label: "GLM Coding",
      provider: "zai",
      status: "active",
      createdBy: bia.id,
    },
  ]);
  const agent = async (name: string, values: Partial<typeof schema.agents.$inferInsert>) => {
    const [row] = await fx.db
      .insert(schema.agents)
      .values({
        orgId: fx.org.id,
        name,
        handle: name.toLowerCase(),
        model: "claude-sonnet-5-5",
        ownerUserId: fx.owner.id,
        machineId: mac,
        ...values,
      })
      .returning();
    if (!row) throw new Error("no agent");
    return row.id;
  };
  await fx.db.update(schema.agents).set({ machineId: mac }).where(eq(schema.agents.id, fx.agent.id));
  const theo = await agent("Theo", {});
  const lia = await agent("Lia", { machineId: pc });
  const zoe = await agent("Zoe", { ownerUserId: bia.id, brain: "claude_code", brainAccountId: BIAS });
  const row = async (id: string) => {
    const [r] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, id));
    if (!r) throw new Error("no agent");
    return r;
  };
  const brainAudits = (id: string) =>
    fx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "agent.brain"), eq(schema.auditLog.targetId, id)));
  const stored = async () => {
    const [s] = await fx.db
      .select({ setup: schema.organizationSettings.agentSetup })
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.orgId, fx.org.id));
    return s?.setup ?? null;
  };
  return { fx, deps: { db: fx.db }, mac, pc, bia, caio, dev: fx.agent.id, theo, lia, zoe, row, brainAudits, stored };
}

const ANA_CLAUDE = (mac: string) => ({
  brain: "claude_code",
  machineId: mac,
  account: ANAS,
  model: "opus",
  effort: "high",
  fallback: true,
});

describe("Usar em outros agentes", () => {
  test("Ana's Claude on her agents; another computer and another person's plan say why; a preview keeps nothing", async () => {
    const w = await world();
    const { fx, deps } = w;
    const ids = [w.dev, w.theo, w.lia, w.zoe];
    const expected: SetupResult[] = [
      { agentId: w.dev, status: "applied" },
      { agentId: w.theo, status: "applied" },
      { agentId: w.lia, status: "skipped", reason: "other_computer", params: { computer: "PC" } },
      // Zoe keeps Bia's GLM Coding plan, which has no Opus.
      { agentId: w.zoe, status: "skipped", reason: "model_missing", params: { plan: "GLM Coding", model: "Opus" } },
    ];
    const preview = await applyAgentSetup(deps, fx.owner.id, fx.org.id, {
      setup: ANA_CLAUDE(w.mac),
      agentIds: ids,
      preview: true,
    });
    expect(preview).toEqual(expected);
    expect(await w.row(w.dev)).toMatchObject({ brain: "model", brainAccountId: null });
    expect(await w.brainAudits(w.dev)).toHaveLength(0);
    expect(await w.stored()).toBeNull();

    expect(await applyAgentSetup(deps, fx.owner.id, fx.org.id, { setup: ANA_CLAUDE(w.mac), agentIds: ids })).toEqual(
      expected,
    );
    for (const id of [w.dev, w.theo]) {
      expect(await w.row(id)).toMatchObject({
        brain: "claude_code",
        brainAccountId: ANAS,
        brainModel: "opus",
        brainEffort: "high",
        audienceMode: "owner",
      });
      // Each is its own change in the audit log, saying where it came from.
      const [audit] = await w.brainAudits(id);
      expect(audit?.details).toMatchObject({ to: { brain: "claude_code", account: ANAS }, via: "setup" });
    }
    expect(await w.row(w.zoe)).toMatchObject({ brainAccountId: BIAS, brainModel: null });
    expect(await w.stored()).toEqual({
      brain: "claude_code",
      model: "opus",
      machineId: w.mac,
      account: ANAS,
      effort: "high",
      contextTokens: null,
      fallback: true,
      autonomy: null,
    });
    // Again: they already think so.
    const again = await applyAgentSetup(deps, fx.owner.id, fx.org.id, { setup: ANA_CLAUDE(w.mac), agentIds: [w.dev] });
    expect(again).toEqual([{ agentId: w.dev, status: "same" }]);
  });

  test("Velocidade goes to the agents picked, never into what new agents start with; left out, each keeps its own", async () => {
    const w = await world();
    const setup = { ...ANA_CLAUDE(w.mac), speed: "fast" };
    const ids = [w.dev];
    await applyAgentSetup(w.deps, w.fx.owner.id, w.fx.org.id, { setup, agentIds: ids });
    expect(await w.row(w.dev)).toMatchObject({ brainSpeed: "fast" });
    expect(await w.stored()).not.toHaveProperty("speed");
    expect(await applyAgentSetup(w.deps, w.fx.owner.id, w.fx.org.id, { setup, agentIds: ids })).toEqual([
      { agentId: w.dev, status: "same" },
    ]);
    await applyAgentSetup(w.deps, w.fx.owner.id, w.fx.org.id, { setup: ANA_CLAUDE(w.mac), agentIds: ids });
    expect(await w.row(w.dev)).toMatchObject({ brainSpeed: "fast" });
    await expect(
      applyAgentSetup(w.deps, w.fx.owner.id, w.fx.org.id, { setup: { ...setup, speed: "turbo" }, agentIds: ids }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("a model the other plan has: the agent keeps its owner's plan and takes the rest", async () => {
    const w = await world();
    const sonnet = { ...ANA_CLAUDE(w.mac), model: "sonnet", contextTokens: 400_000 };
    const [zoe] = await applyAgentSetup(w.deps, w.fx.owner.id, w.fx.org.id, { setup: sonnet, agentIds: [w.zoe] });
    expect(zoe).toEqual({ agentId: w.zoe, status: "applied", keeps: { account: "GLM Coding" } });
    expect(await w.row(w.zoe)).toMatchObject({
      brainAccountId: BIAS,
      brainModel: "sonnet",
      brainEffort: "high",
      contextTokens: 400_000,
    });
    // Nobody took it whole: new agents don't start with it.
    expect(await w.stored()).toBeNull();
  });

  test("an agent on another computer, or a setup whose computer is gone, takes nothing", async () => {
    const w = await world();
    await w.fx.db.update(schema.agents).set({ brain: "claude_code" }).where(eq(schema.agents.id, w.lia));
    const use = (setup: Record<string, unknown>) =>
      applyAgentSetup(w.deps, w.fx.owner.id, w.fx.org.id, { setup, agentIds: [w.lia] });
    expect(await use(ANA_CLAUDE(w.mac))).toEqual([
      { agentId: w.lia, status: "skipped", reason: "other_computer", params: { computer: "PC" } },
    ]);
    expect(await use({ ...ANA_CLAUDE(w.mac), machineId: "0193dddd-0000-4000-8000-00000000dead" })).toEqual([
      { agentId: w.lia, status: "skipped", reason: "failed" },
    ]);
    expect(await w.row(w.lia)).toMatchObject({ brain: "claude_code", brainModel: null, brainEffort: null });
    // Nobody took it: new agents don't start with it.
    expect(await w.stored()).toBeNull();
  });

  test("who may: a member only their own agents, an API model only admins, one agent's sign-in for one", async () => {
    const w = await world();
    const { fx, deps, bia, caio } = w;
    const api = { brain: "model", model: "claude-opus-5-5", key: fx.credential.id };
    expect(await applyAgentSetup(deps, bia.id, fx.org.id, { setup: api, agentIds: [w.dev, w.zoe] })).toEqual([
      { agentId: w.dev, status: "skipped", reason: "not_allowed" },
      { agentId: w.zoe, status: "skipped", reason: "admins_only" },
    ]);
    // Nothing taken, nothing kept for new agents.
    expect(await w.stored()).toBeNull();
    // An admin changes the model and key of anyone's agent; Zoe leaves Bia's plan for the API.
    expect(await applyAgentSetup(deps, caio.id, fx.org.id, { setup: api, agentIds: [w.zoe] })).toEqual([
      { agentId: w.zoe, status: "applied" },
    ]);
    expect(await w.row(w.zoe)).toMatchObject({
      brain: "model",
      model: "claude-opus-5-5",
      credentialId: fx.credential.id,
    });
    expect(await w.stored()).toEqual({
      brain: "model",
      model: "claude-opus-5-5",
      key: fx.credential.id,
      contextTokens: null,
      autonomy: null,
    });

    // Ana's plan thinks only for her agents: an admin gives it to hers (Theo), never to Bia's Zoe.
    const byAdmin = (setup: AgentSetupInput) =>
      applyAgentSetup(deps, caio.id, fx.org.id, { setup, agentIds: [w.theo, w.zoe], preview: true });
    expect(await byAdmin(ANA_CLAUDE(w.mac))).toEqual([
      { agentId: w.theo, status: "applied" },
      { agentId: w.zoe, status: "skipped", reason: "account_owner", params: { owner: "ana" } },
    ]);
    // So does the MacBook's own sign-in: she connected it.
    expect(await byAdmin({ ...ANA_CLAUDE(w.mac), account: null })).toEqual([
      { agentId: w.theo, status: "applied" },
      { agentId: w.zoe, status: "skipped", reason: "account_owner", params: { owner: "ana" } },
    ]);
    expect(
      await applyAgentSetup(deps, fx.owner.id, fx.org.id, { setup: ANA_CLAUDE(w.mac), agentIds: [w.zoe] }),
    ).toEqual([{ agentId: w.zoe, status: "skipped", reason: "account_owner", params: { owner: "ana" } }]);

    // A sign-in made for one agent thinks for that one: Theo can't share Dev's.
    await fx.db.update(schema.machineAccounts).set({ shared: false }).where(eq(schema.machineAccounts.id, ANAS));
    // In the order asked: the first one takes it, also in a preview.
    const first = (agentIds: string[]) =>
      applyAgentSetup(deps, fx.owner.id, fx.org.id, { setup: ANA_CLAUDE(w.mac), agentIds, preview: true });
    expect(await first([w.theo, w.dev])).toEqual([
      { agentId: w.theo, status: "applied" },
      { agentId: w.dev, status: "skipped", reason: "account_single", params: { agent: "Theo" } },
    ]);
    expect(await first([w.dev, w.theo])).toEqual([
      { agentId: w.dev, status: "applied" },
      { agentId: w.theo, status: "skipped", reason: "account_single", params: { agent: "Dev" } },
    ]);
    await setAgentBrain(deps, fx.owner.id, fx.org.id, w.dev, { brain: "claude_code", account: ANAS });
    expect(
      await applyAgentSetup(deps, fx.owner.id, fx.org.id, { setup: ANA_CLAUDE(w.mac), agentIds: [w.dev, w.theo] }),
    ).toEqual([
      { agentId: w.dev, status: "applied" },
      { agentId: w.theo, status: "skipped", reason: "account_single", params: { agent: "Dev" } },
    ]);
  });
});

describe("Usar em outros agentes on someone else's plan (ADR 0059 §5)", () => {
  const planJobs = (w: Awaited<ReturnType<typeof world>>) =>
    w.fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, PLAN_OPENED_JOB));

  test("an admin letting more people talk to Ana's agent on her plan: the preview says so, and Ana gets an email", async () => {
    const w = await world();
    const { fx, deps, caio } = w;
    const open = { ...ANA_CLAUDE(w.mac), onlyOwner: false };
    const use = (userId: string, setup: AgentSetupInput, preview?: boolean) =>
      applyAgentSetup(deps, userId, fx.org.id, { setup, agentIds: [w.theo], ...(preview ? { preview } : {}) });
    expect(await use(caio.id, open, true)).toEqual([{ agentId: w.theo, status: "applied", opensPlan: true }]);
    // The MacBook's own sign-in is Ana's plan too: she connected it.
    expect(await use(caio.id, { ...open, account: null }, true)).toEqual([
      { agentId: w.theo, status: "applied", opensPlan: true },
    ]);
    // Only its owner, or Ana herself: nothing to ask.
    expect(await use(caio.id, { ...open, onlyOwner: true }, true)).toEqual([{ agentId: w.theo, status: "applied" }]);
    expect(await use(fx.owner.id, open, true)).toEqual([{ agentId: w.theo, status: "applied" }]);
    expect(await planJobs(w)).toHaveLength(0);
    expect(await use(caio.id, open)).toEqual([{ agentId: w.theo, status: "applied", opensPlan: true }]);
    expect(await planJobs(w)).toHaveLength(1);
  });
});

describe("new agents start with the last setup", () => {
  test("the last Quem pensa saved or used on others, as it stands; only for whoever creates agents", async () => {
    const w = await world();
    const { fx, deps, bia, caio } = w;
    expect(await getNewAgentSetup(deps, fx.owner.id, fx.org.id)).toBeNull();
    // A Quem pensa saved is the person's latest choice.
    await setAgentBrain(deps, fx.owner.id, fx.org.id, w.dev, {
      brain: "claude_code",
      account: ANAS,
      model: "opus",
      effort: "high",
    });
    expect(await getNewAgentSetup(deps, fx.owner.id, fx.org.id)).toEqual({
      brain: "claude_code",
      model: "opus",
      key: null,
      contextTokens: null,
      computer: { machineId: w.mac, name: "MacBook" },
      account: { id: ANAS, label: "Claude", provider: null, mine: true, free: true },
      ownSignIn: true,
      effort: "high",
      fallback: true,
      autonomy: null,
    });
    // Anyone else sees whose it is: a plan thinks only for its owner's agents.
    expect((await getNewAgentSetup(deps, caio.id, fx.org.id))?.account).toMatchObject({ mine: false });
    await expect(getNewAgentSetup(deps, bia.id, fx.org.id)).rejects.toBeInstanceOf(ForbiddenError);

    // An API model chosen for an agent on the API is a choice too.
    await updateAgent(fx.db, fx.owner.id, fx.org.id, w.theo, { model: "claude-haiku-5-5" });
    expect(await getNewAgentSetup(deps, fx.owner.id, fx.org.id)).toEqual({
      brain: "model",
      model: "claude-haiku-5-5",
      key: null,
      contextTokens: null,
      autonomy: null,
    });
    // Used on others, the setup itself.
    await applyAgentSetup(deps, fx.owner.id, fx.org.id, { setup: ANA_CLAUDE(w.mac), agentIds: [w.theo] });
    expect((await getNewAgentSetup(deps, fx.owner.id, fx.org.id))?.account?.id).toBe(ANAS);
    // Its account gone, there is nothing to start with.
    await releaseAgents(fx.db, fx.org.id, [ANAS]);
    await fx.db.delete(schema.machineAccounts).where(eq(schema.machineAccounts.id, ANAS));
    expect(await getNewAgentSetup(deps, fx.owner.id, fx.org.id)).toBeNull();
  });

  test("Criar agente's own pick counts: a fixed model or a key, not Automático, not an import's model", async () => {
    const w = await world();
    const { fx } = w;
    const make = (handle: string, model?: string, remember = true) =>
      createAgent(
        fx.db,
        fx.owner.id,
        fx.org.id,
        { name: handle, handle, ...(model ? { model } : {}) },
        NEW_AGENT_DEFAULTS,
        {
          remember,
        },
      );
    await make("eva");
    expect(await w.stored()).toBeNull();
    await make("ivo", "claude-haiku-5-5");
    expect(await w.stored()).toEqual({
      brain: "model",
      model: "claude-haiku-5-5",
      key: null,
      contextTokens: null,
      autonomy: null,
    });
    await make("rui", "claude-opus-5-5", false);
    expect((await w.stored())?.model).toBe("claude-haiku-5-5");
  });

  test("set only by whoever creates agents, and on the API only by an admin", async () => {
    const w = await world();
    const { fx, deps, bia } = w;
    const glm = { brain: "claude_code", machineId: w.mac, account: BIAS, model: null, effort: "high" };
    // Bia can't create agents: her own agent takes her plan, new agents don't start with it.
    expect(await applyAgentSetup(deps, bia.id, fx.org.id, { setup: glm, agentIds: [w.zoe] })).toEqual([
      { agentId: w.zoe, status: "applied" },
    ]);
    expect(await w.stored()).toBeNull();
    // Once she may (but isn't an admin), her plan counts, and an API model she picks doesn't.
    await fx.db
      .update(schema.orgRoles)
      .set({ permissions: sql`array_append(${schema.orgRoles.permissions}, 'create_agents')` })
      .where(and(eq(schema.orgRoles.orgId, fx.org.id), eq(schema.orgRoles.kind, "everyone")));
    await setAgentBrain(deps, bia.id, fx.org.id, w.zoe, { effort: "max" });
    expect(await w.stored()).toMatchObject({ brain: "claude_code", account: BIAS, effort: "max" });
    await createAgent(
      fx.db,
      bia.id,
      fx.org.id,
      { name: "Ivo", handle: "ivo", model: "claude-haiku-5-5" },
      NEW_AGENT_DEFAULTS,
      {
        remember: true,
      },
    );
    expect(await w.stored()).toMatchObject({ brain: "claude_code", account: BIAS });
  });
});

describe("the Autonomia goes with the setup", () => {
  const autonomyAudits = (w: Awaited<ReturnType<typeof world>>, id: string) =>
    w.fx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "agent.mission_command_approval"), eq(schema.auditLog.targetId, id)));

  test("the preview says each agent's change; one that can't take the AI still takes the Autonomia", async () => {
    const w = await world();
    const { fx, deps } = w;
    await fx.db
      .update(schema.agents)
      .set({ missionCommandApproval: "always" })
      .where(inArray(schema.agents.id, [w.theo, w.lia]));
    const setup = { ...ANA_CLAUDE(w.mac), autonomy: "never" };
    const ids = [w.dev, w.theo, w.lia, w.zoe];
    const onPc = { agentId: w.lia, status: "skipped", reason: "other_computer", params: { computer: "PC" } } as const;
    const expected: SetupResult[] = [
      { agentId: w.dev, status: "applied", autonomy: { from: "low_risk_auto", to: "never" } },
      { agentId: w.theo, status: "applied", autonomy: { from: "always", to: "never" } },
      { ...onPc, autonomy: { from: "always", to: "never" } },
      {
        agentId: w.zoe,
        status: "skipped",
        reason: "model_missing",
        params: { plan: "GLM Coding", model: "Opus" },
        autonomy: { from: "low_risk_auto", to: "never" },
      },
    ];
    expect(await applyAgentSetup(deps, fx.owner.id, fx.org.id, { setup, agentIds: ids, preview: true })).toEqual(
      expected,
    );
    expect(await w.row(w.dev)).toMatchObject({ missionCommandApproval: null });
    expect(await autonomyAudits(w, w.dev)).toHaveLength(0);

    expect(await applyAgentSetup(deps, fx.owner.id, fx.org.id, { setup, agentIds: ids })).toEqual(expected);
    for (const id of ids) {
      expect(await w.row(id)).toMatchObject({ missionCommandApproval: "never" });
      // Set by the editor of one agent's Autonomia, audited as its own change.
      const [audit] = await autonomyAudits(w, id);
      expect(audit?.details).toMatchObject({ to: "never", via: "setup" });
    }
    // Lia and Zoe keep their AI.
    expect(await w.row(w.lia)).toMatchObject({ brain: "model", machineId: w.pc });
    expect(await w.row(w.zoe)).toMatchObject({ brainAccountId: BIAS, brainModel: null });
    expect(await w.stored()).toMatchObject({ account: ANAS, autonomy: "never" });
    expect(await getNewAgentSetup(deps, fx.owner.id, fx.org.id)).toMatchObject({ autonomy: "never" });
    // Only the Autonomia taken is not a setup new agents start with.
    const always = { ...setup, autonomy: "always" };
    expect(await applyAgentSetup(deps, fx.owner.id, fx.org.id, { setup: always, agentIds: [w.lia] })).toEqual([
      { ...onPc, autonomy: { from: "never", to: "always" } },
    ]);
    expect(await w.stored()).toMatchObject({ autonomy: "never" });

    // Already thinking this way, it takes the Autonomia alone.
    await fx.db.update(schema.agents).set({ missionCommandApproval: "always" }).where(eq(schema.agents.id, w.dev));
    expect(await applyAgentSetup(deps, fx.owner.id, fx.org.id, { setup, agentIds: [w.dev] })).toEqual([
      { agentId: w.dev, status: "same", autonomy: { from: "always", to: "never" } },
    ]);
    expect(await applyAgentSetup(deps, fx.owner.id, fx.org.id, { setup, agentIds: [w.dev] })).toEqual([
      { agentId: w.dev, status: "same" },
    ]);
    // Left out of the setup, each keeps its own; the default is no Autonomia for new agents to start with.
    expect(
      await applyAgentSetup(deps, fx.owner.id, fx.org.id, { setup: ANA_CLAUDE(w.mac), agentIds: [w.dev] }),
    ).toEqual([{ agentId: w.dev, status: "same" }]);
    await applyAgentSetup(deps, fx.owner.id, fx.org.id, {
      setup: { ...setup, autonomy: "low_risk_auto" },
      agentIds: [w.dev],
    });
    expect(await w.stored()).toMatchObject({ autonomy: "low_risk_auto" });
    expect(await getNewAgentSetup(deps, fx.owner.id, fx.org.id)).toMatchObject({ autonomy: null });
  });

  test("one that already thinks so on its own account takes the Autonomia, and new agents don't start with it", async () => {
    const w = await world();
    const { fx, deps } = w;
    // Zoe already thinks this way, on Bia's plan; Dev takes all of it.
    const setup = { ...ANA_CLAUDE(w.mac), model: null, effort: null, autonomy: "never" };
    expect(await applyAgentSetup(deps, fx.owner.id, fx.org.id, { setup, agentIds: [w.zoe, w.dev] })).toEqual([
      { agentId: w.zoe, status: "same", autonomy: { from: "low_risk_auto", to: "never" } },
      { agentId: w.dev, status: "applied", autonomy: { from: "low_risk_auto", to: "never" } },
    ]);
    expect(await w.stored()).toMatchObject({ account: ANAS, autonomy: "never" });
    // Zoe alone: her Autonomia changes, the setup new agents start with doesn't.
    await applyAgentSetup(deps, fx.owner.id, fx.org.id, { setup: { ...setup, autonomy: "always" }, agentIds: [w.zoe] });
    expect(await w.row(w.zoe)).toMatchObject({ brainAccountId: BIAS, missionCommandApproval: "always" });
    expect(await w.stored()).toMatchObject({ account: ANAS, autonomy: "never" });
  });

  test("only where the person may set it by hand: a member on their own agents, an admin on anyone's", async () => {
    const w = await world();
    const { fx, deps, bia, caio } = w;
    const glm = {
      brain: "claude_code",
      machineId: w.mac,
      account: BIAS,
      model: null,
      effort: "high",
      autonomy: "never",
    };
    expect(await applyAgentSetup(deps, bia.id, fx.org.id, { setup: glm, agentIds: [w.dev, w.zoe] })).toEqual([
      { agentId: w.dev, status: "skipped", reason: "not_allowed" },
      { agentId: w.zoe, status: "applied", autonomy: { from: "low_risk_auto", to: "never" } },
    ]);
    expect(await w.row(w.dev)).toMatchObject({ missionCommandApproval: null });
    expect(await w.row(w.zoe)).toMatchObject({ missionCommandApproval: "never" });
    const api = { brain: "model", model: "claude-opus-5-5", autonomy: "always" };
    expect(await applyAgentSetup(deps, caio.id, fx.org.id, { setup: api, agentIds: [w.zoe] })).toEqual([
      { agentId: w.zoe, status: "applied", autonomy: { from: "never", to: "always" } },
    ]);
    expect(await w.row(w.zoe)).toMatchObject({ missionCommandApproval: "always" });
    // Bia's own agent takes it even where its AI can't; Ana's takes nothing from her.
    const onPc = { brain: "claude_code", machineId: w.pc, account: null, autonomy: "never" };
    expect(await applyAgentSetup(deps, bia.id, fx.org.id, { setup: onPc, agentIds: [w.dev, w.zoe] })).toEqual([
      { agentId: w.dev, status: "skipped", reason: "not_allowed" },
      {
        agentId: w.zoe,
        status: "skipped",
        reason: "other_computer",
        params: { computer: "MacBook" },
        autonomy: { from: "always", to: "never" },
      },
    ]);
    expect(await w.row(w.dev)).toMatchObject({ missionCommandApproval: null });
    await expect(
      applyAgentSetup(deps, caio.id, fx.org.id, { setup: { ...api, autonomy: "sometimes" }, agentIds: [w.zoe] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("a new agent starts with an Autonomia only from an admin or its own owner", async () => {
    const w = await world();
    const { fx, bia } = w;
    await fx.db
      .update(schema.orgRoles)
      .set({ permissions: sql`array_append(${schema.orgRoles.permissions}, 'create_agents')` })
      .where(and(eq(schema.orgRoles.orgId, fx.org.id), eq(schema.orgRoles.kind, "everyone")));
    const make = (by: string, handle: string, ownerUserId?: string | null) =>
      createAgent(
        fx.db,
        by,
        fx.org.id,
        {
          name: handle,
          handle,
          model: "claude-haiku-5-5",
          ...(ownerUserId !== undefined ? { ownerUserId } : {}),
          autonomy: "never",
        },
        NEW_AGENT_DEFAULTS,
        { remember: true },
      );
    expect((await make(bia.id, "ivo")).missionCommandApproval).toBe("never");
    // Someone else's agent, or nobody's: she couldn't set it there by hand.
    await expect(make(bia.id, "rui", fx.owner.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(make(bia.id, "lua", null)).rejects.toBeInstanceOf(ForbiddenError);
    const eva = await make(fx.owner.id, "eva", bia.id);
    expect(eva.missionCommandApproval).toBe("never");
    const [created] = await fx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "agent.created"), eq(schema.auditLog.targetId, eva.id)));
    expect(created?.details).toMatchObject({ autonomy: "never" });
    // Created on a model picked, it is the last setup, with its Autonomia.
    expect(await w.stored()).toMatchObject({ model: "claude-haiku-5-5", autonomy: "never" });
  });
});

test("a proposed agent's role may say what it does in full, not a word or two", async () => {
  // The tools depend on whose run it is (the right hand gets one more, ADR 0137): an ordinary agent's.
  const fx = await setup();
  f = fx;
  const tools = await createSetupToolSource({}).tools({
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
  } as ToolContext);
  const props = tools.find((t) => t.name === PROPOSE_AGENT_TOOL)?.inputSchema.properties as
    | Record<string, { maxLength?: number; description?: string }>
    | undefined;
  expect(props?.role?.maxLength).toBe(200);
  expect(props?.role?.description).not.toMatch(/few words|Designer\)/);
});
