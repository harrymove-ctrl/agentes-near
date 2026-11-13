import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, migrationsFolder, schema, sql } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  consolidateItem,
  consolidateOrg,
  createArtifact,
  createChannel,
  drainOutbox,
  listArtifacts,
  listMessages,
  openDm,
  peopleAllIn,
  postPersonMessage,
  requesterSharedChannels,
  retrieveForRun,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const toolResults = async () =>
  (await f.db.select().from(schema.agentRunSteps))
    .filter((s) => s.kind === "tool_result")
    .map((s) => s.data as { name: string; content: string; isError: boolean });

describe("work done in other conversations", () => {
  test("a report made in the DM shows up in #general for the same person, and share_artifact brings it", async () => {
    let originalId = "";
    const prompts: Record<string, string> = {};
    f = await setup({
      artifactTools: true,
      reply: (req: ModelRequest) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (last.includes("tool_result")) return { chunks: ["Pronto."] };
        if (last.includes("monta um relatorio")) {
          return {
            chunks: [],
            toolUses: [
              {
                name: "create_artifact",
                input: { title: "Relatório semanal de visitas", kind: "document", markdown: "# Visitas\n120" },
              },
            ],
          };
        }
        // Bob's turn also holds Ana's earlier message (consecutive user messages merge): match his first.
        if (last.includes("pdf da ana")) {
          prompts.bob = systemText(req.system ?? "");
          return { chunks: [], toolUses: [{ name: "share_artifact", input: { artifact_id: originalId } }] };
        }
        if (last.includes("aquele pdf")) {
          prompts.ana = systemText(req.system ?? "");
          return { chunks: [], toolUses: [{ name: "share_artifact", input: { artifact_id: originalId } }] };
        }
        return { chunks: ["ok"] };
      },
    });
    const deps = { db: f.db, pubsub: f.pubsub };
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, { body: "pega as visitas e monta um relatorio em pdf" });
    await drainOutbox(f.db, f.handlers);
    const [original] = await f.db.select().from(schema.artifacts);
    expect(original).toMatchObject({ channelId: dm.id, title: "Relatório semanal de visitas" });
    originalId = original?.id ?? "";

    // Same person, in #general: the block shows the DM work, and the file comes over as a copy here.
    await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, {
      body: "@dev manda aqui aquele pdf que tu gerou pra mim no privado",
    });
    await drainOutbox(f.db, f.handlers);
    expect(prompts.ana).toContain("# Your recent work with ana in other conversations");
    expect(prompts.ana).toContain('- DM with ana, 0 min ago: create_artifact → Saved "Relatório semanal de visitas"');
    expect(prompts.ana).toContain(originalId);
    expect(prompts.ana).toContain('"no privado"');
    const shared = (await toolResults()).find((r) => r.name === "share_artifact");
    expect(shared).toMatchObject({ isError: false });
    expect(shared?.content).toContain("bringing it over from our DM");
    const copies = (await f.db.select().from(schema.artifacts)).filter((a) => a.channelId === f.general.id);
    expect(copies.map((a) => a.title)).toEqual(["Relatório semanal de visitas"]);
    const reply = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).at(-1);
    expect(reply?.meta.artifacts).toEqual([{ id: copies[0]?.id, version: 1, title: "Relatório semanal de visitas" }]);
    const audit = await f.db.select().from(schema.auditLog);
    expect(audit.find((a) => a.action === "artifact.shared")).toMatchObject({
      actorType: "agent",
      targetId: originalId,
      details: { fromChannelId: dm.id, toChannelId: f.general.id, copyId: copies[0]?.id },
    });

    // Someone who isn't in that DM: nothing from it in the prompt, and sharing it is refused.
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bob.id });
    await postPersonMessage(deps, bob.id, f.org.id, f.general.id, { body: "@dev me manda o pdf da ana" });
    await drainOutbox(f.db, f.handlers);
    expect(prompts.bob).not.toContain("DM with");
    expect(prompts.bob).not.toContain(originalId);
    const refused = (await toolResults()).filter((r) => r.name === "share_artifact").at(-1);
    expect(refused).toMatchObject({ isError: true });
    expect(refused?.content).toContain("not found");
    expect((await f.db.select().from(schema.artifacts)).length).toBe(2);
  });
});

