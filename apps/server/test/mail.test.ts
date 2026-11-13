import { afterEach, expect, test } from "bun:test";
import {
  createFakeComposioClient,
  createFakeMailConnector,
  createFakeMailPoller,
  createFakeMailTester,
  FAKE_COMPOSIO_SIGNATURE,
  type MailAdapters,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  await t?.close();
  t = undefined as never;
});

const ICLOUD = {
  id: "icloud",
  label: "iCloud",
  imapHost: "imap.mail.me.com",
  imapPort: 993,
  smtpHost: "smtp.mail.me.com",
  smtpPort: 587,
  username: "address" as const,
  appPasswordUrl: "https://account.apple.com",
};

function fakeMail() {
  const box = createFakeMailConnector();
  const tester = createFakeMailTester();
  const composio = createFakeComposioClient();
  const mail: MailAdapters = {
    composio: { client: composio.client, connector: box.connector },
    imap: { connector: box.connector, poller: createFakeMailPoller().poller, tester: tester.tester, presets: [ICLOUD] },
  };
  return { mail, box, tester, composio };
}

test("without mail adapters: no providers, Gmail connect is a conflict", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  expect(await (await owner(`/api/app/organizations/${orgId}/mail/providers`)).json()).toEqual({
    composio: false,
    imap: false,
    presets: [],
  });
  const r = await owner(`/api/app/organizations/${orgId}/mail/accounts/composio`, { json: { provider: "gmail" } });
  expect(r.status).toBe(409);
  expect((await owner("/api/webhooks/composio", { json: {} })).status).toBe(404);
  expect((await owner("/api/webhooks/millionsend", { json: {} })).status).toBe(404);
});

test("mail API: IMAP account (tested), Gmail through Composio, agent access, folders, disconnect", async () => {
  const fake = fakeMail();
  t = await createTestServer({ mail: fake.mail });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  expect(await (await api("/mail/providers")).json()).toEqual({
    composio: true,
    imap: true,
    presets: [ICLOUD],
  });

  fake.tester.state.result = { ok: false, error: "auth" };
  const failed = await api("/mail/accounts/imap", {
    json: { preset: "icloud", address: "support@example.com", password: "wrong" },
  });
  expect(failed.status).toBe(422);
  expect(await failed.json()).toEqual({ error: "auth" });
  fake.tester.state.result = { ok: true, sentFolder: "Sent" };
  const created = await api("/mail/accounts/imap", {
    json: { preset: "icloud", address: "support@example.com", password: "abcd-efgh-ijkl", label: "Suporte" },
  });
  expect(created.status).toBe(201);
  const { account } = (await created.json()) as { account: { id: string; status: string } };
  expect(account.status).toBe("active");

  // Gmail: start, the person signs in at Composio, comes back to the callback.
  const started = (await (await api("/mail/accounts/composio", { json: { provider: "gmail" } })).json()) as {
    accountId: string;
    redirectUrl: string;
  };
  expect(started.redirectUrl).toBe("https://composio.example/connect/ca_1");
  fake.composio.activate("ca_1", "team@example.com");
  const back = await owner(`/api/app/mail/composio/callback?account=${started.accountId}`);
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toBe(
    `${t.config.PUBLIC_URL}/org/${orgId}/settings/connectors?mail=connected&account=${started.accountId}`,
  );
  // The agent page reads the Gmail mailbox's folders through Composio, as the org's user.
  const gmailFolders = await api(`/mail/accounts/${started.accountId}/folders`);
  expect(gmailFolders.status).toBe(200);
  expect(fake.box.state.opened.at(-1)).toMatchObject({ externalAccountId: "ca_1", externalUserId: `org_${orgId}` });

  const listed = await (await api("/mail/accounts")).text();
  expect(listed).not.toContain("abcd-efgh");
  const accounts = (JSON.parse(listed) as { accounts: { id: string; address: string; status: string }[] }).accounts;
  expect(accounts.map((a) => [a.address, a.status])).toEqual([
    ["support@example.com", "active"],
    ["team@example.com", "active"],
  ]);

  // Agent access: sending without asking needs allowed recipients.
  const policy = {
    folders: [],
    senders: [],
    windowDays: null,
    allowedRecipients: [],
    dailySendCap: 25,
    sendWithoutAsking: true,
    fromAddress: null,
  };
  const bad = await api(`/agents/${agentId}/mail/${account.id}`, {
    method: "PUT",
    json: { level: "read_write", canDelete: false, policy },
  });
  expect(bad.status).toBe(422);
  expect(await bad.json()).toEqual({ error: "send_without_recipients" });
  const ok = await api(`/agents/${agentId}/mail/${account.id}`, {
    method: "PUT",
    json: { level: "read_write", canDelete: true, policy: { ...policy, allowedRecipients: ["@Acme.com"] } },
  });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ accountId: account.id, level: "read_write", canDelete: true });
  const mailboxes = (await (await api(`/agents/${agentId}/mail`)).json()) as {
    mailboxes: { accountId: string; level: string; policy: { allowedRecipients: string[] } }[];
  };
  expect(mailboxes.mailboxes.map((x) => [x.accountId, x.level])).toEqual([
    [account.id, "read_write"],
    [started.accountId, "none"],
  ]);
  expect(mailboxes.mailboxes[0]?.policy.allowedRecipients).toEqual(["@acme.com"]);
  const withAgents = (await (await api("/mail/accounts")).json()) as { accounts: { agents: unknown[] }[] };
  expect(withAgents.accounts[0]?.agents).toEqual([{ agentId, level: "read_write", canDelete: true }]);

  const folders = (await (await api(`/mail/accounts/${account.id}/folders`)).json()) as { folders: { id: string }[] };
  expect(folders.folders.map((f) => f.id)).toContain("INBOX");

  const renamed = await api(`/mail/accounts/${account.id}`, { method: "PATCH", json: { label: "Help desk" } });
  expect(((await renamed.json()) as { account: { label: string } }).account.label).toBe("Help desk");

  // Other addresses of the mailbox, and the one new mail goes out from.
  const aliased = await api(`/mail/accounts/${account.id}`, {
    method: "PATCH",
    json: { aliases: ["Help@Acme.com"], defaultFrom: "help@acme.com" },
  });
  expect(((await aliased.json()) as { account: unknown }).account).toMatchObject({
    aliases: ["help@acme.com"],
    defaultFrom: "help@acme.com",
  });
  const outside = await api(`/mail/accounts/${account.id}`, { method: "PATCH", json: { defaultFrom: "x@acme.com" } });
  expect(outside.status).toBe(400);
  const suggested = await api(`/mail/accounts/${account.id}/suggested-addresses`);
  expect(suggested.status).toBe(200);
  expect(await suggested.json()).toEqual({ addresses: [] });

  expect((await api(`/mail/accounts/${account.id}`, { method: "DELETE" })).status).toBe(204);
  expect(((await (await api("/mail/accounts")).json()) as { accounts: unknown[] }).accounts).toHaveLength(1);
  const scopes = await t.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, account.id));
  expect(scopes).toEqual([]);
});

