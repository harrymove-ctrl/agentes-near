import { afterEach, beforeEach, expect, test } from "bun:test";
import { type VaultSource, VaultSourceError } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/*
 * The Vault's routes (ADR 0144): who sees and edits what, and that no answer ever carries a password or a key: once
 * saved, a value never comes back to an app (§2).
 */

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

const PASSWORD = "acme-admin-pw-4f1c9e";
const KEY_VALUE = "acme-live-key-8b27d0f3";
const SITE_PASSWORD = "portal-pw-31a7c2";
const TOKEN_VALUE = "npm-token-90de44";

interface Item {
  id: string;
  kind: string;
  scope: string;
  ownerUserId: string | null;
  website: string | null;
  username: string | null;
  keyName: string | null;
  keyHint: string | null;
  hasSecret: boolean;
  connectionId: string | null;
  sourceName: string | null;
  accessFromConnection: boolean;
  access: { everyone: boolean; roleIds: string[]; userIds: string[]; allAgents: boolean; agentIds: string[] };
  can: { edit: boolean; delete: boolean };
}
interface Overview {
  items: Item[];
  connections: { id: string; kind: string; label: string; status: string; itemCount: number }[];
  sources: { kind: string; name: string }[];
  canManageTeam: boolean;
}

const meId = async (b: Browser) => ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;

async function workspace() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const ownerId = await meId(owner);
  const seeded = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, seeded.orgId, "ana@example.com");
  const anaId = await meId(ana);
  const vault = `/api/app/organizations/${seeded.orgId}/vault`;
  return { ...seeded, owner, ownerId, ana, anaId, vault };
}

/** The overview as raw text (to search for values) and parsed. */
async function overviewOf(b: Browser, vault: string) {
  const res = await b(vault);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const text = await res.text();
  return { text, overview: JSON.parse(text) as Overview };
}

async function create(b: Browser, vault: string, input: Record<string, unknown>) {
  const res = await b(`${vault}/items`, { json: input });
  const text = await res.text();
  return { status: res.status, text, item: (res.ok ? JSON.parse(text) : null) as Item | null };
}

test("team items: who manages credentials creates and edits; a member sees them without a value", async () => {
  const w = await workspace();
  const login = await create(w.owner, w.vault, {
    kind: "login",
    scope: "team",
    title: "Acme admin",
    website: "https://acme.example",
    username: "ops@acme.example",
    secret: PASSWORD,
  });
  expect(login.status).toBe(201);
  expect(login.text).not.toContain(PASSWORD);
  expect(login.item).toMatchObject({
    kind: "login",
    scope: "team",
    ownerUserId: null,
    website: "https://acme.example",
    username: "ops@acme.example",
    hasSecret: true,
    // A new team item: everyone in the workspace sees it, no agent uses it yet.
    access: { everyone: true, allAgents: false, agentIds: [] },
    can: { edit: true, delete: true },
  });
  const key = await create(w.owner, w.vault, {
    kind: "key",
    scope: "team",
    title: "Acme API",
    keyName: "ACME_API_KEY",
    description: "Billing API",
    secret: KEY_VALUE,
  });
  expect(key.status).toBe(201);
  expect(key.text).not.toContain(KEY_VALUE);
  expect(key.item).toMatchObject({ kind: "key", keyName: "ACME_API_KEY", keyHint: KEY_VALUE.slice(-4) });
  const loginId = login.item?.id ?? "";

  // The member: both items, never a value, and nothing they may change.
  const seen = await overviewOf(w.ana, w.vault);
  expect(seen.text).not.toContain(PASSWORD);
  expect(seen.text).not.toContain(KEY_VALUE);
  expect(seen.overview.canManageTeam).toBe(false);
  const mine = seen.overview.items.find((i) => i.id === loginId);
  expect(mine?.can).toEqual({ edit: false, delete: false });
  expect(seen.overview.items.some((i) => i.id === key.item?.id)).toBe(true);
  const theirs = { kind: "login", scope: "team", title: "Mine", website: "https://acme.example", secret: "pw-x1" };
  expect((await create(w.ana, w.vault, theirs)).status).toBe(403);
  expect((await w.ana(`${w.vault}/items/${loginId}`, { method: "PATCH", json: { title: "Taken" } })).status).toBe(403);
  expect((await w.ana(`${w.vault}/items/${loginId}`, { method: "DELETE" })).status).toBe(403);

  // Not even its manager gets the value back: there is nothing to ask it of (ADR 0144 §2).
  for (const purpose of ["show", "copy"]) {
    expect((await w.owner(`${w.vault}/items/${loginId}/reveal`, { json: { purpose } })).status).toBe(404);
  }
  const detail = await w.owner(`${w.vault}/items/${loginId}`);
  expect(detail.headers.get("cache-control")).toBe("no-store");
  expect(await detail.text()).not.toContain(PASSWORD);
  const audit = await (await w.owner(`/api/app/organizations/${w.orgId}/audit?kind=change`)).text();
  expect(audit).not.toContain(PASSWORD);
  expect(audit).not.toContain(KEY_VALUE);
});

