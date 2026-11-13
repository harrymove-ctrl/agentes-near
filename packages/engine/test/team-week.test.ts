import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema, sql } from "@agenteschat/db";
import { en, STRINGS } from "@agenteschat/i18n";
import {
  actOnTeamWeek,
  createSetupToolSource,
  createToolGateway,
  decideProposal,
  enqueueTeamWeeks,
  getTeamWeekPrefs,
  insertMessage,
  lastTeamWeekSlot,
  notifyMessage,
  openPersonAgentDm,
  postPersonMessage,
  postTeamWeek,
  RIGHT_HAND,
  requestKey,
  SET_TEAM_WEEK_TOOL,
  setTeamWeekPrefs,
  TEAM_WEEK_DEFAULTS,
  TEAM_WEEK_JOB,
  type TeamWeekCard,
  teamWeekCardOf,
  teamWeekPrefsOf,
  weekKey,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ZONE = "America/Sao_Paulo";
/** Friday 2026-11-06, 17:00 in São Paulo (UTC-3). */
const SLOT = new Date("2026-11-06T20:00:00Z");

const lodiOf = async (fx: Fixture) => {
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

async function inZone(fx: Fixture) {
  await fx.db
    .insert(schema.organizationSettings)
    .values({ orgId: fx.org.id, timezone: ZONE })
    .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { timezone: ZONE } });
}

const jobs = (fx: Fixture) => fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, TEAM_WEEK_JOB));

const run = (fx: Fixture, agentId: string, at: Date, status: "done" | "failed", error?: string) =>
  fx.db.insert(schema.agentRuns).values({
    orgId: fx.org.id,
    agentId,
    channelId: fx.general.id,
    threadRootId: crypto.randomUUID(),
    triggerMessageId: crypto.randomUUID(),
    trigger: "mention",
    hop: 1,
    status,
    error: error ?? null,
    createdAt: at,
  });

/** A run that parked at its budget and has since resumed: only its "budget ran out" note is left. */
const budgetStop = (fx: Fixture, at: Date) =>
  insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author: { type: "agent", agentId: fx.agent.id, runId: null, hop: 1, stretchId: null },
    body: "My budget for the month ran out.",
    meta: { bodyCode: "budget_wait", usageWait: { code: "budget", runId: crypto.randomUUID() } },
    createdAt: at,
  });

describe("when it comes", () => {
  test("Friday at 17h in the workspace's zone by default; one card per person and week", () => {
    const prefs = teamWeekPrefsOf({});
    expect(prefs).toEqual({ off: false, day: 5, hour: 17, daily: false });
    expect(teamWeekPrefsOf({ day: 9, hour: -1, off: "yes" })).toEqual(prefs);
    expect(lastTeamWeekSlot(prefs, ZONE, new Date(SLOT.getTime() + HOUR))?.toISOString()).toBe(SLOT.toISOString());
    // Before the slot: last week's.
    expect(lastTeamWeekSlot(prefs, ZONE, new Date(SLOT.getTime() - HOUR))?.toISOString()).toBe(
      new Date(SLOT.getTime() - 7 * DAY).toISOString(),
    );
    // Moved to Monday 9h, the same week: the same key, so no second card.
    const monday = lastTeamWeekSlot({ off: false, day: 1, hour: 9, daily: false }, ZONE, SLOT);
    expect(monday && weekKey(monday, ZONE)).toBe(weekKey(SLOT, ZONE));
    expect(weekKey(SLOT, ZONE)).toBe("2026-11-02");
  });

  test("requests read the same without accents, mentions or punctuation", () => {
    expect(requestKey("@dev Manda o resumo do dia!")).toBe(requestKey("manda o RESUMO do dia"));
    expect(requestKey("ok")).toBeNull();
  });

  test("queued for admins of a workspace with a team, once, and never when off or before there is a team", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const member = await addMember(f.db, f.org.id, "member", "bia");
    const at = new Date(SLOT.getTime() + HOUR);
    expect(await enqueueTeamWeeks(f.db, at)).toBe(1);
    await enqueueTeamWeeks(f.db, new Date(at.getTime() + HOUR));
    const queued = await jobs(f);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toEqual({ userId: f.owner.id, slot: SLOT.toISOString() });
    expect(queued.some((j) => (j.payload as { userId: string }).userId === member.id)).toBe(false);
    // A slot missed by more than a few hours waits for next week.
    expect(await enqueueTeamWeeks(f.db, new Date(SLOT.getTime() + DAY))).toBe(0);

    await setTeamWeekPrefs(f.db, f.org.id, f.owner.id, { off: true });
    expect(await enqueueTeamWeeks(f.db, new Date(at.getTime() + 7 * DAY))).toBe(0);
    await setTeamWeekPrefs(f.db, f.org.id, f.owner.id, { off: false });
    // No agent but Lodi: no team, no card.
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
    expect(await enqueueTeamWeeks(f.db, new Date(at.getTime() + 7 * DAY))).toBe(0);
  });
});

