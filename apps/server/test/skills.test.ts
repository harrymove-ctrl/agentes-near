import { afterEach, expect, test } from "bun:test";
import { zip } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const skill = (name: string) => `---\nname: ${name}\ndescription: Use for ${name}.\n---\n# ${name}`;

/**
 * Fake GitHub: acme/skills' archive (two skills, deflated as codeload sends them) through codeload's redirect.
 * `limited`: every answer is GitHub limiting us.
 */
function fakeGithub() {
  const archive = zip([
    ["skills-main/skills/deploy/SKILL.md", skill("deploy")],
    ["skills-main/skills/review/SKILL.md", skill("review")],
  ]);
  const gh = { fetched: [] as string[], limited: false };
  const http = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    gh.fetched.push(url);
    if (gh.limited) return new Response("", { status: 429, headers: { "retry-after": "90" } });
    if (url.startsWith("https://github.com/acme/skills/archive/")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://codeload.github.com/acme/skills/zip/abc" },
      });
    }
    if (url === "https://codeload.github.com/acme/skills/zip/abc") return new Response(archive);
    return new Response("404: Not Found", { status: 404 });
  }) as typeof fetch;
  return Object.assign(gh, { http });
}

test("a link holding several skills answers with them, the picked ones install, a skill's folder installs at once", async () => {
  const gh = fakeGithub();
  t = await createTestServer({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const { orgId, agentId } = await seedOrg(b);
  const importing = (json: unknown) => b(`/api/app/organizations/${orgId}/skills/import`, { json });

  const listed = await importing({ url: "https://github.com/acme/skills" });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({
    choices: [
      { path: "skills/deploy", name: "deploy", description: "Use for deploy." },
      { path: "skills/review", name: "review", description: "Use for review." },
    ],
  });
  // From an agent's card (offer_install_skill): what installs goes on for that agent.
  const picked = await importing({
    url: "https://github.com/acme/skills",
    paths: ["skills/review"],
    forAgentId: agentId,
  });
  expect(picked.status).toBe(201);
  expect(((await picked.json()) as { skills: { name: string }[] }).skills.map((s) => s.name)).toEqual(["review"]);
  const its = (await (await b(`/api/app/organizations/${orgId}/agents/${agentId}/skills`)).json()) as {
    skills: { name: string; enabled: boolean }[];
  };
  expect(its.skills.map((s) => [s.name, s.enabled])).toEqual([["review", true]]);
  const one = await importing({ url: "https://github.com/acme/skills/tree/main/skills/deploy" });
  expect(one.status).toBe(201);
  expect(await one.json()).toMatchObject({ name: "deploy", version: 1, source: "url" });
  expect(gh.fetched.filter((u) => !/^https:\/\/(github|codeload\.github)\.com\//.test(u))).toEqual([]);

  // GitHub limiting this server: a 429 that says in how many minutes to try again.
  gh.limited = true;
  const limited = await importing({ url: "https://github.com/acme/skills" });
  expect(limited.status).toBe(429);
  expect(await limited.json()).toMatchObject({ error: { code: "github.limited", params: { count: 2 } } });
});

test("reading links is limited per person, 60 an hour, updating from a link included; a .zip isn't", async () => {
  const gh = fakeGithub();
  t = await createTestServer({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const { orgId } = await seedOrg(b);
  const importing = (json: unknown) => b(`/api/app/organizations/${orgId}/skills/import`, { json });
  for (let i = 0; i < 60; i++) expect((await importing({ url: "https://github.com/acme/secret" })).status).toBe(400);
  const limited = await importing({ url: "https://github.com/acme/skills" });
  expect(limited.status).toBe(429);
  expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
  expect(gh.fetched.filter((u) => u.includes("acme/skills"))).toEqual([]);

  const upload = await importing({ zipBase64: Buffer.from(zip([["SKILL.md", skill("enviada")]])).toString("base64") });
  expect(upload.status).toBe(201);
  const { id } = (await upload.json()) as { id: string };
  expect((await b(`/api/app/organizations/${orgId}/skills/${id}/reimport`, { json: {} })).status).toBe(429);
});

test("a private repository is read through the workspace's GitHub connection, never in an answer; members may not", async () => {
  const token = "ghp_fake_connection_token";
  const archive = zip([
    ["acme-private-abc/skills/deploy/SKILL.md", skill("deploy")],
    ["acme-private-abc/skills/review/SKILL.md", skill("review")],
  ]);
  const sent: { url: string; auth: string | null }[] = [];
  // github.com hides acme/private; the API's zipball answers only the connection's token.
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const auth = new Headers(init?.headers).get("authorization");
    sent.push({ url, auth });
    if (url === "https://api.github.com/repos/acme/private/zipball" && auth === `Bearer ${token}`) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://codeload.github.com/acme/private/z?t=1" },
      });
    }
    if (url === "https://codeload.github.com/acme/private/z?t=1") return new Response(archive);
    return new Response("404: Not Found", { status: 404 });
  }) as typeof fetch;
  t = await createTestServer({ http, resolveHost: async () => ["140.82.112.3"] });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const url = "https://github.com/acme/private";
  const importing = (b: typeof owner, json: unknown) => b(`/api/app/organizations/${orgId}/skills/import`, { json });

  const hidden = await importing(owner, { url });
  expect(hidden.status).toBe(400);
  expect(await hidden.json()).toMatchObject({
    error: { code: "github.repo_missing", params: { repo: "acme/private", connection: "none", app: false } },
  });

  const connected = await owner(`/api/app/organizations/${orgId}/connectors`, {
    json: { connector: "github", apiKey: token },
  });
  expect(connected.status).toBe(201);
  const listed = await importing(owner, { url, list: true });
  expect(listed.status).toBe(200);
  const body = await listed.text();
  expect(JSON.parse(body)).toEqual({
    choices: [
      { path: "skills/deploy", name: "deploy", description: "Use for deploy." },
      { path: "skills/review", name: "review", description: "Use for review." },
    ],
    via: "github",
  });
  expect(body).not.toContain("ghp_");
  const picked = await importing(owner, { url, paths: ["skills/deploy"] });
  expect(picked.status).toBe(201);
  const installed = await picked.text();
  expect(JSON.parse(installed)).toMatchObject({ skills: [{ name: "deploy", sourceVia: "github" }] });
  expect(installed).not.toContain("ghp_");
  expect(sent.filter((s) => s.auth && !s.url.startsWith("https://api.github.com/"))).toEqual([]);

  // Installing skills is what lets a person read through the workspace's GitHub.
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  const before = sent.length;
  expect((await importing(member, { url, list: true })).status).toBe(403);
  expect(sent.length).toBe(before);
});

test("updating from its link: text applies and is undone, a new script waits for approval, updating by itself is a switch", async () => {
  const repo: Record<string, string> = { "skills-main/deploy/SKILL.md": skill("deploy") };
  const http = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://github.com/acme/skills/archive/"))
      return new Response(null, {
        status: 302,
        headers: { location: "https://codeload.github.com/acme/skills/zip/abc" },
      });
    if (url === "https://codeload.github.com/acme/skills/zip/abc") return new Response(zip(Object.entries(repo)));
    return new Response("404: Not Found", { status: 404 });
  }) as typeof fetch;
  t = await createTestServer({ http, resolveHost: async () => ["140.82.112.3"] });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const at = (path: string) => `/api/app/organizations/${orgId}/skills${path}`;
  const made = await owner(at("/import"), { json: { url: "https://github.com/acme/skills/tree/main/deploy" } });
  const { id } = (await made.json()) as { id: string };

  expect(await (await owner(at(`/${id}/update`), { json: {} })).json()).toMatchObject({ status: "unchanged" });
  repo["skills-main/deploy/SKILL.md"] = `${skill("deploy")}\n\nMore.`;
  expect(await (await owner(at(`/${id}/update`), { json: {} })).json()).toMatchObject({
    status: "updated",
    skill: { version: 2, lastUpdate: { fromVersion: 1 } },
  });
  expect(await (await owner(at(`/${id}/update/undo`), { json: {} })).json()).toMatchObject({
    version: 3,
    lastUpdate: null,
  });

  repo["skills-main/deploy/run.sh"] = "echo hi";
  // The route of apps released before `/update`: the same gate.
  expect(await (await owner(at(`/${id}/reimport`), { json: {} })).json()).toMatchObject({
    version: 3,
    pendingUpdate: { scripts: ["run.sh"] },
  });
  expect(await (await owner(at(`/${id}/update`), { json: {} })).json()).toMatchObject({
    status: "waiting",
    scripts: ["run.sh"],
    skill: { version: 3, pendingUpdate: { scripts: ["run.sh"], dismissed: false } },
  });
  expect(await (await owner(at(`/${id}`))).json()).toMatchObject({
    pending: { files: [{ path: "run.sh", before: null, after: "echo hi", large: false }], base: null },
    changes: [],
  });
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect((await member(at(`/${id}/update/approve`), { json: {} })).status).toBe(403);
  expect((await member(at(`/${id}/update/reopen`), { json: {} })).status).toBe(403);
  expect((await member(at(`/${id}`), { method: "PATCH", json: { autoUpdate: true } })).status).toBe(403);
  // Kept out, then Desfazer: it waits again.
  expect(await (await owner(at(`/${id}/update/dismiss`), { json: {} })).json()).toMatchObject({
    pendingUpdate: { dismissed: true },
  });
  expect(await (await owner(at(`/${id}/update/reopen`), { json: {} })).json()).toMatchObject({
    pendingUpdate: { dismissed: false, dismissedAt: null },
  });
  expect(await (await owner(at(`/${id}/update/approve`), { json: {} })).json()).toMatchObject({
    status: "updated",
    skill: { version: 4, pendingUpdate: null, lastUpdate: { waited: true } },
  });
  expect(await (await owner(at(`/${id}`), { method: "PATCH", json: { autoUpdate: true } })).json()).toMatchObject({
    autoUpdate: true,
  });
});

