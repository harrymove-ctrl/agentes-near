import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  SecretRequest,
  VaultAccess,
  VaultConnection,
  VaultItem,
  VaultSourceInfo,
  VaultUse,
} from "@agenteschat/client";
import { vaultNoAgents } from "@agenteschat/client/lib/vault";
import type { TFunction } from "i18next";
import {
  accessProblem,
  accessSentence,
  agentOn,
  agentsSummary,
  codeComplete,
  codeLength,
  connectInput,
  connectionLine,
  connectionState,
  connectMissing,
  defaultAccess,
  editProblem,
  emptyForm,
  firstTab,
  formOf,
  formProblem,
  forScope,
  hostOf,
  initialValues,
  isVaultChanged,
  itemInput,
  itemLine,
  itemPatch,
  keyNameFrom,
  kindsIn,
  type Names,
  patchEmpty,
  peopleSummary,
  reservedKeyName,
  sameAccess,
  scopeParam,
  secretToVaultInput,
  shownFields,
  sourceErrorKey,
  textParam,
  titleOf,
  toggleAgent,
  usageFacts,
  usageWords,
  type VaultForm,
  vaultCounts,
  vaultHref,
  vaultList,
  vaultQueryRoot,
  vaultSaveOffered,
  websiteOrigin,
} from "../../src/features/vault/logic";

