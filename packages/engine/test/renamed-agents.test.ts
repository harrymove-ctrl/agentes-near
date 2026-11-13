import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import {
  addChannelMember,
  archiveAgent,
  assignHandle,
  consolidateItem,
  createAgent,
  currentHandles,
  deleteAgent,
  drainOutbox,
  enableCaches,
  listMembers,
  postPersonMessage,
  refRule,
  resolveParticipants,
  updateAgent,
  updateMyProfile,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { channelRoutine, fire } from "./routine-fixtures";

let f: Fixture;
afterEach(() => f?.close());

const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);

const addAgent = (name: string, handle: string, role: string) =>
  createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, role, credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );

const rename = (agentId: string, name: string, handle: string) =>
  updateAgent(f.db, f.owner.id, f.org.id, agentId, { name, handle });

/** Ada (@ada) in #general, renamed to Claudio (@claudio), as on its page. */
async function renamedAda() {
  const ada = await addAgent("Ada", "ada", "Dev");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ada.id });
  return rename(ada.id, "Claudio", "claudio");
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

const runsOf = (agentId: string) => f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agentId));

describe("a renamed agent's handle", () => {
  test("follows the new name: the one it leaves is kept, and both name it", async () => {
    f = await setup();
    const ada = await addAgent("Ada", "ada", "Dev");
    const claudio = await updateAgent(f.db, f.owner.id, f.org.id, ada.id, { name: "Claudio", handle: "@Claudio " });

    expect(claudio.handle).toBe("claudio");
    expect(claudio.previousHandles).toEqual(["ada"]);
    expect(await currentHandles(f.db, f.org.id, ["ada", "claudio", "dev", "ninguem", "Ada!"])).toEqual([
      "claudio",
      "claudio",
      "dev",
      "ninguem",
      "Ada!",
    ]);
  });

  test("renaming back to the old name gives the old handle back; the other one still names it", async () => {
    f = await setup();
    const claudio = await renamedAda();
    const ada = await rename(claudio.id, "Ada", "ada");

    expect(ada.handle).toBe("ada");
    expect(ada.previousHandles).toEqual(["claudio"]);
    expect(await currentHandles(f.db, f.org.id, ["claudio", "ada"])).toEqual(["ada", "ada"]);
  });

  test("an old handle a person has now is the person's, and an archived agent's old handles name nobody", async () => {
    f = await setup();
    const claudio = await renamedAda();
    const atlas = await addAgent("Atlas", "atlas", "Ops");
    await rename(atlas.id, "Zeus", "zeus");
    // A person's handle set directly, as a workspace from before old handles were kept may have.
    await f.db
      .update(schema.organizationMembers)
      .set({ handle: "ada" })
      .where(eq(schema.organizationMembers.userId, f.owner.id));
    await archiveAgent(f.db, f.owner.id, f.org.id, atlas.id);

    expect(await currentHandles(f.db, f.org.id, ["ada", "atlas", "claudio"])).toEqual(["ada", "atlas", "claudio"]);
    expect(await post("@ada oi")).toMatchObject({ mentionedAgentIds: [] });
    expect(await runsOf(claudio.id)).toHaveLength(0);
  });

  test("a handle another agent has or had, or a person has, is refused with a free one", async () => {
    f = await setup();
    const claudio = await renamedAda();
    const atlas = await addAgent("Atlas", "atlas", "Ops");
    await rename(atlas.id, "Zeus", "zeus");
    const ana = (await listMembers(f.db, f.org.id)).find((m) => m.userId === f.owner.id)?.handle;
    expect(ana).toBe("ana");

    for (const [wanted, suggestion] of [
      ["dev", "dev-2"],
      ["atlas", "atlas-2"],
      ["zeus", "zeus-2"],
      ["ana", "ana-2"],
    ]) {
      await expect(rename(claudio.id, "Claudio", wanted as string)).rejects.toMatchObject({
        code: "agent.handle_taken",
        params: { handle: wanted, suggestion },
      });
    }
    // A new agent can't take an old handle either.
    await expect(addAgent("Ada", "ada", "Dev")).rejects.toMatchObject({
      code: "agent.handle_taken",
      params: { handle: "ada", suggestion: "ada-2" },
    });
    // Nor a person.
    await expect(updateMyProfile(f.db, f.owner.id, f.org.id, { handle: "ada" })).rejects.toMatchObject({
      code: "handle.taken_by_agent",
    });
    const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, claudio.id));
    expect(row?.handle).toBe("claudio");
    expect(row?.previousHandles).toEqual(["ada"]);
  });

  test("a person who joins doesn't get an agent's handle, now or before; the old one still reaches the agent", async () => {
    f = await setup();
    const claudio = await renamedAda();
    const adaSouza = await addMember(f.db, f.org.id, "member", "Ada Souza");
    const claudioLima = await addMember(f.db, f.org.id, "member", "Claudio Lima");

    expect(await assignHandle(f.db, f.org.id, adaSouza.id)).toBe("ada-2");
    expect(await assignHandle(f.db, f.org.id, claudioLima.id)).toBe("claudio-2");
    expect(await currentHandles(f.db, f.org.id, ["ada"])).toEqual(["claudio"]);
    expect(await post("@ada oi")).toMatchObject({ mentionedAgentIds: [claudio.id] });
  });

  test("deleting the agent frees the handles it had", async () => {
    f = await setup();
    const claudio = await renamedAda();
    await deleteAgent({ db: f.db, pubsub: f.pubsub, hub: f.machineHub }, f.owner.id, f.org.id, claudio.id);

    expect((await addAgent("Ada", "ada", "Dev")).handle).toBe("ada");
    expect((await addAgent("Claudio", "claudio", "Dev")).handle).toBe("claudio");
  });
});