test("before an admin lets more people talk to an agent, the apps learn whose mailbox it would lose, and keep it", async () => {
  const fake = fakeMail();
  t = await createTestServer({ mail: fake.mail });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const carla = await joinByInvitation(t, owner, orgId, "carla@example.com", { role: "admin" });
  const org = `/api/app/organizations/${orgId}`;
  const created = await owner(`${org}/mail/accounts/imap`, {
    json: { preset: "icloud", address: "support@example.com", password: "abcd-efgh-ijkl" },
  });
  const { account } = (await created.json()) as { account: { id: string } };
  await owner(`${org}/agents/${agentId}`, { method: "PATCH", json: { audience: { mode: "owner", userIds: [] } } });
  const put = await owner(`${org}/agents/${agentId}/mail/${account.id}`, {
    method: "PUT",
    json: emailCardSave(undefined, "read"),
  });
  expect(put.status).toBe(200);

  const loss = (who: typeof owner) =>
    who(`${org}/agents/${agentId}/audience/mail-loss`, { json: { audience: { mode: "everyone", userIds: [] } } });
  const asked = await loss(carla);
  expect(asked.status).toBe(200);
  expect(await asked.json()).toMatchObject({
    mailboxes: [{ accountId: account.id, address: "support@example.com", ownerName: "owner" }],
  });
  // Its own mailbox stays with the person widening it; asking took nothing.
  expect(await (await loss(owner)).json()).toEqual({ mailboxes: [] });
  const after = (await (await owner(`${org}/agents/${agentId}/mail`)).json()) as {
    mailboxes: { accountId: string; level: string }[];
  };
  expect(after.mailboxes.find((x) => x.accountId === account.id)?.level).toBe("read");

  // Saving with what she was asked before the mailbox came: refused, nothing changes; with it, saved.
  const save = (mailLossSeen: string[]) =>
    carla(`${org}/agents/${agentId}`, {
      method: "PATCH",
      json: { audience: { mode: "everyone", userIds: [] }, mailLossSeen },
    });
  const stale = await save([]);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "agent.mail_loss_changed" } });
  expect((await save([account.id])).status).toBe(200);
});

