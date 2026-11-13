import {
  type AgentScope,
  type ExecRequest,
  type ExecResult,
  FILE_PULL_PROTOCOL,
  generateSecretKeyPair,
  MAX_INLINE_FILE_BYTES,
  madePasswordAad,
  openSecret,
  PASSWORD_CLASSES,
  PASSWORD_LENGTH,
  type PasswordClass,
  policyRefusal,
  type SandboxProvider,
  SECRET_ACTIVATE_PROTOCOL,
  SECRETS_PROTOCOL,
  VAULT_PASSWORD_PROTOCOL,
  VAULT_PROTOCOL,
} from "@agenteschat/adapters";
import { ARTIFACT_LIMITS } from "./artifacts";
import { type MachineCaller, MachineRequestError, type MachineStatus } from "./machine-hub";
import { MachineOfflineError, MachinePausedError } from "./machines";
import { personAtComputerWay, runnerUpdateWay } from "./runner-update";

/** Provider id of connected machines; their computer id is the machine id. */
export const MACHINE_PROVIDER_ID = "machine";

const MB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** The workspace's own computer has no owner to ask: what the agent can do instead of `request_folder_access`. */
export const foldersFixedMessage = (name: string) =>
  `Nobody can allow folders on ${name}, the workspace's own computer: work in your folder, read from your home, or copy what you need into your folder with a command.`;

/**
 * A runner's `not_allowed` (protocol 10): the path is outside every folder
 * this agent may use on the machine, or the tool is off there. Points the
 * agent at `request_folder_access` for a folder, where someone can answer it
 * (`managed`: nobody can). On a `device`, a person's computer the agent
 * named, only that person can, on that computer: the tool is for the agent's
 * own computer alone. The command policy's own (`policyRefusal`) already
 * says where to go and stays as it is.
 */
export function notAllowedMessage(
  name: string,
  detail: string,
  path?: string,
  managed = false,
  device?: Pick<MachineStatus, "os" | "executors">,
) {
  if (policyRefusal(detail)) return detail;
  if (managed) {
    const pointer = " (ask for it with request_folder_access)";
    return detail.includes(pointer)
      ? `${detail.replace(pointer, ".")} ${foldersFixedMessage(name)}`
      : `${(detail || "Not allowed on this computer").replace(/\.$/, "")}. Tell the people.`;
  }
  const absolute = path && /^(\/|~|[A-Za-z]:)/.test(path);
  if (device) {
    return `${(detail || "Not allowed on this computer").replace(/ \(ask for it with request_folder_access\)|\.$/g, "")}. ${
      absolute
        ? `Only the person at ${name} can allow ${path}, ${personAtComputerWay(device, "Folders", [`folders allow ${path}`])}: tell them, or work inside your own folder.`
        : `On ${name}, only the person at it can allow folders or turn tools on: tell them.`
    }`;
  }
  return `${detail || "Not allowed on this computer."} ${
    absolute
      ? `${path} is outside the folders you may use on ${name}: ask its owner for it with request_folder_access (path and a short reason), or work inside your own folder.`
      : `On ${name}, only the person at the computer can allow folders or turn tools on: for a folder outside your own, ask with request_folder_access; for a tool that is off, tell the people.`
  }`;
}

/**
 * Runner error codes → what the agent reads (and tells the people). The runner's error stays as the `cause` of the
 * words given, so a caller can still tell where it failed (a Vault key's use, ADR 0144 §4).
 */
function explain(
  error: unknown,
  status: MachineStatus | null,
  { path, device = false, tooLarge }: { path?: string; device?: boolean; tooLarge?: string } = {},
): Error {
  if (!(error instanceof MachineRequestError)) return error instanceof Error ? error : new Error(String(error));
  const said = (message: string) => new Error(message, { cause: error });
  const name = status?.name ?? "computer";
  const managed = status?.kind === "managed";
  switch (error.code) {
    case "exec_disabled":
      // A runner that reports access (protocol 10) has a switch for it; an older one only its start flag.
      return said(
        status?.access
          ? `Commands are turned off on the computer ${name}: you can only read, write, list and upload files there. Tell the people: only the person at ${name} can turn commands on, ${personAtComputerWay(status, "Tools, Commands", ["tools enable commands"])}.`
          : `Commands are turned off on the computer ${name} (its runner was started with --no-exec): you can only read, write, list and upload files there. Tell the person; its owner can restart the runner without --no-exec.`,
      );
    // The runner names what is wrong with the path and what to use instead.
    case "outside_workspace":
    case "not_found":
      return said(error.message);
    case "too_large":
      return said(
        tooLarge ??
          `${path ?? "The file"} is too large to read here (max ${MB(MAX_INLINE_FILE_BYTES)}). upload_file sends it to the Drive, up to ${MB(ARTIFACT_LIMITS.fileBytes)}.`,
      );
    case "upload_failed":
      return said(`${path ?? "The file"} didn't reach the Drive. ${error.message}`);
    case "pull_failed":
      return said(`${path ?? "The file"} didn't reach ${name}: ${error.message}`);
    case "not_allowed":
      // The command policy's `never` (a push our git proxy refuses): callers read its code, as below.
      return policyRefusal(error.message)
        ? error
        : said(notAllowedMessage(name, error.message, path, managed, device && status ? status : undefined));
    case "paused":
      return said(
        `The owner paused the computer ${name}: nothing new can start there until they resume it. Tell the people.`,
      );
    case "timeout":
    case "canceled":
      return said(error.message);
    // The command policy held it: its message says why and how to ask a person, and callers read its code.
    case "approval_needed":
      return error;
    default:
      return said(`The computer ${name} failed: ${error.message}`);
  }
}