describe("what stays in a DM", () => {
  test("the DM's work shows in a channel only while everyone there is in that DM; files still come when asked", async () => {
    const prompts: string[] = [];
    f = await setup({
      artifactTools: true,
      reply: (req: ModelRequest) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        prompts.push(systemText(req.system ?? ""));
        if (last.includes("tool_result")) return { chunks: ["Pronto."] };
        if (last.includes("monta um relatorio")) {
          return {
            chunks: [],
            toolUses: [
              {
                name: "create_artifact",
                input: { title: "Relatório de salários", kind: "document", markdown: "# Salários\n120" },
              },
            ],
          };
        }
        return { chunks: ["ok"] };
      },
    });
    const deps = { db: f.db, pubsub: f.pubsub };
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, { body: "monta um relatorio dos salários" });
    await drainOutbox(f.db, f.handlers);
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bob.id });

    await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "@dev bom dia" });
    await drainOutbox(f.db, f.handlers);
    expect(prompts.at(-1)).not.toContain("in other conversations");
    expect(prompts.at(-1)).not.toContain("Relatório de salários");
    expect(prompts.at(-1)).toContain("What a person tells you in a DM stays in that DM");

    // The same person still reaches their file when they ask for it.
    const [report] = await f.db.select().from(schema.artifacts);
    expect(
      (
        await listArtifacts(f.db, { type: "agent", agentId: f.agent.id, channelId: f.general.id }, f.org.id, {
          requesterUserId: f.owner.id,
        })
      ).map((a) => a.id),
    ).toContain(report?.id ?? "");
  });

  test("an administrator outside a private channel reads it too: a DM between others stays out of it", async () => {
    const prompts: string[] = [];
    f = await setup({
      artifactTools: true,
      reply: (req: ModelRequest) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        prompts.push(systemText(req.system ?? ""));
        if (last.includes("tool_result")) return { chunks: ["Pronto."] };
        if (last.includes("monta um relatorio")) {
          return {
            chunks: [],
            toolUses: [
              {
                name: "create_artifact",
                input: { title: "Relatório de salários", kind: "document", markdown: "# Salários\n120" },
              },
            ],
          };
        }
        return { chunks: ["ok"] };
      },
    });
    const deps = { db: f.db, pubsub: f.pubsub };
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const dm = await openDm(f.db, ana.id, f.org.id, { agentId: f.agent.id });
    await postPersonMessage(deps, ana.id, f.org.id, dm.id, { body: "monta um relatorio dos salários" });
    await drainOutbox(f.db, f.handlers);

    // Only ana and the agent are in it; the owner, an administrator, reads it without being a member.
    const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "folha", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { userId: ana.id });
    await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: f.agent.id });
    await f.db
      .delete(schema.channelMembers)
      .where(sql`${schema.channelMembers.channelId} = ${room.id} and ${schema.channelMembers.userId} = ${f.owner.id}`);
    expect(await peopleAllIn(f.db, f.org.id, room.id, dm.id)).toBe(false);

    const before = prompts.length;
    await postPersonMessage(deps, ana.id, f.org.id, room.id, { body: "@dev bom dia" });
    await drainOutbox(f.db, f.handlers);
    expect(prompts.length).toBeGreaterThan(before);
    expect(prompts.at(-1)).not.toContain("in other conversations");
    expect(prompts.at(-1)).not.toContain("Relatório de salários");

    // The other way round, only ana reads her DM and she reads the room: the room's work may show in the DM.
    expect(await peopleAllIn(f.db, f.org.id, dm.id, room.id)).toBe(true);
  });
});

