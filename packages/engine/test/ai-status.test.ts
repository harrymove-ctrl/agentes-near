import { afterEach, describe, expect, test } from "bun:test";
import { envPlatformCredentials, noPlatformCredentials, ROUTE_PROTOCOL } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type AiRouting,
  agentAiState,
  createAgent,
  createCredential,
  createJevKey,
  createModelGateway,
  type JobDeps,
  type MachineCaller,
  type MachineStatus,
  messageRouter,
  orgAiStatus,
  orgHasAi,
  orgRouting,
  type RoutingSetup,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * ADR 0061 §1: whether an agent has an AI to think with — a key for its model brain (`auto` checked for
 * the provider its runs would pick), or its computer brain (signed out, missing or no computer: `no_ai`
 * unless it may fall back; away: `waiting`) — and whether the organization has any. No key is decrypted.
 */

let f: Fixture;
afterEach(() => f?.close());

const statusOf = (over: Partial<MachineStatus> = {}): MachineStatus => ({
  id: "m1",
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: 8,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
  ...over,
});

const revokeKeys = () => f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });

test("a model brain: ready with a key of its provider, no_ai without; no key is decrypted", async () => {
  f = await setup();
  const deps = { db: f.db, gateway: f.gateway };
  expect(await agentAiState(deps, f.agent)).toEqual({ state: "ready" });
  // A gateway that can't decrypt anything (no key wrapper) still sees the key: it only checks the row exists.
  const sealed = createModelGateway({
    db: f.db,
    keyWrappers: [],
    providers: { anthropic: f.provider },
    platformCredentials: noPlatformCredentials,
  });
  expect(await agentAiState({ db: f.db, gateway: sealed }, f.agent)).toEqual({ state: "ready" });
  // The agent's own key is from another provider than its model: nothing resolves (like the gateway).
  const openai = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "openai",
    label: "oa",
    apiKey: "sk-proj-test-key-12345678",
  });
  expect(await agentAiState(deps, { ...f.agent, credentialId: openai.id })).toEqual({
    state: "no_ai",
    reason: "no_key",
  });
  await revokeKeys();
  expect(await agentAiState(deps, f.agent)).toEqual({ state: "no_ai", reason: "no_key" });
  // The platform's key (the Cloud) counts, without being fetched.
  const platform = createModelGateway({
    db: f.db,
    keyWrappers: [],
    providers: { anthropic: f.provider },
    platformCredentials: envPlatformCredentials({ anthropic: { apiKey: "sk-ant-platform-1234" } }),
  });
  expect(await agentAiState({ db: f.db, gateway: platform }, { ...f.agent, credentialId: null })).toEqual({
    state: "ready",
  });
});

test("auto: the provider its runs would pick decides, with or without a key", async () => {
  f = await setup();
  const deps = { db: f.db, gateway: f.gateway };
  // `auto` isn't in the catalog: before, every new agent read as "no AI". Ready, it names the maker of the key it
  // thinks with, which the apps say instead of "Automático".
  const claude = { state: "ready", provider: "anthropic" } as const;
  expect(await agentAiState(deps, { ...f.agent, model: "auto" })).toEqual(claude);
  expect(await agentAiState(deps, { ...f.agent, model: "auto", credentialId: null })).toEqual(claude);
  await revokeKeys();
  expect(await agentAiState(deps, { ...f.agent, model: "auto", credentialId: null })).toEqual({
    state: "no_ai",
    reason: "no_key",
  });
  // Only an OpenAI key: an auto agent thinks with OpenAI's line.
  await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "openai",
    label: "oa",
    apiKey: "sk-proj-test-key-12345678",
  });
  expect(await agentAiState(deps, { ...f.agent, model: "auto", credentialId: null })).toEqual({
    state: "ready",
    provider: "openai",
  });
});

