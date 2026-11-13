import { afterEach, describe, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { and, eq, rowsOf, schema, sql } from "@agenteschat/db";
import {
  addChannelMember,
  CHANNEL_KEYS,
  type ChannelOverride,
  channelMaySql,
  channelPermissions,
  createChannel,
  createRole,
  createRoutine,
  deleteRole,
  executeRoutineRun,
  getMembership,
  listChannelOverrides,
  listChannels,
  managesChannel,
  maySql,
  pinMessage,
  postPersonMessage,
  type RouterStrategy,
  removeMember,
  requireChannelAccess,
  resolvePermissions,
  routeMessage,
  setChannelOverride,
  setMemberRoles,
  updateChannel,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });

async function everyoneId() {
  const [row] = await f.db
    .select({ id: schema.orgRoles.id })
    .from(schema.orgRoles)
    .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "everyone")));
  if (!row) throw new Error("no everyone role");
  return row.id;
}

/** bia and cara in #general; Vendas (cara) and Gerência (cara too) as roles. */
async function world() {
  f = await setup({ reply: () => ({ chunks: ["ok"] }) });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const cara = await addMember(f.db, f.org.id, "member", "cara");
  for (const p of [bia, cara]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: p.id });
  const sales = await createRole(f.db, f.owner.id, f.org.id, { name: "Vendas" });
  const leads = await createRole(f.db, f.owner.id, f.org.id, { name: "Gerência" });
  await setMemberRoles(f.db, f.owner.id, f.org.id, cara.id, [sales.id, leads.id]);
  return { bia, cara, sales, leads, everyone: await everyoneId() };
}

const set = (
  target: { type: "role" | "person"; id: string },
  allow: string[],
  deny: string[],
  channelId = f.general.id,
  actorId = f.owner.id,
) => setChannelOverride(f.db, actorId, f.org.id, channelId, { target, allow, deny }, { pubsub: f.pubsub });

const inChannel = async (userId: string, channelId = f.general.id) =>
  (await requireChannelAccess(f.db, userId, f.org.id, channelId)).membership;

const sqlMay = async (userId: string, key: (typeof CHANNEL_KEYS)[number], channelId = f.general.id) => {
  const [row] = rowsOf<{ ok: boolean }>(
    await f.db.execute(sql`select ${channelMaySql(f.org.id, channelId, userId, key)} as ok`),
  );
  return row?.ok === true;
};

describe("the rule (Discord's order)", () => {
  const base = resolvePermissions(false, ["post", "talk_to_agents"]);
  const o = (target: ChannelOverride["target"], allow: string[], deny: string[]): ChannelOverride => ({
    target,
    allow,
    deny,
  });

  test("everyone's deny, a role's allow wins over it; between roles an allow wins; a person's own is last", () => {
    expect(channelPermissions(base, [o("everyone", [], ["post"])]).has("post")).toBe(false);
    expect(channelPermissions(base, [o("everyone", [], ["post"]), o("role", ["post"], [])]).has("post")).toBe(true);
    expect(channelPermissions(base, [o("role", [], ["post"]), o("role", ["post"], [])]).has("post")).toBe(true);
    expect(channelPermissions(base, [o("role", [], ["post"])]).has("post")).toBe(false);
    expect(channelPermissions(base, [o("role", ["post"], []), o("person", [], ["post"])]).has("post")).toBe(false);
    expect(channelPermissions(base, [o("everyone", [], ["post"]), o("person", ["post"], [])]).has("post")).toBe(true);
    expect(channelPermissions(base, [o("everyone", ["manage_channels"], [])]).has("manage_channels")).toBe(true);
  });

  test("an owner or administrator is never overridden; manage_channels held in the workspace stays", () => {
    const deny = [o("everyone", [], [...CHANNEL_KEYS]), o("person", [], [...CHANNEL_KEYS])];
    for (const keys of [resolvePermissions(true, []), resolvePermissions(false, ["administrator"])]) {
      expect(CHANNEL_KEYS.every((k) => channelPermissions(keys, deny).has(k))).toBe(true);
    }
    const manager = resolvePermissions(false, ["post", "manage_channels"]);
    const after = channelPermissions(manager, deny);
    expect([after.has("manage_channels"), after.has("post")]).toEqual([true, false]);
  });

  test("no exceptions: the workspace's keys, unchanged", () => {
    expect(channelPermissions(base, [])).toBe(base);
  });
});