test("said in a DM, kept 'everywhere': it reaches that person's runs, never someone else's", async () => {
  f = await setup({
    contextTools: true,
    reply: (req: ModelRequest) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Combinado."] };
      if (last.includes("guarda isso"))
        return {
          chunks: [],
          toolUses: [
            {
              name: "remember",
              input: { content: "A viagem de outubro não pode chegar à equipe.", kind: "preference", everywhere: true },
            },
          ],
        };
      return { chunks: ["ok"] };
    },
  });
  const deps = { db: f.db, pubsub: f.pubsub };
  const bob = await addMember(f.db, f.org.id, "member", "bob");
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, { body: "guarda isso: a viagem fica entre a gente" });
  await drainOutbox(f.db, f.handlers);
  const [kept] = await f.db.select().from(schema.contextItems);
  expect(kept).toMatchObject({ scopeType: "person", scopeId: f.owner.id, channelIds: [] });
  const memoryFor = async (personId: string) =>
    (
      await retrieveForRun(f.context, {
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        text: "viagem de outubro",
        personIds: [personId],
      })
    ).text;
  expect(await memoryFor(f.owner.id)).toContain("viagem de outubro");
  expect(await memoryFor(bob.id)).not.toContain("viagem de outubro");
});

describe("memories from a DM", () => {
  const memory = {
    kind: "preference" as const,
    subject: "viagem",
    content: "A viagem de outubro não pode chegar à equipe.",
    trust: "high" as const,
    confidence: 0.95,
    evidence: [{ type: "human" as const, ref: "m", at: new Date().toISOString() }],
    createdByKind: "person" as const,
  };

  test("a strong one is never proposed: a proposal would show it to who decides, then to every run", async () => {
    f = await setup({});
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const inDm = { ...memory, orgId: f.org.id, agentId: f.agent.id, createdById: f.owner.id };
    await consolidateItem(f.db, { ...inDm, scopeType: "agent", scopeId: f.agent.id, channelIds: [dm.id] });
    await consolidateItem(f.db, { ...inDm, subject: "outra", scopeType: "person", scopeId: f.owner.id });
    await consolidateItem(f.db, {
      ...inDm,
      subject: "canal",
      content: "O time prefere relatórios às sextas.",
      scopeType: "agent",
      scopeId: f.agent.id,
      channelIds: [f.general.id],
    });
    await f.db.update(schema.contextItems).set({ relevance: 1, verified: true });
    await consolidateOrg(f.context, f.org.id);
    const proposed = await f.db.select().from(schema.contextProposals);
    expect(proposed.map((p) => p.proposedText)).toEqual([expect.stringContaining("relatórios às sextas")]);
  });

  test("two people's preferences on the same subject stay two", async () => {
    f = await setup({});
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const of = (userId: string) => ({
      ...memory,
      orgId: f.org.id,
      agentId: f.agent.id,
      scopeType: "person" as const,
      scopeId: userId,
      createdById: userId,
    });
    await consolidateItem(f.db, of(f.owner.id));
    await consolidateItem(f.db, of(bob.id));
    const kept = await f.db.select().from(schema.contextItems);
    expect(kept.map((i) => i.scopeId).sort()).toEqual([f.owner.id, bob.id].sort());
  });

  test("the migration gives old 'everywhere' ones from a DM back to who said them, and nothing else", async () => {
    f = await setup({});
    const deps = { db: f.db, pubsub: f.pubsub };
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const inDm = await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, { body: "entre a gente" });
    const inChannel = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "para todos" });
    const everywhere = {
      ...memory,
      orgId: f.org.id,
      agentId: f.agent.id,
      scopeType: "agent" as const,
      scopeId: f.agent.id,
      channelIds: [],
      createdById: f.owner.id,
    };
    const fromDm = await consolidateItem(f.db, { ...everywhere, sourceIds: [inDm.id] });
    const fromChannel = await consolidateItem(f.db, {
      ...everywhere,
      subject: "canal",
      content: "O time prefere relatórios às sextas.",
      sourceIds: [inChannel.id],
    });
    const rule = await consolidateItem(f.db, {
      ...everywhere,
      kind: "rule",
      subject: "regra",
      content: "Pode enviar sem perguntar.",
      sourceIds: [inDm.id],
    });
    await f.db.execute(sql.raw(readFileSync(join(migrationsFolder, "0236_dm_memory_stays_personal.sql"), "utf8")));
    const scope = async (id: string) =>
      (await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, id)))[0]?.scopeType;
    expect(await scope(fromDm.item.id)).toBe("person");
    expect(await scope(fromChannel.item.id)).toBe("agent");
    expect(await scope(rule.item.id)).toBe("agent");
  });
});