/** A tool's `length` and `classes`, what a site's rules asked for; anything left out, the strong default. */
function passwordRules(input: { length?: unknown; classes?: unknown }) {
  const length = typeof input.length === "number" ? input.length : PASSWORD_LENGTH.default;
  const given = Array.isArray(input.classes)
    ? PASSWORD_CLASSES.filter((c) => (input.classes as unknown[]).includes(c))
    : [];
  return { length, classes: (given.length > 0 ? given : [...PASSWORD_CLASSES]) as PasswordClass[] };
}

/**
 * A new password made on the agent's computer (ADR 0144 §8): it comes back sealed to a key pair made for this one
 * call, whose private half never leaves this function, so everything between (the hub, a relay, root in system mode)
 * only ever holds a box. Opened here for the caller to seal into the Vault at once.
 */
export async function requestMadePassword(
  hub: MachineCaller,
  machineId: string,
  agent: AgentScope,
  input: { length?: unknown; classes?: unknown },
  signal?: AbortSignal,
): Promise<string> {
  const status = await hub.status(machineId);
  const name = status?.name ?? "computer";
  if (!status || status.protocol < VAULT_PASSWORD_PROTOCOL)
    throw new Error(vaultUpdateText(status ?? { name }, "make passwords"));
  const pair = await generateSecretKeyPair();
  const requestId = crypto.randomUUID();
  try {
    const reply = await hub.call<"vault.password">(
      machineId,
      { agent, op: "vault.password", requestId, publicKey: pair.publicKey, rules: passwordRules(input) },
      { signal, timeoutMs: 30_000 },
    );
    return await openSecret(pair.privateKey, reply.box, madePasswordAad({ requestId, agentId: String(agent.id) }));
  } catch (error) {
    if (error instanceof MachineOfflineError || error instanceof MachinePausedError) throw error;
    if (error instanceof MachineRequestError) throw explain(error, status);
    throw new Error(`The password from the computer ${name} didn't open. Nothing was saved. Try again.`);
  }
}

/**
 * Connected machines as a `SandboxProvider` (ADR 0025): the channel over the hub. A machine is on while its
 * runner is connected; people pair it, and we never create, start or stop it. Files travel base64 up to 5 MB;
 * past that the computer moves them itself over HTTP, to our upload URL (`push`) or from our file URL (`pull`).
 * Every request is for `agent`, which the runner keeps in its own folder of the workspace.
 */
