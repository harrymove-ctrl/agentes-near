import { afterEach, expect, test } from "bun:test";
import { countQueries, eq, inArray, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  agentScopeNames,
  createAgent,
  createCredential,
  drainOutbox,
  enableCaches,
  insertMessage,
  type MachineStatus,
  NO_PERSON,
  postPersonMessage,
  rosterScopeNames,
  summarizeScopes,
  teamPrompt,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(() => f?.close());

const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });

const addAgent = (name: string, handle: string, role: string, instructions = "") =>
  createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, role, instructions, credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );

test("a big team is only a count with a pointer to find_agent", () => {
  const team = Array.from({ length: 20 }, (_, i) => ({
    id: `a${i}`,
    name: `A${i}`,
    handle: `a${i}`,
    role: "",
    instructions: "",
    ownerUserId: null,
    audienceMode: "everyone" as const,
    audienceUserIds: [],
    audienceRoleIds: [],
    consultable: true,
    brain: "model",
    autonomyBrakes: {},
    reportsToAgentId: null,
  }));
  const text = teamPrompt(team, "a0", null, new Set(), NO_PERSON);
  expect(text).toContain("19 other agents work in this organization.");
  expect(text).not.toContain("@a1");
  // Who to ask and who to hand work to, and that what comes of either comes back by itself (ADR 0095).
  expect(text).toContain(
    "When you need another agent's answer for the task, ask it with `ask_agent`; to hand one work, use `tell_agent`, giving the whole job to the agent that owns it with everything it needs. Do this instead of saying you can't or sending the person to it. Either way the call returns at once and what comes of it reaches you here by itself.",
  );
});

test("an agent knows the org's other agents it can work with, even outside its channels", async () => {
  const requests: ModelRequest[] = [];
  f = await setup({
    askAgent: true,
    reply: (req) => {
      requests.push(req);
      return { chunks: ["ok"] };
    },
  });
  await addAgent("Infra", "infra", "Infrastructure");
  const qa = await addAgent("QA", "qa", "Testes");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: qa.id });
  // Nobody can talk to this one: it never shows up.
  const hidden = await addAgent("Secret", "secret", "Finance");
  await f.db
    .update(schema.agents)
    .set({ audienceMode: "owner", ownerUserId: null, consultable: false })
    .where(eq(schema.agents.id, hidden.id));

  await post("@dev oi");
  await drainOutbox(f.db, f.handlers);

  const prompt = systemText(requests[0]?.system ?? []);
  expect(prompt).toContain("# Your team\nOther agents in this organization: @infra (Infrastructure).");
  expect(prompt).toContain("`find_agent`");
  expect(prompt).not.toContain("@secret");
  // QA is a channel member: described in "Where you are", not repeated in the team.
  expect(prompt).not.toMatch(/Other agents in this organization:[^\n]*@qa/);
});

test("an agent reads how its teammates are now, not what older messages say: no AI yet, busy, or ready when called", async () => {
  const requests: ModelRequest[] = [];
  f = await setup({
    askAgent: true,
    reply: (req) => {
      requests.push(req);
      return { chunks: ["ok"] };
    },
  });
  const rui = await addAgent("Rui", "rui", "Backend");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: rui.id });
  // Her card from before she had an AI is still in the channel.
  await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId: rui.id, runId: null, hop: 0, stretchId: null },
    body: "I can't answer yet: I have no AI connected.",
    meta: { bodyCode: "no_ai" },
  });
  // On heavy work now: a run going for five minutes.
  await f.db.insert(schema.agentRuns).values({
    orgId: f.org.id,
    agentId: rui.id,
    channelId: f.general.id,
    threadRootId: crypto.randomUUID(),
    triggerMessageId: crypto.randomUUID(),
    trigger: "mention",
    hop: 0,
    status: "running",
    startedAt: new Date(Date.now() - 5 * 60_000),
    heartbeatAt: new Date(),
  });
  // Otto's own key was revoked: he has no AI.
  const key = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "anthropic",
    label: "otto",
    apiKey: "sk-ant-test-key-otto-5678",
  });
  await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Otto", handle: "otto", role: "Front", instructions: "", credentialId: key.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db
    .update(schema.providerCredentials)
    .set({ revokedAt: new Date() })
    .where(eq(schema.providerCredentials.id, key.id));
  // Lia has an AI and hasn't worked for a while: idle, which for an agent means a mention wakes her at once.
  await addAgent("Lia", "lia", "Revisora de código");

  await post("@dev o Rui e o Otto já têm IA?");
  await drainOutbox(f.db, f.handlers);

  const prompt = systemText(requests[0]?.system ?? []);
  expect(prompt).toContain("# Your teammates now\n");
  expect(prompt).toContain("@rui: busy, on heavy work");
  expect(prompt).toContain("@otto: no AI connected yet");
  expect(prompt).toContain("- @lia: has an AI, answers when called\n");
  expect(prompt).not.toMatch(/@[a-z]+: away/);
  expect(prompt).toContain("This is how they are now: it outweighs what older messages here say about them");
});

