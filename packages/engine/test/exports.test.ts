import { afterEach, expect, test } from "bun:test";
import {
  addChannelMember,
  addContextItemByPerson,
  applyImport,
  createChannel,
  createOrganization,
  createRoutine,
  exportBundle,
  ForbiddenError,
  insertContextItem,
  type MigrationBundle,
  parseSkillMarkdown,
  saveSkill,
  setAgentAppearance,
  setAgentSkills,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SKILL_MD = `---
name: relatorio-semanal
description: Escreve o relatório semanal.
metadata:
  openclaw:
    requires:
      bins: [gh]
---
# Relatório

Junte as entregas.`;

/** A bundle by names instead of ids: what must be equal in both workspaces. */
function shape(b: MigrationBundle) {
  const handle = new Map(b.agents.map((a) => [a.key, a.handle]));
  const channel = new Map(b.channels.map((c) => [c.key, c.name]));
  return {
    agents: b.agents.map(({ key: _key, skills, ...a }) => ({ ...a, skills: skills.length })),
    skills: b.skills.map((s) => parseSkillMarkdown(s.markdown)),
    channels: b.channels.map((c) => ({
      name: c.name,
      topic: c.topic,
      agents: c.agents.map((m) => ({ handle: handle.get(m.key), autoReply: m.autoReply })),
    })),
    routines: b.routines.map(({ key: _key, agent, channel: c, ...r }) => ({
      ...r,
      agent: handle.get(agent),
      channel: c && channel.get(c),
    })),
    notes: b.notes.map(({ key: _key, agent, ...n }) => ({ ...n, agent: agent && handle.get(agent) })),
  };
}

test("export: what everyone may see, never keys; imported into another workspace it comes back the same", async () => {
  f = await setup();
  const { db, owner, org, agent, general } = f;
  const deps = { db, pubsub: f.pubsub };
  await setAgentAppearance(db, owner.id, org.id, agent.id, { color: "teal", eyes: "happy", accessory: "cap" });
  const skill = await saveSkill({ db, blobs: f.artifactDeps.blobs }, owner.id, org.id, {
    ...parseSkillMarkdown(SKILL_MD),
    source: "manual",
    files: [{ path: "templates/relatorio.md", data: new TextEncoder().encode("# Modelo") }],
  });
  await setAgentSkills(db, owner.id, org.id, agent.id, [{ skillId: skill.id, enabled: true }]);
  const ops = await createChannel(db, owner.id, org.id, { name: "ops", topic: "Operação" });
  await addChannelMember(db, owner.id, org.id, ops.id, { agentId: agent.id, autoReply: false });
  const board = await createChannel(db, owner.id, org.id, { name: "diretoria", visibility: "private" });
  await addChannelMember(db, owner.id, org.id, board.id, { agentId: agent.id });
  const weekly = { freq: "weekly" as const, byWeekday: ["MO"], times: ["09:00"], timezone: "America/Sao_Paulo" };
  await createRoutine(deps, owner.id, org.id, {
    name: "Bom dia",
    agentId: agent.id,
    prompt: "Diga bom dia ao time.",
    target: { type: "channel", channelId: ops.id },
    trigger: { type: "schedule", rule: weekly },
  });
  await createRoutine(deps, owner.id, org.id, {
    name: "Nova issue",
    agentId: agent.id,
    prompt: "Olhe a issue nova.",
    target: { type: "dm" },
    trigger: { type: "event", event: "issue.created" },
  });
  await createRoutine(deps, owner.id, org.id, {
    name: "Resumo da diretoria",
    agentId: agent.id,
    prompt: "Resuma a semana.",
    target: { type: "channel", channelId: board.id },
    trigger: { type: "schedule", rule: weekly },
  });
  await addContextItemByPerson(db, owner.id, org.id, { kind: "fact", content: "A Acme lança foguetes às sextas." });
  await db.transaction(async (tx) => {
    // Learned in the private channel; and a claim from an untrusted source.
    await insertContextItem(tx, {
      orgId: org.id,
      kind: "note",
      scopeType: "agent",
      agentId: agent.id,
      content: "A diretoria quer cortar custos.",
      channelIds: [board.id],
    });
    await insertContextItem(tx, {
      orgId: org.id,
      kind: "fact",
      scopeType: "org",
      content: "Diz o e-mail.",
      trust: "low",
    });
  });

  const member = await addMember(db, org.id, "member");
  await expect(exportBundle(db, member.id, org.id)).rejects.toThrow(ForbiddenError);

  const bundle = await exportBundle(db, owner.id, org.id);
  expect(bundle.source).toEqual({ app: "agenteschat", ref: org.id, name: "Acme", files: [] });
  expect(bundle.agents).toEqual([
    {
      key: agent.id,
      name: "Dev",
      handle: "dev",
      role: "Developer",
      instructions: "Answer briefly.",
      model: "claude-sonnet-5-5",
      appearance: { color: "teal", eyes: "happy", accessory: "cap" },
      skills: [skill.id],
    },
  ]);
  expect(parseSkillMarkdown(bundle.skills[0]?.markdown ?? "")).toEqual(parseSkillMarkdown(SKILL_MD));
  expect(bundle.channels.map((c) => [c.name, c.agents])).toEqual([
    ["general", [{ key: agent.id, autoReply: true }]],
    ["ops", [{ key: agent.id, autoReply: false }]],
  ]);
  expect(bundle.routines).toHaveLength(1);
  expect(bundle.routines[0]).toMatchObject({ name: "Bom dia", channel: ops.id, trigger: { rule: weekly } });
  expect(bundle.notes.map((n) => n.content)).toEqual(["A Acme lança foguetes às sextas."]);
  expect(bundle.leftOut).toEqual(
    expect.arrayContaining([
      { kind: "routine", label: "Nova issue" },
      { kind: "routine", label: "Resumo da diretoria" },
      { kind: "file", label: "relatorio-semanal/templates/relatorio.md" },
    ]),
  );
  const text = JSON.stringify(bundle);
  for (const secret of ["sk-ant-test-key-1234", f.credential.id, board.id, "cortar custos", "Diz o e-mail"]) {
    expect(text.includes(secret)).toBe(false);
  }

  // Another workspace (self-host → Cloud): everything comes; #general is joined, not made.
  const other = await addUser(db, "bia");
  const { organization: orgB } = await createOrganization(db, other.id, { name: "Acme Cloud" });
  const into = (input: Partial<Parameters<typeof applyImport>[3]> = {}) =>
    applyImport(
      { db, blobs: f.artifactDeps.blobs, pubsub: f.pubsub },
      other.id,
      orgB.id,
      { bundle, dryRun: false, ...input },
      { model: "claude-haiku-5-5" },
    );
  const applied = await into();
  expect(applied.items.filter((i) => i.action !== "create").map((i) => [i.kind, i.label, i.action, i.reason])).toEqual([
    ["channel", "general", "update", "exists"],
  ]);
  const copy = await exportBundle(db, other.id, orgB.id);
  expect(shape(copy)).toEqual(shape(bundle));
  expect(copy.channels[0]?.key).not.toBe(general.id);
  expect((await into()).items.every((i) => i.action === "unchanged")).toBe(true);
});
