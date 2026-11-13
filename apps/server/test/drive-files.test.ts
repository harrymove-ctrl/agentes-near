import { afterEach, beforeEach, expect, test } from "bun:test";
import { ARTIFACT_LIMITS } from "@agenteschat/engine";
import { type Browser, browser, createTestServer, ORIGIN, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

const PDF = new TextEncoder().encode("%PDF-1.7 not really");

/** A multipart POST with the browser's session cookie and our Origin. */
function upload(b: Browser, path: string, fields: Record<string, string | File>, origin: string = ORIGIN) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return t.app.request(path, { method: "POST", headers: { cookie: b.cookie(), origin }, body: form });
}

test("people upload files as is: download with the real name and type, versions, no JSON shortcut", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}`;
  const api = (path: string, init?: Parameters<typeof owner>[1]) => owner(`${base}${path}`, init);

  const created = await upload(owner, `${base}/artifacts/files`, {
    file: new File([PDF], "relatório.pdf", { type: "application/pdf" }),
    title: "Relatório",
  });
  expect(created.status).toBe(201);
  const a = (await created.json()) as { id: string; kind: string; untrusted: boolean; canEdit: boolean };
  expect(a).toMatchObject({
    kind: "file",
    title: "Relatório",
    untrusted: true,
    canEdit: true,
    versioned: true,
    content: { kind: "file", name: "relatório.pdf", contentType: "application/pdf", size: PDF.byteLength },
  });

  const file = await api(`/artifacts/${a.id}/file`);
  expect(file.status).toBe(200);
  expect(file.headers.get("content-type")).toBe("application/pdf");
  expect(file.headers.get("content-disposition")).toBe(
    `attachment; filename="relat_rio.pdf"; filename*=UTF-8''relat%C3%B3rio.pdf`,
  );
  expect(file.headers.get("x-content-type-options")).toBe("nosniff");
  expect(file.headers.get("content-security-policy")).toBe("sandbox");
  expect(file.headers.get("cache-control")).toBe("private, no-store, no-transform");
  expect(file.headers.get("accept-ranges")).toBe("bytes");
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
  expect((await api(`/artifacts/${a.id}/file?format=pdf`)).status).toBe(400);

  // In parts, as a video player asks: the same safe headers on every part.
  const part = await api(`/artifacts/${a.id}/file`, { headers: { range: "bytes=1-4" } });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe(`bytes 1-4/${PDF.byteLength}`);
  expect(part.headers.get("content-length")).toBe("4");
  expect(part.headers.get("content-disposition")).toStartWith("attachment;");
  expect(part.headers.get("content-security-policy")).toBe("sandbox");
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(PDF.subarray(1, 5));
  const past = await api(`/artifacts/${a.id}/file`, { headers: { range: `bytes=${PDF.byteLength}-` } });
  expect(past.status).toBe(416);
  expect(past.headers.get("content-range")).toBe(`bytes */${PDF.byteLength}`);

  // A new version, by upload only.
  const v2 = await upload(owner, `${base}/artifacts/${a.id}/files`, {
    file: new File(["a,b\n1,2\n"], "dados.csv", { type: "text/csv" }),
    note: "agora em CSV",
  });
  expect(v2.status).toBe(200);
  expect(await v2.json()).toMatchObject({
    version: 2,
    content: { name: "dados.csv", contentType: "text/csv; charset=utf-8", text: "a,b\n1,2\n" },
  });
  const versions = (await (await api(`/artifacts/${a.id}/versions`)).json()) as { versions: { note: string | null }[] };
  expect(versions.versions.map((v) => v.note)).toEqual(["agora em CSV", null]);
  const viaJson = await api(`/artifacts/${a.id}/versions`, {
    json: { content: { kind: "document", markdown: "x" }, baseVersion: 2 },
  });
  expect(viaJson.status).toBe(400);
  const fileJson = await api("/artifacts", {
    json: {
      title: "Falso",
      content: { kind: "file", name: "x.pdf", contentType: "application/pdf", size: 1, sha256: "0" },
    },
  });
  expect(fileJson.status).toBe(400);

  // Versions of uploads only go to files.
  const doc = (await (
    await api("/artifacts", { json: { title: "Plano", content: { kind: "document", markdown: "# Plano" } } })
  ).json()) as { id: string };
  expect((await upload(owner, `${base}/artifacts/${doc.id}/files`, { file: new File([PDF], "x.pdf") })).status).toBe(
    400,
  );

  const list = (await (await api("/artifacts?kind=file")).json()) as { artifacts: { id: string }[] };
  expect(list.artifacts.map((x) => x.id)).toEqual([a.id]);
});

test("uploads: a file is required, other origins are refused, multipart only where it uploads, 50 MB at most", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}`;

  const noFile = await upload(owner, `${base}/artifacts/files`, { title: "Nada" });
  expect(noFile.status).toBe(400);
  const crossSite = await upload(
    owner,
    `${base}/artifacts/files`,
    { file: new File([PDF], "a.pdf") },
    "https://evil.example.com",
  );
  expect(crossSite.status).toBe(403);
  // Other routes still take JSON only.
  expect((await upload(owner, `${base}/artifacts`, { title: "x" })).status).toBe(415);

  const big = await upload(owner, `${base}/artifacts/files`, {
    file: new File([new Uint8Array(ARTIFACT_LIMITS.fileBytes + 1)], "big.bin"),
  });
  // Refused from Content-Length (413) or after reading (400); either way nothing is stored.
  expect([400, 413]).toContain(big.status);
  expect(((await big.json()) as { error: { code: string } }).error.code).toBe("artifact.file_too_large");
  const list = (await (await owner(`${base}/artifacts`)).json()) as { artifacts: unknown[] };
  expect(list.artifacts).toEqual([]);
});

test("a picture is a snapshot: no versions, so a new one is refused in words the app shows", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}`;
  const shot = await upload(owner, `${base}/artifacts/files`, {
    file: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "tela.png", { type: "image/png" }),
    title: "Tela",
  });
  const shotView = (await shot.json()) as { id: string; versioned: boolean };
  expect(shotView.versioned).toBe(false);
  const shotV2 = await upload(owner, `${base}/artifacts/${shotView.id}/files`, {
    file: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0])], "tela.png", { type: "image/png" }),
  });
  expect(shotV2.status).toBe(400);
  expect(((await shotV2.json()) as { error: { code: string } }).error.code).toBe("artifact.not_versioned");
});
