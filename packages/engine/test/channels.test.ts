import { afterEach, beforeEach, expect, test } from "bun:test";
import { orgTopic, type RealtimeEvent, userTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  archiveChannel,
  ConflictError,
  channelMembersDetail,
  createAgent,
  createChannel,
  ForbiddenError,
  joinChannel,
  listChannels,
  NotFoundError,
  openDm,
  postPersonMessage,
  type RouterStrategy,
  removeChannelMember,
  removeMember,
  requireChannelAccess,
  routeMessage,
  setChannelAgentAutoReply,
  ValidationError,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

test("channel access requires org membership, the right org, and channel membership", async () => {
  const stranger = await addUser(f.db, "eve");
  await expect(requireChannelAccess(f.db, stranger.id, f.org.id, f.general.id)).rejects.toBeInstanceOf(ForbiddenError);

  const member = await addMember(f.db, f.org.id, "member");
  await expect(requireChannelAccess(f.db, member.id, f.org.id, f.general.id)).rejects.toThrow(/Join this channel/);
  await joinChannel(f.db, member.id, f.org.id, f.general.id);
  expect((await requireChannelAccess(f.db, member.id, f.org.id, f.general.id)).channel.id).toBe(f.general.id);

  // Same user is owner of another org: the first org's channel id doesn't work through it.
  const [other] = await f.db.insert(schema.organizations).values({ name: "Other" }).returning();
  await f.db.insert(schema.organizationMembers).values({ orgId: other?.id ?? "", userId: member.id, role: "owner" });
  await expect(requireChannelAccess(f.db, member.id, other?.id ?? "", f.general.id)).rejects.toBeInstanceOf(
    NotFoundError,
  );
});

test("private channels can't be joined, only added to by a member", async () => {
  const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "Leadership", visibility: "private" });
  expect(secret.name).toBe("leadership");
  const member = await addMember(f.db, f.org.id, "member");
  await expect(joinChannel(f.db, member.id, f.org.id, secret.id)).rejects.toBeInstanceOf(ForbiddenError);
  expect((await listChannels(f.db, member.id, f.org.id)).map((c) => c.name)).toEqual(["general"]);
  await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { userId: member.id });
  expect((await listChannels(f.db, member.id, f.org.id)).map((c) => [c.name, c.isMember])).toEqual([
    ["general", false],
    ["leadership", true],
  ]);
});

test("names are validated and unique per org", async () => {
  await expect(createChannel(f.db, f.owner.id, f.org.id, { name: "General" })).rejects.toBeInstanceOf(ConflictError);
  await expect(createChannel(f.db, f.owner.id, f.org.id, { name: "has space" })).rejects.toBeInstanceOf(
    ValidationError,
  );
});

test("agents and people from other orgs can't be added", async () => {
  const [other] = await f.db.insert(schema.organizations).values({ name: "Other" }).returning();
  const [foreign] = await f.db
    .insert(schema.agents)
    .values({ orgId: other?.id ?? "", name: "Spy", handle: "spy", model: "claude-sonnet-5-5" })
    .returning();
  await expect(
    addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: foreign?.id ?? "" }),
  ).rejects.toBeInstanceOf(ValidationError);
  const outsider = await addUser(f.db, "zed");
  await expect(
    addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: outsider.id }),
  ).rejects.toBeInstanceOf(ValidationError);
});

test("removing a channel member: self, creator or admin; publishes the revocation", async () => {
  const events: RealtimeEvent[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e));
  const opts = { pubsub: f.pubsub };
  const a = await addMember(f.db, f.org.id, "member", "a");
  const b = await addMember(f.db, f.org.id, "member", "b");
  const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "room", visibility: "public" });
  for (const m of [a, b]) await joinChannel(f.db, m.id, f.org.id, room.id);
  await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: f.agent.id });
  events.length = 0;

  await expect(removeChannelMember(f.db, a.id, f.org.id, room.id, { userId: b.id }, opts)).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  await removeChannelMember(f.db, a.id, f.org.id, room.id, { userId: a.id }, opts); // leave
  await removeChannelMember(f.db, f.owner.id, f.org.id, room.id, { userId: b.id }, opts); // creator/admin
  await removeChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: f.agent.id }, opts);
  const changed = { type: "org.broadcast", orgId: f.org.id, event: { type: "channels.changed" } };
  expect(events).toEqual([
    { type: "membership.revoked", orgId: f.org.id, userId: a.id, channelId: room.id },
    changed,
    { type: "membership.revoked", orgId: f.org.id, userId: b.id, channelId: room.id },
    changed,
    changed,
  ]);

  await removeMember(f.db, f.owner.id, f.org.id, a.id, opts);
  // Their sockets lose access; everyone else's apps read the people again.
  expect(events.slice(-2)).toEqual([
    { type: "membership.revoked", orgId: f.org.id, userId: a.id },
    { type: "org.broadcast", orgId: f.org.id, event: { type: "org.members" } },
  ]);
});

