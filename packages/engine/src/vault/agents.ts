/**
 * The Vault for agents (ADR 0144): what a run may list, type, give to a command and change. Every call reads who is
 * behind the run (`vaultPersonOfRun`) and checks each item (`runAccess`); a refusal is a `VaultRefusal` with English
 * words for the model, never a hint that an item hidden from the run exists, and never an item's title or anything
 * else written on it (`named`: its kind, id, a login's site, a key's variable name; ADR 0117).
 *
 * Values leave here only through `releaseVaultLogin` and `releaseVaultKeys`, to the tool that seals them for the
 * agent's own computer at once. A contact's fields are not secret: agents read them and type them.
 */
import {
  isReservedSecretName,
  SECRET_NAME,
  VAULT_READ_ONLY_CONFIG,
  VaultSourceError,
  vaultOrigin,
  vaultRule,
  vaultRuleLabel,
  vaultRuleMatches,
} from "@agenteschat/adapters";
import { and, type Executor, eq, inArray, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { UUID } from "../authority";
import { SealedValueError } from "../crypto";
import { ConflictError, ValidationError } from "../errors";
import { publishVaultChanged } from "../events";
import { secretLabelOf } from "../secrets";
import { isPersonalWorkspace } from "../workspace-mode";
import {
  type ConnectionRow,
  effectiveColumns,
  type ItemRow,
  runAccess,
  scopeOf,
  sharedWithAgent,
  type VaultRunPerson,
  vaultPersonOfRun,
} from "./access";
import { assertRoom, cleanContact, cleanKeyName, cleanText, cleanWebsite, connectionRow } from "./items";
import { named, refuse, VaultRefusal, vaultItemName, vaultPlaceName } from "./refusals";
import { openItemValue, readItemValue, sealItemValue, sourceCall, sourceConnection, sourceOf } from "./seal";
import {
  VAULT_LIMITS,
  type VaultAgentChange,
  type VaultAgentResult,
  type VaultContactFields,
  type VaultDeps,
  type VaultItemForAgent,
  type VaultItemKind,
  type VaultPlace,
  type VaultReleasedLogin,
  type VaultRun,
  type VaultUnreached,
  vaultNow,
} from "./service";
import { indexSourceItem } from "./sync";
import { recordAgentChange, recordReads } from "./uses";
import {
  agentView,
  connectionOf,
  contactOf,
  hasValue,
  hostOf,
  loadVault,
  placeOf,
  readContact,
  sourceNameOf,
  THE_VAULT,
  type VaultState,
} from "./views";

const { vaultConnections, vaultItems } = schema;

type Source = NonNullable<ReturnType<typeof sourceOf>>;
type SourceConnection = Awaited<ReturnType<typeof sourceConnection>>;

/** Values a made password keeps behind it (`previousSecrets`). */
export const VAULT_PREVIOUS_KEPT = 5;

/**
 * One more value kept behind an item. Past the limit the oldest stays and the one after it goes: the oldest is what the
 * site had before any of these tries, so however many a loop or a page's words make, the one that works isn't dropped.
 */
const keptBehind = (kept: ItemRow["previousSecrets"]) =>
  kept.length > VAULT_PREVIOUS_KEPT ? [kept[0] as (typeof kept)[number], ...kept.slice(2)] : kept;

/** An item's value as it goes behind another. */
function sealedValueOf(item: ItemRow): ItemRow["previousSecrets"] {
  const { secretCiphertext, wrappedDataKey, kekId, secretVersion } = item;
  return secretCiphertext && wrappedDataKey && kekId
    ? [{ secretCiphertext, wrappedDataKey, kekId, secretVersion }]
    : [];
}

/** Most keys one command gets at once. */
export const VAULT_MAX_KEYS = 10;

/** A check's own words as a refusal the agent can act on. */
async function asRefusal<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ValidationError || error instanceof ConflictError) throw refuse.notAllowed(error.message);
    throw error;
  }
}

/** The run may use it now: shared with it for its person, still in its source, and (a login, a key) with a value. */
const usable = (item: ItemRow, connection: ConnectionRow | undefined, person: VaultRunPerson, agentId: string) =>
  !item.missing &&
  (item.kind === "contact" || hasValue(item)) &&
  runAccess(item.ownerUserId, effectiveColumns(item, connection), person, agentId) === "use";

/** Whether a login is for a site the agent named (an address, or part of one). */
function forSite(item: ItemRow, site: string): boolean {
  if (item.kind !== "login" || !item.website) return false;
  const origin = vaultOrigin(site);
  const rule = vaultRule(item.website, item.match === "site" ? "site" : "exact");
  if (origin && rule && vaultRuleMatches(rule, origin)) return true;
  const text = site.trim().toLowerCase();
  return text.length > 0 && hostOf(item.website).toLowerCase().includes(text);
}

