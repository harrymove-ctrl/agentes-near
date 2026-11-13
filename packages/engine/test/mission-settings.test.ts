import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createMission,
  decideCommand,
  drainOutbox,
  eligibleMissionAgents,
  getMission,
  getMissionSettings,
  listMissionCommands,
  type MachineHub,
  removeCommandRule,
  setAgentMissionApproval,
  setCommandApproval,
  setMissionResumeTasks,
  setParticipant,
  startMission,
  startSessionTask,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { type McpResult, missionRunner, pairedMachine, type TaskStartRequest } from "./mission-helpers";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const md = () => f.missionDeps;
const ok = (r: McpResult) => {
  if (!r.ok) throw new Error(`mcp refused: ${r.error.code} ${r.error.message}`);
  return r.text;
};
const audits = (action: string) => f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

/**
 * A started Claude Code mission (its main session is the agent's run), one item session running on the
 * computer (`main`: Claude Code's prompts come from it), and a way to ask for a command.
 */
async function working(judge?: NonNullable<Parameters<typeof setup>[0]>["judge"]) {
  f = await setup({
    machines: true,
    missionTools: true,
    reply: () => ({ chunks: ["ok"] }),
    ...(judge ? { judge } : {}),
  });
  const paired = await pairedMachine(f);
  const runner = missionRunner(f.machineHub as MachineHub);
  await runner.hello(paired.token);
  const view = await createMission(md(), f.owner.id, f.org.id, {
    agentId: f.agent.id,
    channelId: f.general.id,
    goal: "Build our mobile app",
    title: "Mobile app",
    repoDir: "app",
  });
  await drainOutbox(f.db, f.handlers);
  await startMission(md(), f.owner.id, f.org.id, view.id);
  await drainOutbox(f.db, f.handlers);
  await startItem("Navigation");
  const main = runner.started.at(-1) as TaskStartRequest;
  const prompt = async (args: Record<string, unknown>) =>
    JSON.parse(ok(await runner.mcp(main.taskId, "permission_prompt", args))) as {
      behavior?: string;
      status?: string;
      request_id?: string;
    };
  return { view, runner, main, prompt };
}

/** A new item session of the mission on the computer (what the main session's `start_task` starts). */
async function startItem(title: string) {
  const [mission] = await f.db.select().from(schema.missions);
  if (!mission) throw new Error("no mission");
  return startSessionTask(md(), mission, {
    title,
    prompt: "Build it",
    sessionId: crypto.randomUUID(),
    cwd: mission.repoDir,
    resume: false,
  });
}

/** A member of #general; `decide` makes them a decider of the mission. */
async function member(name: string, missionId?: string) {
  const user = await addMember(f.db, f.org.id, "member", name);
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: user.id });
  if (missionId) await setParticipant(md(), f.owner.id, f.org.id, missionId, { userId: user.id, role: "decide" });
  return user;
}

