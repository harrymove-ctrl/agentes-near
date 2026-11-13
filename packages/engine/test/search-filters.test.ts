import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { createChannel, describeHits, indexSource, searchForUser } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const day = (d: string) => new Date(`${d}T12:00:00Z`);

/** A message written straight to the table (any author, mentions, meta, date) and indexed. */
async function message(
  fx: Fixture,
  input: {
    channelId?: string;
    body: string;
    agent?: boolean;
    userId?: string;
    mentionedUserIds?: string[];
    mentionedAgentIds?: string[];
    meta?: Record<string, unknown>;
    at?: Date;
    threadId?: string;
  },
) {
  const [m] = await fx.db
    .insert(schema.messages)
    .values({
      orgId: fx.org.id,
      channelId: input.channelId ?? fx.general.id,
      threadId: input.threadId ?? null,
      authorType: input.agent ? "agent" : "person",
      authorUserId: input.agent ? null : (input.userId ?? fx.owner.id),
      authorAgentId: input.agent ? fx.agent.id : null,
      body: input.body,
      mentionedUserIds: input.mentionedUserIds ?? [],
      mentionedAgentIds: input.mentionedAgentIds ?? [],
      meta: input.meta ?? {},
      createdAt: input.at ?? day("2026-10-15"),
    })
    .returning();
  if (!m) throw new Error("no message");
  await indexSource(deps(fx), { orgId: fx.org.id, kind: "message", sourceId: m.id });
  return m;
}

const deps = (fx: Fixture) => ({ db: fx.db, search: fx.search, gateway: fx.gateway });
const bodies = (hits: { snippet: string }[]) => hits.map((h) => h.snippet).sort();

