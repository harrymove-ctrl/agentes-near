import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentScope, MachineReplies, SecretRequest } from "@agenteschat/adapters/machine-protocol";
import {
  generateSecretKeyPair,
  isReservedSecretName,
  openSecret,
  redactSecrets,
  SECRET_NAME,
} from "@agenteschat/adapters/secret-box";
import { originOf } from "./browser";
import { errnoCode, RunnerError } from "./errors";
import { touchesGitInternals } from "./git-guard";
import { agentFolderName, isInside, normalizeRequestPath, resolveInWorkspace } from "./paths";
import { runnerVault } from "./vault";

/**
 * Each agent's secrets on this machine (ADR 0027), outside the workspace so
 * the file tools never reach them: `<runner home>/secrets/<agent id8>/`
 * (mode 700), with `keys/<requestId>` (the private key of a pending request)
 * and `store.json` (delivered values), both mode 600. A site's password or
 * code (target `site`) never goes in `store.json`: this process keeps it in
 * memory for its browser for 15 minutes after activation (ADR 0144,
 * `vault.ts`), and one an older runner left there is removed.
 */
interface Stored {
  name: string;
  /** `site`: only the agent browser types it, on that site; never a command's environment. */
  target: { kind: "env" } | { kind: "file"; path: string } | { kind: "site"; site: string };
  value: string;
  deliveredAt: string;
  requestId?: string;
  order?: string;
}

type Staged = Extract<SecretRequest, { action: "deliver" }>;
/** Root sends this to the worker only after the server committed delivery. */
export type ActivatedSecret = {
  action: "install";
  requestId: string;
  name: string;
  target: Stored["target"];
  value: string;
  order: string;
};

const REQUEST_ID = /^[a-zA-Z0-9-]{8,64}$/;
/** Keys of requests nobody answered (expired, canceled) are dropped after this. */
const STALE_KEY_MS = 3600_000;

async function pruneKeys(keysDir: string) {
  const names = await readdir(keysDir).catch(() => [] as string[]);
  for (const name of names) {
    const file = path.join(keysDir, name);
    const st = await stat(file).catch(() => null);
    if (!st || Date.now() - st.mtimeMs <= STALE_KEY_MS) continue;
    const staged = path.join(path.dirname(keysDir), "staged", name);
    const stagedStat = await stat(staged).catch(() => null);
    // A committed delivery can wait for the machine to reconnect before the
    // outbox activates it. Keep its key while the staged box is recoverable.
    if (stagedStat && Date.now() - stagedStat.mtimeMs <= 7 * 24 * STALE_KEY_MS) continue;
    await rm(file, { force: true });
    if (stagedStat) await rm(staged, { force: true });
  }
}

const dirOf = (root: string, agent: AgentScope) => path.join(root, agentFolderName(agent).suffix.slice(1));

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
}

async function readRawStore(dir: string): Promise<Stored[]> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, "store.json"), "utf8")) as { secrets?: Stored[] };
    return Array.isArray(raw.secrets) ? raw.secrets : [];
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return [];
    throw err;
  }
}

const isSite = (s: Stored | undefined) => s?.target?.kind === "site";

/** The kept values: never a site's, even one an older runner wrote there before `purgeSitesLocked` removed it. */
async function readStore(dir: string): Promise<Stored[]> {
  return (await readRawStore(dir)).filter((s) => !isSite(s));
}

/** Folders whose `store.json` this process already rid of site secrets. */
const purged = new Set<string>();

/** ADR 0144: `store.json` rewritten without any `site` entry, once per folder per process (under its queue). */
async function purgeSitesLocked(dir: string) {
  if (purged.has(dir)) return;
  purged.add(dir);
  const all = await readRawStore(dir).catch(() => null);
  if (!all?.some(isSite)) return;
  await writeStore(
    dir,
    all.filter((s) => !isSite(s)),
  );
}

