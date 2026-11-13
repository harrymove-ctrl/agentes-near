import type {
  SecretRequest,
  SecretToVaultInput,
  VaultAccess,
  VaultConnectField,
  VaultConnection,
  VaultContactFields,
  VaultItem,
  VaultItemInput,
  VaultItemKind,
  VaultItemPatch,
  VaultMatch,
  VaultOverview,
  VaultScope,
  VaultSourceInfo,
  VaultUse,
} from "@agenteschat/client";
import { joinNames, namesText, relativeTime } from "@agenteschat/client/lib/format";
import type { TFunction } from "i18next";
import type { IconName } from "@/ui";

/*
 * The Vault on the phone (ADR 0144), as the web's: which items each tab lists, how a row and an item's access read in
 * words, what a new item needs before it saves, and what a source's connect form asks. Pure, so it is unit-tested;
 * the screens in this folder turn it into views.
 */

// ── Tabs and rows ───────────────────────────────────────────────────────────

export type VaultTab = "team" | "personal" | "connections";
export type VaultKindFilter = "all" | VaultItemKind;

export const VAULT_KINDS: readonly VaultItemKind[] = ["login", "key", "contact"];

/** Each kind's icon (the web's: a globe for a login, a key, a person for contact details). */
export const KIND_ICON: Record<VaultItemKind, IconName> = { login: "globe", key: "key", contact: "person" };

/** How many items each tab lists, and the connections the viewer sees. */
export function vaultCounts(o: Pick<VaultOverview, "items" | "connections"> | undefined): Record<VaultTab, number> {
  const items = o?.items ?? [];
  return {
    team: items.filter((i) => i.scope === "team").length,
    personal: items.filter((i) => i.scope === "personal").length,
    connections: o?.connections.length ?? 0,
  };
}

/** The tab a person starts on: the team's when it has items (or they may add one there), else their own. */
export function firstTab(o: Pick<VaultOverview, "items" | "connections" | "canManageTeam"> | undefined): VaultTab {
  const n = vaultCounts(o);
  if (n.team > 0 || (n.personal === 0 && o?.canManageTeam)) return "team";
  return "personal";
}

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** `https://github.com` → `github.com` (anything else as it is). */
export function hostOf(website: string | null | undefined): string {
  if (!website) return "";
  try {
    return new URL(website).host;
  } catch {
    return website;
  }
}

const CONTACT_ORDER: readonly (keyof VaultContactFields)[] = [
  "fullName",
  "company",
  "document",
  "email",
  "phone",
  "address",
  "address2",
  "city",
  "region",
  "postalCode",
  "country",
];

/** A contact's fields in the order the form shows them. */
export const CONTACT_FIELDS = CONTACT_ORDER;

/**
 * The line under an item's name: a login's site and username, a key's description, a contact's description (the
 * list carries no contact's fields, only its page does, ADR 0144 §7).
 */
export function itemLine(item: Pick<VaultItem, "kind" | "website" | "username" | "description">): string {
  if (item.kind === "login") return [hostOf(item.website), item.username].filter(Boolean).join(" · ");
  return item.description;
}

/** Everything a search may find an item by (never a value: the app has none; a contact by its title and description). */
export function itemSearchText(item: VaultItem): string {
  return fold(
    [item.title, hostOf(item.website), item.username, item.keyName, item.description, item.sourceName]
      .filter(Boolean)
      .join(" "),
  );
}

