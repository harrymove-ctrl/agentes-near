import { afterEach, describe, expect, test } from "bun:test";
import { createPostgresSearchResolver } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import {
  agentVisibleChannels,
  archiveThread,
  createChannel,
  drainOutbox,
  joinChannel,
  postPersonMessage,
  reindexOrg,
  searchForUser,
  searchVisible,
  unarchiveThread,
} from "../src";
import { deliverNotice } from "../src/delivery";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const post = (fx: Fixture, channelId: string, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, channelId, { body });

describe("search index (Postgres, hybrid)", () => {
  test("messages are indexed through the outbox; results respect channel visibility and the org", async () => {
    f = await setup({ embeddings: true });
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await post(f, f.general.id, "launch window is friday after the review");
    await post(f, secret.id, "launch budget is 100%_secret");
    await post(f, f.general.id, "lunch menu: lasagna");
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.searchDocuments)).toHaveLength(3);
    const deps = { db: f.db, search: f.search, gateway: f.gateway };

    const general = await searchVisible(deps, { orgId: f.org.id, text: "launch", visibleChannelIds: [f.general.id] });
    expect(general.map((h) => h.snippet)).toEqual(["launch window is friday after the review"]);
    const both = await searchVisible(deps, {
      orgId: f.org.id,
      text: "launch",
      visibleChannelIds: [f.general.id, secret.id],
    });
    expect(both).toHaveLength(2);
    expect(await searchVisible(deps, { orgId: f.org.id, text: "launch", visibleChannelIds: [] })).toEqual([]);
    // Query syntax is safe (websearch syntax, no injection).
    expect(
      await searchVisible(deps, { orgId: f.org.id, text: "100%_' or 1=1 --", visibleChannelIds: [secret.id] }),
    ).toBeArray();
    // Another org sees nothing, even with the channel ids.
    const other = await createPostgresSearchResolver(f.db).forOrg(crypto.randomUUID());
    expect(await other.query({ text: "launch", visibleChannelIds: [f.general.id] })).toEqual([]);
    // A notice only its agent reads (what a person decided on its proposal) is nobody's to find.
    await f.db.transaction((tx) =>
      deliverNotice(tx, {
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadId: null,
        hop: 1,
        stretchId: null,
        notice: { kind: "proposal_result", text: "ana created the launch agent" },
        wake: false,
      }),
    );
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.searchDocuments)).toHaveLength(3);
    // Embeddings were computed and recorded as usage (kind embedding, no agent).
    const usage = (await f.db.select().from(schema.usageRecords)).filter((u) => u.kind === "embedding");
    expect(usage.length).toBeGreaterThanOrEqual(3);
    expect(usage.every((u) => u.agentId === null && u.orgId === f.org.id)).toBe(true);
  });

  test("vector similarity finds what full-text misses; without embeddings it falls back to full-text", async () => {
    f = await setup({ embeddings: true });
    await post(f, f.general.id, "the deploy pipeline broke on staging");
    await drainOutbox(f.db, f.handlers);
    const deps = { db: f.db, search: f.search, gateway: f.gateway };
    // "pipeline staging deploys" shares words but not the exact phrase; full-text AND would miss "deploys".
    const hybrid = await searchVisible(deps, {
      orgId: f.org.id,
      text: "pipeline staging deploys",
      visibleChannelIds: [f.general.id],
    });
    expect(hybrid.map((h) => h.snippet)).toEqual(["the deploy pipeline broke on staging"]);
    await f.close();

    f = await setup();
    await post(f, f.general.id, "the deploy pipeline broke on staging");
    await drainOutbox(f.db, f.handlers);
    const textOnly = { db: f.db, search: f.search, gateway: f.gateway };
    expect(
      await searchVisible(textOnly, {
        orgId: f.org.id,
        text: "pipeline staging deploys",
        visibleChannelIds: [f.general.id],
      }),
    ).toEqual([]);
    expect(
      (await searchVisible(textOnly, { orgId: f.org.id, text: "pipeline staging", visibleChannelIds: [f.general.id] }))
        .length,
    ).toBe(1);
  });

  test("a person searches what they can read; an agent what its channels show; reindex rebuilds", async () => {
    f = await setup();
    const eng = await createChannel(f.db, f.owner.id, f.org.id, { name: "eng", visibility: "private" });
    await post(f, eng.id, "postgres upgrade on tuesday");
    await drainOutbox(f.db, f.handlers);
    const deps = { db: f.db, search: f.search, gateway: f.gateway };
    const member = await addMember(f.db, f.org.id, "member");
    expect(await searchForUser(deps, member.id, f.org.id, { text: "postgres" })).toEqual([]);
    expect(await searchForUser(deps, f.owner.id, f.org.id, { text: "postgres" })).toHaveLength(1);
    expect(await agentVisibleChannels(f.db, f.org.id, f.agent.id)).toEqual([f.general.id]);
    await joinChannel(f.db, member.id, f.org.id, f.general.id);

    await f.db.delete(schema.searchDocuments);
    expect(await reindexOrg(deps, f.org.id)).toBe(1);
    expect(await searchForUser(deps, f.owner.id, f.org.id, { text: "postgres" })).toHaveLength(1);
  });

  test("an archived thread's replies are out of a person's search, as its toast says, until it's unarchived", async () => {
    f = await setup();
    const root = await post(f, f.general.id, "release checklist");
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "the rollback plan is ready",
      threadId: root.id,
    });
    await post(f, f.general.id, "rollback drill on monday");
    await drainOutbox(f.db, f.handlers);
    const deps = { db: f.db, search: f.search, gateway: f.gateway };
    const found = async (filters: { channelIds?: string[] } = {}) =>
      (await searchForUser(deps, f.owner.id, f.org.id, { text: "rollback", ...filters })).map((h) => h.snippet).sort();
    expect(await found()).toEqual(["rollback drill on monday", "the rollback plan is ready"]);

    await archiveThread({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, root.id);
    expect(await found()).toEqual(["rollback drill on monday"]);
    expect(await found({ channelIds: [f.general.id] })).toEqual(["rollback drill on monday"]);
    // Its root stays in the channel's timeline, so it stays found.
    expect((await searchForUser(deps, f.owner.id, f.org.id, { text: "checklist" })).length).toBe(1);

    await unarchiveThread({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, root.id);
    expect(await found()).toEqual(["rollback drill on monday", "the rollback plan is ready"]);
  });
});