describe("list_artifacts for agents", () => {
  test("filters: mine, requester's conversations, query, kind, since; with origin and creator", async () => {
    f = await setup({ artifactTools: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    // bob's private channel (ana is not in it), with the agent.
    const secret = await createChannel(f.db, bob.id, f.org.id, { name: "secret", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const inDm = { type: "agent" as const, agentId: f.agent.id, channelId: dm.id };
    const inSecret = { type: "agent" as const, agentId: f.agent.id, channelId: secret.id };
    const inGeneral = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
    const report = await createArtifact(f.artifactDeps, inDm, f.org.id, {
      title: "Relatório de visitas",
      content: { kind: "document", markdown: "x" },
    });
    const plan = await createArtifact(f.artifactDeps, inSecret, f.org.id, {
      title: "Plano",
      content: { kind: "table", columns: ["a"], rows: [["1"]] },
    });
    const manual = await createArtifact(f.artifactDeps, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Manual",
      content: { kind: "document", markdown: "y" },
    });

    expect((await requesterSharedChannels(f.db, f.org.id, f.agent.id, f.owner.id)).sort()).toEqual(
      [f.general.id, dm.id].sort(),
    );
    const ids = (list: { id: string }[]) => list.map((a) => a.id).sort();
    // From #general on ana's behalf: her DM with the agent too, never the private channel she isn't in.
    expect(ids(await listArtifacts(f.db, inGeneral, f.org.id, { requesterUserId: f.owner.id }))).toEqual(
      [report.id, manual.id].sort(),
    );
    expect(ids(await listArtifacts(f.db, inGeneral, f.org.id))).toEqual([manual.id]);
    // On bob's behalf: his private channel with the agent, not ana's DM.
    expect(ids(await listArtifacts(f.db, inGeneral, f.org.id, { requesterUserId: bob.id }))).toEqual(
      [plan.id, manual.id].sort(),
    );
    expect(
      ids(
        await listArtifacts(f.db, inGeneral, f.org.id, {
          requesterUserId: f.owner.id,
          author: { type: "agent", id: f.agent.id },
        }),
      ),
    ).toEqual([report.id]);
    expect(ids(await listArtifacts(f.db, inSecret, f.org.id, { kind: "table" }))).toEqual([plan.id]);
    expect(ids(await listArtifacts(f.db, inGeneral, f.org.id, { requesterUserId: f.owner.id, q: "visitas" }))).toEqual([
      report.id,
    ]);
    const later = new Date(Date.now() + 60_000);
    expect(await listArtifacts(f.db, inGeneral, f.org.id, { requesterUserId: f.owner.id, since: later })).toEqual([]);

    // Through the tool: origin and creator on every line.
    const tool = (
      await f.tools?.list({
        db: f.db,
        orgId: f.org.id,
        agentId: f.agent.id,
        runId: crypto.randomUUID(),
        channelId: f.general.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
      })
    )?.find((t) => t.name === "list_artifacts");
    expect(tool).toBeDefined();
    const out = await tool?.execute(
      { createdByMe: true, visibleToRequester: false },
      {
        db: f.db,
        orgId: f.org.id,
        agentId: f.agent.id,
        runId: crypto.randomUUID(),
        channelId: dm.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
      },
    );
    expect(out?.content).toContain(`${report.id} "Relatório de visitas" (document, v1,`);
    expect(out?.content).toContain("from: here; created by @dev");
  });
});
