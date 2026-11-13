import { createHash } from "node:crypto";
import {
  generateSecretKeyPair,
  MACHINE_PROTOCOL_VERSION,
  type MachineReplies,
  type MachineRequest,
  openSecret,
  type PubSub,
  type SecretRequest,
  type ServerFrame,
} from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import {
  confirmDeviceCode,
  grantScopes,
  type MachineHub,
  MachineRequestError,
  openFilePull,
  pollDeviceToken,
  receiveMachineUpload,
  setAgentComputerTarget,
  startDeviceCode,
} from "../src";
import type { Fixture } from "./fixtures";

/**
 * A runner's `push` for a fake hub: the file at the request's path in the agent's folder (`folder`) goes to its
 * upload as that machine, the way a real runner sends it to the upload URL.
 */
export async function pushFromFolder(
  f: Fixture,
  machineId: string,
  folder: Map<string, Uint8Array>,
  req: Extract<MachineRequest, { op: "push" }>,
): Promise<MachineReplies["push"]> {
  const body = folder.get(req.path);
  if (!body) throw new MachineRequestError("not_found", `no ${req.path}`);
  const name = req.path.split("/").at(-1) ?? req.path;
  const sha256 = createHash("sha256").update(body).digest("hex");
  await receiveMachineUpload(
    { db: f.db, artifacts: f.artifactDeps, pubsub: f.pubsub },
    { uploadId: req.uploadId, machineId, name, contentType: "", sha256, body },
  );
  return { name, size: body.byteLength, sha256, contentType: "" };
}

export interface PairInput {
  name?: string;
  hostname?: string;
  os?: string;
  arch?: string;
  version?: string;
  protocol?: number;
  workspace?: string;
  exec?: boolean;
}

/**
 * Connects a computer the way the device-code flow does (ADR 0036 §5): the
 * computer asks for a code, `actorId` confirms it for `orgId`, the computer
 * polls for its token. Returns what the old pairing returned.
 */
export async function pairMachine(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  input: PairInput = {},
) {
  const start = await startDeviceCode(
    { db: deps.db, publicUrl: "https://agentes.chat" },
    {
      name: input.name ?? "",
      os: input.os ?? "linux",
      arch: input.arch ?? "x64",
      hostname: input.hostname ?? "box",
      version: input.version ?? "0.1.0",
      ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
      ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
      ...(input.exec !== undefined ? { exec: input.exec } : {}),
    },
    // Each test pairing from its own address: the per-address cap never gets in the way.
    { ip: `198.51.100.${Math.floor(Math.random() * 250)}:${crypto.randomUUID()}` },
  );
  await confirmDeviceCode(deps, actorId, orgId, start.userCode, { name: input.name });
  const token = await pollDeviceToken(deps, start.deviceCode);
  if (!token.ok) throw new Error(`pairing failed: ${token.error}`);
  return { machineId: token.machineId, name: token.name, token: token.token };
}

export const RUNNER = {
  hostname: "box",
  os: "linux",
  arch: "x64",
  version: "0.1.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/home/u/agentes",
};

type Request = Extract<ServerFrame, { type: "request" }>;

export interface FakeRunnerOptions {
  exec?: (
    req: Extract<Request, { op: "exec" }>,
    out: (stream: "stdout" | "stderr", chunk: string) => void,
  ) =>
    | { exitCode: number; stdout: string; stderr: string; timedOut?: boolean }
    | "hang"
    /** The runner refuses it (`approval_needed`: its command policy held it). */
    | { fail: { code: string; message: string } };
  push?: (req: Extract<Request, { op: "push" }>, bytes: Uint8Array, name: string) => Promise<void>;
  /** What this computer fetches for a `pull`; `connectedComputer`'s default goes to `openFilePull` as its machine. */
  pull?: (req: Extract<Request, { op: "pull" }>) => Promise<Uint8Array>;
  /** Says hello at this protocol (`connectedComputer`). */
  protocol?: number;
  execAllowed?: boolean;
  /** A socket whose close never reaches the hub (a runner killed behind a proxy: half-open). */
  dead?: boolean;
  /** Pause a staged secret before answering, for delivery/decline races. */
  onSecretStaged?: (requestId: string) => Promise<void>;
  /** Pause activation before checking the current value, for replacement races. */
  onSecretActivate?: (requestId: string) => Promise<void>;
  /** Pause after the runner stores the value, before its reply reaches the server. */
  onSecretActivated?: (requestId: string) => Promise<void>;
  /** Keeps a site's password for its browser alone, as runners do from then on (`keypair` says `sites`). */
  sites?: boolean;
}