describe("the old handle still reaches the agent", () => {
  test("a new message that mentions it starts the renamed agent", async () => {
    f = await setup();
    const claudio = await renamedAda();
    const message = await post("@ada o deploy de staging terminou?");

    expect(message.mentionedAgentIds).toEqual([claudio.id]);
    const runs = await runsOf(claudio.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe("mention");
  });

  for (const [tool, input] of [
    ["ask_agent", { agent: "@ada", question: "Como é o deploy de staging?" }],
    ["tell_agent", { agent: "@ada", message: "O deploy terminou." }],
  ] as const) {
    test(`${tool} reaches it, named as it is now`, async () => {
      const results: string[] = [];
      f = await setup({ askAgent: true, reply: callsTool(tool, input, results) });
      const claudio = await renamedAda();
      await post("@dev go");
      await drainOutbox(f.db, f.handlers);

      expect(results[0]).not.toContain("No agent");
      expect(results[0]).toContain("@claudio");
      expect(await runsOf(claudio.id)).toHaveLength(1);
    });
  }

  test("a routine's text that names it: the run reads who it is now", async () => {
    const requests: ModelRequest[] = [];
    f = await setup({
      reply: (req) => {
        requests.push(req);
        return { chunks: ["ok"] };
      },
    });
    await renamedAda();
    const routine = await channelRoutine(f, { prompt: "Pergunte à @ada se o deploy de staging terminou." });
    await fire(f, routine.id, new Date());
    await drainOutbox(f.db, f.handlers);

    expect(systemText(requests.at(-1)?.system ?? [])).toContain(
      "# Renamed agents\nSome text here names agents by a handle they had before: @ada is @claudio.",
    );
  });

  test("a note in memory that names it: the run reads who it is now", async () => {
    const requests: ModelRequest[] = [];
    f = await setup({
      reply: (req) => {
        requests.push(req);
        return { chunks: ["ok"] };
      },
    });
    await renamedAda();
    await consolidateItem(f.db, {
      orgId: f.org.id,
      kind: "fact",
      scopeType: "channel",
      scopeId: f.general.id,
      channelIds: [f.general.id],
      content: "Quem cuida do deploy de staging é a @ada.",
      pinned: true,
    });
    await drainOutbox(f.db, f.handlers);
    await post("@dev quem cuida do deploy?");
    await drainOutbox(f.db, f.handlers);

    const prompt = systemText(requests.at(-1)?.system ?? []);
    expect(prompt).toContain("Quem cuida do deploy de staging é a @ada.");
    expect(prompt).toContain("@ada is @claudio");
  });

  test("calendar participants and its own git branches", async () => {
    f = await setup();
    const claudio = await renamedAda();

    expect(await resolveParticipants(f.db, f.org.id, ["@ada"])).toEqual([{ type: "agent", id: claudio.id }]);
    const push = { oldOid: "b".repeat(40), newOid: "a".repeat(40), ref: "refs/heads/agentes/ada/fix-login" };
    expect(refRule(push, claudio.handle, claudio.previousHandles)).toEqual({ ok: true });
    expect(refRule(push, claudio.handle)).toEqual({ grant: "agentes/ada/fix-login" });
  });
});

test("other agents' context names it as it is now, even on a server with its caches warm", async () => {
  const requests: ModelRequest[] = [];
  f = await setup({
    reply: (req) => {
      requests.push(req);
      return { chunks: ["ok"] };
    },
  });
  const ada = await addAgent("Ada", "ada", "Dev");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ada.id });
  enableCaches();
  try {
    await post("@dev oi");
    await drainOutbox(f.db, f.handlers);
    expect(systemText(requests.at(-1)?.system ?? [])).toContain("Ada (@ada, agent)");
    await rename(ada.id, "Claudio", "claudio");
    await post("@dev e agora?");
    await drainOutbox(f.db, f.handlers);
  } finally {
    enableCaches(false);
  }
  const prompt = systemText(requests.at(-1)?.system ?? []);
  expect(prompt).toContain("Claudio (@claudio, agent)");
  expect(prompt).not.toContain("(@ada, agent)");
});
