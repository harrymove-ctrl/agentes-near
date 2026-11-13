import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createAgentGroup,
  createChannel,
  createRole,
  decideProposal,
  getTeam,
  listProposals,
  proposeChannelMove,
  RIGHT_HAND,
  setMemberRoles,
  updateAgentGroup,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const seats = async (fx: Fixture, agentId: string) =>
  (
    await fx.db
      .select({ channelId: schema.channelMembers.channelId })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.agentId, agentId))
  ).map((r) => r.channelId);

describe("Equipe's data (ADR 0148)", () => {
  test("each agent's channels: public ones, and a private one only for who is in it", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const of = async (userId: string) =>
      (await getTeam(f.db, userId, f.org.id)).agents.find((a) => a.id === f.agent.id)?.channelIds;
    expect((await of(f.owner.id))?.sort()).toEqual([f.general.id, secret.id].sort());
    expect(await of(member.id)).toEqual([f.general.id]);
    // A private channel limited to a role she holds lists for her (as in listChannels), so its agents do too.
    const sales = await createRole(f.db, f.owner.id, f.org.id, { name: "Vendas" });
    await setMemberRoles(f.db, f.owner.id, f.org.id, member.id, [sales.id]);
    const room = await createChannel(f.db, f.owner.id, f.org.id, {
      name: "vendas",
      visibility: "private",
      audienceRoleIds: [sales.id],
    });
    await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: f.agent.id });
    expect((await of(member.id))?.sort()).toEqual([f.general.id, room.id].sort());
  });

  test("a setor's color, icon, lead and substitute: checked, and cleared with null", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    const deps = { db: f.db, pubsub: f.pubsub };
    const [made] = await createAgentGroup(deps, f.owner.id, f.org.id, {
      name: "Vendas",
      color: "rose",
      icon: "wallet",
    });
    expect(made).toMatchObject({ color: "rose", icon: "wallet", leadUserId: null, backupUserId: null });
    const id = made?.id ?? "";
    const [lead] = await updateAgentGroup(deps, f.owner.id, f.org.id, id, {
      leadUserId: member.id,
      backupUserId: f.owner.id,
      color: "teal",
    });
    expect(lead).toMatchObject({ name: "Vendas", color: "teal", leadUserId: member.id, backupUserId: f.owner.id });
    const [cleared] = await updateAgentGroup(deps, f.owner.id, f.org.id, id, { backupUserId: null });
    expect(cleared).toMatchObject({ leadUserId: member.id, backupUserId: null });
    // Sky is the agents' own color, never a setor's; a lead must be in the workspace; members don't change it.
    await expect(updateAgentGroup(deps, f.owner.id, f.org.id, id, { color: "sky" })).rejects.toMatchObject({
      code: "agent_group.bad_color",
    });
    await expect(updateAgentGroup(deps, f.owner.id, f.org.id, id, { icon: "nope" })).rejects.toMatchObject({
      code: "agent_group.bad_icon",
    });
    await expect(updateAgentGroup(deps, f.owner.id, f.org.id, id, { leadUserId: "u-elsewhere" })).rejects.toMatchObject(
      { code: "agent_group.not_member" },
    );
    await expect(updateAgentGroup(deps, member.id, f.org.id, id, { color: "rose" })).rejects.toMatchObject({
      name: "ForbiddenError",
    });
  });

  test("the map's drag is the right hand's settings card in my DM with it: nothing moves until it is applied", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    const sales = await createChannel(f.db, f.owner.id, f.org.id, { name: "vendas" });
    const out = await proposeChannelMove(deps, f.owner.id, f.org.id, {
      agentId: f.agent.id,
      fromChannelId: f.general.id,
      toChannelId: sales.id,
      reason: "Levar Dev de #general para #vendas, pelo mapa da equipe.",
    });
    const [lodi] = await f.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
    expect(out.rightHandId).toBe(lodi?.id ?? "");
    const [card] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, out.messageId));
    expect(card).toMatchObject({ channelId: out.channelId, authorAgentId: lodi?.id });
    const actionCard = card?.meta.actionCard as { kind: string; forUserId: string; proposalIds: string[] };
    expect(actionCard).toMatchObject({ kind: "settings_proposal", forUserId: f.owner.id });
    const [row] = await listProposals(f.db, f.owner.id, f.org.id, { ids: actionCard.proposalIds });
    expect(row?.settings?.map((l) => [l.field, l.channelId, l.to])).toEqual([
      ["channel_add", sales.id, true],
      ["channel_remove", f.general.id, null],
    ]);
    // Nothing changed yet.
    expect(await seats(f, f.agent.id)).toEqual([f.general.id]);
    await decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept", { pubsub: f.pubsub });
    expect(await seats(f, f.agent.id)).toEqual([sales.id]);
  });

  test("a drop on a channel the person can't see is refused whole, never a bare leave row", async () => {
    f = await setup({ rightHand: true });
    const member = await addMember(f.db, f.org.id, "member");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
    await expect(
      proposeChannelMove({ db: f.db }, member.id, f.org.id, {
        agentId: f.agent.id,
        fromChannelId: f.general.id,
        toChannelId: secret.id,
        reason: "x",
      }),
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(await f.db.select().from(schema.contextProposals)).toEqual([]);
    expect(await seats(f, f.agent.id)).toEqual([f.general.id]);
  });

  test("dropping where it already is changes nothing", async () => {
    f = await setup({ rightHand: true });
    await expect(
      proposeChannelMove({ db: f.db }, f.owner.id, f.org.id, {
        agentId: f.agent.id,
        fromChannelId: f.general.id,
        toChannelId: f.general.id,
        reason: "x",
      }),
    ).rejects.toMatchObject({ name: "ValidationError" });
  });
});
