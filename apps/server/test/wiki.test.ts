import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }), env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

/** A signed-up person outside the organization (sign-up is open on this server). */
async function outsider(email: string) {
  const b = browser(t);
  await signUp(b, email);
  return b;
}

type Page = { id: string; slug: string; version: number; backlinks: { kind: string }[]; body: string };

test("wiki API: create, edit with version check, rename, history, graph, links in messages", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const created = await api("/wiki/pages", {
    json: { title: "Guia de Deploy", folder: "Processos", body: "## Rollback\nx" },
  });
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ slug: "guia-de-deploy", folder: "Processos", version: 1 });
  const dup = await api("/wiki/pages", { json: { title: "guia de deploy", body: "" } });
  expect(dup.status).toBe(409);
  expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("slug_taken");

  const saved = await api("/wiki/pages/guia-de-deploy", {
    method: "PUT",
    json: { body: "## Rollback\ny", baseVersion: 1, note: "corrigi" },
  });
  expect(((await saved.json()) as Page).version).toBe(2);
  const stale = await api("/wiki/pages/guia-de-deploy", { method: "PUT", json: { body: "z", baseVersion: 1 } });
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("version_conflict");

  await api("/wiki/pages", { json: { title: "Runbook", body: "Veja [[Guia de Deploy#Rollback]]" } });
  const posted = await api(`/channels/${channelId}/messages`, { json: { body: "olha o [[Guia de Deploy]]" } });
  const message = (await posted.json()) as { id: string; meta: { wikiLinks?: { slug: string; exists: boolean }[] } };
  expect(message.meta.wikiLinks).toEqual([expect.objectContaining({ slug: "guia-de-deploy", exists: true })]);
  const listed = (await (await api(`/channels/${channelId}/messages`)).json()) as {
    messages: { id: string; meta: { wikiLinks?: unknown[] } }[];
  };
  expect(listed.messages.find((m) => m.id === message.id)?.meta.wikiLinks).toHaveLength(1);

  const renamed = await api("/wiki/pages/guia-de-deploy/rename", { json: { title: "Publicação" } });
  expect(await renamed.json()).toMatchObject({ slug: "publicacao" });
  const runbook = (await (await api("/wiki/pages/runbook")).json()) as Page;
  expect(runbook.body).toBe("Veja [[Publicação#Rollback]]");
  const page = (await (await api("/wiki/pages/guia-de-deploy")).json()) as Page;
  expect(page.slug).toBe("publicacao");
  expect(page.backlinks.map((b) => b.kind).sort()).toEqual(["message", "page"]);

  const history = (await (await api("/wiki/pages/publicacao/history")).json()) as { versions: { version: number }[] };
  expect(history.versions.map((v) => v.version)).toEqual([3, 2, 1]);
  expect(await (await api("/wiki/pages/publicacao/versions/1")).json()).toMatchObject({
    version: 1,
    body: "## Rollback\nx",
  });
  const diff = (await (await api("/wiki/pages/publicacao/diff?from=1&to=2")).json()) as { patch: string };
  expect(diff.patch).toContain("+y");
  expect(await (await api("/wiki/graph")).json()).toMatchObject({ edges: [{ from: "runbook", to: "publicacao" }] });
  const search = (await (await api("/wiki/search?q=pub")).json()) as { pages: { slug: string }[] };
  expect(search.pages.map((p) => p.slug)).toEqual(["publicacao"]);
  const all = (await (await api("/wiki/pages")).json()) as { pages: unknown[] };
  expect(all.pages).toHaveLength(2);
  const resolved = (await (await api("/wiki/resolve", { json: { targets: ["Publicação", "Nada"] } })).json()) as {
    links: { exists: boolean }[];
  };
  expect(resolved.links.map((l) => l.exists)).toEqual([true, false]);

  const append = await api("/wiki/pages/publicacao/append", {
    json: { source: { kind: "message", channelId, messageId: message.id } },
  });
  expect(((await append.json()) as Page).body).toContain("olha o [[Guia de Deploy]]");

  expect((await api("/wiki/pages/runbook", { method: "DELETE" })).status).toBe(204);
  expect((await api("/wiki/pages/runbook")).status).toBe(404);
  expect((await api("/wiki/pages/runbook/restore", { json: {} })).status).toBe(200);

  const stranger = await outsider("stranger@example.com");
  expect((await stranger(`/api/app/organizations/${orgId}/wiki/pages`)).status).toBe(403);
});

