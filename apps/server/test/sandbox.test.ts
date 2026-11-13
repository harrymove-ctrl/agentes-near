import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

test("Run code settings, the agent's computer, and the access tree shows 'Run code'", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  // What holds on every computer: the switch, a command's default timeout and approval (ADR 0077).
  expect(await (await api("/sandbox-settings")).json()).toEqual({
    enabled: true,
    execTimeoutSeconds: 60,
    maxTimeoutSeconds: 600,
    requireApproval: false,
  });
  const put = await api("/sandbox-settings", { method: "PUT", json: { requireApproval: true } });
  expect(await put.json()).toEqual({
    enabled: true,
    execTimeoutSeconds: 60,
    maxTimeoutSeconds: 600,
    requireApproval: true,
  });
  expect((await api("/sandbox-settings", { method: "PUT", json: { execTimeoutSeconds: 1 } })).status).toBe(400);
  // No computer chosen yet; turning one on, off or deleting it went with the cloud computer.
  expect(await (await api(`/agents/${agentId}/computer`)).json()).toEqual({ target: { kind: "none" } });
  expect((await api(`/agents/${agentId}/computer/start`, { json: {} })).status).toBe(404);

  const tree = (await (await api(`/agents/${agentId}/access`)).json()) as {
    builtins: { scope: string; label: string; state: string; tools: { name: string }[] }[];
  };
  const sandbox = tree.builtins.find((b) => b.scope === "sandbox:run");
  // On by default for every agent.
  expect(sandbox).toMatchObject({ label: "Run code", state: "granted" });
  expect(sandbox?.tools.map((x) => x.name)).toContain("run_code");
  expect(sandbox?.tools.map((x) => x.name)).not.toContain("computer_start");
});

test("the agent's browser: unavailable without a connected computer; its sites are validated and saved", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  expect(await (await api(`/agents/${agentId}/browser`)).json()).toEqual({
    allowedDomains: null,
    available: false,
    reason: "no_machine",
    detail: null,
    machine: null,
    profileId: null,
  });
  const bad = await api(`/agents/${agentId}/browser`, { method: "PUT", json: { allowedDomains: ["not a site"] } });
  expect(bad.status).toBe(400);
  const put = await api(`/agents/${agentId}/browser`, {
    method: "PUT",
    json: { allowedDomains: ["https://Shop.Example.com/login", "*.stripe.com"] },
  });
  expect(await put.json()).toMatchObject({ allowedDomains: ["shop.example.com", "*.stripe.com"] });
  const cleared = await api(`/agents/${agentId}/browser`, { method: "PUT", json: { allowedDomains: null } });
  expect(await cleared.json()).toMatchObject({ allowedDomains: null });
});