/** From a reader (not under the queue): the rewrite waits its turn. */
function purgeSoon(dir: string) {
  if (purged.has(dir)) return;
  void withQueue(dir, () => purgeSitesLocked(dir)).catch(() => {
    purged.delete(dir);
  });
}

/**
 * At start: every agent's `store.json` under `root` loses the site passwords an older runner kept there (ADR 0144).
 * Readers skip them meanwhile.
 */
export async function dropStoredSiteSecrets(root: string): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) purgeSoon(path.join(root, name));
}

/** Written whole, then renamed: a crash never leaves half a file. */
async function writeStore(dir: string, secrets: Stored[]) {
  const file = path.join(dir, "store.json");
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ secrets }), { mode: 0o600 });
  await rename(tmp, file);
}

const keyFile = (dir: string, requestId: string) => {
  if (!REQUEST_ID.test(requestId)) throw new RunnerError("bad_request", "Invalid request id");
  return path.join(dir, "keys", requestId);
};
const stagedFile = (dir: string, requestId: string) => {
  if (!REQUEST_ID.test(requestId)) throw new RunnerError("bad_request", "Invalid request id");
  return path.join(dir, "staged", requestId);
};
const canceledFile = (dir: string, requestId: string) =>
  path.join(dir, "canceled", path.basename(stagedFile(dir, requestId)));
const orderFile = (dir: string, name: string) => {
  if (!SECRET_NAME.test(name)) throw new RunnerError("bad_request", "Invalid secret name");
  return path.join(dir, "orders", name);
};
const removedFile = (dir: string, name: string) => {
  if (!SECRET_NAME.test(name)) throw new RunnerError("bad_request", "Invalid secret name");
  return path.join(dir, "removed-through", name);
};
async function removedThrough(dir: string, name: string) {
  return readFile(removedFile(dir, name), "utf8").catch((err) => {
    if (errnoCode(err) === "ENOENT") return "";
    throw err;
  });
}
async function markRemovedThrough(dir: string, name: string, order: string) {
  if (order <= (await removedThrough(dir, name))) return;
  const file = removedFile(dir, name);
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, order, { mode: 0o600 });
  await rename(tmp, file);
}
async function latestOrder(dir: string, name: string, stored: Stored | undefined) {
  const persisted = await readFile(orderFile(dir, name), "utf8").catch((err) => {
    if (errnoCode(err) === "ENOENT") return "";
    throw err;
  });
  return persisted > (stored?.order ?? "") ? persisted : (stored?.order ?? "");
}
async function writeOrder(dir: string, name: string, order: string) {
  const file = orderFile(dir, name);
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, order, { mode: 0o600 });
  await rename(tmp, file);
}
async function cancelStaged(dir: string, requestId: string) {
  const marker = canceledFile(dir, requestId);
  await ensureDir(path.dirname(marker));
  await writeFile(marker, "", { mode: 0o600 });
  await rm(keyFile(dir, requestId), { force: true });
  await rm(stagedFile(dir, requestId), { force: true });
}

/** A delivery's target as it was asked for: a site is an origin (`https://host`), or the request is refused. */
function targetOf(raw: Stored["target"] | undefined): Stored["target"] {
  if (raw?.kind === "file") return { kind: "file", path: String(raw.path) };
  if (raw?.kind !== "site") return { kind: "env" };
  const site = String(raw.site);
  if (originOf(site) !== site)
    throw new RunnerError("bad_request", "A site secret's site must be its origin (https://host)");
  return { kind: "site", site };
}

/** `agentes-secret|v1|<request>|<org>|<name>|<target>`: the server's AAD must name this request, secret and target. */
function checkAad(aad: string, requestId: string, name: string, target: Stored["target"]) {
  const parts = String(aad).split("|");
  const want = target.kind === "file" ? `file:${target.path}` : target.kind === "site" ? `site:${target.site}` : "env";
  if (
    parts.length !== 6 ||
    parts[0] !== "agentes-secret" ||
    parts[2] !== requestId ||
    parts[4] !== name ||
    parts[5] !== want
  ) {
    throw new RunnerError("bad_request", "The secret doesn't match its request");
  }
}