test("wiki API: Obsidian import in batches, pin, what the agents read", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const imported = await api("/wiki/import", {
    json: {
      source: { type: "obsidian", name: "Acme Vault" },
      onConflict: "keep_both",
      folder: "Obsidian",
      notes: [
        { title: "Início", body: "Veja [[Mercado Bom]].", tags: ["mapa"], aliases: ["Home"] },
        { title: "Mercado Bom", folder: "Clientes", body: "Volta ao [[Home]]." },
      ],
    },
  });
  expect(imported.status).toBe(200);
  const result = (await imported.json()) as { created: { slug: string; folder: string; sourceType: string }[] };
  expect(result.created).toMatchObject([
    { slug: "inicio", folder: "Obsidian", sourceType: "obsidian" },
    { slug: "mercado-bom", folder: "Obsidian/Clientes", sourceType: "obsidian" },
  ]);
  const home = (await (await api("/wiki/pages/home")).json()) as Page & { reads: unknown };
  expect(home.slug).toBe("inicio");
  expect(home.backlinks).toMatchObject([{ kind: "page", slug: "mercado-bom" }]);
  expect(home.reads).toEqual({ total: 0, agents: [], last: null });
  const graph = (await (await api("/wiki/graph")).json()) as { nodes: { sourceType: string | null }[] };
  expect(graph.nodes.every((n) => n.sourceType === "obsidian")).toBe(true);

  const pinned = await api("/wiki/pages/inicio/pin", { json: { pinned: true } });
  expect(((await pinned.json()) as { pinned: boolean }).pinned).toBe(true);
  expect(await (await api("/wiki/reads")).json()).toEqual([]);

  const tooMany = await api("/wiki/import", {
    json: {
      source: { type: "obsidian", name: "x" },
      notes: Array.from({ length: 501 }, (_, i) => ({ title: `N${i}`, body: "" })),
    },
  });
  expect(tooMany.status).toBe(400);
});

test("wiki API: a page limited to admins and agents is out of reach for other members", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com", { role: "admin" });
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const api = (b: typeof owner, path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
  const { roles } = (await (await api(owner, "/roles")).json()) as { roles: { id: string; permissions: string[] }[] };
  const adminRole = roles.find((r) => r.permissions.includes("administrator"))?.id ?? "";

  await api(owner, "/wiki/pages", { json: { title: "Margens", body: "Margem mínima de 40%." } });
  const denied = await api(bia, "/wiki/pages/margens/audience", {
    method: "PUT",
    json: { audience: { roleIds: [], userIds: [] }, agentIds: [] },
  });
  expect(denied.status).toBe(403);
  expect(await errorCode(denied)).toBe("wiki.audience_forbidden");
  const set = await api(ana, "/wiki/pages/margens/audience", {
    method: "PUT",
    json: { audience: { roleIds: [adminRole], userIds: [] } },
  });
  expect(set.status).toBe(200);
  expect(((await set.json()) as { audience: unknown }).audience).toEqual({ roleIds: [adminRole], userIds: [] });

  const opened = await api(bia, "/wiki/pages/margens");
  expect(opened.status).toBe(403);
  expect(await errorCode(opened)).toBe("wiki.no_access");
  expect((await api(ana, "/wiki/pages/margens")).status).toBe(200);
  const listed = (await (await api(bia, "/wiki/pages")).json()) as { pages: unknown[] };
  expect(listed.pages).toEqual([]);
  const tree = (await (await api(bia, "/wiki/tree")).json()) as { pages: unknown[] };
  expect(tree.pages).toEqual([]);
  const search = (await (await api(bia, "/wiki/search?q=marg")).json()) as { pages: unknown[] };
  expect(search.pages).toEqual([]);
  const posted = (await (
    await api(bia, `/channels/${channelId}/messages`, { json: { body: "e as [[Margens]]?" } })
  ).json()) as {
    meta: { wikiLinks?: unknown[] };
  };
  expect(posted.meta.wikiLinks).toEqual([
    {
      target: "Margens",
      label: "Margens",
      section: null,
      slug: "margens",
      title: null,
      exists: true,
      restricted: true,
    },
  ]);
  const edit = await api(bia, "/wiki/pages/margens", { method: "PUT", json: { body: "x", baseVersion: 1 } });
  expect(edit.status).toBe(403);

  const reopened = await api(owner, "/wiki/pages/margens/audience", { method: "PUT", json: { audience: null } });
  expect(reopened.status).toBe(200);
  expect((await api(bia, "/wiki/pages/margens")).status).toBe(200);

  // Everyone sees it; only the role edits.
  const editors = await api(owner, "/wiki/pages/margens/audience", {
    method: "PUT",
    json: { audience: null, agentIds: null, editors: { roleIds: [adminRole], userIds: [] }, agentEditorIds: null },
  });
  expect(editors.status).toBe(200);
  const asBia = (await (await api(bia, "/wiki/pages/margens")).json()) as { canEdit: boolean; version: number };
  expect(asBia.canEdit).toBe(false);
  const refused = await api(bia, "/wiki/pages/margens", {
    method: "PUT",
    json: { body: "x", baseVersion: asBia.version },
  });
  expect(refused.status).toBe(403);
  expect(await errorCode(refused)).toBe("wiki.edit_limited");

  // A folder reaches its pages, and what's inside it can only be narrower.
  await api(owner, "/wiki/pages", { json: { title: "Contrato", folder: "Financeiro", body: "x" } });
  const folder = await api(owner, "/wiki/folder-audience", {
    method: "PUT",
    json: { folder: "Financeiro", audience: { roleIds: [adminRole], userIds: [] }, agentIds: [] },
  });
  expect(folder.status).toBe(200);
  expect(await folder.json()).toEqual({ folder: "Financeiro", pages: 1 });
  expect((await api(bia, "/wiki/pages/contrato")).status).toBe(403);
  const read = await api(ana, "/wiki/folder-audience?folder=Financeiro");
  expect(((await read.json()) as { own: { agentIds: unknown } }).own.agentIds).toEqual([]);
  const wider = await api(owner, "/wiki/pages/contrato/audience", { method: "PUT", json: { audience: null } });
  expect(wider.status).toBe(400);
  expect(await errorCode(wider)).toBe("wiki.audience_wider_than_folder");
  expect((await api(bia, "/wiki/folder-audience?folder=Financeiro")).status).toBe(403);
});

