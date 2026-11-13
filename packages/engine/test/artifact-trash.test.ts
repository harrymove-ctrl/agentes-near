import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  ConflictError,
  createArtifact,
  deleteArtifact,
  drainOutbox,
  ForbiddenError,
  insertMessage,
  listArtifacts,
  listDeletedArtifacts,
  listMessages,
  postPersonMessage,
  purgeDeletedArtifacts,
  restoreArtifact,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** bia asks @dev for a report: the agent makes a file in #general. */
async function agentFile() {
  f = await setup({ reply: () => ({ chunks: ["ok"] }) });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  for (const u of [bia, caio]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
  const ask = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
    body: "@dev faz o relatório",
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, ask.id));
  const file = await createArtifact(
    f.artifactDeps,
    { type: "agent", agentId: f.agent.id, channelId: f.general.id, runId: run?.id ?? "" },
    f.org.id,
    { title: "Relatório", content: { kind: "document", markdown: "# Relatório" } },
  );
  const card = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    threadId: null,
    author: run
      ? { type: "agent", agentId: f.agent.id, runId: run.id, hop: 1 }
      : { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
    body: "Pronto.",
    meta: { artifacts: [{ id: file.id, version: 1 }] },
  });
  return { bia, caio, file, ask, card };
}

test("who may delete: who asked the agent, the agent's owner, admins; not other members", async () => {
  const { bia, caio, file } = await agentFile();
  await expect(deleteArtifact(f.artifactDeps, caio.id, f.org.id, file.id)).rejects.toMatchObject({
    code: "artifact.delete_forbidden",
  });
  await expect(deleteArtifact(f.artifactDeps, caio.id, f.org.id, file.id)).rejects.toBeInstanceOf(ForbiddenError);
  await deleteArtifact(f.artifactDeps, bia.id, f.org.id, file.id);
  await restoreArtifact(f.artifactDeps, bia.id, f.org.id, file.id);
  // The agent's owner may too.
  await f.db.update(schema.agents).set({ ownerUserId: caio.id }).where(eq(schema.agents.id, f.agent.id));
  await deleteArtifact(f.artifactDeps, caio.id, f.org.id, file.id);
  const audit = (await f.db.select().from(schema.auditLog)).map((a) => a.action);
  expect(audit.filter((a) => a === "artifact.deleted")).toHaveLength(2);
  expect(audit).toContain("artifact.restored");
});

test("deleted files leave the Drive; messages show them removed; trash and restore", async () => {
  const { bia, file } = await agentFile();
  await deleteArtifact(f.artifactDeps, bia.id, f.org.id, file.id);
  expect((await listArtifacts(f.db, { type: "person", userId: bia.id }, f.org.id)).map((a) => a.id)).not.toContain(
    file.id,
  );
  const timeline = await listMessages(f.db, bia.id, f.org.id, f.general.id);
  expect(timeline.at(-1)?.meta.artifacts).toEqual([{ id: file.id, deleted: true, title: "Relatório" }]);

  const trash = await listDeletedArtifacts(f.db, bia.id, f.org.id);
  expect(trash.map((t) => [t.id, t.title])).toEqual([[file.id, "Relatório"]]);
  expect(await listDeletedArtifacts(f.db, (await addMember(f.db, f.org.id, "member", "zé")).id, f.org.id)).toEqual([]);

  await restoreArtifact(f.artifactDeps, bia.id, f.org.id, file.id);
  expect((await listArtifacts(f.db, { type: "person", userId: bia.id }, f.org.id)).map((a) => a.id)).toContain(file.id);
  const again = await listMessages(f.db, bia.id, f.org.id, f.general.id);
  expect(again.at(-1)?.meta.artifacts).toEqual([{ id: file.id, version: 1 }]);
});

test("after 30 days the purge job removes every version's contents; restore is no longer possible", async () => {
  const { bia, file } = await agentFile();
  await deleteArtifact(f.artifactDeps, bia.id, f.org.id, file.id);
  // Not yet: within 30 days nothing is purged.
  expect(await purgeDeletedArtifacts(f.artifactDeps)).toBe(0);
  const [version] = await f.db
    .select()
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.artifactId, file.id));
  expect(f.platformBlobs.objects.has(version?.blobKey ?? "")).toBe(true);
  await f.db
    .update(schema.artifacts)
    .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
    .where(eq(schema.artifacts.id, file.id));
  expect(await purgeDeletedArtifacts(f.artifactDeps)).toBe(1);
  expect(
    await f.db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, file.id)),
  ).toEqual([]);
  expect(f.platformBlobs.objects.has(version?.blobKey ?? "")).toBe(false);
  await expect(restoreArtifact(f.artifactDeps, bia.id, f.org.id, file.id)).rejects.toBeInstanceOf(ConflictError);
  // The tombstone keeps the title for old messages.
  const [row] = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, file.id));
  expect(row?.title).toBe("Relatório");
});
