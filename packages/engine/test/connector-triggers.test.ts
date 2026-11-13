import { afterEach, expect, test } from "bun:test";
import { createMemoryRateLimiter } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type ConnectorTriggerDeps,
  createdId,
  createRoutine,
  deleteRoutine,
  emailPasses,
  getRoutineView,
  type McpSession,
  newRoutineHookAddress,
  newRoutineHookSecret,
  type RoutineHookDeps,
  receiveRoutineHook,
  setRoutineActive,
  updateRoutine,
} from "../src";
import { type Fixture, SECRET, setup } from "./fixtures";
import { routineDeps } from "./routine-fixtures";

/** ADR 0130: a connector's event as a routine trigger (MillionSend's received email). */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const HOOKS = { publicUrl: "https://agentes.test", secret: SECRET };
const INBOX = "0193eeee-0000-4000-8000-000000000001";

/** A MillionSend connection, the agent allowed to read it, and a fake server that keeps the webhooks it is given. */
async function millionSend(read = true) {
  const [connection] = await f.db
    .insert(schema.connectorConnections)
    .values({
      orgId: f.org.id,
      connector: "mcp_millionsend",
      label: "MillionSend",
      serverUrl: "https://api.millionsend.com/mcp",
      authType: "none",
      toolPrefix: "millionsend",
    })
    .returning();
  if (!connection) throw new Error("no connection");
  if (read) {
    await f.db.insert(schema.agentScopes).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      connectionId: connection.id,
      scope: `custom:${connection.id}:read`,
    });
  }
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let next = 0;
  const session: McpSession = {
    listTools: async () => [],
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "create_webhook") {
        next += 1;
        return { content: JSON.stringify({ id: `0193ffff-0000-4000-8000-00000000000${next}` }), isError: false };
      }
      return { content: "{}", isError: false };
    },
    close: async () => {},
  };
  const connectors: ConnectorTriggerDeps = {
    db: f.db,
    keyWrappers: [f.keyWrapper],
    publicUrl: HOOKS.publicUrl,
    connect: async () => session,
  };
  return { connection, calls, deps: { ...routineDeps(f), hooks: HOOKS, connectors } };
}

const hookDeps = (): RoutineHookDeps => ({
  db: f.db,
  hooks: HOOKS,
  keyWrappers: [f.keyWrapper],
  rateLimiter: createMemoryRateLimiter(),
});

const post = (token: string, body: unknown, id: string) =>
  receiveRoutineHook(hookDeps(), {
    token,
    headers: new Headers({ "content-type": "application/json", "webhook-id": id }),
    read: async () => new TextEncoder().encode(JSON.stringify(body)),
  });

const received = (from: string, subject: string, to = "vendas@loja.example") => ({
  type: "inbox.email.received",
  data: {
    source: "system",
    inbox_id: INBOX,
    thread_id: "0193eeee-0000-4000-8000-0000000000a1",
    email_id: "0193eeee-0000-4000-8000-0000000000b1",
    thread: { object: "inbox_thread", id: "0193eeee-0000-4000-8000-0000000000a1", subject, folder: "inbox" },
    email: { id: "0193eeee-0000-4000-8000-0000000000b1", direction: "inbound", from, to: [to], cc: [], subject },
  },
});

const runsOf = (routineId: string) =>
  f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routineId));

