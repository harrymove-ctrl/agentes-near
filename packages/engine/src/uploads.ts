import { type PubSub, uploadTopic } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, schema } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import {
  ARTIFACT_LIMITS,
  type ArtifactActor,
  type ArtifactDeps,
  type ArtifactDetailView,
  addFileVersion,
  createFileArtifact,
  fileReach,
} from "./artifacts";
import { recordAudit } from "./audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { formatBytes } from "./format";
import type { MachineCaller } from "./machine-hub";
import { replyThreadOf } from "./runs";
import { type ComputerHandle, withConnectedMachine } from "./sandbox";
import { BUILTIN_SCOPES, freshGrantedKeys, isAllowed, toolAccess } from "./tools/scopes";
import type { ToolContext, ToolOutput } from "./tools/types";

const { artifactUploads, artifacts, artifactVersions } = schema;

/**
 * Uploads from an agent's computer to the Drive (`upload_file`, ADR 0025).
 * A pending row is bound to the org, agent, run and computer; the bytes
 * arrive pushed by the machine (`receiveMachineUpload`, from
 * `PUT /api/machines/uploads/{id}`), which ends in `completeUpload`. The tool
 * waits with `waitForUpload`.
 */
export type UploadRow = typeof artifactUploads.$inferSelect;

/** A pending upload expires this long after it was created. */
export const UPLOAD_TTL_MS = 10 * 60_000;
/** `waitForUpload` reads the row this often (the pub/sub signal usually comes first). */
export const UPLOAD_POLL_MS = 1000;

export interface UploadDeps {
  db: Database;
  artifacts: ArtifactDeps;
  pubsub?: PubSub;
  now?: () => Date;
}

const clock = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();

