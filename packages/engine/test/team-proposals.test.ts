import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, inArray, isNull, schema } from "@agenteschat/db";
import {
  BUSINESS_TEMPLATES,
  createAgent,
  createRole,
  createSetupToolSource,
  createTeam,
  createToolGateway,
  denyTeam,
  listTeamTemplates,
  NEW_AGENT_DEFAULTS,
  OFFER_ANSWERS_TOOL,
  OFFER_INVITES_TOOL,
  openPersonAgentDm,
  PERSONAL_TEMPLATES,
  PROPOSE_TEAM_TOOL,
  postPersonMessage,
  RIGHT_HAND,
  rightHandPrompt,
  setMemberRoles,
  TEAM_INTERVIEW,
  TEAM_TEMPLATES,
  type TeamProposalCard,
  type ToolContext,
  undoTeam,
  updateOrgSettings,
  useTeamTemplate,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const lodiOf = async (fx: Fixture) => {
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

async function lodiRun(fx: Fixture, userId: string, body: string): Promise<ToolContext> {
  const lodi = await lodiOf(fx);
  const dm = await openPersonAgentDm(fx.db, fx.org.id, userId, lodi.id);
  const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, dm.id, { body });
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: lodi.id,
    runId: run.id,
    channelId: dm.id,
    threadRootId: run.threadRootId,
    triggerMessageId: trigger.id,
  };
}

const gatewayOf = (fx: Fixture) => createToolGateway({ sources: [createSetupToolSource({ pubsub: fx.pubsub })] });
async function call(fx: Fixture, ctx: ToolContext, name: string, input: Record<string, unknown>) {
  const res = await gatewayOf(fx).invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output;
}

async function cardOf(fx: Fixture, messageId: string) {
  const [m] = await fx.db.select().from(schema.messages).where(eq(schema.messages.id, messageId));
  return m?.meta.actionCard as TeamProposalCard;
}

const TEAM = {
  lead: "3 agentes para a Acme, cada um no seu canal.",
  agents: [
    {
      name: "Iara",
      handle: "iara",
      role: "Atendimento",
      line: "Responde os clientes no WhatsApp e no e-mail.",
      look: { color: "rose", eyes: "happy", accessory: "flower" },
      channel: "atendimento",
      routines: [{ schedule: "0 9 * * *", prompt: "Resuma o que ficou sem resposta.", title: "Resumo do dia" }],
      first_task: "Responder a última mensagem da Clínica Bem Estar",
    },
    {
      name: "Caio",
      handle: "caio",
      role: "Cobrança",
      line: "Lembra quem atrasou o pagamento.",
      channel: "financeiro",
      routines: [{ schedule: "0 8 * * 1", prompt: "Liste quem está atrasado.", title: "Atrasados" }],
    },
    { name: "Ada", handle: "ada", role: "Dev", line: "Corrige os bugs.", channel: "general" },
  ],
  skills: [{ title: "Tom de voz da Acme", line: "como a Acme fala", agents: ["iara", "caio"] }],
  approvals: "As cobranças do Caio esperam a sua aprovação.",
  invite: ["Bruno"],
  weekly_check: true,
};

const activeAgents = async (fx: Fixture) =>
  (
    await fx.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, fx.org.id), isNull(schema.agents.archivedAt)))
  ).map((a) => a.handle);

