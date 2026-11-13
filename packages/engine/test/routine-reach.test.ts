import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  type Brain,
  bridgeToolsFor,
  consultationOrigin,
  createAgent,
  createArtifact,
  createChannel,
  createJobHandlers,
  drainOutbox,
  grantScopes,
  openDm,
  reportHandOffs,
  runRoutineNow,
  STRETCH,
  STRETCH_REFUSAL,
  stretchCardOf,
  updateRoutine,
} from "../src";
import { openRoutineRoom } from "../src/routine-room";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine, RUNNER } from "./machine-fixtures";
import { briefs, channelRoutine, fire, messagesIn, minutesFromNow, routineDeps } from "./routine-fixtures";
import { fakeGithub } from "./tool-fixtures";

/**
 * A routine set to act reaches other agents and posts where its creator can (ADR 0053 §2, amended 2026-10-31):
 * `tell_agent`, `ask_agent`, `post_message` (an @mention there wakes the agent) and `send_dm` to its creator. One
 * that only looks and tells is refused with why. What a routine's run starts counts as work nobody asked for in
 * its stretch (ADR 0089), and its cards and the answers it gets go where it reports, never to its room.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

/** A routine's background run is the one offered `hand_off`. */
const isRoutine = (req: ModelRequest) => (req.tools ?? []).some((t) => t.name === "hand_off");
const inAgentDm = (req: ModelRequest) => systemText(req.system).includes("A private conversation between agents");
const isFor = (req: ModelRequest, name: string, handle: string) =>
  systemText(req.system).includes(`You are ${name} (@${handle})`);
const seen = (req: ModelRequest) => JSON.stringify(req.messages);
const NO_ROUTE = { chunks: ['{"needs_agent":0,"scores":[],"reason":"none"}'] };

/** An agent of #general. */
async function agentIn(fx: Fixture, name: string, handle: string) {
  const agent = await createAgent(
    fx.db,
    fx.owner.id,
    fx.org.id,
    { name, handle, role: "Developer", credentialId: fx.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await fx.db.insert(schema.channelMembers).values({ orgId: fx.org.id, channelId: fx.general.id, agentId: agent.id });
  return agent;
}

/** The routine run's model: `calls` on its first turn, then `done`. */
const routineTurn = (req: ModelRequest, calls: { name: string; input: Record<string, unknown> }[], done: string) =>
  seen(req).includes("tool_result") ? { chunks: [done] } : { chunks: [], toolUses: calls };

const runsOf = (fx: Fixture) => fx.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));
const cardsOf = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).orderBy(asc(schema.messages.createdAt))).filter((m) =>
    stretchCardOf(m.meta),
  );

test("a routine set to act tells another agent: it wakes, and its reply reaches where the routine reports", async () => {
  f = await setup({
    handOff: true,
    askAgent: true,
    judge: (kind) => (kind === "note_reply" ? 0.9 : undefined),
    reply: (req) => {
      if (req.outputSchema) return NO_ROUTE;
      if (isRoutine(req))
        return routineTurn(
          req,
          [{ name: "tell_agent", input: { agent: "@iris", message: "O PR #42 já está pronto? Preciso dele hoje." } }],
          "Cobrei a Iris sobre o PR #42.",
        );
      if (inAgentDm(req)) return { chunks: ["Ainda não: faltam dois testes, termino em 1 hora."] };
      return { chunks: ["A Iris respondeu: faltam dois testes, termina em 1 hora."] };
    },
  });
  const iris = await agentIn(f, "Iris", "iris");
  const routine = await channelRoutine(f, { access: "act", prompt: "Cobre a Iris até o PR #42 ficar pronto." });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const [brief] = await briefs(f);
  if (!brief) throw new Error("the routine didn't fire");
  const [background, note, told] = await runsOf(f);
  // The routine's run, Iris's run on the note in the agents' DM, and the agent where the routine reports.
  expect([background, note, told].map((r) => [r?.agentId, r?.background, r?.hop, r?.status])).toEqual([
    [f.agent.id, true, 1, "done"],
    [iris.id, false, 2, "done"],
    [f.agent.id, false, 2, "done"],
  ]);
  // All of it in the routine's stretch: what it starts counts against its limits.
  expect([background, note, told].every((r) => r?.stretchId === brief.id)).toBe(true);
  const [dm] = await f.db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.id, note?.channelId ?? ""));
  expect(dm?.dmKey).toContain(`a:${iris.id}`);
  const [sent] = await messagesIn(f, dm?.id ?? "");
  expect(sent).toMatchObject({
    authorAgentId: f.agent.id,
    agentRunId: background?.id,
    body: "O PR #42 já está pronto? Preciso dele hoje.",
    meta: { agentNote: { runId: background?.id } },
  });
  // Iris's reply woke the agent where the routine reports, not in the routine's room (nobody reads it).
  expect(told?.channelId).toBe(f.general.id);
  const general = await messagesIn(f, f.general.id);
  expect(general.map((m) => [m.authorAgentId, (m.meta.notice as { kind?: string } | undefined)?.kind ?? null])).toEqual(
    [
      [f.agent.id, "consult_reply"],
      [f.agent.id, null],
    ],
  );
  expect(general[0]?.meta.notice).toMatchObject({ from: "@iris", text: expect.stringContaining("faltam dois testes") });
  expect((await messagesIn(f, brief.channelId)).map((m) => m.id)).toEqual([brief.id]);
  // Its routine block says what it may reach.
  const asked = f.provider.calls.map((c) => c.request).find(isRoutine);
  expect(JSON.stringify(asked)).toContain("tell_agent leaves an agent a note");
});