/** One tab's items of a kind, whose words have the query (accents aside), by name. */
export function vaultList(
  items: readonly VaultItem[],
  tab: Exclude<VaultTab, "connections">,
  kind: VaultKindFilter,
  query: string,
): VaultItem[] {
  const q = fold(query.trim());
  return items
    .filter((i) => i.scope === tab && (kind === "all" || i.kind === kind) && (!q || itemSearchText(i).includes(q)))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** The kinds a tab holds, in the app's order (the kind filter shows only with more than one). */
export function kindsIn(items: readonly VaultItem[], tab: Exclude<VaultTab, "connections">): VaultItemKind[] {
  const there = new Set(items.filter((i) => i.scope === tab).map((i) => i.kind));
  return VAULT_KINDS.filter((k) => there.has(k));
}

// ── Access ──────────────────────────────────────────────────────────────────

/** Who may use what (ADR 0144 §2): what the server enforces, mirrored for the screens. */
export const ACCESS_CAPS = { roles: 100, people: 500, agents: 200 } as const;

/**
 * A new item's access. Personal: any of the owner's agents, when the owner asks. Team: everyone in the workspace sees
 * it and no agent uses it until someone picks one. Saved from a request card: the agent that asked, either way.
 */
export function defaultAccess(scope: VaultScope, askingAgentId?: string | null): VaultAccess {
  if (askingAgentId)
    return { everyone: scope === "team", roleIds: [], userIds: [], allAgents: false, agentIds: [askingAgentId] };
  return scope === "personal"
    ? { everyone: false, roleIds: [], userIds: [], allAgents: true, agentIds: [] }
    : { everyone: true, roleIds: [], userIds: [], allAgents: false, agentIds: [] };
}

/** A personal item has no audience: only its owner sees it (the server clears it too). */
export function forScope(access: VaultAccess, scope: VaultScope): VaultAccess {
  return scope === "personal" ? { ...access, everyone: false, roleIds: [], userIds: [] } : access;
}

/** Turns one agent on or off (with "All agents" on, the list underneath is kept for when it goes off). */
export function toggleAgent(access: VaultAccess, agentId: string): VaultAccess {
  const on = access.agentIds.includes(agentId);
  return { ...access, agentIds: on ? access.agentIds.filter((id) => id !== agentId) : [...access.agentIds, agentId] };
}

/** Whether an agent may use it, as the switches show. */
export const agentOn = (access: Pick<VaultAccess, "allAgents" | "agentIds">, agentId: string) =>
  access.allAgents || access.agentIds.includes(agentId);

/** Whether two accesses say the same (the access screen saves only a change). */
export function sameAccess(a: VaultAccess, b: VaultAccess): boolean {
  const set = (x: readonly string[]) => [...x].sort().join(",");
  return (
    a.everyone === b.everyone &&
    a.allAgents === b.allAgents &&
    set(a.roleIds) === set(b.roleIds) &&
    set(a.userIds) === set(b.userIds) &&
    set(a.agentIds) === set(b.agentIds)
  );
}

/** What is over the server's caps, as the i18n key that says it, or null. */
export function accessProblem(access: VaultAccess): string | null {
  if (access.roleIds.length > ACCESS_CAPS.roles) return "mobile.vault.access.tooManyRoles";
  if (access.userIds.length > ACCESS_CAPS.people) return "mobile.vault.access.tooManyPeople";
  if (access.agentIds.length > ACCESS_CAPS.agents) return "mobile.vault.access.tooManyAgents";
  return null;
}

export interface Names {
  agent: (id: string) => string;
  role: (id: string) => string;
  person: (id: string) => string;
}

const known = (names: string[]) => names.filter(Boolean);

/** "All agents", "Dev and Infra", "Dev, Infra and 2 more", "No agent yet". */
export function agentsSummary(t: TFunction, access: Pick<VaultAccess, "allAgents" | "agentIds">, names: Names) {
  if (access.allAgents) return t("mobile.vault.access.allAgents");
  const list = known(access.agentIds.map(names.agent));
  return list.length === 0 ? t("mobile.vault.access.noAgent") : namesText(t, list, 2);
}

/** "Only you", "Everyone in the workspace", "Ana and people in Support", "Only who manages keys". */
export function peopleSummary(t: TFunction, scope: VaultScope, access: VaultAccess, names: Names) {
  if (scope === "personal") return t("mobile.vault.access.onlyYou");
  if (access.everyone) return t("mobile.vault.access.everyone");
  const parts = audienceParts(t, access, names);
  return parts.length === 0 ? t("mobile.vault.access.managersOnly") : namesText(t, parts, 2);
}

/** The people an audience names, then its roles as "people in Support". */
function audienceParts(t: TFunction, access: VaultAccess, names: Names): string[] {
  return [
    ...known(access.userIds.map(names.person)),
    ...known(access.roleIds.map(names.role)).map((role) => t("mobile.vault.access.inRole", { role })),
  ];
}

/**
 * Who uses it for whom, in one sentence: "Dev and Infra use this for Ana and people in Support.", "Your agents use
 * this when you ask.", "No agent uses this yet."
 */
export function accessSentence(t: TFunction, scope: VaultScope, access: VaultAccess, names: Names): string {
  const agents = known(access.agentIds.map(names.agent));
  if (!access.allAgents && agents.length === 0) return t("mobile.vault.access.sentence.none");
  const who = access.allAgents ? null : joinNames(agents, t);
  const count = access.allAgents ? 2 : agents.length;
  if (scope === "personal")
    return who
      ? t("mobile.vault.access.sentence.personal", { agents: who, count })
      : t("mobile.vault.access.sentence.personalAll");
  const subject = who ?? t("mobile.vault.access.sentence.everyAgent");
  if (access.everyone) return t("mobile.vault.access.sentence.everyone", { agents: subject, count });
  const people = audienceParts(t, access, names);
  return people.length === 0
    ? t("mobile.vault.access.sentence.managers", { agents: subject, count })
    : t("mobile.vault.access.sentence.people", { agents: subject, count, people: joinNames(people, t) });
}

// ── The item's form ─────────────────────────────────────────────────────────

/** The server's limits (ADR 0144), as the fields' `maxLength`. */
export const LIMITS = {
  title: 120,
  description: 300,
  website: 2048,
  username: 200,
  contact: 300,
  keyName: 64,
} as const;

/** A variable name, as the computer takes it (`packages/adapters/src/secret-box.ts`). */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Names a key can't have: they decide where an AI tool's sign-in or requests go. Mirrors `isReservedSecretName`
 * (`packages/adapters/src/secret-box.ts`), so the form says it before the server refuses.
 */
export const reservedKeyName = (name: string) =>
  /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|OPENCODE_|NODE_|SSL_CERT_|LD_|DYLD_)|_PROXY$/.test(name.toUpperCase());

