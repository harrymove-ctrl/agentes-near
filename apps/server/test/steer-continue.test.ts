import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

/** "Parar e mandar", what agents haven't read yet, and "Continuar" over HTTP. */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

test('steer "now" is accepted; active runs list what is unread; continue answers 404 / 409', async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const org = `/api/app/organizations/${orgId}`;
  const post = async (json: Record<string, unknown>) => {
    const res = await owner(`${org}/channels/${channelId}/messages`, { json });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; meta: Record<string, unknown> };
  };

  await post({ body: "@dev revisa o PR" });
  // Asked in the channel, the run answers there: a new message there joins it.
  const steer = await post({ body: "@dev usa a dev", steer: "now" });
  expect(steer.meta.steeredRunIds).toBeArrayOfSize(1);
  const runId = (steer.meta.steeredRunIds as string[])[0] as string;

  const active = (await (await owner(`${org}/channels/${channelId}/active-runs`)).json()) as {
    runs: { runId: string; pendingMessageIds: string[] }[];
  };
  expect(active.runs).toEqual([expect.objectContaining({ runId, pendingMessageIds: [steer.id] })]);
  const working = (await (await owner(`${org}/active-runs`)).json()) as { runs: { pendingMessageIds: string[] }[] };
  expect(working.runs[0]?.pendingMessageIds).toEqual([steer.id]);

  const unknown = await owner(`${org}/runs/${crypto.randomUUID()}/continue`, { json: {} });
  expect(unknown.status).toBe(404);
  // Stopped before it started: nothing to continue.
  expect((await owner(`${org}/runs/${runId}/cancel`, { json: {} })).status).toBe(200);
  const refused = await owner(`${org}/runs/${runId}/continue`, { json: {} });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("run.not_continuable");
});