describe("search filters (ADR 0123)", () => {
  test("from, author type, mentions, has, pinned, dates and sort, with and without words", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    const image = await f.db
      .insert(schema.artifacts)
      .values({
        orgId: f.org.id,
        kind: "file",
        title: "photo.png",
        channelId: f.general.id,
        createdByType: "person",
        createdById: f.owner.id,
        updatedByType: "person",
        updatedById: f.owner.id,
      })
      .returning();
    const imageId = image[0]?.id as string;
    await f.db.insert(schema.artifactVersions).values({
      orgId: f.org.id,
      artifactId: imageId,
      version: 1,
      blobKey: "k",
      contentType: "image/png",
      size: 1,
      sha256: "x",
      authorType: "person",
      authorId: f.owner.id,
    });
    const plain = await message(f, { body: "deploy notes", at: day("2026-09-10") });
    await message(f, { body: "deploy done see https://example.test/run", agent: true, at: day("2026-10-02") });
    await message(f, {
      body: "deploy report attached",
      agent: true,
      mentionedUserIds: [member.id],
      meta: { artifacts: [{ id: crypto.randomUUID(), version: 1, title: "report.pdf" }] },
      at: day("2026-10-20"),
    });
    await message(f, {
      body: "deploy screenshot",
      meta: { artifacts: [{ id: imageId, version: 1, title: "photo.png" }] },
      mentionedAgentIds: [f.agent.id],
      at: day("2026-10-25"),
    });
    await message(f, { body: "approve the deploy?", agent: true, meta: { approvalId: crypto.randomUUID() } });
    await message(f, { body: "party gif", meta: { media: { kind: "gif", id: "g1" } }, at: day("2026-10-26") });
    await f.db.insert(schema.messagePins).values({
      orgId: f.org.id,
      channelId: f.general.id,
      messageId: plain.id,
      messageCreatedAt: plain.createdAt,
    });

    const find = (
      text: string,
      filters: Parameters<typeof searchForUser>[3] extends infer I ? Omit<I, "text"> : never,
    ) => searchForUser(deps(f), f.owner.id, f.org.id, { text, ...filters });

    expect(bodies(await find("deploy", { messages: { fromAgentIds: [f.agent.id] } }))).toEqual([
      "approve the deploy?",
      "deploy done see https://example.test/run",
      "deploy report attached",
    ]);
    // Either author in `from`, any mention in `mentions`.
    expect(
      bodies(await find("deploy", { messages: { fromUserIds: [member.id], fromAgentIds: [f.agent.id] } })),
    ).toHaveLength(3);
    expect(bodies(await find("deploy", { messages: { authorType: "person" } }))).toEqual([
      "deploy notes",
      "deploy screenshot",
    ]);
    expect(
      bodies(await find("", { messages: { mentionsUserIds: [member.id], mentionsAgentIds: [f.agent.id] } })),
    ).toEqual(["deploy report attached", "deploy screenshot"]);
    expect(bodies(await find("", { messages: { has: ["link"] } }))).toEqual([
      "deploy done see https://example.test/run",
    ]);
    expect(bodies(await find("", { messages: { has: ["file"] } }))).toEqual([
      "deploy report attached",
      "deploy screenshot",
    ]);
    expect(bodies(await find("", { messages: { has: ["image"] } }))).toEqual(["deploy screenshot", "party gif"]);
    expect(bodies(await find("", { messages: { has: ["card"] } }))).toEqual(["approve the deploy?"]);
    expect(bodies(await find("", { messages: { has: ["file", "image"] } }))).toEqual(["deploy screenshot"]);
    expect(bodies(await find("", { messages: { pinned: true } }))).toEqual(["deploy notes"]);
    // Dates: after is inclusive, before exclusive.
    expect(bodies(await find("deploy", { after: day("2026-10-01"), before: day("2026-10-21") }))).toEqual([
      "approve the deploy?",
      "deploy done see https://example.test/run",
      "deploy report attached",
    ]);
    // By date, with or without words.
    const newest = await find("deploy", { sort: "newest" });
    expect(newest.map((h) => h.snippet)).toEqual([
      "deploy screenshot",
      "deploy report attached",
      "approve the deploy?",
      "deploy done see https://example.test/run",
      "deploy notes",
    ]);
    expect((await find("deploy", { sort: "oldest" })).map((h) => h.snippet)).toEqual(
      newest.map((h) => h.snippet).reverse(),
    );
    expect((await find("", { messages: { authorType: "person" }, sort: "oldest" }))[0]?.snippet).toBe("deploy notes");
    // No words and no filter: nothing.
    expect(await find("", {})).toEqual([]);
  });

  test("a voice message is found by its words and comes back as audio; a GIF says what it was (ADR 0100)", async () => {
    f = await setup();
    await message(f, {
      body: "ship the release on friday",
      meta: { voice: { clipId: crypto.randomUUID(), durationMs: 4200, peaks: [] } },
    });
    await message(f, { body: "release party gif", meta: { media: { kind: "gif", id: "g2" } }, at: day("2026-10-16") });
    const found = await searchForUser(deps(f), f.owner.id, f.org.id, { text: "release", sort: "newest" });
    const hits = await describeHits(f.db, f.org.id, found);
    expect(hits.map((h) => [h.snippet, h.mediaKind])).toEqual([
      ["release party gif", "gif"],
      ["", "voice"],
    ]);
  });

  test("a reply comes with its thread's title, else its root's first line; the timeline's hits with none", async () => {
    f = await setup();
    const titled = await message(f, { body: "invite link broken" });
    await f.db
      .insert(schema.threads)
      .values({ orgId: f.org.id, channelId: f.general.id, rootMessageId: titled.id, title: "Invite link error" });
    await message(f, { body: "the invite expires at 23h", threadId: titled.id, at: day("2026-10-16") });
    const untitled = await message(f, { body: "pricing page\nsecond line", at: day("2026-10-17") });
    await message(f, { body: "invite copy reviewed", threadId: untitled.id, at: day("2026-10-18") });
    const found = await searchForUser(deps(f), f.owner.id, f.org.id, { text: "invite", sort: "newest" });
    const hits = await describeHits(f.db, f.org.id, found);
    expect(hits.map((h) => [h.snippet, h.threadTitle])).toEqual([
      ["invite copy reviewed", "pricing page second line"],
      ["the invite expires at 23h", "Invite link error"],
      ["invite link broken", null],
    ]);
  });

  test("in: searches only those channels, never one the person can't read", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    const ops = await createChannel(f.db, f.owner.id, f.org.id, { name: "ops", visibility: "public" });
    await message(f, { channelId: secret.id, body: "budget secret" });
    await message(f, { channelId: ops.id, body: "budget ops" });
    await message(f, { body: "budget general" });

    const owner = (channelIds: string[], text = "budget") =>
      searchForUser(deps(f), f.owner.id, f.org.id, { text, channelIds });
    expect(bodies(await owner([ops.id]))).toEqual(["budget ops"]);
    expect(bodies(await owner([ops.id, secret.id]))).toEqual(["budget ops", "budget secret"]);
    // Only a channel scope: every message there, newest first.
    expect(bodies(await owner([secret.id], ""))).toEqual(["budget secret"]);
    // A channel the person isn't in is never searched, even asked for by id, and never widens to everything.
    const asMember = (channelIds: string[], text = "budget") =>
      searchForUser(deps(f), member.id, f.org.id, { text, channelIds });
    expect(await asMember([secret.id])).toEqual([]);
    expect(await asMember([secret.id], "")).toEqual([]);
    expect(await searchForUser(deps(f), member.id, f.org.id, { text: "", messages: { authorType: "person" } })).toEqual(
      [],
    );
  });

  test("has:file leaves out a message whose only file was deleted", async () => {
    f = await setup();
    const [file] = await f.db
      .insert(schema.artifacts)
      .values({
        orgId: f.org.id,
        kind: "file",
        title: "old.pdf",
        channelId: f.general.id,
        createdByType: "person",
        createdById: f.owner.id,
        updatedByType: "person",
        updatedById: f.owner.id,
        deletedAt: new Date(),
      })
      .returning();
    await message(f, { body: "gone file", meta: { artifacts: [{ id: file?.id, version: 1, title: "old.pdf" }] } });
    await message(f, {
      body: "kept file",
      meta: { artifacts: [{ id: crypto.randomUUID(), version: 1, title: "a.pdf" }] },
    });
    const hits = await searchForUser(deps(f), f.owner.id, f.org.id, { text: "", messages: { has: ["file"] } });
    expect(bodies(hits)).toEqual(["kept file"]);
  });

  test("a choice card or a poll is a card, not a file", async () => {
    f = await setup();
    const card = async (kind: "choices" | "poll", body: string) => {
      const [a] = await f.db
        .insert(schema.artifacts)
        .values({
          orgId: f.org.id,
          kind,
          title: body,
          channelId: f.general.id,
          createdByType: "agent",
          createdById: f.agent.id,
          updatedByType: "agent",
          updatedById: f.agent.id,
        })
        .returning();
      await message(f, { body, agent: true, meta: { artifacts: [{ id: a?.id, version: 1 }] } });
    };
    await card("choices", "pick a plan");
    await card("poll", "lunch poll");
    await message(f, {
      body: "a file",
      meta: { artifacts: [{ id: crypto.randomUUID(), version: 1, title: "a.pdf" }] },
    });
    const has = async (h: "file" | "card") =>
      bodies(await searchForUser(deps(f), f.owner.id, f.org.id, { text: "", messages: { has: [h] } }));
    expect(await has("file")).toEqual(["a file"]);
    expect(await has("card")).toEqual(["lunch poll", "pick a plan"]);
  });

  test("a filter probes only the message's own partition, also for a message stamped by the database", async () => {
    f = await setup();
    // `created_at` from `now()`: microseconds, which the document's copy loses.
    const rows = await f.db
      .insert(schema.messages)
      .values([
        { orgId: f.org.id, channelId: f.general.id, authorType: "person", authorUserId: f.owner.id, body: "now" },
        // Left out by the filter: its probe must still stop at its own partition.
        { orgId: f.org.id, channelId: f.general.id, authorType: "agent", authorAgentId: f.agent.id, body: "agent" },
      ])
      .returning();
    for (const r of rows) await indexSource(deps(f), { orgId: f.org.id, kind: "message", sourceId: r.id });
    const client = (f.db as unknown as { $client: { query: Query } }).$client;
    const query = client.query.bind(client);
    const seen: { sql: string; params?: unknown[] }[] = [];
    client.query = (sql, params, opts) => {
      seen.push({ sql, params });
      return query(sql, params, opts);
    };
    const hits = await searchForUser(deps(f), f.owner.id, f.org.id, { text: "", messages: { authorType: "person" } });
    client.query = query;
    expect(bodies(hits)).toEqual(["now"]);
    const search = seen.find((s) => s.sql.includes("search_documents"));
    const plan = (await query(`explain (analyze, costs off) ${search?.sql}`, search?.params)) as {
      rows: { "QUERY PLAN": string }[];
    };
    const lines = plan.rows.map((r) => r["QUERY PLAN"]);
    const partitions = lines.filter((l) => / on messages_\w+ /.test(l));
    expect(partitions.length).toBeGreaterThan(1);
    expect(partitions.filter((l) => !l.includes("never executed"))).toHaveLength(1);
  });
});

type Query = (sql: string, params?: unknown[], opts?: unknown) => Promise<unknown>;