describe("the card", () => {
  async function busyWeek(fx: Fixture) {
    await inZone(fx);
    const lodi = await lodiOf(fx);
    const day = (n: number) => new Date(SLOT.getTime() - n * DAY);
    for (let i = 0; i < 4; i++) await run(fx, fx.agent.id, day(1), "done");
    await run(fx, fx.agent.id, day(2), "failed", "provider_error");
    await budgetStop(fx, day(2));
    // An agent made last week and put in no channel.
    const [lia] = await fx.db
      .insert(schema.agents)
      .values({
        orgId: fx.org.id,
        name: "Lia",
        handle: "lia",
        role: "Research",
        instructions: "",
        model: "claude-sonnet-5-5",
        ownerUserId: fx.owner.id,
        createdAt: day(5),
      })
      .returning();
    // Three questions nobody answered in #general.
    for (const n of [2, 3, 4])
      await insertMessage(fx.db, {
        orgId: fx.org.id,
        channelId: fx.general.id,
        author: { type: "person", userId: fx.owner.id },
        body: `Alguém sabe emitir nota fiscal ${n}?`,
        createdAt: day(n),
      });
    // The same request typed to Dev in their DM on three days, around 18h.
    const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, fx.agent.id);
    for (const n of [1, 2, 3])
      await insertMessage(fx.db, {
        orgId: fx.org.id,
        channelId: dm.id,
        author: { type: "person", userId: fx.owner.id },
        body: n === 1 ? "Manda o resumo do dia, por favor" : "manda o resumo do dia por favor!",
        createdAt: new Date(day(n).getTime() + HOUR),
      });
    // A plan whose steps 2 and 3 wait while step 1 is in review.
    const [parent] = await fx.db
      .insert(schema.issues)
      .values({
        orgId: fx.org.id,
        number: 10,
        title: "Skills do time",
        assigneeType: "agent",
        assigneeId: fx.agent.id,
        createdByType: "person",
        createdById: fx.owner.id,
      })
      .returning();
    const step = (number: number, status: "todo" | "in_review") => ({
      orgId: fx.org.id,
      number,
      title: `Bloco ${number - 10}`,
      status,
      parentIssueId: parent?.id,
      createdByType: "person",
      createdById: fx.owner.id,
      updatedAt: new Date(SLOT.getTime() - 5 * HOUR),
    });
    await fx.db.insert(schema.issues).values([step(11, "in_review"), step(12, "todo"), step(13, "todo")]);
    return { lodi, lia, dm, parent };
  }

  const cardOf = async (fx: Fixture, messageId: string) => {
    const [m] = await fx.db.select().from(schema.messages).where(eq(schema.messages.id, messageId));
    const card = teamWeekCardOf(m?.meta);
    if (!m || !card) throw new Error("no card");
    return { m, card };
  };

  test("posted in the admin's DM with Lodi from stored data, each fix a row, once a week", async () => {
    f = await setup({ rightHand: true });
    const { lodi, lia, parent } = await busyWeek(f);
    const id = await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, {
      userId: f.owner.id,
      slot: SLOT.toISOString(),
    });
    expect(id).not.toBeNull();
    const { m, card } = await cardOf(f, id as string);
    expect(m.authorAgentId).toBe(lodi.id);
    // Written in the person's language: the push and the conversation list read it.
    expect(m.body).toBe("Sua semana da equipe está pronta");
    expect(m.meta.bodyCode).toBe("team_week");
    expect(card.from).toBe("2026-10-30");
    expect(card.to).toBe("2026-11-06");
    expect(card.stats.done).toBe(4);
    expect(card.stats.stuck).toBe(1);
    expect(card.worked).toEqual([{ kind: "runs", agentId: f.agent.id, channelId: f.general.id, count: 4 }]);
    const kinds = card.rows.map((r) => r.kind);
    expect(kinds).toEqual(["budget", "channel", "unanswered", "routine", "stalled"]);
    const budget = card.rows.find((r) => r.kind === "budget");
    expect(budget).toMatchObject({ agentId: f.agent.id, from: 50_000_000_000, to: 75_000_000_000, stops: 1 });
    expect(card.rows.find((r) => r.kind === "channel")).toMatchObject({ agentId: lia?.id, channelId: f.general.id });
    expect(card.rows.find((r) => r.kind === "unanswered")).toMatchObject({ channelId: f.general.id, count: 3 });
    expect(card.rows.find((r) => r.kind === "routine")).toMatchObject({
      agentId: f.agent.id,
      dm: true,
      hour: 18,
      count: 3,
    });
    expect(card.rows.find((r) => r.kind === "stalled")).toMatchObject({
      issueId: parent?.id,
      steps: [12, 13],
      onNumber: 11,
      hours: 5,
      agentId: f.agent.id,
    });
    expect(card.proposalIds).toHaveLength(2);
    // The job runs twice after a lease expiry: one card.
    expect(
      await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: f.owner.id, slot: SLOT.toISOString() }),
    ).toBeNull();
    // Notified like any agent's message in a DM.
    const [notice] = await f.db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.kind, "notifications.message"), sql`${schema.outbox.payload}->>'messageId' = ${id}`));
    expect(notice).toBeDefined();
    await notifyMessage({ db: f.db, pubsub: f.pubsub }, f.org.id, id as string);
    const inbox = await f.db.select().from(schema.notifications).where(eq(schema.notifications.userId, f.owner.id));
    expect(inbox.map((n) => n.kind)).toContain("agent_reply");
  });

  test("a personal workspace's card says the week is the person's own (ADR 0159)", async () => {
    f = await setup({ rightHand: true });
    await busyWeek(f);
    await f.db
      .update(schema.organizationSettings)
      .set({ mode: "personal" })
      .where(eq(schema.organizationSettings.orgId, f.org.id));
    const id = await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, {
      userId: f.owner.id,
      slot: SLOT.toISOString(),
    });
    const { m } = await cardOf(f, id as string);
    expect(m.body).toBe("Sua semana está pronta");
  });

  test("a quiet week says nothing, and a member never gets one", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    expect(
      await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: f.owner.id, slot: SLOT.toISOString() }),
    ).toBeNull();
    const member = await addMember(f.db, f.org.id, "member", "bia");
    await run(f, f.agent.id, new Date(SLOT.getTime() - DAY), "done");
    expect(
      await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: member.id, slot: SLOT.toISOString() }),
    ).toBeNull();
  });

  test("a busy week whose workspace began being deleted since it was queued posts nothing", async () => {
    f = await setup({ rightHand: true });
    await busyWeek(f);
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(Date.now() + 7 * DAY) })
      .where(eq(schema.organizations.id, f.org.id));
    expect(
      await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: f.owner.id, slot: SLOT.toISOString() }),
    ).toBeNull();
  });

  test("rows apply as whoever clicks: the budget with Undo on the card, a routine, Lodi asked, the task's agent told", async () => {
    f = await setup({ rightHand: true });
    const { lodi, dm, parent } = await busyWeek(f);
    const id = (await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, {
      userId: f.owner.id,
      slot: SLOT.toISOString(),
    })) as string;
    const { card } = await cardOf(f, id);
    const row = (kind: TeamWeekCard["rows"][number]["kind"]) => {
      const r = card.rows.find((x) => x.kind === kind);
      if (!r) throw new Error(`no ${kind}`);
      return r;
    };

    // The budget, through the settings card's own path: applied, with its receipt (Undo) on this message.
    const budget = row("budget") as Extract<TeamWeekCard["rows"][number], { kind: "budget" }>;
    await decideProposal(f.db, f.owner.id, f.org.id, budget.proposalId, "accept", { pubsub: f.pubsub });
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(agent?.monthlyBudgetNanoUsd).toBe(75_000_000_000);
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.messageId, id));
    expect(receipt?.kind).toBe("agent.settings_changed");
    expect(receipt?.runId).toBeNull();

    // A daily routine at the hour it was asked, posting in the DM it was asked in.
    const deps = { db: f.db, pubsub: f.pubsub };
    const done = await actOnTeamWeek(deps, f.owner.id, f.org.id, id, { rowId: row("routine").id });
    const routineId = done.done[row("routine").id]?.routineId;
    const [routine] = await f.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, routineId ?? ""));
    expect(routine).toMatchObject({ agentId: f.agent.id, target: { type: "dm" }, report: "always" });
    expect(routine?.rule).toMatchObject({ freq: "daily", times: ["18:00"], timezone: ZONE });
    await expect(actOnTeamWeek(deps, f.owner.id, f.org.id, id, { rowId: row("routine").id })).rejects.toThrow();

    // Lodi asked for an agent, as the person, in their DM with it.
    await actOnTeamWeek(deps, f.owner.id, f.org.id, id, {
      rowId: row("unanswered").id,
      text: "Proponha um agente para as perguntas de #general.",
    });
    const lodiDm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
    const asked = await f.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.channelId, lodiDm.id), eq(schema.messages.authorUserId, f.owner.id)));
    expect(asked.map((m) => m.body)).toEqual(["Proponha um agente para as perguntas de #general."]);

    // The stalled task's agent told to go on, in the task's conversation.
    await actOnTeamWeek(deps, f.owner.id, f.org.id, id, {
      rowId: row("stalled").id,
      text: "@dev os passos #12 e #13 não precisam esperar o #11.",
    });
    const [task] = await f.db
      .select()
      .from(schema.issues)
      .where(eq(schema.issues.id, parent?.id ?? ""));
    const said = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.channelId, task?.conversationChannelId ?? ""));
    expect(said.some((m) => m.body.startsWith("@dev os passos"))).toBe(true);

    // Rows with their own card aren't applied here; nobody else acts on the card; "Agora não" puts it away.
    await expect(actOnTeamWeek(deps, f.owner.id, f.org.id, id, { rowId: row("channel").id })).rejects.toThrow();
    const other = await addMember(f.db, f.org.id, "admin", "caio");
    await expect(actOnTeamWeek(deps, other.id, f.org.id, id, { dismiss: true })).rejects.toThrow();
    expect((await actOnTeamWeek(deps, f.owner.id, f.org.id, id, { dismiss: true })).dismissedAt).not.toBeNull();
    expect(dm.id).not.toBe(lodiDm.id);
  });

  test("next week's fix replaces last week's open one: its Undo lands on the card it was applied from", async () => {
    f = await setup({ rightHand: true });
    await busyWeek(f);
    const post = (slot: Date) =>
      postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: f.owner.id, slot: slot.toISOString() });
    const first = (await post(SLOT)) as string;
    const next = new Date(SLOT.getTime() + 7 * DAY);
    await budgetStop(f, new Date(next.getTime() - DAY));
    const second = (await post(next)) as string;
    const budgetOf = async (id: string) => {
      const r = (await cardOf(f, id)).card.rows.find((x) => x.kind === "budget");
      if (r?.kind !== "budget") throw new Error("no budget row");
      return r;
    };
    const [old, fresh] = [await budgetOf(first), await budgetOf(second)];
    expect(fresh.proposalId).not.toBe(old.proposalId);
    const [was] = await f.db
      .select()
      .from(schema.contextProposals)
      .where(eq(schema.contextProposals.id, old.proposalId));
    expect(was?.status).toBe("stale");
    await decideProposal(f.db, f.owner.id, f.org.id, fresh.proposalId, "accept", { pubsub: f.pubsub });
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.messageId, second));
    expect(receipt?.kind).toBe("agent.settings_changed");
  });

  test("telling Lodi to stop it: set_team_week, for the person behind the run", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "para de mandar o resumo da semana",
    });
    const [r] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
    const gateway = createToolGateway({ sources: [createSetupToolSource({ pubsub: f.pubsub })] });
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: lodi.id,
      runId: r?.id ?? "",
      channelId: dm.id,
      threadRootId: r?.threadRootId ?? trigger.id,
      triggerMessageId: trigger.id,
    };
    const res = await gateway.invoke(ctx, { toolUseId: "tu_1", name: SET_TEAM_WEEK_TOOL, input: { off: true } });
    expect(res.type).toBe("result");
    expect((await getTeamWeekPrefs(f.db, f.org.id, f.owner.id)).off).toBe(true);
    await gateway.invoke(ctx, {
      toolUseId: "tu_2",
      name: SET_TEAM_WEEK_TOOL,
      input: { off: false, day: "monday", hour: 9 },
    });
    expect(await getTeamWeekPrefs(f.db, f.org.id, f.owner.id)).toMatchObject({ off: false, day: 1, hour: 9 });
  });
});