/**
 * What a person types as a key's name, as a variable, while they type it: "stripe key" → `STRIPE_KEY`. An underscore
 * at the end stays (the next word comes after it).
 */
export function keyNameFrom(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^[^A-Z]+/, "")
    .slice(0, LIMITS.keyName);
}

/**
 * A website as the Vault keeps it, `https://host[:port]`, as `vaultOrigin` reads it
 * (`packages/adapters/src/vault/site.ts`): `github.com/login` is HTTPS; `http:` and anything else is refused.
 */
export function websiteOrigin(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > LIMITS.website) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export interface VaultForm {
  kind: VaultItemKind;
  title: string;
  website: string;
  match: VaultMatch;
  username: string;
  /** A new password or key value; empty keeps the saved one. */
  secret: string;
  keyName: string;
  description: string;
  contact: VaultContactFields;
}

export const emptyForm = (kind: VaultItemKind): VaultForm => ({
  kind,
  title: "",
  website: "",
  match: "exact",
  username: "",
  secret: "",
  keyName: "",
  description: "",
  contact: {},
});

/** An item's form as it is saved (the value never comes back: blank keeps it). */
export const formOf = (item: VaultItem): VaultForm => ({
  kind: item.kind,
  title: item.title,
  website: item.website ?? "",
  match: item.match,
  username: item.username ?? "",
  secret: "",
  keyName: item.keyName ?? "",
  description: item.description,
  contact: { ...(item.contact ?? {}) },
});

const trimmedContact = (c: VaultContactFields): VaultContactFields => {
  const out: VaultContactFields = {};
  for (const k of CONTACT_ORDER) {
    const v = c[k]?.trim();
    if (v) out[k] = v;
  }
  return out;
};

/** The name it gets when the person leaves it blank: the site, the variable or the contact's name. */
export function titleOf(form: VaultForm): string {
  const typed = form.title.trim();
  if (typed) return typed;
  if (form.kind === "login") return hostOf(websiteOrigin(form.website));
  if (form.kind === "key") return form.keyName.trim();
  return form.contact.fullName?.trim() || form.contact.company?.trim() || "";
}

export type FormProblem = "website" | "secret" | "keyName" | "keyReserved" | "contact" | "title";

