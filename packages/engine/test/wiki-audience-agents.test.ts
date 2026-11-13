import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  createAgent,
  createRole,
  createWikiPage,
  deleteWikiPage,
  getWikiFolderAudience,
  getWikiPage,
  importWikiPages,
  moveWikiPage,
  NotFoundError,
  removeMember,
  retrieveWikiForRun,
  searchWiki,
  setMemberRoles,
  setWikiFolderAudience,
  setWikiPageAudience,
  updateWikiPage,
  ValidationError,
  type WikiActor,
  wikiHitsForAgent,
} from "../src";
import { addMember, adminRoleId, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string): WikiActor => ({ type: "person", userId });
const agent = (agentId: string): WikiActor => ({ type: "agent", agentId, requestedByUserId: null });
const wikiDeps = () => ({ db: f.db, pubsub: f.pubsub, search: f.context, artifacts: f.artifactDeps });
const code = (e: unknown) => (e as { code?: string }).code;

async function workspace() {
  f = await setup();
  const deps = wikiDeps();
  const other = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Infra", handle: "infra", role: "Infra", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const ana = await addMember(f.db, f.org.id, "admin", "ana");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const admin = await adminRoleId(f.db, f.org.id);
  const page = await createWikiPage(deps, person(f.owner.id), f.org.id, {
    title: "Margens",
    folder: "Financeiro",
    body: "Margem mínima de 40% nos contratos.",
  });
  return { deps, other, ana, bia, admin, page };
}

/** Someone who manages roles and edits the wiki, and is no administrator: an administrator may leave themselves out. */
async function rolesManager() {
  const role = await createRole(f.db, f.owner.id, f.org.id, {
    name: "Gestão",
    permissions: ["manage_roles", "edit_wiki"],
  });
  const manager = await addMember(f.db, f.org.id, "member", "gestor");
  await setMemberRoles(f.db, f.owner.id, f.org.id, manager.id, [role.id]);
  return manager;
}

describe("wiki pages limited to some agents", () => {
  test("an agent off the list finds nothing, and every agent reads by default", async () => {
    const { deps, other, page } = await workspace();
    expect((await getWikiPage(f.db, agent(other.id), f.org.id, "margens")).id).toBe(page.id);
    const view = await setWikiPageAudience(deps, f.owner.id, f.org.id, "margens", null, [f.agent.id]);
    expect(view.audience).toBeNull();
    expect(view.agentIds).toEqual([f.agent.id]);
    expect((await getWikiPage(f.db, agent(f.agent.id), f.org.id, "margens")).id).toBe(page.id);
    const refused = await getWikiPage(f.db, agent(other.id), f.org.id, "margens").catch((e) => e);
    expect(refused).toBeInstanceOf(NotFoundError);
    expect(code(refused)).toBe("wiki.page_not_found");
    expect(await searchWiki(deps, agent(other.id), f.org.id, "margem contratos")).toEqual([]);
    expect((await searchWiki(deps, agent(f.agent.id), f.org.id, "margem contratos")).map((p) => p.id)).toEqual([
      page.id,
    ]);
  });

  test("an older app that sends no list keeps the page's list", async () => {
    const { deps, admin } = await workspace();
    await setWikiPageAudience(deps, f.owner.id, f.org.id, "margens", null, [f.agent.id]);
    const view = await setWikiPageAudience(deps, f.owner.id, f.org.id, "margens", { roleIds: [admin], userIds: [] });
    expect(view.agentIds).toEqual([f.agent.id]);
  });

  test("a run's context leaves it out, even when the message links it", async () => {
    const { deps, other } = await workspace();
    await setWikiPageAudience(deps, f.owner.id, f.org.id, "margens", null, [f.agent.id]);
    const off = await retrieveWikiForRun(deps, {
      orgId: f.org.id,
      text: "resuma [[Margens]]",
      reader: async () => agent(other.id),
    });
    expect(off).toEqual({ text: "", pageIds: [], held: false });
  });

  test("search over everything drops what the run may not read", async () => {
    const { deps, other, page, admin, bia } = await workspace();
    await setWikiPageAudience(deps, f.owner.id, f.org.id, "margens", { roleIds: [admin], userIds: [] }, [f.agent.id]);
    const hit = { kind: "wiki", sourceId: page.id };
    const message = { kind: "message", sourceId: "m" };
    const forPerson = (agentId: string, userId: string | null): WikiActor => ({
      type: "agent",
      agentId,
      requestedByUserId: userId,
    });
    expect(await wikiHitsForAgent(f.db, forPerson(f.agent.id, f.owner.id), [hit, message])).toEqual([hit, message]);
    expect(await wikiHitsForAgent(f.db, forPerson(other.id, f.owner.id), [hit, message])).toEqual([message]);
    expect(await wikiHitsForAgent(f.db, forPerson(f.agent.id, bia.id), [hit, message])).toEqual([message]);
    expect(await wikiHitsForAgent(f.db, forPerson(f.agent.id, null), [hit, message])).toEqual([message]);
  });

  test("an agent off the list in the conversation keeps the page from every agent there", async () => {
    const { deps, other, page } = await workspace();
    await setWikiPageAudience(deps, f.owner.id, f.org.id, "margens", null, [f.agent.id]);
    const ask = () =>
      retrieveWikiForRun(deps, {
        orgId: f.org.id,
        text: "resuma [[Margens]]",
        reader: async () => ({
          type: "agent",
          agentId: f.agent.id,
          requestedByUserId: f.owner.id,
          channelId: f.general.id,
        }),
      });
    expect((await ask()).pageIds).toContain(page.id);
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: other.id });
    expect((await ask()).pageIds).not.toContain(page.id);
  });
});