test("a routine posts only where its creator can post, and writes in a DM only to its creator; its @mention wakes the agent", async () => {
  const results: string[] = [];
  f = await setup({
    handOff: true,
    chatTools: true,
    judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
    reply: (req) => {
      if (req.outputSchema) return NO_ROUTE;
      if (isRoutine(req)) {
        if (seen(req).includes("tool_result")) results.push(seen(req));
        return routineTurn(
          req,
          [
            { name: "post_message", input: { channel: "vendas", text: "@iris o PR #42 já está pronto?" } },
            { name: "post_message", input: { channel: "dev", text: "@iris o PR #42 já está pronto?" } },
            { name: "send_dm", input: { person: "bob", text: "A Iris ainda não terminou o PR #42." } },
            { name: "send_dm", input: { person: "ana", text: "Cobrei a Iris no #dev sobre o PR #42." } },
          ],
          "Cobrei a Iris no #dev.",
        );
      }
      return { chunks: ["Ainda não: faltam dois testes."] };
    },
  });
  const iris = await agentIn(f, "Iris", "iris");
  // Iris answers only Ana, its owner: her routine's @mention wakes it.
  await f.db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, iris.id));
  const bob = await addMember(f.db, f.org.id, "member", "bob");
  // #dev: Ana and Iris are in it. #vendas: Bob's, Ana isn't in it.
  const dev = await createChannel(f.db, f.owner.id, f.org.id, { name: "dev" });
  await addChannelMember(f.db, f.owner.id, f.org.id, dev.id, { agentId: iris.id });
  const vendas = await createChannel(f.db, bob.id, f.org.id, { name: "vendas" });
  const routine = await channelRoutine(f, { access: "act", prompt: "Cobre a Iris até o PR #42 ficar pronto." });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  expect(results[0]).toContain("No channel #vendas that this routine's creator can post in.");
  expect(results[0]).toContain("sends a DM only to the person who set it up");
  expect(await messagesIn(f, vendas.id)).toEqual([]);
  const [background, woken] = await runsOf(f);
  const posted = await messagesIn(f, dev.id);
  expect(posted.map((m) => [m.authorAgentId, m.body])).toEqual([
    [f.agent.id, "@iris o PR #42 já está pronto?"],
    [iris.id, "Ainda não: faltam dois testes."],
  ]);
  expect(posted[0]).toMatchObject({ agentRunId: background?.id, hop: 1, mentionedAgentIds: [iris.id] });
  expect(woken).toMatchObject({ agentId: iris.id, channelId: dev.id, hop: 2, stretchId: background?.stretchId });
  // Its creator's DM with the agent, and nobody else's.
  const anaDm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  expect((await messagesIn(f, anaDm.id)).map((m) => m.body)).toEqual(["Cobrei a Iris no #dev sobre o PR #42."]);
  const bobDms = (await f.db.select().from(schema.channelMembers)).filter((m) => m.userId === bob.id);
  expect(bobDms.map((m) => m.channelId)).toEqual([vendas.id]);
});

