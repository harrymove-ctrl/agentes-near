import type { PubSub, SecretRequest } from "@agenteschat/adapters";
import { parseSecretBox, SECRET_NAME, type SecretTarget, SITE_SECRET_TTL_MS, secretAad } from "@agenteschat/adapters";
import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { recordAudit } from "./audit";
import { consultedFor } from "./consultations";
import { isAgentOnlyDm } from "./dms";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent } from "./events";
import { MachineRequestError } from "./machine-hub";
import { REMOVED_COMPUTER_MESSAGE } from "./machines";
import { notifySecretRequest, resolveSecretRequestNotifications } from "./notification-producers";
import { requireActiveMembership } from "./organizations";
import { enqueue } from "./outbox";
import { personBehindCall } from "./requester";
import {
  type ComputerHandle,
  requireComputerManager,
  type SandboxDeps,
  withConnectedMachine,
  withSandbox,
} from "./sandbox";
import type { ToolContext } from "./tools/types";

const { secretRequests, agentRuns } = schema;

export type SecretRequestRow = typeof secretRequests.$inferSelect;

export const REQUEST_SECRET_TOOL = "request_secret";
export const MAKE_KEY_TOOL = "vault_make_password";
/** How long a request waits for the person before the run goes on without it. */
export const SECRET_TTL_MS = 15 * 60_000;
/** Pending requests one run may have at a time. */
export const MAX_PENDING_SECRETS = 3;

/** What the app renders (`meta.secretRequest`, `secret.requested` / `secret.updated`). Never the value. */
export interface SecretRequestView {
  id: string;
  agentId: string;
  channelId: string;
  threadId: string | null;
  messageId: string | null;
  requestedForUserId: string;
  /** The agent's own name for it (`GITHUB_TOKEN`), for the box's binding: people read `label`, never this. */
  name: string;
  /** What people read, when the agent gave one (`Senha da Conta Google`); else the apps derive one. */
  label: string | null;
  purpose: string;
  target: SecretTarget;
  /** For a browser password: the only site it may be typed on (`https://host`). */
  site: string | null;
  /** A site password's username, when the agent gave it: the card shows it and saves it to the Vault (ADR 0144). */
  username: string | null;
  /** A one-time code: one box per digit on the card (ADR 0144), never saved. Null for anything else. */
  codeDigits: number | null;
  /** The connected machine that holds it (ADR 0025). */
  machineId: string | null;
  /** Only useful while pending: the browser seals the value to it. */
  publicKey: string | null;
  status: "pending" | "delivered" | "declined" | "expired" | "canceled";
  expiresAt: string;
  deliveredAt: string | null;
  removed: boolean;
  /** The agent took it back (`withdraw_request`): it no longer needs it. */
  withdrawn?: true;
  /** Why it closed with nobody answering. Null: answered, expired, or closed before this was kept. */
  endReason: SecretRequestRow["endReason"];
  /** The newer request that took its place, when one did. */
  supersededBy: string | null;
  /** The agent already held this name on this computer: a delivery replaces that value. */
  replaces: boolean;
}

const targetOf = (row: Pick<SecretRequestRow, "targetKind" | "targetPath" | "site">): SecretTarget =>
  row.targetKind === "file" && row.targetPath
    ? { kind: "file", path: row.targetPath }
    : row.targetKind === "site" && row.site
      ? { kind: "site", site: row.site }
      : { kind: "env" };

/**
 * A delivered secret still on its computer, for a select over `secret_requests` (ADR 0144 §6): a site's password
 * lives in the runner's memory only, for `SITE_SECRET_TTL_MS` from its delivery, so an older `site` delivery counts
 * as gone (never told to the agent as held, never listed on its page, never "replaced" by a new request).
 */
export const secretStillHeld = (now = new Date()) =>
  or(
    ne(secretRequests.targetKind, "site"),
    gt(secretRequests.deliveredAt, new Date(now.getTime() - SITE_SECRET_TTL_MS)),
  );

/** A `site` delivery past the time its runner keeps it in memory (`secretStillHeld`, row by row). */
export const siteSecretGone = (row: Pick<SecretRequestRow, "targetKind" | "deliveredAt">, now = new Date()) =>
  row.targetKind === "site" && (!row.deliveredAt || now.getTime() - row.deliveredAt.getTime() >= SITE_SECRET_TTL_MS);

/** How long a site's password stays on the computer, in words ("15 minutes"). */
export const SITE_SECRET_TTL_TEXT = `${SITE_SECRET_TTL_MS / 60_000} minutes`;