const secretQueues = new Map<string, Promise<void>>();

/** One agent folder's mutations, one after another. */
async function withQueue<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = secretQueues.get(dir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  secretQueues.set(dir, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (secretQueues.get(dir) === current) secretQueues.delete(dir);
  }
}

/** Serialize an agent's secret mutations, including activation against removal. */
export async function handleSecret(
  root: string,
  agent: AgentScope | undefined,
  workspaceReal: string,
  req: SecretRequest | ActivatedSecret,
  options: { storageOnly?: boolean } = {},
): Promise<MachineReplies["secret"]> {
  if (!agent) throw new RunnerError("bad_request", "Secrets belong to an agent");
  const dir = dirOf(root, agent);
  return withQueue(dir, async () => {
    await purgeSitesLocked(dir);
    return handleSecretLocked(dir, workspaceReal, req, options);
  });
}

async function handleSecretLocked(
  dir: string,
  workspaceReal: string,
  req: SecretRequest | ActivatedSecret,
  options: { storageOnly?: boolean },
): Promise<MachineReplies["secret"]> {
  switch (req.action) {
    case "keypair": {
      const file = keyFile(dir, req.requestId);
      await ensureDir(path.dirname(file));
      await pruneKeys(path.dirname(file));
      const pair = await generateSecretKeyPair();
      await writeFile(file, pair.privateKey, { mode: 0o600 });
      // This runner keeps a site's password for its browser alone.
      return { publicKey: pair.publicKey, sites: true };
    }
    case "deliver": {
      if (!SECRET_NAME.test(String(req.name)) || isReservedSecretName(String(req.name))) {
        throw new RunnerError("bad_request", "Invalid secret name");
      }
      const target = targetOf(req.target);
      checkAad(req.aad, req.requestId, req.name, target);
      const file = keyFile(dir, req.requestId);
      let privateKey: string;
      try {
        privateKey = await readFile(file, "utf8");
      } catch (err) {
        if (errnoCode(err) === "ENOENT")
          throw new RunnerError(
            "not_found",
            "This request's key is gone (it expired or predates the secure broker). Ask the owner to reissue it.",
          );
        throw err;
      }
      let value: string;
      try {
        value = await openSecret(privateKey, req.box, req.aad);
      } catch {
        throw new RunnerError("bad_request", "The secret couldn't be opened (wrong key or altered on the way)");
      }
      if (target.kind === "file") {
        const resolved = options.storageOnly
          ? { rel: normalizeRequestPath(target.path), abs: target.path }
          : await resolveInWorkspace(workspaceReal, target.path);
        if (resolved.rel === "") throw new RunnerError("bad_request", "Can't write a secret over the workspace");
        // The worker rechecks symlinks at committed installation time.
        if (touchesGitInternals(target.path, resolved.abs)) {
          throw new RunnerError("bad_request", "A secret can't be written inside a .git folder");
        }
      }
      // Before the server commits, keep only ciphertext and never expose the
      // value to commands, browser use, or files in the workspace.
      const staged = stagedFile(dir, req.requestId);
      await ensureDir(path.dirname(staged));
      const payload = JSON.stringify(req);
      try {
        await writeFile(staged, payload, { flag: "wx", mode: 0o600 });
      } catch (err) {
        if (errnoCode(err) !== "EEXIST" || (await readFile(staged, "utf8")) !== payload) throw err;
        // A lost stage reply may be retried with the same sealed box.
      }
      return { size: Buffer.byteLength(value) };
    }
    case "activate": {
      if (!req.order || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\|[a-zA-Z0-9-]{8,64}$/.test(req.order))
        throw new RunnerError("bad_request", "Invalid secret delivery order");
      if (
        await stat(canceledFile(dir, req.requestId)).then(
          () => true,
          (err) => {
            if (errnoCode(err) === "ENOENT") return false;
            throw err;
          },
        )
      )
        return { superseded: true };
      const staged = stagedFile(dir, req.requestId);
      let delivery: Staged;
      try {
        delivery = JSON.parse(await readFile(staged, "utf8")) as Staged;
      } catch (err) {
        if (errnoCode(err) !== "ENOENT") throw err;
        // An activation reply can be lost after the store (or, for a site, this process's memory) was written.
        const held = runnerVault.siteByRequest(dir, req.requestId);
        if (held) {
          if ((await latestOrder(dir, held.name, undefined)) > req.order) {
            await cancelStaged(dir, req.requestId);
            return { superseded: true };
          }
          return { size: held.size };
        }
        const secrets = await readStore(dir);
        const own = secrets.find((s) => s.requestId === req.requestId);
        const current = own ? secrets.filter((s) => s.name === own.name).at(-1) : null;
        if (own && (await latestOrder(dir, own.name, current ?? undefined)) > req.order) {
          await cancelStaged(dir, req.requestId);
          return { superseded: true };
        }
        if (own && current?.requestId === req.requestId) return { size: Buffer.byteLength(own.value) };
        throw new RunnerError("not_found", "This request has no staged secret. Ask the owner to reissue it.");
      }
      if (delivery.action !== "deliver" || delivery.requestId !== req.requestId)
        throw new RunnerError("bad_request", "Invalid staged secret");
      const file = keyFile(dir, req.requestId);
      const privateKey = await readFile(file, "utf8");
      const value = await openSecret(privateKey, delivery.box, delivery.aad);
      const target = targetOf(delivery.target);
      checkAad(delivery.aad, delivery.requestId, delivery.name, target);
      const current = (await readStore(dir)).filter((s) => s.name === delivery.name).at(-1);
      if ((await removedThrough(dir, delivery.name)) >= req.order) {
        await cancelStaged(dir, req.requestId);
        return { superseded: true };
      }
      if ((await latestOrder(dir, delivery.name, current ?? undefined)) > req.order) {
        await cancelStaged(dir, req.requestId);
        return { superseded: true };
      }
      const installed = await installLocked(
        dir,
        workspaceReal,
        {
          action: "install",
          requestId: req.requestId,
          name: delivery.name,
          target,
          value,
          order: req.order,
        },
        options,
      );
      await rm(file, { force: true });
      await rm(staged, { force: true });
      return installed;
    }
    case "install":
      return installLocked(dir, workspaceReal, req, options);
    case "discard":
      await rm(keyFile(dir, req.requestId), { force: true });
      await rm(stagedFile(dir, req.requestId), { force: true });
      return {};
    case "remove": {
      const secrets = await readStore(dir);
      // A worker install already sent by root may arrive after this removal.
      // The server's throughOrder fences the entire removed generation, even
      // when its request id was omitted from the requestIds list.
      if (req.throughOrder) await markRemovedThrough(dir, req.name, req.throughOrder);
      const selected = (s: Stored) =>
        s.name === req.name &&
        (!req.requestIds ||
          (s.requestId !== undefined && req.requestIds.includes(s.requestId)) ||
          (req.throughOrder !== undefined && (s.order ?? "") <= req.throughOrder));
      const gone = secrets.filter(selected);
      runnerVault.dropSites(
        dir,
        (s) =>
          s.name === req.name &&
          (!req.requestIds ||
            req.requestIds.includes(s.requestId) ||
            (req.throughOrder !== undefined && s.order <= req.throughOrder)),
      );
      const otherPaths = new Set(
        secrets.flatMap((s) => (!selected(s) && s.target.kind === "file" ? [s.target.path] : [])),
      );
      for (const old of options.storageOnly ? [] : gone) {
        if (old.target.kind !== "file" || otherPaths.has(old.target.path)) continue;
        const resolved = await resolveInWorkspace(workspaceReal, old.target.path);
        if (resolved.exists) await rm(resolved.abs, { force: true });
      }
      if (gone.length > 0)
        await writeStore(
          dir,
          secrets.filter((s) => !selected(s)),
        );
      for (const requestId of req.requestIds ?? []) {
        await cancelStaged(dir, requestId);
      }
      return {};
    }
    default:
      throw new RunnerError("bad_request", "Unknown secret action");
  }
}

