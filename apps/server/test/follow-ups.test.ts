import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

/** An agent's follow-up over HTTP (ADR 0037, round 3): its line in the conversation, and a person cancels it. */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

test("the agent sets a follow-up; its line lists with the messages; a person cancels it once", async () => {
  t = await createTestServer({
    // Call 1 is the key's test when `seedOrg` saves it.
    reply: (_request, call) =>
      call === 2
        ? {
            chunks: [""],
            toolUses: [
              { name: "follow_up", input: { minutes: 30, note: "Check CI run 42 again.", about: "ver o CI" } },
            ],
          }
        : { chunks: ["Ainda rodando. Volto em 30 minutos para ver o CI."] },
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const org = `/api/app/organizations/${orgId}`;
  await owner(`${org}/channels/${channelId}/messages`, { json: { body: "@dev o CI terminou?" } });
  await t.drain();

  const listed = (await (await owner(`${org}/channels/${channelId}/messages`)).json()) as {
    messages: { id: string; body: string; meta: Record<string, unknown> }[];
  };
  const line = listed.messages.find((m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "follow_up");
  expect(line?.meta.notice).toMatchObject({ refs: { about: "ver o CI", state: "pending" } });
  expect(listed.messages.map((m) => m.body)).toContain("Ainda rodando. Volto em 30 minutos para ver o CI.");

  const canceled = await owner(`${org}/messages/${line?.id}/cancel-follow-up`, { json: {} });
  expect(canceled.status).toBe(204);
  const again = await owner(`${org}/messages/${line?.id}/cancel-follow-up`, { json: {} });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe("follow_up.not_pending");
  const after = (await (await owner(`${org}/channels/${channelId}/messages`)).json()) as {
    messages: { id: string; meta: Record<string, unknown> }[];
  };
  expect(after.messages.find((m) => m.id === line?.id)?.meta.notice).toMatchObject({ refs: { state: "canceled" } });
});