/** What a query is looked for in: everything the agent would see of the item. */
function haystack(item: ItemRow, contact: VaultContactFields | null) {
  return [item.title, item.description, item.website, item.username, item.keyName, ...Object.values(contact ?? {})]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

/**
 * The items this run may use, metadata only (contacts with their fields), optionally narrowed by kind, site or a
 * query, in the order a list shows them. `shown`: how many of the first ones the caller shows (`vault_list`'s
 * `VAULT_LIST_MAX`): only those contacts' fields are read, past what a query needs to match, and only those are
 * recorded as read, once per run; the rest come without their fields, to be counted. `given`: who is behind the run,
 * when the caller already read it (`vaultPersonOfRun`).
 */
export async function listUsableVault(
  deps: VaultDeps,
  run: VaultRun,
  filter: { kind?: VaultItemKind; site?: string; query?: string } = {},
  given?: VaultRunPerson,
  shown = Number.POSITIVE_INFINITY,
): Promise<VaultItemForAgent[]> {
  const person = given ?? (await vaultPersonOfRun(deps.db, run));
  const state = await loadVault(deps.db, run.orgId);
  let items = state.items.filter((item) => usable(item, connectionOf(state, item), person, run.agentId));
  if (filter.kind) items = items.filter((item) => item.kind === filter.kind);
  const site = filter.site?.trim();
  if (site) items = items.filter((item) => forSite(item, site));
  const contacts = new Map<string, VaultContactFields | null>();
  const read = async (list: ItemRow[]) => {
    for (const item of list) {
      if (item.kind === "contact" && !contacts.has(item.id)) contacts.set(item.id, await contactOf(deps, item));
    }
  };
  const query = filter.query?.trim().toLowerCase();
  if (query) {
    // Words in a contact's fields find it: every contact left is read to match.
    await read(items);
    items = items.filter((item) => haystack(item, contacts.get(item.id) ?? null).includes(query));
  }
  const listed = items.slice(0, shown);
  await read(listed);
  await recordReads(
    deps,
    run,
    person,
    listed.filter((item) => item.kind === "contact").map((item) => item.id),
  );
  const inList = new Set(listed.map((item) => item.id));
  return items.map((item) =>
    agentView(
      item,
      inList.has(item.id) ? (contacts.get(item.id) ?? null) : null,
      placeOf(deps.sources, connectionOf(state, item)),
    ),
  );
}

/** A connection whose items this run uses by default: a login saved there is one the agent can type afterwards. */
const reaches = (connection: ConnectionRow, person: VaultRunPerson, agentId: string) =>
  runAccess(connection.ownerUserId, connection, person, agentId) === "use";

/**
 * The places this run's logins can be kept: the Vault, then each connected password manager whose items it uses by
 * default, with whether it takes a new login (`vault_list` says so before the agent saves anything).
 */
export async function listVaultPlaces(deps: VaultDeps, run: VaultRun, given?: VaultRunPerson): Promise<VaultPlace[]> {
  const person = given ?? (await vaultPersonOfRun(deps.db, run));
  const connections = await deps.db.select().from(vaultConnections).where(eq(vaultConnections.orgId, run.orgId));
  return [
    THE_VAULT,
    ...connections.filter((c) => reaches(c, person, run.agentId)).map((c) => placeOf(deps.sources, c)),
  ];
}

/**
 * Connected password managers the person behind the run may know of, whose items this agent doesn't use by default:
 * what lets it say "connected, but I have no access" instead of "nothing is connected". Only the connection: no item
 * of it, and whether any was read, never how many. One the run may not know exists (someone else's personal one, a
 * team one outside that person's reach) is left out.
 */
export async function listUnreachedConnections(
  deps: VaultDeps,
  run: VaultRun,
  given?: VaultRunPerson,
): Promise<VaultUnreached[]> {
  const person = given ?? (await vaultPersonOfRun(deps.db, run));
  const connections = await deps.db.select().from(vaultConnections).where(eq(vaultConnections.orgId, run.orgId));
  const unreached = connections.filter(
    (c) => !sharedWithAgent(c, run.agentId) && runAccess(c.ownerUserId, c, person, run.agentId) === "not_shared",
  );
  if (unreached.length === 0) return [];
  const withItems = await deps.db
    .selectDistinct({ connectionId: vaultItems.connectionId })
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.orgId, run.orgId),
        eq(vaultItems.missing, false),
        inArray(
          vaultItems.connectionId,
          unreached.map((c) => c.id),
        ),
      ),
    );
  const has = new Set(withItems.map((r) => r.connectionId));
  return unreached.map((c) => ({
    place: placeOf(deps.sources, c),
    scope: scopeOf(c.ownerUserId),
    hasItems: has.has(c.id),
  }));
}

/** An item by id as the run sees it: hidden ones (and ids that aren't ids) are not found. */
async function itemForRun(deps: VaultDeps, run: VaultRun, person: VaultRunPerson, itemId: string, what: string) {
  const missingItem = () => refuse.notFound(`No Vault ${what} with that id is shared with you. Look with vault_list.`);
  if (typeof itemId !== "string" || !UUID.test(itemId)) throw missingItem();
  const [item] = await deps.db
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.orgId, run.orgId), eq(vaultItems.id, itemId)));
  if (!item) throw missingItem();
  const connection = await connectionRow(deps.db, run.orgId, item.connectionId);
  const access = runAccess(item.ownerUserId, effectiveColumns(item, connection), person, run.agentId);
  if (access === "hidden") throw missingItem();
  if (access === "not_shared") throw refuse.notShared(item);
  const source = connection ? sourceNameOf(deps.sources, connection.kind) : "the Vault";
  if (item.missing) throw refuse.missing(item, source);
  return { item, connection, source };
}

/** A login's or key's value now, or the refusal that says why not. */
async function valueForRun(deps: VaultDeps, item: ItemRow, connection: ConnectionRow | undefined, source: string) {
  let value: string | null;
  try {
    value = await readItemValue(deps, item, connection);
  } catch (error) {
    if (error instanceof VaultSourceError) throw refuse.sourceError(source, error.message);
    if (error instanceof SealedValueError) throw refuse.noValue(item);
    throw error;
  }
  if (!value) throw refuse.noValue(item);
  return value;
}

/**
 * A shared browser profile a login would be typed in (ADR 0110): its name and every agent granted it, this one
 * included. A session it signs in to there is every one of those agents'.
 */
export interface VaultBrowserProfile {
  name: string;
  agentIds: readonly string[];
}

/**
 * Whether a login may be typed in a shared browser profile (ADR 0144 §2, ADR 0110): the session it opens stays in
 * the profile for every agent granted it, whoever each one works for. So a personal login never is, nor a team login
 * open only to some people (an agent there working for anyone else would act signed in with it); a team login open
 * to everyone, only when it is shared with all agents or with each agent the profile is granted to.
 */