test("a team item shared with some people: only they and its managers see it", async () => {
  const w = await workspace();
  const only = await create(w.owner, w.vault, {
    kind: "login",
    scope: "team",
    title: "Payroll",
    website: "https://payroll.acme.example",
    username: "finance@acme.example",
    secret: PASSWORD,
    access: { everyone: false, roleIds: [], userIds: [w.ownerId], allAgents: false, agentIds: [w.agentId] },
  });
  expect(only.status).toBe(201);
  const id = only.item?.id ?? "";
  expect((await overviewOf(w.ana, w.vault)).overview.items.some((i) => i.id === id)).toBe(false);
  // The same 404 as an item that doesn't exist: nothing says it is there.
  expect((await w.ana(`${w.vault}/items/${id}`)).status).toBe(404);

  const shared = await w.owner(`${w.vault}/items/${id}`, {
    method: "PATCH",
    json: { access: { everyone: false, roleIds: [], userIds: [w.anaId], allAgents: false, agentIds: [w.agentId] } },
  });
  expect(shared.status).toBe(200);
  const seen = (await overviewOf(w.ana, w.vault)).overview.items.find((i) => i.id === id);
  expect(seen?.access.userIds).toEqual([w.anaId]);
  expect(seen?.can).toEqual({ edit: false, delete: false });
});

test("personal items are their owner's alone, the workspace's owner included", async () => {
  const w = await workspace();
  const own = await create(w.ana, w.vault, {
    kind: "key",
    scope: "personal",
    title: "My npm",
    keyName: "NPM_TOKEN",
    secret: TOKEN_VALUE,
  });
  expect(own.status).toBe(201);
  expect(own.text).not.toContain(TOKEN_VALUE);
  // A new personal item: any agent may use it when its owner asks.
  expect(own.item).toMatchObject({ scope: "personal", ownerUserId: w.anaId, access: { allAgents: true } });
  const id = own.item?.id ?? "";
  const contact = await create(w.ana, w.vault, {
    kind: "contact",
    scope: "personal",
    title: "Billing address",
    contact: { fullName: "Ana Souza", company: "Acme", city: "Recife", email: "ana@acme.example" },
  });
  expect(contact.status).toBe(201);

  const anaView = await overviewOf(w.ana, w.vault);
  expect(anaView.text).not.toContain(TOKEN_VALUE);
  expect(anaView.overview.items.map((i) => i.id).sort()).toEqual([id, contact.item?.id ?? ""].sort());
  // The list carries no contact's fields; its page does (ADR 0144 §7).
  expect(anaView.text).not.toContain("Ana Souza");
  const page = await (await w.ana(`${w.vault}/items/${contact.item?.id ?? ""}`)).json();
  expect(page).toMatchObject({ contact: { fullName: "Ana Souza", city: "Recife" }, unreadable: false });
  const ownerView = await overviewOf(w.owner, w.vault);
  expect(ownerView.overview.items.some((i) => i.ownerUserId === w.anaId)).toBe(false);
  expect(ownerView.text).not.toContain("Ana Souza");
  for (const [path, init] of [
    [`${w.vault}/items/${id}`, {}],
    [`${w.vault}/items/${id}`, { method: "PATCH", json: { title: "Mine now" } }],
    [`${w.vault}/items/${id}`, { method: "DELETE" }],
  ] as const) {
    expect((await w.owner(path, init)).status).toBe(404);
  }

  expect((await w.ana(`${w.vault}/items/${id}`, { method: "DELETE" })).status).toBe(204);
  expect((await w.ana(`${w.vault}/items/${id}`)).status).toBe(404);
});