describe("the right hand's team setup tools", () => {
  test("only the right hand has them", async () => {
    f = await setup({ rightHand: true });
    const lodi = (await gatewayOf(f).granted(await lodiRun(f, f.owner.id, "oi"))).map((t) => t.name);
    expect(lodi).toContain(PROPOSE_TEAM_TOOL);
    expect(lodi).toContain(OFFER_ANSWERS_TOOL);
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "oi",
    });
    const others = await gatewayOf(f).granted({
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
    });
    expect(others.map((t) => t.name)).not.toContain(PROPOSE_TEAM_TOOL);
  });

  test("offer_answers posts its question with the answers to tap, once a turn", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "Software e apps");
    const out = await call(f, ctx, OFFER_ANSWERS_TOOL, {
      text: "**O que mais toma o seu tempo hoje?**",
      choices: ["Responder clientes", "Cobrar quem atrasou", "Outra coisa"],
      multiple: true,
      step: 2,
      of: 3,
    });
    expect(out.isError).toBeFalsy();
    const [asked] = await f.db.select().from(schema.messages).where(eq(schema.messages.agentRunId, ctx.runId));
    expect(asked?.body).toBe("**O que mais toma o seu tempo hoje?**");
    expect(asked?.meta.replyChips).toEqual({
      choices: ["Responder clientes", "Cobrar quem atrasou", "Outra coisa"],
      multiple: true,
      step: 2,
      of: 3,
    });
    const again = await call(f, ctx, OFFER_ANSWERS_TOOL, { text: "E mais?", step: 3, of: 3 });
    expect(again.content).toContain("one thing at a time");
    expect(await f.db.select().from(schema.messages).where(eq(schema.messages.agentRunId, ctx.runId))).toHaveLength(1);
  });

  test("one thing a turn: after a question no card that waits on the person goes up, and nothing failed", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "Software e apps");
    await call(f, ctx, OFFER_ANSWERS_TOOL, { text: "**Quem mais?**", step: 3, of: 3 });
    const invite = await call(f, ctx, OFFER_INVITES_TOOL, { emails: ["bruno@acme.test"], why: "Para o time." });
    const team = await call(f, ctx, PROPOSE_TEAM_TOOL, TEAM);
    for (const out of [invite, team]) {
      expect(out.isError).toBeFalsy();
      expect(out.content).toContain("one thing at a time");
    }
    expect(await f.db.select().from(schema.messages).where(eq(schema.messages.agentRunId, ctx.runId))).toHaveLength(1);
    // The next turn is free again.
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, ctx.runId));
    const next = await lodiRun(f, f.owner.id, "Só eu");
    expect(
      (await call(f, next, OFFER_INVITES_TOOL, { emails: ["bruno@acme.test"], why: "Para o time." })).content,
    ).toContain("Posted the invite card");
  });

  test("its prompt runs the interview while there is no team, in its DM", async () => {
    f = await setup({ rightHand: true });
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
    const lodi = await lodiOf(f);
    const prompt = await rightHandPrompt(
      { db: f.db },
      { orgId: f.org.id, agent: lodi, personId: f.owner.id, inDm: true },
    );
    expect(prompt).toContain(TEAM_INTERVIEW);
    expect(prompt).toContain("ONE propose_team card");
    expect(prompt).toContain("One thing at a time");
    // The owner's first-run card shows the setup: no gap is raised over it (ADR 0155 §6).
    expect(prompt).toContain("The checklist card at the top of your DM");
    expect(prompt).not.toContain("build the first team with them");
    expect(prompt).not.toContain("offer_invites).");
    expect(prompt).not.toContain("No computer is ready");
    expect(prompt).not.toContain("offer one the team needs");
    // Without the card (a workspace that had a team before it): with no team, the interview first, nothing else.
    await f.db.update(schema.agents).set({ setup: null }).where(eq(schema.agents.id, lodi.id));
    const bare = await rightHandPrompt(
      { db: f.db },
      { orgId: f.org.id, agent: lodi, personId: f.owner.id, inDm: true },
    );
    expect(bare).toContain("build the first team with them");
    expect(bare).not.toContain("offer_invites).");
    expect(bare).not.toContain("No computer is ready");
  });

  test("with a team too: asked to build or redo it in its DM, it runs the interview", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const dm = { orgId: f.org.id, agent: lodi, personId: f.owner.id, inDm: true };
    expect(await rightHandPrompt({ db: f.db }, dm)).toContain(TEAM_INTERVIEW);
    expect(await rightHandPrompt({ db: f.db }, { ...dm, inDm: false })).not.toContain(TEAM_INTERVIEW);
  });
});