function assertProfileMay(item: ItemRow, connection: ConnectionRow | undefined, profile: VaultBrowserProfile) {
  if (item.ownerUserId) {
    throw refuse.notAllowed(
      `${named(item)} is a personal login, and your browser now is the shared profile "${profile.name}": every agent granted that profile would be signed in as its owner. Switch to your own browser (browser_profile with "own") to sign in with it.`,
    );
  }
  const columns = effectiveColumns(item, connection);
  if (!columns.audienceEveryone) {
    throw refuse.notAllowed(
      `${named(item)} is open only to some people in the workspace, and your browser now is the shared profile "${profile.name}": every agent granted that profile would be signed in with it, whoever they work for. Switch to your own browser (browser_profile with "own") to sign in with it.`,
    );
  }
  if (columns.allAgents || profile.agentIds.every((id) => columns.agentIds.includes(id))) return;
  throw refuse.notAllowed(
    `${named(item)} isn't shared with every agent that uses the browser profile "${profile.name}", so it isn't typed there: they would all be signed in with it. Switch to your own browser (browser_profile with "own"), or ask a person who manages the login to share it with all of them in Settings, Vault.`,
  );
}

/** An id that names a key or a contact where a login was asked for. */
const notALogin = (item: ItemRow) =>
  refuse.notAllowed(`The Vault item ${item.id} is a ${item.kind}, not a login. Use a login's id from vault_list.`);

/**
 * A login the run may type, checked before anything runs: shared with it for the person behind the run, still in its
 * source, with a value, and fit for the shared profile when there is one. Its value isn't read (the source isn't
 * asked): `releaseVaultLogin` checks all of it again at the step that types it.
 */
export async function checkVaultLogin(
  deps: VaultDeps,
  run: VaultRun,
  itemId: string,
  profile: VaultBrowserProfile | null,
): Promise<void> {
  const person = await vaultPersonOfRun(deps.db, run);
  const { item, connection } = await itemForRun(deps, run, person, itemId, "login");
  if (item.kind !== "login") throw notALogin(item);
  if (!hasValue(item)) throw refuse.noValue(item);
  if (profile) assertProfileMay(item, connection, profile);
}

/**
 * A login's password and the rule of where it may be typed, for the tool that seals it for the agent's computer
 * (which checks the rule again against the field's own frame when it types). With `pageOrigin` (the page the agent
 * is on), a page the rule doesn't allow is refused before the value is read; with `profile` (the run's browser is a
 * shared profile), so is a login that profile may not hold. The use is recorded by the caller once the computer
 * typed it (`recordVaultUse`).
 */
export async function releaseVaultLogin(
  deps: VaultDeps,
  run: VaultRun,
  itemId: string,
  pageOrigin: string | null,
  profile: VaultBrowserProfile | null = null,
): Promise<VaultReleasedLogin> {
  const person = await vaultPersonOfRun(deps.db, run);
  const { item, connection, source } = await itemForRun(deps, run, person, itemId, "login");
  if (item.kind !== "login") throw notALogin(item);
  if (profile) assertProfileMay(item, connection, profile);
  const rule = item.website ? vaultRule(item.website, item.match === "site" ? "site" : "exact") : null;
  if (!rule) throw refuse.noWebsite();
  if (pageOrigin && !vaultRuleMatches(rule, pageOrigin))
    throw refuse.wrongSite(vaultRuleLabel(rule), hostOf(pageOrigin));
  const password = await valueForRun(deps, item, connection, source);
  return { item: agentView(item, null, placeOf(deps.sources, connection)), password, rule };
}

/** Prefers the person's own key over the team's, a built-in one over an external one, then the newest. */
const keyOrder = (personId: string | null) => (a: ItemRow, b: ItemRow) => {
  const rank = (item: ItemRow) =>
    (item.ownerUserId && item.ownerUserId === personId ? 0 : 2) + (item.connectionId ? 1 : 0);
  return rank(a) - rank(b) || b.updatedAt.getTime() - a.updatedAt.getTime();
};

/**
 * The workspace's keys with these variable names and their connections: only those rows, never the whole Vault (a
 * command asks for a few names).
 */
async function keysNamed(db: Executor, orgId: string, names: string[]): Promise<VaultState> {
  const items = await db
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.orgId, orgId), eq(vaultItems.kind, "key"), inArray(vaultItems.keyName, names)));
  const ids = [...new Set(items.flatMap((item) => (item.connectionId ? [item.connectionId] : [])))];
  const connections =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(vaultConnections)
          .where(and(eq(vaultConnections.orgId, orgId), inArray(vaultConnections.id, ids)));
  return { items, connections: new Map(connections.map((c) => [c.id, c])) };
}

/**
 * The values of the keys a command asked for by variable name, each from a key this run may use. The use of each
 * is recorded by the caller once the command started (`recordVaultUse`, action `key`).
 */
