import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { adminIds, approverIds, notifyComposioLimit } from "../src";
import { maySql, memberKeysSql, memberRankSql } from "../src/permissions";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const om = schema.organizationMembers;

test("a column passed to maySql keeps its table name in a single-table select, so a plain member doesn't hold the key", async () => {
  f = await setup();
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const query = f.db
    .select({
      userId: om.userId,
      may: maySql(f.org.id, om.userId, "manage_billing"),
      keys: memberKeysSql({ orgId: om.orgId, userId: om.userId }),
      rank: memberRankSql({ orgId: om.orgId, userId: om.userId }),
    })
    .from(om)
    .where(eq(om.orgId, f.org.id));
  const text = query.toSQL().sql;
  expect(text).not.toMatch(/= "(user_id|org_id)"/);
  expect(text).toContain('"organization_members"."user_id"');
  const rows = await query;
  expect(rows.find((r) => r.userId === f.owner.id)?.may).toBe(true);
  expect(rows.find((r) => r.userId === caio.id)?.may).toBe(false);
});

test("a plain member is not a billing manager, not an approver, and doesn't hear admin-only notices", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "admin", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  expect((await adminIds(f.db, f.org.id, "manage_billing")).sort()).toEqual([f.owner.id, bia.id].sort());
  expect((await adminIds(f.db, f.org.id)).sort()).toEqual([f.owner.id, bia.id].sort());
  expect((await approverIds(f.db, { orgId: f.org.id, ownerUserId: null })).sort()).toEqual([f.owner.id, bia.id].sort());
  await notifyComposioLimit({ db: f.db }, f.org.id, "2026-11", 1000);
  const told = await f.db
    .select({ userId: schema.notifications.userId })
    .from(schema.notifications)
    .where(eq(schema.notifications.orgId, f.org.id));
  expect(told.map((n) => n.userId)).not.toContain(caio.id);
  expect(told.map((n) => n.userId).sort()).toEqual([f.owner.id, bia.id].sort());
});
