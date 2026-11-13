import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  approverIds,
  ConflictError,
  coveredFor,
  decideApproval,
  decideApprovals,
  drainOutbox,
  endCover,
  ForbiddenError,
  getMyCovers,
  highRisk,
  listApprovals,
  postPersonMessage,
  REQUEST_PERMISSION_TOOL,
  setMyCover,
  setMyStatus,
  type ToolSource,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WHY = "A pessoa pediu para gravar a meta e publicar a versão.";

const tools: ToolSource = {
  name: "ops",
  tools: async () =>
    ["goal_upsert", "deploy_app"].map((name) => ({
      name,
      description: name,
      scope: "",
      sensitive: true,
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "done" }),
    })),
};

/** The agent calls the tool its message names ("deploy" or anything else: the goal), then closes. */
const reply = (req: { messages: { content: unknown }[] }, call: number) => {
  const said = JSON.stringify(req.messages.at(-1)?.content ?? "");
  return call % 2 === 1
    ? {
        chunks: ["Vou pedir."],
        toolUses: [{ name: said.includes("deploy") ? "deploy_app" : "goal_upsert", input: { why: WHY } }],
      }
    : { chunks: ["Feito."] };
};

const deps = () => ({ db: f.db, pubsub: f.pubsub });

/** Ana owns the agent, Bruno covers her; `by` asks the agent for `body` in #general. */
async function world() {
  f = await setup({ toolSources: [tools], reply });
  // The fixture's owner is another "ana": this one is a member with no role.
  const ana = await addMember(f.db, f.org.id, "member", "ana-souza");
  const bruno = await addMember(f.db, f.org.id, "member", "bruno");
  for (const u of [ana, bruno]) {
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: u.id });
  }
  await f.db.update(schema.agents).set({ ownerUserId: ana.id }).where(eq(schema.agents.id, f.agent.id));
  return { ana, bruno };
}

async function ask(by: string, body: string) {
  await postPersonMessage(deps(), by, f.org.id, f.general.id, { body: `@dev ${body}` });
  await drainOutbox(f.db, f.handlers);
  const rows = await f.db.select().from(schema.approvals).orderBy(schema.approvals.createdAt);
  const row = rows.at(-1);
  if (!row) throw new Error("no approval");
  return row;
}

const setOut = (userId: string, out: boolean) =>
  f.db
    .update(schema.organizationMembers)
    .set({ availability: out ? "out" : "auto" })
    .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, userId)));

const cover = (from: string, to: string, extra: Partial<Parameters<typeof setMyCover>[3]> = {}) =>
  setMyCover(deps(), from, f.org.id, { userId: to, mode: "while_out", risky: false, endsAt: null, ...extra });

test("only while Ana is out: Bruno gets her approval instead of her, decides it in her name, never for good", async () => {
  const { ana, bruno } = await world();
  await cover(ana.id, bruno.id);
  // Bruno hears he covers Ana, in his inbox.
  const [told] = await f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, bruno.id), eq(schema.notifications.kind, "approval_cover")));
  expect(told?.latest).toMatchObject({ statusTo: "while_out" });

  const before = await ask(f.owner.id, "grava a meta");
  expect(before.highRisk).toBe(false);
  expect(before.requestedByUserId).toBe(f.owner.id);
  // Ana is in: hers alone (and the admins').
  expect(await approverIds(f.db, before)).not.toContain(bruno.id);
  await expect(decideApproval(deps(), bruno.id, f.org.id, before.id, { decision: "approve" })).rejects.toBeInstanceOf(
    ForbiddenError,
  );

  // Ana herself decides what is hers, out or not.
  await decideApproval(deps(), ana.id, f.org.id, before.id, { decision: "approve" });
  await drainOutbox(f.db, f.handlers);

  await setOut(ana.id, true);
  const row = await ask(f.owner.id, "grava outra meta");
  expect(row.id).not.toBe(before.id);
  const asked = await approverIds(f.db, row);
  expect(asked).toContain(bruno.id);
  expect(asked).not.toContain(ana.id);
  const inbox = await f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.kind, "approval"), eq(schema.notifications.userId, bruno.id)));
  expect(inbox).toHaveLength(1);
  const listed = await listApprovals(f.db, bruno.id, f.org.id, { status: "pending" });
  expect(listed.find((a) => a.id === row.id)?.canDecide).toBe(true);

  await expect(
    decideApproval(deps(), bruno.id, f.org.id, row.id, { decision: "approve", always: true }),
  ).rejects.toBeInstanceOf(ConflictError);
  const view = await decideApproval(deps(), bruno.id, f.org.id, row.id, { decision: "approve" });
  expect(view).toMatchObject({ status: "approved", decidedByUserId: bruno.id, decidedForUserId: ana.id });
  const [audit] = await f.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "approval.approved"), eq(schema.auditLog.targetId, row.id)));
  expect(audit).toMatchObject({ actorId: bruno.id, onBehalfOfUserId: ana.id });
});