/** What the agent page's Email card (MailAccess.tsx) sends: its draft from the GET answer, with the level picked. */
function emailCardSave(saved: { canDelete: boolean; policy: object } | undefined, level: "read" | "read_write") {
  const policy = {
    folders: [],
    senders: [],
    windowDays: null,
    allowedRecipients: [],
    dailySendCap: 25,
    sendWithoutAsking: false,
    fromAddress: null,
    ...saved?.policy,
  };
  return { level, canDelete: saved?.canDelete ?? false, policy };
}

test("Gmail still pending at Composio on the callback's first read: the agent's Email row has its address and saves", async () => {
  const fake = fakeMail();
  // Composio still says pending when it sends the person back, then active on the next read.
  const read = fake.composio.client.getConnectedAccount;
  let reads = 0;
  fake.composio.client.getConnectedAccount = async (id, userId, options) => {
    if (++reads === 2) fake.composio.activate(id, "Owner@Gmail.com");
    return read(id, userId, options);
  };
  t = await createTestServer({ mail: fake.mail });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const { accountId } = (await (await api("/mail/accounts/composio", { json: { provider: "gmail" } })).json()) as {
    accountId: string;
  };
  const back = await owner(`/api/app/mail/composio/callback?account=${accountId}`);

  const { accounts } = (await (await api("/mail/accounts")).json()) as {
    accounts: { id: string; address: string; status: string }[];
  };
  const { mailboxes } = (await (await api(`/agents/${agentId}/mail`)).json()) as {
    mailboxes: { accountId: string; canDelete: boolean; policy: object }[];
  };
  const saved = mailboxes.find((m) => m.accountId === accountId);
  const put = await api(`/agents/${agentId}/mail/${accountId}`, {
    method: "PUT",
    json: emailCardSave(saved, "read_write"),
  });
  expect({ status: put.status, body: await put.json() }).toMatchObject({
    status: 200,
    body: { accountId, level: "read_write", canDelete: false },
  });
  expect(accounts.map((a) => [a.id, a.address, a.status])).toEqual([[accountId, "owner@gmail.com", "active"]]);
  expect(back.headers.get("location")).toBe(
    `${t.config.PUBLIC_URL}/org/${orgId}/settings/connectors?mail=connected&account=${accountId}`,
  );
});

test("Gmail started in the desktop app: the browser without our session hands the return to the app, and it saves", async () => {
  const fake = fakeMail();
  t = await createTestServer({ mail: fake.mail });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const start = async (desktop: boolean) => {
    const r = await api("/mail/accounts/composio", { json: { provider: "gmail", desktop } });
    const { accountId } = (await r.json()) as { accountId: string };
    const link = fake.composio.state.links.at(-1);
    if (!link) throw new Error("no connect link");
    return { accountId, ca: link.connectedAccountId };
  };
  // The window opens Composio in the person's browser, which isn't signed in.
  const signedOut = browser(t);
  const callback = (accountId: string, from = "&from=desktop") =>
    signedOut(`/api/app/mail/composio/callback?account=${accountId}${from}`, { origin: null });

  const gmail = await start(true);
  fake.composio.activate(gmail.ca, "owner@gmail.com");
  const back = await callback(gmail.accountId);
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toBe(
    `agenteschat://desktop/connectors/oauth?org=${orgId}&state=mail&code=connected`,
  );
  const { accounts } = (await (await api("/mail/accounts")).json()) as {
    accounts: { id: string; address: string; status: string }[];
  };
  expect(accounts.map((a) => [a.id, a.address, a.status])).toEqual([[gmail.accountId, "owner@gmail.com", "active"]]);
  const put = await api(`/agents/${agentId}/mail/${gmail.accountId}`, {
    method: "PUT",
    json: emailCardSave(undefined, "read_write"),
  });
  expect(put.status).toBe(200);

  // Refused at Composio, or a mailbox that isn't there: the app hears it failed.
  const refused = await start(true);
  const remote = fake.composio.state.accounts.get(refused.ca);
  if (remote) remote.status = "failed";
  expect((await callback(refused.accountId)).headers.get("location")).toBe(
    `agenteschat://desktop/connectors/oauth?org=${orgId}&state=mail&code=failed`,
  );
  expect((await callback(crypto.randomUUID())).headers.get("location")).toBe(
    "agenteschat://desktop/connectors/oauth?state=mail&code=failed",
  );

  // Started on the web, back in a browser that isn't signed in: it connects all the same.
  const web = await start(false);
  fake.composio.activate(web.ca, "team@gmail.com");
  expect((await callback(web.accountId, "")).headers.get("location")).toBe(
    `${t.config.PUBLIC_URL}/org/${orgId}/settings/connectors?mail=connected&account=${web.accountId}`,
  );

  // Open to anyone, so limited per address: 30 in 10 minutes.
  const statuses: number[] = [];
  for (let i = 0; i < 27; i++) statuses.push((await callback(crypto.randomUUID())).status);
  expect(statuses.slice(0, 26).every((s) => s === 302)).toBe(true);
  expect(statuses.at(-1)).toBe(429);
});

