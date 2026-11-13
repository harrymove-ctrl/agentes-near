import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, inArray, schema } from "@agenteschat/db";
import { runMigration } from "@agenteschat/db/testing";
import {
  addChannelMember,
  applyImport,
  createAgent,
  createChannel,
  createOrganization,
  deleteSkill,
  ForbiddenError,
  type ImportInput,
  type ImportPlan,
  insertMessage,
  type MigrationBundle,
  setAgentSkills,
  updateMyProfile,
  ValidationError,
} from "../src";
import { addMember as addPerson, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const DEFAULT_MODEL = "claude-sonnet-5-5";
const SKILL_MD =
  "---\nname: relatorio-semanal\ndescription: Escreve o relatório semanal.\n---\n# Relatório\n\nJunte as entregas.";

/** A sales team from another app: two agents, a skill, a room, a routine and two notes. */
function bundle(over: Partial<MigrationBundle> = {}): MigrationBundle {
  return {
    format: "agenteschat.bundle",
    version: 1,
    source: { app: "openmausbot", ref: "pkg-sales", name: "Vendas", files: ["sales.openmaus.json"] },
    agents: [
      {
        key: "scout",
        name: "Scout",
        handle: "scout",
        role: "Prospecção",
        instructions: "Ache leads novos toda semana.",
        model: "gpt-9-turbo",
        appearance: { color: "rose" },
        skills: ["weekly"],
      },
      {
        key: "closer",
        name: "Closer",
        handle: "closer",
        role: "Fechamento",
        instructions: "Feche os negócios.",
        model: "claude-opus-5-5",
        appearance: {},
        skills: [],
      },
    ],
    skills: [{ key: "weekly", markdown: SKILL_MD }],
    channels: [
      {
        key: "room",
        name: "vendas",
        topic: "Pipeline da semana",
        agents: [
          { key: "scout", autoReply: true },
          { key: "closer", autoReply: false },
        ],
      },
    ],
    routines: [
      {
        key: "daily",
        name: "Resumo do pipeline",
        agent: "scout",
        prompt: "Resuma o pipeline de hoje.",
        channel: "room",
        trigger: { cron: "0 9 * * 1-5", timezone: "America/Sao_Paulo" },
      },
    ],
    notes: [
      { key: "cycle", agent: "scout", kind: "fact", content: "O ciclo de venda leva 30 dias." },
      { key: "rule", agent: null, kind: "decision", content: "Contas acima de 50 pessoas vão para o Closer." },
    ],
    todo: [],
    leftOut: [],
    ...over,
  };
}

const deps = () => ({ db: f.db, blobs: f.artifactDeps.blobs, pubsub: f.pubsub });
const run = (input: Partial<ImportInput> & { bundle: MigrationBundle }, actor = f.owner.id) =>
  applyImport(deps(), actor, f.org.id, { dryRun: false, ...input }, { model: DEFAULT_MODEL });
const byKey = <T extends { kind: string; key: string }>(items: T[]) =>
  new Map(items.map((i) => [`${i.kind}:${i.key}`, i]));

async function counts() {
  const rows = async (query: PromiseLike<unknown[]>) => (await query).length;
  return {
    agents: await rows(f.db.select().from(schema.agents)),
    skills: await rows(f.db.select().from(schema.skills)),
    channels: await rows(f.db.select().from(schema.channels)),
    routines: await rows(f.db.select().from(schema.routines)),
    notes: await rows(f.db.select().from(schema.contextItems)),
    made: await rows(f.db.select().from(schema.importItems)),
    audit: await rows(f.db.select().from(schema.auditLog)),
  };
}

describe("planning and applying an import", () => {
  test("a dry run plans every item and writes nothing", async () => {
    f = await setup();
    const before = await counts();
    const plan = await run({ bundle: bundle(), dryRun: true });
    expect(await counts()).toEqual(before);
    expect(plan.items.map((i) => `${i.kind}:${i.key}:${i.action}`)).toEqual([
      "skill:weekly:create",
      "agent:scout:create",
      "agent:closer:create",
      "channel:room:create",
      "routine:daily:create",
      "note:cycle:create",
      "note:rule:create",
    ]);
    // A model outside our catalog: the default one, said so.
    expect(byKey(plan.items).get("agent:scout")).toMatchObject({ label: "Scout", reason: "model_not_in_catalog" });
    expect(byKey(plan.items).get("agent:closer")?.reason).toBeUndefined();
  });

  test("apply creates everything (routines active, skills on for their agents); again: all unchanged; a changed source: update", async () => {
    f = await setup();
    const plan = await run({ bundle: bundle() });
    expect(plan.items.every((i) => i.action === "create" && i.targetId)).toBe(true);
    const ids = byKey(plan.items);

    const [scout] = await f.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, ids.get("agent:scout")?.targetId ?? ""));
    expect(scout).toMatchObject({ handle: "scout", model: DEFAULT_MODEL, ownerUserId: f.owner.id, role: "Prospecção" });
    expect(scout?.appearance).toEqual({ color: "rose", eyes: "round", accessory: "none" });
    const [closer] = await f.db.select().from(schema.agents).where(eq(schema.agents.handle, "closer"));
    expect(closer?.model).toBe("claude-opus-5-5");

    const [skill] = await f.db.select().from(schema.skills).where(eq(schema.skills.slug, "relatorio-semanal"));
    expect(skill?.defaultForNewAgents).toBe(false);
    const on = await f.db
      .select()
      .from(schema.agentSkills)
      .where(eq(schema.agentSkills.skillId, skill?.id ?? ""));
    expect(on.filter((r) => r.enabled).map((r) => r.agentId)).toEqual([scout?.id ?? ""]);

    const [room] = await f.db.select().from(schema.channels).where(eq(schema.channels.name, "vendas"));
    expect(room?.topic).toBe("Pipeline da semana");
    const members = await f.db
      .select({ agentId: schema.channelMembers.agentId, autoReply: schema.channelMembers.autoReply })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, room?.id ?? ""));
    expect(members.filter((m) => m.agentId)).toEqual(
      expect.arrayContaining([
        { agentId: scout?.id ?? "", autoReply: true },
        { agentId: closer?.id ?? "", autoReply: false },
      ]),
    );

    const [routine] = await f.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, ids.get("routine:daily")?.targetId ?? ""));
    expect(routine).toMatchObject({ active: true, triggerType: "schedule", timezone: "America/Sao_Paulo" });
    expect(routine?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    expect(routine?.target).toEqual({ type: "channel", channelId: room?.id });

    const notes = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.orgId, f.org.id));
    expect(notes.map((n) => [n.content, n.agentId])).toEqual(
      expect.arrayContaining([
        ["O ciclo de venda leva 30 dias.", scout?.id ?? null],
        ["Contas acima de 50 pessoas vão para o Closer.", null],
      ]),
    );
    expect(await f.db.select().from(schema.importItems)).toHaveLength(7);
    const [audit] = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "import.applied"));
    expect(audit?.details).toMatchObject({ app: "openmausbot", ref: "pkg-sales", created: 7, skipped: 0 });

    const before = await counts();
    const again = await run({ bundle: bundle() });
    expect(again.items.map((i) => i.action)).toEqual(Array(7).fill("unchanged"));
    expect({ ...(await counts()), audit: 0 }).toEqual({ ...before, audit: 0 });

    const changed = bundle();
    (changed.agents[0] as MigrationBundle["agents"][number]).instructions = "Ache leads e qualifique.";
    const update = await run({ bundle: changed });
    expect(byKey(update.items).get("agent:scout")).toMatchObject({ action: "update", targetId: scout?.id });
    expect(update.items.filter((i) => i.action === "unchanged")).toHaveLength(6);
    const [updated] = await f.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, scout?.id ?? ""));
    expect(updated?.instructions).toBe("Ache leads e qualifique.");
  });

  test("@scout made by hand: the next free handle (@scout-2); an existing public channel is joined, its topic kept", async () => {
    f = await setup();
    const mine = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Meu Scout", handle: "scout" },
      { model: DEFAULT_MODEL },
    );
    const hall = await createChannel(f.db, f.owner.id, f.org.id, { name: "vendas", topic: "Nosso canal" });

    const plan = await run({ bundle: bundle(), dryRun: true });
    expect(byKey(plan.items).get("agent:scout")).toMatchObject({ action: "create", renamedTo: "scout-2" });
    expect(byKey(plan.items).get("channel:room")).toMatchObject({
      action: "update",
      reason: "exists",
      targetId: hall.id,
    });

    const applied = await run({ bundle: bundle() });
    const scout2 = byKey(applied.items).get("agent:scout")?.targetId;
    const [renamed] = await f.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, scout2 ?? ""));
    expect(renamed?.handle).toBe("scout-2");
    const [untouched] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, mine.id));
    expect(untouched).toMatchObject({ name: "Meu Scout", handle: "scout" });
    const [channel] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, hall.id));
    expect(channel?.topic).toBe("Nosso canal");
    const joined = await f.db
      .select()
      .from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, hall.id), eq(schema.channelMembers.agentId, scout2 ?? "")));
    expect(joined).toHaveLength(1);
    expect(await f.db.select().from(schema.channels).where(eq(schema.channels.name, "vendas"))).toHaveLength(1);

    // The same package again finds what it made (the renamed agent, the joined channel).
    const again = await run({ bundle: bundle() });
    expect(byKey(again.items).get("agent:scout")).toMatchObject({ action: "unchanged", renamedTo: "scout-2" });
    expect(byKey(again.items).get("channel:room")?.action).toBe("unchanged");
  });

  test("a private channel with the name is never joined", async () => {
    f = await setup();
    await createChannel(f.db, f.owner.id, f.org.id, { name: "vendas", visibility: "private" });
    const plan = await run({ bundle: bundle(), dryRun: true });
    expect(byKey(plan.items).get("channel:room")).toMatchObject({ action: "skip", reason: "exists" });
    // The routine needs that channel.
    expect(byKey(plan.items).get("routine:daily")).toMatchObject({ action: "skip", reason: "channel_not_picked" });
  });

  test("skills arrive on for the agents that had them, never as defaults; one turned off stays off", async () => {
    f = await setup();
    const plan = await run({ bundle: bundle() });
    const scout = byKey(plan.items).get("agent:scout")?.targetId ?? "";
    const closer = byKey(plan.items).get("agent:closer")?.targetId ?? "";
    const skillId = byKey(plan.items).get("skill:weekly")?.targetId ?? "";
    const rows = await f.db.select().from(schema.agentSkills).where(eq(schema.agentSkills.skillId, skillId));
    expect(rows.filter((r) => r.enabled).map((r) => r.agentId)).toEqual([scout]);
    expect(rows.some((r) => r.agentId === closer)).toBe(false);
    const [skill] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skillId));
    expect(skill?.defaultForNewAgents).toBe(false);

    await setAgentSkills(f.db, f.owner.id, f.org.id, scout, [{ skillId, enabled: false }]);
    await run({ bundle: bundle() });
    const after = await f.db.select().from(schema.agentSkills).where(eq(schema.agentSkills.skillId, skillId));
    expect(after.filter((r) => r.enabled)).toEqual([]);
  });

  test("an agent that comes back with no instructions never clears what an earlier import brought", async () => {
    f = await setup();
    const first = await run({ bundle: bundle() });
    const scoutId = byKey(first.items).get("agent:scout")?.targetId ?? "";
    const closerId = byKey(first.items).get("agent:closer")?.targetId ?? "";

    const again = bundle();
    const [scout, closer] = again.agents as [MigrationBundle["agents"][number], MigrationBundle["agents"][number]];
    const kept = scout.instructions;
    scout.instructions = "";
    closer.instructions = "Close the deal.";
    const items = byKey((await run({ bundle: again })).items);
    expect(items.get("agent:scout")?.action).toBe("unchanged");
    expect(items.get("agent:closer")?.action).toBe("update");
    const rows = await f.db.select().from(schema.agents).where(eq(schema.agents.orgId, f.org.id));
    expect(rows.find((a) => a.id === scoutId)?.instructions).toBe(kept);
    expect(rows.find((a) => a.id === closerId)?.instructions).toBe("Close the deal.");
    expect(rows.filter((a) => a.archivedAt === null && ["Scout", "Closer"].includes(a.name))).toHaveLength(2);
  });

  test("another app's reply is one package: asking again never makes the same agent twice", async () => {
    f = await setup();
    const reply = (ref: string) =>
      bundle({
        source: { app: "agenteschat", ref, name: "Grok Bot", files: [] },
        skills: [],
        channels: [],
        routines: [],
        notes: [],
      });
    // A reply imported when the package still carried the model's own name for the export.
    const old = await run({ bundle: reply("grok-bot:my-bots") });
    const scoutId = byKey(old.items).get("agent:scout")?.targetId ?? "";

    const again = reply("grok-bot");
    (again.agents[1] as MigrationBundle["agents"][number]).instructions = "Close the deal.";
    const items = byKey((await run({ bundle: again })).items);
    expect(items.get("agent:scout")).toMatchObject({ action: "unchanged", targetId: scoutId });
    expect(items.get("agent:closer")?.action).toBe("update");
    const third = byKey((await run({ bundle: again })).items);
    expect(third.get("agent:closer")?.action).toBe("unchanged");
    const rows = await f.db.select().from(schema.agents).where(eq(schema.agents.orgId, f.org.id));
    expect(rows.filter((a) => ["Scout", "Closer"].includes(a.name))).toHaveLength(2);

    // Another app's package is its own, and so is our export of another workspace.
    const other = byKey((await run({ bundle: reply("chatgpt-dots") })).items);
    expect(other.get("agent:scout")?.action).toBe("create");
  });

  test("text that looks like a credential never comes; what depends on a skipped agent is skipped", async () => {
    f = await setup();
    const b = bundle();
    (b.agents[0] as MigrationBundle["agents"][number]).instructions =
      "Use a chave sk-ant-api03-abcdefghijklmnopqrstuvwx.";
    b.notes.push({ key: "pw", agent: null, kind: "note", content: "senha: hunter2hunter2" });
    b.skills.push({ key: "leaky", markdown: "---\nname: leaky\ndescription: x\n---\napi_key = abcdef1234567890" });
    const plan = await run({ bundle: b });
    const items = byKey(plan.items);
    expect(items.get("agent:scout")).toMatchObject({ action: "skip", reason: "secret_like" });
    expect(items.get("note:pw")).toMatchObject({ action: "skip", reason: "secret_like" });
    expect(items.get("skill:leaky")).toMatchObject({ action: "skip", reason: "secret_like" });
    expect(items.get("routine:daily")).toMatchObject({ action: "skip", reason: "agent_not_picked" });
    expect(items.get("note:cycle")).toMatchObject({ action: "skip", reason: "agent_not_picked" });
    expect(items.get("agent:closer")?.action).toBe("create");
    const leaked = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.orgId, f.org.id));
    expect(leaked.some((n) => n.content.includes("hunter2"))).toBe(false);
  });

  test("only the picked items; long text cut and reported; bad handles and repeated keys refused", async () => {
    f = await setup();
    const b = bundle();
    (b.agents[1] as MigrationBundle["agents"][number]).name = "C".repeat(120);
    b.agents.push({ ...(b.agents[1] as MigrationBundle["agents"][number]), key: "closer" });
    b.agents.push({ ...(b.agents[1] as MigrationBundle["agents"][number]), key: "bad", handle: "Não Vale!" });
    const plan = await run({ bundle: b, pick: ["agent:closer", "agent:bad", "routine:daily"] });
    expect(plan.items.map((i) => [i.kind, i.key, i.action, i.reason])).toEqual([
      ["agent", "closer", "create", undefined],
      ["agent", "closer", "skip", "invalid"],
      ["agent", "bad", "skip", "invalid"],
      ["routine", "daily", "skip", "agent_not_picked"],
    ]);
    expect(plan.items[0]?.trimmed).toEqual(["name"]);
    const [closer] = await f.db.select().from(schema.agents).where(eq(schema.agents.handle, "closer"));
    expect(closer?.name).toHaveLength(80);
  });

  test("a 40-character role comes whole, nothing reported as cut; past 200 it is cut and reported", async () => {
    f = await setup();
    const b = bundle();
    (b.agents[0] as MigrationBundle["agents"][number]).role = "Assistente de e-mails, agenda e reuniões";
    (b.agents[1] as MigrationBundle["agents"][number]).role = "r".repeat(201);
    const plan = await run({ bundle: b, pick: ["agent:scout", "agent:closer"] });
    expect(plan.items.map((i) => [i.key, i.action, i.trimmed])).toEqual([
      ["scout", "create", undefined],
      ["closer", "create", ["role"]],
    ]);
    const made = await f.db
      .select()
      .from(schema.agents)
      .where(inArray(schema.agents.handle, ["scout", "closer"]));
    expect(Object.fromEntries(made.map((a) => [a.handle, a.role]))).toEqual({
      scout: "Assistente de e-mails, agenda e reuniões",
      closer: "r".repeat(200),
    });
  });

  test("schedules: a one-off and the picker's once land as one-time rules (active, with a next run); the past and nonsense are skipped", async () => {
    f = await setup();
    const soon = new Date(Date.now() + 3 * 86_400_000);
    const day = soon.toISOString().slice(0, 10);
    const routine = (key: string, trigger: MigrationBundle["routines"][number]["trigger"]) => ({
      key,
      name: key,
      agent: "scout",
      prompt: `Faça ${key}.`,
      channel: null,
      trigger,
    });
    const b = bundle({
      routines: [
        routine("at", { at: soon.toISOString() }),
        routine("once", { rule: { freq: "once", start: day, times: ["10:00"], timezone: "UTC", bySetPos: null } }),
        routine("weekly", {
          rule: { freq: "weekly", byWeekday: ["MO"], times: ["09:00"], timezone: null, start: null },
        }),
        routine("past", { at: "2020-01-01T10:00:00Z" }),
        routine("nonsense", { cron: "every other blue moon", timezone: null }),
      ],
    });
    const plan = await run({ bundle: b });
    const items = byKey(plan.items);
    expect(items.get("routine:past")).toMatchObject({ action: "skip", reason: "schedule_in_past" });
    expect(items.get("routine:nonsense")).toMatchObject({ action: "skip", reason: "schedule_unsupported" });
    for (const key of ["at", "once", "weekly"]) {
      const id = items.get(`routine:${key}`)?.targetId ?? "";
      expect(items.get(`routine:${key}`)?.action).toBe("create");
      const [row] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, id));
      expect(row).toMatchObject({ active: true, triggerType: "schedule" });
      expect(row?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
      expect(row?.target).toEqual({ type: "dm" });
    }
    const [once] = await f.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, items.get("routine:once")?.targetId ?? ""));
    expect(once?.rule).toMatchObject({ freq: "daily", count: 1, start: day, times: ["10:00"] });
  });

  test("routines past the agent's active limit still arrive, paused, with a note saying why", async () => {
    f = await setup();
    const routines = Array.from({ length: 22 }, (_, i) => ({
      key: `r${i}`,
      name: `r${i}`,
      agent: "scout",
      prompt: `Faça r${i}.`,
      channel: null,
      trigger: { cron: "0 9 * * *", timezone: null },
    }));
    const plan = await run({ bundle: bundle({ routines }) });
    const items = byKey(plan.items);
    const rows = await f.db.select().from(schema.routines);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (let i = 0; i < 22; i++) {
      const item = items.get(`routine:r${i}`);
      expect(item?.action).toBe("create");
      const row = byId.get(item?.targetId ?? "");
      if (i < 20) {
        expect(item?.reason).toBeUndefined();
        expect(row?.active).toBe(true);
      } else {
        expect(item?.reason).toBe("too_many_routines");
        expect(row?.active).toBe(false);
        expect(row?.nextRunAt).toBeNull();
      }
    }
  });

  test("admins only; one apply takes at most 200 writes (a dry run any size)", async () => {
    f = await setup();
    const member = await addPerson(f.db, f.org.id, "member");
    await expect(run({ bundle: bundle(), dryRun: true }, member.id)).rejects.toThrow(ForbiddenError);
    await expect(run({ bundle: bundle() }, member.id)).rejects.toThrow(ForbiddenError);

    const notes = Array.from({ length: 201 }, (_, i) => ({
      key: `n${i}`,
      agent: null,
      kind: "fact" as const,
      content: `Fato ${i}.`,
    }));
    const big = bundle({ agents: [], skills: [], channels: [], routines: [], notes });
    expect((await run({ bundle: big, dryRun: true })).items).toHaveLength(201);
    const before = await counts();
    const error = await run({ bundle: big }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("import.too_many_items");
    expect(await counts()).toEqual(before);
    const chunk = await run({ bundle: big, pick: notes.slice(0, 50).map((n) => `note:${n.key}`) });
    expect(chunk.items.every((i) => i.action === "create")).toBe(true);
  });
});