/** A `t` that says which key and values it got, so the logic is tested apart from the words (ADR 0144). */
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key}${JSON.stringify(values)}` : key) as unknown as TFunction;

const NOW = new Date("2026-11-03T15:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const access = (over: Partial<VaultAccess> = {}): VaultAccess => ({
  everyone: false,
  roleIds: [],
  userIds: [],
  allAgents: false,
  agentIds: [],
  ...over,
});

const item = (over: Partial<VaultItem> & { id: string }): VaultItem => ({
  kind: "login",
  scope: "team",
  ownerUserId: null,
  title: "GitHub",
  description: "",
  website: "https://github.com",
  match: "exact",
  username: "dev@acme.example",
  keyName: null,
  keyHint: null,
  hasSecret: true,
  contact: null,
  connectionId: null,
  sourceName: null,
  accessFromConnection: false,
  access: access({ everyone: true }),
  missing: false,
  createdByUserId: "u1",
  createdByAgentId: null,
  lastUsedAt: null,
  createdAt: minutesAgo(600),
  updatedAt: minutesAgo(600),
  can: { edit: true, delete: true },
  ...over,
});

const AGENTS: Record<string, string> = { a1: "Dev", a2: "Infra", a3: "Ops" };
const ROLES: Record<string, string> = { r1: "Support" };
const PEOPLE: Record<string, string> = { u1: "Ana", u2: "Bruno" };
const names: Names = {
  agent: (id) => AGENTS[id] ?? "",
  role: (id) => ROLES[id] ?? "",
  person: (id) => PEOPLE[id] ?? "",
};

const connection = (over: Partial<VaultConnection> = {}): VaultConnection => ({
  id: "c1",
  kind: "onepassword",
  name: "1Password",
  scope: "team",
  ownerUserId: null,
  label: "Agents",
  config: {},
  access: access({ everyone: true }),
  status: "ready",
  errorCode: null,
  itemCount: 12,
  syncedAt: minutesAgo(5),
  can: { edit: true },
  ...over,
});

const ITEMS: VaultItem[] = [
  item({ id: "i1", title: "GitHub" }),
  item({ id: "i2", title: "Stripe", kind: "key", website: null, username: null, keyName: "STRIPE_KEY" }),
  item({
    id: "i3",
    title: "Acme billing",
    kind: "contact",
    // The list carries no contact's fields (ADR 0144 §7): a contact goes by its title and description there.
    description: "Invoices for the São Paulo office",
    website: null,
    username: null,
    hasSecret: false,
    contact: null,
  }),
  item({ id: "i4", title: "Ana's mail", scope: "personal", ownerUserId: "u1", website: "https://mail.acme.example" }),
];

describe("the Vault's tabs and rows", () => {
  test("counts each tab, and starts on the team's when it has items or the person may add to it", () => {
    expect(vaultCounts({ items: ITEMS, connections: [connection()] })).toEqual({
      team: 3,
      personal: 1,
      connections: 1,
    });
    expect(vaultCounts(undefined)).toEqual({ team: 0, personal: 0, connections: 0 });
    expect(firstTab({ items: ITEMS, connections: [], canManageTeam: false })).toBe("team");
    const mine = ITEMS.filter((i) => i.scope === "personal");
    expect(firstTab({ items: mine, connections: [], canManageTeam: true })).toBe("personal");
    expect(firstTab({ items: [], connections: [], canManageTeam: true })).toBe("team");
    expect(firstTab({ items: [], connections: [], canManageTeam: false })).toBe("personal");
  });

  test("lists one tab, of a kind, searched by any of its words (accents aside), by name", () => {
    expect(vaultList(ITEMS, "team", "all", "").map((i) => i.id)).toEqual(["i3", "i1", "i2"]);
    expect(vaultList(ITEMS, "team", "key", "").map((i) => i.id)).toEqual(["i2"]);
    expect(vaultList(ITEMS, "personal", "all", "").map((i) => i.id)).toEqual(["i4"]);
    expect(vaultList(ITEMS, "team", "all", "sao paulo").map((i) => i.id)).toEqual(["i3"]);
    expect(vaultList(ITEMS, "team", "all", "stripe_key").map((i) => i.id)).toEqual(["i2"]);
    expect(vaultList(ITEMS, "team", "all", "github.com").map((i) => i.id)).toEqual(["i1"]);
    expect(vaultList(ITEMS, "team", "all", "nothing like it")).toEqual([]);
    expect(kindsIn(ITEMS, "team")).toEqual(["login", "key", "contact"]);
    expect(kindsIn(ITEMS, "personal")).toEqual(["login"]);
  });

  test("a row's line: a login's site and username, a key's or a contact's description (never its fields)", () => {
    expect(itemLine(item({ id: "x" }))).toBe("github.com · dev@acme.example");
    expect(itemLine(item({ id: "x", username: null }))).toBe("github.com");
    expect(itemLine(item({ id: "x", kind: "key", description: "Payments, test mode" }))).toBe("Payments, test mode");
    expect(itemLine(item({ id: "x", kind: "contact", description: "Lisbon office", contact: null }))).toBe(
      "Lisbon office",
    );
    // Fields an item's page brought along never make the row's line.
    expect(
      itemLine(item({ id: "x", kind: "contact", description: "", contact: { company: "Acme", city: "Lisboa" } })),
    ).toBe("");
    expect(vaultList(ITEMS, "team", "all", "ana souza")).toEqual([]);
    expect(hostOf("https://app.acme.example:8443")).toBe("app.acme.example:8443");
    expect(hostOf(null)).toBe("");
  });
});

describe("who has access", () => {
  test("defaults: personal for the owner's agents, the team's for everyone and no agent, a card's for its agent", () => {
    expect(defaultAccess("personal")).toEqual(access({ allAgents: true }));
    expect(defaultAccess("team")).toEqual(access({ everyone: true }));
    expect(defaultAccess("team", "a1")).toEqual(access({ everyone: true, agentIds: ["a1"] }));
    expect(defaultAccess("personal", "a1")).toEqual(access({ agentIds: ["a1"] }));
  });

  test("a personal item has no audience, and the agents' switches keep their list under All agents", () => {
    const shared = access({ everyone: true, roleIds: ["r1"], userIds: ["u2"], agentIds: ["a1"] });
    expect(forScope(shared, "personal")).toEqual(access({ agentIds: ["a1"] }));
    const team = access({ roleIds: ["r1"] });
    expect(forScope(team, "team")).toBe(team);
    const on = toggleAgent(access(), "a1");
    expect(on.agentIds).toEqual(["a1"]);
    expect(toggleAgent(on, "a1").agentIds).toEqual([]);
    expect(agentOn(access({ allAgents: true }), "a9")).toBe(true);
    expect(agentOn(on, "a1")).toBe(true);
    expect(agentOn(on, "a2")).toBe(false);
  });

  test("saves only a change, in any order, and within the server's caps", () => {
    expect(sameAccess(access({ agentIds: ["a1", "a2"] }), access({ agentIds: ["a2", "a1"] }))).toBe(true);
    expect(sameAccess(access({ everyone: true }), access())).toBe(false);
    expect(accessProblem(access())).toBeNull();
    const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    expect(accessProblem(access({ roleIds: many(101, "r") }))).toBe("mobile.vault.access.tooManyRoles");
    expect(accessProblem(access({ userIds: many(501, "u") }))).toBe("mobile.vault.access.tooManyPeople");
    expect(accessProblem(access({ agentIds: many(201, "a") }))).toBe("mobile.vault.access.tooManyAgents");
  });

  test("summaries: all agents, a few by name, or none yet; only you, everyone, or the people and roles named", () => {
    expect(agentsSummary(t, access({ allAgents: true }), names)).toBe("mobile.vault.access.allAgents");
    expect(agentsSummary(t, access(), names)).toBe("mobile.vault.access.noAgent");
    expect(agentsSummary(t, access({ agentIds: ["a1", "a2"] }), names)).toContain('"Dev","Infra"');
    expect(peopleSummary(t, "personal", access({ everyone: true }), names)).toBe("mobile.vault.access.onlyYou");
    expect(peopleSummary(t, "team", access({ everyone: true }), names)).toBe("mobile.vault.access.everyone");
    expect(peopleSummary(t, "team", access(), names)).toBe("mobile.vault.access.managersOnly");
    const named = peopleSummary(t, "team", access({ userIds: ["u1"], roleIds: ["r1"] }), names);
    expect(named).toContain('"Ana"');
    expect(named).toContain("mobile.vault.access.inRole");
  });

  test("one sentence says which agents use it for whom", () => {
    expect(accessSentence(t, "team", access({ everyone: true }), names)).toBe("mobile.vault.access.sentence.none");
    expect(accessSentence(t, "personal", access({ allAgents: true }), names)).toBe(
      "mobile.vault.access.sentence.personalAll",
    );
    expect(accessSentence(t, "personal", access({ agentIds: ["a1"] }), names)).toStartWith(
      "mobile.vault.access.sentence.personal{",
    );
    expect(accessSentence(t, "team", access({ everyone: true, agentIds: ["a1"] }), names)).toStartWith(
      "mobile.vault.access.sentence.everyone{",
    );
    // Every agent, for everyone: the plural form.
    expect(accessSentence(t, "team", access({ everyone: true, allAgents: true }), names)).toContain('"count":2');
    expect(accessSentence(t, "team", access({ agentIds: ["a1"] }), names)).toStartWith(
      "mobile.vault.access.sentence.managers{",
    );
    const people = accessSentence(t, "team", access({ agentIds: ["a1"], userIds: ["u1"], roleIds: ["r1"] }), names);
    expect(people).toStartWith("mobile.vault.access.sentence.people{");
    expect(people).toContain('"count":1');
  });
});

describe("an item's form", () => {
  test("a website is kept as its HTTPS origin; anything else is refused", () => {
    expect(websiteOrigin("github.com/login")).toBe("https://github.com");
    expect(websiteOrigin(" https://app.acme.example:8443/x?y=1 ")).toBe("https://app.acme.example:8443");
    expect(websiteOrigin("http://acme.example")).toBeNull();
    expect(websiteOrigin("https://ana:secret@acme.example")).toBeNull();
    expect(websiteOrigin("")).toBeNull();
    expect(websiteOrigin(`https://${"a".repeat(2050)}.example`)).toBeNull();
  });

  test("a key's name is typed as a variable, and the names that steer AI tools are refused", () => {
    expect(keyNameFrom("stripe key")).toBe("STRIPE_KEY");
    expect(keyNameFrom("ação token")).toBe("ACAO_TOKEN");
    expect(keyNameFrom("1st token")).toBe("ST_TOKEN");
    // While typing: the underscore before the next word stays.
    expect(keyNameFrom("stripe ")).toBe("STRIPE_");
    expect(keyNameFrom("x".repeat(80))).toHaveLength(64);
    expect(reservedKeyName("OPENAI_API_KEY")).toBe(true);
    expect(reservedKeyName("HTTPS_PROXY")).toBe(true);
    expect(reservedKeyName("STRIPE_KEY")).toBe(false);
  });

  const login = (over: Partial<VaultForm> = {}): VaultForm => ({
    ...emptyForm("login"),
    website: "github.com",
    secret: "s3cret",
    ...over,
  });

  test("what keeps a new item from saving", () => {
    expect(formProblem(login(), true)).toBeNull();
    expect(formProblem(login({ website: "http://github.com" }), true)).toBe("website");
    expect(formProblem(login({ secret: "" }), true)).toBe("secret");
    // An edit keeps the saved value.
    expect(formProblem(login({ secret: "" }), false)).toBeNull();
    const key = { ...emptyForm("key"), keyName: "STRIPE_KEY", secret: "sk" };
    expect(formProblem(key, true)).toBeNull();
    expect(formProblem({ ...key, keyName: "stripe-key" }, true)).toBe("keyName");
    expect(formProblem({ ...key, keyName: "OPENAI_API_KEY" }, true)).toBe("keyReserved");
    expect(formProblem(emptyForm("contact"), true)).toBe("contact");
    expect(formProblem({ ...emptyForm("contact"), contact: { email: "ana@acme.example" } }, true)).toBe("title");
    expect(formProblem({ ...emptyForm("contact"), contact: { fullName: " Ana " } }, true)).toBeNull();
  });

  test("an edit of a password manager's item checks only a key's new name", () => {
    const external = item({ id: "e", connectionId: "c1", website: "https://intranet" });
    expect(editProblem(external, formOf(external))).toBeNull();
    const key = item({ id: "k", kind: "key", website: null, username: null, keyName: "OLD_KEY", connectionId: "c1" });
    expect(editProblem(key, { ...formOf(key), keyName: "new key" })).toBe("keyName");
    expect(editProblem(key, { ...formOf(key), keyName: "NODE_OPTIONS" })).toBe("keyReserved");
    expect(editProblem(key, { ...formOf(key), keyName: "NEW_KEY" })).toBeNull();
    const own = item({ id: "o" });
    expect(editProblem(own, { ...formOf(own), website: "http://github.com" })).toBe("website");
  });

  test("a blank name becomes the site, the variable or the contact's name", () => {
    expect(titleOf(login())).toBe("github.com");
    expect(titleOf(login({ title: " Work GitHub " }))).toBe("Work GitHub");
    expect(titleOf({ ...emptyForm("key"), keyName: "STRIPE_KEY" })).toBe("STRIPE_KEY");
    expect(titleOf({ ...emptyForm("contact"), contact: { company: "Acme" } })).toBe("Acme");
  });

  test("a new item for the server: the origin, the value, trimmed fields, a personal one without an audience", () => {
    const input = itemInput(
      login({ username: " dev ", match: "site" }),
      "personal",
      access({ everyone: true, allAgents: true }),
    );
    expect(input).toEqual({
      kind: "login",
      scope: "personal",
      title: "github.com",
      website: "https://github.com",
      match: "site",
      username: "dev",
      secret: "s3cret",
      access: access({ allAgents: true }),
    });
    const contact = itemInput(
      { ...emptyForm("contact"), contact: { fullName: " Ana ", city: "", phone: "+55 11 5555 0000" } },
      "team",
      defaultAccess("team"),
    );
    expect(contact.contact).toEqual({ fullName: "Ana", phone: "+55 11 5555 0000" });
    expect(contact.secret).toBeUndefined();
  });

  test("an edit sends only what changed, and a password manager's item only its description and key name", () => {
    const saved = item({ id: "i1" });
    expect(patchEmpty(itemPatch(saved, formOf(saved)))).toBe(true);
    expect(itemPatch(saved, { ...formOf(saved), username: "ops@acme.example", secret: "new" })).toEqual({
      username: "ops@acme.example",
      secret: "new",
    });
    expect(itemPatch(saved, { ...formOf(saved), website: "github.com/settings" })).toEqual({});
    expect(itemPatch(saved, { ...formOf(saved), match: "site" })).toEqual({ match: "site" });
    const external = item({ id: "i9", connectionId: "c1", sourceName: "1Password" });
    expect(
      itemPatch(external, { ...formOf(external), title: "Other", username: "x", secret: "y", description: "For CI" }),
    ).toEqual({ description: "For CI" });
    const key = item({ id: "k", kind: "key", website: null, username: null, keyName: "OLD_KEY", connectionId: "c1" });
    expect(itemPatch(key, { ...formOf(key), keyName: "NEW_KEY" })).toEqual({ keyName: "NEW_KEY" });
    const contact = item({ id: "p", kind: "contact", website: null, username: null, contact: { fullName: "Ana" } });
    expect(itemPatch(contact, { ...formOf(contact), contact: { fullName: "Ana", city: "Recife" } })).toEqual({
      contact: { fullName: "Ana", city: "Recife" },
    });
  });
});