describe("wiki folders with an audience", () => {
  test("saving reaches its pages and subfolders; new, moved and imported pages take it", async () => {
    const { deps, admin, bia, ana } = await workspace();
    const sub = await createWikiPage(deps, person(f.owner.id), f.org.id, {
      title: "Acme",
      folder: "Financeiro/Contratos",
    });
    const outside = await createWikiPage(deps, person(f.owner.id), f.org.id, { title: "Geral", folder: "Pessoas" });
    const done = await setWikiFolderAudience(
      deps,
      f.owner.id,
      f.org.id,
      "Financeiro",
      { roleIds: [admin], userIds: [] },
      [f.agent.id],
    );
    expect(done.pages).toBe(2);
    const followed = await getWikiPage(f.db, person(ana.id), f.org.id, sub.id);
    expect(followed.audienceFolder).toBe("Financeiro");
    expect(followed.agentIds).toEqual([f.agent.id]);
    expect(code(await getWikiPage(f.db, person(bia.id), f.org.id, sub.id).catch((e) => e))).toBe("wiki.no_access");
    const made = await createWikiPage(deps, person(f.owner.id), f.org.id, { title: "Nova", folder: "Financeiro/Q4" });
    expect(made.audienceFolder).toBe("Financeiro");
    const moved = await moveWikiPage(deps, person(f.owner.id), f.org.id, outside.id, "Financeiro");
    expect(moved.audienceFolder).toBe("Financeiro");
    expect(moved.audience?.roleIds).toEqual([admin]);
    const imported = await importWikiPages(deps, f.owner.id, f.org.id, {
      source: { type: "obsidian", name: "Cofre" },
      notes: [{ title: "Nota", folder: "Financeiro", body: "x" }],
      onConflict: "keep_both",
    });
    expect(imported.created[0]?.audienceFolder).toBe("Financeiro");
  });

  test("a page that leaves keeps its limit; opening a folder opens only what followed it", async () => {
    const { deps, admin, page, ana } = await workspace();
    const own = await createWikiPage(deps, person(f.owner.id), f.org.id, { title: "Própria", folder: "Financeiro" });
    await setWikiFolderAudience(deps, f.owner.id, f.org.id, "Financeiro", { roleIds: [admin], userIds: [] }, null);
    await setWikiPageAudience(deps, f.owner.id, f.org.id, own.id, { roleIds: [], userIds: [ana.id] }, null);
    const out = await moveWikiPage(deps, person(f.owner.id), f.org.id, page.id, "Geral");
    expect(out.audienceFolder).toBeNull();
    expect(out.audience?.roleIds).toEqual([admin]);
    const stay = await createWikiPage(deps, person(f.owner.id), f.org.id, { title: "Fica", folder: "Financeiro" });
    await setWikiFolderAudience(deps, f.owner.id, f.org.id, "Financeiro", null, null);
    expect((await getWikiPage(f.db, person(f.owner.id), f.org.id, stay.id)).audience).toBeNull();
    expect((await getWikiPage(f.db, person(f.owner.id), f.org.id, own.id)).audience?.userIds).toEqual([ana.id]);
    expect((await getWikiFolderAudience(f.db, f.owner.id, f.org.id, "Financeiro")).own).toBeNull();
  });

  test("a page and a subfolder can only be narrower than the folder", async () => {
    const { deps, admin, ana, bia, other, page } = await workspace();
    await setWikiFolderAudience(deps, f.owner.id, f.org.id, "Financeiro", { roleIds: [admin], userIds: [] }, [
      f.agent.id,
    ]);
    const open = await setWikiPageAudience(deps, f.owner.id, f.org.id, page.id, null, null).catch((e) => e);
    expect(open).toBeInstanceOf(ValidationError);
    expect(code(open)).toBe("wiki.audience_wider_than_folder");
    const wider = await setWikiPageAudience(deps, f.owner.id, f.org.id, page.id, { roleIds: [], userIds: [bia.id] }, [
      f.agent.id,
    ]).catch((e) => e);
    expect(code(wider)).toBe("wiki.audience_wider_than_folder");
    const moreAgents = await setWikiPageAudience(
      deps,
      f.owner.id,
      f.org.id,
      page.id,
      { roleIds: [admin], userIds: [] },
      [f.agent.id, other.id],
    ).catch((e) => e);
    expect(code(moreAgents)).toBe("wiki.audience_wider_than_folder");
    // Ana holds the folder's role, so naming her alone is narrower.
    const narrow = await setWikiPageAudience(
      deps,
      f.owner.id,
      f.org.id,
      page.id,
      { roleIds: [], userIds: [ana.id] },
      [],
    );
    expect(narrow.audienceFolder).toBeNull();
    expect(narrow.folderAudience?.folder).toBe("Financeiro");
    // A subfolder with no audience of its own just follows the folder.
    expect((await setWikiFolderAudience(deps, f.owner.id, f.org.id, "Financeiro/Sub", null, null)).pages).toBe(0);
    const wideSub = await setWikiFolderAudience(
      deps,
      f.owner.id,
      f.org.id,
      "Financeiro/Sub",
      { roleIds: [], userIds: [bia.id] },
      [f.agent.id],
    ).catch((e) => e);
    expect(code(wideSub)).toBe("wiki.audience_wider_than_folder");
  });

  test("a move or a create that would lose the writer the page is refused", async () => {
    const { deps, admin, bia } = await workspace();
    const hers = await createWikiPage(deps, person(bia.id), f.org.id, { title: "Dela", folder: "Geral" });
    await setWikiFolderAudience(deps, f.owner.id, f.org.id, "Financeiro", { roleIds: [admin], userIds: [] }, null);
    const created = await createWikiPage(deps, person(bia.id), f.org.id, {
      title: "Outra",
      folder: "Financeiro",
    }).catch((e) => e);
    expect(code(created)).toBe("wiki.no_access");
    const moved = await moveWikiPage(deps, person(bia.id), f.org.id, hers.id, "Financeiro").catch((e) => e);
    expect(code(moved)).toBe("wiki.no_access");
    expect((await getWikiPage(f.db, person(bia.id), f.org.id, hers.id)).folder).toBe("Geral");
  });

  test("the setter stays in it, a limited folder is only for its audience, and leavers are removed", async () => {
    const { deps, admin, bia } = await workspace();
    const out = await setWikiFolderAudience(
      deps,
      (await rolesManager()).id,
      f.org.id,
      "Financeiro",
      {
        roleIds: [],
        userIds: [],
      },
      null,
    ).catch((e) => e);
    expect(code(out)).toBe("wiki.audience_excludes_you");
    const both = { roleIds: [admin], userIds: [bia.id] };
    await setWikiFolderAudience(deps, f.owner.id, f.org.id, "Financeiro", both, null);
    await removeMember(f.db, f.owner.id, f.org.id, bia.id);
    const info = await getWikiFolderAudience(f.db, f.owner.id, f.org.id, "Financeiro");
    expect(info.own?.audience?.userIds).toEqual([]);
  });
});

