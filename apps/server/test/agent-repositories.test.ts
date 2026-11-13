import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

/** GitHub as the org's connection sees it (an API key; no app configured). */
const http = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.startsWith("https://api.github.com/user/repos")) {
    return Response.json([
      { full_name: "acme/app", name: "app", private: true, owner: { login: "acme", type: "Organization" } },
    ]);
  }
  return new Response("unexpected", { status: 500 });
}) as unknown as typeof fetch;

test("an agent's repositories: read, replace in order, refuse what isn't a repository; the org's listing", async () => {
  t = await createTestServer({ http });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const path = `/api/app/organizations/${orgId}/agents/${agentId}/repositories`;

  expect(await (await owner(path)).json()).toEqual({ repositories: [] });
  const saved = await owner(path, {
    method: "PUT",
    json: { repositories: ["acme/app", "https://github.com/walt/notes"] },
  });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ repositories: ["acme/app", "walt/notes"] });
  expect(await (await owner(path)).json()).toEqual({ repositories: ["acme/app", "walt/notes"] });
  expect((await owner(path, { method: "PUT", json: { repositories: ["not a repo"] } })).status).toBe(400);

  const created = await owner(`/api/app/organizations/${orgId}/connectors`, {
    json: { connector: "github", apiKey: "ghp_secret_123456" },
  });
  expect(created.status).toBe(201);
  const listing = await (await owner(`/api/app/organizations/${orgId}/github/repositories`)).json();
  expect(listing).toEqual({
    connected: true,
    accounts: [
      {
        login: "acme",
        type: "Organization",
        repositories: [{ fullName: "acme/app", owner: "acme", name: "app", private: true, updatedAt: null }],
      },
    ],
    truncated: false,
  });
  expect(JSON.stringify(listing)).not.toContain("ghp_");
});

test("where an agent merges without asking: read and replace; exact repositories only; its owner or an admin", async () => {
  t = await createTestServer({ http });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const path = `/api/app/organizations/${orgId}/agents/${agentId}/merge-repositories`;

  expect(await (await owner(path)).json()).toEqual({ repositories: [] });
  const saved = await owner(path, { method: "PUT", json: { repositories: ["acme/app"] } });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ repositories: ["acme/app"] });
  expect(await (await owner(path)).json()).toEqual({ repositories: ["acme/app"] });
  expect((await owner(path, { method: "PUT", json: { repositories: ["acme/*"] } })).status).toBe(400);
  expect((await browser(t)(path)).status).toBe(401);
});