test("leaving: never #general or a DM; a public channel stays open, the last person out of a private one archives it", async () => {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await joinChannel(f.db, bia.id, f.org.id, f.general.id);
  await expect(removeChannelMember(f.db, bia.id, f.org.id, f.general.id, { userId: bia.id })).rejects.toMatchObject({
    code: "channel.general_stays",
  });
  // An admin can still take someone out of it.
  await removeChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });

  const dm = await openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id });
  await expect(removeChannelMember(f.db, bia.id, f.org.id, dm.id, { userId: bia.id })).rejects.toMatchObject({
    code: "channel.leave_kind",
  });

  const open = await createChannel(f.db, bia.id, f.org.id, { name: "open", visibility: "public" });
  await removeChannelMember(f.db, bia.id, f.org.id, open.id, { userId: bia.id });
  const row = async (id: string) => (await f.db.select().from(schema.channels).where(eq(schema.channels.id, id))).at(0);
  expect((await row(open.id))?.archivedAt).toBeNull();

  const quiet = await createChannel(f.db, bia.id, f.org.id, { name: "quiet", visibility: "private" });
  await addChannelMember(f.db, bia.id, f.org.id, quiet.id, { userId: f.owner.id });
  await addChannelMember(f.db, f.owner.id, f.org.id, quiet.id, { agentId: f.agent.id });
  await removeChannelMember(f.db, bia.id, f.org.id, quiet.id, { userId: bia.id });
  expect((await row(quiet.id))?.archivedAt).toBeNull();
  // The agent left behind reaches nobody: the last person out closes it.
  await removeChannelMember(f.db, f.owner.id, f.org.id, quiet.id, { userId: f.owner.id });
  expect((await row(quiet.id))?.archivedAt).not.toBeNull();
});

test("a channel's creator taken out of it manages it no more: he can't put himself back or remove anyone", async () => {
  const xico = await addMember(f.db, f.org.id, "member", "xico");
  const room = await createChannel(f.db, xico.id, f.org.id, { name: "diretoria", visibility: "private" });
  await addChannelMember(f.db, xico.id, f.org.id, room.id, { userId: f.owner.id });
  await removeChannelMember(f.db, f.owner.id, f.org.id, room.id, { userId: xico.id });

  await expect(addChannelMember(f.db, xico.id, f.org.id, room.id, { userId: xico.id })).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  await expect(removeChannelMember(f.db, xico.id, f.org.id, room.id, { userId: f.owner.id })).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  await expect(archiveChannel(f.db, xico.id, f.org.id, room.id)).rejects.toBeInstanceOf(ForbiddenError);
  await expect(requireChannelAccess(f.db, xico.id, f.org.id, room.id)).rejects.toThrow(/Join this channel/);
});

test("archiving a channel: creator or admin; access ends and subscribers are told", async () => {
  const events: RealtimeEvent[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e));
  const member = await addMember(f.db, f.org.id, "member");
  const eng = await createChannel(f.db, f.owner.id, f.org.id, { name: "eng" });
  await joinChannel(f.db, member.id, f.org.id, eng.id);
  await expect(archiveChannel(f.db, member.id, f.org.id, eng.id)).rejects.toBeInstanceOf(ForbiddenError);
  await expect(archiveChannel(f.db, f.owner.id, f.org.id, f.general.id)).rejects.toBeInstanceOf(ValidationError);
  await archiveChannel(f.db, f.owner.id, f.org.id, eng.id, { pubsub: f.pubsub });
  await expect(requireChannelAccess(f.db, member.id, f.org.id, eng.id)).rejects.toBeInstanceOf(NotFoundError);
  expect(events).toEqual([
    { type: "channel.archived", orgId: f.org.id, channelId: eng.id },
    { type: "org.broadcast", orgId: f.org.id, event: { type: "channels.changed" } },
  ]);
});

