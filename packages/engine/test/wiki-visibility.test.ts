import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  createWikiPage,
  createWikiToolSource,
  deleteWikiPage,
  drainOutbox,
  ForbiddenError,
  getWikiPage,
  insertMessage,
  listWikiPages,
  NotFoundError,
  openPersonAgentDm,
  parseWikiLinks,
  RESTRICTED_HERE,
  recordWikiReads,
  removeMember,
  renameWikiPage,
  resolveWikiTargets,
  restoreWikiPage,
  retrieveWikiForRun,
  searchForUser,
  searchWiki,
  setWikiPageAudience,
  suggestWikiPages,
  type ToolContext,
  topWikiReads,
  updateWikiPage,
  ValidationError,
  type WikiActor,
  wikiGraph,
  withWikiLinks,
} from "../src";
import { personBehindCall, wikiPersonOf } from "../src/requester";
import type { RoutineBrief } from "../src/routine-brief";
import { addMember, adminRoleId, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string): WikiActor => ({ type: "person", userId });
const wikiDeps = () => ({ db: f.db, pubsub: f.pubsub, search: f.context, artifacts: f.artifactDeps });

/** A workspace with an admin, a member, an open page linking to a page limited to agents and admins. */
async function restricted() {
  f = await setup();
  const deps = wikiDeps();
  const ana = await addMember(f.db, f.org.id, "admin", "ana");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const secret = await createWikiPage(deps, person(f.owner.id), f.org.id, {
    title: "Margens",
    body: "Margem mínima de 40% nos contratos. Veja [[Processos]].",
  });
  const open = await createWikiPage(deps, person(f.owner.id), f.org.id, {
    title: "Processos",
    body: "Como vendemos. As margens estão em [[Margens]].",
  });
  const view = await setWikiPageAudience(deps, ana.id, f.org.id, "margens", {
    roleIds: [await adminRoleId(f.db, f.org.id)],
    userIds: [],
  });
  await drainOutbox(f.db, f.handlers);
  return { deps, ana, bia, secret, open, view };
}

const code = (e: unknown) => (e as { code?: string }).code;