test("a computer brain: signed out, missing or no computer is no_ai unless it may fall back; away is waiting", async () => {
  f = await setup();
  let status: MachineStatus | null = statusOf();
  const deps = { db: f.db, gateway: f.gateway, machines: { status: async () => status } };
  const computer = { ...f.agent, brain: "claude_code", machineId: "m1" };
  expect(await agentAiState(deps, computer)).toEqual({ state: "ready" });

  status = statusOf({ executors: { claude: { version: "2.1.300", loggedIn: false } } });
  // The model brain stands in (ADR 0032 §5)…
  expect(await agentAiState(deps, computer)).toEqual({ state: "ready" });
  // …unless the owner turned the fallback off, or it's background work. With no account of its own, it's the
  // computer's own sign-in of Claude Code that isn't there.
  const ownOut = { state: "no_ai", reason: "not_signed_in", own: "claude_code" } as const;
  expect(await agentAiState(deps, { ...computer, brainFallback: false })).toEqual(ownOut);
  const routine = {
    id: crypto.randomUUID(),
    orgId: f.org.id,
    agentId: f.agent.id,
    threadRootId: "0193dddd-0000-4000-8000-0000000000aa",
    triggerMessageId: "0193dddd-0000-4000-8000-0000000000aa",
    background: true,
  };
  expect(await agentAiState(deps, computer, routine)).toEqual(ownOut);

  await revokeKeys();
  expect(await agentAiState(deps, computer)).toEqual(ownOut);
  status = statusOf({ executors: { detectedAt: new Date().toISOString() } });
  expect(await agentAiState(deps, computer)).toEqual({ state: "no_ai", reason: "cli_missing" });
  expect(await agentAiState(deps, { ...computer, brain: "codex" })).toEqual({ state: "no_ai", reason: "cli_missing" });
  expect(await agentAiState(deps, { ...computer, machineId: null })).toEqual({ state: "no_ai", reason: "no_computer" });
  // Offline or paused is "not now": the existing waiting card, not "no AI".
  status = statusOf({ online: false });
  expect(await agentAiState(deps, computer)).toEqual({ state: "waiting" });
});

test("the computer's own sign-in on a computer nobody connected (the workspace's): not signed in, never a wait", async () => {
  f = await setup();
  await revokeKeys();
  const executors = {
    claude: { version: "2.1.300", loggedIn: true },
    codex: { version: "codex-cli 0.163.0" },
    detectedAt: new Date().toISOString(),
  };
  let status = statusOf({ kind: "managed", pairedByUserId: null, executors });
  const deps = { db: f.db, gateway: f.gateway, machines: { status: async () => status } };
  const agent = { ...f.agent, brain: "codex", machineId: "m1" };
  expect(await agentAiState(deps, agent)).toEqual({ state: "no_ai", reason: "not_signed_in", own: "codex" });
  // Whatever the CLI says there: no person signs in at that computer's terminal for an agent.
  expect(await agentAiState(deps, { ...agent, brain: "claude_code" })).toEqual({
    state: "no_ai",
    reason: "not_signed_in",
    own: "claude_code",
  });
  // Offline too: its coming back would sign nothing in.
  status = { ...status, online: false };
  expect(await agentAiState(deps, agent)).toEqual({ state: "no_ai", reason: "not_signed_in", own: "codex" });
  // A computer someone connected: its own sign-in can think (a turn finds out if it can't).
  status = statusOf({ pairedByUserId: f.owner.id, executors });
  expect(await agentAiState(deps, agent)).toEqual({ state: "ready" });
});

test("the organization: any agent ready or waiting; archived ones don't count", async () => {
  f = await setup();
  let status: MachineStatus | null = statusOf({ online: false });
  const deps = { db: f.db, gateway: f.gateway, machines: { status: async () => status } };
  expect(await orgAiStatus(deps, f.org.id)).toEqual({ any: true, agents: [{ agentId: f.agent.id, state: "ready" }] });

  await revokeKeys();
  const other = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", role: "Ops", instructions: "" },
    { model: "auto" },
  );
  expect(await orgAiStatus(deps, f.org.id)).toEqual({
    any: false,
    agents: [
      { agentId: f.agent.id, state: "no_ai", reason: "no_key" },
      { agentId: other.id, state: "no_ai", reason: "no_key" },
    ],
  });
  expect(await orgHasAi(deps, f.org.id)).toBe(false);

  // A computer that's asleep is not "no AI".
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  await f.db
    .update(schema.agents)
    .set({ brain: "claude_code", machineId: paired.machineId })
    .where(eq(schema.agents.id, other.id));
  expect((await orgAiStatus(deps, f.org.id)).agents[1]).toEqual({ agentId: other.id, state: "waiting" });
  expect(await orgHasAi(deps, f.org.id)).toBe(true);

  status = statusOf({ executors: { claude: { version: "2.1.300", loggedIn: false } } });
  expect(await orgHasAi(deps, f.org.id)).toBe(false);
  await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, other.id));
  expect(await orgAiStatus(deps, f.org.id)).toEqual({
    any: false,
    agents: [{ agentId: f.agent.id, state: "no_ai", reason: "no_key" }],
  });
});

