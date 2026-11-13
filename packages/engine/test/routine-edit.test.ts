import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  createAgent,
  createRoutine,
  deleteRoutine,
  drainOutbox,
  duplicateRoutine,
  ForbiddenError,
  fireDueRoutines,
  listRoutineRuns,
  listRoutines,
  NotFoundError,
  runRoutineNow,
  updateRoutine,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub, context: f.context });
const daily = () =>
  createRoutine(deps(), f.owner.id, f.org.id, {
    name: "Resumo",
    agentId: f.agent.id,
    prompt: "Resuma o dia.",
    target: { type: "channel", channelId: f.general.id },
    trigger: { type: "schedule", phrase: "todo dia às 9h", timezone: "UTC" },
  });

describe("editing routines", () => {
  test("a new schedule is parsed again and nextRunAt follows; fields change; audited", async () => {
    f = await setup({ reply: () => ({ chunks: ["ok"] }) });
    const routine = await daily();
    expect(routine.nextRunAt?.endsWith("T09:00:00.000Z")).toBe(true);

    const edited = await updateRoutine(deps(), f.owner.id, f.org.id, routine.id, {
      name: "Resumo da tarde",
      prompt: "Resuma a tarde.",
      trigger: { type: "schedule", phrase: "todo dia às 18h", timezone: "America/Sao_Paulo" },
    });
    expect(edited).toMatchObject({
      name: "Resumo da tarde",
      prompt: "Resuma a tarde.",
      trigger: { type: "schedule", cron: "0 18 * * *", timezone: "America/Sao_Paulo" },
    });
    expect(edited.nextRunAt?.endsWith("T21:00:00.000Z")).toBe(true); // 18:00 in São Paulo

    // Pausing clears the next run; resuming computes it again.
    expect((await updateRoutine(deps(), f.owner.id, f.org.id, routine.id, { active: false })).nextRunAt).toBeNull();
    expect((await updateRoutine(deps(), f.owner.id, f.org.id, routine.id, { active: true })).nextRunAt).not.toBeNull();

    // A one-off in the future; one in the past is refused.
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const once = await updateRoutine(deps(), f.owner.id, f.org.id, routine.id, { trigger: { type: "once", at } });
    expect(once.trigger.type).toBe("once");
    expect(once.nextRunAt).toBe(new Date(at).toISOString());
    await expect(
      updateRoutine(deps(), f.owner.id, f.org.id, routine.id, {
        trigger: { type: "once", at: new Date(Date.now() - 60_000).toISOString() },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateRoutine(deps(), f.owner.id, f.org.id, routine.id, {
        trigger: { type: "schedule", phrase: "todo dia às 9h", timezone: "Mars/Olympus" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const [audit] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "routine.updated")));
    expect(audit?.details).toMatchObject({
      before: { name: "Resumo", cron: "0 9 * * *" },
      after: { name: "Resumo da tarde", cron: "0 18 * * *" },
    });
  });

  test("who may edit: the creator, admins, the agent's owner; a new agent must be one they manage and talk to", async () => {
    f = await setup();
    const routine = await daily();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(updateRoutine(deps(), bia.id, f.org.id, routine.id, { name: "x" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(deleteRoutine(deps(), bia.id, f.org.id, routine.id)).rejects.toBeInstanceOf(ForbiddenError);
    // bia owns the agent now: she may edit.
    await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
    expect((await updateRoutine(deps(), bia.id, f.org.id, routine.id, { name: "Dela" })).name).toBe("Dela");
    // …but not move it to an agent she doesn't manage.
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops" },
      { model: "claude-sonnet-5-5" },
    );
    await expect(updateRoutine(deps(), bia.id, f.org.id, routine.id, { agentId: other.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // The admin may, if the new agent is in the target channel.
    await expect(updateRoutine(deps(), f.owner.id, f.org.id, routine.id, { agentId: other.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test("delete stops firing and keeps the history; duplicate makes a paused copy", async () => {
    f = await setup({ reply: () => ({ chunks: ["ok"] }) });
    const routine = await daily();
    await runRoutineNow(deps(), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);
    expect(await listRoutineRuns(f.db, f.owner.id, f.org.id, routine.id)).toHaveLength(1);

    const copy = await duplicateRoutine(deps(), f.owner.id, f.org.id, routine.id);
    expect(copy).toMatchObject({ name: "Resumo (copy)", active: false, nextRunAt: null, prompt: "Resuma o dia." });
    // The app names the copy in the person's language.
    const named = await duplicateRoutine(deps(), f.owner.id, f.org.id, routine.id, { name: "Resumo (cópia)" });
    expect(named.name).toBe("Resumo (cópia)");
    await deleteRoutine(deps(), f.owner.id, f.org.id, named.id);
    expect(copy.id).not.toBe(routine.id);

    await deleteRoutine(deps(), f.owner.id, f.org.id, routine.id);
    expect((await listRoutines(f.db, f.owner.id, f.org.id)).map((r) => r.id)).toEqual([copy.id]);
    // Even overdue, it never fires again; its runs stay.
    await f.db
      .update(schema.routines)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.routines.id, routine.id));
    expect(await fireDueRoutines(deps())).toBe(0);
    expect(await listRoutineRuns(f.db, f.owner.id, f.org.id, routine.id)).toHaveLength(1);
    await expect(updateRoutine(deps(), f.owner.id, f.org.id, routine.id, { name: "x" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(runRoutineNow(deps(), f.owner.id, f.org.id, routine.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