/** Pending but past its deadline counts as expired (the worker closes it within a minute). */
function statusOf(row: SecretRequestRow, now = new Date()): SecretRequestView["status"] {
  if (row.status === "pending" && row.expiresAt <= now) return "expired";
  return row.status;
}

export function secretRequestView(row: SecretRequestRow): SecretRequestView {
  const status = statusOf(row);
  return {
    id: row.id,
    agentId: row.agentId,
    channelId: row.channelId,
    threadId: row.threadId,
    messageId: row.messageId,
    requestedForUserId: row.requestedForUserId,
    name: row.name,
    label: row.label ?? null,
    purpose: row.purpose,
    target: targetOf(row),
    site: row.site,
    username: row.username ?? null,
    codeDigits: row.codeDigits ?? null,
    machineId: row.machineId,
    publicKey: status === "pending" ? row.publicKey : null,
    status,
    expiresAt: row.expiresAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    removed: row.removedAt !== null,
    replaces: row.replaces,
    ...(row.endReason === "withdrawn" ? { withdrawn: true as const } : {}),
    endReason: row.endReason ?? null,
    supersededBy: row.supersededBy ?? null,
  };
}

/**
 * What people read for a request outside the card (a message's preview, the audit, the Vault): the agent's label, else
 * the site, else its name in plain words. The variable-style name stays with the agent.
 */
