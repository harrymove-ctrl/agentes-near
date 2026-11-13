import { afterEach, beforeEach, expect, test } from "bun:test";
import { orgTopic, type RealtimeEvent } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  channelCard,
  createChannel,
  createRole,
  deleteRole,
  ForbiddenError,
  isChannelMember,
  joinChannel,
  listChannels,
  NotFoundError,
  requireChannelAccess,
  setMemberRoles,
  updateChannel,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

const role = (name: string) => createRole(f.db, f.owner.id, f.org.id, { name });
const names = async (userId: string) =>
  (await listChannels(f.db, userId, f.org.id)).filter((c) => c.name !== "general").map((c) => [c.name, c.isMember]);

test("a channel limited to a department: its people see it and join; the rest don't even see it", async () => {
  const sales = await role("Vendas");
  const ana = await addMember(f.db, f.org.id, "member", "ana");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await setMemberRoles(f.db, f.owner.id, f.org.id, ana.id, [sales.id]);
  const ch = await createChannel(f.db, f.owner.id, f.org.id, {
    name: "vendas",
    visibility: "private",
    audienceRoleIds: [sales.id],
  });
  expect(ch.audienceRoleIds).toEqual([sales.id]);

  expect(await names(ana.id)).toEqual([["vendas", false]]);
  expect((await listChannels(f.db, ana.id, f.org.id)).find((c) => c.id === ch.id)?.audienceRoleIds).toEqual([sales.id]);
  expect((await channelCard(f.db, ana.id, f.org.id, ch.id)).isMember).toBe(false);
  // Seeing it doesn't open its messages: joining does.
  await expect(requireChannelAccess(f.db, ana.id, f.org.id, ch.id)).rejects.toThrow(/Join this channel/);
  await joinChannel(f.db, ana.id, f.org.id, ch.id);
  expect((await requireChannelAccess(f.db, ana.id, f.org.id, ch.id)).channel.id).toBe(ch.id);

  expect(await names(bia.id)).toEqual([]);
  await expect(channelCard(f.db, bia.id, f.org.id, ch.id)).rejects.toBeInstanceOf(NotFoundError);
  await expect(joinChannel(f.db, bia.id, f.org.id, ch.id)).rejects.toBeInstanceOf(ForbiddenError);

  // Dynamic: given the role, she sees it at once.
  await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [sales.id]);
  expect(await names(bia.id)).toEqual([["vendas", false]]);
});

test("roles: only the workspace's own, never on a public channel", async () => {
  const sales = await role("Vendas");
  const [everyone] = await f.db
    .select({ id: schema.orgRoles.id })
    .from(schema.orgRoles)
    .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "everyone")));
  if (!everyone) throw new Error("no base role");
  for (const input of [
    { visibility: "public" as const, audienceRoleIds: [sales.id] },
    { visibility: "private" as const, audienceRoleIds: [everyone.id] },
    { visibility: "private" as const, audienceRoleIds: ["00000000-0000-4000-8000-000000000000"] },
  ]) {
    await expect(createChannel(f.db, f.owner.id, f.org.id, { name: "x", ...input })).rejects.toBeInstanceOf(
      ValidationError,
    );
  }
});

test("losing the role takes a person out; another role of the channel, the creator or a name added keeps them", async () => {
  const events: RealtimeEvent[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e));
  const opts = { pubsub: f.pubsub };
  const sales = await role("Vendas");
  const support = await role("Suporte");
  const ana = await addMember(f.db, f.org.id, "member", "ana");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  await setMemberRoles(f.db, f.owner.id, f.org.id, ana.id, [sales.id]);
  await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [sales.id, support.id]);
  const ch = await createChannel(f.db, f.owner.id, f.org.id, {
    name: "atendimento",
    visibility: "private",
    audienceRoleIds: [sales.id, support.id],
  });
  for (const p of [ana, bia]) await joinChannel(f.db, p.id, f.org.id, ch.id);
  await addChannelMember(f.db, f.owner.id, f.org.id, ch.id, { userId: caio.id });

  await setMemberRoles(f.db, f.owner.id, f.org.id, ana.id, [], opts);
  await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [support.id], opts);
  expect(await isChannelMember(f.db, f.org.id, ch.id, ana.id)).toBe(false);
  expect(await isChannelMember(f.db, f.org.id, ch.id, bia.id)).toBe(true);
  expect(await isChannelMember(f.db, f.org.id, ch.id, caio.id)).toBe(true);
  expect(events.filter((e) => e.type === "membership.revoked")).toEqual([
    { type: "membership.revoked", orgId: f.org.id, userId: ana.id, channelId: ch.id },
  ]);

  // The role deleted: its people go, the channel forgets it; its creator stays.
  await setMemberRoles(f.db, f.owner.id, f.org.id, f.owner.id, [support.id]);
  await deleteRole(f.db, f.owner.id, f.org.id, support.id, opts);
  expect(await isChannelMember(f.db, f.org.id, ch.id, bia.id)).toBe(false);
  expect(await isChannelMember(f.db, f.org.id, ch.id, f.owner.id)).toBe(true);
  expect((await channelCard(f.db, f.owner.id, f.org.id, ch.id)).audienceRoleIds).toEqual([sales.id]);
});