/**
 * A runner over an in-memory socket: files in a map, commands answered by
 * `exec`, uploads handed to `push`. Replies come on a later tick, like a network.
 */
export function fakeRunner(hub: MachineHub, options: FakeRunnerOptions = {}) {
  const sent: ServerFrame[] = [];
  const files = new Map<string, Uint8Array>();
  /** Like the real runner: private keys and ciphertext before activation. */
  const keys = new Map<string, string>();
  const staged = new Map<string, Extract<SecretRequest, { action: "deliver" }>>();
  const secrets = new Map<string, string>();
  const orders = new Map<string, string>();
  const activated = new Map<string, { name: string; value: string; order: string }>();
  const canceled = new Set<string>();
  let closed: { code?: number; reason?: string } | null = null;
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const handle = async (req: Request) => {
    const ok = (data: unknown) => reply({ type: "result", id: req.id, ok: true, data });
    const fail = (code: string, message: string) =>
      reply({ type: "result", id: req.id, ok: false, error: { code, message } });
    switch (req.op) {
      case "secret": {
        if (req.action === "keypair") {
          const pair = await generateSecretKeyPair();
          keys.set(req.requestId, pair.privateKey);
          return ok({ publicKey: pair.publicKey, ...(options.sites ? { sites: true } : {}) });
        }
        if (req.action === "deliver") {
          const key = keys.get(req.requestId);
          if (!key) return fail("not_found", "This request's key is gone");
          const value = await openSecret(key, req.box, req.aad).catch(() => null);
          if (value === null) return fail("bad_request", "The secret couldn't be opened");
          // The real runner receives MachineRequest after the wire's request id is stripped.
          const delivery = {
            action: req.action,
            requestId: req.requestId,
            name: req.name,
            target: req.target,
            aad: req.aad,
            box: req.box,
          };
          const previous = staged.get(req.requestId);
          if (previous && JSON.stringify(previous) !== JSON.stringify(delivery))
            return fail("conflict", "This request is already staged with another box");
          if (!previous) staged.set(req.requestId, delivery);
          await options.onSecretStaged?.(req.requestId);
          return ok({ size: Buffer.byteLength(value) });
        }
        if (req.action === "activate") {
          await options.onSecretActivate?.(req.requestId);
          if (canceled.has(req.requestId)) return ok({ superseded: true });
          const delivery = staged.get(req.requestId);
          const key = keys.get(req.requestId);
          if (!delivery || !key) {
            const prior = activated.get(req.requestId);
            if (prior && (orders.get(prior.name) ?? "") > req.order) return ok({ superseded: true });
            if (prior && orders.get(prior.name) === prior.order) return ok({ size: Buffer.byteLength(prior.value) });
            return fail("not_found", "This request has no staged secret");
          }
          if ((orders.get(delivery.name) ?? "") > req.order) return ok({ superseded: true });
          const value = await openSecret(key, delivery.box, delivery.aad);
          keys.delete(req.requestId);
          staged.delete(req.requestId);
          secrets.set(delivery.name, value);
          orders.set(delivery.name, req.order);
          activated.set(req.requestId, { name: delivery.name, value, order: req.order });
          await options.onSecretActivated?.(req.requestId);
          return ok({ size: Buffer.byteLength(value) });
        }
        if (req.action === "discard") {
          keys.delete(req.requestId);
          staged.delete(req.requestId);
        }
        if (req.action === "remove") {
          const selected = (id: string, prior: { order: string }) =>
            !req.requestIds ||
            req.requestIds.includes(id) ||
            (req.throughOrder !== undefined && prior.order <= req.throughOrder);
          for (const [id, prior] of activated)
            if (prior.name === req.name && selected(id, prior)) {
              activated.delete(id);
              if (orders.get(req.name) === prior.order) secrets.delete(req.name);
            }
          if (!req.requestIds) secrets.delete(req.name);
          for (const id of req.requestIds ?? []) {
            canceled.add(id);
            keys.delete(id);
            staged.delete(id);
          }
        }
        return ok({});
      }
      case "exec": {
        if (options.execAllowed === false) return fail("exec_disabled", "commands are off");
        const r = options.exec?.(req, (stream, chunk) => void reply({ type: "output", id: req.id, stream, chunk })) ?? {
          exitCode: 0,
          stdout: `ran: ${req.command}`,
          stderr: "",
        };
        if (r === "hang") return; // answers only to `cancel`
        if ("fail" in r) return fail(r.fail.code, r.fail.message);
        return ok({ timedOut: false, ...r });
      }
      case "write":
        files.set(req.path, new Uint8Array(Buffer.from(req.base64, "base64")));
        return ok({ size: files.get(req.path)?.byteLength });
      case "read": {
        const data = files.get(req.path);
        return ok({ base64: data ? Buffer.from(data).toString("base64") : null, size: data?.byteLength ?? 0 });
      }
      case "list":
        return ok({ entries: [...files.entries()].map(([path, d]) => ({ path, isDir: false, size: d.byteLength })) });
      case "push": {
        const data = files.get(req.path);
        if (!data) return fail("not_found", `no ${req.path}`);
        const name = req.path.split("/").at(-1) ?? req.path;
        await options.push?.(req, data, name);
        return ok({
          name,
          size: data.byteLength,
          sha256: createHash("sha256").update(data).digest("hex"),
          contentType: "",
        });
      }
      case "pull": {
        try {
          const data = (await options.pull?.(req)) ?? new Uint8Array();
          files.set(req.path, data);
          return ok({ size: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") });
        } catch (error) {
          return fail("pull_failed", error instanceof Error ? error.message : String(error));
        }
      }
    }
  };
  const socket = {
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      sent.push(frame);
      if (frame.type === "request") setTimeout(() => void handle(frame), 1);
      if (frame.type === "cancel") {
        setTimeout(
          () =>
            void reply({
              type: "result",
              id: frame.id,
              ok: true,
              data: { exitCode: 130, stdout: "", stderr: "", timedOut: false, canceled: { killed: true } },
            }),
          1,
        );
      }
    },
    close(code?: number, reason?: string) {
      closed = { code, reason };
      if (!options.dead) void hub.close(conn);
    },
  };
  const conn = hub.open(socket);
  return {
    conn,
    sent,
    files,
    keys,
    staged,
    secrets,
    closed: () => closed,
    hello: (token: string, extra: Record<string, unknown> = {}) =>
      hub.message(
        conn,
        JSON.stringify({ type: "hello", token, ...RUNNER, exec: options.execAllowed !== false, ...extra }),
      ),
    disconnect: () => hub.close(conn),
    /** Sends a frame as this runner. */
    frame: (frame: Record<string, unknown>) => reply(frame),
  };
}

/** A connected computer for `f`'s agent: paired, `sandbox:run` granted, the agent on it, its runner said hello. */
export async function connectedComputer(f: Fixture, options: FakeRunnerOptions = {}, name = "Build box") {
  const deps = { db: f.db, pubsub: f.pubsub };
  const paired = await pairMachine(deps, f.owner.id, f.org.id, {
    name,
    ...RUNNER,
    exec: options.execAllowed !== false,
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "sandbox:run" }]);
  await setAgentComputerTarget(deps, f.owner.id, f.org.id, f.agent.id, paired.machineId);
  const runner = fakeRunner(f.machineHub as MachineHub, {
    pull: async (req) => {
      const { body } = await openFilePull(f.artifactDeps, req.pullId, paired.machineId);
      return new Uint8Array(await new Response(body).arrayBuffer());
    },
    ...options,
  });
  await runner.hello(paired.token, options.protocol ? { protocol: options.protocol } : {});
  return { paired, runner };
}
