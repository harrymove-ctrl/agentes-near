import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { browser, createTestServer, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(async () => {
  await t.close();
});

test("each screen has its own handoff routes, and they act on that screen alone", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const org = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${org.orgId}${path}`, init);
  const machine = await pairComputer(t, api, { os: "darwin", arch: "arm64", hostname: "mac", version: "0.3.0" });
  await t.db.update(schema.agents).set({ machineId: machine.machineId }).where(eq(schema.agents.id, org.agentId));
  await t.db
    .delete(schema.agentScopes)
    .where(and(eq(schema.agentScopes.agentId, org.agentId), eq(schema.agentScopes.scope, "desktop:use")));

  // The owner may drive it (watchers behind a run may only watch: ADR 0040).
  expect(await (await api(`/agents/${org.agentId}/browser/control`)).json()).toEqual({ canControl: true });
  const taken = await (await api(`/agents/${org.agentId}/browser/takeover`, { json: {} })).json();
  expect(taken).toMatchObject({ screen: "browser", status: "active" });
  // The browser's take over isn't the desktop's, and the agent may not use a desktop.
  expect(await (await api(`/agents/${org.agentId}/desktop/handoff`)).json()).toEqual({ handoff: null });
  expect((await api(`/agents/${org.agentId}/desktop/takeover`, { json: {} })).status).toBe(403);
});
