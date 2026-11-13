import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { ApiError, createHttpApi } from "../src/index";
import { knownErrorText } from "../src/lib/errors";
import {
  canSendWithoutAsking,
  choiceOf,
  defaultPolicy,
  loginOf,
  mailAccessOf,
  mailErrorOf,
  normalizePolicy,
  notIcloudMail,
  splitAddresses,
} from "../src/lib/mail";

type Call = { url: string; method: string; body: unknown };

function fakeFetch(responses: Record<string, { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses[`${init.method} ${url}`] ?? { status: 404, body: { error: { code: "not_found" } } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  };
  return { fetch, calls };
}

const ORG = "/api/app/organizations/o1";
const account = {
  id: "m1",
  provider: "imap",
  via: "imap",
  address: "ana@example.com",
  label: "Ana",
  status: "active",
  lastError: null,
  preset: "icloud",
  createdAt: "2026-10-18T00:00:00.000Z",
  agents: [],
};

describe("mail API", () => {
  test("paths, methods and unwrapped answers", async () => {
    const policy = defaultPolicy();
    const { fetch, calls } = fakeFetch({
      [`GET ${ORG}/mail/providers`]: { status: 200, body: { composio: true, imap: true, presets: [] } },
      [`GET ${ORG}/mail/accounts`]: { status: 200, body: { accounts: [account] } },
      [`POST ${ORG}/mail/accounts/imap`]: { status: 201, body: { account } },
      [`POST ${ORG}/mail/accounts/composio`]: { status: 200, body: { accountId: "m2", redirectUrl: "https://x" } },
      [`PATCH ${ORG}/mail/accounts/m1`]: { status: 200, body: { account } },
      [`DELETE ${ORG}/mail/accounts/m1`]: { status: 204 },
      [`GET ${ORG}/mail/accounts/m1/folders`]: { status: 200, body: { folders: [{ id: "INBOX", name: "Inbox" }] } },
      [`GET ${ORG}/agents/a1/mail`]: {
        status: 200,
        body: { mailboxes: [{ accountId: "m1", level: "read", canDelete: false, policy }] },
      },
      [`PUT ${ORG}/agents/a1/mail/m1`]: {
        status: 200,
        body: { accountId: "m1", level: "read_write", canDelete: false, policy },
      },
    });
    const api = createHttpApi({ fetch });
    expect((await api.mail.providers("o1")).composio).toBe(true);
    expect((await api.mail.accounts("o1"))[0]?.id).toBe("m1");
    expect(
      (await api.mail.connectImap("o1", { preset: "icloud", address: "ana@example.com", password: "abcd" })).id,
    ).toBe("m1");
    expect(await api.mail.connectComposio("o1", { provider: "gmail" })).toEqual({
      accountId: "m2",
      redirectUrl: "https://x",
    });
    await api.mail.update("o1", "m1", { password: "new" });
    await api.mail.disconnect("o1", "m1");
    expect(await api.mail.folders("o1", "m1")).toEqual([{ id: "INBOX", name: "Inbox" }]);
    expect((await api.mail.agent("o1", "a1"))[0]?.level).toBe("read");
    expect((await api.mail.setAgent("o1", "a1", "m1", { level: "read_write", canDelete: false, policy })).level).toBe(
      "read_write",
    );
    expect(calls.map((c) => `${c.method} ${c.url.slice(ORG.length)}`)).toEqual([
      "GET /mail/providers",
      "GET /mail/accounts",
      "POST /mail/accounts/imap",
      "POST /mail/accounts/composio",
      "PATCH /mail/accounts/m1",
      "DELETE /mail/accounts/m1",
      "GET /mail/accounts/m1/folders",
      "GET /agents/a1/mail",
      "PUT /agents/a1/mail/m1",
    ]);
    expect(calls[4]?.body).toEqual({ password: "new" });
  });

  test('a 422 `{ error: "auth" }` (a plain string) or `{ error: { code } }` maps to the error code', async () => {
    const { fetch } = fakeFetch({
      [`POST ${ORG}/mail/accounts/imap`]: { status: 422, body: { error: "auth" } },
      [`PATCH ${ORG}/mail/accounts/m1`]: { status: 422, body: { error: { code: "tls", message: "TLS failed" } } },
    });
    const api = createHttpApi({ fetch });
    const e1 = await api.mail.connectImap("o1", { preset: "icloud", address: "a@b.co", password: "x" }).catch((e) => e);
    expect(e1).toBeInstanceOf(ApiError);
    expect(mailErrorOf(e1)).toBe("auth");
    expect(mailErrorOf(await api.mail.update("o1", "m1", { password: "x" }).catch((e) => e))).toBe("tls");
    expect(mailErrorOf(new ApiError(500, "internal", "boom"))).toBe("unknown");
    expect(mailErrorOf(new Error("network"))).toBe("unknown");
  });
});

describe("mail rules", () => {
  test("addresses and @domains; the rest is invalid", () => {
    expect(splitAddresses("Ana@Empresa.com, @cliente.com.br;  oops  b@c")).toEqual({
      valid: ["ana@empresa.com", "@cliente.com.br"],
      invalid: ["oops", "b@c"],
    });
  });

  test("send without asking only with allowed recipients", () => {
    const p = { ...defaultPolicy(), sendWithoutAsking: true };
    expect(canSendWithoutAsking(p)).toBe(false);
    expect(normalizePolicy(p).sendWithoutAsking).toBe(false);
    const ok = { ...p, allowedRecipients: ["@empresa.com"] };
    expect(normalizePolicy(ok).sendWithoutAsking).toBe(true);
  });

  test("the login of a preset; which card a mailbox belongs to", () => {
    expect(loginOf({ username: "address" }, " ana@x.com ")).toBe("ana@x.com");
    expect(loginOf({ username: "local" }, "ana@x.com")).toBe("ana");
    expect(choiceOf({ provider: "gmail", preset: null })).toBe("gmail");
    expect(choiceOf({ provider: "imap", preset: "icloud" })).toBe("icloud");
    expect(choiceOf({ provider: "imap", preset: "locaweb" })).toBe("other");
  });

  test("the iCloud form's hint: a big provider's address, never Apple's own or a custom domain", () => {
    expect(notIcloudMail(" Ana@Gmail.com ")).toBe("Gmail");
    expect(notIcloudMail("ana@googlemail.com")).toBe("Gmail");
    expect(notIcloudMail("ana@outlook.com")).toBe("Outlook");
    expect(notIcloudMail("ana@live.com")).toBe("Outlook");
    expect(notIcloudMail("ana@hotmail.com.br")).toBe("Outlook");
    expect(notIcloudMail("ana@outlook.com.br")).toBe("Outlook");
    expect(notIcloudMail("ana@yahoo.com.br")).toBe("Yahoo Mail");
    for (const address of ["ana@icloud.com", "ana@me.com", "ana@mac.com", "ana@acme.com.br", "gmail.com", ""]) {
      expect(notIcloudMail(address)).toBeNull();
    }
  });
});

test("only who connected a mailbox gives access to it; whoever manages the agent takes it away", () => {
  const box = { ownerUserId: "u-ana" };
  expect(mailAccessOf(box, { userId: "u-ana", talks: true, managesAgent: false })).toEqual({
    gives: true,
    removes: true,
  });
  // Theirs, but the agent doesn't answer them: nothing to give it.
  expect(mailAccessOf(box, { userId: "u-ana", talks: false, managesAgent: false }).gives).toBe(false);
  // An admin (or the agent's owner) on someone else's mailbox: read-only, with a way to remove it.
  expect(mailAccessOf(box, { userId: "u-admin", talks: true, managesAgent: true })).toEqual({
    gives: false,
    removes: true,
  });
  expect(mailAccessOf(box, { userId: "u-bia", talks: true, managesAgent: false })).toEqual({
    gives: false,
    removes: false,
  });
  expect(mailAccessOf({ ownerUserId: null }, { userId: null, talks: true, managesAgent: true }).gives).toBe(false);
});

test("the owner-only refusal names who connected the mailbox, or says so without a blank name", () => {
  const t = ((key: string, o?: Record<string, unknown>) => `${key} ${JSON.stringify(o)}`) as unknown as TFunction;
  const refusal = (ownerName: string) =>
    new ApiError(403, "mail.owner_only", "Only", { address: "x@y.com", ownerUserId: "", ownerName });
  expect(knownErrorText(t, refusal("Ana"))).toStartWith("errors.mail.ownerOnly {");
  expect(knownErrorText(t, refusal(""))).toBe(
    'errors.mail.ownerOnlyUnknown {"address":"x@y.com","ownerUserId":"","ownerName":""}',
  );
});