export async function releaseVaultKeys(
  deps: VaultDeps,
  run: VaultRun,
  names: string[],
): Promise<{ name: string; value: string; itemId: string }[]> {
  const wanted = [...new Set(names.map((n) => (typeof n === "string" ? n.trim() : "")))];
  if (wanted.length === 0) return [];
  if (wanted.length > VAULT_MAX_KEYS) throw refuse.notAllowed(`At most ${VAULT_MAX_KEYS} keys in one command.`);
  for (const name of wanted) {
    if (!SECRET_NAME.test(name))
      throw refuse.notAllowed(`${name || "That"} isn't a variable name. Use capital letters, digits and _.`);
    if (isReservedSecretName(name))
      throw refuse.notAllowed(`${name} is reserved for how agents think. No key uses it.`);
  }
  const person = await vaultPersonOfRun(deps.db, run);
  const state = await keysNamed(deps.db, run.orgId, wanted);
  const out: { name: string; value: string; itemId: string }[] = [];
  for (const name of wanted) {
    const keys = state.items.filter((item) => item.keyName === name);
    const access = (item: ItemRow) =>
      runAccess(item.ownerUserId, effectiveColumns(item, connectionOf(state, item)), person, run.agentId);
    const ready = keys.filter((item) => usable(item, connectionOf(state, item), person, run.agentId));
    const item = ready.sort(keyOrder(person.personId))[0];
    if (!item) {
      const known = keys.filter((key) => access(key) !== "hidden");
      const notShared = known.find((key) => access(key) === "not_shared");
      if (notShared) throw refuse.notShared(notShared);
      const gone = known.find((key) => key.missing);
      if (gone) {
        const kind = connectionOf(state, gone)?.kind;
        throw refuse.missing(gone, kind ? sourceNameOf(deps.sources, kind) : "its password manager");
      }
      if (known[0]) throw refuse.noValue(known[0]);
      throw refuse.notFound(
        `No key named ${name} is shared with you in the Vault. Ask the person to save it in Settings, Vault, or use request_secret.`,
      );
    }
    const connection = connectionOf(state, item);
    const source = connection ? sourceNameOf(deps.sources, connection.kind) : "the Vault";
    out.push({ name, value: await valueForRun(deps, item, connection, source), itemId: item.id });
  }
  return out;
}

/** The agent's audit line for an item it changed. */
function auditByAgent(
  db: Executor,
  run: VaultRun,
  person: VaultRunPerson,
  action: string,
  item: Pick<ItemRow, "id" | "kind" | "title" | "ownerUserId">,
  extra: Record<string, unknown> = {},
) {
  return recordAudit(db, {
    orgId: run.orgId,
    actor: { type: "agent", id: run.agentId },
    action,
    target: { type: "vault_item", id: item.id },
    details: { kind: item.kind, title: item.title, scope: item.ownerUserId ? "personal" : "team", ...extra },
    runId: run.runId,
    onBehalfOfUserId: person.personId,
  });
}

/**
 * An agent's change (`vault_save`): a new contact, personal to the person behind the run (none behind it: refused),
 * or, on an item it may use, a contact's title and fields, a login's username or any item's description. A personal
 * item changes for its owner (only their runs see it); a team item only for someone who manages credentials, as in
 * the app (ADR 0144 §2). An item kept in a password manager changes there: from here only a login's username, where
 * its source takes changes (§9). A contact whose saved fields don't open here is refused: its fields are only ever
 * changed on top of what was saved.
 */
export async function saveVaultItemByAgent(
  deps: VaultDeps,
  run: VaultRun,
  change: VaultAgentChange,
): Promise<VaultAgentResult> {
  const { db } = deps;
  const person = await vaultPersonOfRun(db, run);
  if (!change.itemId) return createContact(deps, run, person, change);

  const { item, connection, source } = await itemForRun(deps, run, person, change.itemId, "item");
  // A login kept in a password manager: its username changes there, when the source can; nothing else does from here.
  const usernameOnly =
    item.kind === "login" &&
    change.username !== undefined &&
    change.title === undefined &&
    change.description === undefined &&
    change.contact === undefined;
  const external = connection ? sourceOf(deps.sources, connection.kind) : undefined;
  const update = usernameOnly ? external?.updateLogin : undefined;
  if (item.connectionId && !update) {
    throw refuse.notAllowed(`${named(item)} comes from ${source}. It changes there, not here.`);
  }
  if (!item.ownerUserId && !(person.personId && person.manages)) {
    throw refuse.notAllowed(
      `${named(item)} is ${await sharedWords(db, run)}: only someone who manages credentials changes it, and nobody behind this request does. Ask one of them, or a person can change it in Settings, Vault.`,
    );
  }
  if (connection && external && update && item.externalRef) {
    const ref = item.externalRef;
    const place = placeOf(deps.sources, connection);
    if (place.writes === "read_only") throw refuse.readOnly(place);
    const username = await asRefusal(() => cleanText(change.username, VAULT_LIMITS.username, "username"));
    const listed = await sourceWrite(deps, connection, (opened, signal) =>
      update.call(external, opened, ref, { username }, signal),
    );
    const row = await db.transaction(async (tx) => {
      const kept = await indexSourceItem(tx, connection, listed, vaultNow(deps));
      if (!kept) throw new Error("vault item index returned nothing");
      await recordAgentChange(tx, run, person, item.id, "edit");
      await auditByAgent(tx, run, person, "vault.item_changed", kept, {
        fields: ["username"],
        source: connection.kind,
      });
      return kept;
    });
    await publishVaultChanged(deps.pubsub, run.orgId);
    return { outcome: "updated", item: agentView(row, null, place) };
  }
  const kind = item.kind as VaultItemKind;
  const set: Partial<typeof vaultItems.$inferInsert> = {};
  const fields: string[] = [];
  let contact: VaultContactFields | null = null;
  if (kind === "contact") {
    const saved = await readContact(deps, item);
    // Its fields don't open here: a change would be merged onto nothing and replace them all.
    if (saved.unreadable) {
      throw refuse.notAllowed(
        `${named(item)} can't be read here (its saved fields don't open on this server), so it isn't changed. Ask a person to save it again in Settings, Vault.`,
      );
    }
    contact = saved.contact;
  }
  await asRefusal(async () => {
    if (change.description !== undefined) {
      set.description = cleanText(change.description, VAULT_LIMITS.description, "description");
      fields.push("description");
    }
    if (change.username !== undefined) {
      if (kind !== "login") throw new ValidationError(`${named(item)} is a ${kind}. Only a login has a username.`);
      set.username = cleanText(change.username, VAULT_LIMITS.username, "username") || null;
      fields.push("username");
    }
    if (change.title !== undefined) {
      if (kind !== "contact") throw new ValidationError("Only a contact's name changes here.");
      const title = cleanText(change.title, VAULT_LIMITS.title, "title");
      if (!title) throw new ValidationError("A contact needs a name.");
      set.title = title;
      fields.push("title");
    }
    if (change.contact !== undefined) {
      if (kind !== "contact") throw new ValidationError(`${named(item)} is a ${kind}, not a contact.`);
      contact = cleanContact({ ...(contact ?? {}), ...change.contact });
      fields.push("contact");
    }
  });
  if (fields.length === 0) return { outcome: "updated", item: agentView(item, contact) };
  if (fields.includes("contact") && contact)
    Object.assign(set, await sealItemValue(deps, item, item.secretVersion + 1, JSON.stringify(contact)));
  set.updatedAt = vaultNow(deps);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(vaultItems)
      .set(set)
      .where(and(eq(vaultItems.id, item.id), eq(vaultItems.secretVersion, item.secretVersion)))
      .returning();
    if (!updated) throw refuse.notAllowed("It changed meanwhile. Read it again with vault_list and retry.");
    await recordAgentChange(tx, run, person, item.id, "edit");
    await auditByAgent(tx, run, person, "vault.item_changed", updated, { fields });
    return updated;
  });
  await publishVaultChanged(deps.pubsub, run.orgId);
  return { outcome: "updated", item: agentView(row, contact) };
}