/** Each problem's words: the server's own refusal for the same thing (`errors.vault.*`), but a missing value. */
export const PROBLEM_KEY: Record<FormProblem, string> = {
  website: "errors.vault.notHttps",
  secret: "mobile.vault.problem.secret",
  keyName: "errors.vault.keyNameInvalid",
  keyReserved: "errors.vault.keyNameReserved",
  contact: "errors.vault.contactEmpty",
  title: "errors.vault.titleRequired",
};

/** What keeps a form from saving, or null. A new login or key needs its value; an edit keeps the saved one. */
export function formProblem(form: VaultForm, isNew: boolean): FormProblem | null {
  if (form.kind === "login") {
    if (!websiteOrigin(form.website)) return "website";
    if (isNew && !form.secret) return "secret";
  }
  if (form.kind === "key") {
    const name = form.keyName.trim();
    if (!SECRET_NAME.test(name)) return "keyName";
    if (reservedKeyName(name)) return "keyReserved";
    if (isNew && !form.secret) return "secret";
  }
  if (form.kind === "contact" && Object.keys(trimmedContact(form.contact)).length === 0) return "contact";
  if (!titleOf(form)) return "title";
  return null;
}

/**
 * What keeps an edit from saving. An item from a password manager changes only its description and a key's name here,
 * so only that name is checked (its other fields are the source's).
 */
export function editProblem(
  item: Pick<VaultItem, "kind" | "connectionId" | "keyName">,
  form: VaultForm,
): FormProblem | null {
  if (!item.connectionId) return formProblem(form, false);
  const name = form.keyName.trim();
  if (item.kind !== "key" || name === (item.keyName ?? "")) return null;
  if (!SECRET_NAME.test(name)) return "keyName";
  return reservedKeyName(name) ? "keyReserved" : null;
}

/** What the server gets for a new item. */
export function itemInput(form: VaultForm, scope: VaultScope, access: VaultAccess): VaultItemInput {
  const base: VaultItemInput = { kind: form.kind, scope, title: titleOf(form), access: forScope(access, scope) };
  const description = form.description.trim();
  if (description) base.description = description;
  if (form.kind === "login") {
    base.website = websiteOrigin(form.website) ?? "";
    base.match = form.match;
    const username = form.username.trim();
    if (username) base.username = username;
    base.secret = form.secret;
  } else if (form.kind === "key") {
    base.keyName = form.keyName.trim();
    base.secret = form.secret;
  } else {
    base.contact = trimmedContact(form.contact);
  }
  return base;
}

/**
 * What changed, for the server. An item from a password manager changes there: here only its description and a
 * key's name.
 */
export function itemPatch(item: VaultItem, form: VaultForm): VaultItemPatch {
  const patch: VaultItemPatch = {};
  const description = form.description.trim();
  if (description !== item.description) patch.description = description;
  if (item.kind === "key" && form.keyName.trim() !== (item.keyName ?? "")) patch.keyName = form.keyName.trim();
  if (item.connectionId) return patch;
  const title = titleOf(form);
  if (title && title !== item.title) patch.title = title;
  if (item.kind === "login") {
    const website = websiteOrigin(form.website);
    if (website && website !== item.website) patch.website = website;
    if (form.match !== item.match) patch.match = form.match;
    if (form.username.trim() !== (item.username ?? "")) patch.username = form.username.trim();
  }
  if (item.kind === "contact") {
    const next = trimmedContact(form.contact);
    if (JSON.stringify(next) !== JSON.stringify(trimmedContact(item.contact ?? {}))) patch.contact = next;
  }
  if ((item.kind === "login" || item.kind === "key") && form.secret) patch.secret = form.secret;
  return patch;
}

/** Whether a patch changes anything. */
export const patchEmpty = (patch: VaultItemPatch) => Object.keys(patch).length === 0;

// ── Recent uses ─────────────────────────────────────────────────────────────

export interface UseNames {
  agent: (id: string) => string;
  person: (id: string) => string;
}

/** Who did what: "Dev, on github.com", "Dev used it in a command", "Ana changed it". */
export function usageWords(t: TFunction, use: VaultUse, names: UseNames): string {
  const agent = use.agentId ? names.agent(use.agentId) : "";
  const person = use.userId ? names.person(use.userId) : "";
  const name = agent || person;
  switch (use.action) {
    case "fill":
      return use.origin
        ? t("mobile.vault.use.fillOn", { name, host: hostOf(use.origin) })
        : t("mobile.vault.use.fill", { name });
    case "key":
      return t("mobile.vault.use.key", { name });
    case "read":
      return t("mobile.vault.use.read", { name });
    case "create":
      return t("mobile.vault.use.create", { name });
    case "edit":
      return t("mobile.vault.use.edit", { name });
  }
}

