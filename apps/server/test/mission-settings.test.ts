import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type ServerFrame } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import { browser, createTestServer, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.5.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

/** A connected runner that starts every task it is asked to. */
function fakeRunner() {
  const hub = t.engine.machineHub;
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request") return;
      setTimeout(() => {
        const ok = (data: unknown) => void reply({ type: "result", id: frame.id, ok: true, data });
        if (frame.op === "task.start") {
          return ok({
            taskId: frame.taskId,
            pid: 7,
            startedAt: new Date().toISOString(),
            cwd: frame.cwd ?? "",
            command: "claude -p",
          });
        }
        if (frame.op === "read") return ok({ base64: null, size: 0 });
        return ok({ size: 0 });
      }, 1);
    },
    close() {},
  });
  return {
    hello: (token: string) => hub.message(conn, JSON.stringify({ type: "hello", token, ...RUNNER, exec: true })),
  };
}

interface Settings {
  rules: { id: string; rule: string; by: string | null }[];
  stats: { auto: number; asked: number; blocked: number };
  agentDefault: { commandApproval: string; canSet: boolean; ownerId: string | null };
}

test("mission settings API: read, take back a rule, resume tasks, the agent's default (and who may)", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const paired = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "MacBook" });
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: paired.machineId } });
  await fakeRunner().hello(paired.token);
  const mission = (await (
    await api("/missions", { json: { agentId, channelId, goal: "Build our mobile app", title: "Mobile app" } })
  ).json()) as { id: string; commandApproval: string; resumeTasks: boolean };
  expect(mission.commandApproval).toBe("low_risk_auto");

  // A rule someone allowed with "Aprovar sempre" (stored in the mission's feed).
  await t.db.insert(schema.missionEvents).values({
    orgId,
    missionId: mission.id,
    kind: "command_rule",
    data: { rule: "Bash(swift build *)", by: "someone" },
  });
  const read = await api(`/missions/${mission.id}/settings`);
  expect(read.status).toBe(200);
  const settings = (await read.json()) as Settings;
  expect(settings.rules.map((r) => r.rule)).toEqual(["Bash(swift build *)"]);
  expect(settings.stats).toEqual({ auto: 0, asked: 0, blocked: 0 });
  expect(settings.agentDefault).toMatchObject({ commandApproval: "low_risk_auto", canSet: true });

  const ruleId = settings.rules[0]?.id as string;
  expect(
    (await api(`/missions/${mission.id}/command-rules/${ruleId}`, { origin: "https://evil.example", method: "DELETE" }))
      .status,
  ).toBe(403);
  const removed = await api(`/missions/${mission.id}/command-rules/${ruleId}`, { method: "DELETE" });
  expect(removed.status).toBe(200);
  expect(((await removed.json()) as { rules: unknown[] }).rules).toEqual([]);
  expect((await api(`/missions/${mission.id}/command-rules/${ruleId}`, { method: "DELETE" })).status).toBe(404);

  const off = await api(`/missions/${mission.id}`, { method: "PATCH", json: { resumeTasks: false } });
  expect(off.status).toBe(200);
  expect(((await off.json()) as { resumeTasks: boolean }).resumeTasks).toBe(false);
  expect((await api(`/missions/${mission.id}`, { method: "PATCH", json: { resumeTasks: "no" } })).status).toBe(400);

  // A member who reads the channel: sees the settings, changes none of them.
  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  const { url } = (await (
    await api("/invitations", { json: { email: "bia@example.com", role: "member" } })
  ).json()) as { url: string };
  await bia(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  const asBia = (path: string, init?: Parameters<typeof bia>[1]) => bia(`/api/app/organizations/${orgId}${path}`, init);
  const biaSees = (await (await asBia(`/missions/${mission.id}/settings`)).json()) as Settings;
  expect(biaSees.agentDefault.canSet).toBe(false);
  expect((await asBia(`/missions/${mission.id}`, { method: "PATCH", json: { resumeTasks: true } })).status).toBe(403);
  const refused = await asBia(`/agents/${agentId}/mission-command-approval`, {
    method: "PUT",
    json: { commandApproval: "never" },
  });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("agent.not_owner");

  // The admin sets the agent's default; the next mission starts with it.
  const set = await api(`/agents/${agentId}/mission-command-approval`, {
    method: "PUT",
    json: { commandApproval: "always" },
  });
  expect(set.status).toBe(200);
  expect(await set.json()).toEqual({ commandApproval: "always" });
  const eligible = (await (await api("/missions/eligible-agents")).json()) as {
    agents: { agentId: string; commandApproval: string }[];
  };
  expect(eligible.agents.find((a) => a.agentId === agentId)?.commandApproval).toBe("always");
  const next = (await (
    await api("/missions", { json: { agentId, channelId, goal: "Photos", title: "Photos" } })
  ).json()) as { commandApproval: string };
  expect(next.commandApproval).toBe("always");
});
