import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { publishOrgEvent } from "@agenteschat/engine";
import { browser, createTestServer, listen, ORIGIN, seedOrg, signUp, type TestServer, upgradeStatus } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

test("suspension closes actor-only issue, artifact, wiki, calendar, channel, and machine gates", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const event = await api("/calendar/events", {
    json: {
      title: "Planning",
      start: "2030-01-01T12:00:00.000Z",
      end: "2030-01-01T13:00:00.000Z",
      participants: [],
    },
  });
  expect(event.status).toBe(201);
  const { id: eventId } = (await event.json()) as { id: string };

  await t.db
    .update(schema.organizations)
    .set({ standing: "suspended", standingNotice: "silent" })
    .where(eq(schema.organizations.id, orgId));

  const attempts: Array<[string, Parameters<typeof owner>[1]?]> = [
    ["/issues"],
    ["/issues", { json: { title: "Should fail" } }],
    ["/issue-columns"],
    ["/issue-columns", { json: { name: "Should fail", stage: "todo" } }],
    ["/artifacts"],
    ["/artifacts", { json: { title: "Should fail", content: { kind: "document", markdown: "x" } } }],
    ["/wiki/pages"],
    ["/wiki/pages", { json: { title: "Should fail", body: "x" } }],
    [`/calendar/events/${eventId}`, { method: "PATCH", json: { title: "Should fail" } }],
    [`/channels/${channelId}`, { method: "PATCH", json: { topic: "Should fail" } }],
    ["/machines/device/ABC123/confirm", { json: {} }],
  ];
  for (const [path, init] of attempts) {
    const response = await api(path, init);
    expect(response.status).toBe(403);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({ error: { code: "org.suspended" } });
  }

  await t.db.update(schema.organizations).set({ standing: "active" }).where(eq(schema.organizations.id, orgId));
  expect((await api("/issues")).status).toBe(200);
});

test("suspended member cannot open a new realtime socket", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const server = listen(t);
  try {
    const url = `ws://127.0.0.1:${server.port}/api/ws?orgId=${orgId}`;
    await t.db.update(schema.organizations).set({ standing: "suspended" }).where(eq(schema.organizations.id, orgId));
    expect(await upgradeStatus(url, { origin: ORIGIN, cookie: owner.cookie() })).toBe(403);
  } finally {
    await Promise.race([server.stop(true), Bun.sleep(500)]);
  }
});

test("a standing change closes an existing realtime socket", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const server = listen(t);
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?orgId=${orgId}`, {
    headers: { origin: ORIGIN, cookie: owner.cookie() },
  } as unknown as string[]);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        if ((JSON.parse(String(event.data)) as { type?: string }).type === "ready") resolve();
      });
      socket.addEventListener("error", () => reject(new Error("socket did not open")), { once: true });
    });
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
    );
    await t.db.update(schema.organizations).set({ standing: "suspended" }).where(eq(schema.organizations.id, orgId));
    await publishOrgEvent(t.adapters.pubsub, {
      type: "org.broadcast",
      orgId,
      event: { type: "org.standing", orgId, state: "suspended" },
    });
    expect(await Promise.race([closed, Bun.sleep(2000).then(() => -1)])).toBe(4403);
  } finally {
    socket.close();
    await Promise.race([server.stop(true), Bun.sleep(500)]);
  }
});
