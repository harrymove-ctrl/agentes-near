import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  consolidateOrg,
  indexSource,
  insertContextItem,
  itemLabel,
  type NewContextItem,
  recordContextUse,
  retrieveForRun,
  searchVisible,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** An item of @dev's (unless `agentId` says otherwise), indexed for search like a saved one. */
async function add(values: Partial<NewContextItem> & Pick<NewContextItem, "content">) {
  const item = await insertContextItem(f.db, {
    orgId: f.org.id,
    kind: "fact",
    scopeType: "agent",
    scopeId: f.agent.id,
    agentId: f.agent.id,
    channelIds: [f.general.id],
    evidence: [{ type: "self", ref: f.agent.id, agentId: f.agent.id, at: new Date().toISOString() }],
    createdByKind: "agent",
    createdById: f.agent.id,
    ...values,
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
  return item;
}

const said = (by: string) => ({
  createdByKind: "person" as const,
  createdById: by,
  evidence: [{ type: "human" as const, ref: crypto.randomUUID(), at: new Date().toISOString() }],
});

const memoryFor = (text: string, budgetChars?: number) =>
  retrieveForRun(f.context, {
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    text,
    personIds: [f.owner.id],
    ...(budgetChars ? { budgetChars } : {}),
  });

describe("the memory budget goes to what matches (ADR 0167)", () => {
  test("its own items come in when they match; the most used others are named in one line", async () => {
    f = await setup();
    const deploy = await add({ title: "Deploy da Northwind", content: "Deploy Northwind with scripts/blue.sh." });
    const offTopic = await add({ title: "Café da equipe", content: "The team orders coffee on Mondays." });
    await f.db.update(schema.contextItems).set({ useCount: 7 }).where(eq(schema.contextItems.id, offTopic.id));
    await add({ agentId: null, scopeType: "org", kind: "lesson", content: "Lessons about invoices go to finance." });

    const memory = await memoryFor("como fazer o deploy da northwind?");
    expect(memory.text).toContain("Deploy Northwind with scripts/blue.sh.");
    expect(memory.matchedIds).toEqual([deploy.id]);
    expect(memory.text).not.toContain("orders coffee");
    expect(memory.text).toContain(`Also in your memory, open with expand: Café da equipe (id ${offTopic.id})`);
    // The team's lessons come in only when the request is about them.
    expect(memory.text).not.toContain("invoices");
  });

  test("what people said and pinned items are never cut; what matched goes before who holds access", async () => {
    f = await setup();
    await add({
      kind: "preference",
      scopeType: "person",
      scopeId: f.owner.id,
      content: "Ana wants short answers.",
      ...said(f.owner.id),
    });
    await add({ kind: "preference", content: "Reports go out in Portuguese.", trust: "high", ...said(f.owner.id) });
    await add({ pinned: true, content: "The product is called Foguete." });
    await add({
      agentId: null,
      scopeType: "org",
      subject: "whoholds @dev stripe dashboard",
      content: "@dev is signed in to the Stripe dashboard.",
      channelIds: [],
    });
    const invoice = await add({ content: "Northwind invoices close on the 5th." });

    const roomy = await memoryFor("quando fecham as faturas da northwind invoices?");
    expect(roomy.text).toContain("Northwind invoices close on the 5th.");
    expect(roomy.text).toContain("Stripe dashboard");
    expect(roomy.text.indexOf("invoices close")).toBeLessThan(roomy.text.indexOf("Stripe dashboard"));

    // A tight budget drops who holds access and what matched, never what people said or pinned.
    const tight = await memoryFor("quando fecham as faturas da northwind invoices?", 200);
    for (const kept of ["Ana wants short answers.", "Reports go out in Portuguese.", "The product is called Foguete."])
      expect(tight.text).toContain(kept);
    expect(tight.text).not.toContain("Stripe dashboard");
    expect(tight.itemIds).not.toContain(invoice.id);
    // Each line names its source and day: a person by name, an agent's note as a hint.
    expect(tight.text).toContain(`[preference · ana, ${new Date().toISOString().slice(0, 10)}]`);
  });

  test("a use counts only when the item matched or was opened; what is sent anyway only stays fresh", async () => {
    f = await setup();
    const pref = await add({
      kind: "preference",
      content: "Reports go out in Portuguese.",
      trust: "high",
      ...said(f.owner.id),
    });
    const deploy = await add({ content: "Deploy Northwind with scripts/blue.sh." });
    const memory = await memoryFor("deploy northwind");
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
        trigger: "mention",
        hop: 1,
      })
      .returning();
    if (!run) throw new Error("no run");
    await recordContextUse(f.db, f.org.id, run.id, memory.itemIds, memory.matchedIds);
    const rows = new Map((await f.db.select().from(schema.contextItems)).map((i) => [i.id, i]));
    expect([rows.get(pref.id)?.useCount, rows.get(pref.id)?.lastUsedAt !== null]).toEqual([0, true]);
    expect(rows.get(deploy.id)?.useCount).toBe(1);
  });
});

