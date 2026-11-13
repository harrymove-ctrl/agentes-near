import { afterEach, describe, expect, test } from "bun:test";
import { DESKTOP_PROTOCOL, type MachineRequest } from "@agenteschat/adapters";
import { and, eq, inArray, schema, sql } from "@agenteschat/db";
import {
  ALL_TOOLS,
  BUILTIN_SCOPES,
  createAgent,
  DEFAULT_AGENT_SCOPES,
  DESKTOP_SCOPE,
  getAgentAccess,
  grantKey,
  grantScopes,
  isNewWork,
  type MachineHub,
  missingPermissions,
  NEW_AGENT_DEFAULTS,
  NOT_IN_ALL,
  type RoutineAccess,
  type RunAuthority,
  setAgentScopes,
  toolAccess,
  toolKind,
  toolPolicy,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const scopesOf = async (agentId: string) =>
  (
    await f.db
      .select({ scope: schema.agentScopes.scope })
      .from(schema.agentScopes)
      .where(eq(schema.agentScopes.agentId, agentId))
  ).map((r) => r.scope);

const newAgent = (handle: string) =>
  createAgent(f.db, f.owner.id, f.org.id, { name: handle, handle }, NEW_AGENT_DEFAULTS);

const drop = (agentId: string, scopes: string[]) =>
  f.db
    .delete(schema.agentScopes)
    .where(and(eq(schema.agentScopes.agentId, agentId), inArray(schema.agentScopes.scope, scopes)));

test("new agents get desktop:use; 'all tools' never covers it; the access tree keeps it", async () => {
  f = await setup();
  expect(DEFAULT_AGENT_SCOPES).toContain(DESKTOP_SCOPE);
  expect(BUILTIN_SCOPES[DESKTOP_SCOPE]?.description).toContain("Run code");
  expect(NOT_IN_ALL.has(DESKTOP_SCOPE)).toBe(true);
  const ops = await newAgent("ops");
  expect(await scopesOf(ops.id)).toEqual(expect.arrayContaining(["sandbox:run", "browser:use", DESKTOP_SCOPE]));
  const tree = await getAgentAccess(f.db, f.owner.id, f.org.id, ops.id);
  expect(tree.builtins.find((b) => b.scope === DESKTOP_SCOPE)?.state).toBe("granted");

  // Only "all tools": the desktop stays off, and the agent may still ask for it.
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.agentId, ops.id));
  await grantScopes(f.db, f.org.id, ops.id, [{ connectionId: null, scope: ALL_TOOLS }]);
  const all = new Set([grantKey(null, ALL_TOOLS)]);
  expect(toolAccess(all, { name: "desktop_do", scope: DESKTOP_SCOPE, connectionId: null })).toBe("off");
  const missing = await missingPermissions({ db: f.db, orgId: f.org.id, agentId: ops.id });
  expect(missing.map((m) => m.id)).toContain(DESKTOP_SCOPE);

  // A known scope: admins grant it like any other.
  await setAgentScopes(f.db, f.owner.id, f.org.id, ops.id, [{ connectionId: null, scope: DESKTOP_SCOPE }]);
  expect(await scopesOf(ops.id)).toEqual([DESKTOP_SCOPE]);
});

test("the migration grants desktop:use only to live agents that may browse and run code", async () => {
  f = await setup();
  const both = await newAgent("both");
  const browses = await newAgent("browses");
  const codes = await newAgent("codes");
  const archived = await newAgent("archived");
  for (const a of [both, browses, codes, archived]) await drop(a.id, [DESKTOP_SCOPE]);
  await drop(browses.id, ["sandbox:run"]);
  await drop(codes.id, ["browser:use"]);
  await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, archived.id));

  const file = await Bun.file(new URL("../../db/migrations/0096_desktop_scope.sql", import.meta.url)).text();
  await f.db.execute(sql.raw(file));
  await f.db.execute(sql.raw(file));

  const granted = await f.db
    .select({ agentId: schema.agentScopes.agentId })
    .from(schema.agentScopes)
    .where(eq(schema.agentScopes.scope, DESKTOP_SCOPE));
  expect(granted.map((g) => g.agentId)).toEqual([both.id]);
});

