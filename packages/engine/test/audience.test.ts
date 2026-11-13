import { afterEach, describe, expect, test } from "bun:test";
import { BRAIN_PROTOCOL, createFakeEmailSender, userTopic } from "@agenteschat/adapters";
import { eq, rowsOf, schema, sql } from "@agenteschat/db";
import {
  acceptInvitation,
  addChannelMember,
  audienceOf,
  audienceSql,
  canTalkTo,
  createAgent,
  createJobHandlers,
  createOrganization,
  createRole,
  createRoutine,
  dispatchMentions,
  drainOutbox,
  emailArtAt,
  executeRoutineRun,
  ForbiddenError,
  getAgentBrain,
  getTeam,
  insertMessageWithRuns,
  inviteMany,
  listAgents,
  listRoutines,
  NO_PERSON,
  NotFoundError,
  openDm,
  PLAN_OPENED_JOB,
  postPersonMessage,
  type RouterStrategy,
  removeMember,
  routeMessage,
  setAgentAudience,
  setAgentBrain,
  setInvitationRoles,
  setMemberRoles,
  speakerFor,
  updateAgent,
  updateOrgSettings,
  ValidationError,
} from "../src";
import { addMember, addUser, type Fixture, makeAdmin, SECRET, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** ana owns @dev; bia is a member in #general. */
async function world() {
  f = await setup({ reply: () => ({ chunks: ["ok"] }) });
  await f.db.update(schema.agents).set({ ownerUserId: f.owner.id }).where(eq(schema.agents.id, f.agent.id));
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  return { bia };
}

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const runsOf = async (messageId: string) =>
  (await f.db.select().from(schema.agentRuns)).filter((r) => r.triggerMessageId === messageId);

describe("who can talk to the agent", () => {
  test("an admin sees and manages another admin's agent kept to a role they don't hold; a member outside sees its card", async () => {
    const { bia } = await world();
    const walt = await addMember(f.db, f.org.id, "admin", "walt");
    const caio = await addMember(f.db, f.org.id, "admin", "caio");
    const support = await createRole(f.db, f.owner.id, f.org.id, { name: "Suporte" });
    await f.db.update(schema.agents).set({ ownerUserId: walt.id }).where(eq(schema.agents.id, f.agent.id));
    await setAgentAudience(f.db, walt.id, f.org.id, f.agent.id, { mode: "people", userIds: [], roleIds: [support.id] });
    const card = async (userId: string) =>
      (await getTeam(f.db, userId, f.org.id)).agents.find((a) => a.id === f.agent.id);

    for (const admin of [caio, f.owner]) {
      expect((await listAgents(f.db, admin.id, f.org.id)).map((a) => a.id)).toContain(f.agent.id);
      expect(await card(admin.id)).toMatchObject({ seesDetails: true, canTalk: false });
      // Its conversation opens (the apps lock the composer and offer to let them in) instead of a refusal.
      expect((await openDm(f.db, admin.id, f.org.id, { agentId: f.agent.id })).kind).toBe("dm");
    }
    expect((await updateAgent(f.db, caio.id, f.org.id, f.agent.id, { role: "Suporte nível 2" })).role).toBe(
      "Suporte nível 2",
    );
    // Letting themselves in is theirs to do: then it answers them.
    await setAgentAudience(f.db, caio.id, f.org.id, f.agent.id, {
      mode: "people",
      userIds: [caio.id],
      roleIds: [support.id],
    });
    expect((await card(caio.id))?.canTalk).toBe(true);

    // A member whose role manages agents, without being an admin: the same as an admin.
    const managers = await createRole(f.db, f.owner.id, f.org.id, { name: "Gestores", permissions: ["manage_agents"] });
    const lia = await addMember(f.db, f.org.id, "member", "lia");
    await setMemberRoles(f.db, f.owner.id, f.org.id, lia.id, [managers.id]);
    expect(await card(lia.id)).toMatchObject({ seesDetails: true, canTalk: false });
    const liaDm = await openDm(f.db, lia.id, f.org.id, { agentId: f.agent.id });
    expect(liaDm.kind).toBe("dm");
    // Seeing it isn't talking to it: what they write there starts no run.
    const sent = await postPersonMessage(deps(), lia.id, f.org.id, liaDm.id, { body: "oi" });
    await drainOutbox(f.db, f.handlers);
    expect(await runsOf(sent.id)).toEqual([]);

    // A member outside it: its public card, no conversation.
    expect(await card(bia.id)).toMatchObject({ seesDetails: false, canTalk: false, capabilities: [] });
    await expect(openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id })).rejects.toMatchObject({
      code: "audience.only",
    });
  });

  test("default is everyone; owner or admins change it (members can't), audited; members must be in the org", async () => {
    const { bia } = await world();
    const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(row).toMatchObject({ audienceMode: "everyone", audienceUserIds: [] });
    await expect(
      setAgentAudience(f.db, bia.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // bia owns another agent: she can restrict it without being an admin.
    const hers = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Bot", handle: "bot", ownerUserId: bia.id },
      { model: "claude-sonnet-5-5" },
    );
    expect((await setAgentAudience(f.db, bia.id, f.org.id, hers.id, { mode: "owner", userIds: [] })).audienceMode).toBe(
      "owner",
    );
    const zed = await addUser(f.db, "zed");
    const updated = await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, {
      mode: "people",
      userIds: [bia.id, zed.id],
    });
    expect(updated.audienceUserIds).toEqual([bia.id]);
    expect(canTalkTo(updated, bia.id, NO_PERSON)).toBe(true);
    expect(canTalkTo(updated, f.owner.id, NO_PERSON)).toBe(true); // the owner always can
    const audit = (await f.db.select().from(schema.auditLog)).filter((a) => a.action === "agent.audience_changed");
    expect(audit).toHaveLength(2);
    // Another organization can't touch it.
    const { organization } = await createOrganization(f.db, zed.id, { name: "Outra" });
    await expect(
      setAgentAudience(f.db, zed.id, organization.id, f.agent.id, { mode: "everyone", userIds: [] }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a personal workspace's new agent answers only its owner; one given an audience, or none, and those there keep theirs", async () => {
    const { bia } = await world();
    const model = { model: "claude-sonnet-5-5" };
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { mode: "personal" });
    const mine = await createAgent(f.db, f.owner.id, f.org.id, { name: "Casa", handle: "casa" }, model);
    // Made while the person was alone: whoever joins later isn't answered until its owner says so (ADR 0159).
    expect(mine).toMatchObject({ audienceMode: "owner", audienceUserIds: [], ownerUserId: f.owner.id });
    expect(canTalkTo(mine, f.owner.id, NO_PERSON)).toBe(true);
    expect(canTalkTo(mine, bia.id, NO_PERSON)).toBe(false);
    // Only a default: an audience given wins, and with no owner it answers everyone, as in a team's.
    const open = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Aberto", handle: "aberto", audienceMode: "everyone" },
      model,
    );
    expect(open.audienceMode).toBe("everyone");
    const nobodys = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Geral", handle: "geral", ownerUserId: null },
      model,
    );
    expect(nobodys.audienceMode).toBe("everyone");
    // The agent already there keeps its own.
    const [before] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(before?.audienceMode).toBe("everyone");
    // Back to a team's: a new agent answers everyone again.
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { mode: "team" });
    const team = await createAgent(f.db, f.owner.id, f.org.id, { name: "Time", handle: "time" }, model);
    expect(team.audienceMode).toBe("everyone");
  });

  test("a personal workspace's new agent starts with every connected app and the calendar; a team's does not", async () => {
    await world();
    const model = { model: "claude-sonnet-5-5" };
    const [app] = await f.db
      .insert(schema.connectorConnections)
      .values({
        orgId: f.org.id,
        connector: "linear",
        toolPrefix: "linear",
        label: "Linear",
        serverUrl: "https://linear.example.com/mcp",
        authType: "none",
      })
      .returning();
    const grantsOf = async (agentId: string) =>
      (await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.agentId, agentId))).map(
        (g) => `${g.connectionId ?? "-"} ${g.scope}`,
      );
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { mode: "personal" });
    const mine = await createAgent(f.db, f.owner.id, f.org.id, { name: "Casa", handle: "casa" }, model);
    // ADR 0159 §3a: broad by default; sensitive tools still ask on every call.
    expect(await grantsOf(mine.id)).toEqual(
      expect.arrayContaining([`${app?.id} connector:*`, "- calendar:read", "- calendar:write"]),
    );
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { mode: "team" });
    const team = await createAgent(f.db, f.owner.id, f.org.id, { name: "Time", handle: "time" }, model);
    const teamGrants = await grantsOf(team.id);
    expect(teamGrants).not.toContain(`${app?.id} connector:*`);
    expect(teamGrants).not.toContain("- calendar:write");
  });

  test("removing the last person keeps it restricted: only its owner, never everyone", async () => {
    const { bia } = await world();
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "people", userIds: [bia.id] });
    const emptied = await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "people", userIds: [] });
    expect(emptied).toMatchObject({ audienceMode: "people", audienceUserIds: [] });
    expect([canTalkTo(emptied, f.owner.id, NO_PERSON), canTalkTo(emptied, bia.id, NO_PERSON)]).toEqual([true, false]);
  });

  test("someone invited with a role changed before accepting can be given the agent; one who left drops out", async () => {
    const { bia } = await world();
    const support = await createRole(f.db, f.owner.id, f.org.id, { name: "Suporte" });
    const [sent] = await inviteMany(f.db, f.owner.id, f.org.id, { emails: ["teo@example.com"], secret: SECRET });
    if (sent?.status !== "invited") throw new Error("expected an invitation");
    await setInvitationRoles(f.db, f.owner.id, f.org.id, sent.invitationId, [support.id]);
    await f.db.insert(schema.users).values({ id: "u_teo", name: "Teo", email: "teo@example.com" });
    await acceptInvitation(f.db, { id: "u_teo", email: "teo@example.com" }, sent.token);
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "people", userIds: [bia.id] });
    // bia leaves: her id no longer stays on the agent, and the list the apps still hold is saved without her.
    await removeMember(f.db, bia.id, f.org.id, bia.id);
    const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(row?.audienceUserIds).toEqual([]);
    const updated = await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, {
      mode: "people",
      userIds: [bia.id, "u_teo"],
    });
    expect(updated.audienceUserIds).toEqual(["u_teo"]);
  });

  test("the migration takes people no longer in the workspace off the agents' lists, keeping the order", async () => {
    const { bia } = await world();
    const cid = await addMember(f.db, f.org.id, "member", "cid");
    const gone = await addUser(f.db, "gone");
    const stale = [cid.id, gone.id, bia.id];
    await f.db.update(schema.agents).set({ audienceMode: "people", audienceUserIds: stale });
    const file = await Bun.file(new URL("../../db/migrations/0162_agent_audience_members.sql", import.meta.url)).text();
    await f.db.execute(sql.raw(file));
    await f.db.execute(sql.raw(file));
    const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(row?.audienceUserIds).toEqual([cid.id, bia.id]);
  });

  test("a mention from someone not allowed starts nothing and only they get the notice", async () => {
    const { bia } = await world();
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] });
    const heard: unknown[] = [];
    f.pubsub.subscribe(userTopic(f.org.id, bia.id), (e) => heard.push(e));
    const sent = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@dev faz o relatório" });
    expect(await runsOf(sent.id)).toEqual([]);
    expect(sent.notices).toEqual([
      {
        agentId: f.agent.id,
        text: "Dev only replies to ana.",
        code: "audience.only",
        params: { agentId: f.agent.id, agentName: "Dev", userIds: [f.owner.id], roleIds: [], names: ["ana"] },
      },
    ]);
    await Bun.sleep(5);
    expect(heard).toContainEqual(
      expect.objectContaining({ type: "agent.unavailable", agentId: f.agent.id, text: "Dev only replies to ana." }),
    );
    await drainOutbox(f.db, f.handlers);
    expect(await runsOf(sent.id)).toEqual([]);
    const mine = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@dev faz o relatório" });
    expect(await runsOf(mine.id)).toHaveLength(1);
    expect(mine.notices).toBeUndefined();
  });

  test("an agent nobody may talk to (no owner, only its owner) still tells whoever mentions it", async () => {
    const { bia } = await world();
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: null, audienceMode: "owner" })
      .where(eq(schema.agents.id, f.agent.id));
    const sent = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@dev faz o relatório" });
    expect(sent.notices).toMatchObject([{ code: "audience.nobody", text: "Dev isn't replying to anyone right now." }]);
    expect(await runsOf(sent.id)).toEqual([]);
  });

  test("a DM can't be started by someone not allowed; in an old DM their messages start nothing", async () => {
    const { bia } = await world();
    const dm = await openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id }); // before the change
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "people", userIds: [] });
    const sent = await postPersonMessage(deps(), bia.id, f.org.id, dm.id, { body: "oi" });
    expect(await runsOf(sent.id)).toEqual([]);
    expect(sent.notices?.[0]?.text).toBe("Dev only replies to ana.");
    await drainOutbox(f.db, f.handlers);
    expect(await runsOf(sent.id)).toEqual([]);
    const cara = await addMember(f.db, f.org.id, "member", "cara");
    await expect(openDm(f.db, cara.id, f.org.id, { agentId: f.agent.id })).rejects.toMatchObject({
      code: "audience.only",
      params: { agentName: "Dev", names: ["ana"] },
    });
    expect((await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).kind).toBe("dm");
  });

  test("the router never offers an agent the author can't talk to (also not as the follow-up agent)", async () => {
    const { bia } = await world();
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] });
    const seen: string[][] = [];
    const strategy: RouterStrategy = {
      name: "fixed",
      async decide(input) {
        seen.push(input.candidates.map((c) => c.handle));
        return { agents: input.candidates.map((c) => ({ agentId: c.agentId, score: 1 })), reason: "test" };
      },
    };
    const policy = { minScore: 0.5, maxAgents: 2, maxHops: 3 };
    const route = async (userId: string, body: string, threadId?: string) => {
      const m = await postPersonMessage(deps(), userId, f.org.id, f.general.id, { body, threadId });
      return routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: m.id });
    };
    const theirs = await route(bia.id, "alguém pode revisar o deploy?");
    expect(theirs.runs).toEqual([]);
    expect(theirs.skipped).toBe("no_candidates");
    const root = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@dev revisa o deploy" });
    await drainOutbox(f.db, f.handlers);
    // bia's short follow-up in that thread would go to "the last agent": not to one she can't talk to.
    const followUp = await route(bia.id, "e agora?", root.id);
    expect(followUp.runs).toEqual([]);
    const anas = await route(f.owner.id, "alguém pode revisar o deploy?");
    expect(anas.runs.map((r) => r.agentId)).toEqual([f.agent.id]);
    expect(seen).toEqual([["dev"]]);
  });

  test("an agent asking another one acts for the person behind its run", async () => {
    const { bia } = await world();
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", ownerUserId: f.owner.id },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });
    await setAgentAudience(f.db, f.owner.id, f.org.id, ops.id, { mode: "owner", userIds: [] });
    const askFor = async (userId: string) => {
      const asked = await postPersonMessage(deps(), userId, f.org.id, f.general.id, { body: "@dev verifica" });
      const [run] = await runsOf(asked.id);
      const { message } = await insertMessageWithRuns(
        f.db,
        {
          orgId: f.org.id,
          channelId: f.general.id,
          threadId: null, // asked in the channel, dev answers there
          author: { type: "agent", agentId: f.agent.id, runId: run?.id ?? "", hop: 1 },
          body: "@ops pode olhar o deploy?",
        },
        { startRuns: false },
      );
      const out = await dispatchMentions(f.db, { orgId: f.org.id, messageId: message.id }, { maxHops: 3 });
      // Dev answered: its run ends (a second call in the channel would otherwise join it while it works).
      if (run) await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
      return out;
    };
    expect((await askFor(bia.id)).runs).toEqual([]);
    expect((await askFor(f.owner.id)).runs.map((r) => r.agentId)).toEqual([ops.id]);
  });

  test("routines: only allowed people create them; a routine whose creator lost access pauses", async () => {
    const { bia } = await world();
    const routineDeps = { db: f.db, pubsub: f.pubsub, context: f.context };
    const input = {
      agentId: f.agent.id,
      prompt: "Resuma o dia.",
      target: { type: "channel" as const, channelId: f.general.id },
      trigger: { type: "schedule" as const, phrase: "todo dia às 9h" },
    };
    await makeAdmin(f.db, f.org.id, bia.id);
    const routine = await createRoutine(routineDeps, bia.id, f.org.id, input);
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] });
    await expect(createRoutine(routineDeps, bia.id, f.org.id, input)).rejects.toMatchObject({ code: "audience.only" });
    const [run] = await f.db
      .insert(schema.routineRuns)
      .values({ orgId: f.org.id, routineId: routine.id, at: new Date(), trigger: "schedule", status: "queued" })
      .returning();
    await executeRoutineRun(routineDeps, run?.id ?? "");
    const [after] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, routine.id));
    expect(after).toMatchObject({ active: false, pausedReason: "audience" });
    const [done] = await f.db
      .select()
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.id, run?.id ?? ""));
    expect(done).toMatchObject({ status: "skipped", code: "audience" });
    expect((await f.db.select().from(schema.messages)).some((m) => m.meta.routineBrief !== undefined)).toBe(false);
  });

  test("on a plan its owner or an admin widens it, with nothing to accept, audited as any change", async () => {
    const { bia } = await world();
    const caio = await addMember(f.db, f.org.id, "admin", "caio");
    await f.db
      .update(schema.agents)
      .set({ brain: "claude_code", audienceMode: "owner" })
      .where(eq(schema.agents.id, f.agent.id));
    const everyone = { mode: "everyone" as const, userIds: [], roleIds: [] };
    const some = { mode: "people" as const, userIds: [bia.id], roleIds: [] };
    const widen = (actor: string, to: typeof everyone | typeof some) =>
      setAgentAudience(f.db, actor, f.org.id, f.agent.id, to).catch((e) => e);
    expect(audienceOf(await widen(f.owner.id, some))).toEqual({ ...some, consultable: true });
    const audits = (await f.db.select().from(schema.auditLog)).filter((a) => a.action === "agent.audience_changed");
    expect(audits.map((a) => a.details)).toEqual([
      {
        from: { mode: "owner", userIds: [], roleIds: [], consultable: true },
        to: { ...some, consultable: true },
        planOwner: f.owner.id,
      },
    ]);
    expect((await widen(caio.id, everyone)).audienceMode).toBe("everyone");
    expect((await widen(f.owner.id, everyone)).audienceMode).toBe("everyone");
    expect((await widen(caio.id, some)).audienceMode).toBe("people");
    expect((await widen(caio.id, everyone)).audienceMode).toBe("everyone");
  });

  test("someone else opening an agent on a person's plan: audited with whose plan, its owner emailed once in their language", async () => {
    const { bia } = await world();
    const caio = await addMember(f.db, f.org.id, "admin", "caio");
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, f.owner.id));
    // On the computer its owner connected: that computer's own sign-in is the owner's plan.
    const { machineId } = await pairMachine(deps(), f.owner.id, f.org.id, { protocol: BRAIN_PROTOCOL, exec: true });
    await f.db
      .update(schema.agents)
      .set({ brain: "claude_code", audienceMode: "owner", machineId })
      .where(eq(schema.agents.id, f.agent.id));
    const everyone = { mode: "everyone" as const, userIds: [], roleIds: [] };
    const jobs = async () => (await f.db.select().from(schema.outbox)).filter((j) => j.kind === PLAN_OPENED_JOB);
    // A member who doesn't own it can't, so nothing goes out.
    await expect(setAgentAudience(f.db, bia.id, f.org.id, f.agent.id, everyone)).rejects.toBeInstanceOf(ForbiddenError);
    // Its owner's own change tells nobody.
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "people", userIds: [bia.id], roleIds: [] });
    expect(await jobs()).toHaveLength(0);
    // An admin's: one job, then one email to the owner, in English, naming who and what changed.
    await setAgentAudience(f.db, caio.id, f.org.id, f.agent.id, everyone);
    expect(await jobs()).toHaveLength(1);
    const [audit] = (await f.db.select().from(schema.auditLog))
      .filter((a) => a.action === "agent.audience_changed" && a.actorId === caio.id)
      .map((a) => a.details);
    expect(audit).toMatchObject({
      from: { mode: "people", userIds: [bia.id] },
      to: { mode: "everyone" },
      planOwner: f.owner.id,
    });
    // Narrowing it again isn't more people: no email.
    await setAgentAudience(f.db, caio.id, f.org.id, f.agent.id, { mode: "owner", userIds: [], roleIds: [] });
    expect(await jobs()).toHaveLength(1);
    const email = createFakeEmailSender();
    await drainOutbox(f.db, createJobHandlers({ ...f.jobDeps, email, emailArt: emailArtAt("https://chat.example") }));
    expect(email.sent).toHaveLength(1);
    const [sent] = email.sent;
    const [owner] = await f.db.select().from(schema.users).where(eq(schema.users.id, f.owner.id));
    expect(sent?.to).toEqual([String(owner?.email)]);
    expect(sent?.subject).toBe("More people can talk to your agent on your Claude plan");
    expect(sent?.text).toContain("caio");
    expect(sent?.text).toContain("You and bia");
    expect(sent?.text).toContain("Everyone in the workspace");
    expect(sent?.html).toContain(
      `https://chat.example/org/${f.org.id}/agents/${f.agent.id}?tab=settings&amp;sec=audience`,
    );
    // The brain dialog's "Atende outras pessoas" by an admin tells the owner too.
    await setAgentBrain({ db: f.db }, caio.id, f.org.id, f.agent.id, { onlyOwner: false });
    expect(await jobs()).toHaveLength(2);
    // So does an admin moving it onto the plan with it on, though it answered everyone already on the API.
    await f.db
      .update(schema.agents)
      .set({ brain: "model", audienceMode: "everyone" })
      .where(eq(schema.agents.id, f.agent.id));
    await setAgentBrain({ db: f.db }, caio.id, f.org.id, f.agent.id, { brain: "claude_code", onlyOwner: false });
    expect(await jobs()).toHaveLength(3);
    const later = createFakeEmailSender();
    const drain = () =>
      drainOutbox(
        f.db,
        createJobHandlers({ ...f.jobDeps, email: later, emailArt: emailArtAt("https://chat.example") }),
      );
    await drain();
    expect(later.sent).toHaveLength(2);
    // On a computer nobody connected no plan of theirs thinks (OpenCode's free tier): the job sends nothing.
    await f.db.update(schema.machines).set({ pairedByUserId: null }).where(eq(schema.machines.id, machineId));
    await setAgentAudience(f.db, caio.id, f.org.id, f.agent.id, { mode: "owner", userIds: [], roleIds: [] });
    await setAgentAudience(f.db, caio.id, f.org.id, f.agent.id, everyone);
    expect(await jobs()).toHaveLength(4);
    await drain();
    expect(later.sent).toHaveLength(2);
  });

  test("a role lets in whoever holds it, now and later, in every path; leaving the role takes it away", async () => {
    const { bia } = await world();
    const support = await createRole(f.db, f.owner.id, f.org.id, { name: "Suporte" });
    const agent = await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, {
      mode: "people",
      userIds: [],
      roleIds: [support.id],
    });
    expect(audienceOf(agent)).toEqual({ mode: "people", userIds: [], roleIds: [support.id], consultable: true });
    const mention = () => postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@dev faz o relatório" });
    const teamSays = async () =>
      (await getTeam(f.db, bia.id, f.org.id)).agents.find((a) => a.id === f.agent.id)?.canTalk;
    // Before Bia holds it: no run, the notice names the role, and every list says no.
    const before = await mention();
    expect(await runsOf(before.id)).toEqual([]);
    expect(before.notices?.[0]).toMatchObject({ text: "Dev only replies to Suporte and ana." });
    expect(before.notices?.[0]?.params).toEqual({
      agentId: f.agent.id,
      agentName: "Dev",
      userIds: [f.owner.id],
      roleIds: [support.id],
      names: ["Suporte", "ana"],
    });
    await expect(openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id })).rejects.toMatchObject({
      code: "audience.only",
    });
    expect(await teamSays()).toBe(false);
    // She joins the role: the mention starts a run (SQL), the DM opens (code), the team screen lets her talk.
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [support.id]);
    const joined = await mention();
    expect(await runsOf(joined.id)).toHaveLength(1);
    expect(joined.notices).toBeUndefined();
    expect((await openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id })).kind).toBe("dm");
    expect(await teamSays()).toBe(true);
    // She leaves it: back to nothing, with no change to the agent.
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, []);
    const left = await mention();
    expect(await runsOf(left.id)).toEqual([]);
    expect(await teamSays()).toBe(false);
  });

  test("routines of an agent show only to who may talk to it: a role grants them, leaving it hides them", async () => {
    const { bia } = await world();
    const routine = await createRoutine({ db: f.db, pubsub: f.pubsub, context: f.context }, f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Resuma o dia.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "schedule", phrase: "todo dia às 9h" },
    });
    const support = await createRole(f.db, f.owner.id, f.org.id, { name: "Suporte" });
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, {
      mode: "people",
      userIds: [],
      roleIds: [support.id],
    });
    const seen = async (userId: string) => (await listRoutines(f.db, userId, f.org.id)).map((r) => r.id);
    expect(await seen(bia.id)).toEqual([]);
    expect(await seen(f.owner.id)).toEqual([routine.id]);
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [support.id]);
    expect(await seen(bia.id)).toEqual([routine.id]);
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, []);
    expect(await seen(bia.id)).toEqual([]);
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] });
    expect(await seen(bia.id)).toEqual([]);
  });

  test("roles to pick: the workspace's own, never `everyone` nor another workspace's; an app that sends none keeps them", async () => {
    await world();
    const support = await createRole(f.db, f.owner.id, f.org.id, { name: "Suporte" });
    const [everyone] = await f.db
      .select()
      .from(schema.orgRoles)
      .where(eq(schema.orgRoles.orgId, f.org.id))
      .then((rows) => rows.filter((r) => r.kind === "everyone"));
    const pick = (roleIds: string[]) =>
      setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "people", userIds: [], roleIds });
    await expect(pick([everyone?.id ?? ""])).rejects.toBeInstanceOf(ValidationError);
    const other = await createOrganization(f.db, f.owner.id, { name: "Outra" });
    const theirs = await createRole(f.db, f.owner.id, other.organization.id, { name: "Deles" });
    await expect(pick([theirs.id])).rejects.toBeInstanceOf(ValidationError);
    // A role alone is enough, even with no owner.
    await f.db.update(schema.agents).set({ ownerUserId: null }).where(eq(schema.agents.id, f.agent.id));
    expect((await pick([support.id])).audienceRoleIds).toEqual([support.id]);
    const bia = await addMember(f.db, f.org.id, "member", "bia2");
    const kept = await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "people", userIds: [bia.id] });
    expect(kept).toMatchObject({ audienceUserIds: [bia.id], audienceRoleIds: [support.id] });
    // Everyone again clears both lists.
    const open = await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "everyone", userIds: [] });
    expect(open).toMatchObject({ audienceUserIds: [], audienceRoleIds: [] });
  });

  test("the gate in SQL and in code agree: every audience, on a plan or the API, with an owner or none", async () => {
    const { bia } = await world();
    const cara = await addMember(f.db, f.org.id, "member", "cara");
    const dora = await addMember(f.db, f.org.id, "member", "dora");
    // Cara holds the agent's role; Dora holds another one.
    const support = await createRole(f.db, f.owner.id, f.org.id, { name: "Suporte" });
    const tech = await createRole(f.db, f.owner.id, f.org.id, { name: "Tecnologia" });
    await setMemberRoles(f.db, f.owner.id, f.org.id, cara.id, [support.id]);
    await setMemberRoles(f.db, f.owner.id, f.org.id, dora.id, [tech.id]);
    const people = [f.owner.id, bia.id, cara.id, dora.id, null];
    let checked = 0;
    for (const brain of ["model", "claude_code", "codex"] as const)
      for (const audienceMode of ["everyone", "people", "owner"] as const)
        for (const ownerUserId of [f.owner.id, null]) {
          const set = { brain, audienceMode, ownerUserId, audienceUserIds: [bia.id], audienceRoleIds: [support.id] };
          const [row] = await f.db.update(schema.agents).set(set).where(eq(schema.agents.id, f.agent.id)).returning();
          if (!row) throw new Error("no agent");
          for (const person of people) {
            const [found] = rowsOf<{ ok: boolean }>(
              await f.db.execute(
                sql`select ${audienceSql("a", sql`${person}::text`)} as ok from agents a where a.id = ${f.agent.id}::uuid`,
              ),
            );
            expect({ ...set, person, ok: found?.ok }).toEqual({
              ...set,
              person,
              ok: canTalkTo(row, person, await speakerFor(f.db, f.org.id, person)),
            });
            checked++;
          }
        }
    expect(checked).toBe(90);
  });

  test("an agent that thinks with its owner's plan: a DM from anyone else gets the notice until its owner lets everyone in", async () => {
    const { bia } = await world();
    const dm = await openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id }); // before the plan
    const { machineId } = await pairMachine(deps(), f.owner.id, f.org.id, {
      name: "mac",
      protocol: BRAIN_PROTOCOL,
      exec: true,
    });
    await f.db
      .update(schema.machines)
      .set({ executors: { claude: { version: "2.1.304", loggedIn: true }, detectedAt: new Date().toISOString() } })
      .where(eq(schema.machines.id, machineId));
    await f.db.update(schema.agents).set({ machineId }).where(eq(schema.agents.id, f.agent.id));
    await setAgentBrain({ db: f.db }, f.owner.id, f.org.id, f.agent.id, { brain: "claude_code" });
    const sent = await postPersonMessage(deps(), bia.id, f.org.id, dm.id, { body: "oi" });
    expect(sent.notices).toEqual([
      {
        agentId: f.agent.id,
        text: "Dev only replies to ana.",
        code: "audience.only",
        params: { agentId: f.agent.id, agentName: "Dev", userIds: [f.owner.id], roleIds: [], names: ["ana"] },
      },
    ]);
    await drainOutbox(f.db, f.handlers);
    expect(await runsOf(sent.id)).toEqual([]);
    const cara = await addMember(f.db, f.org.id, "member", "cara");
    await expect(openDm(f.db, cara.id, f.org.id, { agentId: f.agent.id })).rejects.toMatchObject({
      code: "audience.only",
    });

    // "Atende outras pessoas": its owner turns it on, nothing to accept, on whatever server.
    expect((await setAgentBrain({ db: f.db }, f.owner.id, f.org.id, f.agent.id, { onlyOwner: false })).onlyOwner).toBe(
      false,
    );
    expect((await getAgentBrain({ db: f.db }, f.owner.id, f.org.id, f.agent.id)).brain).toBe("claude_code");
    const again = await postPersonMessage(deps(), bia.id, f.org.id, dm.id, { body: "oi de novo" });
    expect(again.notices).toBeUndefined();
    expect(await runsOf(again.id)).toHaveLength(1);
    expect((await openDm(f.db, cara.id, f.org.id, { agentId: f.agent.id })).kind).toBe("dm");
  });
});
