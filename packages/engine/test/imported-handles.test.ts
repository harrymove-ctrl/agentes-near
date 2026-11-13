import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import { addChannelMember, agentsByHandle, createAgent, currentHandles, drainOutbox, postPersonMessage } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

/** Nina's id in OpenBot.run; an import made it her handle, cut to 32 characters, until migration 0132 named her. */
const KEY = "agent-e9665a97-c8d5-423f-ae59-25c1d0a1b2c3";
const OLD = "agent-e9665a97-c8d5-423f-ae59-25";

/** Nina as an OpenBot.run import left her after migration 0132: `@nina`, the other app's id kept by the import. */
async function importedNina() {
  const nina = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Nina", handle: "nina", role: "Backend", instructions: "", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.insert(schema.importItems).values({
    orgId: f.org.id,
    sourceApp: "openbotrun",
    sourceRef: "grok-bot",
    kind: "agent",
    key: KEY,
    targetId: nina.id,
    hash: "h",
    createdByUserId: f.owner.id,
  });
  return nina;
}

test("a new agent can't take an id-shaped handle, so an imported agent's old one stays its own", async () => {
  f = await setup();
  await importedNina();
  const made = createAgent(f.db, f.owner.id, f.org.id, { name: "Other", handle: OLD }, { model: "claude-sonnet-5-5" });
  await expect(made).rejects.toThrow("look like an id");
  expect(await currentHandles(f.db, f.org.id, [OLD])).toEqual(["nina"]);
});

const runsOf = async (agentId: string) =>
  f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agentId));

test("an imported agent's old handle names it again; any other handle stays as written", async () => {
  f = await setup();
  await importedNina();
  const unknown = "agent-11111111-2222-3333-4444-55";
  expect(await currentHandles(f.db, f.org.id, [OLD, "dev", unknown])).toEqual(["nina", "dev", unknown]);
  // An agent that has that handle as its own (made before such handles were refused) keeps it.
  await f.db.update(schema.agents).set({ handle: OLD }).where(eq(schema.agents.id, f.agent.id));
  expect(await currentHandles(f.db, f.org.id, [OLD])).toEqual([OLD]);
});

test("a tool's agents by handle: the old handle finds the agent, and each input says which one it named", async () => {
  f = await setup();
  const nina = await importedNina();
  const named = await agentsByHandle(f.db, f.org.id, [`@${OLD}`, "@Dev "]);
  expect(named.missing).toEqual([]);
  expect(named.rowOf(`@${OLD}`)?.id).toBe(nina.id);
  expect(named.rowOf("dev")?.id).toBe(f.agent.id);
  expect(named.rowOf("@nobody")).toBeUndefined();
});

test("a person's @ with the old handle reaches the agent", async () => {
  f = await setup({ reply: () => ({ chunks: ["ok"] }) });
  const nina = await importedNina();
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: nina.id });
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: `@${OLD} pode olhar o #12?`,
  });
  expect(message.mentionedAgentIds).toEqual([nina.id]);
  await drainOutbox(f.db, f.handlers);
  expect((await runsOf(nina.id)).map((r) => r.status)).toEqual(["done"]);
});

test("tell_agent with the old handle reaches the agent, and the run is told the handle it has now", async () => {
  const requests: ModelRequest[] = [];
  f = await setup({
    askAgent: true,
    reply: (req) => {
      requests.push(req);
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Avisei."] };
      if (systemText(req.system).includes("A private conversation between agents")) return { chunks: ["ok"] };
      return {
        chunks: [],
        toolUses: [{ name: "tell_agent", input: { agent: `@${OLD}`, message: "O #12 precisa de revisão." } }],
      };
    },
  });
  const nina = await importedNina();
  // Written before the rename, like the routines and notes that still cite it.
  await f.db
    .update(schema.agents)
    .set({ instructions: `Backend work goes to @${OLD}.` })
    .where(eq(schema.agents.id, f.agent.id));
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev avisa o backend do #12",
  });
  await drainOutbox(f.db, f.handlers);
  expect(await runsOf(nina.id)).toHaveLength(1);
  const told = systemText(requests[0]?.system ?? []);
  expect(told).toContain(
    `# Renamed agents\nSome text here names agents by a handle they had before: @${OLD} is @nina.`,
  );
});
