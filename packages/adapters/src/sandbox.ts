/**
 * The channel to an agent's computer (ADR 0025): commands, files, uploads and secrets. Connected computers
 * implement it over the machine hub (`createMachineSandboxProvider` in packages/engine/src/machine-provider.ts).
 * No environment variables of ours go with a command. The only secrets a computer holds are those a person
 * sealed to it (ADR 0027), which we relay without being able to read.
 */
import type { MachineReplies, MachineRequest, SecretRequest } from "./machine-protocol";

export interface ExecRequest {
  command: string;
  /** Relative to the workspace (default: the workspace). */
  cwd?: string;
  timeoutSeconds: number;
  /** Stops the command (killed when the provider can; else we stop waiting): the run was canceled. */
  signal?: AbortSignal;
  /** A person approved this very command (an approval card): the computer runs it even when its command policy would hold it. */
  approved?: boolean;
  /** The repositories the agent merges in without asking (`loneMerge`). */
  mergeRepos?: string[];
  /** Vault keys sealed to the computer's one-use key, for this command's environment only (ADR 0144). */
  vault?: Extract<MachineRequest, { op: "exec" }>["vault"];
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Stopped by `signal`. `killed` false: the provider couldn't kill it, we only stopped waiting. */
  canceled?: { killed: boolean };
  /** It ran as a merge the agent does without asking (`mergeRepos`). */
  merge?: MachineReplies["exec"]["merge"];
}

export interface SandboxFile {
  /** Relative to the workspace. */
  path: string;
  isDir: boolean;
  size: number;
}

/** Where a computer sends a file (`pushFile`): our one-time upload URL, authenticated by the computer's own token. */
export interface PushTarget {
  /** Absolute URL of our upload endpoint (`PUT`). */
  url: string;
  uploadId: string;
  maxBytes: number;
}

/** What a computer fetches (`pullFile`): a one-use URL of ours, authenticated by the computer's own token. */
export interface PullSource {
  /** Absolute URL of our file endpoint (`GET`). */
  url: string;
  pullId: string;
  size: number;
  sha256?: string;
  signal?: AbortSignal;
}

/** What a computer sent: the uploaded name (`report.pdf`, or `folder.zip`), size, SHA-256 (hex) and type. */
export type PushReceipt = MachineReplies["push"];

/** Talking to a running computer: commands, files, uploads and secrets (ADR 0025). */
export interface ComputerChannel {
  /** Runs a shell command in the workspace. No environment variables are passed. */
  exec(id: string, request: ExecRequest): Promise<ExecResult>;
  /**
   * The same, telling `onOutput` what it prints while it runs (new text only,
   * stdout and stderr apart). Providers without streaming report it all at the end.
   */
  execStream?(
    id: string,
    request: ExecRequest,
    onOutput: (stream: "stdout" | "stderr", chunk: string) => void,
  ): Promise<ExecResult>;
  /** Paths are relative to the workspace; parents are created. */
  writeFile(id: string, path: string, data: Uint8Array): Promise<void>;
  /** Null when the file doesn't exist. */
  readFile(id: string, path: string): Promise<Uint8Array | null>;
  listFiles(id: string, path: string, depth?: number): Promise<SandboxFile[]>;
  /** The computer sends a file (a folder: zipped) straight to `target`, so the bytes never pass through the model. */
  pushFile(id: string, path: string, target: PushTarget): Promise<PushReceipt>;
  /** The computer fetches a stored file to `path` itself, for what `writeFile` can't carry. */
  pullFile(id: string, path: string, source: PullSource): Promise<void>;
  /** Why `pullFile` can't work there (an older runner), for the agent; null when it can. */
  pullRefusal(id: string): Promise<string | null>;
  /** Secrets for the agent (ADR 0027), kept by the computer itself. */
  secret(
    id: string,
    request: SecretRequest,
  ): Promise<{ publicKey?: string; sites?: boolean; size?: number; superseded?: boolean }>;
}

/** A computer as the tools reach it: its channel and the provider's id (`machine` for connected computers). */
export type SandboxProvider = ComputerChannel & { readonly id: string };

/** A workspace-relative path, cleaned: no `..`, no absolute paths outside it. */
export function workspacePath(path: string) {
  const trimmed = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/workspace(\/|$)/, "");
  const parts = trimmed.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error(`invalid path: ${path}`);
  return parts.join("/");
}