describe("recent uses", () => {
  const use = (over: Partial<VaultUse>): VaultUse => ({
    id: "u",
    action: "fill",
    agentId: null,
    userId: null,
    onBehalfOfUserId: null,
    routineName: null,
    origin: null,
    at: minutesAgo(2),
    ...over,
  });

  test("who did what, for whom and when", () => {
    expect(usageWords(t, use({ agentId: "a1", origin: "https://github.com" }), names)).toBe(
      'mobile.vault.use.fillOn{"name":"Dev","host":"github.com"}',
    );
    expect(usageWords(t, use({ action: "edit", userId: "u1" }), names)).toBe('mobile.vault.use.edit{"name":"Ana"}');
    expect(usageWords(t, use({ action: "key", agentId: "a2" }), names)).toBe('mobile.vault.use.key{"name":"Infra"}');
    expect(usageFacts(t, "en", use({ agentId: "a1", onBehalfOfUserId: "u2" }), names, NOW)).toStartWith(
      'mobile.vault.use.for{"name":"Bruno"} · ',
    );
    expect(usageFacts(t, "en", use({ agentId: "a1", routineName: "Daily report" }), names, NOW)).toStartWith(
      'mobile.vault.use.routine{"name":"Daily report"} · ',
    );
    expect(usageFacts(t, "en", use({ action: "edit", userId: "u1" }), names, NOW)).not.toContain(" · ");
  });
});

