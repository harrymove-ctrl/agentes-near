import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }), env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

/** A signed-up person outside the organization (sign-up is open on this server). */
async function outsider(email: string) {
  const b = browser(t);
  await signUp(b, email);
  return b;
}

/** Smallest JPEG-shaped bytes (SOI, EXIF, scan, EOI). */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0x01, 0xff, 0xd9,
]);

test("photo: upload, serve to org members only, on the members list, remove", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const bad = await api("/me/avatar", {
    method: "PUT",
    json: { imageBase64: Buffer.from("<svg/>").toString("base64"), contentType: "image/jpeg" },
  });
  expect(bad.status).toBe(400);
  expect(
    (await api("/me/avatar", { method: "PUT", json: { imageBase64: "eA==", contentType: "image/gif" } })).status,
  ).toBe(400);

  const put = await api("/me/avatar", {
    method: "PUT",
    json: { imageBase64: Buffer.from(JPEG).toString("base64"), contentType: "image/jpeg" },
  });
  expect(put.status).toBe(200);
  const { avatarUrl } = (await put.json()) as { avatarUrl: string };
  expect(avatarUrl).toStartWith("/api/app/avatars/");

  const served = await owner(avatarUrl);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/jpeg");
  const body = new Uint8Array(await served.arrayBuffer());
  expect(Buffer.from(body).includes(Buffer.from("Exif"))).toBe(false);

  // Someone in no shared organization can't fetch it; signed-out people neither.
  const stranger = await outsider("stranger@example.com");
  expect((await stranger(avatarUrl)).status).toBe(404);
  expect((await t.app.request(avatarUrl)).status).toBe(401);
  // Nor can they set a photo through an organization they're not in.
  expect(
    (
      await stranger(`/api/app/organizations/${orgId}/me/avatar`, {
        method: "PUT",
        json: { imageBase64: Buffer.from(JPEG).toString("base64"), contentType: "image/jpeg" },
      })
    ).status,
  ).toBe(403);

  const members = (await (await api("/members")).json()) as { members: { avatarUrl: string | null }[] };
  expect(members.members[0]?.avatarUrl).toBe(avatarUrl);
  const people = (await (await api("/people")).json()) as { people: { avatarUrl: string | null }[] };
  expect(people.people[0]?.avatarUrl).toBe(avatarUrl);

  expect((await api("/me/avatar", { method: "DELETE" })).status).toBe(204);
  expect((await owner(avatarUrl)).status).toBe(404);
  const after = (await (await api("/members")).json()) as { members: { avatarUrl: string | null }[] };
  expect(after.members[0]?.avatarUrl).toBeNull();
});

test("agent appearance: on the list and detail, allow-list enforced", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const look = { color: "violet", eyes: "sleepy", accessory: "crown" };
  expect(
    (await api(`/agents/${agentId}`, { method: "PATCH", json: { appearance: { ...look, color: "pink" } } })).status,
  ).toBe(400);
  const patched = await api(`/agents/${agentId}`, { method: "PATCH", json: { appearance: look } });
  expect(patched.status).toBe(200);
  expect(await patched.json()).toMatchObject({ appearance: look });

  const list = (await (await api("/agents")).json()) as { agents: { id: string; appearance: unknown }[] };
  expect(list.agents.find((a) => a.id === agentId)?.appearance).toEqual(look);
  expect(await (await api(`/agents/${agentId}`)).json()).toMatchObject({ appearance: look });

  // "Personalizar": a #rrggbb in the same field, stored lowercase; anything else hex-like is refused.
  for (const color of ["#12345", "#12345g", "red"]) {
    expect(
      (await api(`/agents/${agentId}`, { method: "PATCH", json: { appearance: { ...look, color } } })).status,
    ).toBe(400);
  }
  const custom = await api(`/agents/${agentId}`, {
    method: "PATCH",
    json: { appearance: { ...look, color: "#A1B2C3" } },
  });
  expect(custom.status).toBe(200);
  expect(((await custom.json()) as { appearance: { color: string } }).appearance.color).toBe("#a1b2c3");

  const reset = await api(`/agents/${agentId}`, { method: "PATCH", json: { appearance: null } });
  expect(await reset.json()).toMatchObject({ appearance: null });
});
