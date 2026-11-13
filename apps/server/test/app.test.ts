import { expect, test } from "bun:test";
import { MachineRequestError } from "@agenteschat/engine";
import type { ModuleContext } from "@agenteschat/modules";
import { createApp } from "../src/app";
import { workerHealth } from "../src/routes/health";
import { createTestServer } from "./harness";

test("health reports database state", async () => {
  const ok = createApp({
    edition: "selfhost",
    version: "1.2.3",
    modules: [{ name: "x" }],
    pingDatabase: async () => {},
  });
  const res = await ok.request("/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    status: "ok",
    version: "1.2.3",
    edition: "selfhost",
    database: "ok",
    modules: ["x"],
  });
  const down = createApp({
    edition: "selfhost",
    version: "1",
    modules: [],
    pingDatabase: async () => Promise.reject(new Error("x")),
  });
  expect((await down.request("/api/health")).status).toBe(503);
});

test("health answers 503 once the server is shutting down, so a proxy stops sending requests first", async () => {
  let draining = false;
  const app = createApp({
    edition: "selfhost",
    version: "1",
    modules: [],
    pingDatabase: async () => {},
    draining: () => draining,
  });
  expect((await app.request("/api/health")).status).toBe(200);
  draining = true;
  const res = await app.request("/api/health");
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ status: "draining", database: "ok" });
});

test("a worker process answers its health check alone, as the app does, so its container turns healthy", async () => {
  let up = true;
  let draining = false;
  const fetch = workerHealth({
    version: "1.2.3",
    edition: "selfhost",
    modules: [],
    pingDatabase: async () => (up ? undefined : Promise.reject(new Error("x"))),
    draining: () => draining,
  });
  const health = () => fetch(new Request("http://localhost:3000/api/health"));
  const res = await health();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    status: "ok",
    version: "1.2.3",
    edition: "selfhost",
    database: "ok",
    modules: [],
  });
  expect((await fetch(new Request("http://localhost:3000/api/app/me"))).status).toBe(404);
  expect((await fetch(new Request("http://localhost:3000/"))).status).toBe(404);
  up = false;
  expect((await health()).status).toBe(503);
  up = true;
  draining = true;
  expect((await health()).status).toBe(503);
});

test("a computer's error is a 503 with its code: behind Cloudflare an origin's 502 never reaches the app", async () => {
  const app = createApp({
    edition: "selfhost",
    version: "1",
    pingDatabase: async () => {},
    moduleContext: {} as ModuleContext,
    modules: [
      {
        name: "computer",
        registerRoutes: (api) =>
          api.get("/computer/run", () => {
            throw new MachineRequestError("timeout", "The computer didn't answer in time");
          }),
      },
    ],
  });
  const res = await app.request("/api/computer/run");
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({
    error: { code: "machine.timeout", message: "The computer didn't answer in time" },
  });
});

test("unknown API routes return the JSON error shape", async () => {
  const app = createApp({ edition: "selfhost", version: "1", modules: [], pingDatabase: async () => {} });
  const res = await app.request("/api/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: "not_found", message: "Route not found" } });
});

test("modules can register routes", async () => {
  const t = await createTestServer();
  const app = createApp({
    edition: "cloud",
    version: "1",
    pingDatabase: async () => {},
    modules: [
      { name: "cloud-billing", registerRoutes: (api) => api.get("/billing/ping", (c) => c.json({ pong: true })) },
    ],
    moduleContext: { config: t.config, db: t.db, edition: "cloud", version: "1", adapters: t.adapters },
  });
  expect(await (await app.request("/api/billing/ping")).json()).toEqual({ pong: true });
  await t.close();
});

test("the OpenAPI document lists the app API", async () => {
  const t = await createTestServer();
  const doc = (await (await t.app.request("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
  for (const path of [
    "/app/me",
    "/app/organizations/{orgId}/agents",
    "/app/organizations/{orgId}/channels/{channelId}/messages",
    "/app/organizations/{orgId}/devices",
    "/app/organizations/{orgId}/devices/requests/{requestId}/approve",
  ]) {
    expect(Object.keys(doc.paths)).toContain(path);
  }
  await t.close();
});

test("the API explorer is served off production only; the OpenAPI document stays", async () => {
  const dev = await createTestServer();
  expect((await dev.app.request("/api/reference")).status).toBe(200);
  await dev.close();
  const prod = await createTestServer({ env: { NODE_ENV: "production" } });
  expect((await prod.app.request("/api/reference")).status).toBe(404);
  expect((await prod.app.request("/api/openapi.json")).status).toBe(200);
  await prod.close();
});