describe("Resumo do dia", () => {
  /** Friday 2026-11-06, 09:00 in São Paulo (UTC-3). */
  const NINE = new Date("2026-11-06T12:00:00Z");
  const cardOf = async (fx: Fixture, messageId: string) => {
    const [m] = await fx.db.select().from(schema.messages).where(eq(schema.messages.id, messageId));
    const card = teamWeekCardOf(m?.meta);
    if (!m || !card) throw new Error("no card");
    return { m, card };
  };

  test("every day at its hour, over the last day, for anyone who asks; one card per person and day", async () => {
    const prefs = teamWeekPrefsOf({ daily: true, hour: 9 });
    expect(prefs.daily).toBe(true);
    expect(lastTeamWeekSlot(prefs, ZONE, new Date(NINE.getTime() + HOUR))?.toISOString()).toBe(NINE.toISOString());
    expect(lastTeamWeekSlot(prefs, ZONE, new Date(NINE.getTime() - HOUR))?.toISOString()).toBe(
      new Date(NINE.getTime() - DAY).toISOString(),
    );

    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await setTeamWeekPrefs(f.db, f.org.id, f.owner.id, { off: true });
    expect(await enqueueTeamWeeks(f.db, new Date(NINE.getTime() + HOUR))).toBe(0);
    await setTeamWeekPrefs(f.db, f.org.id, bia.id, { daily: true, hour: 9 });
    expect(await enqueueTeamWeeks(f.db, new Date(NINE.getTime() + HOUR))).toBe(1);
    await enqueueTeamWeeks(f.db, new Date(NINE.getTime() + 2 * HOUR));
    expect(await jobs(f)).toHaveLength(1);
    expect(await enqueueTeamWeeks(f.db, new Date(NINE.getTime() + DAY + HOUR))).toBe(1);
    expect(await jobs(f)).toHaveLength(2);
  });

  test("a member's card counts only work where they read and no money; a quiet day posts nothing", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const slot = NINE.toISOString();
    await setTeamWeekPrefs(f.db, f.org.id, bia.id, { daily: true, hour: 9 });
    expect(await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: bia.id, slot })).toBeNull();

    await run(f, f.agent.id, new Date(NINE.getTime() - 2 * HOUR), "done");
    // A day earlier than the card's: outside it.
    await run(f, f.agent.id, new Date(NINE.getTime() - 2 * DAY), "done");
    const hidden = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "diretoria", kind: "channel", visibility: "private" })
      .returning();
    await f.db.insert(schema.agentRuns).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: hidden[0]?.id ?? "",
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
      trigger: "mention",
      hop: 1,
      status: "done",
      createdAt: new Date(NINE.getTime() - HOUR),
    });
    const id = await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: bia.id, slot });
    expect(id).not.toBeNull();
    const { m, card } = await cardOf(f, id as string);
    expect(card.period).toBe("day");
    expect(card.from).toBe("2026-11-05");
    expect(card.to).toBe("2026-11-06");
    expect(card.stats.done).toBe(1);
    expect(card.stats.spentNanoUsd).toBe(0);
    expect(card.stats.budgetNanoUsd).toBe(0);
    expect(m.body).toBe("Seu resumo do dia está pronto");
    // Once a day.
    expect(await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: bia.id, slot })).toBeNull();
    // Turned off: nothing.
    await setTeamWeekPrefs(f.db, f.org.id, bia.id, { daily: false });
    expect(
      await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, {
        userId: bia.id,
        slot: new Date(NINE.getTime() + DAY).toISOString(),
      }),
    ).toBeNull();
  });

  test("a member's card offers no budget raise and leaves no proposal it couldn't show", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await setTeamWeekPrefs(f.db, f.org.id, bia.id, { daily: true, hour: 9 });
    await run(f, f.agent.id, new Date(NINE.getTime() - 2 * HOUR), "done");
    await budgetStop(f, new Date(NINE.getTime() - HOUR));
    const id = await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, {
      userId: bia.id,
      slot: NINE.toISOString(),
    });
    expect(id).not.toBeNull();
    const { card } = await cardOf(f, id as string);
    expect(card.rows.map((r) => r.kind)).not.toContain("budget");
    expect(await f.db.select().from(schema.contextProposals)).toEqual([]);
  });

  test("asked of Lodi: set_team_week turns it on for the person behind the run", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const lodi = await lodiOf(f);
    const dm = await openPersonAgentDm(f.db, f.org.id, bia.id, lodi.id);
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, dm.id, {
      body: "me manda isso todo dia às 9h",
    });
    const [r] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
    const gateway = createToolGateway({ sources: [createSetupToolSource({ pubsub: f.pubsub })] });
    const res = await gateway.invoke(
      {
        db: f.db,
        orgId: f.org.id,
        agentId: lodi.id,
        runId: r?.id ?? "",
        channelId: dm.id,
        threadRootId: r?.threadRootId ?? trigger.id,
        triggerMessageId: trigger.id,
      },
      { toolUseId: "tu_1", name: SET_TEAM_WEEK_TOOL, input: { daily: true, hour: 9 } },
    );
    if (res.type !== "result") throw new Error(res.type);
    expect((res.output as { content: string }).content).toContain("Resumo do dia");
    expect(await getTeamWeekPrefs(f.db, f.org.id, bia.id)).toMatchObject({ off: false, daily: true, hour: 9 });
  });
});

test("Lodi's settings name what it posts unasked: Team week, on by default, in every language", () => {
  expect(TEAM_WEEK_DEFAULTS.off).toBe(false);
  for (const [code, strings] of Object.entries(STRINGS)) {
    const words = strings as {
      rightHand?: { settings?: Record<string, string> };
      teamWeek?: { settings?: { label?: string } };
    };
    const label = words.teamWeek?.settings?.label ?? en.teamWeek.settings.label;
    expect(label).not.toBe("");
    const lines = Object.entries(words.rightHand?.settings ?? {}).filter(([k]) => /^lock(_female)?$/.test(k));
    for (const [key, line] of lines)
      expect({ code, key, names: line.includes(label) }).toEqual({ code, key, names: true });
  }
});
