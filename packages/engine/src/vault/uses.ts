/**
 * Every use of a Vault item (ADR 0144): a row in `vault_uses` (the item's "Recent uses") and, for what an agent typed
 * or gave to a command, a line in the audit log. Never the value. A login's
 * place is kept as its origin only: a page's path or query may carry a token.
 */
import { vaultOrigin } from "@agenteschat/adapters";
import { and, desc, type Executor, eq, inArray, type SQL, schema, sql } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { UUID } from "../authority";
import { type VaultRunPerson, vaultPersonOfRun } from "./access";
import {
  VAULT_USE_ACTIONS,
  type VaultDeps,
  type VaultRun,
  type VaultUse,
  type VaultUseAction,
  vaultNow,
} from "./service";

const { routines, vaultItems, vaultUses } = schema;

/** The routine's id when it is still there (a deleted one leaves the use without it, as its row would). */
function routineRef(orgId: string, routineId: string | null): SQL | null {
  if (!routineId || !UUID.test(routineId)) return null;
  return sql`(select ${routines.id} from ${routines}
    where ${routines.id} = ${routineId}::uuid and ${routines.orgId} = ${orgId}::uuid)`;
}

type PersonUse = Extract<VaultUseAction, "create" | "edit">;

/** What a person did with an item (create, edit), in the caller's transaction. */
export async function recordPersonUse(
  db: Executor,
  input: { orgId: string; itemId: string; userId: string; action: PersonUse },
) {
  await db.insert(vaultUses).values({
    orgId: input.orgId,
    itemId: input.itemId,
    action: input.action,
    userId: input.userId,
  });
}

/** What an agent did with an item (create or edit, through `vault_save`), in the caller's transaction. */
export async function recordAgentChange(
  db: Executor,
  run: VaultRun,
  person: VaultRunPerson,
  itemId: string,
  action: "create" | "edit",
) {
  await db.insert(vaultUses).values({
    orgId: run.orgId,
    itemId,
    action,
    agentId: run.agentId,
    onBehalfOfUserId: person.personId,
    runId: run.runId,
    routineId: routineRef(run.orgId, person.routineId),
  });
}

/**
 * An agent typed a login (`fill`, after its computer said it did) or gave a key to a command (`key`, once the
 * command started): the use, the item's last use and the audit line (`vault.item_used`, with the origin, the run
 * and the person it worked for). A use isn't a change to the Vault: no `vault.changed` goes to every open app for it
 * (ADR 0144 §7), so agents at work don't make every app reload the list.
 */
export async function recordVaultUse(
  deps: Pick<VaultDeps, "db" | "now">,
  run: VaultRun,
  itemId: string,
  use: { action: "fill" | "key"; origin?: string },
): Promise<void> {
  if (!UUID.test(itemId)) return;
  const { db } = deps;
  const [item] = await db
    .select({ id: vaultItems.id, kind: vaultItems.kind, title: vaultItems.title })
    .from(vaultItems)
    .where(and(eq(vaultItems.orgId, run.orgId), eq(vaultItems.id, itemId)));
  if (!item) return;
  const person = await vaultPersonOfRun(db, run);
  const origin = use.origin ? vaultOrigin(use.origin) : null;
  const now = vaultNow(deps);
  await db.transaction(async (tx) => {
    await tx.insert(vaultUses).values({
      orgId: run.orgId,
      itemId,
      action: use.action,
      agentId: run.agentId,
      onBehalfOfUserId: person.personId,
      runId: run.runId,
      routineId: routineRef(run.orgId, person.routineId),
      origin,
      createdAt: now,
    });
    await tx.update(vaultItems).set({ lastUsedAt: now }).where(eq(vaultItems.id, itemId));
    await recordAudit(tx, {
      orgId: run.orgId,
      actor: { type: "agent", id: run.agentId },
      action: "vault.item_used",
      target: { type: "vault_item", id: itemId },
      details: { kind: item.kind, title: item.title, use: use.action, ...(origin ? { origin } : {}) },
      runId: run.runId,
      onBehalfOfUserId: person.personId,
    });
  });
}

/** An agent read contacts' fields: one `read` per item and run, however often it lists them. */
export async function recordReads(
  deps: Pick<VaultDeps, "db" | "now">,
  run: VaultRun,
  person: VaultRunPerson,
  itemIds: string[],
): Promise<void> {
  if (itemIds.length === 0) return;
  const { db } = deps;
  const seen = new Set(
    (
      await db
        .select({ itemId: vaultUses.itemId })
        .from(vaultUses)
        .where(
          and(
            eq(vaultUses.orgId, run.orgId),
            eq(vaultUses.runId, run.runId),
            eq(vaultUses.action, "read"),
            inArray(vaultUses.itemId, itemIds),
          ),
        )
    ).map((r) => r.itemId),
  );
  const fresh = itemIds.filter((id) => !seen.has(id));
  if (fresh.length === 0) return;
  const now = vaultNow(deps);
  const routineId = routineRef(run.orgId, person.routineId);
  await db.transaction(async (tx) => {
    await tx.insert(vaultUses).values(
      fresh.map((itemId) => ({
        orgId: run.orgId,
        itemId,
        action: "read",
        agentId: run.agentId,
        onBehalfOfUserId: person.personId,
        runId: run.runId,
        routineId,
        createdAt: now,
      })),
    );
    await tx
      .update(vaultItems)
      .set({ lastUsedAt: now })
      .where(and(eq(vaultItems.orgId, run.orgId), inArray(vaultItems.id, fresh)));
  });
}

/** An item's newest uses, newest first. */
export async function listUses(db: Executor, orgId: string, itemId: string, limit = 30): Promise<VaultUse[]> {
  const rows = await db
    .select({
      id: vaultUses.id,
      action: vaultUses.action,
      agentId: vaultUses.agentId,
      userId: vaultUses.userId,
      onBehalfOfUserId: vaultUses.onBehalfOfUserId,
      routineName: routines.name,
      origin: vaultUses.origin,
      at: vaultUses.createdAt,
    })
    .from(vaultUses)
    .leftJoin(routines, eq(routines.id, vaultUses.routineId))
    // Only the actions this version records: a row of any other kind isn't listed.
    .where(
      and(eq(vaultUses.orgId, orgId), eq(vaultUses.itemId, itemId), inArray(vaultUses.action, [...VAULT_USE_ACTIONS])),
    )
    .orderBy(desc(vaultUses.createdAt), desc(vaultUses.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    action: r.action as VaultUseAction,
    agentId: r.agentId,
    userId: r.userId,
    onBehalfOfUserId: r.onBehalfOfUserId,
    routineName: r.routineName ?? null,
    origin: r.origin,
    at: r.at.toISOString(),
  }));
}