/** A pending upload (expires in 10 minutes). `targetArtifactId`: a new version of that `file` artifact. */
export async function createUpload(
  db: Database,
  input: {
    orgId: string;
    agentId: string;
    runId?: string | null;
    /** The run's channel and thread: completion acts as the agent there. */
    channelId: string;
    threadId?: string | null;
    /** `machine:<machine id>`. */
    computer: string;
    /** Only this machine may complete it. */
    machineId?: string | null;
    path: string;
    title?: string | null;
    note?: string | null;
    targetArtifactId?: string | null;
    maxBytes?: number;
    now?: Date;
  },
): Promise<UploadRow> {
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(artifactUploads)
    .values({
      orgId: input.orgId,
      agentId: input.agentId,
      runId: input.runId ?? null,
      channelId: input.channelId,
      threadId: input.threadId ?? null,
      computer: input.computer,
      machineId: input.machineId ?? null,
      path: input.path,
      title: input.title?.trim().slice(0, ARTIFACT_LIMITS.titleChars) || null,
      note: input.note?.trim().slice(0, 500) || null,
      targetArtifactId: input.targetArtifactId ?? null,
      status: "pending",
      maxBytes: Math.min(input.maxBytes ?? ARTIFACT_LIMITS.fileBytes, ARTIFACT_LIMITS.fileBytes),
      expiresAt: new Date(now.getTime() + UPLOAD_TTL_MS),
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error("upload insert returned nothing");
  return row;
}

export async function getUpload(db: Database, uploadId: string): Promise<UploadRow | null> {
  const [row] = await db.select().from(artifactUploads).where(eq(artifactUploads.id, uploadId));
  return row ?? null;
}

async function signal(pubsub: PubSub | undefined, row: Pick<UploadRow, "id" | "status">) {
  await pubsub
    ?.publish(uploadTopic(row.id), { type: "upload.finished", uploadId: row.id, status: row.status })
    .catch(() => undefined);
}

/** Marks a pending upload failed (with why) and wakes whoever waits for it. No-op once it finished. */
export async function failUpload(deps: { db: Database; pubsub?: PubSub }, uploadId: string, error: string) {
  const [row] = await deps.db
    .update(artifactUploads)
    .set({ status: "failed", error: error.slice(0, 1000), completedAt: new Date() })
    .where(and(eq(artifactUploads.id, uploadId), inArray(artifactUploads.status, ["pending", "storing"])))
    .returning();
  if (row) await signal(deps.pubsub, row);
  return row ?? null;
}

/**
 * Stores the bytes of a pending upload as a `file` artifact (or a new
 * version of its target), as the agent in its run's channel and thread.
 * Refuses an unknown, finished or expired upload, another machine than the
 * one it was made for, more than `max_bytes`, and a SHA-256 that doesn't
 * match. Audited (`artifact.uploaded`); wakes `waitForUpload`.
 */
export async function completeUpload(
  deps: UploadDeps,
  uploadId: string,
  input: {
    name: string;
    bytes: Uint8Array;
    contentType?: string | null;
    /** Hex; checked when given. */
    sha256?: string | null;
    /** The machine sending it (connected machines); must match the upload's. */
    machineId?: string | null;
  },
): Promise<{ upload: UploadRow; artifact: ArtifactDetailView }> {
  const { db } = deps;
  const row = await getUpload(db, uploadId);
  if (!row) throw new NotFoundError("Upload not found", "upload.not_found");
  if ((row.machineId ?? null) !== (input.machineId ?? null)) {
    throw new ForbiddenError("This upload is for another computer", "upload.wrong_machine");
  }
  if (row.status !== "pending") throw new ConflictError("This upload already finished", "upload.not_pending");
  if (row.expiresAt.getTime() <= clock(deps).getTime()) {
    await failUpload(deps, row.id, "the upload expired");
    throw new ConflictError("This upload expired", "upload.expired");
  }
  if (input.bytes.byteLength > row.maxBytes) {
    const maxMb = Math.round(row.maxBytes / 1024 / 1024);
    await failUpload(deps, row.id, `the file is too large (max ${maxMb} MB)`);
    throw new ValidationError(`the file is too large (max ${maxMb} MB)`, "artifact.file_too_large", { maxMb });
  }
  const sha = new Bun.CryptoHasher("sha256").update(input.bytes).digest("hex");
  if (input.sha256 && input.sha256.toLowerCase() !== sha) {
    await failUpload(deps, row.id, "the file arrived damaged (SHA-256 mismatch)");
    throw new ValidationError("The file arrived damaged (SHA-256 mismatch)", "upload.sha_mismatch");
  }
  // Claim it: one completion only, even with two requests at once.
  const [claimed] = await db
    .update(artifactUploads)
    .set({ status: "storing" })
    .where(and(eq(artifactUploads.id, row.id), eq(artifactUploads.status, "pending")))
    .returning();
  if (!claimed) throw new ConflictError("This upload already finished", "upload.not_pending");
  const actor: ArtifactActor = {
    type: "agent",
    agentId: row.agentId,
    channelId: row.channelId,
    threadId: row.threadId,
    runId: row.runId,
  };
  let artifact: ArtifactDetailView;
  try {
    artifact = row.targetArtifactId
      ? await addFileVersion(deps.artifacts, actor, row.orgId, row.targetArtifactId, {
          name: input.name,
          bytes: input.bytes,
          contentType: input.contentType,
          note: row.note ?? `Uploaded from ${row.path}`,
          title: row.title ?? undefined,
        })
      : await createFileArtifact(deps.artifacts, actor, row.orgId, {
          title: row.title || input.name,
          name: input.name,
          bytes: input.bytes,
          contentType: input.contentType,
          note: row.note,
        });
  } catch (error) {
    await failUpload(deps, row.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
  const [done] = await db
    .update(artifactUploads)
    .set({ status: "done", artifactId: artifact.id, version: artifact.shownVersion, completedAt: clock(deps) })
    .where(eq(artifactUploads.id, row.id))
    .returning();
  await recordAudit(db, {
    orgId: row.orgId,
    actor: { type: "agent", id: row.agentId },
    action: "artifact.uploaded",
    target: { type: "artifact", id: artifact.id },
    details: {
      uploadId: row.id,
      version: artifact.shownVersion,
      path: row.path,
      size: input.bytes.byteLength,
      sha256: sha,
      computer: row.computer,
    },
  });
  const upload = done ?? { ...row, status: "done", artifactId: artifact.id, version: artifact.shownVersion };
  await signal(deps.pubsub, upload);
  return { upload, artifact };
}

/**
 * What `PUT /api/machines/uploads/{uploadId}` does once the machine token
 * is checked: the bytes a connected machine pushed, for an upload made for
 * that machine.
 */
export async function receiveMachineUpload(
  deps: UploadDeps,
  input: { uploadId: string; machineId: string; name: string; contentType: string; sha256: string; body: Uint8Array },
) {
  if (!input.machineId) throw new ForbiddenError("This upload is for another computer", "upload.wrong_machine");
  return completeUpload(deps, input.uploadId, {
    name: input.name,
    bytes: input.body,
    contentType: input.contentType,
    sha256: input.sha256,
    machineId: input.machineId,
  });
}

/** The upload couldn't finish in time: nothing was stored. */
export class UploadTimeoutError extends Error {
  constructor(path: string, seconds: number) {
    super(`the upload of ${path} did not finish within ${seconds} s; nothing was stored`);
    this.name = "UploadTimeoutError";
  }
}

/**
 * Waits until the upload is done or failed and returns its row: woken by
 * the pub/sub signal, and reading the row every second anyway (the bytes
 * may reach another replica). On timeout or expiry it is marked failed and
 * this throws `UploadTimeoutError`.
 */
export async function waitForUpload(
  deps: { db: Database; pubsub?: PubSub; now?: () => Date },
  uploadId: string,
  timeoutMs: number,
  options: { pollMs?: number } = {},
): Promise<UploadRow> {
  const pollMs = options.pollMs ?? UPLOAD_POLL_MS;
  let wake: (() => void) | null = null;
  const unsubscribe = deps.pubsub?.subscribe(uploadTopic(uploadId), () => wake?.());
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const row = await getUpload(deps.db, uploadId);
      if (!row) throw new NotFoundError("Upload not found", "upload.not_found");
      if (row.status === "done" || row.status === "failed") return row;
      const expired = row.expiresAt.getTime() <= clock(deps).getTime();
      if (Date.now() >= deadline || expired) {
        await failUpload(deps, uploadId, "timed out waiting for the file");
        // It may have finished in between.
        const last = await getUpload(deps.db, uploadId);
        if (last?.status === "done") return last;
        throw new UploadTimeoutError(row.path, Math.round(timeoutMs / 1000));
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(pollMs, Math.max(0, deadline - Date.now())));
        function done() {
          clearTimeout(timer);
          wake = null;
          resolve();
        }
        wake = done;
      });
    }
  } finally {
    unsubscribe?.();
  }
}

