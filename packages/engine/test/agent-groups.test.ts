import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryPubSub, createPostgresPubSub, orgTopic } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import {
  type AgentGroupView,
  archiveAgent,
  createAgent,
  createAgentGroup,
  createOrganization,
  deleteAgentGroup,
  ForbiddenError,
  listAgentGroups,
  moveAgentToGroup,
  NotFoundError,
  updateAgentGroup,
  ValidationError,
} from "../src";
import { addMember, addUser } from "./fixtures";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** A workspace with three agents (Ada, Bia, Caio, in that order), a member and an admin. */
async function workspace() {
  const t = await createTestDatabase();
  close = t.close;
  const db: Database = t.db;
  const pubsub = createMemoryPubSub();
  const owner = await addUser(db, "ana");
  const { organization: org } = await createOrganization(db, owner.id, { name: "Acme" });
  const agent = (name: string) =>
    createAgent(db, owner.id, org.id, { name, handle: name.toLowerCase() }, { model: "claude-sonnet-5-5" });
  const ada = await agent("Ada");
  const bia = await agent("Bia");
  const caio = await agent("Caio");
  const member = await addMember(db, org.id, "member");
  const admin = await addMember(db, org.id, "admin");
  return { db, pubsub, deps: { db, pubsub }, owner, org, ada, bia, caio, member, admin };
}

/** A group that isn't there (deleted meanwhile, or another workspace's), with the code the apps translate. */
const GONE = { name: "NotFoundError", code: "agent_group.not_found" };

const shape = (groups: AgentGroupView[], names: Record<string, string>) =>
  groups.map((g) => [g.name, g.agentIds.map((id) => names[id] ?? id)]);