export function secretLabelOf(row: Pick<SecretRequestRow, "label" | "site" | "name">): string {
  if (row.label) return row.label;
  if (row.site) return new URL(row.site).host;
  const words = row.name.replaceAll("_", " ").toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** What the model hears back once the request is closed. Never the value. */
export function secretResult(row: SecretRequestRow | undefined): { content: string; isError?: boolean } {
  if (!row) return { content: "The secret request is gone.", isError: true };
  if (row.status === "delivered" && row.removedAt)
    return {
      content: `${row.name} was replaced or removed before this run could use it. Ask the person for it again if needed.`,
      isError: true,
    };
  const target = targetOf(row);
  switch (row.status) {
    case "delivered":
      if (target.kind === "site") {
        const host = new URL(target.site).host;
        // A one-time code and the account's username, when the request had them (ADR 0144).
        const code = row.codeDigits
          ? ` It is a ${row.codeDigits}-digit code: type it now, into the code field; when the site shows one box per digit, give \`targets\` with every box in order.`
          : "";
        const user = row.username
          ? ` The account is ${JSON.stringify(row.username)}: type that yourself (a \`fill\` step) where the site asks for it.`
          : "";
        return {
          content: `${row.name} was delivered to your computer for ${host}${row.replaces ? ", replacing the one you had" : ""}: your browser types it there (browser_type_secret, or a type_secret step), only into a password or code field on that site, within ${SITE_SECRET_TTL_TEXT} (it is kept in your computer's memory only). It isn't in your commands' environment; for a command, ask for it again without \`site\`.${code}${user}`,
        };
      }
      return {
        content: `${row.name} was delivered to your computer${row.replaces ? ", replacing the one you had" : ""}: ${
          target.kind === "file"
            ? `written to ${target.path} (mode 600)`
            : `available as the environment variable ${row.name} in your commands`
        }. Use it by name; never print, echo or show its value (outputs show it as [secret:${row.name}]).`,
      };
    case "declined":
      return {
        content: `The person declined to give ${row.name}. Don't ask again in this conversation; say what you can do without it.`,
      };
    case "canceled":
      if (row.endReason === "superseded") {
        return {
          content: `A newer request for ${row.name} took this one's place: the run that asked it goes on with it. Don't ask again here.`,
          isError: true,
        };
      }
      if (row.endReason === "computer_changed") {
        return {
          content: `The request for ${row.name} can't be answered: it was asked on a computer you no longer use, or that lost its key. Ask again if you still need it.`,
          isError: true,
        };
      }
      return { content: `The request for ${row.name} was withdrawn: it won't come.`, isError: true };
    default:
      return {
        content: `No one gave ${row.name} within 15 minutes. Say what you still need; you may ask again if the person wants.`,
      };
  }
}

export async function syncSecretMessage(
  db: Executor,
  row: SecretRequestRow,
  view: SecretRequestView = secretRequestView(row),
) {
  if (!row.messageId) return;
  await db
    .update(schema.messages)
    .set({
      meta: sql`jsonb_set(${schema.messages.meta}, '{secretRequest}', coalesce(${schema.messages.meta}->'secretRequest', '{}'::jsonb) || ${JSON.stringify(view)}::jsonb)`,
    })
    .where(and(eq(schema.messages.id, row.messageId), eq(schema.messages.orgId, row.orgId)));
}

/**
 * A request was asked or changed: its card, wherever it shows. The person asked hears a new one where they wait for
 * things (`notifySecretRequest`), and once it is closed it leaves there.
 */
export async function publishSecret(
  deps: { db: Database; pubsub?: PubSub },
  row: SecretRequestRow,
  type: "secret.requested" | "secret.updated",
  view: SecretRequestView = secretRequestView(row),
) {
  await publishChannelEvent(deps.pubsub, {
    type,
    channelId: row.channelId,
    threadId: row.threadId,
    secretRequest: view,
  });
  if (type === "secret.requested") await notifySecretRequest(deps, row).catch(() => undefined);
  else if (statusOf(row) !== "pending")
    await resolveSecretRequestNotifications(deps, row.orgId, row.id).catch(() => undefined);
}

const resumeJob = (row: SecretRequestRow) => ({
  orgId: row.orgId,
  kind: "agent_run.execute",
  payload: { runId: row.runId },
  dedupeKey: `agent_run.execute:${row.runId}:secret:${row.id}`,
  maxAttempts: 4,
});

/** A stable winner when two requests for the same name overlap. */
const deliveryOrder = (row: SecretRequestRow) => {
  if (!row.deliveredAt) throw new Error("A delivered secret has no delivery time");
  return `${row.deliveredAt.toISOString()}|${row.id}`;
};

/**
 * A request that ended (`secret.closed`), with how it ended so the card can say it even if it can't read the request
 * again. A computer that can't take it now answers its own code, and it stays open.
 */
const closedRequest = (row: SecretRequestRow) =>
  new ConflictError("This request was already answered or expired", "secret.closed", {
    status: statusOf(row),
    endReason: row.endReason,
  });

/** `closedRequest` as the request stands now: what ended it happened after `row` was read. */
async function closedNow(db: Database, row: SecretRequestRow) {
  const [current] = await db.select().from(secretRequests).where(eq(secretRequests.id, row.id));
  return closedRequest(current ?? row);
}

/** The computer that made the request's key is no longer the agent's, was removed, or no longer has the key. */
const keyIsGone = (error: unknown) =>
  (error instanceof ConflictError && error.code === "secret.computer_changed") ||
  (error instanceof Error && error.message === REMOVED_COMPUTER_MESSAGE) ||
  (error instanceof Error && error.cause instanceof MachineRequestError && error.cause.code === "not_found");

/** Closes a waiting request nobody answered: its card says why, its run goes on, the computer drops its key. */
async function closeInTx(tx: Executor, row: SecretRequestRow, set: Partial<SecretRequestRow>) {
  const [closed] = await tx
    .update(secretRequests)
    .set({ status: "canceled", ...set })
    .where(and(eq(secretRequests.id, row.id), eq(secretRequests.status, "pending")))
    .returning();
  if (!closed) return null;
  await syncSecretMessage(tx, closed);
  await enqueue(tx, resumeJob(closed));
  await enqueueSecretDiscard(tx, closed);
  return closed;
}

async function closeRequest(
  deps: { db: Database; pubsub?: PubSub },
  row: SecretRequestRow,
  endReason: NonNullable<SecretRequestRow["endReason"]>,
) {
  const closed = await deps.db.transaction((tx) => closeInTx(tx, row, { endReason }));
  if (closed) await publishSecret(deps, closed, "secret.updated");
}

/**
 * A newer request for the same thing, of the same person and account, takes the place of what is still open (asked by
 * another run: the same run waits on its own): two live cards for one password would each take a value, and the first
 * answer would go for nothing. One that closed unanswered within its time (its run stopped) points to the newer one
 * too. Another person's request is their own: they couldn't open this one, and it isn't their account.
 */
export async function supersedeOlderSecretRequests(deps: { db: Database; pubsub?: PubSub }, newer: SecretRequestRow) {
  const older = await deps.db
    .select()
    .from(secretRequests)
    .where(
      and(
        eq(secretRequests.orgId, newer.orgId),
        eq(secretRequests.agentId, newer.agentId),
        eq(secretRequests.name, newer.name),
        eq(secretRequests.requestedForUserId, newer.requestedForUserId),
        ne(secretRequests.id, newer.id),
        isNull(secretRequests.supersededBy),
        gt(secretRequests.expiresAt, sql`now()`),
        or(eq(secretRequests.status, "pending"), eq(secretRequests.status, "canceled")),
        sql`${secretRequests.site} is not distinct from ${newer.site}`,
        sql`${secretRequests.targetPath} is not distinct from ${newer.targetPath}`,
        sql`${secretRequests.username} is not distinct from ${newer.username}`,
      ),
    );
  for (const row of older) {
    const closed = await deps.db.transaction(async (tx) => {
      if (row.status === "pending") return closeInTx(tx, row, { endReason: "superseded", supersededBy: newer.id });
      const [pointed] = await tx
        .update(secretRequests)
        .set({ supersededBy: newer.id })
        .where(eq(secretRequests.id, row.id))
        .returning();
      if (pointed) await syncSecretMessage(tx, pointed);
      return pointed ?? null;
    });
    if (closed) await publishSecret(deps, closed, "secret.updated");
  }
}

/** One secret action on the computer: the runner keeps the key and the value (runner protocol 3, ADR 0027). */
export async function secretOnComputer(
  computer: ComputerHandle,
  request: SecretRequest,
): Promise<{ publicKey?: string; sites?: boolean; size?: number; superseded?: boolean }> {
  return computer.provider.secret(computer.id, request);
}

/** Files on the agent's computers that hold secrets: the file tools refuse them. */
export async function secretFilePaths(db: Database, orgId: string, agentId: string, machineId: string) {
  const rows = await db
    .select({ path: secretRequests.targetPath })
    .from(secretRequests)
    .where(
      and(
        eq(secretRequests.orgId, orgId),
        eq(secretRequests.agentId, agentId),
        eq(secretRequests.status, "delivered"),
        eq(secretRequests.targetKind, "file"),
        isNull(secretRequests.removedAt),
        eq(secretRequests.machineId, machineId),
      ),
    );
  return rows.flatMap((r) => (r.path ? [r.path] : []));
}

/** The run's context, rebuilt for actions people take on a request (deliver, remove). */
async function runContext(db: Database, row: SecretRequestRow): Promise<ToolContext> {
  const [run] = await db
    .select({ threadRootId: agentRuns.threadRootId, triggerMessageId: agentRuns.triggerMessageId })
    .from(agentRuns)
    .where(eq(agentRuns.id, row.runId));
  return {
    db,
    orgId: row.orgId,
    agentId: row.agentId,
    runId: row.runId,
    channelId: row.channelId,
    threadRootId: run?.threadRootId ?? row.channelId,
    triggerMessageId: run?.triggerMessageId ?? row.channelId,
  };
}

/** The same computer that made the key, or a clear refusal (the agent was moved meanwhile). */
async function onRequestComputer<T>(
  deps: SandboxDeps,
  row: SecretRequestRow,
  fn: (computer: ComputerHandle) => Promise<T>,
  allowPaused = false,
  directMachine = false,
): Promise<T> {
  const ctx = await runContext(deps.db, row);
  // Browser passwords and owner removals use the original machine even if
  // the agent moved or the org later switched off code execution.
  if ((row.site || directMachine) && row.machineId) {
    if (!deps.machines)
      throw new ConflictError("Connected computers are not available on this server", "secret.computer_changed");
    const agent = await getAgentCached(deps.db, row.orgId, row.agentId);
    return withConnectedMachine(
      deps.machines.hub,
      ctx,
      { machineId: row.machineId, handle: agent?.handle ?? "agent", ...(agent?.name ? { name: agent.name } : {}) },
      fn,
      { allowPaused },
    );
  }
  return withSandbox(
    deps,
    ctx,
    async (computer) => {
      if (computer.machineId !== row.machineId) {
        throw new ConflictError("The agent changed computers since it asked. Ask it again.", "secret.computer_changed");
      }
      return fn(computer);
    },
    { allowPaused },
  );
}

async function loadForRequester(db: Database, actorId: string, orgId: string, requestId: string) {
  // Asked as a member: someone removed since, or in a closed workspace, can't read or answer it.
  await requireActiveMembership(db, actorId, orgId);
  const [row] = await db
    .select()
    .from(secretRequests)
    .where(and(eq(secretRequests.id, requestId), eq(secretRequests.orgId, orgId)));
  // Someone else's request doesn't exist for you.
  if (!row || row.requestedForUserId !== actorId) throw new NotFoundError("Secret request not found");
  return row;
}

export async function getSecretRequest(db: Database, actorId: string, orgId: string, requestId: string) {
  return secretRequestView(await loadForRequester(db, actorId, orgId, requestId));
}

/** Resolve an uncertain or lost delivery commit without deleting another caller's staged box. */
async function reconcileStagedDelivery(
  deps: SandboxDeps & { pubsub?: PubSub },
  row: SecretRequestRow,
): Promise<SecretRequestView | null> {
  let current: SecretRequestRow | undefined;
  try {
    [current] = await deps.db.select().from(secretRequests).where(eq(secretRequests.id, row.id));
  } catch {
    // The DB may have committed before its reply was lost. Keep the staged box
    // for the durable activation job until the outcome can be read.
    return null;
  }
  if (current?.status === "delivered") {
    await activateDeliveredSecret(deps, row.orgId, row.id);
    const [latest] = await deps.db.select().from(secretRequests).where(eq(secretRequests.id, row.id));
    return secretRequestView(latest ?? current);
  }
  // Pending can still be won by another in-flight caller. Only a durable
  // declined/expired/canceled decision makes every activation impossible.
  if (current && current.status !== "pending") {
    await onRequestComputer(
      deps,
      row,
      (computer) => secretOnComputer(computer, { action: "discard", requestId: row.id }),
      true,
    ).catch(() => undefined);
  }
  return null;
}

/** Retry deletion after a terminal DB decision, including when the computer was offline. */
async function enqueueSecretDiscard(tx: Executor, row: SecretRequestRow) {
  await enqueue(tx, {
    orgId: row.orgId,
    kind: "secret.discard",
    payload: { requestId: row.id },
    dedupeKey: `secret.discard:${row.id}`,
    maxAttempts: 96,
  });
}

export async function discardClosedSecret(deps: SandboxDeps, orgId: string, requestId: string) {
  const [row] = await deps.db
    .select()
    .from(secretRequests)
    .where(and(eq(secretRequests.id, requestId), eq(secretRequests.orgId, orgId)));
  if (!row || !["declined", "expired", "canceled"].includes(row.status)) return;
  await onRequestComputer(
    deps,
    row,
    (computer) => secretOnComputer(computer, { action: "discard", requestId: row.id }),
    true,
    true,
  );
}

/**
 * The computer stages only the sealed box while the DB request is pending.
 * Once the DB commits delivery, the computer activates the value, then the
 * run resumes. A failed transaction can leave staged ciphertext and its key.
 */
export async function deliverSecret(
  deps: SandboxDeps & { pubsub?: PubSub },
  actorId: string,
  orgId: string,
  requestId: string,
  rawBox: unknown,
): Promise<SecretRequestView> {
  const row = await loadForRequester(deps.db, actorId, orgId, requestId);
  if (statusOf(row) !== "pending") throw closedRequest(row);
  const box = parseSecretBox(rawBox);
  if (!box) throw new ValidationError("Invalid secret box");
  const target = targetOf(row);
  const aad = secretAad({ requestId: row.id, orgId, name: row.name, target });
  const reply = await onRequestComputer(deps, row, (computer) =>
    secretOnComputer(computer, { action: "deliver", requestId: row.id, name: row.name, target, aad, box }),
  ).catch(async (error: unknown) => {
    // No computer can open this box anymore: the request ends here, or its card would go on taking values for nothing.
    if (!keyIsGone(error)) throw error;
    await closeRequest(deps, row, "computer_changed");
    throw await closedNow(deps.db, row);
  });
  let delivered: SecretRequestRow | null;
  try {
    delivered = await deps.db.transaction(async (tx) => {
      // Serialize delivery generations across server replicas. A timestamp
      // taken before this lock (or from a skewed app clock) can reverse two
      // commits and let an older activation overwrite the newer value.
      await tx
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(and(eq(schema.agents.id, row.agentId), eq(schema.agents.orgId, orgId)))
        .for("update");
      const [previous] = await tx
        .select({ deliveredAt: secretRequests.deliveredAt })
        .from(secretRequests)
        .where(
          and(
            eq(secretRequests.orgId, orgId),
            eq(secretRequests.agentId, row.agentId),
            eq(secretRequests.name, row.name),
            row.machineId ? eq(secretRequests.machineId, row.machineId) : isNull(secretRequests.machineId),
            isNotNull(secretRequests.deliveredAt),
          ),
        )
        .orderBy(desc(secretRequests.deliveredAt))
        .limit(1);
      const now = new Date(Math.max(Date.now(), (previous?.deliveredAt?.getTime() ?? 0) + 1));
      const [updated] = await tx
        .update(secretRequests)
        .set({ status: "delivered", deliveredAt: now, deliveredSize: reply.size ?? null })
        .where(
          and(
            eq(secretRequests.id, row.id),
            eq(secretRequests.status, "pending"),
            sql`${secretRequests.expiresAt} > now()`,
          ),
        )
        .returning();
      if (!updated) return null;
      await syncSecretMessage(tx, updated);
      // Durable recovery if this server stops before the computer activates.
      await enqueue(tx, {
        orgId,
        kind: "secret.activate",
        payload: { requestId: row.id },
        dedupeKey: `secret.activate:${row.id}`,
        maxAttempts: 24,
      });
      return updated;
    });
  } catch (error) {
    const recovered = await reconcileStagedDelivery(deps, row);
    if (recovered) return recovered;
    throw error;
  }
  if (!delivered) {
    const recovered = await reconcileStagedDelivery(deps, row);
    if (recovered) return recovered;
    throw await closedNow(deps.db, row);
  }
  try {
    await activateDeliveredSecret(deps, orgId, row.id);
  } catch (error) {
    // The row stays visible and removable even if the activation reply is lost.
    await publishSecret(deps, delivered, "secret.updated").catch(() => undefined);
    throw error;
  }
  const [latest] = await deps.db.select().from(secretRequests).where(eq(secretRequests.id, row.id));
  return secretRequestView(latest ?? delivered);
}

/** Idempotent inline completion and outbox recovery after the DB commit. */
export async function activateDeliveredSecret(
  deps: SandboxDeps & { pubsub?: PubSub },
  orgId: string,
  requestId: string,
) {
  const [row] = await deps.db
    .select()
    .from(secretRequests)
    .where(and(eq(secretRequests.id, requestId), eq(secretRequests.orgId, orgId)));
  if (row?.status !== "delivered" || row.removedAt) return;
  const reply = await onRequestComputer(
    deps,
    row,
    (computer) => secretOnComputer(computer, { action: "activate", requestId: row.id, order: deliveryOrder(row) }),
    true,
  );
  const finalized = await deps.db.transaction(async (tx) => {
    // Serialize the DB side of activation with owner removal and other
    // deliveries for this agent.
    await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, row.agentId), eq(schema.agents.orgId, orgId)))
      .for("update");
    const [current] = await tx.select().from(secretRequests).where(eq(secretRequests.id, row.id)).for("update");
    if (current?.status !== "delivered" || current.removedAt) return null;
    if (!current.deliveredAt) throw new Error("A delivered secret has no delivery time");
    const job = resumeJob(current);
    const [already] = await tx
      .select({ id: schema.outbox.id })
      .from(schema.outbox)
      .where(eq(schema.outbox.dedupeKey, job.dedupeKey));
    if (already) return null;
    let old: SecretRequestRow[] = [];
    let finished = current;
    if (reply.superseded) {
      const [removed] = await tx
        .update(secretRequests)
        .set({ removedAt: new Date() })
        .where(eq(secretRequests.id, current.id))
        .returning();
      if (!removed) return null;
      finished = removed;
      await syncSecretMessage(tx, finished);
    } else {
      // Only strictly older deliveries were replaced. A newer request may
      // have committed while this activation was in flight.
      old = await tx
        .update(secretRequests)
        .set({ removedAt: new Date() })
        .where(
          and(
            eq(secretRequests.orgId, orgId),
            eq(secretRequests.agentId, row.agentId),
            eq(secretRequests.name, row.name),
            eq(secretRequests.status, "delivered"),
            isNull(secretRequests.removedAt),
            row.machineId ? eq(secretRequests.machineId, row.machineId) : isNull(secretRequests.machineId),
            or(
              isNull(secretRequests.deliveredAt),
              lt(secretRequests.deliveredAt, current.deliveredAt),
              and(eq(secretRequests.deliveredAt, current.deliveredAt), lt(secretRequests.id, current.id)),
            ),
          ),
        )
        .returning();
      for (const replaced of old) {
        await syncSecretMessage(tx, replaced);
        await enqueue(tx, resumeJob(replaced));
      }
    }
    await enqueue(tx, job);
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: row.requestedForUserId },
      action: reply.superseded ? "secret.superseded" : "secret.delivered",
      target: { type: "agent", id: row.agentId },
      details: {
        requestId: row.id,
        name: secretLabelOf(row),
        target: targetOf(row),
        machineId: row.machineId,
        size: row.deliveredSize,
      },
    });
    return { finished, old };
  });
  if (reply.superseded) {
    await onRequestComputer(
      deps,
      row,
      (computer) => secretOnComputer(computer, { action: "discard", requestId: row.id }),
      true,
    ).catch(() => undefined);
  }
  if (finalized) {
    await publishSecret(deps, finalized.finished, "secret.updated");
    for (const replaced of finalized.old) await publishSecret(deps, replaced, "secret.updated");
  }
}

