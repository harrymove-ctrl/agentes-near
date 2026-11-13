import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

test("outcomes quote a conversation only to who reads it; the rest keep kind and polarity", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const [dm] = await t.db
    .insert(schema.channels)
    .values({ orgId, name: "dm-other", kind: "dm", visibility: "private" })
    .returning();
  await t.db.insert(schema.outcomes).values([
    {
      orgId,
      agentId,
      kind: "query",
      polarity: "positive",
      subject: "payroll",
      summary: "salary late",
      source: "tool",
      channelId: dm?.id,
    },
    {
      orgId,
      agentId,
      kind: "deploy",
      polarity: "positive",
      subject: "app",
      summary: "shipped",
      source: "tool",
      channelId,
    },
  ]);
  const res = await owner(`/api/app/organizations/${orgId}/outcomes?agentId=${agentId}`);
  const { outcomes } = (await res.json()) as { outcomes: { kind: string; subject: string; summary: string }[] };
  expect(outcomes.find((o) => o.kind === "query")).toMatchObject({ subject: "", summary: "" });
  expect(outcomes.find((o) => o.kind === "deploy")).toMatchObject({ subject: "app", summary: "shipped" });
});