export function createMachineSandboxProvider(hub: MachineCaller, agent: AgentScope, device = false): SandboxProvider {
  const guard = async <T>(id: string, fn: () => Promise<T>, path?: string, tooLarge?: string): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof MachineOfflineError || error instanceof MachinePausedError) throw error;
      throw explain(error, await hub.status(id), { path, device, tooLarge });
    }
  };
  const pullRefusal = async (id: string) => {
    const status = await hub.status(id);
    return status && status.protocol < FILE_PULL_PROTOCOL ? pullUpdateText(status) : null;
  };
  const execOn = async (
    id: string,
    request: ExecRequest,
    onOutput?: (stream: "stdout" | "stderr", chunk: string) => void,
  ): Promise<ExecResult> =>
    guard(id, async () => {
      const r = await hub.call(
        id,
        {
          agent,
          op: "exec",
          command: request.command,
          ...(request.cwd ? { cwd: request.cwd } : {}),
          timeoutSeconds: request.timeoutSeconds,
          stream: Boolean(onOutput),
          ...(request.approved ? { approved: true } : {}),
          ...(request.mergeRepos?.length ? { mergeRepos: request.mergeRepos } : {}),
          // Vault keys for this one command (ADR 0144), sealed to a one-use key of this computer.
          ...(request.vault ? { vault: request.vault } : {}),
        },
        { signal: request.signal, onOutput },
      );
      return {
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        ...(r.canceled ? { canceled: r.canceled } : {}),
        ...(r.merge ? { merge: r.merge } : {}),
      };
    });
  return {
    id: MACHINE_PROVIDER_ID,
    exec: (id, request) => execOn(id, request),
    execStream: (id, request, onOutput) => execOn(id, request, onOutput),
    async writeFile(id, path, data) {
      if (data.byteLength > MAX_INLINE_FILE_BYTES) {
        throw new Error(
          `${path} is too large to write in one piece (max ${MB(MAX_INLINE_FILE_BYTES)}). A Drive file reaches the computer whole with import_file, up to ${MB(ARTIFACT_LIMITS.fileBytes)}.`,
        );
      }
      await guard(
        id,
        () => hub.call(id, { agent, op: "write", path, base64: Buffer.from(data).toString("base64") }),
        path,
      );
    },
    async readFile(id, path) {
      const r = await guard(id, () => hub.call(id, { agent, op: "read", path, maxBytes: MAX_INLINE_FILE_BYTES }), path);
      return r.base64 === null ? null : new Uint8Array(Buffer.from(r.base64, "base64"));
    },
    async listFiles(id, path, depth = 3) {
      const r = await guard(id, () => hub.call(id, { agent, op: "list", path, depth }), path);
      return r.entries;
    },
    async secret(id, request) {
      const status = await hub.status(id);
      if (status && status.protocol < SECRETS_PROTOCOL) {
        throw new Error(
          `The runner on the computer ${status.name} is too old to keep secrets. ${runnerUpdateWay(status)}`,
        );
      }
      if (
        status &&
        status.protocol < SECRET_ACTIVATE_PROTOCOL &&
        (request.action === "keypair" || request.action === "deliver" || request.action === "activate")
      ) {
        throw new Error(
          `The runner on the computer ${status.name} is too old for safe secret delivery. ${runnerUpdateWay(status)}`,
        );
      }
      try {
        return await hub.call(id, { agent, op: "secret", ...request });
      } catch (error) {
        // The runner's own words ("This request's key is gone…"), not the file-tool wording.
        if (error instanceof MachineRequestError && error.code !== "timeout" && error.code !== "canceled") {
          throw new Error(error.message, { cause: error });
        }
        throw error;
      }
    },
    async pushFile(id, path, target) {
      return guard(
        id,
        () =>
          hub
            .call(id, {
              agent,
              op: "push",
              path,
              url: target.url,
              uploadId: target.uploadId,
              maxBytes: target.maxBytes,
            })
            .catch((error: unknown) => {
              if (!(error instanceof MachineRequestError) || error.code !== "too_large") throw error;
              throw new Error(
                `${path} is over the ${MB(target.maxBytes)} the Drive takes per file, so it stayed on the computer. Make it smaller (a video: re-encode it at a lower resolution or bitrate) or send it in parts under ${MB(target.maxBytes)}, then upload again.`,
                { cause: error },
              );
            }),
        path,
        `${path} is too large to send to the Drive (max ${MB(target.maxBytes)}).`,
      );
    },
    pullRefusal,
    async pullFile(id, path, { signal, ...source }) {
      const refusal = await pullRefusal(id);
      if (refusal) throw new Error(refusal);
      await guard(id, () => hub.call(id, { agent, op: "pull", path, ...source }, { signal }), path);
    },
  };
}

/** What a computer too old for `pull` answers for a file past what a `write` carries. */
export const pullUpdateText = (status: Pick<MachineStatus, "name" | "kind" | "executors">) =>
  vaultUpdateText(status, `receive files over ${MB(MAX_INLINE_FILE_BYTES)}`);

/** What a computer too old for the Vault answers (ADR 0144), with how it gets its update (`runnerUpdateWay`). */
export const vaultUpdateText = (
  status: { name: string; kind?: MachineStatus["kind"]; executors?: { mode?: string } | null },
  what: string,
) => `The computer ${status.name} needs an update to ${what}. ${runnerUpdateWay(status)}`;

/** A one-use key on the agent's computer (ADR 0144, protocol 45): a Vault value is sealed to it, never sent bare. */
export type VaultKey = { keyId: string; publicKey: string; expiresAt: string };

/**
 * Asks the agent's runner for a one-use key (`vault.key`): the private key stays in that computer's memory (in the
 * agent's own worker in system mode) for two minutes and one opening. Throws an error the agent reads when the
 * computer is too old (`what` says what for) or refuses.
 */
export async function requestVaultKey(
  hub: MachineCaller,
  machineId: string,
  agent: AgentScope,
  what: string,
  signal?: AbortSignal,
): Promise<VaultKey> {
  const status = await hub.status(machineId);
  const name = status?.name ?? "computer";
  if (!status || status.protocol < VAULT_PROTOCOL) throw new Error(vaultUpdateText(status ?? { name }, what));
  try {
    const reply = await hub.call<"vault.key">(machineId, { agent, op: "vault.key" }, { signal, timeoutMs: 30_000 });
    const key = reply?.vaultKey;
    if (!key?.keyId || !key.publicKey) throw new Error(`The computer ${name} made no key for the Vault.`);
    return { keyId: key.keyId, publicKey: key.publicKey, expiresAt: key.expiresAt };
  } catch (error) {
    if (error instanceof MachineOfflineError || error instanceof MachinePausedError) throw error;
    throw explain(error, status);
  }
}