describe("the team card", () => {
  test("propose_team posts one card: new channels marked, routines read, the weekly check; a newer one replaces it", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "Só o Bruno");
    const out = await call(f, ctx, PROPOSE_TEAM_TOOL, {
      ...TEAM,
      agents: TEAM.agents.map((a) => ({ ...a, handle: `${a.handle}x` })),
      skills: [{ ...TEAM.skills[0], agents: ["iarax", "caiox"] }],
    });
    expect(out.content).toStartWith("Posted the team card");
    const id = (out.data as { actionCard: { messageId: string } }).actionCard.messageId;
    const card = await cardOf(f, id);
    expect(card.state).toBe("pending");
    expect(card.params.newChannels.sort()).toEqual(["atendimento", "financeiro"]);
    expect(card.params.agents[0]?.routines[0]?.rule).not.toBeNull();
    expect(card.params.weekly?.cron).toBe("0 17 * * 5");
    expect(card.params.skills[0]?.name).toBe("tom-de-voz-da-acme");
    expect(card.params.invite).toEqual(["Bruno"]);
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, ctx.runId));
    const newer = await call(f, await lodiRun(f, f.owner.id, "Só a Iara"), PROPOSE_TEAM_TOOL, {
      lead: "Só a Iara",
      agents: [{ ...TEAM.agents[0], handle: "iaray" }],
    });
    expect(newer.isError).toBeFalsy();
    expect((await cardOf(f, id)).state).toBe("superseded");
  });

  test("a taken handle or a skill for someone off the team is refused with the reason", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "monta o time");
    const taken = await call(f, ctx, PROPOSE_TEAM_TOOL, {
      lead: "x",
      agents: [{ ...TEAM.agents[0], handle: f.agent.handle }],
    });
    expect(taken.isError).toBe(true);
    expect(taken.content).toContain("already taken");
    const stranger = await call(f, ctx, PROPOSE_TEAM_TOOL, {
      lead: "x",
      agents: [TEAM.agents[0]],
      skills: [{ title: "Voz", line: "como fala", agents: ["zeca"] }],
    });
    expect(stranger.isError).toBe(true);
  });

  test("an agent like one of the team's already here: no card until the person says to make new ones", async () => {
    f = await setup({ rightHand: true });
    await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Bruna", handle: "bruna", role: "atendimento", instructions: "Responde os clientes." },
      NEW_AGENT_DEFAULTS,
    );
    const ctx = await lodiRun(f, f.owner.id, "monta o time");
    const teamCards = async () =>
      (await f.db.select().from(schema.messages).where(eq(schema.messages.agentRunId, ctx.runId))).filter(
        (m) => (m.meta.actionCard as { kind?: string } | undefined)?.kind === "team_proposal",
      );
    const out = await call(f, ctx, PROPOSE_TEAM_TOOL, TEAM);
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain(
      "Not posted: an agent like this already exists: Bruna (@bruna, atendimento) for Iara.",
    );
    expect(out.content).toContain("call propose_team again with also_new: true");
    expect(await teamCards()).toHaveLength(0);
    const again = await call(f, ctx, PROPOSE_TEAM_TOOL, { ...TEAM, also_new: true });
    expect(again.content).toStartWith("Posted the team card");
    expect(await teamCards()).toHaveLength(1);
  });

  test("in a personal workspace an agent may go without a channel: it lives in its DM, and the result says so", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "Casa e contas");
    const inDm = {
      lead: "2 agentes para você",
      agents: [{ name: "Clara", handle: "clara", role: "Casa", line: "Cuida das tarefas de casa." }],
    };
    // A team's right hand still names a channel for each agent.
    const team = await call(f, ctx, PROPOSE_TEAM_TOOL, inDm);
    expect(team.isError).toBe(true);
    expect(team.content).toContain("channel: required");
    expect(await f.db.select().from(schema.messages).where(eq(schema.messages.agentRunId, ctx.runId))).toEqual([]);

    await updateOrgSettings(f.db, f.owner.id, f.org.id, { mode: "personal" });
    const listed = (await gatewayOf(f).granted(ctx)).find((t) => t.name === PROPOSE_TEAM_TOOL);
    expect(listed?.description).toContain("Each agent lives in its DM with the person");
    expect(JSON.stringify(listed?.inputSchema)).toContain("Leave it out: the agent lives in its DM with the person");
    const out = await call(f, ctx, PROPOSE_TEAM_TOOL, inDm);
    expect(out.isError).toBeFalsy();
    expect(out.content).toStartWith("Posted the card of their agents: Clara in its DM, 0 routines, 0 skills.");
    expect(out.content).not.toContain("#");
    const card = await cardOf(f, (out.data as { actionCard: { messageId: string } }).actionCard.messageId);
    expect(card.params.agents.map((a) => a.channel)).toEqual([""]);
    expect(card.params.newChannels).toEqual([]);
  });

  test("Criar o time makes it all as the clicker, Desfazer takes it back", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "Só o Bruno");
    const out = await call(f, ctx, PROPOSE_TEAM_TOOL, TEAM);
    const id = (out.data as { actionCard: { messageId: string } }).actionCard.messageId;
    const made = await createTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id);
    expect(made.card.state).toBe("created");
    expect(made.card.created?.agentIds).toHaveLength(3);
    // #general existed: only the two new channels are the team's own.
    expect(made.card.created?.channelIds).toHaveLength(2);
    expect(made.card.created?.routineIds).toHaveLength(3);
    expect(made.card.created?.skillIds).toHaveLength(1);
    expect(made.card.created?.skipped).toEqual([]);
    expect(await activeAgents(f)).toEqual(expect.arrayContaining(["iara", "caio", "ada"]));
    const iara = (await f.db.select().from(schema.agents).where(eq(schema.agents.handle, "iara")))[0];
    expect(iara?.ownerUserId).toBe(f.owner.id);
    const [atendimento] = await f.db.select().from(schema.channels).where(eq(schema.channels.name, "atendimento"));
    const seat = await f.db
      .select()
      .from(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, atendimento?.id ?? ""),
          eq(schema.channelMembers.agentId, iara?.id ?? ""),
        ),
      );
    expect(seat).toHaveLength(1);
    const lodi = await lodiOf(f);
    const weekly = await f.db.select().from(schema.routines).where(eq(schema.routines.agentId, lodi.id));
    expect(weekly).toHaveLength(1);
    const skill = await f.db
      .select()
      .from(schema.agentSkills)
      .where(eq(schema.agentSkills.agentId, iara?.id ?? ""));
    expect(skill).toHaveLength(1);
    // Twice is once.
    await expect(createTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id)).rejects.toThrow();

    const undone = await undoTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id);
    expect(undone.card.state).toBe("undone");
    expect(await activeAgents(f)).not.toContain("iara");
    const live = await f.db
      .select()
      .from(schema.routines)
      .where(and(eq(schema.routines.orgId, f.org.id), isNull(schema.routines.deletedAt)));
    expect(live.filter((r) => made.card.created?.routineIds.includes(r.id))).toEqual([]);
    const [gone] = await f.db.select().from(schema.channels).where(eq(schema.channels.name, "atendimento"));
    expect(gone?.archivedAt).not.toBeNull();
  });

  const connectGithub = async (fx: Fixture) => {
    const [row] = await fx.db
      .insert(schema.connectorConnections)
      .values({
        orgId: fx.org.id,
        connector: "github",
        label: "GitHub",
        toolPrefix: "github",
        serverUrl: "https://github.example.com/mcp",
        authType: "none",
      })
      .returning();
    return row?.id ?? "";
  };
  const grantsOn = async (fx: Fixture, handle: string, connectionId: string) => {
    const [agent] = await fx.db.select().from(schema.agents).where(eq(schema.agents.handle, handle));
    return (
      await fx.db
        .select()
        .from(schema.agentScopes)
        .where(eq(schema.agentScopes.agentId, agent?.id ?? ""))
    )
      .filter((s) => s.connectionId === connectionId)
      .map((s) => s.scope);
  };

  test("an admin's team gets every connected app at Ler e escrever, as every agent has it", async () => {
    f = await setup({ rightHand: true });
    const github = await connectGithub(f);
    const out = await call(f, await lodiRun(f, f.owner.id, "monta o time"), PROPOSE_TEAM_TOOL, TEAM);
    const id = (out.data as { actionCard: { messageId: string } }).actionCard.messageId;
    expect((await createTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id)).card.state).toBe("created");
    expect(await grantsOn(f, "iara", github)).toEqual(["connector:*"]);
  });

  test("a member's team starts without access (ADR 0085 §5)", async () => {
    f = await setup({ rightHand: true });
    const github = await connectGithub(f);
    const member = await addMember(f.db, f.org.id, "member");
    const makers = await createRole(f.db, f.owner.id, f.org.id, { name: "Makers", permissions: ["create_agents"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, member.id, [makers.id]);
    const out = await call(f, await lodiRun(f, member.id, "monta o time"), PROPOSE_TEAM_TOOL, {
      ...TEAM,
      weekly_check: false,
    });
    const id = (out.data as { actionCard: { messageId: string } }).actionCard.messageId;
    expect((await createTeam({ db: f.db, pubsub: f.pubsub }, member.id, f.org.id, id)).card.state).toBe("created");
    expect(await grantsOn(f, "iara", github)).toEqual([]);
  });

  test("a step that fails creates nothing: the card stays open and says which step", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "monta o time");
    const out = await call(f, ctx, PROPOSE_TEAM_TOOL, TEAM);
    const id = (out.data as { actionCard: { messageId: string } }).actionCard.messageId;
    // Someone takes Caio's handle before the click.
    await f.db.insert(schema.agents).values({
      orgId: f.org.id,
      name: "Outro Caio",
      handle: "caio",
      role: "",
      instructions: "",
      model: "auto",
      ownerUserId: f.owner.id,
    });
    const tried = await createTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id);
    expect(tried.card.state).toBe("pending");
    expect(tried.card.error?.step).toBe("Caio");
    expect(tried.card.error).toMatchObject({ status: 409, code: "agent.handle_taken" });
    expect(await activeAgents(f)).not.toContain("iara");
    expect((await f.db.select().from(schema.channels).where(eq(schema.channels.name, "atendimento"))).length).toBe(0);
    expect((await cardOf(f, id)).error?.step).toBe("Caio");
  });

  test("a member who creates agents: the team without the skills (an admin's), which the receipt names", async () => {
    f = await setup({ rightHand: true });
    // Not in #general, where Ada goes: the team joins them there, as an agent works only where its owner is.
    const member = await addMember(f.db, f.org.id, "member");
    const makers = await createRole(f.db, f.owner.id, f.org.id, { name: "Makers", permissions: ["create_agents"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, member.id, [makers.id]);
    const ctx = await lodiRun(f, member.id, "monta o time");
    const out = await call(f, ctx, PROPOSE_TEAM_TOOL, { ...TEAM, weekly_check: false });
    const id = (out.data as { actionCard: { messageId: string } }).actionCard.messageId;
    const made = await createTeam({ db: f.db, pubsub: f.pubsub }, member.id, f.org.id, id);
    expect(made.card.state).toBe("created");
    expect(made.card.created?.skillIds).toEqual([]);
    expect(made.card.created?.skipped).toEqual(["skills"]);
    const inGeneral = await f.db
      .select()
      .from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, f.general.id), eq(schema.channelMembers.userId, member.id)));
    expect(inGeneral.length).toBe(1);
  });

  test("a private channel the person isn't in can't be named, and a template picks a free name", async () => {
    f = await setup({ rightHand: true });
    const member = await addMember(f.db, f.org.id, "member");
    const makers = await createRole(f.db, f.owner.id, f.org.id, { name: "Makers", permissions: ["create_agents"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, member.id, [makers.id]);
    await f.db.insert(schema.channels).values({
      orgId: f.org.id,
      name: "financeiro",
      visibility: "private",
      createdByUserId: f.owner.id,
    });
    const ctx = await lodiRun(f, member.id, "monta o time");
    const out = await call(f, ctx, PROPOSE_TEAM_TOOL, { ...TEAM, weekly_check: false });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("#financeiro");
    const templates = await listTeamTemplates({ db: f.db }, member.id, f.org.id, "pt-BR");
    expect(templates.find((t) => t.id === "software")?.team.agents[1]?.channel).toBe("financeiro-2");
  });

  test("Descartar closes it for good", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "monta o time");
    const out = await call(f, ctx, PROPOSE_TEAM_TOOL, TEAM);
    const id = (out.data as { actionCard: { messageId: string } }).actionCard.messageId;
    expect((await denyTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id)).card.state).toBe("denied");
    await expect(createTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id)).rejects.toThrow();
    const told = await f.db
      .select({ meta: schema.messages.meta })
      .from(schema.messages)
      .where(eq(schema.messages.channelId, ctx.channelId));
    const notice = told.map((m) => (m.meta.notice as { text?: string } | undefined)?.text).find(Boolean);
    expect(notice).toStartWith("ana dismissed it.");
  });
});

