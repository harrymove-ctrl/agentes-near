import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, joinByInvitation, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

/** Smallest JPEG-shaped bytes (SOI, EXIF, scan, EOI). */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0x01, 0xff, 0xd9,
]);
const image = { imageBase64: Buffer.from(JPEG).toString("base64"), contentType: "image/jpeg" };

/** Someone who joins the organization through an email invitation (a plain member). */
const member = (owner: ReturnType<typeof browser>, orgId: string, email: string) =>
  joinByInvitation(t, owner, orgId, email);

test("workspace logo: admins upload and remove it; members see it; strangers don't", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const logoApi = `/api/app/organizations/${orgId}/logo`;

  // Only real JPEG/PNG/WebP bytes.
  const bad = await owner(logoApi, {
    method: "PUT",
    json: { imageBase64: Buffer.from("<svg/>").toString("base64"), contentType: "image/jpeg" },
  });
  expect(bad.status).toBe(400);

  const put = await owner(logoApi, { method: "PUT", json: image });
  expect(put.status).toBe(200);
  const { logo } = (await put.json()) as { logo: string };
  expect(logo).toStartWith(`/api/app/org-logos/${orgId}/`);

  // On the organization and in /me; served without metadata.
  const org = (await (await owner(`/api/app/organizations/${orgId}`)).json()) as { logo: string | null };
  expect(org.logo).toBe(logo);
  const me = (await (await owner("/api/app/me")).json()) as { organizations: { id: string; logo: string | null }[] };
  expect(me.organizations.find((o) => o.id === orgId)?.logo).toBe(logo);
  const served = await owner(logo);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/jpeg");
  expect(Buffer.from(new Uint8Array(await served.arrayBuffer())).includes(Buffer.from("Exif"))).toBe(false);

  // A member sees it but can't change it.
  const ana = await member(owner, orgId, "ana@example.com");
  expect((await ana(logo)).status).toBe(200);
  expect((await ana(logoApi, { method: "PUT", json: image })).status).toBe(403);
  expect((await ana(logoApi, { method: "DELETE" })).status).toBe(403);
  // Closed, it still marks the workspace in its people's list of workspaces.
  const set = (to: Partial<typeof schema.organizations.$inferInsert>) =>
    t.db.update(schema.organizations).set(to).where(eq(schema.organizations.id, orgId));
  for (const closed of [{ deletionDueAt: new Date(Date.now() + 86_400_000) }, { standing: "suspended" as const }]) {
    await set(closed);
    expect((await ana(logo)).status).toBe(200);
  }
  await set({ deletionDueAt: null, standing: "active" });

  // Signed-out people and people outside the organization can't fetch it.
  expect((await t.app.request(logo)).status).toBe(401);
  // Invited, never accepted: signed up but not in the organization.
  const invited = await owner(`/api/app/organizations/${orgId}/invitations`, {
    json: { email: "stranger@example.com", role: "member" },
  });
  expect(invited.status).toBe(201);
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  expect((await stranger(logo)).status).toBe(404);

  // Removed: back to the agent mark.
  expect((await owner(logoApi, { method: "DELETE" })).status).toBe(204);
  const after = (await (await owner(`/api/app/organizations/${orgId}`)).json()) as { logo: string | null };
  expect(after.logo).toBeNull();
});

