import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  bridgeToolsFor,
  createAgent,
  createArtifact,
  createChannel,
  createFileArtifact,
  drainOutbox,
  fileReach,
  getArtifact,
  grantScopes,
  listArtifacts,
  listRoles,
  openDm,
  postPersonMessage,
  receiveMachineUpload,
  runRoutineNow,
  shareSavedFile,
  surfaceRoomFiles,
  type ToolContext,
  updateArtifact,
  updateRole,
  withPersonFacts,
} from "../src";
import { openRoutineRoom } from "../src/routine-room";
import { addMember, type Fixture, setup } from "./fixtures";
import { connectedComputer } from "./machine-fixtures";
import { agentRunRow, channelRoutine, fire, messagesIn, routineDeps } from "./routine-fixtures";

/** What an agent saves through the real Tool Gateway, against what a person then finds in the Drive. */

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const DRIVE = ["drive:read", "drive:write"].map((scope) => ({ connectionId: null, scope }));
const WIKI = ["wiki:read", "wiki:write"].map((scope) => ({ connectionId: null, scope }));
const PDF = new TextEncoder().encode("%PDF-1.4 relatório");

let computerFiles: () => Map<string, Uint8Array>;

const lastText = (req: { messages: unknown[] }) => JSON.stringify(req.messages.at(-1));

type Reply = NonNullable<NonNullable<Parameters<typeof setup>[0]>["reply"]>;

/** @dev on a connected computer with a PDF on it, the Drive and wiki tools; `reply` answers its model calls. */
async function world(reply?: Reply) {
  f = await setup({
    machines: true,
    artifactTools: true,
    askAgent: true,
    handOff: true,
    chatTools: true,
    wikiTools: true,
    contextTools: true,
    reply:
      reply ??
      ((req) => {
        if (lastText(req).includes("tool_result")) return { chunks: ["ok"] };
        if (lastText(req).includes("pergunta bia"))
          return { chunks: [], toolUses: [{ name: "ask_agent", input: { agent: "@bia", question: "Monta" } }] };
        return { chunks: ["ok"] };
      }),
  });
  let machineId = "";
  const computer = await connectedComputer(f, {
    async push(req, bytes, name) {
      await receiveMachineUpload(
        { db: f.db, artifacts: f.artifactDeps, pubsub: f.pubsub },
        {
          uploadId: req.uploadId,
          machineId,
          name,
          contentType: "",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          body: bytes,
        },
      );
    },
  });
  machineId = computer.paired.machineId;
  await grantScopes(f.db, f.org.id, f.agent.id, [...DRIVE, ...WIKI]);
  computer.runner.files.set("relatorio.pdf", PDF);
  computerFiles = () => computer.runner.files;
  return { bob: await addMember(f.db, f.org.id, "member", "bob") };
}

const ctxOf = (run: Awaited<ReturnType<typeof agentRunRow>>): ToolContext => ({
  db: f.db,
  orgId: f.org.id,
  agentId: run.agentId,
  runId: run.id,
  channelId: run.channelId,
  threadRootId: run.threadRootId,
  triggerMessageId: run.triggerMessageId,
  background: run.background,
});

const call = async (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
  const outcome = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
  if (outcome?.type !== "result") throw new Error(`expected a result, got ${outcome?.type}`);
  return outcome.output;
};

/** The run a person's message started, finished; calls go through it afterwards. */
async function runAfter(agentId: string, channelId: string, body: string, userId = f.owner.id) {
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, channelId, { body });
  await drainOutbox(f.db, f.handlers);
  const runs = await f.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.agentId, agentId), eq(schema.agentRuns.channelId, channelId)));
  const run = runs.at(-1);
  if (!run) throw new Error("no run");
  return run;
}

const routineRun = async (input: Parameters<typeof channelRoutine>[1] = {}) =>
  agentRunRow(f, (await fire(f, (await channelRoutine(f, input)).id, new Date())).agentRunId);

/** A routine of @dev's own owner, `userId`, reporting in their DM unless said otherwise. */
async function routineOf(userId: string, input: Parameters<typeof channelRoutine>[1] = {}) {
  await f.db.update(schema.agents).set({ ownerUserId: userId }).where(eq(schema.agents.id, f.agent.id));
  return channelRoutine(f, { target: { type: "dm" }, ...input }, userId);
}

