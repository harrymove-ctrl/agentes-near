import { afterEach, beforeEach, expect, test } from "bun:test";
import { statfsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeS3 } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import { storagePlatform } from "../src/routes/app/storage";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

const SECRET = "secret-test-key-123456";
let t: TestServer;
let s3: ReturnType<typeof createFakeS3>;
beforeEach(async () => {
  s3 = createFakeS3({
    host: "s3.example.com",
    region: "auto",
    accessKeyId: "AKIATEST",
    secretAccessKey: SECRET,
    buckets: ["acme"],
  });
  t = await createTestServer({ s3Fetch: s3.fetch, resolveHost: async () => ["93.184.216.34"] });
});
afterEach(() => t.close());

const settings = {
  endpoint: "https://s3.example.com",
  region: "auto",
  bucket: "acme",
  prefix: null,
  pathStyle: true,
  accessKeyId: "AKIATEST",
  secretAccessKey: SECRET,
};

test("storage API: masked settings, test before switching, migrate", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const disk = { kind: "disk", folder: null };
  const usage = { platformBytes: 0, ownBucketBytes: 0, disk: null };
  expect(await (await api("/storage")).json()).toEqual({
    kind: "agentes",
    s3: null,
    migration: null,
    platform: disk,
    usage,
  });
  const refused = await api("/storage", { method: "PUT", json: { kind: "s3", s3: settings } });
  expect(refused.status).toBe(400);
  const tested = (await (await api("/storage/test", { json: settings })).json()) as { ok: boolean };
  expect(tested.ok).toBe(true);
  const saved = await api("/storage", { method: "PUT", json: { kind: "s3", s3: settings } });
  expect(saved.status).toBe(200);
  const body = await saved.text();
  expect(body).not.toContain(SECRET);
  // The app keeps what a switch answers: where this server keeps files, and what they take, come along.
  expect(JSON.parse(body)).toMatchObject({
    kind: "s3",
    s3: { bucket: "acme", secretHint: "••••3456" },
    platform: disk,
    usage,
  });

  const migration = await api("/storage/migrate", { json: {} });
  expect(await migration.json()).toMatchObject({ status: "running", total: 0 });
  await t.drain();
  expect(await (await api("/storage/migration")).json()).toMatchObject({ status: "done" });

  const ssrf = (await (
    await api("/storage/test", { json: { ...settings, endpoint: "https://169.254.169.254" } })
  ).json()) as { ok: boolean; steps: { error: string | null }[] };
  expect(ssrf.ok).toBe(false);
  expect(ssrf.steps[0]?.error).toContain("internal network");
});

test("storage API: where this server keeps files, with the folder only outside a container", async () => {
  const folder = "/home/walter/.agentes/files";
  const desktop = await createTestServer({ platformKind: "disk", env: { FILES_DIR: folder, INSTALL_MODE: "desktop" } });
  try {
    const owner = browser(desktop);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const read = await owner(`/api/app/organizations/${orgId}/storage`);
    expect(((await read.json()) as { platform: unknown }).platform).toEqual({ kind: "disk", folder });
  } finally {
    await desktop.close();
  }
  const config = { FILES_DIR: "/data/files" };
  expect(storagePlatform("disk", { ...config, INSTALL_MODE: "native" })).toEqual({
    kind: "disk",
    folder: "/data/files",
  });
  // Inside Docker the path is the container's: said or guessed, it never shows.
  expect(storagePlatform("disk", { ...config, INSTALL_MODE: "docker" })).toEqual({ kind: "disk", folder: null });
  expect(storagePlatform("disk", config, true)).toEqual({ kind: "disk", folder: null });
  expect(storagePlatform("disk", config, false)).toEqual({ kind: "disk", folder: "/data/files" });
  expect(storagePlatform("postgres", { INSTALL_MODE: "native" })).toEqual({ kind: "database", folder: null });
  expect(storagePlatform("s3", { ...config, INSTALL_MODE: "native" })).toEqual({ kind: "bucket", folder: null });
});