test("Reconectar on a Gmail that needs it: the same mailbox signs in again and comes back connected", async () => {
  const fake = fakeMail();
  t = await createTestServer({ mail: fake.mail });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const signIn = async (json: object) => {
    const { accountId } = (await (await api("/mail/accounts/composio", { json })).json()) as { accountId: string };
    fake.composio.activate(fake.composio.state.links.at(-1)?.connectedAccountId ?? "", "team@example.com");
    const back = await owner(`/api/app/mail/composio/callback?account=${accountId}`);
    return { accountId, location: back.headers.get("location") };
  };
  const first = await signIn({ provider: "gmail" });
  await t.db
    .update(schema.mailAccounts)
    .set({ status: "needs_reconnect" })
    .where(eq(schema.mailAccounts.id, first.accountId));

  expect(await signIn({ provider: "gmail", accountId: first.accountId })).toEqual({
    accountId: first.accountId,
    location: `${t.config.PUBLIC_URL}/org/${orgId}/settings/connectors?mail=connected&account=${first.accountId}`,
  });
  const { accounts } = (await (await api("/mail/accounts")).json()) as { accounts: { id: string; status: string }[] };
  expect(accounts.map((a) => [a.id, a.status])).toEqual([[first.accountId, "active"]]);
});

test("email routines through the routines API, woken by a signed Composio webhook", async () => {
  const fake = fakeMail();
  t = await createTestServer({ mail: fake.mail });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const { accountId } = (await (await api("/mail/accounts/composio", { json: { provider: "gmail" } })).json()) as {
    accountId: string;
  };
  fake.composio.activate("ca_1", "team@example.com");
  await owner(`/api/app/mail/composio/callback?account=${accountId}`);
  await api(`/agents/${agentId}/mail/${accountId}`, {
    method: "PUT",
    json: {
      level: "read",
      canDelete: false,
      policy: {
        folders: [],
        senders: [],
        windowDays: null,
        allowedRecipients: [],
        dailySendCap: 25,
        sendWithoutAsking: false,
        fromAddress: null,
      },
    },
  });

  const created = await api("/routines", {
    json: {
      agentId,
      prompt: "Triage support mail",
      target: { type: "dm" },
      trigger: { type: "email", accountId, filter: { from: ["@acme.com"] } },
    },
  });
  expect(created.status).toBe(201);
  const routine = (await created.json()) as { id: string; trigger: Record<string, unknown> };
  expect(routine.trigger).toEqual({
    type: "email",
    accountId,
    folder: "INBOX",
    filter: { from: ["@acme.com"] },
    status: "active",
  });
  const [triggerId] = [...fake.composio.state.triggers.keys()];

  const hook = (body: unknown, signature = FAKE_COMPOSIO_SIGNATURE) =>
    t.app.request("/api/webhooks/composio", {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-signature": signature },
      body: JSON.stringify(body),
    });
  const event = {
    type: "mail.received",
    triggerId,
    connectedAccountId: "ca_1",
    message: {
      id: "g1",
      from: { address: "ana@acme.com" },
      to: [],
      cc: [],
      subject: "Help",
      date: new Date().toISOString(),
      snippet: "please",
      unread: true,
      hasAttachments: false,
    },
  };
  expect((await hook(event, "v1,forged")).status).toBe(401);
  const accepted = await hook(event);
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({ ok: true, type: "mail.received", fired: 1 });
  // Retried by Composio: the same message never runs twice.
  expect(await (await hook(event)).json()).toMatchObject({ fired: 0 });
  const runs = await t.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routine.id));
  expect(runs).toHaveLength(1);

  // Listing shows the email trigger; deleting the routine deletes the trigger.
  const listed = (await (await api("/routines")).json()) as { routines: { id: string; trigger: { type: string } }[] };
  expect(listed.routines.find((r) => r.id === routine.id)?.trigger.type).toBe("email");
  expect((await api(`/routines/${routine.id}`, { method: "DELETE" })).status).toBe(204);
  expect(fake.composio.state.triggers.size).toBe(0);
});
