import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BlobStore,
  createDiskBlobStore,
  createPostgresBlobStore,
  createS3BlobStore,
  StorageError,
} from "@agenteschat/adapters";
import { eq, rowsOf, schema, sql } from "@agenteschat/db";
import {
  type ArtifactDeps,
  acceptVoiceClip,
  addFileVersion,
  artifactDownload,
  assertPublicHttpsUrl,
  createArtifact,
  createBlobStoreResolver,
  createFileArtifact,
  createOrganization,
  deleteArtifact,
  drainOutbox,
  enqueue,
  ForbiddenError,
  getArtifact,
  getMigration,
  getStorage,
  isBlockedAddress,
  ORG_FILES_PURGE_JOB,
  purgeOrgFiles,
  purgeWorkspace,
  restoreArtifact,
  type S3Input,
  saveSkill,
  saveStorage,
  scheduleDeletion,
  startMigration,
  storedBytes,
  storedBytesQueries,
  testStorage,
  USER_FILES_PURGE_JOB,
  ValidationError,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let f: Fixture;
afterEach(async () => {
  setSystemTime();
  // Some tests don't set up a database: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SECRET = "secret-test-key-123456";
const bucket = (over: Partial<S3Input> = {}): S3Input => ({
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "acme-files",
  prefix: "agentes",
  pathStyle: true,
  accessKeyId: "AKIATEST",
  secretAccessKey: SECRET,
  ...over,
});
const person = (userId: string) => ({ type: "person" as const, userId });
/** A workspace deleted for good: its owner deletes it, and its date passes. */
async function deleteForGood(orgId: string) {
  await scheduleDeletion({ db: f.db }, f.owner.id, orgId, "owner");
  await f.db
    .update(schema.organizations)
    .set({ deletionDueAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.organizations.id, orgId));
  expect(await purgeWorkspace({ db: f.db }, orgId)).toBe(true);
}
const doc = (title: string) => ({ title, content: { kind: "document" as const, markdown: `# ${title}` } });

describe("S3 client against the fake server", () => {
  test("put, get, list, delete and a presigned GET, path-style and virtual-hosted", async () => {
    f = await setup();
    for (const pathStyle of [true, false]) {
      const store = createS3BlobStore(
        { ...bucket({ pathStyle }), accessKeyId: "AKIATEST", secretAccessKey: SECRET },
        { fetch: f.s3.fetch },
      );
      await store.put("a/b c.txt", new TextEncoder().encode("hi"), { contentType: "text/plain" });
      expect(new TextDecoder().decode((await store.get("a/b c.txt"))?.body)).toBe("hi");
      expect(await new Response(await store.stream?.("a/b c.txt")).text()).toBe("hi");
      expect(await store.stream?.("a/none.txt")).toBeNull();
      expect(await store.list("a/")).toEqual(["a/b c.txt"]);
      const url = (await store.signedUrl("a/b c.txt", { expiresInSeconds: 60, filename: "b.txt" })) ?? "";
      expect((await f.s3.fetch(url, { method: "GET" })).status).toBe(200);
      expect((await f.s3.fetch(url.replace(/X-Amz-Signature=\w+/, "X-Amz-Signature=00"), {})).status).toBe(403);
      await store.delete("a/b c.txt");
      expect(await store.get("a/b c.txt")).toBeNull();
    }
    const settings = { ...bucket(), accessKeyId: "AKIATEST", secretAccessKey: "nope" };
    const wrong = createS3BlobStore(settings, { fetch: f.s3.fetch });
    const error = await wrong.get("x").catch((e) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe("auth");
  });
});

describe("org storage", () => {
  test("a failing test blocks activation, with a clear reason per failure", async () => {
    f = await setup();
    const cases: [Partial<S3Input>, string][] = [
      [{ secretAccessKey: "wrong-secret" }, "was not accepted"],
      [{ bucket: "missing" }, "doesn't exist"],
      [{ region: "eu-west-1" }, "region"],
    ];
    for (const [over, reason] of cases) {
      const result = await testStorage(f.storage, f.owner.id, f.org.id, bucket(over));
      expect(result.ok).toBe(false);
      expect(result.steps[0]).toMatchObject({ step: "write", ok: false, code: expect.stringMatching(/^storage\./) });
      expect(result.steps[0]?.error).toContain(reason);
      await expect(saveStorage(f.storage, f.owner.id, f.org.id, { kind: "s3", s3: bucket(over) })).rejects.toThrow(
        "Test the connection",
      );
    }
    f.s3.state.denyDelete = true;
    const noDelete = await testStorage(f.storage, f.owner.id, f.org.id, bucket());
    expect(noDelete.steps.map((s) => [s.step, s.ok])).toEqual([
      ["write", true],
      ["read", true],
      ["list", true],
      ["delete", false],
    ]);
    expect(noDelete.steps[3]?.error).toContain("no permission");
    expect((await getStorage(f.db, f.owner.id, f.org.id)).kind).toBe("agentes");
  });

  test("after a switch old files still read from where they were written; new files go to the bucket", async () => {
    f = await setup();
    const before = await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, doc("Antes"));
    expect((await testStorage(f.storage, f.owner.id, f.org.id, bucket())).ok).toBe(true);
    const view = await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "s3", s3: bucket() });
    expect(view).toMatchObject({ kind: "s3", s3: { bucket: "acme-files", prefix: "agentes" } });

    const after = await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, doc("Depois"));
    const objects = [...(f.s3.buckets.get("acme-files")?.keys() ?? [])];
    expect(objects).toHaveLength(1);
    expect(objects[0]?.startsWith(`agentes/artifacts/${after.id}/v1-`)).toBe(true);
    expect(
      [...f.platformBlobs.objects.keys()].some((k) => k.startsWith(`orgs/${f.org.id}/artifacts/${before.id}/v1-`)),
    ).toBe(true);
    expect((await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, before.id)).content).toEqual(
      doc("Antes").content,
    );
    expect((await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, after.id)).content).toEqual(
      doc("Depois").content,
    );
    // Downloads of bucket files are signed by the bucket (and the signature holds).
    const link = await artifactDownload(f.artifactDeps, f.owner.id, f.org.id, after.id);
    expect(link.url.startsWith(`https://s3.example.com/acme-files/agentes/artifacts/${after.id}/v1-`)).toBe(true);
    expect(await (await f.s3.fetch(link.url, { method: "GET" })).text()).toBe("# Depois");

    // Back to platform storage: new files go there; bucket files still read.
    await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "agentes" });
    const back = await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, doc("De volta"));
    expect(
      [...f.platformBlobs.objects.keys()].some((k) => k.startsWith(`orgs/${f.org.id}/artifacts/${back.id}/v1-`)),
    ).toBe(true);
    expect((await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, after.id)).title).toBe("Depois");
  });

  test("the migration copies old files to the bucket and resumes after a failure", async () => {
    f = await setup();
    const files = [];
    for (const t of ["Um", "Dois", "Três"]) {
      files.push(await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, doc(t)));
    }
    await testStorage(f.storage, f.owner.id, f.org.id, bucket());
    await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "s3", s3: bucket() });

    // The second read fails: the job stops with progress saved.
    const realGet = f.platformBlobs.get;
    let reads = 0;
    f.platformBlobs.get = async (key) => {
      reads++;
      if (reads === 2) throw new StorageError("network", "boom");
      return realGet(key);
    };
    expect(await startMigration(f.storage, f.owner.id, f.org.id)).toMatchObject({ status: "running", total: 3 });
    await drainOutbox(f.db, f.handlers);
    expect(await getMigration(f.db, f.owner.id, f.org.id)).toMatchObject({ status: "failed", copied: 1, total: 3 });

    f.platformBlobs.get = realGet;
    await startMigration(f.storage, f.owner.id, f.org.id);
    await drainOutbox(f.db, f.handlers);
    expect(await getMigration(f.db, f.owner.id, f.org.id)).toMatchObject({ status: "done", copied: 3, total: 3 });
    const versions = await f.db.select().from(schema.artifactVersions);
    expect(versions.every((v) => v.storageConfigId !== null && v.blobKey.startsWith("agentes/"))).toBe(true);
    expect(f.s3.buckets.get("acme-files")?.size).toBe(3);
    for (const file of files) {
      const read = await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, file.id);
      expect(read.content).toEqual(doc(file.title).content);
    }
    // Nothing left to copy: a new migration is done at once.
    await startMigration(f.storage, f.owner.id, f.org.id);
    await drainOutbox(f.db, f.handlers);
    expect(await getMigration(f.db, f.owner.id, f.org.id)).toMatchObject({ status: "done", copied: 0, total: 0 });
  });

  test("the migration deletes the source copy and skips trashed artifacts", async () => {
    f = await setup();
    const keep = await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, doc("Fica"));
    const trash = await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, doc("Lixo"));
    await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, trash.id);
    await testStorage(f.storage, f.owner.id, f.org.id, bucket());
    await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "s3", s3: bucket() });

    const [before] = await f.db
      .select()
      .from(schema.artifactVersions)
      .where(eq(schema.artifactVersions.artifactId, keep.id));
    if (!before) throw new Error("no version row");
    const sourceKey = before.blobKey;
    expect(f.platformBlobs.objects.has(sourceKey)).toBe(true);

    // Only the live artifact counts; without the live-only filter this would be 2.
    expect(await startMigration(f.storage, f.owner.id, f.org.id)).toMatchObject({ status: "running", total: 1 });
    await drainOutbox(f.db, f.handlers);
    expect(await getMigration(f.db, f.owner.id, f.org.id)).toMatchObject({ status: "done", copied: 1 });

    // The live file moved to the bucket and its source copy was deleted (no pile-up when cycling storages).
    expect(f.s3.buckets.get("acme-files")?.size).toBe(1);
    expect(f.platformBlobs.objects.has(sourceKey)).toBe(false);
    expect((await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, keep.id)).content).toEqual(
      doc("Fica").content,
    );
  });

  test("the migration keeps a workspace's own bucket copy; only platform copies are freed", async () => {
    f = await setup();
    const art = await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, doc("Minha"));
    await testStorage(f.storage, f.owner.id, f.org.id, bucket());
    await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "s3", s3: bucket() });
    await startMigration(f.storage, f.owner.id, f.org.id);
    await drainOutbox(f.db, f.handlers);

    // The version now lives in the workspace's own bucket.
    const [onBucket] = await f.db
      .select()
      .from(schema.artifactVersions)
      .where(eq(schema.artifactVersions.artifactId, art.id));
    if (!onBucket?.storageConfigId) throw new Error("expected the version on the bucket");
    const bucketKey = onBucket.blobKey;
    expect(f.s3.buckets.get("acme-files")?.has(bucketKey)).toBe(true);

    // Switch back to the platform and migrate: the bucket copy is theirs and must be kept, not deleted.
    await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "agentes" });
    await startMigration(f.storage, f.owner.id, f.org.id);
    await drainOutbox(f.db, f.handlers);
    const [backOnPlatform] = await f.db
      .select()
      .from(schema.artifactVersions)
      .where(eq(schema.artifactVersions.artifactId, art.id));
    expect(backOnPlatform?.storageConfigId).toBeNull();
    expect(f.s3.buckets.get("acme-files")?.has(bucketKey)).toBe(true);
  });

  test("credentials never leak: hints only, sealed at rest, not in the audit log", async () => {
    f = await setup();
    await testStorage(f.storage, f.owner.id, f.org.id, bucket());
    await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "s3", s3: bucket() });
    const view = await getStorage(f.db, f.owner.id, f.org.id);
    expect(view.s3).toMatchObject({ accessKeyIdHint: "••••TEST", secretHint: "••••3456" });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    const rows = await f.db.select().from(schema.storageConfigs);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, f.org.id));
    expect(
      audit
        .map((a) => a.action)
        .filter((a) => a.startsWith("storage."))
        .sort(),
    ).toEqual(["storage.activated", "storage.test_passed"]);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    // Re-testing with empty keys reuses the stored ones.
    const again = await testStorage(f.storage, f.owner.id, f.org.id, {
      ...bucket(),
      accessKeyId: "",
      secretAccessKey: "",
    });
    expect(again.ok).toBe(true);
  });

  test("a deleted account's photos leave platform storage, never while the account exists, and nobody else's go", async () => {
    f = await setup();
    const bia = await addUser(f.db, "bia");
    const photos = [`avatars/${f.owner.id}/a.png`, `avatars/${bia.id}/b.png`, `avatars/${bia.id}/c.png`];
    for (const key of photos) await f.platformBlobs.put(key, new Uint8Array([1]), { contentType: "image/png" });
    const purge = () => enqueue(f.db, { orgId: null, kind: USER_FILES_PURGE_JOB, payload: { userId: bia.id } });

    await purge();
    await drainOutbox(f.db, f.handlers);
    expect([...f.platformBlobs.objects.keys()].sort()).toEqual(photos.sort());
    await f.db.delete(schema.users).where(eq(schema.users.id, bia.id));
    await purge();
    await drainOutbox(f.db, f.handlers);
    expect([...f.platformBlobs.objects.keys()]).toEqual([`avatars/${f.owner.id}/a.png`]);
  });

  test("a deleted workspace's files leave platform storage a page at a time, and nobody else's go", async () => {
    f = await setup();
    const put = (key: string) => f.platformBlobs.put(key, new Uint8Array([1]), { contentType: "text/plain" });
    const { organization: second } = await createOrganization(f.db, f.owner.id, { name: "Two" });
    const bia = await addUser(f.db, "bia");
    const { organization: hers } = await createOrganization(f.db, bia.id, { name: "Bia's" });
    // A full page and one key more, then the logo.
    for (let i = 0; i <= 1000; i++) await put(`orgs/${f.org.id}/artifacts/a${i}/v1`);
    await put(`org-logos/${f.org.id}/logo.png`);
    await put(`orgs/${second.id}/skills/s/SKILL.md`);
    await put(`orgs/${second.id}/connector-icons/c/0123456789abcdef.png`);
    const kept = [`orgs/${hers.id}/artifacts/b/v1`, `org-logos/${hers.id}/logo.png`, `avatars/${bia.id}/me.png`];
    for (const key of kept) await put(key);
    const purges = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, ORG_FILES_PURGE_JOB));
    const runsOf = async (orgId: string) => (await purges()).filter((j) => j.payload.orgId === orgId);

    for (const orgId of [f.org.id, second.id]) await deleteForGood(orgId);
    // Two per workspace: one now, one a day later.
    const queued = (await purges()).map((j) => ({ orgId: j.orgId, payload: j.payload }));
    expect(queued).toEqual(
      expect.arrayContaining([
        { orgId: null, payload: { orgId: f.org.id } },
        { orgId: null, payload: { orgId: second.id } },
      ]),
    );
    expect(queued).toHaveLength(4);

    await drainOutbox(f.db, f.handlers);
    expect([...f.platformBlobs.objects.keys()].sort()).toEqual(kept.sort());
    // The full first page ran the job once more.
    expect((await runsOf(f.org.id)).map((j) => j.status).sort()).toEqual(["done", "done", "pending"]);
    expect((await runsOf(second.id)).map((j) => j.status).sort()).toEqual(["done", "pending"]);

    // Run again, and a day later: nothing is left and nothing more is queued. A workspace that still exists keeps
    // its files.
    for (const orgId of [f.org.id, hers.id])
      await enqueue(f.db, { orgId: null, kind: ORG_FILES_PURGE_JOB, payload: { orgId } });
    await drainOutbox(f.db, f.handlers, { now: new Date(Date.now() + 2 * DAY) });
    expect([...f.platformBlobs.objects.keys()].sort()).toEqual(kept.sort());
    expect(await runsOf(f.org.id)).toHaveLength(4);
    expect((await purges()).every((j) => j.status === "done")).toBe(true);
  });

  test("the purge outlasts a storage outage, and its pass a day later takes a file stored after the first", async () => {
    f = await setup();
    const t0 = Date.now();
    const filesOf = (orgId: string) =>
      [...f.platformBlobs.objects.keys()].filter((k) => k.startsWith(`orgs/${orgId}/`));
    await f.platformBlobs.put(`orgs/${f.org.id}/artifacts/a/v1`, new Uint8Array([1]), { contentType: "text/plain" });
    // Every delete fails for 5 hours.
    const remove = f.platformBlobs.delete;
    f.platformBlobs.delete = async (key) => {
      if (Date.now() < t0 + 5 * HOUR) throw new Error("storage unreachable");
      await remove(key);
    };
    const purges = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, ORG_FILES_PURGE_JOB));
    // The clock jumps to each purge when it is due, up to `until`.
    const runUntil = async (until: number) => {
      for (;;) {
        const next = Math.min(
          ...(await purges()).filter((j) => j.status === "pending").map((j) => j.nextAttemptAt.getTime()),
        );
        if (!(next <= until)) return;
        setSystemTime(new Date(Math.max(next, Date.now())));
        await drainOutbox(f.db, f.handlers);
      }
    };

    await deleteForGood(f.org.id);
    await runUntil(t0 + 20 * HOUR);
    // Eight tries failed, all that the default budget gives, and the ninth, after the outage, deleted the file.
    expect((await purges()).find((j) => j.status === "done")?.attempts).toBe(9);
    expect(filesOf(f.org.id)).toEqual([]);

    // An agent's upload under way: the file is stored, then its row is refused (the workspace is gone).
    const agent = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
    await expect(createArtifact(f.artifactDeps, agent, f.org.id, doc("Late"))).rejects.toThrow();
    expect(filesOf(f.org.id)).toHaveLength(1);
    await runUntil(t0 + 2 * DAY);
    expect(filesOf(f.org.id)).toEqual([]);
    expect((await purges()).map((j) => j.status)).toEqual(["done", "done"]);
  });

  test("on a disk, a deleted workspace's folders go whole, with the folder names people chose", async () => {
    f = await setup();
    const dir = await mkdtemp(join(tmpdir(), "agentes-purge-"));
    try {
      const disk = createDiskBlobStore(dir);
      const gone = crypto.randomUUID();
      const keys = [
        `orgs/${gone}/skills/s/v1/clientes/acme-contrato-2026/notes.md`,
        `org-logos/${gone}/logo.png`,
        `orgs/${f.org.id}/artifacts/a/v1`,
      ];
      for (const key of keys) await disk.put(key, new Uint8Array([1]), { contentType: "text/plain" });
      for (const orgId of [gone, f.org.id])
        expect(await purgeOrgFiles({ ...f.storage, platform: disk }, orgId)).toBe(false);
      expect(await readdir(join(dir, "orgs"))).toEqual([f.org.id]);
      expect(await readdir(join(dir, "org-logos"))).toEqual([]);
      expect(await disk.list("")).toEqual([`orgs/${f.org.id}/artifacts/a/v1`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("only admins manage storage", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(getStorage(f.db, bia.id, f.org.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(testStorage(f.storage, bia.id, f.org.id, bucket())).rejects.toBeInstanceOf(ForbiddenError);
    const revert = saveStorage(f.storage, bia.id, f.org.id, { kind: "agentes" });
    await expect(revert).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startMigration(f.storage, bia.id, f.org.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("the SSRF guard holds: https only, no private, loopback, link-local or metadata addresses", async () => {
    f = await setup();
    const requests = f.s3.state.requests;
    const endpoints = [
      "http://s3.example.com",
      "https://169.254.169.254",
      "https://127.0.0.1:9000",
      "https://[::1]",
      "https://localhost",
      "https://minio.internal",
      "https://user:pass@s3.example.com",
      "https://storage.corp.test", // resolves to 10.0.0.5 in the fixture
    ];
    for (const endpoint of endpoints) {
      const result = await testStorage(f.storage, f.owner.id, f.org.id, bucket({ endpoint }));
      expect(result.ok).toBe(false);
      expect(result.steps[0]?.error).toBeTruthy();
    }
    expect(f.s3.state.requests).toBe(requests); // nothing was sent
    const blocked = ["10.1.2.3", "172.20.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::ffff:127.0.0.1", "fe80::1"];
    for (const ip of blocked) expect(isBlockedAddress(ip)).toBe(true);
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
    await expect(assertPublicHttpsUrl("https://s3.example.com", async () => ["93.184.216.34"])).resolves.toBeDefined();
    const metadata = assertPublicHttpsUrl("https://x.example.com", async () => ["169.254.169.254"]);
    await expect(metadata).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("voice recordings in a copy between storages", () => {
  const voiceDeps = () => ({
    db: f.db,
    pubsub: f.pubsub,
    blobs: f.artifactDeps.blobs,
    engines: () => [
      {
        id: "groq" as const,
        model: "fake",
        nanoUsdPerHour: 0,
        minBilledSeconds: 0,
        file: async () => ({ text: "oi" }),
      },
    ],
    limits: null,
    retentionDays: 90,
  });
  const recording = () => ({
    audio: new Uint8Array([1, 2, 3]),
    contentType: "audio/mp4",
    durationMs: 1000,
    peaks: [],
    clientId: crypto.randomUUID(),
  });

  test("kept recordings move, swept ones are skipped", async () => {
    f = await setup();
    const kept = await acceptVoiceClip(voiceDeps(), f.owner.id, f.org.id, f.general.id, recording());
    const swept = await acceptVoiceClip(voiceDeps(), f.owner.id, f.org.id, f.general.id, recording());
    const { voiceClips } = schema;
    await f.db.update(voiceClips).set({ audioDeletedAt: new Date() }).where(eq(voiceClips.id, swept.clipId));
    expect((await testStorage(f.storage, f.owner.id, f.org.id, bucket())).ok).toBe(true);
    await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "s3", s3: bucket() });
    await startMigration(f.storage, f.owner.id, f.org.id);
    await drainOutbox(f.db, f.handlers);
    const [moved] = await f.db.select().from(voiceClips).where(eq(voiceClips.id, kept.clipId));
    const [left] = await f.db.select().from(voiceClips).where(eq(voiceClips.id, swept.clipId));
    expect(moved?.storageConfigId).not.toBeNull();
    expect(moved?.blobKey).toBe(`agentes/voice/${kept.clipId}`);
    expect(left?.storageConfigId).toBeNull();
  });
});

describe("what a workspace's files take", () => {
  const bytes = (n: number) => new Uint8Array(n).fill(97);
  /** The Drive and skills with `platform` as this server's storage. */
  const on = (platform: BlobStore): ArtifactDeps => ({
    db: f.db,
    blobs: createBlobStoreResolver({ ...f.storage, platform }),
    pubsub: f.pubsub,
  });
  const upload = (deps: ArtifactDeps, orgId: string, name: string, size: number) =>
    createFileArtifact(deps, person(f.owner.id), orgId, { title: name, name, bytes: bytes(size) });
  const skill = (deps: ArtifactDeps, orgId: string, files: [string, number][]) =>
    saveSkill({ db: f.db, blobs: deps.blobs }, f.owner.id, orgId, {
      name: "relatorio-semanal",
      description: "Monta o relatório da semana.",
      body: "Siga o modelo.",
      metadata: {},
      source: "manual",
      files: files.map(([path, size]) => ({ path, data: bytes(size) })),
    });
  /** The bytes of the files under `dir`, their content types left out. */
  const folderBytes = async (dir: string) => {
    let total = 0;
    for (const name of await readdir(dir, { recursive: true })) {
      const file = await stat(join(dir, name));
      if (file.isFile() && !name.endsWith(".type")) total += file.size;
    }
    return total;
  };

  test("on this server's disk: every version kept and the skills' files, the trash and other workspaces apart", async () => {
    f = await setup();
    const dir = await mkdtemp(join(tmpdir(), "agentes-usage-"));
    try {
      const deps = on(createDiskBlobStore(dir));
      expect(await storedBytes(f.db, f.org.id)).toEqual({ platformBytes: 0, ownBucketBytes: 0 });
      const report = await upload(deps, f.org.id, "relatorio.pdf", 3000);
      await addFileVersion(deps, person(f.owner.id), f.org.id, report.id, {
        name: "relatorio.pdf",
        bytes: bytes(5000),
      });
      const old = await upload(deps, f.org.id, "antigo.zip", 7000);
      // A skill's picture is stored too, for its agents to see.
      await skill(deps, f.org.id, [
        ["modelo.md", 400],
        ["exemplo.png", 900],
      ]);
      const { organization: other } = await createOrganization(f.db, f.owner.id, { name: "Outra" });
      await upload(deps, other.id, "deles.pdf", 11_000);
      await deleteArtifact(deps, f.owner.id, f.org.id, old.id);

      expect(await storedBytes(f.db, f.org.id)).toEqual({ platformBytes: 9300, ownBucketBytes: 0 });
      expect(await storedBytes(f.db, other.id)).toEqual({ platformBytes: 11_000, ownBucketBytes: 0 });
      // The folder holds as much, and the file in the trash until it goes for good.
      expect(await folderBytes(join(dir, "orgs", f.org.id))).toBe(9300 + 7000);
      await restoreArtifact(deps, f.owner.id, f.org.id, old.id);
      expect(await storedBytes(f.db, f.org.id)).toEqual({ platformBytes: 16_300, ownBucketBytes: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("in this server's database: what its rows hold for the workspace, the trash apart", async () => {
    f = await setup();
    const deps = on(createPostgresBlobStore(f.db));
    await upload(deps, f.org.id, "planilha.xlsx", 1200);
    await skill(deps, f.org.id, [["modelo.md", 300]]);
    const draft = await upload(deps, f.org.id, "rascunho.txt", 500);
    await deleteArtifact(deps, f.owner.id, f.org.id, draft.id);
    expect(await storedBytes(f.db, f.org.id)).toEqual({ platformBytes: 1500, ownBucketBytes: 0 });
    const [rows] = await f.db
      .select({ size: sql<string>`sum(${schema.blobs.size})` })
      .from(schema.blobs)
      .where(eq(schema.blobs.orgId, f.org.id));
    expect(Number(rows?.size)).toBe(1500 + 500);
  });

  test("in the workspace's own bucket: what went there, apart from what this server keeps", async () => {
    f = await setup();
    const deps = f.artifactDeps;
    await upload(deps, f.org.id, "antes.pdf", 2000);
    await testStorage(f.storage, f.owner.id, f.org.id, bucket());
    await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "s3", s3: bucket() });
    await upload(deps, f.org.id, "depois.pdf", 6000);
    await skill(deps, f.org.id, [["modelo.md", 250]]);
    expect(await storedBytes(f.db, f.org.id)).toEqual({ platformBytes: 2000, ownBucketBytes: 6250 });
    const objects = [...(f.s3.buckets.get("acme-files")?.values() ?? [])];
    expect(objects.reduce((n, o) => n + o.body.byteLength, 0)).toBe(6250);
    // Copying the files kept before moves them to the bucket's side.
    await startMigration(f.storage, f.owner.id, f.org.id);
    await drainOutbox(f.db, f.handlers);
    expect(await storedBytes(f.db, f.org.id)).toEqual({ platformBytes: 0, ownBucketBytes: 8250 });
    // Back on this server, the bucket still holds its files.
    await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "agentes" });
    await upload(deps, f.org.id, "de-volta.pdf", 100);
    expect(await storedBytes(f.db, f.org.id)).toEqual({ platformBytes: 100, ownBucketBytes: 8250 });
  });

  test("a small workspace next to a big one: summed through its own rows, never the whole table", async () => {
    f = await setup();
    const { organization: big } = await createOrganization(f.db, f.owner.id, { name: "Grande" });
    // Files of 5 versions each, a tenth of them in the trash: 20,000 in the big one, 20 in the small one.
    for (const [orgId, files] of [
      [big.id, 20_000],
      [f.org.id, 20],
    ] as const) {
      await f.db.execute(sql`insert into artifacts (id, org_id, kind, title, created_by_type, created_by_id,
          updated_by_type, updated_by_id, deleted_at)
        select gen_random_uuid(), ${orgId}, 'file', 'arquivo ' || i, 'person', ${f.owner.id}, 'person', ${f.owner.id},
          case when i % 10 = 0 then now() end
        from generate_series(1, ${files}) i`);
      await f.db.execute(sql`insert into artifact_versions (id, org_id, artifact_id, version, blob_key, content_type,
          size, sha256, author_type, author_id)
        select gen_random_uuid(), a.org_id, a.id, v, 'k/' || a.id || '/' || v, 'application/pdf', 1000, '',
          'person', ${f.owner.id}
        from artifacts a, generate_series(1, 5) v where a.org_id = ${orgId}`);
    }
    // The planner's statistics, as autovacuum keeps them on a server.
    await f.db.execute(sql`analyze artifacts`);
    await f.db.execute(sql`analyze artifact_versions`);
    expect(await storedBytes(f.db, big.id)).toEqual({ platformBytes: 18_000 * 5 * 1000, ownBucketBytes: 0 });
    expect(await storedBytes(f.db, f.org.id)).toEqual({ platformBytes: 18 * 5 * 1000, ownBucketBytes: 0 });
    // The plan, not a time: here a scan of both tables takes milliseconds too, and on a server of many workspaces
    // it grows with all of them.
    const [drive] = storedBytesQueries(f.db, f.org.id);
    const plan = rowsOf<{ "QUERY PLAN": string }>(await f.db.execute(sql`explain ${drive.getSQL()}`))
      .map((row) => row["QUERY PLAN"])
      .join("\n");
    expect(plan).toContain("Index");
    expect(plan).not.toMatch(/Seq Scan on artifact/);
  }, 120_000);
});