// This scenario creates four database-backed servers to compare storage modes.
test("storage API: what the workspace's files take, and the disk under this server's folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentes-files-"));
  // In a container: the folder's path stays hidden, its disk is still told.
  const server = await createTestServer({ platformKind: "disk", env: { FILES_DIR: dir, INSTALL_MODE: "docker" } });
  try {
    const owner = browser(server);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const api = (path: string, init?: Parameters<typeof owner>[1]) =>
      owner(`/api/app/organizations/${orgId}${path}`, init);
    await api("/artifacts", { json: { title: "Metas", content: { kind: "document", markdown: "# Metas" } } });
    const [version] = await server.db.select({ size: schema.artifactVersions.size }).from(schema.artifactVersions);
    const read = (await (await api("/storage")).json()) as {
      platform: unknown;
      usage: { platformBytes: number; ownBucketBytes: number; disk: { sizeBytes: number; freeBytes: number } };
    };
    expect(read.platform).toEqual({ kind: "disk", folder: null });
    expect(read.usage).toMatchObject({ platformBytes: version?.size, ownBucketBytes: 0 });
    expect(read.usage.platformBytes).toBeGreaterThan(0);
    const fs = statfsSync(dir);
    expect(read.usage.disk.sizeBytes).toBe(fs.blocks * fs.bsize);
    expect(read.usage.disk.freeBytes).toBeGreaterThan(0);
    expect(read.usage.disk.freeBytes).toBeLessThanOrEqual(read.usage.disk.sizeBytes);
  } finally {
    await server.close();
  }
  // Files in this server's database or in a bucket: no disk of its own to tell.
  for (const platformKind of ["postgres", "s3"]) {
    const other = await createTestServer({ platformKind, env: { FILES_DIR: dir } });
    try {
      const owner = browser(other);
      await signUp(owner, "owner@example.com");
      const { orgId } = await seedOrg(owner);
      const read = (await (await owner(`/api/app/organizations/${orgId}/storage`)).json()) as { usage: unknown };
      expect(read.usage).toEqual({ platformBytes: 0, ownBucketBytes: 0, disk: null });
    } finally {
      await other.close();
    }
  }
  // The Cloud keeps files in a folder too, but its disk is every workspace's: only what this one keeps is told.
  const cloud = await createTestServer({
    platformKind: "disk",
    env: { FILES_DIR: dir, MACHINE_PROVISIONING: "external", OPERATOR_API_TOKEN: "o".repeat(40) },
  });
  try {
    const owner = browser(cloud);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const api = (path: string, init?: Parameters<typeof owner>[1]) =>
      owner(`/api/app/organizations/${orgId}${path}`, init);
    await api("/artifacts", { json: { title: "Metas", content: { kind: "document", markdown: "# Metas" } } });
    const read = (await (await api("/storage")).json()) as { usage: Record<string, unknown> };
    expect(read.usage).toMatchObject({ ownBucketBytes: 0, disk: null });
    expect(read.usage.platformBytes).toBeGreaterThan(0);
  } finally {
    await cloud.close();
  }
  await rm(dir, { recursive: true, force: true });
}, 20_000);

test("Drive API: create, new version, versions, download link, file, delete", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const created = await api("/artifacts", {
    json: { title: "Metas", content: { kind: "table", columns: ["mês", "meta"], rows: [["jan", "10"]] } },
  });
  expect(created.status).toBe(201);
  const a = (await created.json()) as { id: string; version: number; canEdit: boolean };
  expect(a).toMatchObject({ version: 1, canEdit: true });

  const v2 = await api(`/artifacts/${a.id}/versions`, {
    json: { content: { kind: "table", columns: ["mês", "meta"], rows: [["fev", "12"]] }, baseVersion: 1, note: "fev" },
  });
  expect(v2.status).toBe(200);
  const stale = await api(`/artifacts/${a.id}/versions`, {
    json: { content: { kind: "table", columns: ["mês"], rows: [] }, baseVersion: 1 },
  });
  expect(stale.status).toBe(409);
  const versions = (await (await api(`/artifacts/${a.id}/versions`)).json()) as { versions: { note: string | null }[] };
  expect(versions.versions.map((v) => v.note)).toEqual(["fev", null]);
  const old = (await (await api(`/artifacts/${a.id}?version=1`)).json()) as { content: { rows: string[][] } };
  expect(old.content.rows).toEqual([["jan", "10"]]);

  const list = (await (await api("/artifacts?kind=table")).json()) as { artifacts: { id: string }[] };
  expect(list.artifacts.map((x) => x.id)).toEqual([a.id]);
  const link = (await (await api(`/artifacts/${a.id}/download`)).json()) as { url: string; expiresAt: string };
  expect(link.url).toContain("memory://");
  const csv = await api(`/artifacts/${a.id}/file?format=csv`);
  expect(csv.headers.get("content-disposition")).toContain("attachment");
  expect(await csv.text()).toBe("mês,meta\r\nfev,12");

  const html = (await (
    await api("/artifacts", { json: { title: "Página", content: { kind: "html", html: "<script>x</script>" } } })
  ).json()) as { id: string; untrusted: boolean; canEdit: boolean };
  expect(html).toMatchObject({ untrusted: true, canEdit: false });
  const page = await api(`/artifacts/${html.id}/file`);
  expect(page.headers.get("content-disposition")).toContain("attachment");
  expect(page.headers.get("content-security-policy")).toBe("sandbox");

  const doc = (await (
    await api("/artifacts", { json: { title: "Plano", content: { kind: "document", markdown: "# Plano\n\n- um" } } })
  ).json()) as { id: string };
  const pdf = await api(`/artifacts/${doc.id}/file?format=pdf`);
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");

  expect((await api(`/artifacts/${a.id}`, { method: "DELETE" })).status).toBe(204);
  expect((await api(`/artifacts/${a.id}`)).status).toBe(404);
});