test("a routine wakes only agents its creator can talk to", async () => {
  const results: string[] = [];
  f = await setup({
    handOff: true,
    askAgent: true,
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["Ainda não."] };
      if (seen(req).includes("tool_result")) results.push(seen(req));
      return routineTurn(
        req,
        [{ name: "tell_agent", input: { agent: "@iris", message: "O PR #42 já está pronto?" } }],
        "ok",
      );
    },
  });
  const iris = await agentIn(f, "Iris", "iris");
  const bob = await addMember(f.db, f.org.id, "member", "bob");
  // Iris works only with Bob, its owner.
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: bob.id, audienceMode: "owner", consultable: false })
    .where(eq(schema.agents.id, iris.id));
  const routine = await channelRoutine(f, { access: "act", prompt: "Cobre a Iris até o PR #42 ficar pronto." });
  await fire(f, routine.id, new Date(Date.now() - 60_000));
  await drainOutbox(f.db, f.handlers);
  expect(results[0]).toContain("@iris only works with some people");
  expect((await runsOf(f)).filter((r) => r.agentId === iris.id)).toEqual([]);

  // Bob lets Ana talk to Iris: her routine reaches it.
  await f.db
    .update(schema.agents)
    .set({ audienceMode: "people", audienceUserIds: [f.owner.id] })
    .where(eq(schema.agents.id, iris.id));
  await fire(f, routine.id, new Date());
  await drainOutbox(f.db, f.handlers);
  expect(results[1]).toContain("Handed to @iris");
  expect((await runsOf(f)).filter((r) => r.agentId === iris.id).map((r) => r.status)).toEqual(["done"]);
});

test("a consulted agent's approval for a routine's question shows where the routine reports", async () => {
  const github = fakeGithub();
  const WHY = "The PR #42 is stale and its branch was replaced by #57: closing it keeps the queue honest.";
  f = await setup({
    handOff: true,
    askAgent: true,
    toolSources: [github.source],
    reply: (req) => {
      if (req.outputSchema) return NO_ROUTE;
      if (isRoutine(req))
        return routineTurn(
          req,
          [
            {
              name: "ask_agent",
              input: { agent: "@iris", question: "Pode fechar o PR #42, que foi trocado pelo #57?" },
            },
          ],
          "Pedi à Iris para fechar o PR #42.",
        );
      return seen(req).includes("tool_result")
        ? { chunks: ["Fechado."] }
        : { chunks: [], toolUses: [{ name: "github_close_pr", input: { repo: "acme/app", pr: 42, why: WHY } }] };
    },
  });
  const iris = await agentIn(f, "Iris", "iris");
  await grantScopes(f.db, f.org.id, iris.id, [{ connectionId: null, scope: "github:pr.write" }]);
  const routine = await channelRoutine(f, { access: "act", prompt: "Cuide da fila de PRs." });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const [approval] = await f.db.select().from(schema.approvals);
  expect(approval).toMatchObject({ agentId: iris.id, channelId: f.general.id, status: "pending", why: WHY });
  const card = (await messagesIn(f, f.general.id)).find((m) => m.meta.approvalId === approval?.id);
  expect(card).toMatchObject({ authorAgentId: iris.id, threadId: null });
  expect(github.executed).toEqual([]);
});

