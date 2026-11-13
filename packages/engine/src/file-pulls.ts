import { type BlobStoreResolver, MAX_INLINE_FILE_BYTES } from "@agenteschat/adapters";
import { and, type Database, eq, gt, lt, or, schema } from "@agenteschat/db";
import { NotFoundError } from "./errors";
import type { ComputerHandle } from "./sandbox";

const { machineFilePulls } = schema;

/** A pull must start this long after it was made; the runner's own limit covers how long the copy then takes. */
export const FILE_PULL_TTL_MS = 5 * 60_000;

/** A file in our storage, as a Drive version or a skill keeps it. */
export interface StoredFile {
  storageConfigId: string | null;
  blobKey: string;
  size: number;
  sha256?: string | null;
}

export interface FilePullDeps {
  db: Database;
  blobs: BlobStoreResolver;
  publicUrl?: string;
}

/**
 * A stored file onto the agent's computer, after the caller's own read check: small files in one `write`, the rest
 * fetched by the computer itself from a URL of ours good for one fetch by that machine (`openFilePull`), so their
 * bytes are never held whole here.
 */
export async function copyToComputer(
  deps: FilePullDeps,
  ctx: { orgId: string; signal?: AbortSignal },
  computer: ComputerHandle,
  path: string,
  file: StoredFile,
): Promise<void> {
  if (file.size <= MAX_INLINE_FILE_BYTES) {
    const store = await deps.blobs.forConfig(ctx.orgId, file.storageConfigId);
    const object = await store.get(file.blobKey);
    if (!object) throw new NotFoundError("The stored file is missing");
    return computer.provider.writeFile(computer.id, path, object.body);
  }
  const [pull] = await deps.db
    .insert(machineFilePulls)
    .values({
      orgId: ctx.orgId,
      machineId: computer.machineId,
      storageConfigId: file.storageConfigId,
      blobKey: file.blobKey,
      size: file.size,
      expiresAt: new Date(Date.now() + FILE_PULL_TTL_MS),
    })
    .returning({ id: machineFilePulls.id });
  if (!pull) throw new Error("file pull insert returned nothing");
  try {
    await computer.provider.pullFile(computer.id, path, {
      url: `${(deps.publicUrl ?? "").replace(/\/$/, "")}/api/machines/pulls/${pull.id}`,
      pullId: pull.id,
      size: file.size,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } finally {
    // Also what a restart left behind on this machine: only this ever clears a pull that was never fetched.
    await deps.db
      .delete(machineFilePulls)
      .where(
        and(
          eq(machineFilePulls.machineId, computer.machineId),
          or(eq(machineFilePulls.id, pull.id), lt(machineFilePulls.expiresAt, new Date())),
        ),
      );
  }
}

/**
 * What `GET /api/machines/pulls/{id}` does once the machine token is checked. Deleting the row is the claim, so a
 * second fetch finds nothing, on any replica. Refuses a used, expired or unknown pull and another machine's alike.
 */
export async function openFilePull(deps: Pick<FilePullDeps, "db" | "blobs">, pullId: string, machineId: string) {
  const [pull] = await deps.db
    .delete(machineFilePulls)
    .where(
      and(
        eq(machineFilePulls.id, pullId),
        eq(machineFilePulls.machineId, machineId),
        gt(machineFilePulls.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!pull) throw new NotFoundError("This file isn't waiting for this computer", "pull.not_found");
  const store = await deps.blobs.forConfig(pull.orgId, pull.storageConfigId);
  // ponytail: Postgres storage has no streaming, so a pull there holds the file in memory like a download does.
  const body = store.stream ? await store.stream(pull.blobKey) : (await store.get(pull.blobKey))?.body;
  if (!body) throw new NotFoundError("The stored file is missing");
  return { body, size: pull.size };
}