async function createContact(
  deps: VaultDeps,
  run: VaultRun,
  person: VaultRunPerson,
  change: VaultAgentChange,
): Promise<VaultAgentResult> {
  const ownerUserId = person.personId;
  if (!ownerUserId) throw refuse.noPerson();
  if (change.username !== undefined) throw refuse.notAllowed("A contact has no username. Save its fields instead.");
  const { contact, title, description } = await asRefusal(() => {
    const contact = cleanContact(change.contact);
    const given = cleanText(change.title, VAULT_LIMITS.title, "title");
    const title = given || contact.fullName || contact.company || contact.email || "";
    if (!title) throw new ValidationError("A contact needs a name.");
    return {
      contact,
      title: title.slice(0, VAULT_LIMITS.title),
      description: cleanText(change.description, VAULT_LIMITS.description, "description"),
    };
  });
  await asRefusal(() => assertRoom(deps.db, run.orgId));
  const id = Bun.randomUUIDv7();
  const sealed = await sealItemValue(deps, { orgId: run.orgId, id, ownerUserId }, 1, JSON.stringify(contact));
  const row = await deps.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(vaultItems)
      .values({
        id,
        orgId: run.orgId,
        kind: "contact",
        ownerUserId,
        title,
        description,
        ...sealed,
        // A personal item: any agent its owner asks may use it (ADR 0144).
        allAgents: true,
        createdByAgentId: run.agentId,
      })
      .returning();
    if (!created) throw new Error("vault item insert returned nothing");
    await recordAgentChange(tx, run, person, id, "create");
    await auditByAgent(tx, run, person, "vault.item_created", created);
    return created;
  });
  await publishVaultChanged(deps.pubsub, run.orgId);
  return { outcome: "created", item: agentView(row, contact) };
}

/** What a made password is saved as: a login for a site and username, or a key for commands. */
export type VaultMadeTarget = { website: string; username: string | null } | { keyName: string; title: string };

/** A value the agent made replaces only what the run could type or use anyway, on the terms of `vault_save`. */
async function assertMayReplace(db: Executor, item: ItemRow, run: VaultRun, person: VaultRunPerson) {
  if (item.ownerUserId || item.createdByAgentId === run.agentId || (person.personId && person.manages)) return;
  throw refuse.notAllowed(
    `${named(item)} is ${await sharedWords(db, run)} and you didn't make it: only someone who manages credentials changes it. Nothing was changed.`,
  );
}

/** Whose a shared item is, in the refusal: the team's, or the workspace's in a personal one (ADR 0159). */
const sharedWords = async (db: Executor, run: VaultRun) =>
  (await isPersonalWorkspace(db, run.orgId)) ? "shared in this workspace" : "the team's";

/** A write into a connection's source, as a refusal the agent can act on. A refused write is remembered as read-only. */
async function sourceWrite<T>(
  deps: VaultDeps,
  connection: ConnectionRow,
  work: (opened: SourceConnection, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const place = placeOf(deps.sources, connection);
  const opened = await sourceConnection(deps, connection).catch(() => {
    throw refuse.sourceWrite(place, "Its connection has to be made again in Settings, Vault, Connections.");
  });
  try {
    return await sourceCall((signal) => work(opened, signal));
  } catch (error) {
    if (!(error instanceof VaultSourceError)) throw error;
    if (error.code !== "read_only") throw refuse.sourceWrite(place, error.message);
    await deps.db
      .update(vaultConnections)
      .set({ config: { ...connection.config, [VAULT_READ_ONLY_CONFIG]: "true" }, updatedAt: vaultNow(deps) })
      .where(and(eq(vaultConnections.orgId, connection.orgId), eq(vaultConnections.id, connection.id)));
    await publishVaultChanged(deps.pubsub, connection.orgId);
    throw refuse.readOnly({ ...place, writes: "read_only" });
  }
}

/**
 * Whether a login following this connection's access could be typed in the run's shared browser profile, on the
 * terms of `assertProfileMay`: the team's, open to everyone, for every agent of the profile.
 */
const fitsProfile = (connection: ConnectionRow, profile: VaultBrowserProfile | null) =>
  !profile ||
  (!connection.ownerUserId &&
    connection.audienceEveryone &&
    (connection.allAgents || profile.agentIds.every((id) => connection.agentIds.includes(id))));

/** A place's name as an agent may write it in `save_in`: case, accents' forms and punctuation don't count. */
const foldPlace = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Where a new login goes (ADR 0144 §9). The place the person named (`saveIn`: `vault`, or a connected password
 * manager by its name, what it reads, both, or its id), refused when it can't take one. Else the one connected
 * password manager this run uses that takes new logins, since that is where the agent's logins live. Else (none, or
 * more than one) the Vault. `connection` null is the Vault; `why` says what decided, for the tool's answer.
 */