describe("who picks the agents (ADR 0074)", () => {
  /** The router as `message.posted` builds it, on a computer hub that reports `status`. */
  const routingOf = (over: Partial<NonNullable<JobDeps["router"]>>, status: Partial<MachineStatus> = {}) => {
    const hub = {
      status: async (id: string) => statusOf({ id, protocol: ROUTE_PROTOCOL, ...status }),
      call: async () => Promise.reject(new Error("not asked")),
    } as unknown as Pick<MachineCaller, "call" | "status">;
    return (
      messageRouter({
        ...f.jobDeps,
        router: {
          enabled: true,
          model: "claude-haiku-5-5",
          plans: { hub, publicUrl: "http://localhost:3000" },
          ...over,
        },
      })?.routing ?? null
    );
  };
  const who = (routing: RoutingSetup | null, userId = f.owner.id) =>
    orgRouting({ db: f.db, gateway: f.gateway }, routing, f.org.id, userId);

  /** Ana's own Claude account on her computer, lent to Dev; no API key; Bruna in the workspace. */
  async function plans() {
    await revokeKeys();
    const bruna = await addMember(f.db, f.org.id, "member", "Bruna");
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Mac" });
    const accountId = crypto.randomUUID();
    await f.db.insert(schema.machineAccounts).values({
      id: accountId,
      orgId: f.org.id,
      machineId,
      kind: "claude_code",
      label: "Trabalho",
      createdBy: f.owner.id,
    });
    await f.db
      .update(schema.agents)
      .set({ brain: "claude_code", machineId, brainAccountId: accountId })
      .where(eq(schema.agents.id, f.agent.id));
    return { bruna, accountId };
  }

  test("Jev, while its owner sees it working; a small model; off", async () => {
    f = await setup();
    let clock = Date.now();
    const key = createJevKey({
      db: f.db,
      keyWrapper: f.keyWrapper,
      keyWrappers: [f.keyWrapper],
      envKey: "ts_env_key",
      now: () => clock,
    });
    const jev = routingOf({ jev: { key } });
    const jevLine: AiRouting = { by: "jev", mine: "jev", model: null, noSmallModel: null };
    expect(await who(jev)).toEqual({ apiKey: true, routing: jevLine });
    // Three outages in a row skip Jev for a minute: no screen says so.
    for (const _ of [1, 2, 3]) key.report("down");
    expect(key.usable()).toBe(false);
    expect((await who(jev)).routing).toEqual(jevLine);
    key.report("no_credit");
    expect((await who(jev)).routing).toEqual({
      by: "model",
      mine: "model",
      model: "claude-haiku-5-5",
      noSmallModel: null,
    });
    clock += 1;
    expect(await who(null)).toEqual({
      apiKey: true,
      routing: { by: "off", mine: "off", model: null, noSmallModel: null },
    });
  });

  test("plans: the owner's own, a teammate gets the rules; coding plans, offline and old computers don't count", async () => {
    f = await setup();
    const { bruna, accountId } = await plans();
    const routing = routingOf({});
    expect(await who(routing)).toEqual({
      apiKey: false,
      routing: { by: "plans", mine: "plan", model: null, noSmallModel: null },
    });
    expect((await who(routing, bruna.id)).routing).toMatchObject({ by: "plans", mine: "rules" });
    expect((await who(routingOf({}, { online: false }))).routing).toMatchObject({ by: "rules", mine: "rules" });
    expect((await who(routingOf({}, { protocol: ROUTE_PROTOCOL - 1 }))).routing.by).toBe("rules");
    // The runner refuses routes on Windows, and with that CLI switched off.
    expect((await who(routingOf({}, { os: "windows" }))).routing).toMatchObject({ by: "rules", mine: "rules" });
    const off = { folders: [], tools: { claude: false, codex: true, commands: true } };
    expect((await who(routingOf({}, { access: off }))).routing).toMatchObject({ by: "rules", mine: "rules" });
    // The Cloud: never a plan.
    const cloud = routingOf({
      plans: {
        hub: { status: async () => null, call: async () => null } as never,
        publicUrl: "https://app.agentes.chat",
      },
    });
    expect((await who(cloud)).routing.by).toBe("rules");
    await f.db.update(schema.machineAccounts).set({ provider: "zai" }).where(eq(schema.machineAccounts.id, accountId));
    expect((await who(routing)).routing).toMatchObject({ by: "rules", mine: "rules" });
  });

  test("the computer's own sign-in counts only when made with a plan", async () => {
    f = await setup();
    await plans();
    await f.db.update(schema.agents).set({ brainAccountId: null }).where(eq(schema.agents.id, f.agent.id));
    const signedIn = (authMethod: string) => ({
      executors: { claude: { version: "2.1.311", loggedIn: true, authMethod }, detectedAt: new Date().toISOString() },
    });
    expect((await who(routingOf({}, signedIn("claude.ai")))).routing.mine).toBe("plan");
    expect((await who(routingOf({}, signedIn("api_key")))).routing.mine).toBe("rules");
  });

  test("a Kimi key alone: the rules, and why", async () => {
    f = await setup();
    await revokeKeys();
    await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "moonshot",
      label: "kimi",
      apiKey: "sk-kimi-test-key-123456",
      makeDefault: true,
    });
    expect(await who(routingOf({}))).toEqual({
      apiKey: true,
      routing: { by: "rules", mine: "rules", model: null, noSmallModel: "moonshot" },
    });
  });
});
