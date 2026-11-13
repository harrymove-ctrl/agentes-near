import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { type Browser, browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

interface Summary {
  id: string;
  onboarding?: { step: string; generalChannelId: string };
}
interface Created {
  organization: { id: string; name: string };
  generalChannelId: string;
  rightHandId: string | null;
  me?: { organizations: Summary[] };
}

const rightHandOf = async (orgId: string) =>
  (
    await t.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.builtin, "right_hand")))
  )[0]?.id ?? null;
const orgsOf = async (b: Browser) =>
  ((await (await b("/api/app/me")).json()) as { organizations: Summary[] }).organizations;
const create = (b: Browser, name: string) => b("/api/app/organizations", { json: { name } });
const save = (b: Browser, orgId: string, json: { step?: string; finished?: true }) =>
  b(`/api/app/organizations/${orgId}/onboarding`, { method: "PATCH", json });

test("a new workspace is its owner's to set up: /me says where it resumes, to them only, until it's finished", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const made = await create(owner, "Acme");
  expect(made.status).toBe(201);
  const { organization, generalChannelId } = (await made.json()) as Created;
  // Creating it passed the first step.
  expect(await orgsOf(owner)).toEqual([
    expect.objectContaining({ id: organization.id, onboarding: { step: "context", generalChannelId } }),
  ]);

  // Someone invited never goes through it, and can't save it.
  const ana = await joinByInvitation(t, owner, organization.id, "ana@example.com", { role: "admin" });
  expect((await orgsOf(ana))[0]).not.toHaveProperty("onboarding");
  expect((await save(ana, organization.id, { step: "team" })).status).toBe(403);
  expect((await save(ana, organization.id, { finished: true })).status).toBe(403);

  // Only forward: an earlier step changes nothing.
  const at = async (json: { step?: string; finished?: true }) => (await save(owner, organization.id, json)).json();
  expect(await at({ step: "agents" })).toEqual({ step: "agents", finished: false });
  expect(await at({ step: "import" })).toEqual({ step: "agents", finished: false });
  expect((await orgsOf(owner))[0]?.onboarding?.step).toBe("agents");
  expect((await save(owner, organization.id, { step: "elsewhere" })).status).toBe(400);

  // Finished, for good: it says where the workspace opens, and /me as it is now.
  const lodi = await rightHandOf(organization.id);
  expect(await at({ finished: true })).toEqual({
    step: "done",
    finished: true,
    rightHandId: lodi,
    me: await (await owner("/api/app/me")).json(),
  });
  expect((await orgsOf(owner))[0]).not.toHaveProperty("onboarding");
  expect(await at({ step: "team" })).toEqual({ step: "done", finished: true });
});

test("making another while one is being set up gives that one back: a stale tab, two presses at once", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const first = (await (await create(owner, "Acme")).json()) as Created;
  await save(owner, first.organization.id, { step: "computer" });
  // The stale tab's step 1 gets the workspace as it is, its progress kept.
  const stale = await create(owner, "Acme again");
  expect(stale.status).toBe(200);
  expect(await stale.json()).toEqual({
    organization: expect.objectContaining({ id: first.organization.id, name: "Acme", role: "owner" }),
    generalChannelId: first.generalChannelId,
    rightHandId: first.rightHandId,
    me: expect.objectContaining({ organizations: [expect.objectContaining({ id: first.organization.id })] }),
  });
  expect(await orgsOf(owner)).toEqual([
    expect.objectContaining({ id: first.organization.id, onboarding: expect.objectContaining({ step: "computer" }) }),
  ]);

  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  const twice = await Promise.all([create(bia, "Beta"), create(bia, "Beta")]);
  expect(twice.map((r) => r.status).sort()).toEqual([200, 201]);
  const ids = await Promise.all(twice.map(async (r) => ((await r.json()) as Created).organization.id));
  expect(new Set(ids).size).toBe(1);
  expect((await orgsOf(bia)).map((o) => o.id)).toEqual(ids.slice(0, 1));
  // Suspended, it shows as suspended, not as its onboarding.
  await t.db
    .update(schema.organizations)
    .set({ standing: "suspended" })
    .where(eq(schema.organizations.id, ids[0] ?? ""));
  expect((await orgsOf(bia))[0]).not.toHaveProperty("onboarding");

  // Once it's set up, the next one is a new workspace.
  await save(owner, first.organization.id, { finished: true });
  const next = await create(owner, "Labs");
  expect(next.status).toBe(201);
  expect(((await next.json()) as Created).organization.id).not.toBe(first.organization.id);
});

test("one call makes it with both zones, finished, and answers where it opens and /me as it is now (#1)", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const made = await owner("/api/app/organizations", {
    json: { name: "Acme", timezone: "America/Sao_Paulo", memberTimezone: "Europe/Lisbon", finished: true },
  });
  expect(made.status).toBe(201);
  const body = (await made.json()) as Created;
  const orgId = body.organization.id;
  expect(body.rightHandId).toBe(await rightHandOf(orgId));
  expect(body.rightHandId).not.toBeNull();
  // The app opens it with this /me, never asking again: the same body as GET /me, the onboarding over.
  expect(body.me).toEqual((await (await owner("/api/app/me")).json()) as Created["me"]);
  expect(body.me?.organizations.find((o) => o.id === orgId)).not.toHaveProperty("onboarding");
  const settings = (await (await owner(`/api/app/organizations/${orgId}/settings`)).json()) as { timezone: string };
  expect(settings.timezone).toBe("America/Sao_Paulo");
  const { people } = (await (await owner(`/api/app/organizations/${orgId}/people`)).json()) as {
    people: { timezone: string | null }[];
  };
  expect(people[0]?.timezone).toBe("Europe/Lisbon");

  // A person's zone the server doesn't know is left out: the workspace is made all the same, on the server's default.
  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  const odd = await bia("/api/app/organizations", {
    json: { name: "Beta", memberTimezone: "Mars/Olympus", finished: true },
  });
  expect(odd.status).toBe(201);
  const beta = (await odd.json()) as Created;
  const { people: theirs } = (await (await bia(`/api/app/organizations/${beta.organization.id}/people`)).json()) as {
    people: { timezone: string | null }[];
  };
  expect(theirs[0]?.timezone).not.toBe("Mars/Olympus");
});

test("a second press while one is being set up finishes that one, with the zones it sends", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const first = (await (await create(owner, "Acme")).json()) as Created;
  const again = await owner("/api/app/organizations", {
    json: { name: "Acme", timezone: "Asia/Tokyo", memberTimezone: "Asia/Tokyo", finished: true },
  });
  expect(again.status).toBe(200);
  const body = (await again.json()) as Created;
  expect(body.organization.id).toBe(first.organization.id);
  expect(body.me?.organizations.find((o) => o.id === first.organization.id)).not.toHaveProperty("onboarding");
  const settings = (await (await owner(`/api/app/organizations/${first.organization.id}/settings`)).json()) as {
    timezone: string;
  };
  expect(settings.timezone).toBe("Asia/Tokyo");
});