function destinationFor(
  deps: VaultDeps,
  state: VaultState,
  run: VaultRun,
  person: VaultRunPerson,
  profile: VaultBrowserProfile | null,
  saveIn: string | undefined,
): { connection: ConnectionRow | null; why?: string } {
  const mine = [...state.connections.values()].filter((c) => reaches(c, person, run.agentId));
  const nameOf = (c: ConnectionRow) => vaultPlaceName(placeOf(deps.sources, c));
  const wanted = foldPlace(saveIn ?? "");
  if (wanted) {
    if (wanted === "vault" || wanted === "the vault") return { connection: null, why: "as asked" };
    const found = mine.filter((c) => {
      const place = placeOf(deps.sources, c);
      return [c.id, place.name, c.label, `${place.name} ${c.label}`].some((name) => foldPlace(name) === wanted);
    });
    const [connection] = found;
    if (!connection || found.length > 1) {
      throw refuse.notAllowed(
        found.length > 1
          ? `More than one connected password manager matches that (${found.map(nameOf).join(", ")}). Give \`save_in\` the full name, as vault_list shows it.`
          : `No password manager by that name is connected for you here. \`save_in\` takes "vault"${mine.length > 0 ? ` or one of: ${mine.map(nameOf).join(", ")}` : ""}.`,
      );
    }
    const place = placeOf(deps.sources, connection);
    if (place.writes === "read_only") throw refuse.readOnly(place);
    if (place.writes === "no") {
      throw refuse.notAllowed(
        `${vaultPlaceName(place)} doesn't take new logins from here: people add them there. Save it in the Vault instead (\`save_in\`: "vault").`,
      );
    }
    if (!fitsProfile(connection, profile)) {
      throw refuse.notAllowed(
        `A login in ${vaultPlaceName(place)} couldn't be typed in the shared browser profile "${profile?.name}": it isn't open to every agent that uses it. Save it in the Vault instead (\`save_in\`: "vault"), or switch to your own browser (browser_profile with "own").`,
      );
    }
    return { connection, why: "as asked" };
  }
  if (mine.length === 0) return { connection: null };
  const writable = mine.filter((c) => placeOf(deps.sources, c).writes === "yes");
  const [only] = writable;
  if (only && writable.length === 1) {
    return fitsProfile(only, profile)
      ? { connection: only, why: "the one connected password manager that takes your new logins" }
      : {
          connection: null,
          why: `${nameOf(only)} isn't open to every agent of the shared browser profile "${profile?.name}", so a login there couldn't be typed in it`,
        };
  }
  if (writable.length > 1) {
    return {
      connection: null,
      why: `more than one connected password manager takes new logins (${writable.map(nameOf).join(", ")}); to keep it in one of them, name it in \`save_in\``,
    };
  }
  const readOnly = mine.filter((c) => placeOf(deps.sources, c).writes === "read_only");
  return {
    connection: null,
    why:
      readOnly.length > 0
        ? `${readOnly.map(nameOf).join(", ")} can only be read with the token it was connected with; someone who manages that connection can reconnect it with one that also writes`
        : `${mine.map(nameOf).join(", ")} doesn't take new logins from here`,
  };
}

/**
 * A password an agent's computer made, kept before anything is typed (ADR 0144 §8): a form sent with a password
 * nothing keeps would lock the agent out. The same login or key again (the person's own first, then the team's) takes
 * the new value, keeping the old one sealed behind it for `restoreMadePassword`: a site that turned the new one down
 * still takes the old one.
 *
 * A new login goes where `destinationFor` says (§9): the one connected password manager that takes this run's new
 * logins, the place the person named (`saveIn`), or the Vault. In a password manager it follows that connection's
 * access, as every item read from it does; one that turns out to read only is remembered so, and the login goes to
 * the Vault unless that place was asked for. A key is always the Vault's.
 *
 * A new one in the Vault is the team's, open to everyone, for this agent (with `profile`, for every agent of that
 * shared browser profile, or it couldn't be typed there): the session it opens stays in the agent's browser for all
 * its work (§5), so its next run needs it whoever asked. Only its site, username and name show; the value comes back
 * to nobody.
 */