const addBia = async () => {
  const bia = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Bia", handle: "bia", role: "Dados", instructions: "Answer.", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await grantScopes(f.db, f.org.id, bia.id, DRIVE);
  return bia;
};

/** Ana asks @dev in `channelId`, and @dev consults @bia in their DM: @bia's run there. */
async function consultedRun(biaId: string, channelId = f.general.id) {
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, {
    body: "@dev pergunta bia",
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, biaId));
  if (!run) throw new Error("no consulted run");
  return run;
}

const save = (ctx: ToolContext, extra: Record<string, unknown> = {}) =>
  call(ctx, "create_artifact", { title: "Relatório", kind: "document", markdown: "# oi", ...extra });

/** What the Drive API lists for this person: the same two calls as its route. */
async function driveOf(userId: string) {
  const list = await listArtifacts(f.db, { type: "person", userId }, f.org.id);
  return withPersonFacts(f.db, userId, f.org.id, list);
}

const join = (userId: string) => addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId });

const titles = async (userId: string) => (await driveOf(userId)).map((a) => a.title).sort();

/** Both ways of saving: the document and the uploaded file are found by the same people, and each result says so. */
async function savesBoth(ctx: ToolContext, reach: string, extra: Record<string, unknown> = {}) {
  const doc = await save(ctx, extra);
  const file = await call(ctx, "upload_file", { path: "relatorio.pdf", ...extra });
  expect(doc.isError).toBeFalsy();
  expect(file.isError).toBeFalsy();
  expect(doc.content).toContain(reach);
  expect(file.content).toContain(reach);
}

const BOTH = ["Relatório", "relatorio.pdf"];

