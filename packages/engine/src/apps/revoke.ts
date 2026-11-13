import { and, type Executor, eq, inArray, isNull, type SQL, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";

const { appGrants, appTokens } = schema;

/** Who ended a connection: a person in Settings, or the server (`reason` says why). */
export type RevokedBy = { type: "person"; id: string } | { type: "system"; reason: string };

/**
 * Revokes the AI app grants matching `where`, every token they have, and audits each one (ADR 0119 §1.5). The one
 * way a grant ends, so a grant connected again later never brings an old token back.
 */
export async function revokeAppGrants(tx: Executor, where: SQL | undefined, by: RevokedBy) {
  const revoked = await tx
    .update(appGrants)
    .set({ revokedAt: new Date(), revokedBy: by.type === "person" ? by.id : null })
    .where(and(where, isNull(appGrants.revokedAt)))
    .returning();
  if (revoked.length === 0) return 0;
  await revokeGrantTokens(
    tx,
    revoked.map((g) => g.id),
  );
  for (const grant of revoked) {
    await recordAudit(tx, {
      orgId: grant.orgId,
      actor: by.type === "person" ? { type: "person", id: by.id } : { type: "system", id: null },
      action: grant.kind === "oauth" ? "apps.disconnected" : "apps.token_revoked",
      target: { type: "app_grant", id: grant.id },
      details: {
        app: grant.displayName,
        ...(by.type === "system" ? { reason: by.reason } : {}),
        ...(by.type !== "person" || grant.userId !== by.id ? { personId: grant.userId } : {}),
      },
    });
  }
  return revoked.length;
}

/** Every live token of these grants. */
export async function revokeGrantTokens(tx: Executor, grantIds: string[]) {
  if (grantIds.length === 0) return;
  await tx
    .update(appTokens)
    .set({ revokedAt: new Date() })
    .where(and(inArray(appTokens.grantId, grantIds), isNull(appTokens.revokedAt)));
}

/** A new password: every app and token of the person, in every workspace, stops now. */
export const revokeUserApps = (db: Executor, userId: string) =>
  revokeAppGrants(db, eq(appGrants.userId, userId), { type: "system", reason: "password_reset" });

/** A person removed from (or leaving) a workspace: their apps and tokens there stop now. */
export const revokeMemberApps = (db: Executor, orgId: string, userId: string) =>
  revokeAppGrants(db, and(eq(appGrants.orgId, orgId), eq(appGrants.userId, userId)), {
    type: "system",
    reason: "left_workspace",
  });