describe("importing the same package again", () => {
  type Agent = MigrationBundle["agents"][number];
  const members = (channelId: string) =>
    f.db
      .select({ agentId: schema.channelMembers.agentId, autoReply: schema.channelMembers.autoReply })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, channelId));

  test("an agent that comes later joins the channel an earlier import made; the rest of it stays as people left it", async () => {
    f = await setup();
    const first = await run({
      bundle: bundle(),
      pick: ["skill:weekly", "agent:scout", "channel:room", "routine:daily", "note:cycle", "note:rule"],
    });
    const room = byKey(first.items).get("channel:room")?.targetId ?? "";
    const scout = byKey(first.items).get("agent:scout")?.targetId ?? "";
    // Scout's auto-reply in the room was turned off here since.
    await f.db
      .update(schema.channelMembers)
      .set({ autoReply: false })
      .where(and(eq(schema.channelMembers.channelId, room), eq(schema.channelMembers.agentId, scout)));

    expect(byKey((await run({ bundle: bundle(), dryRun: true })).items).get("channel:room")?.action).toBe("update");
    const again = await run({ bundle: bundle() });
    const closer = byKey(again.items).get("agent:closer")?.targetId ?? "";
    expect(byKey(again.items).get("agent:closer")?.action).toBe("create");
    expect(byKey(again.items).get("channel:room")).toMatchObject({ action: "update", targetId: room });
    expect((await members(room)).filter((m) => m.agentId)).toEqual(
      expect.arrayContaining([
        { agentId: scout, autoReply: false },
        { agentId: closer, autoReply: false },
      ]),
    );
    // Everyone is in: nothing left to do there.
    expect(byKey((await run({ bundle: bundle(), dryRun: true })).items).get("channel:room")?.action).toBe("unchanged");
  });

  test("the model is chosen here: another one at the source is no change, and an update keeps it", async () => {
    f = await setup();
    const closer = byKey((await run({ bundle: bundle() })).items).get("agent:closer")?.targetId ?? "";
    const other = bundle();
    (other.agents[1] as Agent).model = DEFAULT_MODEL;
    expect(byKey((await run({ bundle: other, dryRun: true })).items).get("agent:closer")?.action).toBe("unchanged");

    (other.agents[1] as Agent).instructions = "Feche e passe para o financeiro.";
    const update = await run({ bundle: other });
    expect(byKey(update.items).get("agent:closer")?.action).toBe("update");
    const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, closer));
    expect(row).toMatchObject({ model: "claude-opus-5-5", instructions: "Feche e passe para o financeiro." });
  });

  test("a channel it made, made private since, gets no agent through an import", async () => {
    f = await setup();
    const room = byKey((await run({ bundle: bundle() })).items).get("channel:room")?.targetId ?? "";
    await f.db.update(schema.channels).set({ visibility: "private" }).where(eq(schema.channels.id, room));
    const changed = bundle();
    changed.agents.push({ ...(changed.agents[1] as Agent), key: "analyst", name: "Analyst", handle: "analyst" });
    changed.channels[0]?.agents.push({ key: "analyst", autoReply: true });

    const again = await run({ bundle: changed });
    expect(byKey(again.items).get("channel:room")).toMatchObject({ action: "skip", reason: "exists" });
    const analyst = byKey(again.items).get("agent:analyst")?.targetId;
    expect(analyst).toBeTruthy();
    expect((await members(room)).some((m) => m.agentId === analyst)).toBe(false);
  });

  test("another person's package with the same ids lands as new items, never as updates to what someone else imported", async () => {
    f = await setup();
    const first = byKey((await run({ bundle: bundle() })).items);
    const scout = first.get("agent:scout")?.targetId ?? "";
    const admin = await addPerson(f.db, f.org.id, "admin");
    const theirs = bundle();
    (theirs.agents[0] as Agent).instructions = "Outra pessoa, outro Scout.";

    const plan = byKey((await run({ bundle: theirs, dryRun: true }, admin.id)).items);
    expect(plan.get("agent:scout")).toMatchObject({ action: "create", renamedTo: expect.any(String) });
    expect(plan.get("note:cycle")?.action).toBe("create");
    const applied = byKey((await run({ bundle: theirs }, admin.id)).items);
    expect(applied.get("agent:scout")?.targetId).not.toBe(scout);
    const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, scout));
    expect(row?.instructions).toBe("Ache leads novos toda semana.");
    // Each person's next import still updates only their own items.
    expect(byKey((await run({ bundle: bundle(), dryRun: true })).items).get("agent:scout")?.action).toBe("unchanged");
  });

  test("a skill it made and an admin deleted comes back on only for the agents that bring it, as on a first import", async () => {
    f = await setup();
    const first = await run({ bundle: bundle() });
    const scout = byKey(first.items).get("agent:scout")?.targetId ?? "";
    const skillId = byKey(first.items).get("skill:weekly")?.targetId ?? "";
    await deleteSkill(f.db, f.owner.id, f.org.id, skillId);

    const again = await run({ bundle: bundle() });
    expect(byKey(again.items).get("skill:weekly")).toMatchObject({ action: "create", targetId: skillId });
    const rows = await f.db.select().from(schema.agentSkills).where(eq(schema.agentSkills.skillId, skillId));
    expect(rows.filter((r) => r.enabled).map((r) => r.agentId)).toEqual([scout]);
  });
});

