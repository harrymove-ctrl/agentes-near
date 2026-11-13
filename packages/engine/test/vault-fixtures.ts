import {
  orgTopic,
  type RealtimeEvent,
  type VaultConnection as SourceConnection,
  type VaultSource,
  VaultSourceError,
  type VaultSourceItem,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createAgent,
  createAgentRuns,
  insertMessage,
  type RoutineBrief,
  type VaultDeps,
  type VaultRun,
} from "../src";
import { readItemValue } from "../src/vault/seal";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * The Vault's tests (ADR 0144): one workspace (Acme) with its owner Ana, Bruno (a member in "Support"), Carla (an
 * admin, so she manages credentials) and Dora (a member in no role); agents Dev and Infra; a fake password manager.
 */

/** What the fake source's token and items' values look like: tests search every output for them. */
export const SOURCE_TOKEN = "fake-token-SHOULD-NEVER-LEAK-1234";
export const SOURCE_PASSWORD = "src-password-NEVER-SHOWN-9876";

export interface FakeSource extends VaultSource {
  items: VaultSourceItem[];
  values: Map<string, string>;
  /** Thrown by the next `list` calls while set. */
  listError: VaultSourceError | Error | null;
  /** The secrets `list` and `reveal` were handed (to prove they were unsealed). */
  seenTokens: string[];
  /** Every call, with the signal the engine gave it and the workspace `connect` was told (ADR 0144). */
  calls: {
    op: "connect" | "list" | "reveal" | "create" | "update";
    signal: AbortSignal | undefined;
    orgId: string | undefined;
  }[];
  /** Writes are refused as a token that only reads would be (a source made with `writableSource`). */
  readOnly: boolean;
  /** Writes fail as a provider's own error would, with its secrets in the text. */
  writeBroken: boolean;
}

/**
 * The fake password manager with write support, as 1Password has: a new login and a login's username or password.
 * Its refusal of a write carries the token and the password on purpose, as a provider's raw error might.
 */
export function writableSource(): FakeSource {
  const source = fakeSource();
  const mayWrite = (connection: SourceConnection, password = "") => {
    source.seenTokens.push(connection.secret.token ?? "");
    if (source.readOnly) {
      throw new VaultSourceError("read_only", "This token can only read this vault.");
    }
    if (source.writeBroken) throw new Error(`boom ${connection.secret.token} ${password}`);
  };
  source.createLogin = async (connection, login, signal) => {
    source.calls.push({ op: "create", signal, orgId: connection.orgId });
    mayWrite(connection, login.password);
    const item: VaultSourceItem = {
      ref: `made-${source.items.length + 1}`,
      kind: "login",
      title: login.title,
      ...(login.username ? { username: login.username } : {}),
      ...(login.website ? { websites: [{ url: login.website, match: login.match ?? "exact" }] } : {}),
    };
    source.items.push(item);
    source.values.set(item.ref, login.password);
    return { ...item };
  };
  source.updateLogin = async (connection, ref, change, signal) => {
    source.calls.push({ op: "update", signal, orgId: connection.orgId });
    mayWrite(connection, change.password);
    const item = source.items.find((i) => i.ref === ref);
    if (!item) throw new VaultSourceError("not_found", "It isn't there any more.");
    if (change.username !== undefined) item.username = change.username;
    if (change.password !== undefined) source.values.set(ref, change.password);
    return { ...item };
  };
  return source;
}

export function fakeSource(): FakeSource {
  const source: FakeSource = {
    kind: "fakepass",
    items: [],
    values: new Map(),
    listError: null,
    seenTokens: [],
    calls: [],
    readOnly: false,
    writeBroken: false,
    describe: () => ({
      kind: "fakepass",
      name: "FakePass",
      kinds: ["login", "key"],
      steps: ["Create a vault for your agents", "Paste the token here"],
      fields: [{ id: "token", kind: "secret", label: "Token", required: true }],
    }),
    connect: async (input, signal, context) => {
      source.calls.push({ op: "connect", signal, orgId: context?.orgId });
      if (input.token !== SOURCE_TOKEN) throw new VaultSourceError("auth_failed", "The token was refused.");
      return { label: "Agents", config: { vaultId: "v1", vaultName: "Agents" }, secret: { token: input.token } };
    },
    list: async (connection: SourceConnection, signal) => {
      source.calls.push({ op: "list", signal, orgId: connection.orgId });
      source.seenTokens.push(connection.secret.token ?? "");
      if (source.listError) throw source.listError;
      return source.items.map((item) => ({ ...item }));
    },
    reveal: async (connection: SourceConnection, ref, _field, signal) => {
      source.calls.push({ op: "reveal", signal, orgId: connection.orgId });
      source.seenTokens.push(connection.secret.token ?? "");
      const value = source.values.get(ref);
      if (value === undefined) throw new VaultSourceError("not_found", "It isn't there any more.");
      return value;
    },
  };
  return source;
}

export interface VaultFixture {
  f: Fixture;
  deps: VaultDeps;
  source: FakeSource;
  ana: { id: string };
  bruno: { id: string };
  carla: { id: string };
  dora: { id: string };
  supportRoleId: string;
  dev: { id: string };
  infra: { id: string };
  /** Every org event published, as sent. */
  events: RealtimeEvent[];
}