/** The person says no: the run goes on without it; a durable job removes the runner key. */
export async function declineSecret(
  deps: { db: Database; pubsub?: PubSub; sandbox?: SandboxDeps | null },
  actorId: string,
  orgId: string,
  requestId: string,
): Promise<SecretRequestView> {
  const row = await loadForRequester(deps.db, actorId, orgId, requestId);
  const declined = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(secretRequests)
      .set({ status: "declined" })
      .where(
        and(
          eq(secretRequests.id, row.id),
          eq(secretRequests.status, "pending"),
          sql`${secretRequests.expiresAt} > now()`,
        ),
      )
      .returning();
    if (!updated) return null;
    await syncSecretMessage(tx, updated);
    await enqueue(tx, resumeJob(updated));
    await enqueueSecretDiscard(tx, updated);
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "secret.declined",
      target: { type: "agent", id: row.agentId },
      details: { requestId: row.id, name: secretLabelOf(row) },
    });
    return updated;
  });
  if (!declined) throw await closedNow(deps.db, row);
  await publishSecret(deps, declined, "secret.updated");
  const sandbox = deps.sandbox;
  if (sandbox) {
    await onRequestComputer(
      sandbox,
      declined,
      (c) => secretOnComputer(c, { action: "discard", requestId: declined.id }),
      true,
    ).catch(() => undefined);
  }
  return secretRequestView(declined);
}

