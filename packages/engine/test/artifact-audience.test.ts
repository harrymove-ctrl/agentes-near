import { afterEach, expect, test } from "bun:test";
import { eq, schema, sql } from "@agenteschat/db";
import {
  addChannelMember,
  createArtifact,
  createChannel,
  deleteArtifact,
  ForbiddenError,
  getArtifact,
  listArtifacts,
  listDeletedArtifacts,
  NotFoundError,
  openDm,
  purgeArtifactNow,
  restoreArtifact,
  withPersonFacts,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const doc = (title: string, channelId: string | null = null) => ({
  title,
  channelId,
  content: { kind: "document" as const, markdown: `# ${title}` },
});

test("who can see a file, per source: workspace, public channel, private channel, DM with an agent or a person", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
  await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { userId: bia.id });
  const withAgent = await openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id });
  const withOwner = await openDm(f.db, bia.id, f.org.id, { userId: f.owner.id });
  const files = {
    drive: await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Manual")),
    general: await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Pauta", f.general.id)),
    secret: await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Plano", secret.id)),
    agentDm: await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Rascunho", withAgent.id)),
    ownerDm: await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Recibo", withOwner.id)),
  };
  const facts = await withPersonFacts(f.db, bia.id, f.org.id, await listArtifacts(f.db, person(bia.id), f.org.id));
  const audience = (id: string) => facts.find((a) => a.id === id)?.audience;
  expect(audience(files.drive.id)).toEqual({ kind: "workspace" });
  expect(audience(files.general.id)).toEqual({ kind: "channel", name: f.general.name, private: false });
  expect(audience(files.secret.id)).toEqual({ kind: "channel", name: "secret", private: true });
  expect(audience(files.agentDm.id)).toEqual({ kind: "dm", with: { type: "agent", id: f.agent.id } });
  expect(audience(files.ownerDm.id)).toEqual({ kind: "dm", with: { type: "person", id: f.owner.id } });
  // The owner, on the other side of the same DM, sees bia.
  const [fromOwner] = await withPersonFacts(f.db, f.owner.id, f.org.id, [
    await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, files.ownerDm.id),
  ]);
  expect(fromOwner?.audience).toEqual({ kind: "dm", with: { type: "person", id: bia.id } });
});

test("a DM's files stay in the DM: other people, admins included, and agents outside it never see them", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const dm = await openDm(f.db, bia.id, f.org.id, { userId: caio.id });
  const file = await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Recibo", dm.id));
  for (const outsider of [f.owner.id]) {
    expect((await listArtifacts(f.db, person(outsider), f.org.id)).map((a) => a.id)).not.toContain(file.id);
    await expect(getArtifact(f.artifactDeps, person(outsider), f.org.id, file.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  }
  const agentInGeneral = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
  expect((await listArtifacts(f.db, agentInGeneral, f.org.id)).map((a) => a.id)).not.toContain(file.id);
  expect((await listArtifacts(f.db, person(caio.id), f.org.id)).map((a) => a.id)).toContain(file.id);
});

test("canDelete: the creator, the agent's owner and admins; not other members", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  await f.db.update(schema.agents).set({ ownerUserId: caio.id }).where(eq(schema.agents.id, f.agent.id));
  const mine = await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Meu"));
  const agents = await createArtifact(
    f.artifactDeps,
    { type: "agent", agentId: f.agent.id, channelId: f.general.id },
    f.org.id,
    doc("Do agente"),
  );
  const can = async (userId: string) =>
    Object.fromEntries(
      (await withPersonFacts(f.db, userId, f.org.id, [mine, agents])).map((a) => [a.title, a.canDelete]),
    );
  expect(await can(bia.id)).toEqual({ Meu: true, "Do agente": false });
  expect(await can(caio.id)).toEqual({ Meu: false, "Do agente": true });
  expect(await can(f.owner.id)).toEqual({ Meu: true, "Do agente": true });
});

test("delete for good from the trash: contents gone now, out of the trash, no restore; same people only", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const file = await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Velho"));
  // Only from the trash.
  await expect(purgeArtifactNow(f.artifactDeps, bia.id, f.org.id, file.id)).rejects.toBeInstanceOf(NotFoundError);
  await deleteArtifact(f.artifactDeps, bia.id, f.org.id, file.id);
  await expect(purgeArtifactNow(f.artifactDeps, caio.id, f.org.id, file.id)).rejects.toBeInstanceOf(ForbiddenError);
  const [version] = await f.db
    .select()
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.artifactId, file.id));
  expect(f.platformBlobs.objects.has(version?.blobKey ?? "")).toBe(true);

  await purgeArtifactNow(f.artifactDeps, bia.id, f.org.id, file.id);
  expect(f.platformBlobs.objects.has(version?.blobKey ?? "")).toBe(false);
  expect(
    await f.db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, file.id)),
  ).toEqual([]);
  expect(await listDeletedArtifacts(f.db, bia.id, f.org.id)).toEqual([]);
  await expect(restoreArtifact(f.artifactDeps, bia.id, f.org.id, file.id)).rejects.toMatchObject({
    code: "artifact.purged",
  });
  await expect(purgeArtifactNow(f.artifactDeps, bia.id, f.org.id, file.id)).rejects.toBeInstanceOf(NotFoundError);
  expect((await f.db.select().from(schema.auditLog)).map((a) => a.action)).toContain("artifact.purged");
});

