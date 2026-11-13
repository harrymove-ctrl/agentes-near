import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createChannel,
  deleteChannel,
  drainOutbox,
  ForbiddenError,
  listChannels,
  NotFoundError,
  pinMessage,
  postPersonMessage,
  purgeChannel,
  unarchiveChannel,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/** Deleting a channel for good: owners and admins, by its name, never #general; a tombstone, then the purge job. */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const remove = (channelId: string, typed: string, actorId = f.owner.id) =>
  deleteChannel({ db: f.db, pubsub: f.pubsub }, actorId, f.org.id, channelId, typed);
const say = (channelId: string, body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, { body });
const count = async (
  table: typeof schema.messages | typeof schema.messagePins | typeof schema.channelMembers,
  id: string,
) => (await f.db.select({ c: table.channelId }).from(table).where(eq(table.channelId, id))).length;

describe("who may delete which channel", () => {
  test("only owners and admins, typing its name; #general never", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    const room = await createChannel(f.db, member.id, f.org.id, { name: "lancamento" });
    // Its creator may archive it, not delete it.
    await expect(remove(room.id, "lancamento", member.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(remove(room.id, "lancamentos")).rejects.toBeInstanceOf(ValidationError);
    await expect(remove(f.general.id, "general")).rejects.toMatchObject({ code: "channel.general" });
    const admin = await addMember(f.db, f.org.id, "admin", "Caio");
    await remove(room.id, "#Lancamento ", admin.id);
    await expect(remove(room.id, "lancamento")).rejects.toBeInstanceOf(NotFoundError);
  });
});

test("gone at once: unlisted, its name free, never unarchived, audited, its routines deleted; then its contents purged", async () => {
  f = await setup();
  const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "lancamento" });
  await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: f.agent.id });
  const msg = await say(room.id, "Plano do lançamento");
  const kept = await say(f.general.id, "Bom dia");
  await pinMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, room.id, msg.id);
  await f.db.insert(schema.messageReactions).values({
    orgId: f.org.id,
    messageId: msg.id,
    userId: f.owner.id,
    reaction: "👍",
  });
  await f.db.insert(schema.contextItems).values({
    orgId: f.org.id,
    kind: "note",
    scopeType: "agent",
    scopeId: f.agent.id,
    agentId: f.agent.id,
    content: "O lançamento é dia 10.",
    channelIds: [room.id],
  });
  const [routine] = await f.db
    .insert(schema.routines)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      name: "Resumo",
      prompt: "Resuma",
      target: { type: "channel", channelId: room.id },
      triggerType: "schedule",
    })
    .returning();

  await remove(room.id, "lancamento");
  const [row] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, room.id));
  expect(row?.deletedAt).not.toBeNull();
  expect(row?.archivedAt).not.toBeNull();
  expect(row?.name).toBe(`deleted-${room.id}`);
  expect((await listChannels(f.db, f.owner.id, f.org.id)).map((c) => c.id)).not.toContain(room.id);
  await expect(unarchiveChannel(f.db, f.owner.id, f.org.id, room.id)).rejects.toBeInstanceOf(NotFoundError);
  expect((await createChannel(f.db, f.owner.id, f.org.id, { name: "lancamento" })).name).toBe("lancamento");
  const [audit] = await f.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "channel.deleted"), eq(schema.auditLog.targetId, room.id)));
  expect(audit?.details).toMatchObject({ name: "lancamento" });
  const [r] = await f.db
    .select()
    .from(schema.routines)
    .where(eq(schema.routines.id, routine?.id ?? ""));
  expect(r?.deletedAt).not.toBeNull();

  await drainOutbox(f.db, f.handlers);
  expect(await count(schema.messages, room.id)).toBe(0);
  expect(await count(schema.messagePins, room.id)).toBe(0);
  expect(await count(schema.channelMembers, room.id)).toBe(0);
  expect(
    await f.db.select().from(schema.messageReactions).where(eq(schema.messageReactions.messageId, msg.id)),
  ).toEqual([]);
  expect(
    (await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.orgId, f.org.id))).filter((c) =>
      c.channelIds.includes(room.id),
    ),
  ).toEqual([]);
  expect(
    (await f.db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.orgId, f.org.id))).filter((d) =>
      d.channelIds.includes(room.id),
    ),
  ).toEqual([]);
  // Other channels keep theirs; the tombstone stays.
  expect((await f.db.select().from(schema.messages).where(eq(schema.messages.id, kept.id))).length).toBe(1);
  expect((await f.db.select().from(schema.channels).where(eq(schema.channels.id, room.id))).length).toBe(1);
});

test("a private channel's tasks go with it, a public one's stay for everyone; its recordings leave storage", async () => {
  f = await setup();
  const open = await createChannel(f.db, f.owner.id, f.org.id, { name: "aberto" });
  const closed = await createChannel(f.db, f.owner.id, f.org.id, { name: "fechado", visibility: "private" });
  const task = (n: number, channelId: string) => ({
    orgId: f.org.id,
    number: n,
    title: `Tarefa ${n}`,
    channelId,
    createdByType: "person",
    createdById: f.owner.id,
  });
  await f.db.insert(schema.issues).values([task(1, open.id), task(2, closed.id)]);
  const blobs = f.artifactDeps.blobs;
  await (await blobs.forConfig(f.org.id, null)).put("voice/clip-1", new Uint8Array([1]), { contentType: "audio/webm" });
  await f.db.insert(schema.voiceClips).values({
    orgId: f.org.id,
    channelId: closed.id,
    userId: f.owner.id,
    clientId: "clip-1",
    blobKey: "voice/clip-1",
    contentType: "audio/webm",
    size: 1,
    durationMs: 1000,
    peaks: [],
    status: "sent",
  });
  await remove(open.id, "aberto");
  await remove(closed.id, "fechado");
  await purgeChannel({ db: f.db, blobs }, f.org.id, open.id);
  await purgeChannel({ db: f.db, blobs }, f.org.id, closed.id);
  const left = await f.db.select().from(schema.issues).where(eq(schema.issues.orgId, f.org.id));
  expect(left.map((i) => [i.number, i.channelId])).toEqual([[1, null]]);
  const [clip] = await f.db.select().from(schema.voiceClips).where(eq(schema.voiceClips.clientId, "clip-1"));
  expect(clip?.audioDeletedAt).not.toBeNull();
  expect(await (await blobs.forConfig(f.org.id, null)).get("voice/clip-1")).toBeNull();
});