describe("where a saved file lands, and who finds it", () => {
  test("a public channel: everyone, and the result says so", async () => {
    const { bob } = await world();
    await savesBoth(ctxOf(await runAfter(f.agent.id, f.general.id, "@dev salva")), "everyone in the workspace sees it");
    expect(await titles(f.owner.id)).toEqual(BOTH);
    expect(await titles(bob.id)).toEqual(BOTH);
  });

  test("a private channel: its members only, in the private section", async () => {
    const { bob } = await world();
    const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "vendas", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: f.agent.id });
    await savesBoth(
      ctxOf(await runAfter(f.agent.id, room.id, "@dev salva")),
      "Only the members of #vendas and administrators see it",
    );
    expect(await titles(f.owner.id)).toEqual(BOTH);
    expect((await driveOf(f.owner.id))[0]?.audience).toEqual({ kind: "channel", name: "vendas", private: true });
    expect(await titles(bob.id)).toEqual([]);
  });

  test("a DM stays with that person, and the agent is told it isn't in the shared Drive", async () => {
    const { bob } = await world();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const ctx = ctxOf(await runAfter(f.agent.id, dm.id, "salva"));
    await savesBoth(ctx, "not in the shared Drive");
    expect((await save(ctx)).content).toContain("Only ana can see it");
    expect((await driveOf(f.owner.id))[0]?.audience.kind).toBe("dm");
    expect(await titles(bob.id)).toEqual([]);
  });

  test("the agents' DM: the file goes where the person asked, with the thread it was asked in", async () => {
    const { bob } = await world();
    const bia = await addBia();
    const run = await consultedRun(bia.id);
    const saved = await save(ctxOf(run));
    expect(saved.content).toContain("from #general: everyone in the workspace sees it");
    expect(await titles(f.owner.id)).toEqual(["Relatório"]);
    expect(await titles(bob.id)).toEqual(["Relatório"]);
    expect((await driveOf(f.owner.id))[0]?.channelId).toBe(f.general.id);
  });

  test("the agents' DM from a person's DM: it stays with that person", async () => {
    const { bob } = await world();
    const bia = await addBia();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const saved = await save(ctxOf(await consultedRun(bia.id, dm.id)));
    expect(saved.content).toContain("Only ana can see it");
    expect(await titles(f.owner.id)).toEqual(["Relatório"]);
    expect(await titles(bob.id)).toEqual([]);
  });

  test("a routine that reports to a channel: where it posts", async () => {
    const { bob } = await world();
    const run = await routineRun();
    const listed = await bridgeToolsFor(
      { db: f.db, pubsub: f.pubsub, tools: f.tools },
      { orgId: f.org.id, agentId: run.agentId, runId: run.id, machineId: "" },
    );
    expect(listed.map((t) => t.name)).toEqual(expect.arrayContaining(["create_artifact", "upload_file"]));
    await savesBoth(ctxOf(run), "from #general: everyone in the workspace sees it");
    expect(await titles(f.owner.id)).toEqual(BOTH);
    expect(await titles(bob.id)).toEqual(BOTH);
  });

  test("a routine that reports in its creator's DM: the creator sees it, nobody else", async () => {
    const { bob } = await world();
    await savesBoth(ctxOf(await routineRun({ target: { type: "dm" } })), "Only ana can see it");
    expect(await titles(f.owner.id)).toEqual(BOTH);
    expect(await titles(bob.id)).toEqual([]);
  });

  test('a routine set to "Um documento no Drive": the whole workspace, and its prompt asks for the document', async () => {
    const { bob } = await world((req) => {
      const last = lastText(req);
      if (last.includes("Posted.")) return { chunks: ["registrado"] };
      if (last.includes("Saved"))
        return { chunks: [], toolUses: [{ name: "hand_off", input: { message: "Está no Drive." } }] };
      return {
        chunks: [],
        toolUses: [{ name: "create_artifact", input: { title: "Semana", kind: "document", markdown: "# oi" } }],
      };
    });
    const routine = await channelRoutine(f, { target: { type: "artifact" } });
    await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);
    expect(systemText(f.provider.calls[0]?.request.system ?? "")).toContain("delivers a document in the Drive");
    expect(await titles(bob.id)).toEqual(["Semana"]);
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const [posted] = await messagesIn(f, dm.id);
    expect(posted?.body).toBe("Está no Drive.");
    expect(posted?.meta.artifacts).toEqual([expect.objectContaining({ title: "Semana" })]);
  });

  test("a run answering agents only stays in the room, and its result doesn't claim otherwise", async () => {
    await world();
    const bia = await addBia();
    const lone = await f.db
      .insert(schema.messages)
      .values({
        orgId: f.org.id,
        channelId: (await openRoutineRoom(f.db, f.org.id, bia.id, crypto.randomUUID())).id,
        authorType: "agent",
        authorAgentId: bia.id,
        body: "nota",
      })
      .returning();
    const [message] = lone;
    if (!message) throw new Error("no message");
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: bia.id,
        channelId: message.channelId,
        threadRootId: message.id,
        triggerMessageId: message.id,
        trigger: "mention",
        hop: 1,
        status: "running",
      })
      .returning();
    if (!run) throw new Error("no run");
    expect((await save(ctxOf(run))).content).toContain("No person sees it");
    expect(await titles(f.owner.id)).toEqual([]);
  });
});

test("what a connector brought back for a routine's run stays in its room, and is said so", async () => {
  await world();
  const run = await routineRun();
  const file = await createFileArtifact(
    f.artifactDeps,
    { type: "agent", agentId: run.agentId, channelId: run.channelId, runId: run.id },
    f.org.id,
    { title: "fatura.pdf", name: "fatura.pdf", bytes: PDF, byProduct: true },
  );
  expect(file.channelId).toBe(run.channelId);
  expect(await titles(f.owner.id)).toEqual([]);
  expect(await fileReach(f.db, f.org.id, file.id)).toContain("No person sees it");
});

