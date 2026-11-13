import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({
    env: { ALLOW_SIGNUP: "true" },
    reply: () => ({ chunks: ["done"], usage: { inputTokens: 100, outputTokens: 10 } }),
  });
});
afterEach(() => t.close());

async function workspace() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const member = browser(t);
  await signUp(member, "ana@example.com");
  const { url } = (await (
    await owner(`/api/app/organizations/${seeded.orgId}/invitations`, {
      json: { email: "ana@example.com", role: "member" },
    })
  ).json()) as { url: string };
  await member(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  const me = (await (await member("/api/auth/get-session")).json()) as { user: { id: string } };
  const api = (b: typeof owner) => (path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${seeded.orgId}${path}`, init);
  return { ...seeded, memberId: me.user.id, owner: api(owner), member: api(member) };
}

test("Uso › Pessoas: admins see each person's use, its CSV and the limits; members only their own, in percentages", async () => {
  const w = await workspace();
  await w.owner(`/channels/${w.channelId}/messages`, { json: { body: "@dev status?" } });
  await t.drain();

  type People = { people: { name: string; runs: number; costUsd: number }[]; limitsOn: boolean };
  const report = (await (await w.owner("/usage/people")).json()) as People;
  expect(report.limitsOn).toBe(false);
  expect(report.people.find((p) => p.name === "owner")).toMatchObject({ runs: 1 });
  const csv = await w.owner("/usage/people.csv");
  expect(csv.headers.get("content-type")).toContain("text/csv");
  expect((await csv.text()).split("\n")[0]).toStartWith("person,email,roles,day");

  // A member: no people report, no CSV, no one else's month; their own without money.
  expect((await w.member("/usage/people")).status).toBe(403);
  expect((await w.member("/usage/people.csv")).status).toBe(403);
  const mine = await w.member(`/usage/people/${w.memberId}`);
  expect(mine.status).toBe(200);
  // Field names only: a random id in the answer may contain "usd" by chance.
  const keys = (value: unknown): string[] =>
    value && typeof value === "object" ? Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)]) : [];
  expect(keys(await mine.json()).filter((key) => /usd/i.test(key))).toEqual([]);

  // Limits: off until set; only who configures sets them.
  const off = (await (await w.owner("/usage/limits")).json()) as { defaultUsd: number | null; onLimit: string };
  expect(off).toMatchObject({ defaultUsd: null, onLimit: "block" });
  const limits = { defaultUsd: 20, roles: {}, people: { [w.memberId]: 10 }, onLimit: "block", warn: true };
  expect((await w.member("/usage/limits", { method: "PUT", json: limits })).status).toBe(403);
  const saved = await w.owner("/usage/limits", { method: "PUT", json: limits });
  expect(await saved.json()).toMatchObject({ defaultUsd: 20, people: { [w.memberId]: 10 } });
  expect(((await (await w.owner("/usage/people")).json()) as People).limitsOn).toBe(true);

  // A raise for the month is the owner's to make, never the member's own.
  expect((await w.member(`/usage/people/${w.memberId}/raise`, { json: { limitUsd: 15 } })).status).toBe(403);
  expect((await w.owner(`/usage/people/${w.memberId}/raise`, { json: { limitUsd: 15 } })).status).toBe(204);
  const raised = (await (await w.owner(`/usage/people/${w.memberId}`)).json()) as {
    limit: { limitUsd: number; limitFrom: string };
  };
  expect(raised.limit).toMatchObject({ limitUsd: 15, limitFrom: "raised" });
});