test("agents' tools never see a trashed file", async () => {
  f = await setup();
  const agent = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
  const file = await createArtifact(f.artifactDeps, agent, f.org.id, doc("Relatório"));
  expect((await listArtifacts(f.db, agent, f.org.id)).map((a) => a.id)).toContain(file.id);
  await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, file.id);
  expect((await listArtifacts(f.db, agent, f.org.id)).map((a) => a.id)).not.toContain(file.id);
  await expect(getArtifact(f.artifactDeps, agent, f.org.id, file.id)).rejects.toBeInstanceOf(NotFoundError);
});

test("the trash follows who may read: an admin and the agent's owner outside a DM never see, restore or purge its file", async () => {
  f = await setup();
  const theo = await addMember(f.db, f.org.id, "member", "theo");
  const ana = await addMember(f.db, f.org.id, "member", "ana");
  await f.db.update(schema.agents).set({ ownerUserId: ana.id }).where(eq(schema.agents.id, f.agent.id));
  const dm = await openDm(f.db, theo.id, f.org.id, { agentId: f.agent.id });
  const file = await createArtifact(
    f.artifactDeps,
    { type: "agent", agentId: f.agent.id, channelId: dm.id },
    f.org.id,
    doc("Planilha", dm.id),
  );
  // In the trash (moved there from inside the DM).
  await f.db.update(schema.artifacts).set({ deletedAt: new Date() }).where(eq(schema.artifacts.id, file.id));
  for (const outsider of [f.owner.id, ana.id]) {
    expect((await listDeletedArtifacts(f.db, outsider, f.org.id)).map((a) => a.id)).not.toContain(file.id);
    await expect(restoreArtifact(f.artifactDeps, outsider, f.org.id, file.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(purgeArtifactNow(f.artifactDeps, outsider, f.org.id, file.id)).rejects.toBeInstanceOf(NotFoundError);
  }
  expect(
    await f.db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, file.id)),
  ).toHaveLength(1);
});

/** The deps with `fn` run (and committed) just before the next transaction starts: another request racing in. */
function racing(fn: () => Promise<unknown>) {
  let done = false;
  const db = new Proxy(f.db, {
    get(target, key, receiver) {
      if (key !== "transaction" || done) return Reflect.get(target, key, receiver);
      return async (...args: Parameters<typeof target.transaction>) => {
        done = true;
        await fn();
        return target.transaction(...args);
      };
    },
  });
  return { ...f.artifactDeps, db };
}

test("restore and delete for good racing: whichever commits first wins, a restored file keeps its contents", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const file = await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("Corrida"));
  await deleteArtifact(f.artifactDeps, bia.id, f.org.id, file.id);
  // A restore commits after the purge read the row.
  const restoredFirst = racing(() =>
    f.db.update(schema.artifacts).set({ deletedAt: null }).where(eq(schema.artifacts.id, file.id)),
  );
  await expect(purgeArtifactNow(restoredFirst, bia.id, f.org.id, file.id)).rejects.toBeInstanceOf(NotFoundError);
  const [row] = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, file.id));
  expect(row?.deletedAt).toBeNull();
  expect(
    await f.db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, file.id)),
  ).toHaveLength(1);

  // A delete for good commits after the restore read the row.
  await deleteArtifact(f.artifactDeps, bia.id, f.org.id, file.id);
  const purgedFirst = racing(() =>
    f.db
      .update(schema.artifacts)
      .set({ deletedAt: sql`now() - interval '31 days'` })
      .where(eq(schema.artifacts.id, file.id)),
  );
  await expect(restoreArtifact(purgedFirst, bia.id, f.org.id, file.id)).rejects.toBeInstanceOf(NotFoundError);
  const [after] = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, file.id));
  expect(after?.deletedAt).not.toBeNull();
});

test("a DM with an archived agent or a person who left is marked gone, so the app offers no way into it", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const withAgent = await openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id });
  const withCaio = await openDm(f.db, bia.id, f.org.id, { userId: caio.id });
  const files = [
    await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("A", withAgent.id)),
    await createArtifact(f.artifactDeps, person(bia.id), f.org.id, doc("B", withCaio.id)),
  ];
  const audiences = async () => (await withPersonFacts(f.db, bia.id, f.org.id, files)).map((a) => a.audience);
  expect(await audiences()).toEqual([
    { kind: "dm", with: { type: "agent", id: f.agent.id } },
    { kind: "dm", with: { type: "person", id: caio.id } },
  ]);
  await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
  await f.db.update(schema.users).set({ blockedAt: new Date() }).where(eq(schema.users.id, caio.id));
  expect(await audiences()).toEqual([
    { kind: "dm", with: { type: "agent", id: f.agent.id }, gone: true },
    { kind: "dm", with: { type: "person", id: caio.id }, gone: true },
  ]);
});