describe("shared_drive", () => {
  test("from a DM: the whole workspace sees it, a file and a document alike", async () => {
    const { bob } = await world();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await savesBoth(ctxOf(await runAfter(f.agent.id, dm.id, "salva no drive compartilhado")), "shared Drive", {
      shared_drive: true,
    });
    expect(await titles(bob.id)).toEqual(BOTH);
    expect((await driveOf(bob.id)).map((a) => a.audience)).toEqual([{ kind: "workspace" }, { kind: "workspace" }]);
  });

  test("export_file too", async () => {
    const { bob } = await world();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const ctx = ctxOf(await runAfter(f.agent.id, dm.id, "salva no drive compartilhado"));
    computerFiles().set("nota.md", new TextEncoder().encode("# nota"));
    const out = await call(ctx, "export_file", { path: "nota.md", shared_drive: true });
    expect(out.content).toContain("the workspace's shared Drive");
    expect(await titles(bob.id)).toEqual(["nota.md"]);
  });

  test("from a routine: in the workspace's Drive, whoever it reports to", async () => {
    const { bob } = await world();
    const run = await routineRun({ target: { type: "dm" } });
    await savesBoth(ctxOf(run), "the workspace's shared Drive: everyone in the workspace sees it", {
      shared_drive: true,
    });
    expect(await titles(bob.id)).toEqual(BOTH);
  });

  test("an existing file moves with update_artifact and no content, keeping its id and versions", async () => {
    const { bob } = await world();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const ctx = ctxOf(await runAfter(f.agent.id, dm.id, "salva"));
    const id = ((await save(ctx)).data as { artifact: { id: string } }).artifact.id;
    expect(await titles(bob.id)).toEqual([]);
    const moved = await call(ctx, "update_artifact", { artifact_id: id, note: "pro time", shared_drive: true });
    expect(moved.content).toContain("the workspace's shared Drive");
    expect(await titles(bob.id)).toEqual(["Relatório"]);
    expect((await getArtifact(f.artifactDeps, { type: "person", userId: bob.id }, f.org.id, id)).version).toBe(1);
  });

  test("someone else's DM file can't be moved by an agent asked from elsewhere", async () => {
    const { bob } = await world();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const id = ((await save(ctxOf(await runAfter(f.agent.id, dm.id, "salva")))).data as { artifact: { id: string } })
      .artifact.id;
    await join(bob.id);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bob.id, f.org.id, f.general.id, { body: "@dev publica" });
    await drainOutbox(f.db, f.handlers);
    const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.channelId, f.general.id));
    const asked = runs.at(-1);
    if (!asked) throw new Error("no run");
    const out = await call(ctxOf(asked), "update_artifact", { artifact_id: id, note: "x", shared_drive: true });
    expect(out.isError).toBe(true);
    expect(await titles(bob.id)).toEqual([]);
  });
});

describe("a routine's own files", () => {
  test("its next run still lists, reads and updates them where they landed", async () => {
    await world();
    const routine = await channelRoutine(f, { target: { type: "dm" } });
    const first = ctxOf(await agentRunRow(f, (await fire(f, routine.id, new Date())).agentRunId));
    const id = ((await save(first)).data as { artifact: { id: string } }).artifact.id;
    await f.db.update(schema.routineRuns).set({ status: "reported", finishedAt: new Date() });
    await f.db.update(schema.agentRuns).set({ status: "done" });
    const next = ctxOf(await agentRunRow(f, (await fire(f, routine.id, new Date(Date.now() + 86_400_000))).agentRunId));
    expect((await call(next, "list_artifacts", {})).content).toContain(id);
    expect((await call(next, "read_artifact", { artifact_id: id })).content).toContain("# oi");
    expect(
      (await call(next, "update_artifact", { artifact_id: id, note: "semana", markdown: "# novo" })).isError,
    ).toBeFalsy();
    expect((await call(next, "update_artifact", { artifact_id: id, note: "x", shared_drive: true })).content).toContain(
      "the workspace's shared Drive",
    );
  });

  test("but not the creator's other files in that DM", async () => {
    await world();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const theirs = await createArtifact(f.artifactDeps, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Meu",
      content: { kind: "document", markdown: "meu" },
      channelId: dm.id,
    });
    const run = ctxOf(await routineRun({ target: { type: "dm" } }));
    expect((await call(run, "list_artifacts", {})).content).not.toContain(theirs.id);
    expect((await call(run, "read_artifact", { artifact_id: theirs.id })).isError).toBe(true);
    // Nor by search, which reads that DM's messages.
    await drainOutbox(f.db, f.handlers);
    expect((await call(run, "search_context", { query: "meu", kinds: ["file"] })).content).not.toContain(theirs.id);
  });

  test("hand_off's message carries the card of what the run saved", async () => {
    await world((req) => {
      const last = lastText(req);
      if (last.includes("Posted.")) return { chunks: ["registrado"] };
      if (last.includes("Saved"))
        return { chunks: [], toolUses: [{ name: "hand_off", input: { message: "Relatório da semana pronto." } }] };
      return {
        chunks: [],
        toolUses: [{ name: "create_artifact", input: { title: "Semana", kind: "document", markdown: "# oi" } }],
      };
    });
    const routine = await channelRoutine(f);
    await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);
    const [posted] = await messagesIn(f, f.general.id);
    const [file] = await driveOf(f.owner.id);
    expect(posted?.meta.artifacts).toEqual([{ id: file?.id, version: 1, title: "Semana" }]);
  });

  test("share_artifact in a routine says the files already go where it reports", async () => {
    await world();
    const out = await call(ctxOf(await routineRun()), "share_artifact", { artifact_id: crypto.randomUUID() });
    expect(out.content).toContain("hand_off carries their cards");
  });
});