describe("matching across languages (ADR 0167)", () => {
  test("an item is found by its English key, which no hit shows", async () => {
    f = await setup();
    const item = await add({
      title: "Como publicar no TestFlight",
      subject: "ios release testflight",
      content: "Rodar fastlane beta em apps/mobile.",
    });
    const hits = await searchVisible(f.context, {
      orgId: f.org.id,
      text: "ios release",
      visibleChannelIds: [f.general.id],
      kinds: ["context_item"],
    });
    expect(hits.map((h) => [h.sourceId, h.title])).toEqual([[item.id, "fact: Como publicar no TestFlight"]]);
  });
});

/**
 * An offline retrieval check in LongMemEval's categories (ADR 0167): for each request, is the item it needs among the
 * first five that matched? Words only (self-host's default) and hybrid with vectors (Cloud's).
 */
describe("offline retrieval: the item a request needs is in the top 5", () => {
  for (const vectors of [false, true]) {
    test(vectors ? "hybrid, with vectors" : "words only", async () => {
      f = await setup({ embeddings: vectors });
      // Filler the requests must not drown in.
      for (const n of [1, 2, 3, 4, 5, 6])
        await add({ title: `Rotina ${n}`, content: `Routine ${n} posts the weekly numbers in #general.` });
      // Across languages: an English request finds a Portuguese item by its English key alone.
      const release = await add({
        title: "Como publicar no TestFlight",
        subject: "ios release testflight fastlane",
        content: "Rodar fastlane beta em apps/mobile.",
      });
      // Knowledge updates: the newer version answers, the one it replaced never does.
      const before = await add({ title: "Servidor de staging", content: "The staging server is in Frankfurt." });
      const after = await add({ title: "Servidor de staging", content: "The staging server moved to Lisbon." });
      await f.db
        .update(schema.contextItems)
        .set({ status: "archived", supersededBy: after.id })
        .where(eq(schema.contextItems.id, before.id));
      await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: before.id });
      // Time: the line says when it was saved, so "when" can be answered.
      const launch = await add({ title: "Lançamento", content: "The beta launch happened for the Lisbon office." });

      const top = async (text: string) => (await memoryFor(text)).matchedIds.slice(0, 5);
      expect(await top("how do I make an ios release?")).toContain(release.id);
      const staging = await top("onde fica o servidor de staging?");
      expect(staging).toContain(after.id);
      expect(staging).not.toContain(before.id);
      const when = await memoryFor("quando foi o lançamento?");
      expect(when.matchedIds.slice(0, 5)).toContain(launch.id);
      expect(when.text).toContain(`${new Date().toISOString().slice(0, 10)}] Lançamento:`);
      // Knowing when not to answer: nothing matches what memory doesn't hold.
      expect(await top("qual é a senha do wifi do escritório?")).toEqual([]);
    });
  }
});

describe("dates on facts, and re-checks (ADR 0167)", () => {
  test("a fact about where things run reads 'check before relying' once it is a month old", async () => {
    f = await setup();
    const host = await add({ content: "The staging server runs in Frankfurt." });
    const day = 86_400_000;
    const at = host.createdAt.getTime();
    expect(itemLabel(host, undefined, at + 10 * day)).not.toContain("check before relying");
    expect(itemLabel(host, undefined, at + 31 * day)).toContain("check before relying");
    // Other facts don't go stale that way.
    const fiscal = await add({ content: "The fiscal year starts in April." });
    expect(itemLabel(fiscal, undefined, at + 31 * day)).not.toContain("check before relying");
  });

  test("an unconfirmed fact no request used in a month is archived; confirmed ones and who holds access stay", async () => {
    f = await setup();
    const hint = await add({ content: "The vendor ships on Fridays." });
    const confirmed = await add({ content: "The fiscal year starts in April.", ...said(f.owner.id) });
    const access = await add({
      agentId: null,
      scopeType: "org",
      subject: "whoholds @dev stripe dashboard",
      content: "@dev is signed in to the Stripe dashboard.",
      channelIds: [],
    });
    const used = await add({ content: "The vendor answers within a day." });
    const later = new Date(Date.now() + 31 * 86_400_000);
    await f.db
      .update(schema.contextItems)
      .set({ lastUsedAt: new Date(later.getTime() - 86_400_000) })
      .where(eq(schema.contextItems.id, used.id));
    const res = await consolidateOrg(f.context, f.org.id, later);
    expect(res.unconfirmed).toBe(1);
    const status = new Map((await f.db.select().from(schema.contextItems)).map((i) => [i.id, i.status]));
    expect([hint, confirmed, access, used].map((i) => status.get(i.id))).toEqual([
      "archived",
      "active",
      "active",
      "active",
    ]);
  });
});