/** Closes requests past their deadline and resumes their runs (worker, every minute). */
export async function expireSecretRequests(deps: { db: Database; pubsub?: PubSub }, now = new Date()) {
  const expired = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(secretRequests)
      .set({ status: "expired" })
      .where(and(eq(secretRequests.status, "pending"), lt(secretRequests.expiresAt, now)))
      .returning();
    for (const row of rows) {
      await syncSecretMessage(tx, row);
      await enqueue(tx, resumeJob(row));
      await enqueueSecretDiscard(tx, row);
      await recordAudit(tx, {
        orgId: row.orgId,
        actor: { type: "system", id: null },
        action: "secret.expired",
        target: { type: "agent", id: row.agentId },
        details: { requestId: row.id, name: secretLabelOf(row) },
      });
    }
    return rows;
  });
  for (const row of expired) await publishSecret(deps, row, "secret.updated");
  return expired.length;
}

/** The agent withdraws its own pending request (`withdraw_request`): its card closes and a run waiting on it goes on. */
export async function withdrawSecretRequest(
  deps: { db: Database; pubsub?: PubSub },
  agentId: string,
  requestId: string,
) {
  const withdrawn = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(secretRequests)
      .set({ status: "canceled", endReason: "withdrawn" })
      .where(
        and(
          eq(secretRequests.id, requestId),
          eq(secretRequests.agentId, agentId),
          eq(secretRequests.status, "pending"),
        ),
      )
      .returning();
    if (!row) return null;
    await syncSecretMessage(tx, row);
    await enqueue(tx, resumeJob(row));
    await enqueueSecretDiscard(tx, row);
    await recordAudit(tx, {
      orgId: row.orgId,
      actor: { type: "agent", id: agentId },
      action: "secret.canceled",
      target: { type: "agent", id: agentId },
      details: { requestId: row.id, name: secretLabelOf(row) },
    });
    return row;
  });
  if (withdrawn) await publishSecret(deps, withdrawn, "secret.updated");
  return withdrawn;
}