describe("agent groups", () => {
  test("a group goes after the others with its agents in order; rename and reorder; everyone reads them", async () => {
    const w = await workspace();
    const names = { [w.ada.id]: "Ada", [w.bia.id]: "Bia", [w.caio.id]: "Caio" };
    expect(await listAgentGroups(w.db, w.member.id, w.org.id)).toEqual([]);
    await createAgentGroup(w.deps, w.owner.id, w.org.id, { name: "  Integrations ", agentIds: [w.bia.id, w.ada.id] });
    let groups = await createAgentGroup(w.deps, w.admin.id, w.org.id, { name: "Produto" });
    expect(shape(groups, names)).toEqual([
      ["Integrations", ["Bia", "Ada"]],
      ["Produto", []],
    ]);
    const produto = groups[1]?.id ?? "";
    groups = await updateAgentGroup(w.deps, w.owner.id, w.org.id, produto, { index: 0, name: "Produto e marketing" });
    expect(shape(groups, names)).toEqual([
      ["Produto e marketing", []],
      ["Integrations", ["Bia", "Ada"]],
    ]);
    // An index past the end is the end.
    groups = await updateAgentGroup(w.deps, w.owner.id, w.org.id, produto, { index: 9 });
    expect(groups.map((g) => g.name)).toEqual(["Integrations", "Produto e marketing"]);
    expect(await listAgentGroups(w.db, w.member.id, w.org.id)).toEqual(groups);
  });

  test("moving an agent: to a place in a group, to another group, out of any; one group at most", async () => {
    const w = await workspace();
    const names = { [w.ada.id]: "Ada", [w.bia.id]: "Bia", [w.caio.id]: "Caio" };
    let groups = await createAgentGroup(w.deps, w.owner.id, w.org.id, {
      name: "Integrations",
      agentIds: [w.ada.id, w.bia.id],
    });
    const integrations = groups[0]?.id ?? "";
    groups = await createAgentGroup(w.deps, w.owner.id, w.org.id, { name: "Produto" });
    const produto = groups[1]?.id ?? "";

    groups = await moveAgentToGroup(w.deps, w.owner.id, w.org.id, w.caio.id, { groupId: integrations, index: 1 });
    expect(shape(groups, names)[0]).toEqual(["Integrations", ["Ada", "Caio", "Bia"]]);
    // Inside its own group: its place among the others.
    groups = await moveAgentToGroup(w.deps, w.owner.id, w.org.id, w.ada.id, { groupId: integrations, index: 2 });
    expect(shape(groups, names)[0]).toEqual(["Integrations", ["Caio", "Bia", "Ada"]]);
    // To another group (the end without an index): out of the first.
    groups = await moveAgentToGroup(w.deps, w.owner.id, w.org.id, w.bia.id, { groupId: produto });
    expect(shape(groups, names)).toEqual([
      ["Integrations", ["Caio", "Ada"]],
      ["Produto", ["Bia"]],
    ]);
    // A group made with an agent of another group takes it from there.
    groups = await createAgentGroup(w.deps, w.owner.id, w.org.id, { name: "Financeiro", agentIds: [w.caio.id] });
    expect(shape(groups, names)).toEqual([
      ["Integrations", ["Ada"]],
      ["Produto", ["Bia"]],
      ["Financeiro", ["Caio"]],
    ]);
    groups = await moveAgentToGroup(w.deps, w.owner.id, w.org.id, w.bia.id, { groupId: null });
    expect(shape(groups, names)[1]).toEqual(["Produto", []]);
    const [row] = await w.db.select().from(schema.agents).where(eq(schema.agents.id, w.bia.id));
    expect(row?.groupId).toBeNull();
    // An archived agent leaves the views.
    await archiveAgent(w.db, w.owner.id, w.org.id, w.ada.id);
    expect(shape(await listAgentGroups(w.db, w.owner.id, w.org.id), names)[0]).toEqual(["Integrations", []]);
  });

  test("deleting a group puts its agents back in none; the other groups keep theirs", async () => {
    const w = await workspace();
    await createAgentGroup(w.deps, w.owner.id, w.org.id, { name: "Integrations", agentIds: [w.ada.id, w.bia.id] });
    const groups = await createAgentGroup(w.deps, w.owner.id, w.org.id, { name: "Produto", agentIds: [w.caio.id] });
    const left = await deleteAgentGroup(w.deps, w.owner.id, w.org.id, groups[0]?.id ?? "");
    expect(left).toEqual([
      {
        id: groups[1]?.id ?? "",
        name: "Produto",
        agentIds: [w.caio.id],
        color: "graphite",
        icon: "person",
        leadUserId: null,
        backupUserId: null,
      },
    ]);
    const rows = await w.db.select().from(schema.agents).where(eq(schema.agents.orgId, w.org.id));
    expect(rows.filter((a) => a.groupId === null).map((a) => a.name)).toEqual(expect.arrayContaining(["Ada", "Bia"]));
    await expect(deleteAgentGroup(w.deps, w.owner.id, w.org.id, groups[0]?.id ?? "")).rejects.toMatchObject(GONE);
  });

  test("only owners and admins change them; members read them; nobody outside the workspace does", async () => {
    const w = await workspace();
    const groups = await createAgentGroup(w.deps, w.admin.id, w.org.id, { name: "Integrations" });
    const id = groups[0]?.id ?? "";
    const refused = [
      () => createAgentGroup(w.deps, w.member.id, w.org.id, { name: "Meu grupo" }),
      () => updateAgentGroup(w.deps, w.member.id, w.org.id, id, { name: "Outro" }),
      () => deleteAgentGroup(w.deps, w.member.id, w.org.id, id),
      () => moveAgentToGroup(w.deps, w.member.id, w.org.id, w.ada.id, { groupId: id }),
    ];
    for (const attempt of refused) await expect(attempt()).rejects.toBeInstanceOf(ForbiddenError);
    expect(await listAgentGroups(w.db, w.member.id, w.org.id)).toEqual(groups);
    const stranger = await addUser(w.db, "zoe");
    await expect(listAgentGroups(w.db, stranger.id, w.org.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a name is needed; another workspace's agents and groups are not found", async () => {
    const w = await workspace();
    await expect(createAgentGroup(w.deps, w.owner.id, w.org.id, { name: "   " })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const other = await createOrganization(w.db, w.owner.id, { name: "Outra" });
    const theirs = await createAgent(
      w.db,
      w.owner.id,
      other.organization.id,
      { name: "Zed", handle: "zed" },
      { model: "claude-sonnet-5-5" },
    );
    const theirGroups = await createAgentGroup(w.deps, w.owner.id, other.organization.id, { name: "Deles" });
    await expect(
      createAgentGroup(w.deps, w.owner.id, w.org.id, { name: "Misto", agentIds: [w.ada.id, theirs.id] }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await listAgentGroups(w.db, w.owner.id, w.org.id)).toEqual([]);
    await expect(
      moveAgentToGroup(w.deps, w.owner.id, w.org.id, w.ada.id, { groupId: theirGroups[0]?.id ?? "" }),
    ).rejects.toMatchObject(GONE);
    await expect(moveAgentToGroup(w.deps, w.owner.id, w.org.id, theirs.id, { groupId: null })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      updateAgentGroup(w.deps, w.owner.id, w.org.id, theirGroups[0]?.id ?? "", { name: "Nosso" }),
    ).rejects.toMatchObject(GONE);
  });

  test("every change reaches the workspace's open apps: one broadcast each, for them to read the groups again", async () => {
    const w = await workspace();
    const heard: unknown[] = [];
    w.pubsub.subscribe(orgTopic(w.org.id), (e) => heard.push(e));
    const created = await createAgentGroup(w.deps, w.owner.id, w.org.id, { name: "Integrations" });
    const id = created[0]?.id ?? "";
    await moveAgentToGroup(w.deps, w.owner.id, w.org.id, w.ada.id, { groupId: id });
    await updateAgentGroup(w.deps, w.owner.id, w.org.id, id, { name: "APIs" });
    await deleteAgentGroup(w.deps, w.owner.id, w.org.id, id);
    const event = { type: "org.broadcast", orgId: w.org.id, event: { type: "agent.groups" } };
    expect(heard).toEqual([event, event, event, event]);
  });

  test("at the limits every change still goes out over Postgres NOTIFY; a group past them is refused with its code", async () => {
    const w = await workspace();
    const sent: string[] = [];
    const pubsub = await createPostgresPubSub({
      listen: async () => async () => {},
      notify: async (_channel, payload) => {
        sent.push(payload);
      },
    });
    const deps = { db: w.db, pubsub };
    // The longest names in bytes: 80 two-byte letters.
    for (let i = 0; i < 50; i++) {
      const agentIds = i === 49 ? [w.ada.id, w.bia.id, w.caio.id] : [];
      await createAgentGroup(deps, w.owner.id, w.org.id, { name: `${i}`.padEnd(80, "ç"), agentIds });
    }
    await pubsub.close?.();
    expect(sent.map((p) => (JSON.parse(p) as { e: { event: { type: string } } }).e.event.type)).toEqual(
      Array(50).fill("agent.groups"),
    );
    await expect(createAgentGroup(deps, w.owner.id, w.org.id, { name: "Mais um" })).rejects.toMatchObject({
      name: "ValidationError",
      code: "agent_group.too_many",
      params: { max: 50 },
    });
  });
});
