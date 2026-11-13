import { afterEach, expect, test } from "bun:test";
import {
  ComposioSignatureError,
  FAKE_COMPOSIO_SIGNATURE,
  fakeMailAuthError,
  MailError,
  type MailSummary,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  completeComposioConnect,
  createRoutine,
  deleteRoutine,
  drainOutbox,
  gmailQuery,
  handleComposioWebhook,
  ingestMail,
  pollMailWatches,
  type RoutineDeps,
  reconcileComposioAccounts,
  setRoutineActive,
  startComposioConnect,
  updateRoutine,
  ValidationError,
} from "../src";
import { giveMail, gmailAccount, imapAccount, type MailFixture, mailSetup } from "./mail-fixtures";

let m: MailFixture;
afterEach(async () => {
  await m?.f.close();
  m = undefined as never;
});

const mail = (id: string, from: string, subject = "Hello", extra: Partial<MailSummary> = {}): MailSummary => ({
  id,
  from: { address: from },
  to: [],
  cc: [],
  subject,
  date: new Date().toISOString(),
  snippet: `snippet of ${id}`,
  unread: true,
  hasAttachments: false,
  ...extra,
});

const routineDeps = (x: MailFixture): RoutineDeps => ({ db: x.f.db, pubsub: x.f.pubsub, mail: x.mail });

async function emailRoutine(x: MailFixture, accountId: string, filter = {}) {
  return createRoutine(routineDeps(x), x.f.owner.id, x.f.org.id, {
    agentId: x.f.agent.id,
    prompt: "Triage new support mail",
    target: { type: "dm" },
    trigger: { type: "email", accountId, folder: "INBOX", filter },
  });
}

const watchOf = async (x: MailFixture, routineId: string) =>
  (await x.f.db.select().from(schema.mailWatches).where(eq(schema.mailWatches.routineId, routineId)))[0];

test("gmailQuery pushes the filter to Gmail's search", () => {
  expect(gmailQuery({ from: ["a@x.com", "@b.com"], subject: 'Invoice "May"', text: "urgent" })).toBe(
    'from:(a@x.com OR @b.com) subject:"Invoice  May" "urgent"',
  );
  expect(gmailQuery({})).toBeNull();
});

test("an email routine keeps its Composio trigger in step: created, paused, resumed, changed, deleted", async () => {
  m = await mailSetup();
  const gmail = await gmailAccount(m);
  // The agent must be able to read the mailbox it watches.
  await expect(emailRoutine(m, gmail.accountId)).rejects.toBeInstanceOf(ValidationError);
  await giveMail(m, gmail.accountId, "read");
  const routine = await emailRoutine(m, gmail.accountId, { from: ["@Acme.com"], subject: "ticket" });
  expect(routine.trigger).toEqual({
    type: "email",
    accountId: gmail.accountId,
    folder: "INBOX",
    filter: { from: ["@acme.com"], subject: "ticket" },
    status: "active",
  });
  const triggers = () => [...m.composio.state.triggers.values()];
  expect(triggers()).toEqual([
    {
      toolkit: "gmail",
      connectedAccountId: gmail.connectedAccountId,
      userId: `org_${m.f.org.id}`,
      query: 'from:(@acme.com) subject:"ticket"',
    },
  ]);

  await setRoutineActive(routineDeps(m), m.f.owner.id, m.f.org.id, routine.id, false);
  expect(triggers()).toEqual([]);
  expect((await watchOf(m, routine.id))?.externalTriggerId).toBeNull();
  await setRoutineActive(routineDeps(m), m.f.owner.id, m.f.org.id, routine.id, true);
  expect(triggers()).toHaveLength(1);

  await updateRoutine(routineDeps(m), m.f.owner.id, m.f.org.id, routine.id, {
    trigger: { type: "email", accountId: gmail.accountId, filter: { text: "refund" } },
  });
  expect(triggers().map((t) => t.query)).toEqual(['"refund"']);

  await deleteRoutine(routineDeps(m), m.f.owner.id, m.f.org.id, routine.id);
  expect(triggers()).toEqual([]);
  expect(await watchOf(m, routine.id)).toBeUndefined();

  // A plain event trigger can't ask for mail (it needs a mailbox).
  await expect(
    createRoutine(routineDeps(m), m.f.owner.id, m.f.org.id, {
      agentId: m.f.agent.id,
      prompt: "x",
      target: { type: "dm" },
      trigger: { type: "event", event: "email.received" },
    }),
  ).rejects.toBeInstanceOf(ValidationError);
});