test("a connection no agent may use: neither all of them nor one picked", () => {
  expect(vaultNoAgents({ allAgents: false, agentIds: [] })).toBe(true);
  expect(vaultNoAgents({ allAgents: true, agentIds: [] })).toBe(false);
  expect(vaultNoAgents({ allAgents: false, agentIds: ["a1"] })).toBe(false);
});

describe("password managers", () => {
  const bitwarden: VaultSourceInfo = {
    kind: "bitwarden",
    name: "Bitwarden",
    kinds: ["login"],
    steps: ["Make an account", "Copy the API key", "Fill in the fields below"],
    warning: "Use an account only for your agents.",
    fields: [
      {
        id: "server",
        kind: "choice",
        label: "Server",
        required: true,
        choices: [
          { value: "bitwarden.com", label: "bitwarden.com" },
          { value: "bitwarden.eu", label: "bitwarden.eu" },
          { value: "self", label: "Your own server" },
        ],
      },
      { id: "serverUrl", kind: "url", label: "Server address", required: false },
      { id: "clientId", kind: "text", label: "client_id", required: true },
      { id: "clientSecret", kind: "secret", label: "client_secret", required: true },
      { id: "masterPassword", kind: "secret", label: "Master password", required: true },
      { id: "folder", kind: "text", label: "Folder", required: false, initial: "Agents" },
    ],
  };

  test("an own server's address shows, and is required, only once that server is picked", () => {
    const start = initialValues(bitwarden);
    expect(start).toEqual({
      server: "bitwarden.com",
      serverUrl: "",
      clientId: "",
      clientSecret: "",
      masterPassword: "",
      folder: "Agents",
    });
    expect(shownFields(bitwarden, start).map((f) => f.id)).not.toContain("serverUrl");
    expect(connectMissing(bitwarden, start)).toEqual(["clientId", "clientSecret", "masterPassword"]);
    const own = { ...start, server: "self" };
    expect(shownFields(bitwarden, own).map((f) => f.id)).toContain("serverUrl");
    expect(connectMissing(bitwarden, own)).toEqual(["serverUrl", "clientId", "clientSecret", "masterPassword"]);
  });

  test("sends the shown fields, trimmed but for secrets", () => {
    const values = {
      ...initialValues(bitwarden),
      serverUrl: "https://vault.acme.example",
      clientId: " user.1 ",
      clientSecret: "abc",
      masterPassword: " pass phrase ",
    };
    expect(connectInput(bitwarden, values)).toEqual({
      server: "bitwarden.com",
      clientId: "user.1",
      clientSecret: "abc",
      masterPassword: " pass phrase ",
      folder: "Agents",
    });
  });

  test("a refusal and a connection's state in plain words", () => {
    // The same words the server's refusal gets while connecting (`errors.vault.source.*`).
    expect(sourceErrorKey("auth_failed")).toBe("errors.vault.source.authFailed");
    expect(sourceErrorKey("many_vaults")).toBe("errors.vault.source.manyVaults");
    // The Vault's own: full, so new items wait.
    expect(sourceErrorKey("too_many_items")).toBe("errors.vault.source.tooManyItems");
    expect(sourceErrorKey("whatever")).toBe("errors.vault.sourceError");
    expect(sourceErrorKey(null)).toBe("errors.vault.sourceError");
    expect(connectionState(connection())).toEqual({ key: "mobile.vault.connection.ready", icon: "check" });
    expect(connectionState(connection({ status: "syncing" })).icon).toBe("clock");
    expect(connectionState(connection({ status: "error", errorCode: "locked" }))).toEqual({
      key: "errors.vault.source.locked",
      icon: "x",
    });
    const line = connectionLine(t, "en", connection(), NOW);
    expect(line).toStartWith(
      'mobile.vault.connection.reads{"label":"Agents"} · mobile.vault.connection.items{"count":12}',
    );
    expect(connectionLine(t, "en", connection({ syncedAt: null, label: "" }), NOW)).toBe(
      'mobile.vault.connection.items{"count":12}',
    );
  });
});