test("merge, deploy and the like only when Ana turned them on; never what Bruno asked himself", async () => {
  const { ana, bruno } = await world();
  await cover(ana.id, bruno.id, { mode: "always" });
  const deploy = await ask(f.owner.id, "faz o deploy");
  expect(deploy.highRisk).toBe(true);
  await expect(decideApproval(deps(), bruno.id, f.org.id, deploy.id, { decision: "approve" })).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  await cover(ana.id, bruno.id, { mode: "always", risky: true });
  await decideApproval(deps(), bruno.id, f.org.id, deploy.id, { decision: "refuse" });
  await drainOutbox(f.db, f.handlers);

  // His own request: Ana or an admin decides it, even through "Aprovar tudo".
  const his = await ask(bruno.id, "grava a meta");
  expect(his.requestedByUserId).toBe(bruno.id);
  expect(await approverIds(f.db, his)).not.toContain(bruno.id);
  const bulk = await decideApprovals(deps(), bruno.id, f.org.id, { ids: [his.id], decision: "approve" }).catch(
    (e) => e,
  );
  expect(bulk).toBeInstanceOf(ForbiddenError);
  const listed = await listApprovals(f.db, bruno.id, f.org.id, { status: "pending" });
  expect(listed.find((a) => a.id === his.id)?.canDecide ?? false).toBe(false);
});

test("Ana goes out with a request waiting: it moves to Bruno's inbox, and back to hers when she returns", async () => {
  const { ana, bruno } = await world();
  await cover(ana.id, bruno.id);
  const row = await ask(f.owner.id, "grava a meta");
  const open = async (userId: string) =>
    (
      await f.db
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.kind, "approval"), eq(schema.notifications.userId, userId)))
    ).filter((n) => n.doneAt === null);
  expect(await open(ana.id)).toHaveLength(1);
  expect(await open(bruno.id)).toHaveLength(0);
  await setMyStatus(deps(), ana.id, f.org.id, { availability: "out" });
  expect(await open(ana.id)).toHaveLength(0);
  expect((await open(bruno.id)).map((n) => n.source)).toMatchObject([{ approvalId: row.id }]);
  await setMyStatus(deps(), ana.id, f.org.id, { availability: "auto" });
  expect(await open(ana.id)).toHaveLength(1);
  expect(await open(bruno.id)).toHaveLength(0);
});

test("a cover past its end decides nothing; Bruno may say no, and Ana hears it", async () => {
  const { ana, bruno } = await world();
  const soon = new Date(Date.now() + 60_000).toISOString();
  await cover(ana.id, bruno.id, { mode: "always", endsAt: soon });
  const row = await ask(f.owner.id, "grava a meta");
  const later = () => new Date(Date.now() + 120_000);
  await expect(
    decideApproval({ ...deps(), now: later }, bruno.id, f.org.id, row.id, { decision: "approve" }),
  ).rejects.toBeInstanceOf(ForbiddenError);

  const carla = await addMember(f.db, f.org.id, "member", "carla");
  await expect(endCover(deps(), carla.id, f.org.id, ana.id)).rejects.toBeInstanceOf(ForbiddenError);
  await endCover(deps(), bruno.id, f.org.id, ana.id);
  expect((await getMyCovers(f.db, ana.id, f.org.id)).cover).toBeNull();
  const [heard] = await f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, ana.id), eq(schema.notifications.kind, "approval_cover")));
  expect(heard?.latest).toMatchObject({ statusTo: "declined" });
});

test("a cover is someone else, in the workspace, ending in the future", async () => {
  const { ana, bruno } = await world();
  await expect(cover(ana.id, ana.id)).rejects.toBeInstanceOf(ValidationError);
  await expect(cover(ana.id, bruno.id, { endsAt: "2020-01-01T00:00:00Z" })).rejects.toBeInstanceOf(ValidationError);
  const outsider = await addMember(f.db, f.org.id, "member", "x");
  await f.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, outsider.id));
  await expect(cover(ana.id, outsider.id)).rejects.toBeInstanceOf(ValidationError);
  const mine = await cover(ana.id, bruno.id);
  expect(mine.cover).toMatchObject({ userId: bruno.id, mode: "while_out", active: false });
  expect((await getMyCovers(f.db, bruno.id, f.org.id)).covering).toMatchObject([{ userId: ana.id }]);
});

test("coveredFor: never a mailbox's action, access for good, or past what Ana is asked personally", () => {
  const covers = [{ fromUserId: "ana", toUserId: "bruno", risky: true, fromOut: true }];
  const base = { ownerUserId: "ana", tool: "goal_upsert", highRisk: false, requestedByUserId: null };
  expect(coveredFor(base, "bruno", covers)).toBe("ana");
  expect(coveredFor({ ...base, ownerUserId: "carla" }, "bruno", covers)).toBeNull();
  expect(coveredFor({ ...base, tool: REQUEST_PERMISSION_TOOL }, "bruno", covers)).toBeNull();
  const named = { userIds: ["ana"], label: "Ana", requestedBy: null, requesterDecides: false };
  expect(coveredFor({ ...base, ownerUserId: "carla", approvers: named }, "bruno", covers)).toBe("ana");
  expect(coveredFor({ ...base, approvers: { ...named, required: true } }, "bruno", covers)).toBeNull();
  expect(coveredFor({ ...base, approvers: { ...named, requestedBy: "bruno" } }, "bruno", covers)).toBeNull();
  expect(highRisk("GITHUB_MERGE_A_PULL_REQUEST", "")).toBe(true);
  expect(highRisk("gmail_send", "mail:send")).toBe(true);
  expect(highRisk("gmail_draft", "mail:draft")).toBe(false);
  expect(highRisk("request_approval", "")).toBe(false);
});