/** Persist a value after the DB decision; the root broker mirrors only the store, the worker writes files. */
async function installLocked(
  dir: string,
  workspaceReal: string,
  req: ActivatedSecret,
  options: { storageOnly?: boolean },
): Promise<MachineReplies["secret"]> {
  // Removal may have won while a root-to-worker install was still in flight.
  if (
    await stat(canceledFile(dir, req.requestId)).then(
      () => true,
      (err) => {
        if (errnoCode(err) === "ENOENT") return false;
        throw err;
      },
    )
  )
    return { superseded: true };
  if ((await removedThrough(dir, req.name)) >= req.order) return { superseded: true };
  if (!SECRET_NAME.test(req.name) || isReservedSecretName(req.name))
    throw new RunnerError("bad_request", "Invalid secret name");
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\|[a-zA-Z0-9-]{8,64}$/.test(req.order))
    throw new RunnerError("bad_request", "Invalid secret delivery order");
  const target = targetOf(req.target);
  const current = (await readStore(dir)).filter((s) => s.name === req.name).at(-1);
  if ((await latestOrder(dir, req.name, current)) > req.order) return { superseded: true };
  let fileTarget: string | null = null;
  if (target.kind === "file") {
    const resolved = options.storageOnly
      ? { rel: normalizeRequestPath(target.path), abs: target.path }
      : await resolveInWorkspace(workspaceReal, target.path);
    if (resolved.rel === "") throw new RunnerError("bad_request", "Can't write a secret over the workspace");
    if (touchesGitInternals(target.path, resolved.abs))
      throw new RunnerError("bad_request", "A secret can't be written inside a .git folder");
    target.path = resolved.rel;
    fileTarget = resolved.abs;
  }
  await ensureDir(dir);
  await writeOrder(dir, req.name, req.order);
  const before = await readStore(dir);
  const next = before.filter((s) => s.name !== req.name);
  if (target.kind === "site") {
    // ADR 0144: only in this process's memory, for its browser, for 15 minutes; never in `store.json`.
    runnerVault.putSite(dir, {
      name: req.name,
      site: target.site,
      value: req.value,
      requestId: req.requestId,
      order: req.order,
    });
  } else {
    runnerVault.dropSites(dir, (s) => s.name === req.name);
    next.push({
      name: req.name,
      target,
      value: req.value,
      deliveredAt: new Date().toISOString(),
      requestId: req.requestId,
      order: req.order,
    });
  }
  const livePaths = new Set(next.flatMap((s) => (s.target.kind === "file" ? [s.target.path] : [])));
  const oldFiles = before.filter((s) => s.name === req.name && s.target.kind === "file");
  const filesToRemove = oldFiles.filter((s) => s.target.kind === "file" && !livePaths.has(s.target.path));
  // A site's own entry never goes in; one it replaces (an env or file secret of that name) goes out.
  if (target.kind !== "site" || before.some((s) => s.name === req.name)) {
    await writeStore(dir, [...oldFiles, ...next]);
  }
  if (!options.storageOnly && fileTarget) {
    await mkdir(path.dirname(fileTarget), { recursive: true });
    await writeFile(fileTarget, req.value, { mode: 0o600 });
    await chmod(fileTarget, 0o600).catch(() => undefined);
  }
  if (oldFiles.length > 0) {
    let allRemoved = true;
    for (const old of options.storageOnly ? [] : filesToRemove) {
      if (old.target.kind !== "file") continue;
      try {
        const resolved = await resolveInWorkspace(workspaceReal, old.target.path);
        if (resolved.exists) await rm(resolved.abs, { force: true });
      } catch {
        allRemoved = false;
      }
    }
    if (allRemoved) await writeStore(dir, next);
  }
  return { size: Buffer.byteLength(req.value) };
}