/** For whom and when: "for Ana · 2 min ago", "Daily report routine · yesterday", "2 min ago". */
export function usageFacts(t: TFunction, locale: string, use: VaultUse, names: UseNames, now = new Date()): string {
  const forWhom =
    use.agentId && use.onBehalfOfUserId
      ? t("mobile.vault.use.for", { name: names.person(use.onBehalfOfUserId) })
      : use.routineName
        ? t("mobile.vault.use.routine", { name: use.routineName })
        : null;
  return [forWhom, relativeTime(t, locale, use.at, now)].filter(Boolean).join(" · ");
}

// ── Connections ─────────────────────────────────────────────────────────────

const SOURCE_ERRORS = new Set([
  "auth_failed",
  "locked",
  "many_vaults",
  "no_vault",
  "folder_missing",
  "not_found",
  "rate_limited",
  "unreachable",
  "unsupported",
  "invalid_input",
  // The Vault's own: full, so new items wait (ADR 0144 §3).
  "too_many_items",
]);

/**
 * A source's failure in plain words (`VaultSourceErrorCode`), as the i18n key that says it: the same words the
 * server's refusal gets while connecting (`vault.source.<code>` → `errors.vault.source.*`, in
 * `packages/client/src/lib/errors.ts`).
 */
export const sourceErrorKey = (code: string | null | undefined) =>
  code && SOURCE_ERRORS.has(code)
    ? `errors.vault.source.${code.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())}`
    : "errors.vault.sourceError";

/** A connection's state as its chip says it: the key and the chip's icon. */
export function connectionState(c: Pick<VaultConnection, "status" | "errorCode">): { key: string; icon: IconName } {
  if (c.status === "error") return { key: sourceErrorKey(c.errorCode), icon: "x" };
  if (c.status === "syncing") return { key: "mobile.vault.connection.syncing", icon: "clock" };
  return { key: "mobile.vault.connection.ready", icon: "check" };
}