describe("who edits a wiki page", () => {
  const nobody = { roleIds: [], userIds: [] };
  const write = (actor: WikiActor, ref: string, baseVersion: number) =>
    updateWikiPage(wikiDeps(), actor, f.org.id, ref, { baseVersion, body: "mudou" });

  test("everyone sees it, only the editors change it, and owners always do", async () => {
    const { deps, admin, ana, bia, page } = await workspace();
    const view = await setWikiPageAudience(deps, f.owner.id, f.org.id, page.id, null, null, {
      editors: { roleIds: [admin], userIds: [] },
      agentEditorIds: null,
    });
    expect(view.audience).toBeNull();
    expect(view.editors?.roleIds).toEqual([admin]);
    const asBia = await getWikiPage(f.db, person(bia.id), f.org.id, page.id);
    expect(asBia.canEdit).toBe(false);
    expect((await getWikiPage(f.db, person(ana.id), f.org.id, page.id)).canEdit).toBe(true);
    expect(code(await write(person(bia.id), page.id, view.version).catch((e) => e))).toBe("wiki.edit_limited");
    expect(code(await deleteWikiPage(deps, person(bia.id), f.org.id, page.id).catch((e) => e))).toBe(
      "wiki.edit_limited",
    );
    const saved = await write(person(ana.id), page.id, view.version);
    expect((await write(person(f.owner.id), page.id, saved.version)).body).toBe("mudou");
  });

  test("an agent edits only on its list and for a person on theirs", async () => {
    const { deps, other, ana, bia, page } = await workspace();
    const view = await setWikiPageAudience(deps, f.owner.id, f.org.id, page.id, null, null, {
      editors: { roleIds: [], userIds: [ana.id] },
      agentEditorIds: [f.agent.id],
    });
    const forAna = (agentId: string): WikiActor => ({ type: "agent", agentId, requestedByUserId: ana.id });
    const forBia: WikiActor = { type: "agent", agentId: f.agent.id, requestedByUserId: bia.id };
    expect(code(await write(forAna(other.id), page.id, view.version).catch((e) => e))).toBe("wiki.edit_limited");
    expect(code(await write(forBia, page.id, view.version).catch((e) => e))).toBe("wiki.edit_limited");
    expect((await write(forAna(f.agent.id), page.id, view.version)).version).toBe(view.version + 1);
    expect((await getWikiPage(f.db, agent(other.id), f.org.id, page.id)).canEdit).toBe(false);
    expect((await getWikiPage(f.db, agent(f.agent.id), f.org.id, page.id)).canEdit).toBe(true);
  });

  test("seeing still comes first: an editor outside the audience gets no access", async () => {
    const { deps, admin, bia, page } = await workspace();
    const view = await setWikiPageAudience(
      deps,
      f.owner.id,
      f.org.id,
      page.id,
      { roleIds: [admin], userIds: [] },
      null,
      {
        editors: { roleIds: [], userIds: [bia.id] },
        agentEditorIds: null,
      },
    );
    expect(code(await write(person(bia.id), page.id, view.version).catch((e) => e))).toBe("wiki.no_access");
  });

  test("whoever sets the editors stays among them", async () => {
    const { deps, page } = await workspace();
    const out = await setWikiPageAudience(deps, (await rolesManager()).id, f.org.id, page.id, null, null, {
      editors: nobody,
      agentEditorIds: null,
    }).catch((e) => e);
    expect(code(out)).toBe("wiki.editors_exclude_you");
  });

  test("an older app that sends no editors keeps the page's", async () => {
    const { deps, ana, page } = await workspace();
    await setWikiPageAudience(deps, f.owner.id, f.org.id, page.id, null, null, {
      editors: { roleIds: [], userIds: [ana.id] },
      agentEditorIds: [f.agent.id],
    });
    const view = await setWikiPageAudience(deps, f.owner.id, f.org.id, page.id, null);
    expect(view.editors?.userIds).toEqual([ana.id]);
    expect(view.agentEditorIds).toEqual([f.agent.id]);
  });

  test("a folder's editors reach its pages; a page can only narrow them, and new pages follow", async () => {
    const { deps, admin, ana, bia, other, page } = await workspace();
    const edit = { editors: { roleIds: [admin], userIds: [] }, agentEditorIds: [f.agent.id] };
    await setWikiFolderAudience(deps, f.owner.id, f.org.id, "Financeiro", null, null, edit);
    const followed = await getWikiPage(f.db, person(f.owner.id), f.org.id, page.id);
    expect(followed.audienceFolder).toBe("Financeiro");
    expect(followed.editors?.roleIds).toEqual([admin]);
    expect(followed.agentEditorIds).toEqual([f.agent.id]);
    expect(followed.folderAudience?.editors?.roleIds).toEqual([admin]);
    const wider = await setWikiPageAudience(deps, f.owner.id, f.org.id, page.id, null, null, {
      editors: { roleIds: [admin], userIds: [] },
      agentEditorIds: [f.agent.id, other.id],
    }).catch((e) => e);
    expect(code(wider)).toBe("wiki.audience_wider_than_folder");
    const narrow = await setWikiPageAudience(deps, f.owner.id, f.org.id, page.id, null, null, {
      editors: { roleIds: [], userIds: [ana.id] },
      agentEditorIds: [],
    });
    expect(narrow.audienceFolder).toBeNull();
    const created = await createWikiPage(deps, person(ana.id), f.org.id, { title: "Nova", folder: "Financeiro" });
    expect(created.editors?.roleIds).toEqual([admin]);
    const refused = await createWikiPage(deps, person(bia.id), f.org.id, {
      title: "Dela",
      folder: "Financeiro",
    }).catch((e) => e);
    expect(code(refused)).toBe("wiki.edit_limited");
  });

  test("someone leaving is taken off the editors too", async () => {
    const { deps, bia, page } = await workspace();
    await setWikiPageAudience(deps, f.owner.id, f.org.id, page.id, null, null, {
      editors: { roleIds: [], userIds: [bia.id] },
      agentEditorIds: null,
    });
    await removeMember(f.db, f.owner.id, f.org.id, bia.id);
    expect((await getWikiPage(f.db, person(f.owner.id), f.org.id, page.id)).editors?.userIds).toEqual([]);
  });
});