/** Someone leaving the workspace: the requests waiting on them close, and the runs waiting on them go on. */
export async function cancelSecretRequestsFor(tx: Executor, orgId: string, userId: string) {
  const rows = await tx
    .update(secretRequests)
    .set({ status: "canceled", endReason: "person_left" })
    .where(
      and(
        eq(secretRequests.orgId, orgId),
        eq(secretRequests.requestedForUserId, userId),
        eq(secretRequests.status, "pending"),
      ),
    )
    .returning();
  for (const row of rows) {
    await syncSecretMessage(tx, row);
    await enqueue(tx, resumeJob(row));
    await enqueueSecretDiscard(tx, row);
  }
  return rows;
}

/** A run canceled while waiting: its requests close too. */
export async function cancelSecretRequests(tx: Executor, runId: string) {
  const rows = await tx
    .update(secretRequests)
    .set({ status: "canceled", endReason: "run_stopped" })
    .where(and(eq(secretRequests.runId, runId), eq(secretRequests.status, "pending")))
    .returning();
  for (const row of rows) await enqueueSecretDiscard(tx, row);
  return rows;
}

export interface AgentSecretView {
  /** What removing it goes by; people read `label`. */
  name: string;
  label: string;
  target: SecretTarget;
  machineId: string | null;
  deliveredAt: string;
  deliveredByUserId: string;
}