test("Agentes melhoram as skills sozinhos: on by default, who manages agents turns it off, a skill's own switch wins", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  const settings = `/api/app/organizations/${orgId}/skill-settings`;

  expect(await (await member(settings)).json()).toEqual({ agentsImprove: true });
  expect((await member(settings, { method: "PUT", json: { agentsImprove: false } })).status).toBe(403);
  const off = await owner(settings, { method: "PUT", json: { agentsImprove: false } });
  expect([off.status, await off.json()]).toEqual([200, { agentsImprove: false }]);
  expect(await (await member(settings)).json()).toEqual({ agentsImprove: false });

  const created = await owner(`/api/app/organizations/${orgId}/skills`, {
    json: { name: "deploy", description: "Deploys.", body: "# deploy" },
  });
  const { id, agentsImprove } = (await created.json()) as { id: string; agentsImprove: boolean | null };
  expect(agentsImprove).toBeNull();
  const patch = (b: typeof owner, json: unknown) =>
    b(`/api/app/organizations/${orgId}/skills/${id}`, { method: "PATCH", json });
  expect((await patch(member, { agentsImprove: true })).status).toBe(403);
  const on = await patch(owner, { agentsImprove: true });
  expect(((await on.json()) as { agentsImprove: boolean; version: number }).agentsImprove).toBe(true);
  const back = await patch(owner, { agentsImprove: null });
  expect(await back.json()).toMatchObject({ agentsImprove: null, version: 1 });
});