test("Save to the Vault from a request's card: the person asked, a delivered password or variable, never a code", async () => {
  const w = await workspace();
  const posted = (await (
    await w.owner(`/api/app/organizations/${w.orgId}/channels/${w.channelId}/messages`, { json: { body: "hello" } })
  ).json()) as { id: string };
  const [run] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId: w.orgId,
      agentId: w.agentId,
      channelId: w.channelId,
      threadRootId: posted.id,
      triggerMessageId: posted.id,
      trigger: "router",
      hop: 1,
      status: "running",
    })
    .returning();
  const request = async (values: Partial<typeof schema.secretRequests.$inferInsert> & { name: string }) => {
    const [row] = await t.db
      .insert(schema.secretRequests)
      .values({
        orgId: w.orgId,
        runId: run?.id ?? "",
        agentId: w.agentId,
        channelId: w.channelId,
        toolUseId: `tool-${values.name}-${values.requestedForUserId ?? ""}`,
        requestedForUserId: w.ownerId,
        purpose: "sign in to the Acme portal",
        targetKind: "env",
        publicKey: "pk",
        status: "delivered",
        deliveredAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        ...values,
      })
      .returning();
    if (!row) throw new Error("no request");
    return `/api/app/organizations/${w.orgId}/secret-requests/${row.id}/vault`;
  };
  const input = { value: SITE_PASSWORD, scope: "personal", allAgents: false, agentIds: [w.agentId] };

  const site = await request({
    name: "PORTAL_PASSWORD",
    targetKind: "site",
    site: "https://portal.acme.example",
    username: "bot@acme.example",
  });
  const saved = await w.owner(site, { json: { ...input, username: "bot@acme.example" } });
  expect(saved.status).toBe(200);
  const savedText = await saved.text();
  expect(savedText).not.toContain(SITE_PASSWORD);
  const login = JSON.parse(savedText) as Item;
  expect(login).toMatchObject({
    kind: "login",
    scope: "personal",
    ownerUserId: w.ownerId,
    website: "https://portal.acme.example",
    username: "bot@acme.example",
    hasSecret: true,
    access: { allAgents: false, agentIds: [w.agentId] },
  });
  // Sealed in its row, and no app ever gets it back (ADR 0144 §2).
  const rows = await t.db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, login.id));
  expect(rows[0]?.secretCiphertext).toBeTruthy();
  expect(JSON.stringify(rows)).not.toContain(SITE_PASSWORD);

  // A variable becomes a key under its name.
  const env = await request({ name: "ACME_API_KEY" });
  const key = await w.owner(env, { json: { ...input, value: KEY_VALUE, scope: "team" } });
  expect(key.status).toBe(200);
  expect(await key.text()).not.toContain(KEY_VALUE);

  const refused = async (b: Browser, path: string, status: number, code: string) => {
    const res = await b(path, { json: input });
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
  };
  await refused(
    w.owner,
    await request({ name: "WAITING_TOKEN", status: "pending", deliveredAt: null }),
    409,
    "vault.request_not_delivered",
  );
  await refused(
    w.owner,
    await request({ name: "DEPLOY_KEY", targetKind: "file", targetPath: ".ssh/deploy" }),
    400,
    "vault.request_not_savable",
  );
  await refused(
    w.owner,
    await request({ name: "PORTAL_CODE", targetKind: "site", site: "https://portal.acme.example", codeDigits: 6 }),
    400,
    "vault.request_not_savable",
  );

  // Only the person it was for, and a team item takes `manage_credentials`.
  expect([403, 404]).toContain((await w.ana(site, { json: input })).status);
  const anas = await request({
    name: "ANA_PORTAL",
    targetKind: "site",
    site: "https://portal.acme.example",
    requestedForUserId: w.anaId,
  });
  const team = await w.ana(anas, { json: { ...input, scope: "team" } });
  expect(team.status).toBe(403);
  expect(((await team.json()) as { error: { code: string } }).error.code).toBe("vault.team_needs_permission");
  expect((await w.ana(anas, { json: input })).status).toBe(200);
});

test("importing a passwords file: a dry run only counts; HTTPS logins with a password come in, never echoed", async () => {
  const w = await workspace();
  const csv = [
    "name,url,username,password,note",
    "Acme,https://acme.example/login,ana@acme.example,pw-one-1f9a,",
    "Old,http://old.example,bob,pw-two-7c3d,",
    "Empty,https://empty.example,carl,,",
  ].join("\r\n");

  const dry = await w.owner(`${w.vault}/import`, { json: { csv, scope: "personal", dryRun: true } });
  expect(dry.status).toBe(200);
  const dryText = await dry.text();
  expect(dryText).not.toContain("pw-one-1f9a");
  const counted = JSON.parse(dryText) as { added: number; updated: number; skipped: unknown[]; format: string };
  expect(counted).toMatchObject({ format: "chrome", added: 1, updated: 0 });
  expect(counted.skipped).toEqual(
    expect.arrayContaining([
      { reason: "not_https", count: 1 },
      { reason: "no_password", count: 1 },
    ]),
  );
  expect((await overviewOf(w.owner, w.vault)).overview.items).toEqual([]);

  const done = await w.owner(`${w.vault}/import`, { json: { csv, scope: "personal", dryRun: false } });
  expect(((await done.json()) as { added: number }).added).toBe(1);
  const after = await overviewOf(w.owner, w.vault);
  expect(after.text).not.toContain("pw-one-1f9a");
  expect(after.overview.items).toHaveLength(1);
  expect(after.overview.items[0]).toMatchObject({
    kind: "login",
    scope: "personal",
    username: "ana@acme.example",
    hasSecret: true,
  });
  const again = await w.owner(`${w.vault}/import`, { json: { csv, scope: "personal", dryRun: true } });
  expect(((await again.json()) as { skipped: unknown[] }).skipped).toEqual(
    expect.arrayContaining([{ reason: "duplicate", count: 1 }]),
  );

  // A team import takes `manage_credentials`; the file's size has a limit before anything reads it.
  expect((await w.ana(`${w.vault}/import`, { json: { csv, scope: "team", dryRun: true } })).status).toBe(403);
  const huge = `name,url,username,password,note\r\n${"x".repeat(2 * 1024 * 1024)}`;
  expect((await w.owner(`${w.vault}/import`, { json: { csv: huge, scope: "personal", dryRun: true } })).status).toBe(
    400,
  );
});