test("joining a channel tells its members, so their members column shows the newcomer", async () => {
  const member = await addMember(f.db, f.org.id, "member", "dani");
  const eng = await createChannel(f.db, f.owner.id, f.org.id, { name: "eng" });
  const events = f.listen(eng.id);
  await joinChannel(f.db, member.id, f.org.id, eng.id, { pubsub: f.pubsub });
  await Bun.sleep(5);
  expect(events).toEqual([
    { type: "channel.member_added", channelId: eng.id, member: { type: "person", id: member.id } },
  ]);
});

test("adding members: creator or admin; agents need an admin or their owner; events and auto-reply", async () => {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const pub = { pubsub: f.pubsub };
  const room = await createChannel(f.db, bia.id, f.org.id, { name: "squad", visibility: "private" });
  const events = f.listen(room.id);
  const caioEvents: string[] = [];
  f.pubsub.subscribe(userTopic(f.org.id, caio.id), (e) => caioEvents.push(e.type));

  // The creator adds a person; that person can't add others.
  await addChannelMember(f.db, bia.id, f.org.id, room.id, { userId: caio.id }, pub);
  expect(caioEvents).toEqual(["channel.member_added"]);
  await expect(addChannelMember(f.db, caio.id, f.org.id, room.id, { userId: f.owner.id })).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  // The creator can't add an agent owned by someone else; the agent's owner (or an admin) can.
  const own = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Bot", handle: "bot", ownerUserId: bia.id },
    { model: "claude-haiku-5-5" },
  );
  await expect(addChannelMember(f.db, bia.id, f.org.id, room.id, { agentId: f.agent.id })).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  await addChannelMember(f.db, bia.id, f.org.id, room.id, { agentId: own.id, autoReply: false }, pub);
  await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: f.agent.id }, pub);
  await Bun.sleep(5);
  expect(
    events.filter((e) => e.type === "channel.member_added").map((e) => (e as unknown as { member: unknown }).member),
  ).toEqual([
    { type: "person", id: caio.id },
    { type: "agent", id: own.id, autoReply: false },
    { type: "agent", id: f.agent.id, autoReply: true },
  ]);

  // The router sees auto-reply changes on the next message.
  const seen: string[][] = [];
  const strategy: RouterStrategy = {
    name: "fixed",
    async decide(input) {
      seen.push(input.candidates.map((c) => c.handle).sort());
      return { agents: input.candidates.map((c) => ({ agentId: c.agentId, score: 0 })), reason: "t" };
    },
  };
  const route = async () => {
    const m = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, room.id, {
      body: "alguém viu o build?",
    });
    return routeMessage(
      { db: f.db, strategy, policy: { minScore: 0.5, maxAgents: 2, maxHops: 3 } },
      {
        orgId: f.org.id,
        messageId: m.id,
      },
    );
  };
  await route();
  await expect(setChannelAgentAutoReply(f.db, caio.id, f.org.id, room.id, own.id, true)).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  await setChannelAgentAutoReply(f.db, bia.id, f.org.id, room.id, own.id, true, pub);
  await route();
  expect(seen).toEqual([["dev"], ["bot", "dev"]]);
  await Bun.sleep(5);
  expect(events.some((e) => e.type === "channel.member_updated")).toBe(true);

  await removeChannelMember(f.db, bia.id, f.org.id, room.id, { agentId: own.id }, pub);
  await route();
  expect(seen.at(-1)).toEqual(["dev"]);
  await Bun.sleep(5);
  expect(events.some((e) => e.type === "channel.member_removed")).toBe(true);
});

test("an agent's reply mode in a channel: the channel's creator or the agent's owner, no admin role needed", async () => {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const room = await createChannel(f.db, bia.id, f.org.id, { name: "squad" });
  const bot = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Bot", handle: "bot", ownerUserId: caio.id },
    { model: "claude-haiku-5-5" },
  );
  for (const agentId of [f.agent.id, bot.id]) await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId });

  // bia created the room but doesn't own @dev; caio owns @bot but didn't create the room.
  await setChannelAgentAutoReply(f.db, bia.id, f.org.id, room.id, f.agent.id, false);
  await setChannelAgentAutoReply(f.db, caio.id, f.org.id, room.id, bot.id, false);
  // Owning another agent there isn't enough.
  await expect(setChannelAgentAutoReply(f.db, caio.id, f.org.id, room.id, f.agent.id, true)).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  const rows = await channelMembersDetail(f.db, f.org.id, room.id);
  expect(Object.fromEntries(rows.filter((r) => r.agentHandle).map((r) => [r.agentHandle, r.autoReply]))).toEqual({
    dev: false,
    bot: false,
  });
});