describe("Configurações da missão", () => {
  test("removing an allowed rule: owner or deciders, audited, the command asks again, the next task's list drops it", async () => {
    const { view, runner, prompt } = await working();
    const asked = await prompt({ tool_name: "Bash", input: { command: "swift build -c release" } });
    await decideCommand(md(), f.owner.id, f.org.id, view.id, asked.request_id as string, "always");
    const settings = await getMissionSettings(md(), f.owner.id, f.org.id, view.id);
    expect(settings.rules).toEqual([
      { id: expect.any(String), rule: "Bash(swift build *)", by: f.owner.id, createdAt: expect.any(String) },
    ]);
    const ruleId = settings.rules[0]?.id as string;

    // Someone who only reads can't take it back; an unknown rule is not found.
    const bia = await member("bia");
    await expect(removeCommandRule(md(), bia.id, f.org.id, view.id, ruleId)).rejects.toMatchObject({
      code: "mission.not_allowed",
    });
    await expect(
      removeCommandRule(md(), f.owner.id, f.org.id, view.id, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ code: "mission.rule_not_found" });

    // A decider can.
    const caio = await member("caio", view.id);
    expect(await removeCommandRule(md(), caio.id, f.org.id, view.id, ruleId)).toEqual({ rules: [] });
    expect((await listMissionCommands(md(), f.owner.id, f.org.id, view.id)).rules).toEqual([]);
    expect((await audits("mission.command_rule_removed")).map((a) => a.details)).toEqual([
      { ruleId, rule: "Bash(swift build *)" },
    ]);
    // Twice: already gone.
    await expect(removeCommandRule(md(), caio.id, f.org.id, view.id, ruleId)).rejects.toMatchObject({
      code: "mission.rule_not_found",
    });

    // No longer allowed by itself: the card again.
    expect(await prompt({ tool_name: "Bash", input: { command: "swift build" } })).toMatchObject({
      status: "pending",
    });
    await startItem("Release");
    expect((runner.started.at(-1) as TaskStartRequest).mission?.allow).toEqual([]);

    // Aprovar sempre again brings it back (a new rule).
    const again = await prompt({ tool_name: "Bash", input: { command: "swift build -c debug" } });
    await decideCommand(md(), f.owner.id, f.org.id, view.id, again.request_id as string, "always");
    const back = await getMissionSettings(md(), f.owner.id, f.org.id, view.id);
    expect(back.rules.map((r) => r.rule)).toEqual(["Bash(swift build *)"]);
    expect(back.rules[0]?.id).not.toBe(ruleId);
  });

  test("stats: allowed automatically, asked, blocked (refused cards and commands a task was refused)", async () => {
    let risk = 0.99;
    const { view, prompt, runner, main } = await working((kind) =>
      kind === "mission_command_risk" ? risk : undefined,
    );
    const scope = { cwd: "/Users/w/agentes/dev/app", folders: ["/Users/w/agentes/dev/app"], home: "/Users/w" };
    expect(await prompt({ tool_name: "Bash", input: { command: "swift build" }, scope })).toEqual({
      behavior: "allow",
    });
    expect(await prompt({ tool_name: "Bash", input: { command: "make test" }, scope })).toEqual({
      behavior: "allow",
    });
    risk = 0;
    const a = await prompt({ tool_name: "Bash", input: { command: "brew install ffmpeg" }, scope });
    await prompt({ tool_name: "Bash", input: { command: "brew install imagemagick" }, scope });
    await decideCommand(md(), f.owner.id, f.org.id, view.id, a.request_id as string, "deny");
    await runner.done(main.taskId, {
      denials: [
        { tool: "Bash", command: "sudo rm -rf /tmp/x" },
        { tool: "Bash", command: "scp a host:/tmp" },
      ],
    });
    await drainOutbox(f.db, f.handlers);
    expect((await getMissionSettings(md(), f.owner.id, f.org.id, view.id)).stats).toEqual({
      auto: 2,
      asked: 2,
      blocked: 3,
    });
  });

  test("Retomar sozinho: owner or deciders turn resume_tasks off and on; audited", async () => {
    const { view } = await working();
    expect(view.resumeTasks).toBe(true);
    const bia = await member("bia");
    await expect(setMissionResumeTasks(md(), bia.id, f.org.id, view.id, false)).rejects.toMatchObject({
      code: "mission.not_allowed",
    });
    await expect(setMissionResumeTasks(md(), f.owner.id, f.org.id, view.id, "no")).rejects.toMatchObject({
      code: "mission.invalid",
    });
    expect((await setMissionResumeTasks(md(), f.owner.id, f.org.id, view.id, false)).resumeTasks).toBe(false);
    expect((await getMission(md(), f.owner.id, f.org.id, view.id)).resumeTasks).toBe(false);
    const caio = await member("caio", view.id);
    expect((await setMissionResumeTasks(md(), caio.id, f.org.id, view.id, true)).resumeTasks).toBe(true);
    // The same value again: nothing new recorded.
    await setMissionResumeTasks(md(), caio.id, f.org.id, view.id, true);
    expect((await audits("mission.resume_tasks")).map((a) => a.details)).toEqual([
      { from: true, to: false },
      { from: false, to: true },
    ]);
  });

  test("Usar como padrão: the agent's owner or an admin; new missions of the agent start with it", async () => {
    const { view } = await working();
    const bia = await member("bia");
    // Not the agent's owner, not an admin: they see it, can't change it.
    const seen = await getMissionSettings(md(), bia.id, f.org.id, view.id);
    expect(seen.agentDefault).toMatchObject({ commandApproval: "low_risk_auto", canSet: false });
    await expect(setAgentMissionApproval(md(), bia.id, f.org.id, f.agent.id, "never")).rejects.toMatchObject({
      code: "agent.not_owner",
    });
    await expect(setAgentMissionApproval(md(), f.owner.id, f.org.id, f.agent.id, "sometimes")).rejects.toMatchObject({
      code: "mission.invalid_command_approval",
    });
    // The agent's owner can.
    await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
    expect((await getMissionSettings(md(), bia.id, f.org.id, view.id)).agentDefault.canSet).toBe(true);
    expect(await setAgentMissionApproval(md(), bia.id, f.org.id, f.agent.id, "always")).toEqual({
      commandApproval: "always",
    });
    expect((await audits("agent.mission_command_approval")).map((a) => a.details)).toEqual([
      { from: "low_risk_auto", to: "always" },
    ]);
    // An admin (the org's owner) too.
    expect((await getMissionSettings(md(), f.owner.id, f.org.id, view.id)).agentDefault).toMatchObject({
      commandApproval: "always",
      canSet: true,
      ownerId: bia.id,
    });
    // The current mission doesn't change; a new one starts with the default, unless asked otherwise.
    expect((await getMission(md(), f.owner.id, f.org.id, view.id)).commandApproval).toBe("low_risk_auto");
    const next = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Photos",
    });
    expect(next.commandApproval).toBe("always");
    const asked = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Videos",
      commandApproval: "never",
    });
    expect(asked.commandApproval).toBe("never");
    // "Nova missão" starts from it too.
    const eligible = await eligibleMissionAgents(md(), f.owner.id, f.org.id);
    expect(eligible.find((a) => a.agentId === f.agent.id)?.commandApproval).toBe("always");
    // The mission's own setting still changes on its own.
    await setCommandApproval(md(), f.owner.id, f.org.id, next.id, "never");
    expect((await getMissionSettings(md(), f.owner.id, f.org.id, next.id)).agentDefault.commandApproval).toBe("always");
  });
});