describe("restricted wiki pages", () => {
  test("the audience reads it, an agent only for them; anyone else gets a plain no access", async () => {
    const { ana, bia, view } = await restricted();
    expect(view.audience?.userIds).toEqual([]);
    expect(view.audience?.roleIds).toHaveLength(1);
    expect((await getWikiPage(f.db, person(ana.id), f.org.id, "margens")).title).toBe("Margens");
    expect((await getWikiPage(f.db, person(f.owner.id), f.org.id, "margens")).title).toBe("Margens");
    const agentFor = (userId: string | null): WikiActor => ({
      type: "agent",
      agentId: f.agent.id,
      requestedByUserId: userId,
    });
    expect((await getWikiPage(f.db, agentFor(ana.id), f.org.id, "margens")).body).toContain("40%");
    for (const nobody of [bia.id, null]) {
      const hidden = await getWikiPage(f.db, agentFor(nobody), f.org.id, "margens").catch((e) => e);
      expect(hidden).toBeInstanceOf(NotFoundError);
    }
    const refused = await getWikiPage(f.db, person(bia.id), f.org.id, "margens").catch((e) => e);
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect(code(refused)).toBe("wiki.no_access");
  });

  test("lists, suggestions, the graph, search, backlinks and links leave it out for others", async () => {
    const { deps, ana, bia } = await restricted();
    const titles = async (userId: string) =>
      (await listWikiPages(f.db, person(userId), f.org.id)).map((p) => p.title).sort();
    expect(await titles(ana.id)).toEqual(["Margens", "Processos"]);
    expect(await titles(bia.id)).toEqual(["Processos"]);
    expect((await suggestWikiPages(f.db, person(bia.id), f.org.id, "Marg")).length).toBe(0);
    // `[[` before any letter: the latest pages, not an error.
    expect((await suggestWikiPages(f.db, person(f.owner.id), f.org.id, "")).length).toBeGreaterThan(0);
    const graph = await wikiGraph(f.db, person(bia.id), f.org.id);
    expect(graph.nodes.map((n) => n.title)).toEqual(["Processos"]);
    expect(graph.unresolved).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect((await searchWiki(deps, person(bia.id), f.org.id, "margem contratos")).length).toBe(0);
    expect((await searchWiki(deps, person(ana.id), f.org.id, "margem contratos")).length).toBe(1);
    const hits = await searchForUser(f.context, bia.id, f.org.id, { text: "margem contratos" });
    expect(hits.some((h) => h.kind === "wiki")).toBe(false);
    expect(
      (await searchForUser(f.context, ana.id, f.org.id, { text: "margem contratos" })).some((h) => h.kind === "wiki"),
    ).toBe(true);
    const page = await getWikiPage(f.db, person(bia.id), f.org.id, "processos");
    expect(page.backlinks).toEqual([]);
    expect(page.links).toEqual([{ target: "Margens", slug: "margens", title: null, exists: false }]);
    const asAdmin = await getWikiPage(f.db, person(ana.id), f.org.id, "processos");
    expect(asAdmin.backlinks.map((b) => b.kind === "page" && b.title)).toEqual(["Margens"]);
  });

  test("agents' reads, context and message links don't show its title", async () => {
    const { bia, secret, ana } = await restricted();
    await recordWikiReads(f.db, { orgId: f.org.id, agentId: f.agent.id, pageIds: [secret.id] });
    expect(await topWikiReads(f.db, person(bia.id), f.org.id)).toEqual([]);
    expect((await topWikiReads(f.db, person(ana.id), f.org.id)).map((r) => r.title)).toEqual(["Margens"]);
    const run = await retrieveWikiForRun(wikiDeps(), {
      orgId: f.org.id,
      text: "qual a margem mínima dos contratos?",
      reader: async () => ({ type: "agent", agentId: f.agent.id, requestedByUserId: ana.id }),
    });
    expect(run.pageIds).toContain(secret.id);
    const [linked] = await withWikiLinks(f.db, f.org.id, [
      { body: "veja [[Margens]]", meta: {} as Record<string, unknown> },
    ]);
    expect(linked?.meta.wikiLinks).toEqual([
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
    expect(await resolveWikiTargets(f.db, f.org.id, parseWikiLinks("[[Processos]]"))).toEqual([
      { target: "Processos", label: "Processos", section: null, slug: "processos", title: "Processos", exists: true },
    ]);
  });

  test("nobody outside writes it, not even an agent on their behalf", async () => {
    const { deps, bia, secret } = await restricted();
    const edit = (actor: WikiActor) =>
      updateWikiPage(deps, actor, f.org.id, "margens", { baseVersion: secret.version, body: "nada" }).catch((e) => e);
    expect(code(await edit(person(bia.id)))).toBe("wiki.no_access");
    expect(code(await edit({ type: "agent", agentId: f.agent.id, requestedByUserId: bia.id }))).toBe(
      "wiki.page_not_found",
    );
    const ok = await edit({ type: "agent", agentId: f.agent.id, requestedByUserId: f.owner.id });
    expect(ok.body).toBe("nada");
  });

  test("a new page named like one the writer can't see takes the next address instead of naming it", async () => {
    const { deps, bia } = await restricted();
    const mine = await createWikiPage(deps, person(bia.id), f.org.id, { title: "Margens", body: "outra" });
    expect(mine.slug).toBe("margens-2");
  });

  test("who may choose the audience, and only one they stay in", async () => {
    const { deps, ana, bia } = await restricted();
    // Agents and who edits take managing roles; who sees it, anyone who edits the page.
    const forbidden = await setWikiPageAudience(
      deps,
      bia.id,
      f.org.id,
      "processos",
      { roleIds: [], userIds: [] },
      [],
    ).catch((e) => e);
    expect(code(forbidden)).toBe("wiki.audience_forbidden");
    const outside = await setWikiPageAudience(deps, bia.id, f.org.id, "processos", {
      roleIds: [],
      userIds: [ana.id],
    }).catch((e) => e);
    expect(outside).toBeInstanceOf(ValidationError);
    expect(code(outside)).toBe("wiki.audience_excludes_you");
    // Administrators only: an administrator may leave both lists empty.
    const ownersOnly = await setWikiPageAudience(deps, f.owner.id, f.org.id, "processos", { roleIds: [], userIds: [] });
    expect(ownersOnly.audience).toEqual({ roleIds: [], userIds: [] });
    expect(code(await getWikiPage(f.db, person(bia.id), f.org.id, "processos").catch((e) => e))).toBe("wiki.no_access");
    expect((await getWikiPage(f.db, person(ana.id), f.org.id, "processos")).title).toBe("Processos");
    // A person named on the page sees it; opening it again shows it to everyone.
    await setWikiPageAudience(deps, f.owner.id, f.org.id, "processos", { roleIds: [], userIds: [bia.id, "nobody"] });
    expect((await getWikiPage(f.db, person(bia.id), f.org.id, "processos")).audience).toEqual({
      roleIds: [],
      userIds: [bia.id],
    });
    expect((await setWikiPageAudience(deps, f.owner.id, f.org.id, "margens", null)).audience).toBeNull();
    expect((await getWikiPage(f.db, person(bia.id), f.org.id, "margens")).title).toBe("Margens");
  });
});

describe("agents with a restricted page", () => {
  const ask = (text: string, run: { channelId: string | null; person: string | null }) =>
    retrieveWikiForRun(wikiDeps(), {
      orgId: f.org.id,
      text,
      reader: async () => ({
        type: "agent",
        agentId: f.agent.id,
        requestedByUserId: run.person,
        channelId: run.channelId,
      }),
    });

  test("a run for someone outside gets nothing at all, naming it or searching for it", async () => {
    const { ana, bia, secret } = await restricted();
    for (const text of ["resuma [[Margens]]", "qual a margem mínima dos contratos?"]) {
      const outsider = await ask(text, { channelId: null, person: bia.id });
      expect(outsider.pageIds).not.toContain(secret.id);
      expect(outsider.text).not.toContain("40%");
      expect(outsider.text).not.toContain("[[Margens]] (");
    }
    expect((await ask("resuma [[Margens]]", { channelId: null, person: ana.id })).text).toContain("40%");
    // Nobody behind the run: nothing limited to people.
    expect((await ask("resuma [[Margens]]", { channelId: null, person: null })).pageIds).not.toContain(secret.id);
  });

  test("a run stops reading it as soon as someone reading the conversation can't", async () => {
    const { ana, bia, secret } = await restricted();
    const private_ = () =>
      f.db.update(schema.channels).set({ visibility: "private" }).where(eq(schema.channels.id, f.general.id));
    const inChannel = () => ask("resuma [[Margens]]", { channelId: f.general.id, person: ana.id });
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: ana.id });
    // A public channel is the whole workspace's, Bia's too, member or not.
    expect((await inChannel()).pageIds).not.toContain(secret.id);
    await private_();
    expect((await inChannel()).pageIds).toContain(secret.id);
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bia.id });
    expect((await inChannel()).pageIds).not.toContain(secret.id);
  });

  test("someone with access asking in an open channel gets it by DM; someone without gets nothing", async () => {
    f = await setup({ wikiTools: true });
    const deps = wikiDeps();
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await createWikiPage(deps, person(f.owner.id), f.org.id, { title: "Margens", body: "Margem mínima de 40%." });
    await setWikiPageAudience(deps, f.owner.id, f.org.id, "margens", { roleIds: [], userIds: [ana.id] });
    const askIn = async (userId: string): Promise<ToolContext> => {
      const trigger = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId },
        body: "@dev qual é a margem mínima?",
      });
      const [run] = await f.db
        .insert(schema.agentRuns)
        .values({
          orgId: f.org.id,
          agentId: f.agent.id,
          channelId: f.general.id,
          threadRootId: trigger.id,
          triggerMessageId: trigger.id,
          trigger: "mention",
          hop: 0,
        })
        .returning();
      return {
        db: f.db,
        orgId: f.org.id,
        agentId: f.agent.id,
        runId: (run as { id: string }).id,
        channelId: f.general.id,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
      };
    };
    const ctx = await askIn(ana.id);
    const tools = await createWikiToolSource({ pubsub: f.pubsub, search: f.context }).tools(ctx);
    const read = tools.find((t) => t.name === "read_wiki_page");
    if (!read) throw new Error("read_wiki_page missing");
    // In the open channel the run gets a line, no title and no text; the question goes to Ana's DM.
    const here = await read.execute({ page: "margens" }, ctx);
    expect(here.content).toBe(RESTRICTED_HERE);
    expect(here.content).not.toContain("40%");
    await read.execute({ page: "margens" }, ctx);
    const dm = await openPersonAgentDm(f.db, f.org.id, ana.id, f.agent.id);
    const notes = await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, dm.id));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toContain("qual é a margem mínima?");
    expect(notes[0]?.body).not.toContain("40%");
    const [woken] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.channelId, dm.id));
    expect(woken).toBeTruthy();
    // That run acts for Ana, and there the page is there.
    const inDm = { ...ctx, channelId: dm.id, runId: (woken as { id: string }).id };
    expect(await personBehindCall(inDm)).toBe(ana.id);
    expect((await read.execute({ page: "margens" }, inDm)).content).toContain("40%");
    // Bia: no line, no DM, the page isn't there.
    const hers = await askIn(bia.id);
    const refused = await read.execute({ page: "margens" }, hers);
    expect(refused.isError).toBe(true);
    expect(refused.content).not.toBe(RESTRICTED_HERE);
    const biaDm = await openPersonAgentDm(f.db, f.org.id, bia.id, f.agent.id);
    expect(await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, biaDm.id))).toEqual([]);
  });

  test("the wiki tools act for the person behind the call, and the receipt leaves out the title", async () => {
    f = await setup({ wikiTools: true });
    const deps = wikiDeps();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await createWikiPage(deps, person(f.owner.id), f.org.id, { title: "Margens", body: "Margem mínima de 40%." });
    await setWikiPageAudience(deps, f.owner.id, f.org.id, "margens", { roleIds: [], userIds: [] });
    await f.db.update(schema.channels).set({ visibility: "private" }).where(eq(schema.channels.id, f.general.id));
    const context = async (userId: string): Promise<ToolContext> => {
      const trigger = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId },
        body: "@dev documenta na wiki Margens que vale para 2027",
      });
      return {
        db: f.db,
        orgId: f.org.id,
        agentId: f.agent.id,
        runId: crypto.randomUUID(),
        channelId: f.general.id,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
      };
    };
    const ctx = await context(f.owner.id);
    const tools = await createWikiToolSource({ pubsub: f.pubsub, search: f.context }).tools(ctx);
    const tool = (name: string) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`${name} missing`);
      return t;
    };
    expect((await tool("read_wiki_page").execute({ page: "margens" }, ctx)).content).toContain("40%");
    expect((await tool("search_wiki").execute({ query: "margem" }, ctx)).content).toContain("40%");
    const saved = await tool("update_wiki_page").execute(
      { page: "margens", mode: "append", content: "Vale para 2027." },
      ctx,
    );
    expect(saved.isError).toBeFalsy();
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.orgId, f.org.id));
    expect(JSON.stringify([receipt?.target, receipt?.params])).not.toContain("argens");
    expect(receipt?.params).toEqual({ restricted: true });
    // The same agent, asked by someone outside: the text never reaches it. Bia isn't in the channel here, so only
    // who asked keeps it from the page.
    const theirs = await context(bia.id);
    const read = await tool("read_wiki_page").execute({ page: "margens" }, theirs);
    expect(read.isError).toBe(true);
    expect(read.content).not.toContain("40%");
    const found = await tool("search_wiki").execute({ query: "margem" }, theirs);
    expect(found.content).toBe("No wiki pages match.");
    const edit = await tool("update_wiki_page").execute({ page: "margens", mode: "append", content: "Mudei." }, theirs);
    expect(edit.isError).toBe(true);
    expect((await getWikiPage(f.db, person(f.owner.id), f.org.id, "margens")).body).not.toContain("Mudei");
  });

  test("a routine reads with its creator's access, and a run with nobody behind it with none", () => {
    const brief = { creatorUserId: "creator" } as RoutineBrief;
    expect(wikiPersonOf({ kind: "person", personId: "ana" })).toBe("ana");
    expect(wikiPersonOf({ kind: "routine", personId: null, brief })).toBe("creator");
    expect(wikiPersonOf({ kind: "unattended", personId: null, reason: "routine_report", brief })).toBe("creator");
    expect(wikiPersonOf({ kind: "unattended", personId: null, reason: "agent" })).toBeNull();
  });

  test("an agent creating a page for an outsider takes the next address instead of naming the hidden page", async () => {
    const { deps, bia } = await restricted();
    const mine = await createWikiPage(
      deps,
      { type: "agent", agentId: f.agent.id, requestedByUserId: bia.id },
      f.org.id,
      { title: "Margens", body: "outra" },
    );
    expect(mine.slug).toBe("margens-2");
  });
});

