import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import {
  addChannelMember,
  archiveAgent,
  type Brain,
  computerPrompt,
  createAgent,
  createJobHandlers,
  drainOutbox,
  listAgents,
  listRoles,
  type MachineStatus,
  postPersonMessage,
  updateRole,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(() => f?.close());

const post = (body: string, threadId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });
const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);

const addAgent = (name: string, handle: string, role: string, instructions = "") =>
  createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, role, instructions, credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );

/** @infra in #general, then archived: archiving leaves its memberships. */
async function archivedInfra() {
  const infra = await addAgent("Infra", "infra", "Infrastructure", "Cuida do deploy.");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: infra.id });
  await archiveAgent(f.db, f.owner.id, f.org.id, infra.id);
  return infra;
}

/** @dev calls one tool on "go", then answers "done"; every tool result it reads is kept. */
function callsTool(name: string, input: Record<string, unknown>, results: string[]) {
  return (req: ModelRequest): FakeReply => {
    const last = lastText(req);
    if (last.includes("tool_result")) {
      results.push(last);
      return { chunks: ["done"] };
    }
    return last.includes("go") ? { chunks: [], toolUses: [{ name, input }] } : { chunks: ["ok"] };
  };
}

const runsOf = async (agentId: string) =>
  f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agentId));

test("an archived agent still in the channel is in no roster a run reads", async () => {
  const requests: ModelRequest[] = [];
  f = await setup({
    askAgent: true,
    reply: (req) => {
      requests.push(req);
      return { chunks: ["ok"] };
    },
  });
  await addAgent("Design", "design", "Designer");
  await archivedInfra();
  await post("@dev oi");
  await drainOutbox(f.db, f.handlers);

  const prompt = systemText(requests[0]?.system ?? []);
  expect(prompt).toContain("Members: ana (@ana, person), Dev (@dev, agent).");
  expect(prompt).toContain("Other agents in this organization: @design (Designer).");
  expect(prompt).not.toContain("@infra");
});

test("find_agent leaves an archived agent out", async () => {
  const results: string[] = [];
  f = await setup({ askAgent: true, reply: callsTool("find_agent", {}, results) });
  await addAgent("Design", "design", "Designer");
  await archivedInfra();
  await post("@dev go");
  await drainOutbox(f.db, f.handlers);

  expect(results[0]).toContain("@design: Design, Designer");
  expect(results[0]).not.toContain("@infra");
});

for (const [tool, input] of [
  ["ask_agent", { agent: "@infra", question: "Como é o deploy de staging?" }],
  ["tell_agent", { agent: "@infra", message: "O deploy terminou." }],
] as const) {
  test(`${tool} refuses an archived agent and says so`, async () => {
    const results: string[] = [];
    f = await setup({ askAgent: true, reply: callsTool(tool, input, results) });
    const infra = await archivedInfra();
    await post("@dev go");
    await drainOutbox(f.db, f.handlers);

    expect(results[0]).toContain(
      "@infra is archived: nothing you send reaches it. Don't try it again. If the work needs it, tell the person.",
    );
    expect(await f.db.select().from(schema.agentConsultations)).toHaveLength(0);
    expect(await runsOf(infra.id)).toHaveLength(0);
  });
}

test("an unknown handle is answered with the closest handles of the agents here", async () => {
  const results: string[] = [];
  f = await setup({
    askAgent: true,
    reply: callsTool("ask_agent", { agent: "@infra-acme", question: "Pode fazer o deploy?" }, results),
  });
  await addAgent("QA", "qa", "Testes");
  await addAgent("Infra", "infra", "Infrastructure");
  await addAgent("Design", "design", "Designer");
  await post("@dev go");
  await drainOutbox(f.db, f.handlers);

  expect(results[0]).toContain("No agent @infra-acme here. Closest handles: @infra, @qa, @design.");
});