test("a runner's hello stores whether it serves desktops and a terminal, and its switches", async () => {
  f = await setup({ machines: true });
  const hub = f.machineHub as MachineHub;
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Box" });
  const conn = hub.open({ send() {}, close() {} });
  await hub.message(
    conn,
    JSON.stringify({
      type: "hello",
      token: paired.token,
      version: "0.1.0",
      protocol: DESKTOP_PROTOCOL,
      os: "linux",
      arch: "x64",
      hostname: "box",
      workspace: "/srv/agents",
      exec: true,
      access: { folders: [], tools: { claude: false, codex: false, commands: true, desktop: true, terminal: false } },
      desktop: { available: true, width: 1280, height: 800 },
      terminal: { available: false, reason: "Needs Bun 1.3.5 or newer" },
    }),
  );
  const [row] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, paired.machineId));
  expect(row?.executors).toMatchObject({
    desktop: { available: true, width: 1280, height: 800 },
    terminal: { available: false, reason: "Needs Bun 1.3.5 or newer" },
  });
  expect(row?.access?.tools).toEqual({ claude: false, codex: false, commands: true, desktop: true });
  await hub.close(conn);
});

describe("pure parts", () => {
  const brief = (access: RoutineAccess) => ({
    routineId: "00000000-0000-4000-8000-000000000001",
    routineRunId: "00000000-0000-4000-8000-000000000002",
    name: "Conferir o painel",
    creatorUserId: "user_creator",
    deliverTo: { channelId: "00000000-0000-4000-8000-000000000003", threadId: null },
    access,
    report: "when_new" as const,
    trigger: "schedule" as const,
    dueAt: new Date().toISOString(),
  });
  const routine = (access: RoutineAccess): RunAuthority => ({ kind: "routine", personId: null, brief: brief(access) });
  const unattended: RunAuthority = { kind: "unattended", personId: null, reason: "agent" };
  const person: RunAuthority = { kind: "person", personId: "user_ana" };
  const desktopTool = { name: "desktop_do", scope: DESKTOP_SCOPE, connectionId: null };

  test("the desktop is its own area: every routine and runs nobody is behind may use it (ADR 0109)", () => {
    expect(toolKind(desktopTool)).toEqual({ kind: "internal", area: "desktop" });
    expect(toolPolicy(person, desktopTool).action).toBe("allow");
    expect(toolPolicy(routine("act"), desktopTool).action).toBe("allow");
    expect(toolPolicy(routine("read"), desktopTool).action).toBe("allow");
    expect(toolPolicy(unattended, desktopTool).action).toBe("allow");
    // Asking a person speaks in the run's own conversation, like the browser's.
    const ask = { name: "desktop_ask_person", scope: DESKTOP_SCOPE, connectionId: null };
    expect(toolKind(ask).kind).toBe("here");
    expect(toolPolicy(unattended, ask).action).toBe("allow");
    expect(toolPolicy(routine("act"), ask).action).toBe("refuse");
  });

  test("a paused computer still shows a desktop that runs; starting one, control and a terminal are new work", () => {
    const agent = { id: "a1", handle: "dev" };
    const id = "x".repeat(43);
    const requests: [MachineRequest, boolean][] = [
      [{ op: "desktop.session.start", agent }, true],
      [{ op: "desktop.session.stop", agent }, false],
      [{ op: "desktop.session.status", agent }, false],
      [{ op: "stream.open", streamId: id, kind: "desktop", mode: "watch", agent }, false],
      [{ op: "stream.open", streamId: id, kind: "desktop", mode: "control", agent }, true],
      [{ op: "stream.open", streamId: id, kind: "terminal", cols: 80, rows: 24, agent }, true],
    ];
    for (const [request, work] of requests) expect([request.op, isNewWork(request)]).toEqual([request.op, work]);
  });
});