describe("renames, restores and people leaving", () => {
  test("renaming a restricted page leaves the open pages that link to it alone", async () => {
    const { deps, ana, open } = await restricted();
    await renameWikiPage(deps, person(ana.id), f.org.id, "margens", { title: "Margens e salários da diretoria" });
    const after = await getWikiPage(f.db, person(f.owner.id), f.org.id, "processos");
    expect(after.body).toBe(open.body);
    expect(after.version).toBe(open.version);
  });

  test("renaming onto, or restoring under, a hidden page's address never names it", async () => {
    const { deps, bia } = await restricted();
    const mine = await createWikiPage(deps, person(bia.id), f.org.id, { title: "Rascunho", body: "x" });
    const renamed = await renameWikiPage(deps, person(bia.id), f.org.id, mine.slug, { title: "margens" });
    expect(renamed.slug).toBe("margens-2");
    // A deleted page whose address a restricted page holds now.
    const old = await createWikiPage(deps, person(f.owner.id), f.org.id, { title: "Comissões", body: "y" });
    await deleteWikiPage(deps, person(f.owner.id), f.org.id, old.slug);
    await f.db.update(schema.wikiPages).set({ slug: "comissoes-old" }).where(eq(schema.wikiPages.id, old.id));
    const secret = await createWikiPage(deps, person(f.owner.id), f.org.id, {
      title: "Comissões da diretoria",
      body: "z",
    });
    await f.db
      .update(schema.wikiPages)
      .set({ slug: "comissoes-old", restricted: true })
      .where(eq(schema.wikiPages.id, secret.id));
    const refused = await restoreWikiPage(deps, person(f.owner.id), f.org.id, old.id).catch((e) => e);
    expect(code(refused)).toBe("wiki.restore_slug_taken");
    expect(JSON.stringify(refused.params ?? {})).not.toContain("diretoria");
    expect(String(refused.message)).not.toContain("diretoria");
  });

  test("a person who leaves drops off the pages they were named on", async () => {
    const { deps, bia } = await restricted();
    await setWikiPageAudience(deps, f.owner.id, f.org.id, "margens", { roleIds: [], userIds: [bia.id] });
    await removeMember(f.db, f.owner.id, f.org.id, bia.id);
    await f.db.insert(schema.organizationMembers).values({ orgId: f.org.id, userId: bia.id, role: "member" });
    expect(code(await getWikiPage(f.db, person(bia.id), f.org.id, "margens").catch((e) => e))).toBe("wiki.no_access");
  });
});