describe("the request card and the screens", () => {
  const request = (over: Partial<SecretRequest>): SecretRequest => ({
    id: "s1",
    agentId: "a1",
    channelId: "c1",
    threadId: null,
    messageId: "m1",
    requestedForUserId: "u1",
    name: "GITHUB_PASSWORD",
    purpose: "Sign in",
    target: { kind: "site", site: "https://github.com" },
    machineId: "mc1",
    publicKey: "pk",
    status: "pending",
    expiresAt: minutesAgo(-10),
    deliveredAt: null,
    removed: false,
    ...over,
  });

  test("Save to the Vault is offered for a site's password and a key, never for a file or a code", () => {
    expect(vaultSaveOffered(request({}))).toBe(true);
    expect(vaultSaveOffered(request({ target: { kind: "env" } }))).toBe(true);
    expect(vaultSaveOffered(request({ target: { kind: "file", path: "~/.netrc" } }))).toBe(false);
    expect(vaultSaveOffered(request({ codeDigits: 6 }))).toBe(false);
  });

  test("Save to the Vault sends a site's username always: cleared, the agent's suggestion isn't kept", () => {
    const choice = { scope: "personal" as const, pick: { allAgents: false, agentIds: ["a1"] }, username: " dev " };
    expect(secretToVaultInput(request({ username: "dev" }), "pw", choice)).toStrictEqual({
      value: "pw",
      scope: "personal",
      allAgents: false,
      agentIds: ["a1"],
      username: "dev",
    });
    expect(secretToVaultInput(request({ username: "guessed" }), "pw", { ...choice, username: "  " }).username).toBe("");
    // A key has no username at all.
    expect("username" in secretToVaultInput(request({ target: { kind: "env" } }), "pw", choice)).toBe(false);
  });

  test("a code has 4 to 12 boxes, each one a digit", () => {
    expect(codeLength(request({ codeDigits: 6 }))).toBe(6);
    expect(codeLength(request({ codeDigits: null }))).toBeNull();
    expect(codeLength(request({ codeDigits: 3 }))).toBeNull();
    expect(codeLength(request({ codeDigits: 13 }))).toBeNull();
    expect(codeComplete("123456", 6)).toBe(true);
    expect(codeComplete("12345", 6)).toBe(false);
    expect(codeComplete("12a456", 6)).toBe(false);
  });

  test("every Vault screen is a route of the app, and the org event refreshes the Vault's queries", () => {
    const app = join(import.meta.dir, "..", "..", "app", "(app)");
    const hrefs = [
      vaultHref.list,
      vaultHref.item("i1"),
      vaultHref.create("team"),
      vaultHref.itemAccess("i1"),
      vaultHref.connectionAccess("c1"),
      vaultHref.connect("bitwarden"),
      vaultHref.reconnect("bitwarden", "c1"),
      vaultHref.connection("c1"),
    ];
    for (const href of hrefs) {
      const path = href.split("?")[0]?.slice(1) ?? "";
      expect(existsSync(join(app, `${path}.tsx`))).toBe(true);
    }
    expect(vaultHref.reconnect("one password", "c/1")).toBe(
      "/settings/vault-connect?kind=one%20password&connection=c%2F1",
    );
    expect(isVaultChanged({ type: "vault.changed" })).toBe(true);
    expect(isVaultChanged({ type: "secret.updated" })).toBe(false);
    expect(vaultQueryRoot("o1")).toEqual(["org", "o1", "vault"]);
  });

  test("route parameters", () => {
    expect(scopeParam("team")).toBe("team");
    expect(scopeParam("anything")).toBe("personal");
    expect(scopeParam(undefined)).toBe("personal");
    expect(textParam("i1")).toBe("i1");
    expect(textParam(["i1", "i2"])).toBe("i1");
    expect(textParam(undefined)).toBe("");
  });
});