test("a connected password manager: its credentials and passwords never come back, its refusals have codes", async () => {
  const w = await workspace();
  const TOKEN = "service-token-c0ffee77";
  const SOURCE_PASSWORD = "from-source-pw-5e2b";
  const refusedToken = new VaultSourceError("auth_failed", "The token was refused.");
  const source: VaultSource = {
    kind: "acmepass",
    describe: () => ({
      kind: "acmepass",
      name: "AcmePass",
      kinds: ["login"],
      steps: ["Paste the token here"],
      fields: [{ id: "token", kind: "secret", label: "Token", required: true }],
    }),
    connect: async (input) => {
      if (input.token !== TOKEN) throw refusedToken;
      return { label: "Agents", config: { vaultName: "Agents" }, secret: { token: TOKEN } };
    },
    list: async (connection) => {
      if (connection.secret.token !== TOKEN) throw refusedToken;
      return [
        {
          ref: "item-1",
          kind: "login",
          title: "Acme portal",
          websites: [{ url: "https://portal.acme.example", match: "exact" }],
          username: "bot@acme.example",
        },
      ];
    },
    reveal: async (_connection, ref) => {
      if (ref !== "item-1") throw new VaultSourceError("not_found", "Gone.");
      return SOURCE_PASSWORD;
    },
  };
  t.adapters.vaultSources = { acmepass: source };

  expect((await overviewOf(w.owner, w.vault)).overview.sources.map((s) => s.name)).toContain("AcmePass");
  const connect = (b: Browser, token: string, scope = "team") =>
    b(`${w.vault}/connections`, { json: { kind: "acmepass", scope, input: { token } } });
  expect((await connect(w.ana, TOKEN)).status).toBe(403);
  const wrong = await connect(w.owner, "not-the-token");
  expect(wrong.status).toBe(400);
  expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("vault.source.auth_failed");

  const ok = await connect(w.owner, TOKEN);
  expect(ok.status).toBe(201);
  const okText = await ok.text();
  expect(okText).not.toContain(TOKEN);
  const connection = JSON.parse(okText) as { id: string; label: string; status: string; itemCount: number };
  expect(connection).toMatchObject({ label: "Agents", status: "ready", itemCount: 1 });

  const seen = await overviewOf(w.owner, w.vault);
  expect(seen.text).not.toContain(TOKEN);
  expect(seen.text).not.toContain(SOURCE_PASSWORD);
  const external = seen.overview.items.find((i) => i.connectionId === connection.id);
  expect(external).toMatchObject({ kind: "login", sourceName: "AcmePass", accessFromConnection: true });

  // Connected without an access: every agent, as a standing choice. Only who manages it changes that.
  const open = { everyone: true, roleIds: [], userIds: [], allAgents: true, agentIds: [] };
  expect((JSON.parse(okText) as { access: unknown }).access).toEqual(open);
  const none = { ...open, allAgents: false };
  const setAccess = (b: Browser, access: unknown) =>
    b(`${w.vault}/connections/${connection.id}`, { method: "PATCH", json: { access } });
  expect((await setAccess(w.ana, none)).status).toBe(404);
  const still = (await overviewOf(w.owner, w.vault)).overview.connections as unknown as { access: unknown }[];
  expect(still[0]?.access).toEqual(open);
  const narrowed = await setAccess(w.owner, none);
  expect(narrowed.status).toBe(200);
  expect(((await narrowed.json()) as { access: unknown }).access).toEqual(none);
  expect((await setAccess(w.ana, open)).status).toBe(404);

  expect((await w.owner(`${w.vault}/connections/${connection.id}`, { method: "DELETE" })).status).toBe(204);
  const gone = await overviewOf(w.owner, w.vault);
  expect(gone.overview.connections).toEqual([]);
  expect(gone.overview.items.some((i) => i.connectionId === connection.id)).toBe(false);
});