test("the logo on an invitation's page: through its link or invitation only, while it works", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const anon = browser(t);
  const preview = async (token: string) =>
    (await (await anon(`/api/app/invitations/${token}`)).json()) as Record<string, unknown>;
  const tokenOf = (url: string) => url.split("/invite/")[1] ?? "";
  const link = (await (await owner(`/api/app/organizations/${orgId}/invite-links`, { json: {} })).json()) as {
    id: string;
    url: string;
  };
  const invited = await owner(`/api/app/organizations/${orgId}/invitations`, {
    json: { email: "bia@example.com", role: "member" },
  });
  const tokens = { link: tokenOf(link.url), email: tokenOf(((await invited.json()) as { url: string }).url) };

  // No logo: none on the page, nothing to serve.
  expect(await preview(tokens.link)).not.toHaveProperty("logo");
  expect((await anon(`/api/app/invitations/${tokens.link}/logo/0123456789abcdef.jpg`)).status).toBe(404);

  const put = await owner(`/api/app/organizations/${orgId}/logo`, { method: "PUT", json: image });
  const file = ((await put.json()) as { logo: string }).logo.split("/").pop();
  for (const token of [tokens.link, tokens.email]) {
    const logo = (await preview(token)).logo;
    expect(logo).toBe(`/api/app/invitations/${token}/logo/${file}`);
    const served = await anon(String(logo));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/jpeg");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe("sandbox");
    expect(served.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    // No session guards it: only this server's own pages may show it.
    expect(served.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  }
  // Only the workspace's current file, only through a token that works.
  expect((await anon(`/api/app/invitations/${tokens.link}/logo/0123456789abcdef.jpg`)).status).toBe(404);
  expect((await anon(`/api/app/invitations/not-a-token/logo/${file}`)).status).toBe(404);
  // A paused workspace takes no one in: neither token shows or serves its logo until it is active again.
  const standing = (to: "active" | "hold" | "suspended") =>
    t.db.update(schema.organizations).set({ standing: to }).where(eq(schema.organizations.id, orgId));
  for (const paused of ["hold", "suspended"] as const) {
    await standing(paused);
    expect(await preview(tokens.email)).not.toHaveProperty("logo");
    for (const token of [tokens.link, tokens.email])
      expect((await anon(`/api/app/invitations/${token}/logo/${file}`)).status).toBe(404);
  }
  await standing("active");
  expect((await anon(`/api/app/invitations/${tokens.email}/logo/${file}`)).status).toBe(200);
  // Nor one being deleted, until it is restored.
  const deleting = (dueAt: Date | null) =>
    t.db.update(schema.organizations).set({ deletionDueAt: dueAt }).where(eq(schema.organizations.id, orgId));
  await deleting(new Date(Date.now() + 86_400_000));
  for (const token of [tokens.link, tokens.email]) {
    expect(await preview(token)).not.toHaveProperty("logo");
    expect((await anon(`/api/app/invitations/${token}/logo/${file}`)).status).toBe(404);
  }
  // Its invitations read as closed, as its links do: no inviter, no agents, no form to join.
  expect(await preview(tokens.email)).toEqual({
    orgName: "Acme",
    email: "",
    role: "member",
    kind: "email",
    invitedBy: null,
    agents: [],
    closed: true,
  });
  await deleting(null);
  expect((await anon(`/api/app/invitations/${tokens.email}/logo/${file}`)).status).toBe(200);
  await t.db.update(schema.organizationInvitations).set({ expiresAt: new Date(Date.now() - 1000) });
  expect((await anon(`/api/app/invitations/${tokens.email}/logo/${file}`)).status).toBe(404);
  const off = await owner(`/api/app/organizations/${orgId}/invite-links/${link.id}`, { method: "DELETE" });
  expect(off.status).toBe(204);
  expect((await anon(`/api/app/invitations/${tokens.link}/logo/${file}`)).status).toBe(404);
  expect(await preview(tokens.link)).not.toHaveProperty("logo");
});

test("the logo on an invitation's page is limited per address: 60 a minute, then 429", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const link = (await (await owner(`/api/app/organizations/${orgId}/invite-links`, { json: {} })).json()) as {
    url: string;
  };
  const put = await owner(`/api/app/organizations/${orgId}/logo`, { method: "PUT", json: image });
  const file = ((await put.json()) as { logo: string }).logo.split("/").pop();
  const logo = `/api/app/invitations/${link.url.split("/invite/")[1]}/logo/${file}`;
  const from = (ip: string) => browser(t)(logo, { headers: { "x-forwarded-for": ip } });
  for (let i = 0; i < 60; i++) expect((await from("203.0.113.1")).status).toBe(200);
  const limited = await from("203.0.113.1");
  expect(limited.status).toBe(429);
  expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  expect((await from("203.0.113.2")).status).toBe(200);
});

test("the logo for a connected computer: machine token, ETag/304, 404 without one, 401 once removed", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const computer = { hostname: "mac", os: "darwin", arch: "arm64", version: "0.1.0", protocol: 10, exec: false };
  const { machineId, token } = await pairComputer(t, api, computer);
  const fetchLogo = (headers: Record<string, string> = {}) =>
    t.app.request("/api/machines/org-logo", { headers: { authorization: `Bearer ${token}`, ...headers } });

  expect((await t.app.request("/api/machines/org-logo")).status).toBe(401);
  const forged = await t.app.request("/api/machines/org-logo", { headers: { authorization: "Bearer agm_nope" } });
  expect(forged.status).toBe(401);
  expect((await fetchLogo()).status).toBe(404);

  const put = await owner(`/api/app/organizations/${orgId}/logo`, { method: "PUT", json: image });
  const { logo } = (await put.json()) as { logo: string };
  const res = await fetchLogo();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/jpeg");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).toBe("private, max-age=300");
  const etag = res.headers.get("etag") ?? "";
  expect(etag).toBe(`"${logo.split("/").pop()}"`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);

  const same = await fetchLogo({ "if-none-match": etag });
  expect(same.status).toBe(304);
  expect(same.headers.get("etag")).toBe(etag);
  expect((await fetchLogo({ "if-none-match": '"0000000000000000.jpg"' })).status).toBe(200);

  // Removed logo → 404; removed computer → 401.
  expect((await owner(`/api/app/organizations/${orgId}/logo`, { method: "DELETE" })).status).toBe(204);
  expect((await fetchLogo()).status).toBe(404);
  expect((await api(`/machines/${machineId}`, { method: "DELETE" })).status).toBe(204);
  expect((await fetchLogo()).status).toBe(401);
});