test("Drive API: pages with a cursor in the order asked; the first page counts each kind for the filters", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const made = [
    ["Cc", "table"],
    ["Aa", "document"],
    ["Ee", "table"],
    ["Bb", "document"],
    ["Dd", "table"],
  ] as const;
  for (const [title, kind] of made) {
    const content = kind === "table" ? { kind, columns: ["a"], rows: [["1"]] } : { kind, markdown: `# ${title}` };
    expect((await api("/artifacts", { json: { title, content } })).status).toBe(201);
  }
  type Page = { artifacts: { title: string }[]; nextCursor: string | null; counts?: Record<string, number> };
  const read = async (query: string) => (await (await api(`/artifacts?${query}`)).json()) as Page;
  const titles = (p: Page) => p.artifacts.map((a) => a.title);

  const first = await read("limit=2&sort=name");
  expect(titles(first)).toEqual(["Aa", "Bb"]);
  expect(first.counts).toEqual({ table: 3, document: 2 });
  const second = await read(`limit=2&sort=name&cursor=${first.nextCursor}`);
  expect(titles(second)).toEqual(["Cc", "Dd"]);
  expect(second.counts).toBeUndefined();
  const last = await read(`limit=2&sort=name&cursor=${second.nextCursor}`);
  expect([titles(last), last.nextCursor]).toEqual([["Ee"], null]);
  // Newest first by default; kinds narrow the list while the chips still count every kind.
  const tables = await read("kinds=table&limit=2");
  expect(titles(tables)).toEqual(["Dd", "Ee"]);
  expect(tables.counts).toEqual({ table: 3, document: 2 });
  expect(titles(await read("sort=kind"))).toEqual(["Bb", "Aa", "Dd", "Ee", "Cc"]);
  // Quem fez looks at every file, not a page.
  expect(await read("who=agents")).toMatchObject({ artifacts: [], nextCursor: null, counts: {} });
  expect((await read("who=people&limit=1")).counts).toEqual({ table: 3, document: 2 });
});

test("Drive API: canDelete and who can see it on each file; the trash deletes for good", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const created = (await (
    await api("/artifacts", { json: { title: "Metas", content: { kind: "document", markdown: "# Metas" } } })
  ).json()) as { id: string; canDelete: boolean; audience: unknown };
  expect(created.canDelete).toBe(true);
  expect(created.audience).toEqual({ kind: "workspace" });
  const list = (await (await api("/artifacts")).json()) as { artifacts: { canDelete: boolean; audience: unknown }[] };
  expect(list.artifacts[0]).toEqual(expect.objectContaining({ canDelete: true, audience: { kind: "workspace" } }));
  const one = (await (await api(`/artifacts/${created.id}`)).json()) as { canDelete: boolean };
  expect(one.canDelete).toBe(true);

  expect((await api(`/artifacts-trash/${created.id}`, { method: "DELETE" })).status).toBe(404);
  expect((await api(`/artifacts/${created.id}`, { method: "DELETE" })).status).toBe(204);
  expect((await api(`/artifacts-trash/${created.id}`, { method: "DELETE" })).status).toBe(204);
  const trash = (await (await api("/artifacts-trash")).json()) as { files: unknown[] };
  expect(trash.files).toEqual([]);
  expect((await api(`/artifacts/${created.id}/restore`, { json: {} })).status).toBe(409);
});
