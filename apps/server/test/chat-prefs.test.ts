import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }), env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

type Me = { organizations: { id: string; chatPrefs?: Record<string, string> }[] };

test("how conversations look: only what the person chose, each person's own, merged key by key", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const prefsOf = async (b: typeof owner) =>
    ((await (await b("/api/app/me")).json()) as Me).organizations.find((o) => o.id === orgId)?.chatPrefs;
  const put = (b: typeof owner, json: Record<string, string>) =>
    b(`/api/app/organizations/${orgId}/me/chat`, { method: "PUT", json });

  expect(await prefsOf(owner)).toEqual({});

  const first = await put(owner, { dmStyle: "compact" });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ dmStyle: "compact" });
  expect(await (await put(owner, { channelTone: "strong", openAt: "read" })).json()).toEqual({
    dmStyle: "compact",
    channelTone: "strong",
    openAt: "read",
  });
  expect(await prefsOf(owner)).toEqual({ dmStyle: "compact", channelTone: "strong", openAt: "read" });

  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect(await prefsOf(member)).toEqual({});

  expect((await put(owner, { dmStyle: "wide" })).status).toBe(400);
  expect(await prefsOf(owner)).toEqual({ dmStyle: "compact", channelTone: "strong", openAt: "read" });

  // Tamanho do texto: one of the steps, kept beside the looks, each person's own.
  expect((await put(owner, { textSize: "huge" })).status).toBe(400);
  expect(await (await put(owner, { textSize: "xl" })).json()).toEqual({
    dmStyle: "compact",
    channelTone: "strong",
    openAt: "read",
    textSize: "xl",
  });
  expect((await prefsOf(owner))?.textSize).toBe("xl");
  expect(await prefsOf(member)).toEqual({});

  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  expect((await put(stranger, { dmStyle: "left" })).status).toBe(403);
});

test("where the unread starts is in the channel list, and reading moves it", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  type Channels = { channels: { id: string; lastReadAt: string | null }[] };
  const list = async () =>
    ((await (await owner(`/api/app/organizations/${orgId}/channels`)).json()) as Channels).channels;
  const before = (await list())[0];
  if (!before?.lastReadAt) throw new Error("no read position");
  await Bun.sleep(5);
  const read = await owner(`/api/app/organizations/${orgId}/channels/${before.id}/read`, { method: "POST", json: {} });
  expect(read.status).toBe(204);
  const after = (await list()).find((c) => c.id === before.id);
  expect(Date.parse(after?.lastReadAt ?? "")).toBeGreaterThan(Date.parse(before.lastReadAt));
});
