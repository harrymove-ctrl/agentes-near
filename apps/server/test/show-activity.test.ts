import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }), env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

type Me = { organizations: { id: string; showActivity?: boolean }[] };

test("what agents did under each reply: off by default, each person's own, in GET /me", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const shownTo = async (b: typeof owner) =>
    ((await (await b("/api/app/me")).json()) as Me).organizations.find((o) => o.id === orgId)?.showActivity;
  const put = (b: typeof owner, show: boolean) =>
    b(`/api/app/organizations/${orgId}/me/activity`, { method: "PUT", json: { show } });

  expect(await shownTo(owner)).toBe(false);

  const on = await put(owner, true);
  expect(on.status).toBe(200);
  expect(await on.json()).toEqual({ show: true });
  expect(await shownTo(owner)).toBe(true);

  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect(await shownTo(member)).toBe(false);
  expect((await put(member, true)).status).toBe(200);
  expect((await put(member, false)).status).toBe(200);
  expect(await shownTo(member)).toBe(false);
  expect(await shownTo(owner)).toBe(true);

  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  expect((await put(stranger, true)).status).toBe(403);
});