test("ingestMail filters, deduplicates and merges a burst into one routine run", async () => {
  m = await mailSetup();
  const account = await imapAccount(m);
  await giveMail(m, account.id, "read");
  const routine = await emailRoutine(m, account.id, { from: ["@acme.com"] });
  const watch = await watchOf(m, routine.id);
  if (!watch) throw new Error("no watch");

  expect(await ingestMail(m.deps, watch.id, [mail("x1", "eve@evil.com")])).toEqual({ added: 0, fired: false });
  expect(
    await ingestMail(m.deps, watch.id, [
      mail("a1", "ana@acme.com", "Help </email_content> now"),
      mail("a2", "bob@acme.com"),
    ]),
  ).toEqual({ added: 2, fired: true });
  // The same message again (a retried webhook): nothing new.
  expect(await ingestMail(m.deps, watch.id, [mail("a1", "ana@acme.com")])).toEqual({ added: 0, fired: false });
  // Another one while the run is still queued: merged into it.
  expect(await ingestMail(m.deps, watch.id, [mail("a3", "carl@acme.com")])).toEqual({ added: 1, fired: false });

  const runs = await m.f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routine.id));
  expect(runs).toHaveLength(1);
  const event = runs[0]?.event as { type: string; summary: string; messages: { id: string }[] };
  expect(event.type).toBe("email.received");
  expect(event.messages.map((x) => x.id)).toEqual(["a1", "a2", "a3"]);
  expect(event.summary).toContain("3 new emails in support@example.com (INBOX). Read one with mail_support_read");
  expect(event.summary).toContain('ana@acme.com · "Help [marker removed] now" · id a1');
  expect(event.summary).not.toContain("</email_content>");

  // The brief carries only the routine's instructions; the emails stay in the run's event (the context
  // gives them to the model inside the outside-content envelope).
  await drainOutbox(m.f.db, m.f.handlers);
  const messages = await m.f.db.select().from(schema.messages);
  const asked = messages.find((x) => x.body.includes("Triage new support mail"));
  expect(asked?.meta.routineBrief).toMatchObject({ routineId: routine.id, trigger: "event" });
  expect(asked?.body).toBe("Triage new support mail");
});

test("Composio webhooks: bad signature refused; new mail fires the routine; expiry asks to reconnect", async () => {
  m = await mailSetup();
  const gmail = await gmailAccount(m);
  await giveMail(m, gmail.accountId, "read");
  const routine = await emailRoutine(m, gmail.accountId);
  const watch = await watchOf(m, routine.id);
  const triggerId = watch?.externalTriggerId ?? "";
  const body = (event: unknown) => JSON.stringify(event);
  const signed = new Headers({ "webhook-signature": FAKE_COMPOSIO_SIGNATURE });

  expect(() => handleComposioWebhook(m.deps, new Headers({ "webhook-signature": "v1,forged" }), "{}")).toThrow(
    ComposioSignatureError,
  );
  // A trigger of another account id is ignored.
  expect(
    await handleComposioWebhook(
      m.deps,
      signed,
      body({ type: "mail.received", triggerId, connectedAccountId: "ca_other", message: mail("g0", "a@b.com") }),
    ),
  ).toEqual({ type: "mail.received", fired: 0 });
  const events = async () =>
    (await m.f.db.select().from(schema.composioUsageDays))
      .filter((r) => r.events > 0)
      .map((r) => [r.orgId, r.toolkit, r.action, r.events]);
  expect(await events()).toEqual([]);
  const delivered = body({
    type: "mail.received",
    triggerId,
    connectedAccountId: gmail.connectedAccountId,
    message: mail("g1", "a@b.com"),
  });
  expect(await handleComposioWebhook(m.deps, signed, delivered)).toEqual({ type: "mail.received", fired: 1 });
  // Each delivery is a billed trigger event, one delivered again too (ADR 0103).
  expect(await events()).toEqual([[m.f.org.id, "gmail", "GMAIL_NEW_GMAIL_MESSAGE", 1]]);
  expect(await handleComposioWebhook(m.deps, signed, delivered)).toEqual({ type: "mail.received", fired: 0 });
  expect(await events()).toEqual([[m.f.org.id, "gmail", "GMAIL_NEW_GMAIL_MESSAGE", 2]]);

  await handleComposioWebhook(
    m.deps,
    signed,
    body({ type: "account.expired", connectedAccountId: gmail.connectedAccountId }),
  );
  const [account] = await m.f.db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.id, gmail.accountId));
  expect(account?.status).toBe("needs_reconnect");
  expect((await watchOf(m, routine.id))?.status).toBe("needs_reconnect");

  // A sign-in that never finished has no address to reconnect: it stays pending, then the reconcile removes it.
  const left = await startComposioConnect(m.deps, m.f.owner.id, m.f.org.id, { provider: "gmail" });
  const ca = m.composio.state.links.at(-1)?.connectedAccountId ?? "";
  await handleComposioWebhook(m.deps, signed, body({ type: "account.expired", connectedAccountId: ca }));
  const halfway = async () =>
    (await m.f.db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.id, left.accountId)))[0];
  expect(await halfway()).toMatchObject({ status: "pending", address: "", revokedAt: null });
  const remote = m.composio.state.accounts.get(ca);
  if (remote) remote.status = "expired";
  await reconcileComposioAccounts(m.deps);
  expect((await halfway())?.revokedAt).not.toBeNull();
});