describe("share_artifact", () => {
  test("a file a routine saved reaches the conversation where someone asks for it", async () => {
    await world();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const saved = await save(ctxOf(await routineRun({ target: { type: "dm" } })));
    const id = (saved.data as { artifact: { id: string } }).artifact.id;
    const asked = ctxOf(await runAfter(f.agent.id, dm.id, "manda aqui"));
    expect((await call(asked, "share_artifact", { artifact_id: id })).isError).toBeFalsy();
  });

  test("what a teammate made for the person in the agents' DM comes to them", async () => {
    await world();
    const bia = await addBia();
    const run = await consultedRun(bia.id);
    const dmId = run.channelId;
    const saved = await save(ctxOf(run));
    const id = (saved.data as { artifact: { id: string } }).artifact.id;
    await f.db.update(schema.artifacts).set({ channelId: dmId }).where(eq(schema.artifacts.id, id));
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const asked = ctxOf(await runAfter(f.agent.id, dm.id, "manda aqui"));
    const out = await call(asked, "share_artifact", { artifact_id: id });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("a copy was saved here");
  });

  test("what it made for someone else stays refused", async () => {
    const { bob } = await world();
    const bia = await addBia();
    const run = await consultedRun(bia.id);
    const saved = await save(ctxOf(run));
    const id = (saved.data as { artifact: { id: string } }).artifact.id;
    await f.db.update(schema.artifacts).set({ channelId: run.channelId }).where(eq(schema.artifacts.id, id));
    await join(bob.id);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bob.id, f.org.id, f.general.id, { body: "@dev manda" });
    await drainOutbox(f.db, f.handlers);
    const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.channelId, f.general.id));
    const asked = runs.at(-1);
    if (!asked) throw new Error("no run");
    expect((await call(ctxOf(asked), "share_artifact", { artifact_id: id })).isError).toBe(true);
  });
});

describe("the wiki in a routine", () => {
  test("a routine a person set up writes, in that person's name", async () => {
    await world();
    const run = ctxOf(await routineRun({ prompt: "Salve o resumo na wiki." }));
    const out = await call(run, "create_wiki_page", { title: "Resumo", body: "# Resumo" });
    expect(out.isError).toBeFalsy();
    const [version] = await f.db.select().from(schema.wikiPageVersions);
    expect(version).toMatchObject({ authorType: "agent", requestedByUserId: f.owner.id });
  });

  test("visible_to requester limits the page to the routine's creator", async () => {
    await world();
    const run = ctxOf(await routineRun({ prompt: "Salve o resumo na wiki, só para mim." }));
    const out = await call(run, "create_wiki_page", { title: "Resumo", body: "# Resumo", visible_to: "requester" });
    expect(out.content).toContain("only the people chosen");
    const [page] = await f.db.select().from(schema.wikiPages);
    expect(page).toMatchObject({ restricted: true, audienceUserIds: [f.owner.id] });
  });

  test("nobody behind it and no routine: refused, without saying a message was missing", async () => {
    await world();
    const bia = await addBia();
    await grantScopes(f.db, f.org.id, bia.id, WIKI);
    const room = await openRoutineRoom(f.db, f.org.id, bia.id, crypto.randomUUID());
    const [message] = await f.db
      .insert(schema.messages)
      .values({ orgId: f.org.id, channelId: room.id, authorType: "agent", authorAgentId: bia.id, body: "nota" })
      .returning();
    if (!message) throw new Error("no message");
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: bia.id,
        channelId: room.id,
        threadRootId: message.id,
        triggerMessageId: message.id,
        trigger: "mention",
        hop: 1,
        status: "running",
      })
      .returning();
    if (!run) throw new Error("no run");
    const out = await call(ctxOf(run), "create_wiki_page", { title: "Resumo", body: "# Resumo" });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("a routine a person set up");
    expect(out.content).not.toContain("current message");
  });
});