describe("team templates", () => {
  test("six, in the person's language, each a team its card would propose", async () => {
    f = await setup({ rightHand: true });
    const list = await listTeamTemplates({ db: f.db }, f.owner.id, f.org.id, "pt-BR");
    expect(list.map((t) => t.id)).toEqual([...BUSINESS_TEMPLATES]);
    expect(TEAM_TEMPLATES).toEqual([...BUSINESS_TEMPLATES, ...PERSONAL_TEMPLATES]);
    const software = list.find((t) => t.id === "software");
    expect(software?.name).toBe("Software e apps");
    expect(software?.team.agents.map((a) => [a.name, a.channel])).toEqual([
      ["Iara", "atendimento"],
      ["Caio", "financeiro"],
      ["Ada", "eng"],
    ]);
    expect(software?.team.weekly).not.toBeNull();
    expect(software?.team.skills.map((s) => s.title)).toEqual(["Tom de voz", "Régua de cobrança"]);
    const en = await listTeamTemplates({ db: f.db }, f.owner.id, f.org.id, "en");
    expect(en.find((t) => t.id === "software")?.team.agents[0]?.channel).toBe("support");
  });

  test("Criar o time makes the template's team in one call: its card reads created, with no question after", async () => {
    f = await setup({ rightHand: true });
    // What the conversation hears: the card once, already made, so no other device shows it open for a moment.
    const heard: { type: string; message?: { meta: Record<string, unknown> } }[] = [];
    const pubsub = { ...f.pubsub, publish: async (_topic: string, e: unknown) => void heard.push(e as never) };
    const used = await useTeamTemplate({ db: f.db, pubsub }, f.owner.id, f.org.id, "clinic", "pt-BR");
    expect(used).toMatchObject({ state: "created", error: null });
    const announced = heard.filter((e) => e.type === "message.created");
    expect(announced).toHaveLength(1);
    expect(announced[0]?.message?.meta.actionCard).toMatchObject({ state: "created" });
    const card = await cardOf(f, used.messageId);
    expect(card.params.template).toBe("clinic");
    expect(card.state).toBe("created");
    expect(card.params.agents.map((a) => a.name)).toEqual(["Nina", "Caio", "Iara"]);
    expect(card.created?.agentIds).toHaveLength(3);
    const rows = await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, used.channelId));
    expect(rows.some((m) => m.meta.replyChips)).toBe(false);
    expect(rows.filter((m) => m.authorType === "agent")).toHaveLength(1);
  });

  test("a personal workspace lists templates for one person's life, each agent in its DM with no channel", async () => {
    f = await setup({ rightHand: true });
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { mode: "personal" });
    const list = await listTeamTemplates({ db: f.db }, f.owner.id, f.org.id, "pt-BR");
    expect(list.map((t) => t.id)).toEqual([...PERSONAL_TEMPLATES]);
    const life = list.find((t) => t.id === "life");
    expect(life?.name).toBe("Vida em ordem");
    expect(life?.team.agents.map((a) => [a.name, a.channel])).toEqual([
      ["Clara", ""],
      ["Duda", ""],
    ]);
    for (const t of list) {
      expect(t.team.newChannels).toEqual([]);
      expect(t.team.agents.every((a) => a.channel === "" && a.routines.length === 1)).toBe(true);
      // The weekly check reports on a team's work: not one person's agents.
      expect(t.team.weekly).toBeNull();
    }
  });

  test("Create my agents in a personal workspace: no channel is made, routines report in each agent's DM", async () => {
    f = await setup({ rightHand: true });
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { mode: "personal" });
    const channelsBefore = await f.db.select().from(schema.channels).where(eq(schema.channels.orgId, f.org.id));
    const used = await useTeamTemplate({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "life", "pt-BR");
    expect(used).toMatchObject({ state: "created", error: null });
    const card = await cardOf(f, used.messageId);
    expect(card.created?.agentIds).toHaveLength(2);
    expect(card.created?.channelIds).toEqual([]);
    const ids = card.created?.agentIds ?? [];
    const channelsAfter = await f.db.select().from(schema.channels).where(eq(schema.channels.orgId, f.org.id));
    // Only the right hand's DM with the person, where the card went, may be new.
    const places = (rows: { kind: string }[]) => rows.filter((c) => c.kind !== "dm").length;
    expect(places(channelsAfter)).toBe(places(channelsBefore));
    const memberships = await f.db
      .select()
      .from(schema.channelMembers)
      .where(inArray(schema.channelMembers.agentId, ids));
    expect(memberships).toEqual([]);
    const routines = await f.db.select().from(schema.routines).where(inArray(schema.routines.agentId, ids));
    expect(routines.map((r) => r.target)).toEqual([{ type: "dm" }, { type: "dm" }]);
  });

  test("a personal template works in a team's workspace too: the mode only picks the gallery's list", async () => {
    f = await setup({ rightHand: true });
    const used = await useTeamTemplate({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "health", "en");
    expect(used).toMatchObject({ state: "created", error: null });
    expect((await cardOf(f, used.messageId)).params.agents.map((a) => a.name)).toEqual(["Léo", "Mel"]);
  });
});