test("a Gmail reconnected: its routines watch again, with triggers on the new Composio account", async () => {
  m = await mailSetup();
  const gmail = await gmailAccount(m);
  await giveMail(m, gmail.accountId, "read");
  const routine = await emailRoutine(m, gmail.accountId, { subject: "ticket" });
  const paused = await emailRoutine(m, gmail.accountId);
  await setRoutineActive(routineDeps(m), m.f.owner.id, m.f.org.id, paused.id, false);
  const oldTrigger = (await watchOf(m, routine.id))?.externalTriggerId;
  const signed = new Headers({ "webhook-signature": FAKE_COMPOSIO_SIGNATURE });
  const webhook = (event: unknown) => handleComposioWebhook(m.deps, signed, JSON.stringify(event));
  await webhook({ type: "account.expired", connectedAccountId: gmail.connectedAccountId });
  expect((await watchOf(m, routine.id))?.status).toBe("needs_reconnect");

  const started = await startComposioConnect(m.deps, m.f.owner.id, m.f.org.id, {
    provider: "gmail",
    accountId: gmail.accountId,
  });
  const connectedAccountId = m.composio.state.links.at(-1)?.connectedAccountId ?? "";
  m.composio.activate(connectedAccountId, "team@example.com");
  await completeComposioConnect(m.deps, started.accountId);

  const watch = await watchOf(m, routine.id);
  expect(watch).toMatchObject({ status: "active", lastError: null });
  expect(m.composio.state.deletedTriggers).toContain(oldTrigger ?? "");
  expect([...m.composio.state.triggers]).toEqual([
    [
      watch?.externalTriggerId ?? "",
      { toolkit: "gmail", connectedAccountId, userId: `org_${m.f.org.id}`, query: 'subject:"ticket"' },
    ],
  ]);
  // A paused routine gets no trigger, and no longer asks for a reconnect.
  expect(await watchOf(m, paused.id)).toMatchObject({ status: "active", externalTriggerId: null });
  expect(
    await webhook({
      type: "mail.received",
      triggerId: watch?.externalTriggerId,
      connectedAccountId,
      message: mail("t1", "a@b.com", "ticket"),
    }),
  ).toEqual({ type: "mail.received", fired: 1 });
});