describe("files already stuck in rooms", () => {
  async function stuckIn(ctx: ToolContext) {
    const id = ((await save(ctx)).data as { artifact: { id: string } }).artifact.id;
    await f.db
      .update(schema.artifacts)
      .set({ channelId: ctx.channelId, threadId: null })
      .where(eq(schema.artifacts.id, id));
    return id;
  }

  test("each goes to its person alone, even when the routine reports to a public channel, once", async () => {
    const { bob } = await world();
    const bia = await addBia();
    await stuckIn(ctxOf(await routineRun()));
    await stuckIn(ctxOf(await consultedRun(bia.id)));
    expect(await titles(f.owner.id)).toEqual([]);
    expect(await surfaceRoomFiles(f.db)).toBe(2);
    expect(await titles(f.owner.id)).toEqual(["Relatório", "Relatório"]);
    expect((await driveOf(f.owner.id)).map((a) => a.audience.kind)).toEqual(["dm", "dm"]);
    expect(await titles(bob.id)).toEqual([]);
    expect(await surfaceRoomFiles(f.db)).toBe(0);
    const moves = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "artifact.surfaced"));
    expect(moves.length).toBe(2);
  });

  test("a person who left: the file stays in the room", async () => {
    const { bob } = await world();
    const routine = await routineOf(bob.id);
    await stuckIn(ctxOf(await agentRunRow(f, (await fire(f, routine.id, new Date())).agentRunId)));
    await f.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, bob.id));
    expect(await surfaceRoomFiles(f.db)).toBe(0);
  });

  test("blocks, what no run made and what a connector or an email brought in stay", async () => {
    await world();
    const ctx = ctxOf(await routineRun());
    const block = await stuckIn(ctx);
    await f.db.update(schema.artifacts).set({ inDrive: false }).where(eq(schema.artifacts.id, block));
    const noRun = await stuckIn(ctx);
    await f.db
      .update(schema.artifactVersions)
      .set({ runId: null })
      .where(eq(schema.artifactVersions.artifactId, noRun));
    const brought = await stuckIn(ctx);
    await f.db
      .update(schema.artifactVersions)
      .set({ note: "From an email in a@example.com" })
      .where(eq(schema.artifactVersions.artifactId, brought));
    expect(await surfaceRoomFiles(f.db)).toBe(0);
  });
});

/** A run of `agentId` in `channelId` that another agent's message woke: nobody is behind it. */
async function unattendedRun(agentId: string, channelId: string) {
  const [message] = await f.db
    .insert(schema.messages)
    .values({ orgId: f.org.id, channelId, authorType: "agent", authorAgentId: agentId, body: "nota" })
    .returning();
  if (!message) throw new Error("no message");
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId,
      channelId,
      threadRootId: message.id,
      triggerMessageId: message.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

const idOf = (out: { data?: Record<string, unknown> }) => (out.data as { artifact: { id: string } }).artifact.id;

/** People of the base role can no longer add files. */
async function noUploads() {
  const base = (await listRoles(f.db, f.owner.id, f.org.id)).roles.find((r) => r.kind === "everyone");
  if (!base) throw new Error("no base role");
  await updateRole(f.db, f.owner.id, f.org.id, base.id, {
    permissions: base.permissions.filter((k) => k !== "upload_files"),
  });
}

const privateRoom = async () => {
  const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "vendas", visibility: "private" });
  await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: f.agent.id });
  return room;
};

const madeBy = (userId: string, channelId: string, title = "Meu") =>
  createArtifact(f.artifactDeps, { type: "person", userId }, f.org.id, {
    title,
    content: { kind: "document", markdown: "privado" },
    channelId,
  });