test("a routine's creator outside the consulted agent's audience: its approval stays with the agents, not where the routine reports", async () => {
  const github = fakeGithub();
  f = await setup({
    handOff: true,
    askAgent: true,
    toolSources: [github.source],
    reply: (req) => {
      if (req.outputSchema) return NO_ROUTE;
      if (isRoutine(req))
        return routineTurn(
          req,
          [{ name: "ask_agent", input: { agent: "@iris", question: "Pode fechar o PR #42?" } }],
          "Pedi à Iris.",
        );
      return seen(req).includes("tool_result")
        ? { chunks: ["Fechado."] }
        : {
            chunks: [],
            toolUses: [
              {
                name: "github_close_pr",
                input: {
                  repo: "acme/app",
                  pr: 42,
                  why: "The PR #42 was replaced by #57: closing it keeps the queue honest.",
                },
              },
            ],
          };
    },
  });
  const iris = await agentIn(f, "Iris", "iris");
  // Iris answers only its owner; other agents may consult it (the default).
  await f.db
    .update(schema.agents)
    .set({ audienceMode: "owner", ownerUserId: f.owner.id })
    .where(eq(schema.agents.id, iris.id));
  await grantScopes(f.db, f.org.id, iris.id, [{ connectionId: null, scope: "github:pr.write" }]);
  const lia = await addMember(f.db, f.org.id, "member", "lia");
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: lia.id });
  // Her own agent runs the routine.
  await f.db.update(schema.agents).set({ ownerUserId: lia.id }).where(eq(schema.agents.id, f.agent.id));
  const routine = await channelRoutine(f, { access: "act", prompt: "Cuide da fila de PRs." }, lia.id);
  await runRoutineNow(routineDeps(f), lia.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const [approval] = await f.db.select().from(schema.approvals);
  expect(approval).toMatchObject({ agentId: iris.id, status: "pending" });
  expect(approval?.channelId).not.toBe(f.general.id);
  expect((await messagesIn(f, f.general.id)).some((m) => m.authorAgentId === iris.id)).toBe(false);
  const [run] = (await runsOf(f)).filter((r) => r.agentId === iris.id);
  expect(await consultationOrigin(f.db, f.org.id, run?.id ?? "")).toBeNull();
});

/** Iris and Dev hand the work back to each other forever. */
const pingPong = (req: ModelRequest) => {
  if (req.outputSchema) return NO_ROUTE;
  if (isRoutine(req))
    return routineTurn(
      req,
      [{ name: "post_message", input: { channel: "dev", text: "@iris o PR #42 já está pronto?" } }],
      "Cobrei a Iris.",
    );
  return {
    chunks: [isFor(req, "Iris", "iris") ? "@dev ainda não: revisa os testes?" : "@iris revisei: corrige o lint?"],
  };
};

test("loops stay held: agents a routine's post set off stop at the limit of work nobody asked for, with one card for its creator", async () => {
  f = await setup({
    handOff: true,
    chatTools: true,
    judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
    reply: pingPong,
  });
  const iris = await agentIn(f, "Iris", "iris");
  const dev = await createChannel(f.db, f.owner.id, f.org.id, { name: "dev" });
  for (const agentId of [iris.id, f.agent.id]) await addChannelMember(f.db, f.owner.id, f.org.id, dev.id, { agentId });
  const routine = await channelRoutine(f, { access: "act", prompt: "Cobre a Iris até o PR #42 ficar pronto." });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers, { maxBatches: 2000 });

  const [brief] = await briefs(f);
  const runs = await runsOf(f);
  expect(runs.filter((r) => r.hop >= 2).length).toBe(STRETCH.unattendedRuns);
  expect(runs.every((r) => r.stretchId === brief?.id && r.status === "done")).toBe(true);
  const [card, ...more] = await cardsOf(f);
  expect(more).toEqual([]);
  expect(card?.channelId).toBe(dev.id);
  expect(card?.meta.actionCard).toMatchObject({
    reason: "runs",
    limit: STRETCH.unattendedRuns,
    forUserId: f.owner.id,
  });
  const told = await f.db.select().from(schema.notifications);
  expect(told.some((n) => n.userId === f.owner.id && n.source.messageId === card?.id)).toBe(true);
});

test("a routine's tell_agent at the limit is refused, and the card goes where the routine reports", async () => {
  const results: string[] = [];
  f = await setup({
    handOff: true,
    askAgent: true,
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["ok"] };
      if (seen(req).includes("tool_result")) results.push(seen(req));
      return routineTurn(
        req,
        [{ name: "tell_agent", input: { agent: "@iris", message: "O PR #42 já está pronto?" } }],
        "ok",
      );
    },
  });
  const iris = await agentIn(f, "Iris", "iris");
  const routine = await channelRoutine(f, { access: "act", prompt: "Cobre a Iris até o PR #42 ficar pronto." });
  await fire(f, routine.id, new Date());
  const [brief] = await briefs(f);
  if (!brief) throw new Error("the routine didn't fire");
  // The routine's work already started as many runs as work nobody asked for may.
  await f.db.insert(schema.agentRuns).values(
    Array.from({ length: STRETCH.unattendedRuns }, () => ({
      orgId: f.org.id,
      agentId: iris.id,
      channelId: f.general.id,
      threadRootId: brief.id,
      triggerMessageId: Bun.randomUUIDv7(),
      trigger: "mention" as const,
      hop: 2,
      stretchId: brief.id,
      status: "done" as const,
    })),
  );
  await drainOutbox(f.db, f.handlers);

  expect(results[0]?.split(STRETCH_REFUSAL).length).toBe(2);
  const [card] = await cardsOf(f);
  expect(card?.channelId).toBe(f.general.id);
  expect(card?.meta.actionCard).toMatchObject({ limit: STRETCH.unattendedRuns, forUserId: f.owner.id });
  expect((await runsOf(f)).filter((r) => r.agentId === iris.id && r.status !== "done")).toEqual([]);
});

