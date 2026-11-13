import { afterEach, describe, expect, test } from "bun:test";
import { orgTopic, userTopic } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  askAgentToImplement,
  createIssue,
  deleteIssue,
  drainOutbox,
  ForbiddenError,
  getIssue,
  NotFoundError,
  openTaskConversation,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const deps = () => ({ db: f.db, pubsub: f.pubsub, hub: null, mail: undefined }) as Parameters<typeof deleteIssue>[0];

describe("deleting a task", () => {
  test("who created it may, someone else may not, an administrator may", async () => {
    f = await setup();
    const other = await addMember(f.db, f.org.id, "member", "Other");
    const admin = await addMember(f.db, f.org.id, "admin", "Admin");
    const mine = await createIssue({ db: f.db }, person(other.id), f.org.id, { title: "Theirs" });
    const owners = await createIssue({ db: f.db }, person(f.owner.id), f.org.id, { title: "Someone else's" });

    await expect(deleteIssue(deps(), other.id, f.org.id, owners.id)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteIssue(deps(), other.id, f.org.id, mine.id);
    await expect(getIssue(f.db, person(other.id), f.org.id, { id: mine.id })).rejects.toBeInstanceOf(NotFoundError);
    await deleteIssue(deps(), admin.id, f.org.id, owners.id);
    await expect(getIssue(f.db, person(admin.id), f.org.id, { id: owners.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a task an agent made has no person behind it: whoever may give agents work deletes it", async () => {
    f = await setup();
    const other = await addMember(f.db, f.org.id, "member", "Other");
    const made = await createIssue({ db: f.db }, person(f.owner.id), f.org.id, { title: "From an agent" });
    await f.db
      .update(schema.issues)
      .set({ createdByType: "agent", createdById: f.agent.id })
      .where(eq(schema.issues.id, made.id));
    await deleteIssue(deps(), other.id, f.org.id, made.id);
    expect(await f.db.select().from(schema.issues).where(eq(schema.issues.id, made.id))).toHaveLength(0);
  });

  test("its steps go with it, its number isn't given again, and the audit log keeps it", async () => {
    f = await setup();
    const parent = await createIssue({ db: f.db }, person(f.owner.id), f.org.id, { title: "The plan" });
    const step = await createIssue({ db: f.db }, person(f.owner.id), f.org.id, {
      title: "A step",
      parentIssueId: parent.id,
    });
    const inner = await createIssue({ db: f.db }, person(f.owner.id), f.org.id, {
      title: "A step of the step",
      parentIssueId: step.id,
    });
    await deleteIssue(deps(), f.owner.id, f.org.id, parent.id);
    expect(await f.db.select().from(schema.issues).where(eq(schema.issues.orgId, f.org.id))).toHaveLength(0);
    const next = await createIssue({ db: f.db }, person(f.owner.id), f.org.id, { title: "Next" });
    expect(next.number).toBe(inner.number + 1);
    const [row] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "issue.deleted")));
    expect(row?.details).toMatchObject({ number: parent.number, title: "The plan", steps: 2 });
  });

  test("a step this person can't see stays, as a task of its own; one an agent works on stops with the rest", async () => {
    f = await setup({ issueTools: true, reply: () => ({ chunks: ["ok"] }) });
    const member = await addMember(f.db, f.org.id, "member", "Member");
    const parent = await createIssue({ db: f.db }, person(member.id), f.org.id, { title: "The plan" });
    const seen = await createIssue({ db: f.db }, person(f.owner.id), f.org.id, {
      title: "Seen",
      parentIssueId: parent.id,
    });
    const hidden = await createIssue({ db: f.db }, person(f.owner.id), f.org.id, {
      title: "Hidden",
      parentIssueId: parent.id,
    });
    const [room] = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "closed", kind: "channel", visibility: "private" } as never)
      .returning();
    await f.db
      .update(schema.issues)
      .set({ channelId: room?.id as string })
      .where(eq(schema.issues.id, hidden.id));
    await askAgentToImplement({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, seen.id, f.agent.id);
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.issueId, seen.id));

    await deleteIssue(deps(), member.id, f.org.id, parent.id);

    const left = await f.db.select().from(schema.issues).where(eq(schema.issues.orgId, f.org.id));
    expect(left.map((i) => [i.id, i.parentIssueId])).toEqual([[hidden.id, null]]);
    const [stopped] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, run?.id as string));
    expect(stopped?.status).toBe("canceled");
  });

  test("what an agent is doing on it stops, and its conversation is deleted and purged", async () => {
    f = await setup({ issueTools: true, reply: () => ({ chunks: ["ok"] }) });
    const issue = await createIssue({ db: f.db }, person(f.owner.id), f.org.id, { title: "Working" });
    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, issue.id);
    await askAgentToImplement({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, issue.id, f.agent.id);
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.issueId, issue.id));
    expect(run?.status).toBe("queued");

    await deleteIssue(deps(), f.owner.id, f.org.id, issue.id);

    const [stopped] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, run?.id as string));
    expect(stopped?.status).toBe("canceled");
    expect(stopped?.issueId).toBeNull();
    const [room] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, at.channelId));
    expect(room?.deletedAt).not.toBeNull();
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, at.channelId))).toHaveLength(
      0,
    );
  });

  test("a limited task's end reaches who sees it, not the workspace", async () => {
    f = await setup();
    const named = await addMember(f.db, f.org.id, "member", "Named");
    const admin = await addMember(f.db, f.org.id, "admin", "Admin");
    const other = await addMember(f.db, f.org.id, "member", "Other");
    const issue = await createIssue({ db: f.db }, person(named.id), f.org.id, {
      title: "Limited",
      audience: { mode: "people", userIds: [named.id] },
    });
    const heard: string[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), () => heard.push("workspace"));
    for (const [name, id] of [
      ["named", named.id],
      ["admin", admin.id],
      ["other", other.id],
    ] as const)
      f.pubsub.subscribe(userTopic(f.org.id, id), () => heard.push(name));

    await deleteIssue(deps(), named.id, f.org.id, issue.id);

    expect(heard.sort()).toEqual(["admin", "named"]);
  });

  test("a public channel's task is the workspace's: its end reaches who isn't in the channel too", async () => {
    f = await setup();
    await addMember(f.db, f.org.id, "member", "Outside");
    const issue = await createIssue({ db: f.db }, person(f.owner.id), f.org.id, {
      title: "Public",
      channelId: f.general.id,
    });
    expect(issue.audience.mode).toBe("everyone");
    const heard: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (event) => heard.push(event));

    await deleteIssue(deps(), f.owner.id, f.org.id, issue.id);

    expect(heard).toContainEqual(
      expect.objectContaining({ event: expect.objectContaining({ type: "issue.deleted", issueId: issue.id }) }),
    );
  });

  test("everyone's notifications about it go", async () => {
    f = await setup();
    const issue = await createIssue({ db: f.db }, person(f.owner.id), f.org.id, { title: "Told" });
    await f.db.insert(schema.notifications).values({
      orgId: f.org.id,
      userId: f.owner.id,
      kind: "issue_assigned",
      groupKey: `issue:${issue.id}`,
      source: { issueId: issue.id },
      latest: {},
    } as never);
    await deleteIssue(deps(), f.owner.id, f.org.id, issue.id);
    expect(await f.db.select().from(schema.notifications).where(eq(schema.notifications.orgId, f.org.id))).toHaveLength(
      0,
    );
  });
});