describe("channel exceptions", () => {
  test("with none, every check is today's: the channel's keys are the workspace's, in code and in SQL", async () => {
    const { bia, cara } = await world();
    const admin = await addMember(f.db, f.org.id, "admin", "dora");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: admin.id });
    for (const id of [f.owner.id, bia.id, cara.id, admin.id]) {
      const workspace = await getMembership(f.db, id, f.org.id);
      expect([...(await inChannel(id)).permissions].sort()).toEqual([...(workspace?.permissions ?? [])].sort());
      for (const key of CHANNEL_KEYS) {
        const [row] = rowsOf<{ ok: boolean }>(await f.db.execute(sql`select ${maySql(f.org.id, id, key)} as ok`));
        expect({ id, key, ok: await sqlMay(id, key) }).toEqual({ id, key, ok: row?.ok === true });
      }
    }
    const general = (await listChannels(f.db, bia.id, f.org.id)).find((c) => c.id === f.general.id);
    expect(general?.can).toEqual({ post: true, callAgents: true, manage: false });
    expect((await listChannels(f.db, f.owner.id, f.org.id)).find((c) => c.id === f.general.id)?.can).toEqual({
      post: true,
      callAgents: true,
      manage: true,
    });
  }, 30_000);

  test("code and SQL agree on every combination for owner, admin, members with and without roles", async () => {
    const { bia, cara, sales, leads, everyone } = await world();
    const admin = await addMember(f.db, f.org.id, "admin", "dora");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: admin.id });
    const people = [f.owner.id, admin.id, bia.id, cara.id];
    const states = [
      [[], []] as const,
      [["post", "talk_to_agents"], []] as const,
      [[], ["post", "manage_channels"]] as const,
    ];
    let checked = 0;
    for (const [ea, ed] of states)
      for (const [ra, rd] of states)
        for (const [pa, pd] of states) {
          await set({ type: "role", id: everyone }, [...ea], [...ed]);
          await set({ type: "role", id: sales.id }, [...ra], [...rd]);
          await set({ type: "role", id: leads.id }, [...rd], [...ra]);
          await set({ type: "person", id: cara.id }, [...pa], [...pd]);
          await set({ type: "person", id: bia.id }, [...pd], [...pa]);
          for (const id of people) {
            const js = await inChannel(id);
            for (const key of CHANNEL_KEYS) {
              expect({ id, key, ok: await sqlMay(id, key) }).toEqual({ id, key, ok: js.permissions.has(key) });
              checked++;
            }
          }
        }
    expect(checked).toBe(27 * 4 * 3);
  }, 120_000);

  test("Todos denied sending, Gerência allowed: an announcements channel", async () => {
    const { bia, cara, leads, everyone } = await world();
    await set({ type: "role", id: everyone }, [], ["post"]);
    await set({ type: "role", id: leads.id }, ["post"], []);
    await expect(postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "oi" })).rejects.toMatchObject({
      code: "channel.post_denied",
    });
    expect((await postPersonMessage(deps(), cara.id, f.org.id, f.general.id, { body: "aviso" })).body).toBe("aviso");
    const pinned = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "fixe" });
    await expect(pinMessage(deps(), bia.id, f.org.id, f.general.id, pinned.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect((await listChannels(f.db, bia.id, f.org.id)).find((c) => c.id === f.general.id)?.can.post).toBe(false);
    // A person's own allow beats Todos.
    await set({ type: "person", id: bia.id }, ["post"], []);
    expect((await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "agora sim" })).body).toBe(
      "agora sim",
    );
  });

  test("Chamar agentes denied: the message posts, no agent wakes, the router skips, the author hears why", async () => {
    const { bia } = await world();
    await set({ type: "person", id: bia.id }, [], ["talk_to_agents"]);
    const sent = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@dev faz o relatório" });
    const runs = (await f.db.select().from(schema.agentRuns)).filter((r) => r.triggerMessageId === sent.id);
    expect(runs).toEqual([]);
    expect(sent.notices).toMatchObject([{ agentId: f.agent.id, code: "channel.agents_denied" }]);
    const strategy: RouterStrategy = {
      name: "fixed",
      async decide(input) {
        return { agents: input.candidates.map((c) => ({ agentId: c.agentId, score: 1 })), reason: "test" };
      },
    };
    const plain = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "alguém revisa?" });
    const routed = await routeMessage(
      { db: f.db, strategy, policy: { minScore: 0.5, maxAgents: 2, maxHops: 3 } },
      { orgId: f.org.id, messageId: plain.id },
    );
    expect(routed.skipped).toBe("no_candidates");
    // Elsewhere she still calls agents: the exception is this channel's.
    const other = await createChannel(f.db, f.owner.id, f.org.id, { name: "outro" });
    await addChannelMember(f.db, f.owner.id, f.org.id, other.id, { userId: bia.id });
    await addChannelMember(f.db, f.owner.id, f.org.id, other.id, { agentId: f.agent.id });
    const there = await postPersonMessage(deps(), bia.id, f.org.id, other.id, { body: "@dev oi" });
    expect((await f.db.select().from(schema.agentRuns)).some((r) => r.triggerMessageId === there.id)).toBe(true);
  });

  test("a routine whose creator may no longer send there pauses; a new one is refused", async () => {
    const { bia } = await world();
    await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
    const routineDeps = { db: f.db, pubsub: f.pubsub, context: f.context };
    const input = {
      agentId: f.agent.id,
      prompt: "Resuma o dia.",
      target: { type: "channel" as const, channelId: f.general.id },
      trigger: { type: "schedule" as const, phrase: "todo dia às 9h" },
    };
    const routine = await createRoutine(routineDeps, bia.id, f.org.id, input);
    await set({ type: "person", id: bia.id }, [], ["post"]);
    await expect(createRoutine(routineDeps, bia.id, f.org.id, input)).rejects.toMatchObject({
      code: "routine.creator_cannot_post",
    });
    const [run] = await f.db
      .insert(schema.routineRuns)
      .values({ orgId: f.org.id, routineId: routine.id, at: new Date(), trigger: "schedule", status: "queued" })
      .returning();
    await executeRoutineRun(routineDeps, run?.id ?? "");
    const [after] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, routine.id));
    expect(after).toMatchObject({ active: false, pausedReason: "creator_no_access" });
  });

  test("a routine whose creator may no longer call agents there pauses, as their own message would wake nobody", async () => {
    const { bia } = await world();
    // Not the agent's owner (who always calls it): someone who runs routines for the workspace.
    const ops = await createRole(f.db, f.owner.id, f.org.id, { name: "Rotinas", permissions: ["manage_routines"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [ops.id]);
    const routineDeps = { db: f.db, pubsub: f.pubsub, context: f.context };
    const routine = await createRoutine(routineDeps, bia.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Resuma o dia.",
      target: { type: "channel" as const, channelId: f.general.id },
      trigger: { type: "schedule" as const, phrase: "todo dia às 9h" },
    });
    await set({ type: "person", id: bia.id }, [], ["talk_to_agents"]);
    const [run] = await f.db
      .insert(schema.routineRuns)
      .values({ orgId: f.org.id, routineId: routine.id, at: new Date(), trigger: "schedule", status: "queued" })
      .returning();
    await executeRoutineRun(routineDeps, run?.id ?? "");
    const [after] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, routine.id));
    expect(after).toMatchObject({ active: false, pausedReason: "audience" });
  });

  test("Gerenciar o canal: an allow lets a member manage it while in it; a deny never takes it from who holds it", async () => {
    const { bia, cara, everyone } = await world();
    await set({ type: "person", id: bia.id }, ["manage_channels"], []);
    await updateChannel(f.db, bia.id, f.org.id, f.general.id, { topic: "por bia" });
    expect((await listChannels(f.db, bia.id, f.org.id)).find((c) => c.id === f.general.id)?.can.manage).toBe(true);
    await expect(updateChannel(f.db, cara.id, f.org.id, f.general.id, { topic: "x" })).rejects.toMatchObject({
      name: "ForbiddenError",
    });
    // Out of the channel, the exception lets nobody back in.
    const priv = await createChannel(f.db, f.owner.id, f.org.id, { name: "priv", visibility: "private" });
    await set({ type: "person", id: cara.id }, ["manage_channels"], [], priv.id);
    expect(await managesChannel(f.db, await mustMembership(cara.id), cara.id, priv)).toBe(false);
    // The creator, while in it, and a workspace manager stay managers whatever the exceptions say.
    const mine = await createChannel(f.db, cara.id, f.org.id, { name: "da-cara" });
    await set({ type: "role", id: everyone }, [], ["manage_channels"], mine.id);
    await set({ type: "person", id: cara.id }, [], ["manage_channels"], mine.id);
    expect(await managesChannel(f.db, await mustMembership(cara.id), cara.id, mine)).toBe(true);
    const admin = await addMember(f.db, f.org.id, "admin", "dora");
    await set({ type: "person", id: admin.id }, [], ["manage_channels"]);
    expect(await managesChannel(f.db, await mustMembership(admin.id), admin.id, f.general)).toBe(true);
  });

  test("who changes them: managers only, keys they hold, roles and people below them, never themselves", async () => {
    const { bia, cara, sales, leads, everyone } = await world();
    await expect(listChannelOverrides(f.db, bia.id, f.org.id, f.general.id)).rejects.toMatchObject({
      code: "channel.permission_forbidden",
    });
    // Cara manages #general by an exception.
    await set({ type: "person", id: cara.id }, ["manage_channels", "post"], ["talk_to_agents"]);
    const asCara = (target: { type: "role" | "person"; id: string }, allow: string[], deny: string[]) =>
      set(target, allow, deny, f.general.id, cara.id);
    expect(await asCara({ type: "role", id: everyone }, [], ["post"])).toMatchObject({ deny: ["post"] });
    await expect(asCara({ type: "person", id: cara.id }, ["post"], [])).rejects.toMatchObject({
      code: "channel.permission_forbidden",
    });
    // She can't call agents here, so she neither hands that out nor takes it away.
    await expect(asCara({ type: "role", id: everyone }, [], ["talk_to_agents"])).rejects.toMatchObject({
      code: "channel.permission_forbidden",
    });
    // Roles: only those below her highest.
    const ranks = await f.db.select().from(schema.orgRoles).where(eq(schema.orgRoles.orgId, f.org.id));
    const pos = (id: string) => ranks.find((r) => r.id === id)?.position ?? 0;
    const [higher, lower] = pos(sales.id) < pos(leads.id) ? [sales, leads] : [leads, sales];
    await expect(asCara({ type: "role", id: higher.id }, ["post"], [])).rejects.toMatchObject({
      code: "channel.permission_forbidden",
    });
    expect(await asCara({ type: "role", id: lower.id }, ["post"], [])).toMatchObject({ allow: ["post"] });
    // bia holds no role: below her.
    expect(await asCara({ type: "person", id: bia.id }, ["post"], [])).toMatchObject({ allow: ["post"] });
    await expect(asCara({ type: "person", id: f.owner.id }, [], ["post"])).rejects.toMatchObject({
      code: "channel.permission_forbidden",
    });
    // Empty removes the row; the list shows what's left; audited.
    expect(await asCara({ type: "person", id: bia.id }, [], [])).toBeNull();
    const listed = await listChannelOverrides(f.db, cara.id, f.org.id, f.general.id);
    expect(listed.overrides.map((o) => o.target.id).sort()).toEqual([everyone, lower.id, cara.id].sort());
    const audits = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "channel.permissions_changed"));
    expect(audits.length).toBeGreaterThan(3);
    await expect(set({ type: "role", id: everyone }, ["post"], ["post"])).rejects.toMatchObject({
      name: "ValidationError",
    });
    await expect(set({ type: "role", id: everyone }, ["read"], [])).rejects.toMatchObject({ name: "ValidationError" });
  });

  test("an exception goes with its role, its person leaving the workspace, or its channel", async () => {
    const { bia, sales } = await world();
    await set({ type: "role", id: sales.id }, [], ["post"]);
    await set({ type: "person", id: bia.id }, [], ["post"]);
    await deleteRole(f.db, f.owner.id, f.org.id, sales.id);
    await removeMember(f.db, f.owner.id, f.org.id, bia.id);
    expect(await f.db.select().from(schema.channelPermissionOverrides)).toEqual([]);
  });

  test("a change tells everyone's apps to refetch", async () => {
    const { everyone } = await world();
    const heard: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => heard.push(e));
    await set({ type: "role", id: everyone }, [], ["post"]);
    await Bun.sleep(5);
    expect(JSON.stringify(heard)).toContain("channel.permissions");
  });
});

async function mustMembership(userId: string) {
  const m = await getMembership(f.db, userId, f.org.id);
  if (!m) throw new Error("not a member");
  return m;
}
