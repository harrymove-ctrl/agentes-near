import { afterEach, describe, expect, test } from "bun:test";
import { createFakeEmailSender } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  ACCOUNT_CONTACT_JOB,
  deleteAccount,
  enableAccountContacts,
  enqueueAccountContact,
  enqueueAccountContacts,
  restoreAccount,
  saveAccountContact,
  scheduleAccountDeletion,
  setMyLocale,
  setUserBlocked,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

const CLOUD = "https://app.agentes.chat";
const SELF_HOSTED = "https://chat.example.com";
const contacts = createFakeEmailSender();

let f: Fixture;
afterEach(async () => {
  enableAccountContacts(SELF_HOSTED, contacts);
  await f?.close();
});

const jobs = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, ACCOUNT_CONTACT_JOB));

/** Runs every queued `account.contact` job against a fresh fake sender, in order, and returns what it saved. */
async function sync() {
  const sender = createFakeEmailSender();
  for (const job of await jobs()) {
    await saveAccountContact(f.db, sender, job.payload as { userId: string; email: string });
  }
  await f.db.delete(schema.outbox).where(eq(schema.outbox.kind, ACCOUNT_CONTACT_JOB));
  return sender.contacts;
}

describe("account contacts", () => {
  test("self-hosted, or a provider without contacts: nothing is queued, at boot or on any change", async () => {
    f = await setup();
    enableAccountContacts(SELF_HOSTED, contacts);
    const ana = await addUser(f.db, "ana");
    await enqueueAccountContact(f.db, ana.id);
    expect(await enqueueAccountContacts(f.db)).toBe(0);
    await setMyLocale(f.db, ana.id, "en");
    await setUserBlocked(f, ana.id, { blocked: true, reason: null });
    expect(await jobs()).toEqual([]);
    enableAccountContacts(CLOUD, { saveContact: undefined });
    await enqueueAccountContact(f.db, ana.id);
    expect(await jobs()).toEqual([]);
  });

  test("a new account saves its creation date and language; a language change syncs again", async () => {
    f = await setup();
    enableAccountContacts(CLOUD, contacts);
    const ana = await addUser(f.db, "ana");
    await enqueueAccountContact(f.db, ana.id);
    const [row] = await f.db.select().from(schema.users).where(eq(schema.users.id, ana.id));
    expect(await sync()).toEqual([
      { email: ana.email, properties: { account_created_at: row?.createdAt.toISOString() ?? "", locale: "pt-BR" } },
    ]);

    await setMyLocale(f.db, ana.id, "en");
    expect((await sync()).map((c) => c.properties.locale)).toEqual(["en"]);
  });

  test("no language: locale is left alone", async () => {
    f = await setup();
    enableAccountContacts(CLOUD, contacts);
    const ana = await addUser(f.db, "ana");
    await f.db.update(schema.users).set({ locale: null }).where(eq(schema.users.id, ana.id));
    await enqueueAccountContact(f.db, ana.id);
    expect(Object.keys((await sync())[0]?.properties ?? {})).toEqual(["account_created_at"]);
  });

  test("blocked, being deleted or gone: account_created_at is cleared; let back or restored, it returns", async () => {
    f = await setup();
    enableAccountContacts(CLOUD, contacts);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const cleared = [{ email: bia.email, properties: { account_created_at: null } }];

    await setUserBlocked(f, bia.id, { blocked: true, reason: null });
    expect(await sync()).toEqual(cleared);
    await setUserBlocked(f, bia.id, { blocked: false, reason: null });
    expect((await sync())[0]?.properties.account_created_at).toEqual(expect.any(String));

    const deps = { db: f.db, pubsub: f.pubsub };
    await scheduleAccountDeletion(deps, bia.id);
    expect(await sync()).toEqual(cleared);
    await restoreAccount(deps, bia.id);
    expect((await sync())[0]?.properties.account_created_at).toEqual(expect.any(String));

    await deleteAccount(f.db, bia.id, {});
    expect(await f.db.select().from(schema.users).where(eq(schema.users.id, bia.id))).toEqual([]);
    expect(await sync()).toEqual(cleared);
  });

  test("boot catch-up covers every account once; a restart with nothing changed queues nothing new", async () => {
    f = await setup();
    enableAccountContacts(CLOUD, contacts);
    await addUser(f.db, "ana");
    const count = (await f.db.select().from(schema.users)).length;
    expect(await enqueueAccountContacts(f.db)).toBe(count);
    expect(await jobs()).toHaveLength(count);
    await enqueueAccountContacts(f.db);
    expect(await jobs()).toHaveLength(count);
  });
});