test("changing it later: a dropped role's people go; turned invite only or public, everyone in stays", async () => {
  const sales = await role("Vendas");
  const support = await role("Suporte");
  const ana = await addMember(f.db, f.org.id, "member", "ana");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await setMemberRoles(f.db, f.owner.id, f.org.id, ana.id, [sales.id]);
  await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [support.id]);
  const ch = await createChannel(f.db, f.owner.id, f.org.id, { name: "time" });
  for (const p of [ana, bia]) await joinChannel(f.db, p.id, f.org.id, ch.id);

  // Only the creator or an admin changes who may join.
  await expect(
    updateChannel(f.db, ana.id, f.org.id, ch.id, { visibility: "private", audienceRoleIds: [sales.id] }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  const limited = await updateChannel(f.db, f.owner.id, f.org.id, ch.id, {
    visibility: "private",
    audienceRoleIds: [sales.id, support.id],
  });
  expect(limited.audienceRoleIds).toEqual([sales.id, support.id]);

  await updateChannel(f.db, f.owner.id, f.org.id, ch.id, { audienceRoleIds: [sales.id] });
  expect(await isChannelMember(f.db, f.org.id, ch.id, bia.id)).toBe(false);
  expect(await isChannelMember(f.db, f.org.id, ch.id, ana.id)).toBe(true);

  const inviteOnly = await updateChannel(f.db, f.owner.id, f.org.id, ch.id, { audienceRoleIds: [] });
  expect([inviteOnly.visibility, inviteOnly.audienceRoleIds]).toEqual(["private", []]);
  expect(await isChannelMember(f.db, f.org.id, ch.id, ana.id)).toBe(true);

  await updateChannel(f.db, f.owner.id, f.org.id, ch.id, { audienceRoleIds: [sales.id] });
  const open = await updateChannel(f.db, f.owner.id, f.org.id, ch.id, { visibility: "public" });
  expect([open.visibility, open.audienceRoleIds]).toEqual(["public", []]);
});

/** `f.db`, whose first transaction waits for `meanwhile`: what another request commits between a read and a write. */
const racing = (meanwhile: () => Promise<unknown>) => {
  const state = { raced: false };
  const db = new Proxy(f.db, {
    get(target, key) {
      if (key === "transaction" && !state.raced)
        return async (...args: Parameters<typeof target.transaction>) => {
          state.raced = true;
          await meanwhile();
          return target.transaction(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, state };
};

test("joining while the role is taken away: the join checks the role again under the lock and refuses", async () => {
  const sales = await role("Vendas");
  const ana = await addMember(f.db, f.org.id, "member", "ana");
  await setMemberRoles(f.db, f.owner.id, f.org.id, ana.id, [sales.id]);
  const ch = await createChannel(f.db, f.owner.id, f.org.id, {
    name: "vendas",
    visibility: "private",
    audienceRoleIds: [sales.id],
  });
  const race = racing(() => setMemberRoles(f.db, f.owner.id, f.org.id, ana.id, []));
  await expect(joinChannel(race.db, ana.id, f.org.id, ch.id)).rejects.toBeInstanceOf(ForbiddenError);
  expect(race.state.raced).toBe(true);
  expect(await isChannelMember(f.db, f.org.id, ch.id, ana.id)).toBe(false);
});

test("a topic edit while a role is deleted doesn't write the deleted role back on the channel", async () => {
  const sales = await role("Vendas");
  const support = await role("Suporte");
  const ch = await createChannel(f.db, f.owner.id, f.org.id, {
    name: "time",
    visibility: "private",
    audienceRoleIds: [sales.id, support.id],
  });
  // The role is deleted between updateChannel's first read and its write.
  const race = racing(() => deleteRole(f.db, f.owner.id, f.org.id, support.id));
  await updateChannel(race.db, f.owner.id, f.org.id, ch.id, { topic: "novo" });
  expect(race.state.raced).toBe(true);
  expect((await channelCard(f.db, f.owner.id, f.org.id, ch.id)).audienceRoleIds).toEqual([sales.id]);
});
