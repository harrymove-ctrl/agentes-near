import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  actionHash,
  approverIds,
  createRole,
  decideApproval,
  decidingKeys,
  drainOutbox,
  ensureRightHand,
  ForbiddenError,
  getApproval,
  listApprovals,
  missingPermissions,
  orgOverview,
  postPersonMessage,
  RIGHT_HAND,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { runContext } from "./mail-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);

const WHY = "I need a person's answer before I go on: this decides what I change next.";

/** Asks for the browser for "open the site"; says what came back. */
const reply = (req: ModelRequest) => {
  const last = lastText(req);
  if (last.includes("tool_result")) return { chunks: [last.includes("Turned on") ? "Ligado." : "Sem navegador."] };
  if (last.includes("open the site"))
    return {
      chunks: [],
      toolUses: [
        {
          name: "request_permission",
          input: {
            why: WHY,
            permission: "browser:use",
          },
        },
      ],
    };
  return { chunks: ["Feito."] };
};

const scopes = async () =>
  (
    await f.db
      .select({ scope: schema.agentScopes.scope })
      .from(schema.agentScopes)
      .where(eq(schema.agentScopes.agentId, f.agent.id))
  ).map((s) => s.scope);

test("a missing permission becomes an approval card; approving turns it on and the run goes on", async () => {
  f = await setup({ permissionTools: true, reply });
  expect((await missingPermissions({ db: f.db, orgId: f.org.id, agentId: f.agent.id })).map((m) => m.id)).toContain(
    "browser:use",
  );
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev open the site",
  });
  await drainOutbox(f.db, f.handlers);

  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_approval");
  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  expect(approval).toMatchObject({ tool: "request_permission", title: "Turn on: Use a browser" });
  expect(approval?.why).toBe(WHY);
  expect(approval?.detail).toBe("");
  expect(await scopes()).not.toContain("browser:use");

  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, f.handlers);

  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(await scopes()).toContain("browser:use");
  expect((await missingPermissions({ db: f.db, orgId: f.org.id, agentId: f.agent.id })).map((m) => m.id)).not.toContain(
    "browser:use",
  );
});

test("a card asked with the old `reason` field still turns the permission on", async () => {
  f = await setup({ permissionTools: true, reply });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev open the site",
  });
  await drainOutbox(f.db, f.handlers);
  const [approval] = await f.db.select().from(schema.approvals);
  if (!approval) throw new Error("no approval");
  const params = { ...approval.params, reason: "Open the landing page." };
  const { tool, scope, connectionId } = approval;
  await f.db
    .update(schema.approvals)
    .set({ params, actionHash: actionHash({ tool, scope, connectionId, params }) })
    .where(eq(schema.approvals.id, approval.id));
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval.id, { decision: "approve" });
  await drainOutbox(f.db, f.handlers);
  expect(await scopes()).toContain("browser:use");
});

test("the right hand can't ask: its tools are fixed in code, so an approved card would turn on nothing", async () => {
  f = await setup({ permissionTools: true, reply });
  await ensureRightHand(f.db, f.org.id);
  const [lodi] = await f.db.select().from(schema.agents).where(eq(schema.agents.builtin, RIGHT_HAND));
  const ctx = await runContext(f);
  const names = async (agentId: string) => ((await f.tools?.list({ ...ctx, agentId })) ?? []).map((t) => t.name);
  expect(await names(f.agent.id)).toContain("request_permission");
  expect(await names(lodi?.id ?? "")).not.toContain("request_permission");
});

test("refused: nothing is turned on", async () => {
  f = await setup({ permissionTools: true, reply });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev open the site",
  });
  await drainOutbox(f.db, f.handlers);
  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "refuse",
  });
  await drainOutbox(f.db, f.handlers);
  expect(await scopes()).not.toContain("browser:use");
});

test("only admins decide it: the agent's owner who isn't one can't give the agent more", async () => {
  f = await setup({ permissionTools: true, reply });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev open the site",
  });
  await drainOutbox(f.db, f.handlers);
  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  expect(approval).toMatchObject({ tool: "request_permission", ownerUserId: bia.id, canDecide: true });
  // Bia sees it (her agent's) but may not decide it, and isn't asked.
  const [hers] = await listApprovals(f.db, bia.id, f.org.id, { status: "pending" });
  expect(hers).toMatchObject({ id: approval?.id, canDecide: false });
  expect(await approverIds(f.db, { orgId: f.org.id, ownerUserId: bia.id, tool: "request_permission" })).toEqual([
    f.owner.id,
  ]);
  await expect(
    decideApproval({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, approval?.id ?? "", { decision: "approve" }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(await scopes()).not.toContain("browser:use");
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, f.handlers);
  expect(await scopes()).toContain("browser:use");
});

test("turning on access is decided by who gives it on the agent's page, not by approving actions; the grant is theirs", async () => {
  f = await setup({ permissionTools: true, reply });
  const sup = await addMember(f.db, f.org.id, "member", "sup");
  const lead = await addMember(f.db, f.org.id, "member", "lead");
  const approves = await createRole(f.db, f.owner.id, f.org.id, {
    name: "Supervisor",
    permissions: ["approve_actions"],
  });
  const manages = await createRole(f.db, f.owner.id, f.org.id, { name: "Agentes", permissions: ["manage_agents"] });
  await f.db.insert(schema.organizationMemberRoles).values([
    { orgId: f.org.id, userId: sup.id, roleId: approves.id },
    { orgId: f.org.id, userId: lead.id, roleId: manages.id },
  ]);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev open the site",
  });
  await drainOutbox(f.db, f.handlers);
  const [row] = await f.db.select().from(schema.approvals);
  if (!row) throw new Error("no approval");

  expect((await approverIds(f.db, row)).sort()).toEqual([f.owner.id, lead.id].sort());
  const [supView] = await listApprovals(f.db, sup.id, f.org.id, { status: "pending" });
  expect(supView?.canDecide).toBe(false);
  expect((await orgOverview(f.db, sup.id, f.org.id)).approvalsWaitingForMe).toBe(0);
  await expect(
    decideApproval({ db: f.db, pubsub: f.pubsub }, sup.id, f.org.id, row.id, { decision: "approve" }),
  ).rejects.toBeInstanceOf(ForbiddenError);

  expect((await orgOverview(f.db, lead.id, f.org.id)).approvalsWaitingForMe).toBe(1);
  // Outside the channel, they still find and open what they decide.
  await f.db.delete(schema.channelMembers).where(eq(schema.channelMembers.userId, lead.id));
  const [leadView] = await listApprovals(f.db, lead.id, f.org.id, { status: "pending" });
  expect(leadView?.id).toBe(row.id);
  expect((await getApproval(f.db, lead.id, f.org.id, row.id)).canDecide).toBe(true);
  await decideApproval({ db: f.db, pubsub: f.pubsub }, lead.id, f.org.id, row.id, { decision: "approve" });
  await drainOutbox(f.db, f.handlers);
  const [grant] = await f.db
    .select()
    .from(schema.agentScopes)
    .where(and(eq(schema.agentScopes.agentId, f.agent.id), eq(schema.agentScopes.scope, "browser:use")));
  expect(grant?.grantedByUserId).toBe(lead.id);
  // A browser profile also needs managing connectors, as on the agent's page.
  expect(decidingKeys({ tool: "request_permission", params: { permission: "browser-profile:p1" } })).toEqual([
    "manage_agents",
    "manage_connectors",
  ]);
});