describe("who may widen a file to the whole workspace", () => {
  test("nobody behind the run: a private channel's file stays there, a new one and one that exists", async () => {
    const { bob } = await world();
    const room = await privateRoom();
    const ctx = ctxOf(await unattendedRun(f.agent.id, room.id));
    const saved = await save(ctx, { shared_drive: true });
    expect(saved.isError).toBeFalsy();
    expect(saved.content).toContain("Saved");
    expect(saved.content).toContain("It isn't in the shared Drive");
    expect(saved.content).toContain("Only the members of #vendas");
    expect(saved.content).not.toContain("update_artifact with shared_drive");
    const theirs = await madeBy(f.owner.id, room.id);
    const moved = await call(ctx, "update_artifact", { artifact_id: theirs.id, note: "x", shared_drive: true });
    expect(moved.isError).toBe(true);
    expect(await titles(bob.id)).toEqual([]);
  });

  test("a person who can't add files to the Drive doesn't do it through an agent", async () => {
    const { bob } = await world();
    await noUploads();
    const dm = await openDm(f.db, bob.id, f.org.id, { agentId: f.agent.id });
    const saved = await save(ctxOf(await runAfter(f.agent.id, dm.id, "salva no drive compartilhado", bob.id)), {
      shared_drive: true,
    });
    expect(saved.content).toContain("It isn't in the shared Drive");
    expect(await titles(f.owner.id)).toEqual([]);
    expect(await titles(bob.id)).toEqual(["Relatório"]);
  });

  test("a run that read outside content doesn't publish a file it didn't make: its own, and the next message, do", async () => {
    const { bob } = await world();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const theirs = await madeBy(f.owner.id, dm.id);
    const run = await runAfter(f.agent.id, dm.id, "lê essa página");
    await f.db
      .insert(schema.agentRunSteps)
      .values({ orgId: f.org.id, runId: run.id, seq: 900, kind: "tool_result", data: { data: { outside: true } } });
    const ctx = ctxOf(run);
    const held = await call(ctx, "update_artifact", { artifact_id: theirs.id, note: "x", shared_drive: true });
    expect(held.isError).toBe(true);
    expect(held.content).toContain("outside");
    expect(await titles(bob.id)).toEqual([]);
    await save(ctx, { shared_drive: true });
    expect(await titles(bob.id)).toEqual(["Relatório"]);
    const next = ctxOf(await runAfter(f.agent.id, dm.id, "pode publicar o meu"));
    expect(
      (await call(next, "update_artifact", { artifact_id: theirs.id, note: "x", shared_drive: true })).isError,
    ).toBeFalsy();
    expect(await titles(bob.id)).toEqual(["Meu", "Relatório"]);
  });

  test("a routine doesn't publish a file of its room a person added to in their DM", async () => {
    const { bob } = await world();
    const routine = await channelRoutine(f, { target: { type: "dm" } });
    const first = ctxOf(await agentRunRow(f, (await fire(f, routine.id, new Date())).agentRunId));
    const id = idOf(await save(first));
    await updateArtifact(f.artifactDeps, { type: "person", userId: f.owner.id }, f.org.id, id, {
      content: { kind: "document", markdown: "anotação privada" },
      note: "minha",
    });
    await f.db.update(schema.routineRuns).set({ status: "reported", finishedAt: new Date() });
    await f.db.update(schema.agentRuns).set({ status: "done" });
    const next = ctxOf(await agentRunRow(f, (await fire(f, routine.id, new Date(Date.now() + 86_400_000))).agentRunId));
    const moved = await call(next, "update_artifact", { artifact_id: id, note: "x", shared_drive: true });
    expect(moved.isError).toBe(true);
    expect(await titles(bob.id)).toEqual([]);
  });

  test("an agent a routine asked, in their DM, does what the routine said", async () => {
    const { bob } = await world();
    const bia = await addBia();
    const routine = await channelRoutine(f, { prompt: "pergunta bia", target: { type: "dm" } });
    await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, bia.id));
    if (!run) throw new Error("no consulted run");
    await save(ctxOf(run), { shared_drive: true });
    expect(await titles(bob.id)).toEqual(["Relatório"]);
  });

  test('"Um documento no Drive" of a person who can\'t add files stays with them', async () => {
    const { bob } = await world();
    const carla = await addMember(f.db, f.org.id, "member", "carla");
    await noUploads();
    const routine = await routineOf(bob.id, { target: { type: "artifact" } });
    const saved = await save(ctxOf(await agentRunRow(f, (await fire(f, routine.id, new Date())).agentRunId)));
    expect(saved.content).toContain("Only bob can see it");
    expect(await titles(bob.id)).toEqual(["Relatório"]);
    expect(await titles(carla.id)).toEqual([]);
  });
});