/** A finished upload as the tool reports it: the artifact's title, the file's name and size. */
export async function uploadedFile(db: Database, row: UploadRow) {
  if (row.status !== "done" || !row.artifactId || row.version === null) return null;
  const [found] = await db
    .select({ title: artifacts.title, name: artifactVersions.fileName, size: artifactVersions.size })
    .from(artifactVersions)
    .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
    .where(and(eq(artifactVersions.artifactId, row.artifactId), eq(artifactVersions.version, row.version)));
  if (!found) return null;
  return { id: row.artifactId, version: row.version, title: found.title, name: found.name ?? "file", size: found.size };
}

/** How long `upload_file` waits for the bytes. */
export const UPLOAD_TIMEOUT_SECONDS = 300;

/**
 * A file or folder on the agent's computer to the Drive as is (`upload_file`, a screenshot's `share`): the
 * computer sends it itself (`pushFile`) to our upload URL, and the upload completes when the bytes arrive
 * (`receiveMachineUpload`), as the agent in its run's channel and thread.
 */
export async function uploadFromComputer(
  deps: { db: Database; pubsub?: PubSub; publicUrl?: string },
  ctx: ToolContext,
  computer: ComputerHandle,
  path: string,
  input: { title: string | null; note: string | null; targetArtifactId: string | null },
): Promise<UploadRow> {
  const upload = await createUpload(deps.db, {
    orgId: ctx.orgId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    channelId: ctx.channelId,
    threadId: replyThreadOf(ctx),
    computer: computer.ref,
    machineId: computer.machineId,
    path,
    ...input,
  });
  const base = (deps.publicUrl ?? "").replace(/\/$/, "");
  try {
    await computer.provider.pushFile(computer.id, path, {
      url: `${base}/api/machines/uploads/${upload.id}`,
      uploadId: upload.id,
      maxBytes: upload.maxBytes,
    });
  } catch (error) {
    // The answer may be what got lost (the link dropped after the bytes arrived): what landed is the file.
    const landed = await getUpload(deps.db, upload.id);
    if (landed?.status === "done") return landed;
    if (landed?.status === "storing") return waitForUpload(deps, upload.id, UPLOAD_TIMEOUT_SECONDS * 1000);
    await failUpload(deps, upload.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
  return waitForUpload(deps, upload.id, UPLOAD_TIMEOUT_SECONDS * 1000);
}

/** A screenshot tool's `share`. */
export const SHARE_INPUT = {
  type: "boolean",
  description: "Show it in this conversation: it goes to the Drive and its card goes with your reply.",
} as const;

/** What a screenshot taken without `share` adds to its answer. */
export const SHARE_HINT = "To show a screenshot in this conversation, take it with share: true.";

/** What sharing a file makes: a Drive file ("Write files"), as `create_artifact` does. Never Run code. */
const DRIVE_FILE = { name: "create_artifact", scope: "drive:write" };

/**
 * A file the agent just saved in its folder (`saved`: that tool's answer), shown in this conversation: it goes to
 * the Drive the way `upload_file` sends one, and its card goes with the reply (`data.artifact`). Without "Write
 * files" the file stays saved, and the answer says how to ask for it.
 */
export async function shareSavedFile(
  deps: { machines?: { hub: MachineCaller } | null; pubsub?: PubSub; publicUrl?: string },
  ctx: ToolContext,
  machineId: string,
  path: string,
  saved: ToolOutput,
): Promise<ToolOutput> {
  const access = toolAccess(await freshGrantedKeys(ctx.db, ctx.orgId, ctx.agentId), DRIVE_FILE);
  if (!isAllowed(access)) {
    const why =
      access === "denied"
        ? "making Drive files is turned off for you; tell the people"
        : `that needs "${BUILTIN_SCOPES[DRIVE_FILE.scope]?.label}" (${DRIVE_FILE.scope}), which you don't have. Ask for it with request_permission, then take it again with share: true`;
    return { ...saved, content: `${saved.content} It isn't shown in this conversation: ${why}.` };
  }
  try {
    const hub = deps.machines?.hub;
    if (!hub) throw new Error("Connected computers are not available on this server.");
    const agent = await getAgentCached(ctx.db, ctx.orgId, ctx.agentId);
    const row = await withConnectedMachine(
      hub,
      ctx,
      { machineId, handle: agent?.handle ?? "agent", ...(agent?.name ? { name: agent.name } : {}) },
      (computer) =>
        uploadFromComputer({ db: ctx.db, pubsub: deps.pubsub, publicUrl: deps.publicUrl }, ctx, computer, path, {
          title: null,
          note: null,
          targetArtifactId: null,
        }),
    );
    const done = await uploadedFile(ctx.db, row);
    if (!done) throw new Error(row.error ?? "the upload did not finish");
    const [landed] = await ctx.db
      .select({ channelId: artifacts.channelId })
      .from(artifacts)
      .where(eq(artifacts.id, done.id));
    return {
      content:
        landed?.channelId === ctx.channelId
          ? `${saved.content} It is shown in this conversation: its card goes with your reply ("${done.title}" in the Drive, ${formatBytes(done.size)}, artifact ${done.id}).`
          : `${saved.content} Saved as "${done.title}" (${formatBytes(done.size)}), artifact ${done.id}. ${await fileReach(ctx.db, ctx.orgId, done.id)}`,
      data: { ...saved.data, artifact: { id: done.id, version: done.version, title: done.title } },
    };
  } catch (error) {
    return {
      ...saved,
      content: `${saved.content} It couldn't be shown in this conversation: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}
