import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { mailAccountAad, purgeWorkspace, retireMillionSendMailboxes, sealSecret } from "../src";
import { type MailFixture, mailSetup } from "./mail-fixtures";

const { mailAccounts, agentScopes, auditLog, organizations } = schema;
const WEBHOOK = "00000000-0000-4000-8000-000000000001";

let m: MailFixture | undefined;
afterEach(async () => {
  await m?.f.close();
  m = undefined;
});

/** A MillionSend mailbox as the withdrawn path left it: sealed key and webhook, and an agent reading it. */
async function millionSendRow(fx: MailFixture, revoked = false, webhookId = WEBHOOK) {
  const id = crypto.randomUUID();
  const wrapper = fx.deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const secret = JSON.stringify({ apiKey: "ms_fake_full", webhook: { id: webhookId, secret: "whsec_fake" } });
  const sealed = await sealSecret(wrapper, secret, mailAccountAad(fx.f.org.id, id));
  await fx.f.db.insert(mailAccounts).values({
    id,
    orgId: fx.f.org.id,
    provider: "millionsend",
    via: "millionsend",
    address: "suporte@acme.example.com",
    status: "active",
    externalAccountId: "7eeb9517-aed7-40d7-ad65-500be42ed147",
    secretCiphertext: sealed.ciphertext,
    wrappedDataKey: sealed.wrappedDataKey,
    kekId: sealed.kekId,
    revokedAt: revoked ? new Date("2026-11-01T12:00:00Z") : null,
  });
  await fx.f.db
    .insert(agentScopes)
    .values({ orgId: fx.f.org.id, agentId: fx.f.agent.id, connectionId: id, scope: "mail:read" });
  return id;
}

function fakeFetch(status: number) {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
    return new Response(null, { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe("retireMillionSendMailboxes", () => {
  test("deletes each webhook with the mailbox's own key, disconnects it like a person would, and runs once", async () => {
    m = await mailSetup();
    const id = await millionSendRow(m);
    const http = fakeFetch(200);
    const deps = { db: m.f.db, keyWrappers: m.deps.keyWrappers, fetch: http.fetch };
    expect(await retireMillionSendMailboxes(deps)).toEqual({ checked: 1, webhooksLeft: [] });
    expect(http.calls).toEqual([
      { url: `https://api.millionsend.com/webhooks/${WEBHOOK}`, method: "DELETE", auth: "Bearer ms_fake_full" },
    ]);
    const [row] = await m.f.db.select().from(mailAccounts).where(eq(mailAccounts.id, id));
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.secretCiphertext).toBeNull();
    expect(await m.f.db.select().from(agentScopes).where(eq(agentScopes.connectionId, id))).toEqual([]);
    const audit = await m.f.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, id), eq(auditLog.action, "mail_account.disconnected")));
    expect(audit.length).toBe(1);
    expect(await retireMillionSendMailboxes(deps)).toEqual({ checked: 0, webhooksLeft: [] });
    expect(http.calls.length).toBe(1);
  });

  test("a delete MillionSend fails keeps the key for the next boot, but the mailbox is disconnected now", async () => {
    m = await mailSetup();
    const id = await millionSendRow(m);
    const down = fakeFetch(503);
    const deps = { db: m.f.db, keyWrappers: m.deps.keyWrappers };
    expect(await retireMillionSendMailboxes({ ...deps, fetch: down.fetch })).toEqual({
      checked: 1,
      webhooksLeft: [id],
    });
    const [row] = await m.f.db.select().from(mailAccounts).where(eq(mailAccounts.id, id));
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.secretCiphertext).not.toBeNull();
    const up = fakeFetch(404);
    expect(await retireMillionSendMailboxes({ ...deps, fetch: up.fetch })).toEqual({ checked: 1, webhooksLeft: [] });
    const [after] = await m.f.db.select().from(mailAccounts).where(eq(mailAccounts.id, id));
    expect(after?.secretCiphertext).toBeNull();
    expect(after?.revokedAt).toEqual(row?.revokedAt ?? null);
    const audit = await m.f.db.select().from(auditLog).where(eq(auditLog.targetId, id));
    expect(audit.filter((a) => a.action === "mail_account.disconnected").length).toBe(1);
  });

  test("one a person already disconnected only loses its webhook and key", async () => {
    m = await mailSetup();
    const id = await millionSendRow(m, true);
    const http = fakeFetch(200);
    await retireMillionSendMailboxes({ db: m.f.db, keyWrappers: m.deps.keyWrappers, fetch: http.fetch });
    const [row] = await m.f.db.select().from(mailAccounts).where(eq(mailAccounts.id, id));
    expect(row?.revokedAt).toEqual(new Date("2026-11-01T12:00:00Z"));
    expect(row?.secretCiphertext).toBeNull();
    const audit = await m.f.db.select().from(auditLog).where(eq(auditLog.targetId, id));
    expect(audit).toEqual([]);
    expect(http.calls.length).toBe(1);
  });

  test("a key MillionSend forbids, or a webhook id that can't be MillionSend's, is done: the key goes, no retry", async () => {
    m = await mailSetup();
    const forbidden = await millionSendRow(m);
    const http = fakeFetch(403);
    const deps = { db: m.f.db, keyWrappers: m.deps.keyWrappers, fetch: http.fetch };
    expect(await retireMillionSendMailboxes(deps)).toEqual({ checked: 1, webhooksLeft: [] });
    const malformed = await millionSendRow(m, false, "not-a-webhook-id");
    expect(await retireMillionSendMailboxes(deps)).toEqual({ checked: 1, webhooksLeft: [] });
    expect(http.calls.length).toBe(1);
    const rows = await m.f.db.select().from(mailAccounts);
    expect(rows.filter((r) => [forbidden, malformed].some((id) => id === r.id)).map((r) => r.secretCiphertext)).toEqual(
      [null, null],
    );
  });

  test("a workspace's purge retries a webhook the boot step couldn't delete before its sealed key goes", async () => {
    m = await mailSetup();
    const id = await millionSendRow(m);
    const fx = m;
    await retireMillionSendMailboxes({ db: fx.f.db, keyWrappers: fx.deps.keyWrappers, fetch: fakeFetch(503).fetch });
    await fx.f.db
      .update(organizations)
      .set({ deletionRequestedAt: new Date("2026-01-01T00:00:00Z"), deletionDueAt: new Date("2026-01-02T00:00:00Z") })
      .where(eq(organizations.id, fx.f.org.id));
    const deps = { db: fx.f.db, connectors: { keyWrappers: fx.deps.keyWrappers } } as Parameters<
      typeof purgeWorkspace
    >[0];
    const down = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response(null, { status: 503 })) as never,
    );
    try {
      await expect(purgeWorkspace(deps, fx.f.org.id)).rejects.toThrow(id);
      expect(down).toHaveBeenCalledTimes(1);
      down.mockImplementation((async () => new Response(null, { status: 200 })) as never);
      expect(await purgeWorkspace(deps, fx.f.org.id)).toBe(true);
      expect(down).toHaveBeenCalledTimes(2);
    } finally {
      down.mockRestore();
    }
  });
});