/**
 * The secrets on the agent's computers (names only), for its owner and admins. A site's password past the minutes
 * its runner keeps it in memory is gone from there, so it isn't listed (ADR 0144 §6).
 */
export async function listAgentSecrets(db: Database, actorId: string, orgId: string, agentId: string) {
  await requireComputerManager(db, actorId, orgId, agentId);
  const rows = await db
    .select()
    .from(secretRequests)
    .where(
      and(
        eq(secretRequests.orgId, orgId),
        eq(secretRequests.agentId, agentId),
        eq(secretRequests.status, "delivered"),
        isNull(secretRequests.removedAt),
        secretStillHeld(),
      ),
    );
  return rows
    .map(
      (r): AgentSecretView => ({
        name: r.name,
        label: secretLabelOf(r),
        target: targetOf(r),
        machineId: r.machineId,
        deliveredAt: (r.deliveredAt ?? r.createdAt).toISOString(),
        deliveredByUserId: r.requestedForUserId,
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Deletes a secret from the agent's computer (and its file); the rows stay for the record. */
export async function removeAgentSecret(
  deps: SandboxDeps,
  actorId: string,
  orgId: string,
  agentId: string,
  name: string,
  machineId: string | null,
) {
  await requireComputerManager(deps.db, actorId, orgId, agentId);
  if (!SECRET_NAME.test(name)) throw new ValidationError("Invalid secret name");
  await removeSecret(deps, actorId, orgId, agentId, name, machineId);
}

/**
 * An agent being deleted (ADR 0082 §4): every secret people delivered to it leaves the computer it was delivered
 * to, as `removeAgentSecret` does. One whose computer doesn't answer now (offline) keeps its value there and its
 * row open.
 */
export async function removeAgentSecrets(deps: SandboxDeps, actorId: string, orgId: string, agentId: string) {
  const held = await deps.db
    .selectDistinct({ name: secretRequests.name, machineId: secretRequests.machineId })
    .from(secretRequests)
    .where(
      and(
        eq(secretRequests.orgId, orgId),
        eq(secretRequests.agentId, agentId),
        eq(secretRequests.status, "delivered"),
        isNull(secretRequests.removedAt),
      ),
    );
  for (const s of held) await removeSecret(deps, actorId, orgId, agentId, s.name, s.machineId).catch(() => null);
}

async function removeSecret(
  deps: SandboxDeps,
  actorId: string,
  orgId: string,
  agentId: string,
  name: string,
  machineId: string | null,
) {
  const live = await deps.db
    .select()
    .from(secretRequests)
    .where(
      and(
        eq(secretRequests.orgId, orgId),
        eq(secretRequests.agentId, agentId),
        eq(secretRequests.name, name),
        eq(secretRequests.status, "delivered"),
        isNull(secretRequests.removedAt),
        machineId ? eq(secretRequests.machineId, machineId) : isNull(secretRequests.machineId),
      ),
    );
  const latest = live.at(-1);
  if (!latest) throw new NotFoundError("Secret not found");
  // Clear the runner before marking the rows removed. The machine RPC can
  // read the DB itself, so it must not run inside a PGlite transaction.
  await onRequestComputer(
    deps,
    latest,
    (c) =>
      secretOnComputer(c, {
        action: "remove",
        name,
        requestIds: live.map((r) => r.id),
        throughOrder: live.map(deliveryOrder).sort().at(-1),
      }),
    true,
    true,
  );
  await deps.db.transaction(async (tx) => {
    await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId)))
      .for("update");
    const now = new Date();
    for (const r of live) {
      const [removed] = await tx
        .update(secretRequests)
        .set({ removedAt: now })
        .where(and(eq(secretRequests.id, r.id), isNull(secretRequests.removedAt)))
        .returning();
      if (removed) {
        await syncSecretMessage(tx, removed);
        // A committed delivery can still be waiting for activation. Removal
        // resolves that wait with an absent-secret result, once.
        await enqueue(tx, resumeJob(removed));
      }
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "secret.removed",
      target: { type: "agent", id: agentId },
      details: { name: secretLabelOf({ label: null, site: null, name }), machineId },
    });
  });
}

/**
 * Who a secret may be asked of: the person behind the run (`authority.ts`), where they read the card.
 * Nobody for a routine's or an unattended run. In an agents' DM no person reads the card: only a run
 * answering another agent's question for a person asks them, and its card goes where they asked (ADR 0034).
 */
export async function requesterOfRun(ctx: ToolContext): Promise<string | null> {
  const [here] = await ctx.db
    .select({ kind: schema.channels.kind, dmKey: schema.channels.dmKey })
    .from(schema.channels)
    .where(and(eq(schema.channels.orgId, ctx.orgId), eq(schema.channels.id, ctx.channelId)));
  if (!here) return null;
  if (isAgentOnlyDm(here)) return consultedFor(ctx);
  return personBehindCall(ctx);
}