test("a routine that only says the Drive doesn't publish: that takes the shared Drive", async () => {
  await world();
  const routine = await channelRoutine(f, { prompt: "Salve no Drive.", target: { type: "dm" } });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);
  const prompt = systemText(f.provider.calls[0]?.request.system ?? "");
  expect(prompt).toContain('ask for the shared Drive ("drive compartilhado")');
  expect(prompt).not.toContain("name the Drive");
});

describe("what a tool's result says", () => {
  test("share_artifact's copy from the agents' DM: where it really went", async () => {
    await world();
    const bia = await addBia();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: bia.id });
    const theirs = await madeBy(f.owner.id, dm.id);
    const out = await call(ctxOf(await consultedRun(bia.id)), "share_artifact", { artifact_id: theirs.id });
    expect(out.content).toContain("from #general: everyone in the workspace sees it");
  });

  test("a screenshot shared from a routine's room isn't shown there", async () => {
    await world();
    const run = await routineRun({ target: { type: "dm" } });
    const [machine] = await f.db.select().from(schema.machines);
    const out = await shareSavedFile(
      { machines: { hub: f.machineHub as NonNullable<typeof f.machineHub> }, pubsub: f.pubsub },
      ctxOf(run),
      machine?.id ?? "",
      "relatorio.pdf",
      { content: "Saved relatorio.pdf in your folder." },
    );
    expect(out.isError).toBeFalsy();
    expect(out.content).not.toContain("It is shown in this conversation");
    expect(out.content).toContain("Only ana can see it");
  });
});

test("what an agent outside the person's audience made in the agents' DM doesn't reach them through a colleague", async () => {
  await world();
  const lia = await addMember(f.db, f.org.id, "member", "lia");
  const bia = await addBia();
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: f.owner.id, audienceMode: "owner" })
    .where(eq(schema.agents.id, bia.id));
  await join(lia.id);
  const asked = await runAfter(f.agent.id, f.general.id, "@dev pergunta bia", lia.id);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, bia.id));
  if (!run) throw new Error("no consulted run");
  const saved = await save(ctxOf(run), { shared_drive: true });
  expect(saved.content).toContain("it answers the agent that asked");
  const id = idOf(saved);
  expect(await titles(lia.id)).toEqual([]);
  expect((await call(ctxOf(asked), "share_artifact", { artifact_id: id })).isError).toBe(true);
  expect(await titles(lia.id)).toEqual([]);
});

test("a routine whose creator left writes nothing to the wiki in their name", async () => {
  const { bob } = await world();
  const routine = await routineOf(bob.id, { prompt: "Salve na wiki." });
  const run = await agentRunRow(f, (await fire(f, routine.id, new Date())).agentRunId);
  await f.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, bob.id));
  const out = await call(ctxOf(run), "create_wiki_page", { title: "Resumo", body: "# Resumo" });
  expect(out.isError).toBe(true);
  expect(await f.db.select().from(schema.wikiPageVersions)).toEqual([]);
});

test("a run a routine's report woke in a private channel publishes none of it", async () => {
  const { bob } = await world((req) => {
    const last = lastText(req);
    if (last.includes("tool_result")) return { chunks: ["ok"] };
    return last.includes("Veja as avaliações")
      ? { chunks: [], toolUses: [{ name: "hand_off", input: { message: "Olha isso.", wake_me: true } }] }
      : { chunks: ["ok"] };
  });
  const room = await privateRoom();
  await grantScopes(f.db, f.org.id, f.agent.id, WIKI);
  const routine = await channelRoutine(f, { target: { type: "channel", channelId: room.id } });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.channelId, room.id));
  if (!run) throw new Error("no run woken");
  expect((await save(ctxOf(run), { shared_drive: true })).content).toContain("It isn't in the shared Drive");
  expect(await titles(bob.id)).toEqual([]);
  const wiki = await call(ctxOf(run), "create_wiki_page", { title: "Resumo", body: "# Resumo" });
  expect(wiki.content).toContain("nobody asked for this");
});