test("a routine on MillionSend's received email: its address registered for that inbox, filtered, deduplicated, and taken back", async () => {
  f = await setup();
  const { connection, calls, deps } = await millionSend();
  const routine = await createRoutine(deps, f.owner.id, f.org.id, {
    name: "Pedidos por e-mail",
    agentId: f.agent.id,
    prompt: "Responda o pedido novo.",
    target: { type: "channel", channelId: f.general.id },
    trigger: {
      type: "connector",
      connectionId: connection.id,
      event: "millionsend.email.received",
      inboxId: INBOX,
      filter: { to: "Vendas@loja.example", from: ["@Cliente.example"], subject: "pedido" },
    },
  });
  expect(routine.trigger).toEqual({
    type: "connector",
    connectionId: connection.id,
    event: "millionsend.email.received",
    inboxId: INBOX,
    filter: { to: "vendas@loja.example", from: ["@cliente.example"], subject: "pedido" },
    status: "active",
    lastError: null,
  });
  const created = calls.find((c) => c.name === "create_webhook");
  expect(created?.args.events).toEqual(["inbox.email.received"]);
  expect(created?.args.inbox_ids).toEqual([INBOX]);
  const endpoint = String(created?.args.endpoint);
  expect(endpoint.startsWith(`${HOOKS.publicUrl}/api/hooks/`)).toBe(true);
  const token = endpoint.split("/api/hooks/")[1] ?? "";

  // Another inbox, another sender, another subject, another event: nothing runs.
  expect(await post(token, received("ana@cliente.example", "Pedido 1", "suporte@loja.example"), "msg_0")).toMatchObject(
    {
      runId: null,
    },
  );
  expect(await post(token, received("Ana <ana@outro.example>", "Pedido 12"), "msg_1")).toMatchObject({ runId: null });
  expect(await post(token, received("ana@cliente.example", "Oi"), "msg_2")).toMatchObject({ runId: null });
  expect(await post(token, { type: "inbox.email.sent", data: {} }, "msg_3")).toMatchObject({ runId: null });
  expect(await runsOf(routine.id)).toEqual([]);
  // Its email runs it once, however often MillionSend delivers it.
  const first = await post(token, received("Ana <ana@cliente.example>", "Novo pedido 12"), "msg_4");
  expect(first).toMatchObject({ status: 202, duplicate: false });
  expect(await post(token, received("Ana <ana@cliente.example>", "Novo pedido 12"), "msg_4")).toMatchObject({
    duplicate: true,
  });
  expect((await runsOf(routine.id)).length).toBe(1);

  // Paused: MillionSend's webhook goes; resumed: a new one.
  await setRoutineActive(deps, f.owner.id, f.org.id, routine.id, false);
  expect(calls.filter((c) => c.name === "delete_webhook").map((c) => c.args.id)).toEqual([
    "0193ffff-0000-4000-8000-000000000001",
  ]);
  await setRoutineActive(deps, f.owner.id, f.org.id, routine.id, true);
  expect(calls.filter((c) => c.name === "create_webhook").length).toBe(2);

  // A new filter registers again; deleting the routine takes the webhook back.
  await updateRoutine(deps, f.owner.id, f.org.id, routine.id, {
    trigger: { type: "connector", connectionId: connection.id, event: "millionsend.email.received" },
  });
  const view = await getRoutineView(f.db, f.owner.id, f.org.id, routine.id, HOOKS);
  expect(view.trigger).toMatchObject({ type: "connector", inboxId: null, filter: {} });
  expect(calls.filter((c) => c.name === "create_webhook").at(-1)?.args.inbox_ids).toBeNull();
  await deleteRoutine(deps, f.owner.id, f.org.id, routine.id);
  expect(calls.filter((c) => c.name === "delete_webhook").map((c) => c.args.id)).toEqual([
    "0193ffff-0000-4000-8000-000000000001",
    "0193ffff-0000-4000-8000-000000000002",
    "0193ffff-0000-4000-8000-000000000003",
  ]);
});

test("a GET-only webhook switched to a connector answers the provider's POSTs again", async () => {
  f = await setup();
  const { connection, calls, deps } = await millionSend();
  const routine = await createRoutine(deps, f.owner.id, f.org.id, {
    name: "Pedidos",
    agentId: f.agent.id,
    prompt: "Responda o pedido novo.",
    target: { type: "channel", channelId: f.general.id },
    trigger: { type: "webhook", methods: ["GET"] },
  });
  await updateRoutine(deps, f.owner.id, f.org.id, routine.id, {
    trigger: { type: "connector", connectionId: connection.id, event: "millionsend.email.received" },
  });
  const endpoint = String(calls.find((c) => c.name === "create_webhook")?.args.endpoint);
  const token = endpoint.split("/api/hooks/")[1] ?? "";
  expect(await post(token, received("ana@cliente.example", "Pedido 7"), "msg_get")).toMatchObject({
    status: 202,
    duplicate: false,
  });
  expect((await runsOf(routine.id)).length).toBe(1);
});

