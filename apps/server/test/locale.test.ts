import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t?.close());

test("the person's language (ADR 0122): PATCH /me saves any language of the app, /me returns it", async () => {
  t = await createTestServer();
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  const me = async () =>
    ((await (await ana("/api/app/me")).json()) as { user: { locale: string | null; localeAuto: boolean } }).user;
  expect(await me()).toMatchObject({ localeAuto: true });

  expect((await ana("/api/app/me", { method: "PATCH", json: { locale: "fr", auto: false } })).status).toBe(204);
  expect(await me()).toMatchObject({ locale: "fr", localeAuto: false });
  // Detected by a device: `auto` defaults to false only when it is left out.
  expect((await ana("/api/app/me", { method: "PATCH", json: { locale: "ja", auto: true } })).status).toBe(204);
  expect(await me()).toMatchObject({ locale: "ja", localeAuto: true });
  expect((await ana("/api/app/me", { method: "PATCH", json: { locale: "xx" } })).status).toBe(400);

  // An email to them is written in that language (English where it has no words yet).
  await ana("/api/app/me", { method: "PATCH", json: { locale: "fr" } });
  await t.drain();
  const before = t.email.sent.length;
  const reset = await browser(t)("/api/auth/request-password-reset", {
    json: { email: "ana@example.com", redirectTo: "/reset-password" },
  });
  expect(reset.status).toBe(200);
  await t.drain();
  expect(t.email.sent.slice(before).map((m) => m.html.includes('lang="fr"'))).toEqual([true]);
});

test("the person's own area: PUT /me/work-area takes an id of the list or skipped, /me returns it", async () => {
  t = await createTestServer();
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  const area = async () =>
    ((await (await ana("/api/app/me")).json()) as { user: { workArea: string | null } }).user.workArea;
  // Not asked yet.
  expect(await area()).toBeNull();
  expect((await ana("/api/app/me/work-area", { method: "PUT", json: { area: "marketing" } })).status).toBe(204);
  expect(await area()).toBe("marketing");
  expect((await ana("/api/app/me/work-area", { method: "PUT", json: { area: "skipped" } })).status).toBe(204);
  expect(await area()).toBe("skipped");
  // Only the list's ids.
  expect((await ana("/api/app/me/work-area", { method: "PUT", json: { area: "astronaut" } })).status).toBe(400);
  expect(await area()).toBe("skipped");
  // Signed out: nothing to say it for.
  expect((await browser(t)("/api/app/me/work-area", { method: "PUT", json: { area: "dev" } })).status).toBe(401);
});

test("a browser that says no language of ours gets English", async () => {
  t = await createTestServer();
  const bia = browser(t);
  const res = await bia("/api/auth/sign-up/email", {
    json: { email: "bia@example.com", password: "correct horse battery", name: "bia" },
    headers: { "accept-language": "xx-XX" },
  });
  expect(res.status).toBe(200);
  await t.drain();
  expect(t.email.sent.at(-1)?.subject).toBe("Confirm your email for agentes.chat");
  expect(((await (await bia("/api/app/me")).json()) as { user: { locale: string | null } }).user.locale).toBeNull();
});