test("only its creator sets what a routine does: anyone else takes it over first", async () => {
  f = await setup();
  const bob = await addMember(f.db, f.org.id, "member", "bob");
  const routine = await channelRoutine(f, { prompt: "Veja o PR #42." });
  // Bob's routine on an agent Ana owns: it acts (ADR 0109), so it would reach Bob's rooms and the agents Bob talks to.
  await f.db.update(schema.routines).set({ createdByUserId: bob.id }).where(eq(schema.routines.id, routine.id));
  const edit = (actorId: string, patch: Parameters<typeof updateRoutine>[4]) =>
    updateRoutine(routineDeps(f), actorId, f.org.id, routine.id, patch);
  const refused = { code: "routine.act_take_over" };
  await expect(edit(f.owner.id, { prompt: "Cobre o @hr-bot e poste no #m-team." })).rejects.toMatchObject(refused);
  expect((await edit(bob.id, { prompt: "Cobre o PR #42." })).prompt).toBe("Cobre o PR #42.");
  // The rest stays hers to change; an old client's "read" changes nothing: every routine acts.
  expect((await edit(f.owner.id, { name: "PR #42", prompt: "Cobre o PR #42." })).name).toBe("PR #42");
  expect((await edit(f.owner.id, { access: "read" })).access).toBe("act");
});

test("a routine set to act posts the file its run made, and the post's audit names the routine", async () => {
  let fileId = "";
  f = await setup({
    handOff: true,
    chatTools: true,
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["ok"] };
      return routineTurn(
        req,
        [{ name: "post_message", input: { channel: "general", text: "Relatório do dia.", artifact_ids: [fileId] } }],
        "Postei o relatório no #general.",
      );
    },
  });
  const routine = await channelRoutine(f, { access: "act", prompt: "Poste o relatório no #general." });
  // What its run makes lives in its room, where nobody else reads.
  const room = await openRoutineRoom(f.db, f.org.id, f.agent.id, routine.id);
  const file = await createArtifact(
    f.artifactDeps,
    { type: "agent", agentId: f.agent.id, channelId: room.id },
    f.org.id,
    { title: "Relatório", content: { kind: "document", markdown: "# Relatório" } },
  );
  fileId = file.id;
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const [post] = await messagesIn(f, f.general.id);
  expect(post?.body).toBe("Relatório do dia.");
  expect((post?.meta.artifacts as string[] | undefined)?.length).toBe(1);
  const [audit] = await f.db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "message.posted_elsewhere"));
  expect(audit?.details).toMatchObject({ requesterUserId: null, routineId: routine.id, creatorUserId: f.owner.id });
});

test("an agent a routine told keeps within its creator's rooms: it can't post where the creator can't", async () => {
  const results: string[] = [];
  f = await setup({
    handOff: true,
    askAgent: true,
    chatTools: true,
    reply: (req) => {
      if (req.outputSchema) return NO_ROUTE;
      if (isRoutine(req))
        return routineTurn(
          req,
          [{ name: "tell_agent", input: { agent: "@ops", message: "Poste o resumo do dia no #financeiro." } }],
          "Passei o resumo para o Ops.",
        );
      if (!inAgentDm(req)) return { chunks: ["ok"] };
      if (seen(req).includes("tool_result")) {
        results.push(seen(req));
        return { chunks: ["Não consegui postar no #financeiro."] };
      }
      return {
        chunks: [],
        toolUses: [{ name: "post_message", input: { channel: "financeiro", text: "Resumo do dia." } }],
      };
    },
  });
  const ops = await agentIn(f, "Ops", "ops");
  const bob = await addMember(f.db, f.org.id, "member", "bob");
  // #financeiro: Bob's, with Ops in it; the routine's creator isn't.
  const financeiro = await createChannel(f.db, bob.id, f.org.id, { name: "financeiro", visibility: "private" });
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: financeiro.id, agentId: ops.id });
  const routine = await channelRoutine(f, { access: "act", prompt: "Mande o resumo do dia." });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  expect((await runsOf(f)).some((r) => r.agentId === ops.id)).toBe(true);
  expect(results[0]).toContain("No channel #financeiro that this routine's creator can post in.");
  expect(await messagesIn(f, financeiro.id)).toEqual([]);
});