export async function saveMadePassword(
  deps: VaultDeps,
  run: VaultRun,
  target: VaultMadeTarget,
  value: string,
  profile: VaultBrowserProfile | null = null,
  saveIn?: string,
): Promise<VaultAgentResult> {
  const { db } = deps;
  const person = await vaultPersonOfRun(db, run);
  const fields = await asRefusal(() => {
    if ("keyName" in target) {
      const keyName = cleanKeyName(target.keyName);
      const plain = secretLabelOf({ label: null, site: null, name: keyName });
      const title = cleanText(target.title, VAULT_LIMITS.title, "title") || plain;
      return { kind: "key" as const, title, website: null, username: null, keyName };
    }
    const website = cleanWebsite(target.website);
    const username = cleanText(target.username, VAULT_LIMITS.username, "username") || null;
    return { kind: "login" as const, title: hostOf(website), website, username, keyName: null };
  });
  const state = await loadVault(db, run.orgId);
  const destination: ReturnType<typeof destinationFor> =
    fields.kind === "login" ? destinationFor(deps, state, run, person, profile, saveIn) : { connection: null };
  const asked = Boolean(foldPlace(saveIn ?? ""));
  const same = state.items.filter(
    (item) =>
      item.kind === fields.kind &&
      // A key is the Vault's own; a place the person named holds only its own logins.
      (fields.kind === "key" || asked ? (item.connectionId ?? null) === (destination.connection?.id ?? null) : true) &&
      usable(item, connectionOf(state, item), person, run.agentId) &&
      (fields.website
        ? item.username === fields.username && forSite(item, fields.website)
        : item.keyName === fields.keyName),
  );
  const builtIn = same.filter((item) => !item.connectionId);
  const existing =
    builtIn.find((item) => item.ownerUserId && item.ownerUserId === person.personId) ?? builtIn[0] ?? same[0];
  let why = destination.why;
  if (existing && !existing.connectionId) {
    await assertMayReplace(deps.db, existing, run, person);
    const sealed = await sealItemValue(deps, existing, existing.secretVersion + 1, value);
    const kept = keptBehind([...existing.previousSecrets, ...sealedValueOf(existing)]);
    const row = await replaceValue(deps, run, person, existing, sealed, kept);
    return { outcome: "updated", item: agentView(row, null) };
  }
  if (existing) {
    const connection = connectionOf(state, existing);
    const place = placeOf(deps.sources, connection);
    const source = connection ? sourceOf(deps.sources, connection.kind) : undefined;
    const reason =
      place.writes === "read_only"
        ? "its token can only read"
        : source?.updateLogin
          ? null
          : `a login already in ${place.name} can't be changed from here`;
    if (connection && source?.updateLogin && !reason) {
      await assertMayReplace(deps.db, existing, run, person);
      try {
        const row = await replaceInSource(deps, run, person, existing, connection, source, value);
        return { outcome: "updated", item: agentView(row, null, place) };
      } catch (error) {
        if (asked || !(error instanceof VaultRefusal) || error.code !== "read_only") throw error;
      }
    } else if (asked) {
      if (place.writes === "read_only") throw refuse.readOnly(place);
      throw refuse.notAllowed(
        `${named(existing)} is in ${vaultPlaceName(place)}, and ${reason}. Change its password there, or keep the new one in the Vault (\`save_in\`: "vault").`,
      );
    }
    why = `${vaultItemName(existing)} in ${vaultPlaceName(place)} keeps its old password (${reason ?? "its token can only read"}): tell the person to change it there`;
  } else if (destination.connection) {
    try {
      const created = await createInSource(deps, run, person, destination.connection, fields, value);
      return { ...created, ...(why ? { why } : {}) };
    } catch (error) {
      if (asked || !(error instanceof VaultRefusal) || error.code !== "read_only") throw error;
      why = `${vaultPlaceName(placeOf(deps.sources, destination.connection))} turned out to be read-only (its token can only read; someone who manages that connection can reconnect it with one that also writes)`;
    }
  }
  await asRefusal(() => assertRoom(db, run.orgId));
  const id = Bun.randomUUIDv7();
  const sealed = await sealItemValue(deps, { orgId: run.orgId, id, ownerUserId: null }, 1, value);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(vaultItems)
      .values({
        id,
        orgId: run.orgId,
        ownerUserId: null,
        ...fields,
        // Sign-up and sign-in are often on different hosts of one site (the rule falls back to exact when it has none).
        match: "website" in target ? "site" : "exact",
        ...sealed,
        audienceEveryone: true,
        agentIds: [...new Set([run.agentId, ...(profile?.agentIds ?? [])])],
        createdByAgentId: run.agentId,
      })
      .returning();
    if (!created) throw new Error("vault item insert returned nothing");
    await recordAgentChange(tx, run, person, id, "create");
    await auditByAgent(tx, run, person, "vault.item_created", created, { made: true });
    return created;
  });
  await publishVaultChanged(deps.pubsub, run.orgId);
  return { outcome: "created", item: agentView(row, null), ...(why ? { why } : {}) };
}

/** A new login kept in a connection's source, then indexed here at once, as the next sync would find it. */
async function createInSource(
  deps: VaultDeps,
  run: VaultRun,
  person: VaultRunPerson,
  connection: ConnectionRow,
  fields: { title: string; website: string | null; username: string | null },
  value: string,
): Promise<VaultAgentResult> {
  const source = sourceOf(deps.sources, connection.kind);
  const create = source?.createLogin;
  if (!source || !create) throw refuse.notAllowed("That password manager doesn't take new logins from here.");
  await asRefusal(() => assertRoom(deps.db, run.orgId));
  const listed = await sourceWrite(deps, connection, (opened, signal) =>
    create.call(
      source,
      opened,
      {
        title: fields.title,
        password: value,
        ...(fields.username ? { username: fields.username } : {}),
        ...(fields.website ? { website: fields.website, match: "site" as const } : {}),
      },
      signal,
    ),
  );
  const row = await deps.db.transaction(async (tx) => {
    const created = await indexSourceItem(tx, connection, listed, vaultNow(deps), run.agentId);
    if (!created) throw new Error("vault item index returned nothing");
    await recordAgentChange(tx, run, person, created.id, "create");
    await auditByAgent(tx, run, person, "vault.item_created", created, { made: true, source: connection.kind });
    return created;
  });
  await publishVaultChanged(deps.pubsub, run.orgId);
  return { outcome: "created", item: agentView(row, null, placeOf(deps.sources, connection)) };
}

/**
 * A login's new password, written to the password manager that keeps it. What it had is read first and sealed
 * behind the row here (`previousSecrets`), as for a Vault item: `undo` writes it back, and a password manager's own
 * history is not something an agent can reach. `previous`: what to keep behind it instead (an `undo`).
 */
