import { afterEach, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

test("a sign-up whose name is its password makes no account", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const res = await browser(t)("/api/auth/sign-up/email", {
    json: { email: "bia@example.com", password: "correct horse battery", name: " correct horse battery " },
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { code: string }).code).toBe("NAME_IS_PASSWORD");
  expect(await t.db.select().from(schema.users).where(eq(schema.users.email, "bia@example.com"))).toEqual([]);
});

test("a new name reaches every workspace the person is in", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  const orgIds: string[] = [];
  for (const owner of [bia, ana]) {
    const res = await owner("/api/app/organizations", { json: { name: "Acme" } });
    orgIds.push(((await res.json()) as { organization: { id: string } }).organization.id);
  }
  await joinByInvitation(t, ana, orgIds[1] as string, "bia@example.com", { as: bia });
  // A workspace she isn't in hears nothing.
  const carla = browser(t);
  await signUp(carla, "carla@example.com");
  const other = await carla("/api/app/organizations", { json: { name: "Other" } });
  const otherId = ((await other.json()) as { organization: { id: string } }).organization.id;
  const phone = browser(t);
  await phone("/api/auth/sign-in/email", { json: { email: "bia@example.com", password: "correct horse battery" } });
  expect(((await (await phone("/api/app/me")).json()) as { user: { name: string } }).user.name).toBe("bia");
  const heard: string[] = [];
  for (const orgId of [...orgIds, otherId])
    t.adapters.pubsub.subscribe(orgTopic(orgId), (e) => {
      if ((e as { event?: { type?: string } }).event?.type === "org.members") heard.push(orgId);
    });
  expect((await bia("/api/auth/update-user", { json: { name: "Bia Souza" } })).status).toBe(200);
  expect(heard.sort()).toEqual([...orgIds].sort());
  // Her other devices read it in `me`, past their session's cached cookie.
  const me = (await (await phone("/api/app/me")).json()) as { user: { name: string } };
  expect(me.user.name).toBe("Bia Souza");
  // The photo is theirs everywhere too; a handle is one workspace's.
  heard.length = 0;
  expect((await bia(`/api/app/organizations/${orgIds[0]}/me/avatar`, { method: "DELETE" })).status).toBe(204);
  expect(heard.sort()).toEqual([...orgIds].sort());
  heard.length = 0;
  const renamed = await bia(`/api/app/organizations/${orgIds[0]}/me`, { method: "PATCH", json: { handle: "bias" } });
  expect(renamed.status).toBe(200);
  expect(heard).toEqual([orgIds[0] as string]);
});