test("the closest handles leave out the agents the person behind the run can't talk to", async () => {
  const results: string[] = [];
  f = await setup({
    askAgent: true,
    reply: callsTool("ask_agent", { agent: "@infra-acme", question: "Pode fazer o deploy?" }, results),
  });
  await addAgent("QA", "qa", "Testes");
  await addAgent("Infra", "infra", "Infrastructure");
  await addAgent("Design", "design", "Designer");
  // Bia's roles don't let her talk to agents: only @dev, which she owns, still answers her.
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
  const base = (await listRoles(f.db, f.owner.id, f.org.id)).roles.find((r) => r.kind === "everyone");
  if (!base) throw new Error("no base role");
  await updateRole(f.db, f.owner.id, f.org.id, base.id, {
    permissions: base.permissions.filter((k) => k !== "talk_to_agents"),
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, { body: "@dev go" });
  await drainOutbox(f.db, f.handlers);

  expect(results[0]).toContain("No agent @infra-acme here.");
  expect(results[0]).not.toContain("Closest handles");
});

test("the agents the @ pickers list leave an archived one out", async () => {
  f = await setup();
  await addAgent("Design", "design", "Designer");
  await archivedInfra();

  expect((await listAgents(f.db, f.owner.id, f.org.id)).map((a) => a.handle)).toEqual(["dev", "design"]);
});

test("a computer brain's resumed session reads the archived line in its turn", async () => {
  f = await setup();
  await archivedInfra();
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    os: "darwin",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  await f.db.update(schema.agents).set({ machineId, brain: "claude_code" }).where(eq(schema.agents.id, f.agent.id));
  const status = (id: string): MachineStatus => ({
    id,
    orgId: f.org.id,
    name: "MacBook",
    online: true,
    execAllowed: true,
    os: "darwin",
    protocol: 8,
    executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
  });
  const turns: { prompt: string; resume: boolean }[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      turns.push({ prompt: computerPrompt(turn), resume: Boolean(turn.session?.resume) });
      yield { type: "usage", input: 40, output: 5, source: "plan", model: "claude-sonnet-5-5" };
      yield { type: "done", text: "ok" };
    },
  };
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => status(id) },
  });
  const first = await post("@dev oi");
  await drainOutbox(f.db, handlers);
  await post("@dev pede o deploy ao @infra", first.id);
  await drainOutbox(f.db, handlers);

  // A live session keeps the system prompt it started with: only "# This turn" reaches it.
  expect(turns.map((t) => t.resume)).toEqual([false, true]);
  expect(turns[1]?.prompt).toContain("## Archived agents\n@infra is archived: nothing you send reaches it.");
});

test("an agent's message that mentions an archived agent starts no run for it", async () => {
  f = await setup({ reply: () => ({ chunks: ["@infra pode fazer o deploy de staging?"] }) });
  const infra = await archivedInfra();
  await post("@dev pede o deploy");
  await drainOutbox(f.db, f.handlers);

  const [reply] = await f.db.select().from(schema.messages).where(eq(schema.messages.authorAgentId, f.agent.id));
  expect(reply?.body).toBe("@infra pode fazer o deploy de staging?");
  expect(reply?.mentionedAgentIds).toEqual([]);
  expect(await runsOf(infra.id)).toHaveLength(0);
});

test("instructions that name an archived agent come with a line that it is archived", async () => {
  const requests: ModelRequest[] = [];
  f = await setup({
    reply: (req) => {
      requests.push(req);
      return { chunks: ["ok"] };
    },
  });
  await archivedInfra();
  await f.db
    .update(schema.agents)
    .set({ instructions: "Para deploy, peça ao @infra." })
    .where(eq(schema.agents.id, f.agent.id));
  await post("@dev faz o deploy");
  await drainOutbox(f.db, f.handlers);

  expect(systemText(requests[0]?.system ?? [])).toContain(
    "# Archived agents\n@infra is archived: nothing you send reaches it. Don't ask or mention it. If your instructions, notes or this conversation count on it, tell the person.",
  );
});

test("a person who holds an archived agent's handle now is not called archived", async () => {
  const requests: ModelRequest[] = [];
  f = await setup({
    reply: (req) => {
      requests.push(req);
      return { chunks: ["ok"] };
    },
  });
  await archivedInfra();
  await f.db
    .update(schema.organizationMembers)
    .set({ handle: "infra" })
    .where(eq(schema.organizationMembers.userId, f.owner.id));
  await post("@dev pergunta ao @infra");
  await drainOutbox(f.db, f.handlers);

  expect(systemText(requests[0]?.system ?? [])).not.toContain("# Archived agents");
});