/** The root broker's activated value for an internal worker install, never for an agent protocol request. */
export async function activatedSecret(
  root: string,
  agent: AgentScope,
  requestId: string,
): Promise<ActivatedSecret | null> {
  const dir = dirOf(root, agent);
  const secrets = await readStore(dir);
  const stored = secrets.find((s) => s.requestId === requestId);
  if (stored?.order) {
    return {
      action: "install",
      requestId,
      name: stored.name,
      target: stored.target,
      value: stored.value,
      order: stored.order,
    };
  }
  const site = runnerVault.siteByRequest(dir, requestId);
  if (!site?.value) return null;
  return {
    action: "install",
    requestId,
    name: site.name,
    target: { kind: "site", site: site.site },
    value: site.value,
    order: site.order,
  };
}

/** Root handed a site's password to the agent's worker (ADR 0144): from here, only the worker's memory has it. */
export function handOffSiteSecret(root: string, agent: AgentScope, requestId: string) {
  runnerVault.handOff(dirOf(root, agent), requestId);
}

/** Whether root already handed this request's site password on (a lost activation reply asked again). */
export function handedSiteSecret(root: string, agent: AgentScope, requestId: string): boolean {
  const held = runnerVault.siteByRequest(dirOf(root, agent), requestId);
  return held !== null && held.value === null;
}

