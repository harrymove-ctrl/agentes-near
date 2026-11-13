import { afterEach, expect, test } from "bun:test";
import { enableAccountContacts } from "@agenteschat/engine";
import { browser, createTestServer, ORIGIN, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => {
  enableAccountContacts(ORIGIN, t.email);
  return t?.close();
});

test("self-hosted: a sign-up and a language change leave no contact", async () => {
  t = await createTestServer();
  enableAccountContacts(ORIGIN, t.email);
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  await ana("/api/app/me", { method: "PATCH", json: { locale: "fr", auto: false } });
  await t.drain();
  expect(t.email.contacts).toEqual([]);
});

test("on agentes.chat Cloud: a sign-up becomes a contact with its creation date; a language change syncs it again", async () => {
  t = await createTestServer();
  enableAccountContacts("https://app.agentes.chat", t.email);
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  await t.drain();
  expect(t.email.contacts).toEqual([
    { email: "ana@example.com", properties: { account_created_at: expect.any(String), locale: expect.any(String) } },
  ]);
  expect((await ana("/api/app/me", { method: "PATCH", json: { locale: "fr", auto: false } })).status).toBe(204);
  await t.drain();
  expect(t.email.contacts.at(-1)?.properties).toMatchObject({ locale: "fr" });
});
