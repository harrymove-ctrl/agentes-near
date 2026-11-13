import { expect, test } from "bun:test";
import { githubHookLink, WEBHOOK_TEST_MS, webhookTestState } from "../src/lib/routine-webhooks";

const at = (ms: number) => new Date(ms).toISOString();
const T = Date.parse("2026-11-06T12:00:00Z");

test("a repository's webhook page on GitHub, only for owner/name", () => {
  expect(githubHookLink("acme/app")).toBe("https://github.com/acme/app/settings/hooks/new");
  expect(githubHookLink(" https://github.com/acme/app ")).toBe("https://github.com/acme/app/settings/hooks/new");
  for (const bad of ["", "acme", "acme/app/x", "acme/app?x=1"]) expect(githubHookLink(bad)).toBeNull();
});

test("Testar: waiting, green on a call with the right secret, refused on another, nothing after the wait", () => {
  const none = { receivedAt: null, refusedAt: null };
  expect(webhookTestState(undefined, null, T)).toBe("idle");
  expect(webhookTestState(none, null, T)).toBe("idle");
  expect(webhookTestState({ receivedAt: at(T - 86_400_000), refusedAt: null }, null, T)).toBe("working");
  expect(webhookTestState({ receivedAt: null, refusedAt: at(T) }, null, T)).toBe("refused");
  expect(webhookTestState(none, T, T + 1000)).toBe("waiting");
  expect(webhookTestState(none, T, T + WEBHOOK_TEST_MS)).toBe("timeout");
  // GitHub's ping can land just before Testar (the one-click add returns after it).
  expect(webhookTestState({ receivedAt: at(T - 5000), refusedAt: null }, T, T + 1000)).toBe("working");
  // A day-old call doesn't count for a new test (another repository).
  expect(webhookTestState({ receivedAt: at(T - 86_400_000), refusedAt: null }, T, T + 1000)).toBe("waiting");
  expect(webhookTestState({ receivedAt: null, refusedAt: at(T + 500) }, T, T + 1000)).toBe("refused");
  expect(webhookTestState({ receivedAt: at(T + 900), refusedAt: at(T + 500) }, T, T + 1000)).toBe("working");
});