test("only an agent the connection's owner let read it may wait on its events", async () => {
  f = await setup();
  const { connection, calls, deps } = await millionSend(false);
  const made = await createRoutine(deps, f.owner.id, f.org.id, {
    name: "E-mail",
    agentId: f.agent.id,
    prompt: "Leia.",
    target: { type: "channel", channelId: f.general.id },
    trigger: { type: "connector", connectionId: connection.id, event: "millionsend.email.received" },
  }).catch((e: unknown) => e);
  expect((made as { code?: string }).code).toBe("routine.connector_agent_cannot_read");
  expect(calls).toEqual([]);
});

test("an email that arrives after the owner took the agent's access, or the connection, runs nothing", async () => {
  f = await setup();
  const { connection, calls, deps } = await millionSend();
  const routine = await createRoutine(deps, f.owner.id, f.org.id, {
    name: "E-mail",
    agentId: f.agent.id,
    prompt: "Leia.",
    target: { type: "channel", channelId: f.general.id },
    trigger: { type: "connector", connectionId: connection.id, event: "millionsend.email.received" },
  });
  const endpoint = String(calls.find((c) => c.name === "create_webhook")?.args.endpoint);
  const token = endpoint.split("/api/hooks/")[1] ?? "";
  // Its address and signing are MillionSend's webhook: neither changes by hand.
  const ref = { id: routine.id, orgId: f.org.id, name: routine.name };
  for (const change of [newRoutineHookAddress, newRoutineHookSecret]) {
    const refused = await change(hookDeps(), f.owner.id, ref).catch((e: unknown) => e);
    expect((refused as { code?: string }).code).toBe("routine.connector_hook");
  }
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.connectionId, connection.id));
  expect(await post(token, received("ana@cliente.example", "Oi"), "msg_a")).toMatchObject({ runId: null });
  await f.db.insert(schema.agentScopes).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    connectionId: connection.id,
    scope: `custom:${connection.id}:read`,
  });
  await f.db
    .update(schema.connectorConnections)
    .set({ revokedAt: new Date() })
    .where(eq(schema.connectorConnections.id, connection.id));
  expect(await post(token, received("ana@cliente.example", "Oi"), "msg_b")).toMatchObject({ runId: null });
  expect(await runsOf(routine.id)).toEqual([]);
});

test("the filter reads addresses as payloads write them; a created id from JSON or text", () => {
  expect(emailPasses({ from: "Ana <ANA@x.example>" }, { from: ["ana@x.example"] })).toBe(true);
  expect(emailPasses({ from: { address: "bo@y.example" } }, { from: ["@y.example"] })).toBe(true);
  expect(emailPasses({}, { from: ["@y.example"] })).toBe(false);
  expect(emailPasses({ subject: "Pedido novo" }, { subject: "PEDIDO" })).toBe(true);
  expect(emailPasses({ to: "Loja <Vendas@loja.example>, b@c.example" }, { to: "vendas@loja.example" })).toBe(true);
  expect(emailPasses({ to: [] }, { to: "vendas@loja.example" })).toBe(false);
  expect(emailPasses({}, {})).toBe(true);
  expect(createdId('{"id":"wh_1"}')).toBe("wh_1");
  expect(createdId("Created webhook 0193ffff-0000-4000-8000-000000000009 for 1 inbox")).toBe(
    "0193ffff-0000-4000-8000-000000000009",
  );
  expect(createdId("done")).toBeNull();
});