test("wiki API: a bad note doesn't sink its batch; delete an import, the trash, the root's agents, always in context", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const importId = "0190a000-0000-7000-8000-0000000000aa";

  const imported = await api("/wiki/import", {
    json: {
      source: { type: "obsidian", name: "Vault" },
      importId,
      notes: [
        { title: "Boa", body: "ok", tags: ["t".repeat(120)], aliases: ["a".repeat(400)] },
        { title: "Enorme", body: "x".repeat(250_000) },
        { title: "Outra", body: "ok" },
      ],
    },
  });
  expect(imported.status).toBe(200);
  const result = (await imported.json()) as {
    created: { importId: string }[];
    failed: { title: string; reason: string }[];
  };
  expect(result.created).toHaveLength(2);
  expect(result.created[0]?.importId).toBe(importId);
  expect(result.failed).toEqual([{ title: "Enorme", reason: "too_long" }]);

  const deleted = await api("/wiki/bulk/delete", { json: { importId } });
  expect(await deleted.json()).toEqual({ deleted: 2, kept: 0 });
  const trash = (await (await api("/wiki/pages?deleted=true")).json()) as {
    pages: { id: string; deletedAt: string }[];
  };
  expect(trash.pages).toHaveLength(2);
  const restored = await api("/wiki/trash/restore", { json: { ids: trash.pages.map((p) => p.id) } });
  expect(await restored.json()).toEqual({ restored: 2, kept: 0, failed: [] });
  await api("/wiki/bulk/delete", { json: { ids: [trash.pages[0]?.id] } });
  expect(await (await api("/wiki/trash/purge", { json: {} })).json()).toEqual({ purged: 1, kept: 0 });

  const root = await api("/wiki/folder-audience", {
    method: "PUT",
    json: { folder: "", audience: null, agentIds: [] },
  });
  expect(await root.json()).toEqual({ folder: "", pages: 1 });
  expect(((await (await api("/wiki/folder-audience?folder=")).json()) as { own: { folder: string } }).own.folder).toBe(
    "",
  );
  const agents = await api("/wiki/bulk/agents", { method: "PUT", json: { ids: [trash.pages[1]?.id], agentIds: null } });
  expect(agents.status).toBe(200);

  const on = await api(`/wiki/pages/${trash.pages[1]?.id}/context`, { json: { on: true } });
  expect(((await on.json()) as { agentContext: boolean }).agentContext).toBe(true);
});
