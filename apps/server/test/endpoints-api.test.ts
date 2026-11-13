import { afterEach, expect, test } from "bun:test";
import { customModelId } from "@agenteschat/providers";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

/** A gateway's model list, as `GET /v1/models` answers. */
const gatewayList = (async (url: string | URL | Request) =>
  String(url) === "https://gw.example/v1/models"
    ? new Response(JSON.stringify({ data: [{ id: "llama-4" }, { id: "qwen-3" }] }))
    : new Response("not found", { status: 404 })) as unknown as typeof fetch;

const resolveHost = async (host: string) => (host === "inside.example" ? ["10.0.0.7"] : ["93.184.216.34"]);

const endpoint = {
  style: "openai",
  baseURL: "https://gw.example/v1",
  models: [{ id: "llama-4", prices: { input: 1, output: 2 } }, { id: "qwen-3" }],
};

test("an endpoint: its list, saved with a test per model, its models in the pickers, admins only", async () => {
  t = await createTestServer({ http: gatewayList, resolveHost });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const listed = await api("/credentials/endpoint-models", {
    json: { style: "openai", baseURL: "https://gw.example/v1/", apiKey: "gw-key-1234567" },
  });
  expect(await listed.json()).toEqual({
    baseURL: "https://gw.example/v1",
    models: [{ id: "llama-4" }, { id: "qwen-3" }],
  });

  const created = await api("/credentials", {
    json: { provider: "custom", label: "OpenGateway", apiKey: "gw-key-1234567", endpoint },
  });
  expect(created.status).toBe(201);
  const key = (await created.json()) as {
    id: string;
    keyHint: string;
    endpoint: { models: { id: string; prices?: { input: number }; check?: string }[] };
    checks: { model: string; check: string }[];
  };
  expect(JSON.stringify(key)).not.toContain("gw-key-1234567");
  // The fake model answers in text: the endpoint works, without tools.
  expect(key.checks).toEqual([
    { model: "llama-4", check: "no_tools" },
    { model: "qwen-3", check: "no_tools" },
  ]);
  expect(key.endpoint.models[0]?.prices?.input).toBe(1);

  const models = (await (await owner("/api/app/models")).json()) as {
    models: { id: string; provider: string; endpoint?: { credentialId: string; name: string }; unpriced?: boolean }[];
  };
  const llama = models.models.find((m) => m.id === customModelId(key.id, "llama-4"));
  expect(llama).toMatchObject({ provider: "custom", endpoint: { credentialId: key.id, name: "OpenGateway" } });
  expect(llama?.unpriced).toBeUndefined();
  expect(models.models.find((m) => m.id === customModelId(key.id, "qwen-3"))?.unpriced).toBe(true);
  const orgModels = (await (await api("/models")).json()) as { models: { id: string; available: boolean }[] };
  expect(orgModels.models.find((m) => m.id === customModelId(key.id, "qwen-3"))?.available).toBe(true);

  const changed = await api(`/credentials/${key.id}/models`, {
    method: "PUT",
    json: { models: [{ id: "qwen-3", prices: { input: 0.5, output: 1 } }] },
  });
  expect(changed.status).toBe(200);
  expect(((await changed.json()) as { models: unknown[] }).models).toEqual([
    { id: "qwen-3", prices: { input: 0.5, output: 1, cacheRead: 0.5, cacheWrite: 0.5 }, check: "no_tools" },
  ]);

  // A member neither lists, adds nor changes one.
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const asMember = (path: string, init?: Parameters<typeof member>[1]) =>
    member(`/api/app/organizations/${orgId}${path}`, init);
  expect(
    (await asMember("/credentials/endpoint-models", { json: { style: "openai", baseURL: "https://gw.example/v1" } }))
      .status,
  ).toBe(403);
  expect(
    (await asMember("/credentials", { json: { provider: "custom", label: "x", apiKey: "", endpoint } })).status,
  ).toBe(403);
  expect((await asMember(`/credentials/${key.id}/models`, { method: "PUT", json: { models: [] } })).status).toBe(403);
});

test("on the Cloud's rules: http, internal and private addresses are refused", async () => {
  t = await createTestServer({ http: gatewayList, resolveHost, env: { MODEL_ENDPOINTS_PRIVATE: "false" } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  for (const baseURL of [
    "http://gw.example/v1",
    "https://localhost:11434/v1",
    "https://inside.example/v1",
    "https://169.254.169.254/v1",
  ]) {
    const listed = await owner(`/api/app/organizations/${orgId}/credentials/endpoint-models`, {
      json: { style: "openai", baseURL },
    });
    expect(listed.status).toBe(400);
    const saved = await owner(`/api/app/organizations/${orgId}/credentials`, {
      json: { provider: "custom", label: "x", apiKey: "k-12345678", endpoint: { ...endpoint, baseURL } },
    });
    expect(saved.status).toBe(400);
  }
});
