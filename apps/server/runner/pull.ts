import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { MachineReplies } from "@agenteschat/adapters/machine-protocol";
import { errnoCode, RunnerError } from "./errors";
import { type FetchLike, serverMessage, uploadUrl } from "./push";

/** 50 MB in this time is about 0.7 Mbit/s: a slow link still gets there, and a dead one still ends. */
export const PULL_TIMEOUT_MS = 10 * 60 * 1000;

export interface PullOptions {
  /** Where the file lands: already through `write`'s path rules. */
  abs: string;
  token: string;
  /** The server this computer is paired with: the fetch goes there, to the path `url` names. */
  server?: string;
  url: string;
  pullId: string;
  size: number;
  sha256?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

const TRY_AGAIN = "Nothing changed there, so it can be tried again.";

const isDiskFull = (err: unknown) => ["ENOSPC", "EDQUOT"].includes(errnoCode(err) ?? "");
const diskFull = () =>
  new RunnerError("pull_failed", "the computer's disk is full. Free some space there, then try again.");

/** Why a pull stopped, for people and agents: a fetch's own words name the server's address, which stays out of them. */
function pullError(err: unknown, canceled: boolean): RunnerError {
  if (canceled) return new RunnerError("internal", "Canceled");
  if (err instanceof RunnerError) return err;
  if (isDiskFull(err)) return diskFull();
  if (err instanceof Error && err.name === "TimeoutError") {
    return new RunnerError("pull_failed", `the copy took over 10 minutes, too long for this link. ${TRY_AGAIN}`);
  }
  return new RunnerError("pull_failed", `the copy stopped before the end. ${TRY_AGAIN}`);
}

/**
 * Fetches a file from our one-use URL straight to disk. It goes to a temporary file beside the target and takes its
 * place only once every byte and the hash match, so a cut connection leaves the target as it was.
 */
export async function pullFile(opts: PullOptions): Promise<MachineReplies["pull"]> {
  const url = opts.server ? uploadUrl(opts.server, opts.url) : opts.url;
  if (!url || !/^https?:\/\//i.test(url)) throw new RunnerError("bad_request", "The file URL must be http(s)");
  const damaged = new RunnerError("pull_failed", `it arrived damaged. ${TRY_AGAIN}`);
  const signals = [AbortSignal.timeout(PULL_TIMEOUT_MS)];
  if (opts.signal) signals.push(opts.signal);
  const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  const temp = path.join(path.dirname(opts.abs), `.agentes-pull-${randomUUID()}`);
  // `wx`: never through a link or over a file someone put at that name.
  const file = await open(temp, "wx").catch((err: unknown) => {
    throw isDiskFull(err) ? diskFull() : err;
  });
  try {
    const res = await doFetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${opts.token}`, "x-agentes-pull-id": opts.pullId },
      signal: AbortSignal.any(signals),
    });
    if (!res.ok || !res.body) {
      throw new RunnerError(
        "pull_failed",
        `${await serverMessage(res, `the server refused it (${res.status})`)}. ${TRY_AGAIN}`,
      );
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > opts.size) throw damaged;
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    const sha256 = hash.digest("hex");
    if (size !== opts.size || (opts.sha256 && opts.sha256.toLowerCase() !== sha256)) throw damaged;
    // Over an existing file: `write` keeps its permissions, and so does this.
    const before = await stat(opts.abs).catch(() => null);
    if (before) await file.chmod(before.mode & 0o7777);
    await file.close();
    await rename(temp, opts.abs);
    return { size, sha256 };
  } catch (err) {
    await file.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw pullError(err, opts.signal?.aborted === true);
  }
}