/**
 * What commands of this agent get: env values (never a site's password: that one only its browser types), and a
 * redactor for everything that leaves the machine: every value kept, a site's password in memory, and every Vault
 * value opened here in the last 10 minutes (ADR 0144).
 */
export async function agentSecrets(root: string | undefined, agent: AgentScope | undefined) {
  if (!agent) return null;
  const dir = root ? dirOf(root, agent) : null;
  if (dir) purgeSoon(dir);
  const secrets = dir ? await readStore(dir).catch(() => [] as Stored[]) : [];
  const values: { name: string; value: string }[] = [
    ...secrets.map((s) => ({ name: s.name, value: s.value })),
    ...(dir ? runnerVault.sitesOf(dir) : []).flatMap((s) => (s.value ? [{ name: s.name, value: s.value }] : [])),
    ...runnerVault.armedOf(String(agent.id ?? "")),
  ];
  if (values.length === 0) return null;
  const env: Record<string, string> = {};
  // One kept before its name was reserved still never reaches the env.
  for (const s of secrets) if (s.target.kind === "env" && !isReservedSecretName(s.name)) env[s.name] = s.value;
  return {
    env,
    files: secrets.flatMap((s) => (s.target.kind === "file" ? [s.target.path] : [])),
    hold: Math.max(0, ...values.map((s) => s.value.length - 1)),
    redact: (text: string) => redactSecrets(text, values),
  };
}

/** `abs` is one of the agent's secret files (`files`, relative to its folder), or a folder that holds one. */
export async function holdsSecretFile(workspaceReal: string, files: readonly string[], abs: string) {
  for (const file of files) {
    const held = await resolveInWorkspace(workspaceReal, file).catch(() => null);
    if (held && (held.abs === abs || isInside(abs, held.abs))) return true;
  }
  return false;
}

/**
 * One delivered secret by name, for the agent browser to type into a password field: its value, and the one site
 * it was given for when the person sealed it to that site (`site`). Null when there is none.
 */
export async function secretValue(
  root: string | undefined,
  agent: AgentScope,
  name: string,
): Promise<{ value: string; site: string | null } | null> {
  if (!root) return null;
  const dir = dirOf(root, agent);
  purgeSoon(dir);
  // A site's password: in memory only (ADR 0144).
  const site = runnerVault.site(dir, name);
  if (site?.value) return { value: site.value, site: site.site };
  const secrets = await readStore(dir).catch(() => [] as Stored[]);
  const held = secrets.filter((s) => s.name === name).at(-1);
  return held ? { value: held.value, site: null } : null;
}