async function replaceInSource(
  deps: VaultDeps,
  run: VaultRun,
  person: VaultRunPerson,
  item: ItemRow,
  connection: ConnectionRow,
  source: Source,
  value: string,
  previous?: ItemRow["previousSecrets"],
) {
  const update = source.updateLogin;
  const ref = item.externalRef;
  if (!update || !ref) throw refuse.notAllowed(`${named(item)} can't be changed from here.`);
  const version = item.secretVersion + 1;
  const kept = previous ?? keptBehind([...item.previousSecrets, ...(await behindOf(deps, item, connection, version))]);
  await sourceWrite(deps, connection, (opened, signal) =>
    update.call(source, opened, ref, { password: value }, signal),
  );
  return replaceValue(deps, run, person, item, { secretVersion: version }, kept, { source: connection.kind });
}

/** What a login in a password manager holds now, sealed as `version` to go behind its row; nothing when unreadable. */
async function behindOf(deps: VaultDeps, item: ItemRow, connection: ConnectionRow, version: number) {
  const now = await readItemValue(deps, item, connection).catch(() => null);
  return now ? [await sealItemValue(deps, item, version, now)] : [];
}

/**
 * An item's value and the ones kept behind it, in one step that loses to any other change. `set`: a Vault item's new
 * seal; an item in a password manager only takes the next version (its value is there).
 */
async function replaceValue(
  deps: VaultDeps,
  run: VaultRun,
  person: VaultRunPerson,
  item: ItemRow,
  set: Partial<Awaited<ReturnType<typeof sealItemValue>>> & { secretVersion: number },
  previousSecrets: ItemRow["previousSecrets"],
  audit: Record<string, unknown> = {},
) {
  const row = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(vaultItems)
      // A key's hint names the value it replaces.
      .set({ ...set, previousSecrets, keyHint: null, updatedAt: vaultNow(deps) })
      .where(and(eq(vaultItems.id, item.id), eq(vaultItems.secretVersion, item.secretVersion)))
      .returning();
    if (!updated) throw refuse.notAllowed("It changed meanwhile. Nothing was replaced. Try again.");
    await recordAgentChange(tx, run, person, item.id, "edit");
    await auditByAgent(tx, run, person, "vault.item_changed", updated, { fields: ["secret"], made: true, ...audit });
    return updated;
  });
  await publishVaultChanged(deps.pubsub, run.orgId);
  return row;
}

/** What `undo` answers: which value the site takes is the agent's to find out, and none was lost. */
export const undoneText = (item: string, kept: number) =>
  `${item} has its earlier value back. The Vault keeps ${kept} more: if this one is not it, \`undo\` again steps to the next.`;

/**
 * The value kept last comes back in its place, as a new version. What it replaces goes to the far end of what is kept,
 * so more `undo`s step through them all and none is lost: only the agent's words say which one the site takes, and a
 * page's words can reach those. `discard`: it was never typed anywhere, so it goes.
 */
export async function restoreMadePassword(
  deps: VaultDeps,
  run: VaultRun,
  itemId: string,
  { discard = false }: { discard?: boolean } = {},
): Promise<VaultAgentResult & { kept: number }> {
  const person = await vaultPersonOfRun(deps.db, run);
  const { item, connection } = await itemForRun(deps, run, person, itemId, "item");
  await assertMayReplace(deps.db, item, run, person);
  const last = item.previousSecrets.at(-1);
  if (!last) throw refuse.notAllowed(`${named(item)} keeps no earlier password.`);
  const value = await openItemValue(deps, { ...item, ...last }).catch(() => null);
  if (value === null) throw refuse.noValue(item);
  const source = connection ? sourceOf(deps.sources, connection.kind) : undefined;
  if (connection && source) {
    const behind = discard ? [] : await behindOf(deps, item, connection, item.secretVersion + 1);
    const kept = [...behind, ...item.previousSecrets.slice(0, -1)];
    const row = await replaceInSource(deps, run, person, item, connection, source, value, kept);
    return { outcome: "updated", item: agentView(row, null, placeOf(deps.sources, connection)), kept: kept.length };
  }
  const sealed = await sealItemValue(deps, item, item.secretVersion + 1, value);
  const kept = [...(discard ? [] : sealedValueOf(item)), ...item.previousSecrets.slice(0, -1)];
  const row = await replaceValue(deps, run, person, item, sealed, kept);
  return { outcome: "updated", item: agentView(row, null), kept: kept.length };
}

/**
 * An agent deletes an item it may use (`vault_delete`), only one it saved itself (ADR 0144 §2): anything people saved,
 * personal or the team's, is deleted by people in the app, where they see what goes. Only built-in items.
 */
export async function deleteVaultItemByAgent(
  deps: VaultDeps,
  run: VaultRun,
  itemId: string,
): Promise<VaultAgentResult> {
  const person = await vaultPersonOfRun(deps.db, run);
  const { item, source } = await itemForRun(deps, run, person, itemId, "item");
  if (item.connectionId) throw refuse.notAllowed(`${named(item)} comes from ${source}. It goes from there, not here.`);
  if (item.createdByAgentId !== run.agentId) {
    throw refuse.notAllowed(
      `You didn't save ${vaultItemName(item)}, so you can't delete it. Someone who manages it can, in Settings, Vault.`,
    );
  }
  const contact = item.kind === "contact" ? await contactOf(deps, item) : null;
  await deps.db.transaction(async (tx) => {
    await tx.delete(vaultItems).where(and(eq(vaultItems.orgId, run.orgId), eq(vaultItems.id, item.id)));
    await auditByAgent(tx, run, person, "vault.item_deleted", item);
  });
  await publishVaultChanged(deps.pubsub, run.orgId);
  return { outcome: "deleted", item: agentView(item, contact) };
}