test("find_agent searches by what agents do and shows what they can do", async () => {
  const results: string[] = [];
  f = await setup({
    askAgent: true,
    reply: (req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) {
        results.push(last);
        return { chunks: ["done"] };
      }
      return { chunks: [], toolUses: [{ name: "find_agent", input: { query: "deploy de staging" } }] };
    },
  });
  await addAgent("Infra", "infra", "Infrastructure", "Cuida dos servidores e do deploy no Railway.");
  await addAgent("Design", "design", "Designer", "Faz telas e protótipos.");

  await post("@dev quem faz deploy?");
  await drainOutbox(f.db, f.handlers);

  const out = results[0] ?? "";
  expect(out).toContain("@infra: Infra, Infrastructure");
  expect(out).toContain("Files (Drive)");
  expect(out).toContain("Responsible person:");
  expect(out).not.toContain("@design");
  expect(out).not.toContain("@dev:");
});

test("a whole-connection grant is named after its connector, not 'Connector'", async () => {
  f = await setup();
  const [conn] = await f.db
    .insert(schema.connectorConnections)
    .values({
      orgId: f.org.id,
      connector: "sentry",
      label: "Sentry",
      toolPrefix: "sentry",
      serverUrl: "https://mcp.sentry.dev",
      authType: "none",
    })
    .returning();
  await f.db
    .insert(schema.agentScopes)
    .values({ orgId: f.org.id, agentId: f.agent.id, connectionId: conn?.id ?? null, scope: "connector:*" });
  const names = await agentScopeNames(f.db, f.org.id, [f.agent.id]);
  expect(names.map((n) => n.scope)).toContain("sentry:*");
  expect(names.map((n) => n.scope)).not.toContain("connector:*");
});

test("another agent's computer, browser and desktop are stated only where its computer serves them", async () => {
  f = await setup();
  // Granted to every new agent.
  const qa = await addAgent("QA", "qa", "Testes");
  const roster = async (machines?: { status(id: string): Promise<MachineStatus | null> }) =>
    summarizeScopes((await rosterScopeNames(f.db, machines, f.org.id, [qa.id])).map((s) => s.scope));
  const none = await roster();
  expect(none).toContain("Files (Drive)");
  expect(none).not.toMatch(/Code|Browser|Desktop/);

  // A computer whose browser is on and ready, and no desktop use: Code and Browser.
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  await f.db.update(schema.agents).set({ machineId }).where(eq(schema.agents.id, qa.id));
  const served = await roster({
    status: async (id) =>
      id === machineId
        ? {
            id,
            orgId: f.org.id,
            name: "MacBook",
            online: false,
            execAllowed: true,
            os: "darwin",
            protocol: 12,
            executors: { browser: { available: true, version: "0.39.1" } },
            paused: null,
            access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
          }
        : null,
  });
  expect(served).toContain("Code");
  expect(served).toContain("Browser");
  expect(served).not.toContain("Desktop");
});

test("the roster reads a computer once, however many agents share it", async () => {
  f = await setup({ machines: true });
  const ids = (await Promise.all(["qa", "ops", "web"].map((h) => addAgent(h.toUpperCase(), h, "")))).map((a) => a.id);
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  await f.db.update(schema.agents).set({ machineId }).where(inArray(schema.agents.id, ids));
  enableCaches();
  try {
    // A running server has the agents cached.
    await rosterScopeNames(f.db, f.machineHub, f.org.id, ids);
    const { queries } = await countQueries(() => rosterScopeNames(f.db, f.machineHub, f.org.id, ids));
    // Their scopes, the code environment's switch and the computer.
    expect(queries).toBeLessThanOrEqual(3);
  } finally {
    enableCaches(false);
  }
});