export async function vaultSetup(): Promise<VaultFixture> {
  const f = await setup();
  const bruno = await addMember(f.db, f.org.id, "member", "bruno");
  const carla = await addMember(f.db, f.org.id, "admin", "carla");
  const dora = await addMember(f.db, f.org.id, "member", "dora");
  const [support] = await f.db
    .insert(schema.orgRoles)
    .values({ orgId: f.org.id, name: "Support", position: 5 })
    .returning();
  if (!support) throw new Error("no role");
  await f.db.insert(schema.organizationMemberRoles).values({ orgId: f.org.id, userId: bruno.id, roleId: support.id });
  const infra = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Infra", handle: "infra", role: "Ops", instructions: "", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: infra.id });
  const source = fakeSource();
  const deps: VaultDeps = {
    db: f.db,
    keyWrapper: f.keyWrapper,
    keyWrappers: [f.keyWrapper],
    sources: { fakepass: source },
    pubsub: f.pubsub,
  };
  const events: RealtimeEvent[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e));
  return {
    f,
    deps,
    source,
    ana: f.owner,
    bruno,
    carla,
    dora,
    supportRoleId: support.id,
    dev: f.agent,
    infra,
    events,
  };
}

/** A run of `agentId` that `userId` asked for in #general. */
export async function runAskedBy(v: VaultFixture, agentId: string, userId: string): Promise<VaultRun> {
  const message = await insertMessage(v.f.db, {
    orgId: v.f.org.id,
    channelId: v.f.general.id,
    author: { type: "person", userId },
    body: "faz login pra mim",
  });
  const [run] = await v.f.db.transaction((tx) => createAgentRuns(tx, message, [agentId], "mention"));
  if (!run) throw new Error("no run");
  return { orgId: v.f.org.id, agentId, runId: run.id };
}

/** A routine's background run of `agentId`, set up by `creatorUserId`: nobody behind it, its creator's reach. */
export async function routineRun(v: VaultFixture, agentId: string, creatorUserId: string | null): Promise<VaultRun> {
  const brief: RoutineBrief = {
    routineId: crypto.randomUUID(),
    routineRunId: crypto.randomUUID(),
    name: "Daily check",
    creatorUserId,
    deliverTo: { channelId: v.f.general.id, threadId: null },
    access: "act",
    report: "when_new",
    trigger: "schedule",
    dueAt: new Date().toISOString(),
  };
  const message = await insertMessage(v.f.db, {
    orgId: v.f.org.id,
    channelId: v.f.general.id,
    author: { type: "person", userId: creatorUserId ?? v.ana.id },
    body: "Check the dashboard",
    meta: { routineBrief: brief, background: true },
  });
  const [run] = await v.f.db.transaction((tx) =>
    createAgentRuns(tx, message, [agentId], "mention", { background: true }),
  );
  if (!run) throw new Error("no run");
  return { orgId: v.f.org.id, agentId, runId: run.id };
}

/** A run nobody is behind: an agent's own message woke it. */
export async function unattendedRun(v: VaultFixture, agentId: string): Promise<VaultRun> {
  const message = await insertMessage(v.f.db, {
    orgId: v.f.org.id,
    channelId: v.f.general.id,
    author: { type: "agent", agentId: v.dev.id, runId: null, hop: 1, stretchId: null },
    body: "Checking the deploy",
  });
  const [run] = await v.f.db.transaction((tx) => createAgentRuns(tx, message, [agentId], "mention"));
  if (!run) throw new Error("no run");
  return { orgId: v.f.org.id, agentId, runId: run.id };
}

/** Everything a test can read back, as one string to search for values that must never be there. */
export async function everythingStored(v: VaultFixture): Promise<string> {
  const audit = await v.f.db.select().from(schema.auditLog);
  const uses = await v.f.db.select().from(schema.vaultUses);
  const outbox = await v.f.db.select().from(schema.outbox);
  const items = await v.f.db
    .select({
      title: schema.vaultItems.title,
      description: schema.vaultItems.description,
      username: schema.vaultItems.username,
      keyHint: schema.vaultItems.keyHint,
    })
    .from(schema.vaultItems);
  const connections = await v.f.db
    .select({ label: schema.vaultConnections.label, config: schema.vaultConnections.config })
    .from(schema.vaultConnections);
  return JSON.stringify({ audit, uses, outbox, items, connections, events: v.events });
}

/**
 * What an item holds now, read the way the server reads it to seal it for an agent's computer: no person's screen
 * ever gets it back (ADR 0144 §2), so tests look here.
 */
export async function storedValue(v: VaultFixture, itemId: string): Promise<string | null> {
  const [item] = await v.f.db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, itemId));
  if (!item) throw new Error(`No item ${itemId}`);
  const [connection] = item.connectionId
    ? await v.f.db.select().from(schema.vaultConnections).where(eq(schema.vaultConnections.id, item.connectionId))
    : [];
  return readItemValue(v.deps, item, connection);
}