describe("agents another app knows by an id", () => {
  type Agent = MigrationBundle["agents"][number];
  /**
   * An OpenBot.run export as the browser reads it: each agent's id (`agent-` and a UUID) is its key, and that id
   * cut to our 32 characters its handle. Every agent is still called "New agent" unless named.
   */
  const openbot = (agents: Partial<Agent>[]) =>
    bundle({
      source: { app: "openbotrun", ref: "grok-bot", name: "Grok Bot", files: ["openbot-import.json"] },
      agents: agents.map((a, i) => {
        const key = `agent-${i}5ba44fd-45b0-4b0e-9bb0-375efa7e90de`;
        const blank = { name: "New agent", role: "", instructions: "", model: null, appearance: {}, skills: [] };
        return { key, handle: key.slice(0, 32), ...blank, ...a };
      }),
      skills: [],
      channels: [],
      routines: [],
      notes: [],
    });
  const handles = (plan: ImportPlan) =>
    Promise.all(
      plan.items.map(
        async (i) =>
          (
            await f.db
              .select({ handle: schema.agents.handle })
              .from(schema.agents)
              .where(eq(schema.agents.id, i.targetId ?? ""))
          )[0]?.handle,
      ),
    );

  test("each gets a handle from its name, never the id; a handle someone chose stays, also after that name", async () => {
    f = await setup();
    const plan = await run({
      bundle: openbot([
        { name: "Otávio Ofertas", role: "Vendas" },
        { name: "Rita Revisão" },
        { name: "Posts & Anúncios" },
        { name: "App/UX" },
        { name: "Inbox Router" },
        { name: "Scout" },
        { key: "scout", name: "Scout", handle: "scout" },
      ]),
    });
    expect(plan.items.map((i) => [i.action, i.renamedTo])).toEqual([
      ["create", "otavioofertas"],
      ["create", "ritarevisao"],
      ["create", "postsanuncios"],
      ["create", "appux"],
      ["create", "inboxrouter"],
      ["create", "scout-2"],
      ["create", undefined],
    ]);
    expect(await handles(plan)).toEqual([
      "otavioofertas",
      "ritarevisao",
      "postsanuncios",
      "appux",
      "inboxrouter",
      "scout-2",
      "scout",
    ]);
  });

  test('"New agent" (or its id as its name): from its role, else its instructions\' first sentence, else @newagent', async () => {
    f = await setup();
    const plan = await run({
      bundle: openbot([
        { role: "Account executive" },
        { instructions: "Você revisa contratos. Nunca assina nada." },
        { name: "agent-95ba44fd-45b0-4b0e-9bb0-375efa7e90de", role: "Ops" },
        {},
        {},
      ]),
    });
    expect(await handles(plan)).toEqual(["accountexecutive", "vocerevisacontratos", "ops", "newagent", "newagent-2"]);
  });

  test("a name an agent or a person here already has: the next number", async () => {
    f = await setup();
    await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Otávio", handle: "otavioofertas" },
      { model: DEFAULT_MODEL },
    );
    await updateMyProfile(f.db, f.owner.id, f.org.id, { handle: "ritarevisao" });
    const plan = await run({
      bundle: openbot([{ name: "Otávio Ofertas" }, { name: "Rita Revisão" }, { name: "Otávio Ofertas" }]),
    });
    expect(await handles(plan)).toEqual(["otavioofertas-2", "ritarevisao-2", "otavioofertas-3"]);
  });

  test("what is picked never moves a handle: an agent picked alone gets the one the list showed", async () => {
    f = await setup();
    const file = openbot([{}, {}]);
    const listed = await run({ bundle: file, dryRun: true });
    expect(listed.items.map((i) => i.renamedTo)).toEqual(["newagent", "newagent-2"]);
    const second = await run({ bundle: file, pick: [`agent:${file.agents[1]?.key}`] });
    expect(await handles(second)).toEqual(["newagent-2"]);
    // The other one, brought later, gets the one the list showed for it.
    const later = await run({ bundle: file });
    expect(later.items.map((i) => [i.action, i.renamedTo])).toEqual([
      ["create", "newagent"],
      ["unchanged", "newagent-2"],
    ]);
  });

  test("the same file again: every agent is already here, found by its id and not by its handle", async () => {
    f = await setup();
    const file = openbot([{ name: "Otávio Ofertas" }, {}, {}]);
    const first = await run({ bundle: file });
    const before = await counts();
    const again = await run({ bundle: file });
    expect(again.items.map((i) => [i.action, i.renamedTo, i.targetId])).toEqual([
      ["unchanged", "otavioofertas", first.items[0]?.targetId],
      ["unchanged", "newagent", first.items[1]?.targetId],
      ["unchanged", "newagent-2", first.items[2]?.targetId],
    ]);
    expect({ ...(await counts()), audit: 0 }).toEqual({ ...before, audit: 0 });

    // One an earlier version imported with the id as its handle is found the same way.
    await f.db
      .update(schema.agents)
      .set({ handle: file.agents[1]?.handle })
      .where(eq(schema.agents.id, first.items[1]?.targetId ?? ""));
    const plan = await run({ bundle: file, dryRun: true });
    expect(plan.items[1]).toMatchObject({ action: "unchanged", targetId: first.items[1]?.targetId });
    expect(plan.items[1]?.renamedTo).toBeUndefined();
  });

  test("the migration names the agents an import named by an id, unique in each workspace; mentions stay by id", async () => {
    f = await setup();
    const file = openbot([
      { name: "Otávio Ofertas" },
      { name: "Rita Revisão" },
      { role: "Account executive" },
      { instructions: "Você revisa contratos. Nunca assina nada." },
      {},
      {},
      { key: "scout", name: "Scout", handle: "scout" },
    ]);
    const ids = (await run({ bundle: file })).items.map((i) => i.targetId ?? "");
    // As an import left them before: each with its id as its handle.
    for (const [i, a] of file.agents.entries()) {
      await f.db
        .update(schema.agents)
        .set({ handle: a.handle })
        .where(eq(schema.agents.id, ids[i] ?? ""));
    }
    await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Otávio", handle: "otavioofertas" },
      { model: DEFAULT_MODEL },
    );
    await updateMyProfile(f.db, f.owner.id, f.org.id, { handle: "ritarevisao" });
    // Made by hand (before id-shaped handles were refused), so never renamed, whatever its handle looks like.
    const byHand = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Bot", handle: "bot" },
      { model: DEFAULT_MODEL },
    );
    await f.db
      .update(schema.agents)
      .set({ handle: "agent-75ba44fd-45b0-4b0e-9bb0-37" })
      .where(eq(schema.agents.id, byHand.id));
    // Another workspace's handles don't count here.
    const bia = await addUser(f.db, "bia");
    const { organization: other } = await createOrganization(f.db, bia.id, { name: "Outra" });
    await createAgent(f.db, bia.id, other.id, { name: "AE", handle: "accountexecutive" }, { model: DEFAULT_MODEL });
    // A message that mentioned Otávio by his old handle.
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ids[0] ?? "" });
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: `@${file.agents[0]?.handle} o que mudou hoje?`,
    });
    expect(said.mentionedAgentIds).toEqual([ids[0] ?? ""]);

    await runMigration(f.db, "imported_agent_handles");
    await runMigration(f.db, "imported_agent_handles");
    const rows = await f.db
      .select({ id: schema.agents.id, handle: schema.agents.handle })
      .from(schema.agents)
      .where(inArray(schema.agents.id, [...ids, byHand.id]));
    const handleOf = new Map(rows.map((r) => [r.id, r.handle]));
    expect(ids.map((id) => handleOf.get(id))).toEqual([
      "otavioofertas-2",
      "ritarevisao-2",
      "accountexecutive",
      "vocerevisacontratos",
      "newagent",
      "newagent-2",
      "scout",
    ]);
    expect(handleOf.get(byHand.id)).toBe("agent-75ba44fd-45b0-4b0e-9bb0-37");
    // The message keeps its text, and its mention, which is by id.
    const [message] = await f.db
      .select({ body: schema.messages.body, mentioned: schema.messages.mentionedAgentIds })
      .from(schema.messages)
      .where(eq(schema.messages.id, said.id));
    expect(message).toEqual({ body: "@agent-05ba44fd-45b0-4b0e-9bb0-37 o que mudou hoje?", mentioned: [ids[0] ?? ""] });
  });
});
