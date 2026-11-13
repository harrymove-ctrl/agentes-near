import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  ALL_TOOLS,
  BROWSER_SCOPE,
  ConflictError,
  DESKTOP_SCOPE,
  ForbiddenError,
  finishHandoff,
  grantScopes,
  markPageRead,
  openHandoffOf,
  requirePageRead,
  startTakeover,
  waitIfPersonInControl,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });

async function start(scopes: string[]) {
  f = await setup({ machines: true });
  const machine = await pairMachine(deps(), f.owner.id, f.org.id, { name: "MacBook" });
  await f.db.update(schema.agents).set({ machineId: machine.machineId }).where(eq(schema.agents.id, f.agent.id));
  await grantScopes(
    f.db,
    f.org.id,
    f.agent.id,
    scopes.map((scope) => ({ connectionId: null, scope })),
  );
}

test('people drive the desktop only while the agent may use it, and "all tools" never covers it', async () => {
  await start([BROWSER_SCOPE, ALL_TOOLS]);
  await expect(startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop")).rejects.toBeInstanceOf(
    ForbiddenError,
  );
});

test("a desktop handoff never holds the browser: one open handoff per screen", async () => {
  await start([BROWSER_SCOPE, DESKTOP_SCOPE]);
  const bia = await addMember(f.db, f.org.id, "admin", "bia");
  // Each agent its own OS user: admins may drive the computer too, so Bia could take the desktop.
  await f.db.update(schema.machines).set({ executors: { mode: "system" } });
  const desktop = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
  expect(desktop).toMatchObject({ screen: "desktop", status: "active", controllerUserId: f.owner.id });
  expect(await openHandoffOf(f.db, f.org.id, f.agent.id)).toBeNull();
  // The agent's browser tools go on while a person holds its desktop.
  expect(await waitIfPersonInControl(f.db, { orgId: f.org.id, agentId: f.agent.id, runId: "none" })).toBeNull();
  await expect(startTakeover(deps(), bia.id, f.org.id, f.agent.id, null, "desktop")).rejects.toBeInstanceOf(
    ConflictError,
  );
  expect(await startTakeover(deps(), bia.id, f.org.id, f.agent.id)).toMatchObject({
    screen: "browser",
    controllerUserId: bia.id,
  });
  expect((await openHandoffOf(f.db, f.org.id, f.agent.id, "desktop"))?.id).toBe(desktop.id);
});

test("after a person had the desktop, only the desktop asks to be read again", async () => {
  await start([BROWSER_SCOPE, DESKTOP_SCOPE]);
  const ctx = { orgId: f.org.id, agentId: f.agent.id };
  const t = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
  await finishHandoff(deps(), f.owner.id, f.org.id, t.id, { result: "done" });
  expect(await requirePageRead(f.db, ctx)).toBeNull();
  expect((await requirePageRead(f.db, ctx, "desktop"))?.content).toContain(
    "Read the screen again first (a person changed it): call desktop_read",
  );
  await markPageRead(f.db, ctx);
  expect(await requirePageRead(f.db, ctx, "desktop")).not.toBeNull();
  await markPageRead(f.db, ctx, "desktop");
  expect(await requirePageRead(f.db, ctx, "desktop")).toBeNull();
});
