import { afterEach, beforeEach, expect, test } from "bun:test";
import { ROLE_PERMISSIONS } from "@agenteschat/engine";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

type Workspace = { id: string; role: string; permissions: string[]; rank: number | null };
type Role = { id: string; kind: string; name: string; permissions: string[]; editable: boolean; givable: boolean };

const userIdOf = async (b: Browser) => ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;

/** The owner's workspace and Ana, a member invited with no role but the base one. */
async function start() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const api = (b: Browser, path: string, init?: Parameters<Browser>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const workspace = async (b: Browser) => (await (await api(b, "")).json()) as Workspace;
  const roles = async (b: Browser) => ((await (await api(b, "/roles")).json()) as { roles: Role[] }).roles;
  return { owner, ana, orgId, ownerId: await userIdOf(owner), anaId: await userIdOf(ana), api, workspace, roles };
}

test("GET /me: an owner may do everything; a member what the base role gives", async () => {
  const { owner, ana, orgId } = await start();
  const here = async (b: Browser) => {
    const { organizations } = (await (await b("/api/app/me")).json()) as { organizations: Workspace[] };
    return organizations.find((o) => o.id === orgId);
  };
  const owners = await here(owner);
  expect(owners).toMatchObject({ role: "owner", rank: null });
  expect([...(owners?.permissions ?? [])].sort()).toEqual(["read", "manage_owners", ...ROLE_PERMISSIONS].sort());
  const members = await here(ana);
  expect(members).toMatchObject({ role: "member", rank: null });
  expect([...(members?.permissions ?? [])].sort()).toEqual([
    "assign_work",
    "create_channels",
    "edit_wiki",
    "own_browsers",
    "own_computers",
    "pair_computers",
    "post",
    "read",
    "talk_to_agents",
    "upload_files",
  ]);
});

test("an owner creates a role and gives it to a member, whose permissions grow; people show who holds it", async () => {
  const { owner, ana, anaId, api, workspace } = await start();
  const created = await api(owner, "/roles", {
    json: { name: "Finance", color: "amber", permissions: ["view_usage", "manage_billing"] },
  });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  expect((await workspace(ana)).permissions).not.toContain("view_usage");

  const given = await api(owner, `/members/${anaId}/roles`, { method: "PUT", json: { roleIds: [id] } });
  expect(given.status).toBe(200);
  expect(await given.json()).toEqual({ roleIds: [id] });
  const after = await workspace(ana);
  expect(after).toMatchObject({ role: "member", rank: 1 });
  expect(after.permissions).toEqual(expect.arrayContaining(["view_usage", "manage_billing", "post", "read"]));
  // What the role gives, nothing more.
  expect(after.permissions).not.toContain("manage_roles");
  expect(after.permissions).not.toContain("administrator");

  const { people } = (await (await api(owner, "/people")).json()) as {
    people: { userId: string; roleIds: string[] }[];
  };
  expect(people.map((p) => (p.userId === anaId ? ["ana", p.roleIds] : ["owner", p.roleIds]))).toEqual([
    ["owner", []],
    ["ana", [id]],
  ]);
});

test("a member who may not manage roles nor people can't create a role or give one", async () => {
  const { ana, ownerId, api, roles } = await start();
  const refused = await api(ana, "/roles", { json: { name: "Mine", permissions: ["post"] } });
  expect(refused.status).toBe(403);
  const admin = (await roles(ana)).find((r) => r.permissions.includes("administrator"));
  const given = await api(ana, `/members/${ownerId}/roles`, { method: "PUT", json: { roleIds: [admin?.id] } });
  expect(given.status).toBe(403);
  expect((await roles(ana)).map((r) => r.name)).toEqual(["Admin", "everyone"]);
});

test("every member reads the roles; only who stands above a role may change it or give it", async () => {
  const { owner, ana, api, roles } = await start();
  const { id } = (await (
    await api(owner, "/roles", { json: { name: "Support", permissions: ["manage_routines"] } })
  ).json()) as { id: string };
  const asOwner = await roles(owner);
  expect(asOwner.map((r) => [r.kind, r.name])).toEqual([
    ["custom", "Admin"],
    ["custom", "Support"],
    ["everyone", "everyone"],
  ]);
  expect(asOwner.find((r) => r.id === id)).toMatchObject({ permissions: ["manage_routines"], editable: true });
  expect(asOwner.every((r) => r.editable)).toBe(true);
  // The base role is everyone's already: nobody gives it.
  expect(asOwner.map((r) => r.givable)).toEqual([true, true, false]);
  const asAna = await roles(ana);
  expect(asAna.find((r) => r.id === id)).toMatchObject({ name: "Support", editable: false, givable: false });
  expect(asAna.some((r) => r.editable || r.givable)).toBe(false);
});