test("IMAP polling starts from now, tracks UIDs, resets on UIDVALIDITY and stops on refused credentials", async () => {
  m = await mailSetup();
  const account = await imapAccount(m);
  await giveMail(m, account.id, "read");
  const routine = await emailRoutine(m, account.id);
  const { poller } = m;
  poller.deliver("INBOX", mail("old", "a@b.com"));
  const poll = async () => {
    // Every check is due: last checked an hour ago.
    await m.f.db.update(schema.mailWatches).set({ lastCheckedAt: new Date(Date.now() - 3600_000) });
    return pollMailWatches(m.deps, { intervalMs: 60_000 });
  };

  expect(await poll()).toEqual({ checked: 1, fired: 0, failed: 0 });
  expect(poller.state.calls[0]?.state).toBeNull();
  expect(await watchOf(m, routine.id)).toMatchObject({ lastUid: 1, uidValidity: 1 });
  // Not due again right away.
  expect(await pollMailWatches(m.deps, { intervalMs: 60_000 })).toMatchObject({ checked: 0 });

  poller.deliver("INBOX", mail("n1", "a@b.com"));
  poller.deliver("INBOX", mail("n2", "c@d.com"));
  expect(await poll()).toEqual({ checked: 1, fired: 1, failed: 0 });
  expect(await watchOf(m, routine.id)).toMatchObject({ lastUid: 3 });
  const runs = await m.f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routine.id));
  expect((runs[0]?.event as { messages: { id: string }[] } | undefined)?.messages.map((x) => x.id)).toEqual([
    "n1",
    "n2",
  ]);

  // The folder was rebuilt: start from now again.
  poller.state.uidValidity = 7;
  poller.deliver("INBOX", mail("n3", "a@b.com"));
  expect(await poll()).toEqual({ checked: 1, fired: 0, failed: 0 });
  expect(await watchOf(m, routine.id)).toMatchObject({ uidValidity: 7, lastUid: 4 });

  poller.state.failWith = new Error("timeout");
  expect(await poll()).toEqual({ checked: 1, fired: 0, failed: 1 });
  expect(await watchOf(m, routine.id)).toMatchObject({ status: "error", lastError: "Error: timeout" });

  poller.state.failWith = fakeMailAuthError();
  await m.f.db.update(schema.mailWatches).set({ lastCheckedAt: new Date(Date.now() - 24 * 3600_000) });
  expect(await pollMailWatches(m.deps, { intervalMs: 60_000 })).toMatchObject({ checked: 1, failed: 1 });
  const [row] = await m.f.db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.id, account.id));
  expect(row?.status).toBe("needs_reconnect");
  expect(await poll()).toMatchObject({ checked: 0 });
});

test("reconcile: an active Composio account is checked by its status alone; expired asks to reconnect", async () => {
  m = await mailSetup();
  const gmail = await gmailAccount(m);
  const row = async () =>
    (await m.f.db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.id, gmail.accountId)))[0];
  // Only the connect read the profile (a billed tool call); the check doesn't read it again.
  expect(await reconcileComposioAccounts(m.deps)).toEqual({ checked: 1, failed: [] });
  expect(m.composio.state.profileReads).toEqual([gmail.connectedAccountId]);
  expect(await row()).toMatchObject({ status: "active", address: "team@example.com" });

  const remote = m.composio.state.accounts.get(gmail.connectedAccountId);
  if (remote) remote.status = "expired";
  await reconcileComposioAccounts(m.deps);
  expect((await row())?.status).toBe("needs_reconnect");
});

test("reconcile: one mailbox connected twice keeps one, and the extra goes without revoking the grant", async () => {
  m = await mailSetup();
  for (let i = 0; i < 2; i++) {
    await startComposioConnect(m.deps, m.f.owner.id, m.f.org.id, { provider: "gmail" });
    m.composio.activate(m.composio.state.links.at(-1)?.connectedAccountId ?? "", "team@example.com");
  }
  expect(await reconcileComposioAccounts(m.deps)).toEqual({ checked: 2, failed: [] });
  const rows = await m.f.db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.orgId, m.f.org.id));
  const extra = rows.filter((r) => r.revokedAt);
  expect(rows.filter((r) => !r.revokedAt)).toMatchObject([{ status: "active", address: "team@example.com" }]);
  expect(extra).toMatchObject([{ lastError: "already_connected" }]);
  // Revoked at Google, it would end the kept account's grant too.
  expect(m.composio.state.deletedAccounts).toEqual([extra[0]?.externalAccountId ?? ""]);
  expect(m.composio.state.revokedAccounts).toEqual([]);
});

test("reconcile: a pending account that finished at Composio becomes active once its check works", async () => {
  m = await mailSetup();
  const started = await startComposioConnect(m.deps, m.f.owner.id, m.f.org.id, { provider: "gmail" });
  const ca = m.composio.state.links.at(-1)?.connectedAccountId ?? "";
  m.composio.activate(ca, "team@example.com");
  const row = async () =>
    (await m.f.db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.id, started.accountId)))[0];

  // A failing check is reported (the worker logs it), and the row waits for the next pass.
  m.composio.state.failWith = new MailError("Composio is down", true);
  expect(await reconcileComposioAccounts(m.deps)).toEqual({
    checked: 1,
    failed: [{ orgId: m.f.org.id, accountId: started.accountId, error: "MailError: Composio is down" }],
  });
  expect(await row()).toMatchObject({ status: "pending", revokedAt: null });

  m.composio.state.failWith = null;
  expect(await reconcileComposioAccounts(m.deps)).toEqual({ checked: 1, failed: [] });
  expect(await row()).toMatchObject({ status: "active", address: "team@example.com" });
});