test("what a routine handed off lands where it reports even while its run is still at work, and its run is told so", async () => {
  f = await setup({ handOff: true, askAgent: true });
  const iris = await agentIn(f, "Iris", "iris");
  const routine = await channelRoutine(f, { access: "act", prompt: "Cobre a Iris até o PR #42 ficar pronto." });
  await fire(f, routine.id, new Date());
  const [background] = await runsOf(f);
  if (!background?.background || !f.tools) throw new Error("the routine didn't fire");
  const told = await f.tools.invoke(
    {
      db: f.db,
      orgId: f.org.id,
      agentId: background.agentId,
      runId: background.id,
      channelId: background.channelId,
      threadRootId: background.threadRootId,
      triggerMessageId: background.triggerMessageId,
      background: true,
    },
    {
      toolUseId: "tu_routine_note",
      name: "tell_agent",
      input: { agent: "@iris", message: "O PR #42 já está pronto?" },
    },
  );
  const text = told.type === "result" ? String(told.output.content) : "";
  expect(text).toContain("reaches the people where this routine reports");
  expect(text).not.toContain("Your answer goes back");

  // Iris is done while the routine's run still works.
  await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, background.id));
  await f.db
    .update(schema.agentConsultations)
    .set({ status: "answered", answer: "Faltam dois testes.", answeredAt: new Date() });
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.agentId, iris.id));
  const [asker] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, background.id));
  if (!asker) throw new Error("no run");
  const [delivered] = await reportHandOffs({ db: f.db, pubsub: f.pubsub }, asker);

  // Not queued on the routine's run (which may still fail unread): it lands where people read, and wakes the agent there.
  expect(delivered?.message.channelId).toBe(f.general.id);
  expect(delivered?.runs.map((r) => [r.agentId, r.channelId])).toEqual([[f.agent.id, f.general.id]]);
  const [after] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, background.id));
  expect(after?.pendingMessageIds).toEqual([]);
});

test("a scheduled routine's run on Claude Code lists ask_agent and tell_agent, in its turn and through the bridge", async () => {
  f = await setup({
    handOff: true,
    askAgent: true,
    reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
  });
  await agentIn(f, "Iris", "iris");
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "MacBook",
    ...RUNNER,
    exec: true,
  });
  await f.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code" })
    .where(eq(schema.agents.id, f.agent.id));
  const seen: { turn: string[]; bridge: string[] } = { turn: [], bridge: [] };
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      seen.turn = turn.tools.map((t) => t.name);
      const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId: paired.machineId };
      seen.bridge = (await bridgeToolsFor({ db: f.db, pubsub: f.pubsub, tools: f.tools }, id)).map((t) => t.name);
      yield { type: "done", text: "Nada novo." };
    },
  };
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: {
      status: async (id) => ({
        id,
        orgId: f.org.id,
        name: "MacBook",
        online: true,
        execAllowed: true,
        os: "darwin",
        protocol: RUNNER.protocol,
        executors: { claude: { version: "2.1.316", loggedIn: true }, detectedAt: new Date().toISOString() },
      }),
    },
  });
  const routine = await channelRoutine(f, { access: "act" });
  await fire(f, routine.id, minutesFromNow(-1), "schedule");
  await drainOutbox(f.db, handlers);

  const [run] = await runsOf(f);
  expect([run?.background, run?.brain, run?.status]).toEqual([true, "claude_code", "done"]);
  for (const names of [seen.turn, seen.bridge])
    expect(names).toEqual(expect.arrayContaining(["ask_agent", "tell_agent"]));
});