/** "Reads Agents · read-only · 12 items · synced 2 min ago" (read-only: its credential can't save new logins). */
export function connectionLine(t: TFunction, locale: string, c: VaultConnection, now = new Date()): string {
  return [
    c.label ? t("mobile.vault.connection.reads", { label: c.label }) : null,
    c.readOnly ? t("mobile.vault.connection.noWrites") : null,
    t("mobile.vault.connection.items", { count: c.itemCount }),
    c.syncedAt ? t("mobile.vault.connection.synced", { when: relativeTime(t, locale, c.syncedAt, now) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The value a choice gives when the person runs the service on their own server. */
const OWN_SERVER = "self";

/**
 * The choice an optional address field follows when it is the address of "your own server" (Bitwarden's `server`:
 * bitwarden.com, bitwarden.eu or self-hosted, then `serverUrl`), or null.
 */
function ownServerChoice(fields: readonly VaultConnectField[], i: number): VaultConnectField | null {
  const f = fields[i];
  const before = fields[i - 1];
  if (f?.kind !== "url" || f.required || before?.kind !== "choice") return null;
  return before.choices?.some((c) => c.value === OWN_SERVER) ? before : null;
}

/** The fields the form shows now: an own server's address only once "your own server" is picked. */
export function shownFields(source: Pick<VaultSourceInfo, "fields">, values: Record<string, string>) {
  return source.fields.filter((_, i) => {
    const choice = ownServerChoice(source.fields, i);
    return !choice || (values[choice.id] ?? choice.initial) === OWN_SERVER;
  });
}

/** The form's starting values: each field's default (a choice's first value when it has none). */
export function initialValues(source: Pick<VaultSourceInfo, "fields">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of source.fields) out[f.id] = f.initial ?? (f.kind === "choice" ? (f.choices?.[0]?.value ?? "") : "");
  return out;
}

/** The required fields still empty (an own server's address, once shown, is required too). */
export function connectMissing(source: Pick<VaultSourceInfo, "fields">, values: Record<string, string>): string[] {
  const shown = new Set(shownFields(source, values));
  return source.fields
    .filter((f, i) => shown.has(f) && (f.required || ownServerChoice(source.fields, i) !== null))
    .filter((f) => !(values[f.id] ?? "").trim())
    .map((f) => f.id);
}

/** What the server gets: the shown fields, trimmed but for secrets (a password may start with a space). */
export function connectInput(source: Pick<VaultSourceInfo, "fields">, values: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const f of shownFields(source, values)) {
    const v = values[f.id] ?? "";
    const value = f.kind === "secret" ? v : v.trim();
    if (value) out[f.id] = value;
  }
  return out;
}

/** A field's keyboard and how it is typed. */
export function fieldKeyboard(f: Pick<VaultConnectField, "kind">) {
  const keyboardType = f.kind === "email" ? "email-address" : f.kind === "url" ? "url" : "default";
  return { secure: f.kind === "secret", keyboardType } as const;
}

// ── The request card ────────────────────────────────────────────────────────

/**
 * Whether the card offers "Save to the Vault": a site's password or a key, never a file or a code (ADR 0144 §6).
 * Checked by default when offered.
 */
export function vaultSaveOffered(r: Pick<SecretRequest, "target"> & { codeDigits?: number | null }): boolean {
  if (r.codeDigits) return false;
  return r.target.kind === "site" || r.target.kind === "env";
}

/**
 * What "Save to the Vault" sends (ADR 0144 §6). A site's password always carries the username the person left on the
 * card: empty means none, even when the agent suggested one (absent would keep the agent's).
 */
export function secretToVaultInput(
  r: Pick<SecretRequest, "target">,
  value: string,
  choice: { scope: VaultScope; pick: Pick<VaultAccess, "allAgents" | "agentIds">; username: string },
): SecretToVaultInput {
  return {
    value,
    scope: choice.scope,
    allAgents: choice.pick.allAgents,
    agentIds: choice.pick.agentIds,
    ...(r.target.kind === "site" ? { username: choice.username.trim() } : {}),
  };
}

/** A code request's boxes: 4 to 12 digits, or null when the request isn't one. */
export function codeLength(r: { codeDigits?: number | null }): number | null {
  const n = r.codeDigits;
  return typeof n === "number" && Number.isInteger(n) && n >= 4 && n <= 12 ? n : null;
}

/** Whether every box of a code is filled with a digit. */
export const codeComplete = (value: string, length: number) => new RegExp(`^\\d{${length}}$`).test(value);

// ── Screens ─────────────────────────────────────────────────────────────────

const param = (key: string, value: string) => `${key}=${encodeURIComponent(value)}`;

/** The Vault's screens, each pushed on the stack (`app/(app)/settings/vault*.tsx`). */
export const vaultHref = {
  list: "/settings/vault",
  item: (id: string) => `/settings/vault-item?${param("id", id)}`,
  create: (scope: VaultScope) => `/settings/vault-new?${param("scope", scope)}`,
  itemAccess: (id: string) => `/settings/vault-access?${param("id", id)}`,
  connectionAccess: (id: string) => `/settings/vault-access?${param("connection", id)}`,
  connect: (kind: string) => `/settings/vault-connect?${param("kind", kind)}`,
  reconnect: (kind: string, connectionId: string) =>
    `/settings/vault-connect?${param("kind", kind)}&${param("connection", connectionId)}`,
  connection: (id: string) => `/settings/vault-connection?${param("id", id)}`,
} as const;

/** A route's `?scope=`, as a scope (anything else is personal: always allowed). */
export const scopeParam = (value: unknown): VaultScope => (value === "team" ? "team" : "personal");

/** A route's text parameter (expo-router may hand an array). */
export const textParam = (value: unknown): string =>
  typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";

// ── Realtime ────────────────────────────────────────────────────────────────

/** The org event after any change to the Vault: every screen refetches what it may see. */
export const VAULT_CHANGED = "vault.changed";

/** The root of every Vault query of a workspace (`packages/client/src/api/keys.ts`). */
export const vaultQueryRoot = (orgId: string) => ["org", orgId, "vault"] as const;

export const isVaultChanged = (event: { type: string }) => event.type === VAULT_CHANGED;
