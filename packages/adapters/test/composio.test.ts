import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  ComposioActionError,
  ComposioSignatureError,
  createComposioClient,
  createComposioMailConnector,
  FileTooLargeError,
  gmailMessage,
  gmailQueryFromFilter,
  gmailSearchQuery,
  type MailAccountRef,
  MailAuthError,
  MailError,
} from "../src";
import { htmlToText, parseAddressList } from "../src/composio-mail";

const BASE = "https://backend.composio.dev/api/v3.1";

type Call = { method: string; url: string; body: Record<string, unknown> | null; headers: Headers };
type Handler = (call: Call) => Response | undefined;

/** A fetch that records calls and answers from the first handler that replies. */
function fakeFetch(...handlers: Handler[]) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    for (const handler of handlers) {
      const res = handler(call);
      if (res) return res;
    }
    return Response.json({ error: { message: "no handler", status: 404 } }, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

/**
 * Answers `POST /tools/execute/<slug>` with `{ data, successful: true }`, or with Composio's 400
 * when the call names a connected account without its user id.
 */
const tool =
  (slug: string, data: unknown | ((call: Call) => unknown)): Handler =>
  (call) => {
    if (call.url !== `${BASE}/tools/execute/${slug}`) return undefined;
    if (call.body?.connected_account_id && !call.body.user_id) {
      return Response.json(
        {
          error: {
            message:
              "User ID is required with connected account. Please provide a user ID to identify the connected account.",
            slug: "ActionExecute_ConnectedAccountEntityIdRequired",
            status: 400,
          },
        },
        { status: 400 },
      );
    }
    return Response.json({
      data: typeof data === "function" ? (data as (c: Call) => unknown)(call) : data,
      error: null,
      successful: true,
      log_id: "log_1",
    });
  };

const toolArgs = (calls: Call[], slug: string) =>
  calls
    .filter((c) => c.url === `${BASE}/tools/execute/${slug}`)
    .map((c) => c.body?.arguments as Record<string, unknown>);

const gmailAccount: MailAccountRef = {
  id: "acc1",
  orgId: "org1",
  provider: "gmail",
  via: "composio",
  address: "ana@acme.com",
  externalAccountId: "ca_gmail",
  externalUserId: "org_org1",
};
const outlookAccount: MailAccountRef = { ...gmailAccount, provider: "outlook", externalAccountId: "ca_outlook" };

const b64url = (text: string) => Buffer.from(text).toString("base64url");

/** A Gmail message as GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID returns it (format=full). */
const gmailFull = {
  messageId: "18f1a2b3c4d5e6f7",
  threadId: "18f1a2b3c4d5e6f0",
  labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
  messageTimestamp: "2026-10-17T12:30:00Z",
  internalDate: "1792240200000",
  sender: "Bia Souza <BIA@Cliente.com.br>",
  subject: "Proposta",
  messageText: "ignored when the payload has a body",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "Bia Souza <BIA@Cliente.com.br>" },
      { name: "To", value: '"Silva, Ana" <Ana@Acme.com>, ops@acme.com' },
      { name: "Cc", value: "Carlos <CARLOS@acme.com>" },
      { name: "Reply-To", value: "vendas@cliente.com.br" },
      { name: "Subject", value: "Proposta" },
      { name: "Message-ID", value: "<abc@mail.cliente.com.br>" },
      { name: "References", value: "<r1@x> <r2@x>" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          {
            mimeType: "text/html",
            body: {
              data: b64url(
                '<html><head><style>p{}</style></head><body><p>Ol&aacute;, Ana!</p><p>Veja o <a href="https://cliente.com.br/p">or&ccedil;amento</a> &amp; responda.</p><ul><li>Item 1</li><li>Item 2</li></ul></body></html>',
              ),
            },
          },
        ],
      },
      {
        mimeType: "application/pdf",
        filename: "proposta.pdf",
        body: { attachmentId: "ANGjdJ8-att1", size: 2048 },
      },
    ],
  },
};

test("a Gmail message says where it was delivered (every Delivered-To and X-Original-To)", () => {
  const headers = [
    ...gmailFull.payload.headers,
    { name: "Delivered-To", value: "Suporte@Acme.com" },
    { name: "Delivered-To", value: "ana@acme.com" },
    { name: "X-Original-To", value: "suporte@acme.com" },
  ];
  const message = gmailMessage({ ...gmailFull, payload: { ...gmailFull.payload, headers } });
  expect(message.deliveredTo).toEqual(["suporte@acme.com", "ana@acme.com"]);
  expect(gmailMessage(gmailFull).deliveredTo).toBeUndefined();
});

describe("gmail queries", () => {
  test("gmailQueryFromFilter: senders, subject and text; quotes dropped; null when empty", () => {
    expect(gmailQueryFromFilter({ from: ["A@x.com", "@b.com"], subject: 'Fatura "maio"', text: "pagar" })).toBe(
      'from:(a@x.com OR @b.com) subject:"Fatura maio" "pagar"',
    );
    expect(gmailQueryFromFilter({ from: ["ana@x.com"] })).toBe("from:ana@x.com");
    expect(gmailQueryFromFilter({})).toBeNull();
    expect(gmailQueryFromFilter({ from: ["  "], subject: '"' })).toBeNull();
  });

  test("MailQuery → Gmail search with exact epoch dates and unread", () => {
    expect(
      gmailSearchQuery({
        from: "@cliente.com.br",
        to: "ana@acme.com",
        subject: "proposta",
        text: "valor final",
        since: "2026-10-01T00:00:00Z",
        before: "2026-10-10T00:00:00Z",
        unreadOnly: true,
      }),
    ).toBe(
      'from:@cliente.com.br to:ana@acme.com subject:"proposta" "valor final" after:1790812799 before:1791590400 is:unread',
    );
    expect(gmailSearchQuery({})).toBe("");
  });
});

describe("Composio client", () => {
  test("connect link: finds the managed auth config once (cached) and asks for a link with the callback", async () => {
    const { fetch, calls } = fakeFetch(
      (c) =>
        c.method === "GET" && c.url.startsWith(`${BASE}/auth_configs?`)
          ? Response.json({
              items: [
                { id: "ac_custom", toolkit: { slug: "gmail" }, is_composio_managed: false, status: "ENABLED" },
                { id: "ac_gmail", toolkit: { slug: "gmail" }, is_composio_managed: true, status: "ENABLED" },
              ],
              total_pages: 1,
              current_page: 1,
              total_items: 2,
            })
          : undefined,
      (c) =>
        c.url === `${BASE}/connected_accounts/link`
          ? Response.json(
              {
                link_token: "lt_1",
                redirect_url: "https://connect.composio.dev/link/lt_1",
                expires_at: "2026-10-18T13:00:00Z",
                connected_account_id: "ca_new",
              },
              { status: 201 },
            )
          : undefined,
    );
    const client = createComposioClient({ apiKey: "ck_secret", fetch });
    const input = { toolkit: "gmail" as const, userId: "org_1", callbackUrl: "https://agentes.chat/api/mail/callback" };
    expect(await client.createConnectLink(input)).toEqual({
      connectedAccountId: "ca_new",
      redirectUrl: "https://connect.composio.dev/link/lt_1",
    });
    await client.createConnectLink(input);
    const lists = calls.filter((c) => c.url.startsWith(`${BASE}/auth_configs`));
    expect(lists).toHaveLength(1);
    expect(lists[0]?.url).toContain("toolkit_slug=gmail");
    expect(lists[0]?.url).toContain("is_composio_managed=true");
    const link = calls.find((c) => c.url.endsWith("/connected_accounts/link"));
    expect(link?.method).toBe("POST");
    expect(link?.headers.get("x-api-key")).toBe("ck_secret");
    expect(link?.body).toEqual({
      auth_config_id: "ac_gmail",
      user_id: "org_1",
      callback_url: "https://agentes.chat/api/mail/callback",
    });
  });

  test("auth config: created with Composio-managed auth when none exists; a configured id skips the lookup", async () => {
    const { fetch, calls } = fakeFetch(
      (c) => (c.method === "GET" && c.url.includes("/auth_configs?") ? Response.json({ items: [] }) : undefined),
      (c) =>
        c.method === "POST" && c.url === `${BASE}/auth_configs`
          ? Response.json(
              {
                toolkit: { slug: "outlook" },
                auth_config: { id: "ac_out", auth_scheme: "OAUTH2", is_composio_managed: true },
              },
              { status: 201 },
            )
          : undefined,
      (c) =>
        c.url.endsWith("/connected_accounts/link")
          ? Response.json({ redirect_url: "https://x/l", connected_account_id: "ca_1" }, { status: 201 })
          : undefined,
    );
    const client = createComposioClient({ apiKey: "k", fetch, gmailAuthConfigId: "ac_given" });
    await client.createConnectLink({ toolkit: "outlook", userId: "u", callbackUrl: "https://cb" });
    expect(calls.find((c) => c.method === "POST" && c.url === `${BASE}/auth_configs`)?.body).toEqual({
      toolkit: { slug: "outlook" },
      auth_config: { type: "use_composio_managed_auth" },
    });
    await client.createConnectLink({ toolkit: "gmail", userId: "u", callbackUrl: "https://cb" });
    expect(calls.filter((c) => c.url.includes("/auth_configs")).length).toBe(2);
    expect(calls.at(-1)?.body?.auth_config_id).toBe("ac_given");
  });

  test("getConnectedAccount: status mapping, address from the mailbox profile, 404 = failed", async () => {
    const accounts: Record<string, unknown> = {
      ca_gmail: { id: "ca_gmail", status: "ACTIVE", toolkit: { slug: "gmail" }, is_disabled: false },
      ca_outlook: {
        id: "ca_outlook",
        status: "ACTIVE",
        toolkit: { slug: "outlook" },
        is_disabled: false,
        state: { val: { displayName: " Ana Lima ", access_token: "never read" } },
      },
      ca_pending: { id: "ca_pending", status: "INITIATED", toolkit: { slug: "gmail" } },
      ca_expired: { id: "ca_expired", status: "EXPIRED", toolkit: { slug: "gmail" } },
      ca_failed: { id: "ca_failed", status: "FAILED", toolkit: { slug: "gmail" } },
    };
    const { fetch, calls } = fakeFetch(
      (c) => {
        const match = /\/connected_accounts\/([^/?]+)$/.exec(c.url);
        if (c.method !== "GET" || !match?.[1]) return undefined;
        const account = accounts[match[1]];
        return account
          ? Response.json(account)
          : Response.json({ error: { message: "Connected account not found" } }, { status: 404 });
      },
      tool("GMAIL_GET_PROFILE", { response_data: { emailAddress: "Ana@Acme.com", messagesTotal: 10 } }),
      tool("OUTLOOK_GET_PROFILE", { mail: "Ana@Contoso.com", userPrincipalName: "ana@contoso.onmicrosoft.com" }),
    );
    const client = createComposioClient({ apiKey: "k", fetch });
    // The status alone runs no tool.
    expect(await client.getConnectedAccount("ca_gmail", "org_1", { readAddress: false })).toEqual({
      status: "active",
      address: null,
      displayName: null,
    });
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/connected_accounts/ca_gmail`]);
    const state = (id: string) => client.getConnectedAccount(id, "org_1");
    expect(await state("ca_gmail")).toEqual({ status: "active", address: "ana@acme.com", displayName: null });
    expect(await state("ca_outlook")).toEqual({
      status: "active",
      address: "ana@contoso.com",
      displayName: "Ana Lima",
    });
    expect(await state("ca_pending")).toEqual({ status: "pending", address: null });
    expect(await state("ca_expired")).toEqual({ status: "expired", address: null });
    expect(await state("ca_failed")).toEqual({ status: "failed", address: null });
    expect(await state("ca_gone")).toEqual({ status: "failed", address: null });
    const profile = calls.find((c) => c.url.endsWith("/tools/execute/GMAIL_GET_PROFILE"));
    expect(profile?.body).toEqual({ connected_account_id: "ca_gmail", user_id: "org_1", arguments: { user_id: "me" } });
  });

  test("triggers: Gmail query pushed to the source (inbox by default), Outlook unfiltered; deletes tolerate 404", async () => {
    const { fetch, calls } = fakeFetch(
      (c) =>
        c.url.includes("/trigger_instances/") && c.url.endsWith("/upsert")
          ? Response.json({ trigger_id: "ti_1" }, { status: 201 })
          : undefined,
      (c) => (c.method === "DELETE" ? Response.json({ error: { message: "not found" } }, { status: 404 }) : undefined),
    );
    const client = createComposioClient({ apiKey: "k", fetch });
    const gmail = { toolkit: "gmail" as const, connectedAccountId: "ca_g", userId: "org_1" };
    await client.createMailTrigger({ ...gmail, query: "from:(a@x.com OR @b.com)" });
    await client.createMailTrigger({ ...gmail, query: null });
    await client.createMailTrigger({ ...gmail, query: "label:clientes" });
    const outlook = { toolkit: "outlook" as const, connectedAccountId: "ca_o", userId: "org_1" };
    expect(await client.createMailTrigger({ ...outlook, query: "x" })).toEqual({
      triggerId: "ti_1",
    });
    const upserts = calls.filter((c) => c.url.endsWith("/upsert"));
    expect(upserts[0]?.url).toBe(`${BASE}/trigger_instances/GMAIL_NEW_GMAIL_MESSAGE/upsert`);
    expect(upserts.map((c) => c.body)).toEqual([
      {
        connected_account_id: "ca_g",
        user_id: "org_1",
        trigger_config: { query: "in:inbox from:(a@x.com OR @b.com)" },
      },
      { connected_account_id: "ca_g", user_id: "org_1", trigger_config: { labelIds: "INBOX" } },
      { connected_account_id: "ca_g", user_id: "org_1", trigger_config: { query: "label:clientes" } },
      { connected_account_id: "ca_o", user_id: "org_1", trigger_config: {} },
    ]);
    expect(upserts[3]?.url).toBe(`${BASE}/trigger_instances/OUTLOOK_MESSAGE_TRIGGER/upsert`);
    await client.deleteTrigger("ti_1");
    await client.deleteConnectedAccount("ca_g");
    await client.deleteConnectedAccount("ca_o", { revoke: false });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      `${BASE}/trigger_instances/manage/ti_1`,
      `${BASE}/connected_accounts/ca_g?revoke_on_delete=true`,
      `${BASE}/connected_accounts/ca_o?revoke_on_delete=false`,
    ]);
  });

  test("errors: broken connection → MailAuthError; 429/5xx retryable; bad project key and 4xx not; key never leaks", async () => {
    const reply = (status: number, body: unknown) =>
      createComposioClient({
        apiKey: "ck_super_secret",
        fetch: (async () => Response.json(body, { status })) as unknown as typeof fetch,
      });
    const run = (client: ReturnType<typeof createComposioClient>) =>
      client
        .executeTool("GMAIL_FETCH_EMAILS", { connectedAccountId: "ca_1", userId: "org_1", toolkit: "gmail" }, {})
        .catch((e: unknown) => e as Error);

    const expired = await run(
      reply(400, { error: { message: "Connected account is not active (status EXPIRED)", status: 400 } }),
    );
    expect(expired).toBeInstanceOf(MailAuthError);
    const toolAuth = await run(
      reply(200, { data: {}, successful: false, error: "Request had invalid authentication credentials (401)" }),
    );
    expect(toolAuth).toBeInstanceOf(MailAuthError);
    for (const [status, body, retryable] of [
      [429, { error: { message: "Too many requests" } }, true],
      [503, {}, true],
      [401, { error: { message: "Invalid API key" } }, false],
      [422, { error: { message: "Invalid arguments" } }, false],
      [200, { data: {}, successful: false, error: "Quota exceeded for quota metric" }, true],
      [200, { data: {}, successful: false, error: "Invalid id value" }, false],
    ] as const) {
      const error = await run(reply(status, body));
      expect(error).toBeInstanceOf(MailError);
      expect((error as MailError).retryable).toBe(retryable);
      expect(String((error as Error).message)).not.toContain("ck_super_secret");
      // Only an action that ran and failed is the service's own answer.
      expect(error instanceof ComposioActionError).toBe(status === 200);
    }
    const offline = createComposioClient({
      apiKey: "k",
      fetch: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    const error = await run(offline);
    expect(error).toBeInstanceOf(MailError);
    expect((error as MailError).retryable).toBe(true);
  });

  test("onExecute: each execution Composio answered, failed ones too, never one that didn't reach it", async () => {
    const seen: unknown[] = [];
    const answering = (status: number, body: unknown) =>
      (async () => Response.json(body, { status })) as unknown as typeof fetch;
    const offline = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const client = (fetch: typeof globalThis.fetch, onExecute = (e: unknown) => void seen.push(e)) =>
      createComposioClient({ apiKey: "k", fetch, onExecute });
    const account = { connectedAccountId: "ca_1", userId: "org_1", toolkit: "gmail" };
    const ok = { data: { n: 1 }, successful: true };
    const failed = { data: {}, successful: false, error: "Invalid id value" };

    expect(await client(answering(200, ok)).executeTool("GMAIL_FETCH_EMAILS", account, {})).toEqual({ n: 1 });
    await client(answering(200, failed))
      .executeTool("GMAIL_FETCH_EMAILS", account, {})
      .catch(() => {});
    await client(answering(503, {}))
      .executeTool("ONE_DRIVE_GET_ITEM", { ...account, toolkit: "one_drive" }, {})
      .catch(() => {});
    await client(offline)
      .executeTool("GMAIL_FETCH_EMAILS", account, {})
      .catch(() => {});
    expect(seen).toEqual([
      { userId: "org_1", toolkit: "gmail", slug: "GMAIL_FETCH_EMAILS", ok: true },
      { userId: "org_1", toolkit: "gmail", slug: "GMAIL_FETCH_EMAILS", ok: false },
      // The account's toolkit: the slug's first word isn't it.
      { userId: "org_1", toolkit: "one_drive", slug: "ONE_DRIVE_GET_ITEM", ok: false },
    ]);

    // A hook that throws changes nothing.
    const throwing = () => {
      throw new Error("hook");
    };
    expect(await client(answering(200, ok), throwing).executeTool("GMAIL_FETCH_EMAILS", account, {})).toEqual({
      n: 1,
    });
    const refused = await client(answering(200, failed), throwing)
      .executeTool("GMAIL_FETCH_EMAILS", account, {})
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(MailError);
    expect(String(refused)).toContain("Invalid id value");
  });

  test("an answer reaches us without the service's credentials, its page cursors kept", async () => {
    const pages = {
      data: [{ id: "101", name: "Acme Store", access_token: "fake-page-token", tasks: ["CREATE_CONTENT"] }],
      paging: { cursors: { after: "QVFIUz" } },
      page_access_token: "fake-token",
      refreshToken: "fake-refresh",
      nextPageToken: "CAUQAA",
    };
    const { fetch } = fakeFetch(tool("FACEBOOK_LIST_MANAGED_PAGES", pages));
    const account = { connectedAccountId: "ca_1", userId: "org_1", toolkit: "facebook" };
    expect(
      await createComposioClient({ apiKey: "k", fetch }).executeTool("FACEBOOK_LIST_MANAGED_PAGES", account, {}),
    ).toEqual({
      data: [{ id: "101", name: "Acme Store", tasks: ["CREATE_CONTENT"] }],
      paging: { cursors: { after: "QVFIUz" } },
      nextPageToken: "CAUQAA",
    });
  });

  test("fetchFile never follows a redirect: the link's own address answers, or nothing does", async () => {
    const asked: (RequestInit | undefined)[] = [];
    const client = createComposioClient({
      apiKey: "k",
      fetch: (async (_url: string, init?: RequestInit) => {
        asked.push(init);
        // The link redirects into our own network: following it would answer this.
        if (init?.redirect !== "error") return new Response("internal secret");
        throw new TypeError("unexpected redirect");
      }) as unknown as typeof fetch,
    });
    await expect(client.fetchFile("https://files.example/r1")).rejects.toBeInstanceOf(MailError);
    expect(asked.map((init) => init?.redirect)).toEqual(["error"]);
  });

  test("fetchFile reads no further than the cap: by the length it declares, else by what arrives", async () => {
    const chunks = (n: number) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(4));
          c.close();
        },
      });
    const bodies: Record<string, () => Response> = {
      "https://files.example/small": () => new Response(chunks(2)),
      "https://files.example/declared": () => new Response("12345678901", { headers: { "content-length": "11" } }),
      "https://files.example/streamed": () => new Response(chunks(4)),
    };
    const client = createComposioClient({
      apiKey: "k",
      fetch: (async (url: string) => bodies[url]?.() ?? new Response(null, { status: 404 })) as unknown as typeof fetch,
    });
    expect(await client.fetchFile("https://files.example/small", 10)).toEqual(new Uint8Array(8));
    for (const url of ["https://files.example/declared", "https://files.example/streamed"]) {
      await expect(client.fetchFile(url, 10)).rejects.toBeInstanceOf(FileTooLargeError);
    }
  });
});

describe("Composio webhooks", () => {
  const secret = "whsec_test_secret";
  const now = 1_792_240_200_000;
  const sign = (body: string, options: { id?: string; ts?: number; key?: string } = {}) => {
    const id = options.id ?? "msg_1";
    const ts = String(options.ts ?? now / 1000);
    const signature = createHmac("sha256", options.key ?? secret)
      .update(`${id}.${ts}.${body}`)
      .digest("base64");
    return new Headers({ "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${signature}` });
  };
  const client = createComposioClient({ apiKey: "k", webhookSecret: secret, now: () => now });

  test("signature: valid passes; wrong secret, old timestamp, missing headers or secret are refused", () => {
    const body = JSON.stringify({ id: "msg_1", type: "composio.something.else", data: {} });
    expect(client.verifyWebhook(sign(body), body)).toEqual({ type: "other" });
    expect(() => client.verifyWebhook(sign(body, { key: "other" }), body)).toThrow(ComposioSignatureError);
    expect(() => client.verifyWebhook(sign(body, { ts: now / 1000 - 301 }), body)).toThrow(ComposioSignatureError);
    expect(() => client.verifyWebhook(sign(body), `${body} `)).toThrow(ComposioSignatureError);
    expect(() => client.verifyWebhook(new Headers(), body)).toThrow(ComposioSignatureError);
    const noSecret = createComposioClient({ apiKey: "k", now: () => now });
    expect(() => noSecret.verifyWebhook(sign(body), body)).toThrow(ComposioSignatureError);
    // Several signatures (rotation): any v1 match passes.
    const headers = sign(body);
    headers.set("webhook-signature", `v1,AAAA ${headers.get("webhook-signature")}`);
    expect(client.verifyWebhook(headers, body)).toEqual({ type: "other" });
  });

  test("new Gmail message → mail.received with a normalised summary", () => {
    const body = JSON.stringify({
      id: "msg_2",
      type: "composio.trigger.message",
      timestamp: "2026-10-17T12:31:00Z",
      metadata: {
        log_id: "log_1",
        trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
        trigger_id: "ti_g",
        connected_account_id: "ca_gmail",
        auth_config_id: "ac_1",
        user_id: "org_1",
      },
      data: {
        id: "18f1a2b3c4d5e6f7",
        message_id: "18f1a2b3c4d5e6f7",
        thread_id: "18f1a2b3c4d5e6f0",
        sender: "Bia <BIA@Cliente.com.br>",
        to: "Ana@Acme.com, ops@acme.com",
        subject: "Proposta",
        message_text: `<div>${"Texto longo. ".repeat(40)}</div>`,
        message_timestamp: "2026-10-17T12:30:00Z",
        label_ids: ["INBOX", "UNREAD"],
        attachment_list: [{ attachmentId: "att1", filename: "a.pdf", mimeType: "application/pdf" }],
      },
    });
    const event = client.verifyWebhook(sign(body, { id: "msg_2" }), body);
    expect(event.type).toBe("mail.received");
    if (event.type !== "mail.received") return;
    expect(event.triggerId).toBe("ti_g");
    expect(event.connectedAccountId).toBe("ca_gmail");
    const { snippet, ...rest } = event.message;
    expect(rest).toEqual({
      id: "18f1a2b3c4d5e6f7",
      threadId: "18f1a2b3c4d5e6f0",
      folder: "INBOX",
      from: { name: "Bia", address: "bia@cliente.com.br" },
      to: [{ address: "ana@acme.com" }, { address: "ops@acme.com" }],
      cc: [],
      subject: "Proposta",
      date: "2026-10-17T12:30:00.000Z",
      unread: true,
      flagged: false,
      hasAttachments: true,
    });
    expect(snippet.length).toBeLessThanOrEqual(200);
    expect(snippet.startsWith("Texto longo. Texto longo.")).toBe(true);
    expect(snippet).not.toContain("<div>");
  });

  test("new Outlook message → mail.received from outlook_message", () => {
    const body = JSON.stringify({
      id: "msg_3",
      type: "composio.trigger.message",
      metadata: { trigger_slug: "OUTLOOK_MESSAGE_TRIGGER", trigger_id: "ti_o", connected_account_id: "ca_outlook" },
      data: {
        event_type: "created",
        id: "AAMkAGI2TAAA=",
        outlook_message: {
          subject: "Reunião",
          from: { emailAddress: { name: "Carlos", address: "Carlos@Contoso.com" } },
          toRecipients: [{ emailAddress: { name: "Ana", address: "ANA@contoso.com" } }],
          ccRecipients: [],
          receivedDateTime: "2026-10-17T09:00:00Z",
          bodyPreview: "Podemos mover para amanhã?",
          isRead: false,
          hasAttachments: false,
          conversationId: "conv1",
        },
      },
    });
    expect(client.verifyWebhook(sign(body), body)).toEqual({
      type: "mail.received",
      triggerId: "ti_o",
      connectedAccountId: "ca_outlook",
      message: {
        id: "AAMkAGI2TAAA=",
        threadId: "conv1",
        folder: undefined,
        from: { name: "Carlos", address: "carlos@contoso.com" },
        to: [{ name: "Ana", address: "ana@contoso.com" }],
        cc: [],
        subject: "Reunião",
        date: "2026-10-17T09:00:00.000Z",
        snippet: "Podemos mover para amanhã?",
        unread: true,
        flagged: false,
        hasAttachments: false,
      },
    });
  });

  test("expired account, disabled trigger and other triggers", () => {
    const expired = JSON.stringify({
      id: "msg_4",
      type: "composio.connected_account.expired",
      metadata: { project_id: "pr_1" },
      data: { id: "ca_gmail", toolkit: { slug: "gmail" }, status: "EXPIRED" },
    });
    expect(client.verifyWebhook(sign(expired), expired)).toEqual({
      type: "account.expired",
      connectedAccountId: "ca_gmail",
    });
    const disabled = JSON.stringify({
      id: "msg_5",
      type: "composio.trigger.disabled",
      metadata: { project_id: "pr_1" },
      data: { id: "ti_g", connected_account_id: "ca_gmail", trigger_name: "GMAIL_NEW_GMAIL_MESSAGE" },
    });
    expect(client.verifyWebhook(sign(disabled), disabled)).toEqual({ type: "trigger.disabled", triggerId: "ti_g" });
    const github = JSON.stringify({
      id: "msg_6",
      type: "composio.trigger.message",
      metadata: { trigger_slug: "GITHUB_COMMIT_EVENT", trigger_id: "ti_x", connected_account_id: "ca_x" },
      data: { commit_sha: "a1b2" },
    });
    expect(client.verifyWebhook(sign(github), github)).toEqual({ type: "other" });
  });
});

describe("Composio mail connector: Gmail", () => {
  const setup = (...handlers: Handler[]) => {
    const fake = fakeFetch(
      ...handlers,
      tool("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", gmailFull),
      tool("GMAIL_ADD_LABEL_TO_EMAIL", {}),
      tool("GMAIL_MOVE_TO_TRASH", {}),
    );
    const client = createComposioClient({ apiKey: "k", fetch: fake.fetch });
    return { ...fake, connector: createComposioMailConnector(client) };
  };

  test("open refuses accounts that aren't Composio Gmail/Outlook", async () => {
    const { connector } = setup();
    await expect(connector.open({ ...gmailAccount, via: "imap" })).rejects.toBeInstanceOf(MailError);
    await expect(connector.open({ ...gmailAccount, provider: "imap" })).rejects.toBeInstanceOf(MailError);
    await expect(connector.open({ ...gmailAccount, externalUserId: null })).rejects.toBeInstanceOf(MailError);
  });

  test("read: HTML → text with links, lowercase addresses, threading headers, attachments", async () => {
    const { connector, calls } = setup();
    const mailbox = await connector.open(gmailAccount);
    const message = await mailbox.read("18f1a2b3c4d5e6f7");
    expect(toolArgs(calls, "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID")[0]).toEqual({
      user_id: "me",
      message_id: "18f1a2b3c4d5e6f7",
      format: "full",
    });
    expect(calls[0]?.body).toMatchObject({ connected_account_id: "ca_gmail", user_id: "org_org1" });
    expect(message.text).toBe(
      "Olá, Ana!\n\nVeja o orçamento (https://cliente.com.br/p) & responda.\n\n- Item 1\n- Item 2",
    );
    expect(message.from).toEqual({ name: "Bia Souza", address: "bia@cliente.com.br" });
    expect(message.to).toEqual([{ name: "Silva, Ana", address: "ana@acme.com" }, { address: "ops@acme.com" }]);
    expect(message.cc).toEqual([{ name: "Carlos", address: "carlos@acme.com" }]);
    expect(message.replyTo).toEqual([{ address: "vendas@cliente.com.br" }]);
    expect(message.messageIdHeader).toBe("<abc@mail.cliente.com.br>");
    expect(message.references).toEqual(["<r1@x>", "<r2@x>"]);
    expect(message.date).toBe(new Date(1792240200000).toISOString());
    expect(message.unread).toBe(true);
    expect(message.folder).toBe("INBOX");
    expect(message.attachments).toEqual([
      { id: "0:ANGjdJ8-att1", filename: "proposta.pdf", contentType: "application/pdf", size: 2048 },
    ]);
  });

  test("search: query and label, limit capped at 50, newest first", async () => {
    const { connector, calls } = setup(
      tool("GMAIL_FETCH_EMAILS", {
        messages: [
          {
            messageId: "m1",
            threadId: "t1",
            labelIds: ["INBOX"],
            messageTimestamp: "2026-10-01T10:00:00Z",
            sender: "a@x.com",
            subject: "old",
            preview: { body: "old one" },
          },
          {
            messageId: "m2",
            threadId: "t2",
            labelIds: ["INBOX", "UNREAD"],
            messageTimestamp: "2026-10-02T10:00:00Z",
            sender: "b@x.com",
            subject: "new",
            preview: { body: "new one" },
          },
        ],
        nextPageToken: null,
      }),
    );
    const mailbox = await connector.open(gmailAccount);
    const results = await mailbox.search({ from: "@x.com", unreadOnly: true, limit: 500 });
    expect(results.map((m) => m.id)).toEqual(["m2", "m1"]);
    expect(results[0]?.snippet).toBe("new one");
    expect(toolArgs(calls, "GMAIL_FETCH_EMAILS")[0]).toEqual({
      user_id: "me",
      query: "from:@x.com is:unread",
      label_ids: ["INBOX"],
      include_spam_trash: false,
      max_results: 50,
      include_payload: true,
      verbose: false,
    });
    await mailbox.search({ folder: "ALL" });
    expect(toolArgs(calls, "GMAIL_FETCH_EMAILS")[1]?.max_results).toBe(20);
    expect(toolArgs(calls, "GMAIL_FETCH_EMAILS")[1]?.label_ids).toBeUndefined();
  });

  test("folders: system labels with roles, user labels, All Mail", async () => {
    const { connector } = setup(
      tool("GMAIL_LIST_LABELS", {
        labels: [
          { id: "INBOX", name: "INBOX", type: "system" },
          { id: "SENT", name: "SENT", type: "system" },
          { id: "UNREAD", name: "UNREAD", type: "system" },
          { id: "CATEGORY_SOCIAL", name: "CATEGORY_SOCIAL", type: "system" },
          { id: "Label_12", name: "Clientes", type: "user" },
        ],
      }),
    );
    const mailbox = await connector.open(gmailAccount);
    expect(await mailbox.listFolders()).toEqual([
      { id: "INBOX", name: "Inbox", role: "inbox" },
      { id: "SENT", name: "Sent", role: "sent" },
      { id: "Label_12", name: "Clientes" },
      { id: "ALL", name: "All Mail", role: "all" },
    ]);
  });

  test("send, reply in thread and forward map to the right tools with exactly our recipients", async () => {
    const { connector, calls } = setup(
      tool("GMAIL_SEND_EMAIL", { id: "sent1", threadId: "t9" }),
      tool("GMAIL_REPLY_TO_THREAD", { response_data: { id: "sent2" } }),
      tool("GMAIL_FORWARD_MESSAGE", { id: "sent3" }),
    );
    const mailbox = await connector.open(gmailAccount);
    const base = {
      to: ["bia@cliente.com.br", "ops@cliente.com.br"],
      cc: ["carlos@acme.com"],
      bcc: [],
      subject: "Re: Proposta",
      text: "Fechado.",
    };
    expect(await mailbox.send({ ...base, from: "vendas@acme.com" })).toEqual({ id: "sent1" });
    expect(toolArgs(calls, "GMAIL_SEND_EMAIL")[0]).toEqual({
      user_id: "me",
      recipient_email: "bia@cliente.com.br",
      extra_recipients: ["ops@cliente.com.br"],
      cc: ["carlos@acme.com"],
      subject: "Re: Proposta",
      body: "Fechado.",
      is_html: false,
      include_signature: false,
      from_email: "vendas@acme.com",
    });
    expect(await mailbox.send({ ...base, inReplyTo: "18f1a2b3c4d5e6f7" })).toEqual({ id: "sent2" });
    expect(toolArgs(calls, "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID").at(-1)?.format).toBe("metadata");
    expect(toolArgs(calls, "GMAIL_REPLY_TO_THREAD")[0]).toEqual({
      user_id: "me",
      thread_id: "18f1a2b3c4d5e6f0",
      recipient_email: "bia@cliente.com.br",
      extra_recipients: ["ops@cliente.com.br"],
      cc: ["carlos@acme.com"],
      message_body: "Fechado.",
      is_html: false,
      include_signature: false,
    });
    expect(await mailbox.send({ ...base, to: ["socio@acme.com"], forwardOf: "18f1a2b3c4d5e6f7" })).toEqual({
      id: "sent3",
    });
    expect(toolArgs(calls, "GMAIL_FORWARD_MESSAGE")[0]).toEqual({
      user_id: "me",
      message_id: "18f1a2b3c4d5e6f7",
      recipients: ["socio@acme.com"],
      cc: ["carlos@acme.com"],
      additional_text: "Fechado.",
      include_signature: false,
    });
  });

  test("drafts: reply draft stays in the thread; forward draft quotes the original", async () => {
    const { connector, calls } = setup(tool("GMAIL_CREATE_EMAIL_DRAFT", { id: "r-123", message: { id: "m" } }));
    const mailbox = await connector.open(gmailAccount);
    const base = { to: ["bia@cliente.com.br"], cc: [], bcc: [], subject: "Re: Proposta", text: "Rascunho." };
    expect(await mailbox.createDraft({ ...base, inReplyTo: "18f1a2b3c4d5e6f7" })).toEqual({ id: "r-123" });
    expect(toolArgs(calls, "GMAIL_CREATE_EMAIL_DRAFT")[0]).toEqual({
      user_id: "me",
      recipient_email: "bia@cliente.com.br",
      subject: "",
      body: "Rascunho.",
      is_html: false,
      include_signature: false,
      thread_id: "18f1a2b3c4d5e6f0",
    });
    await mailbox.createDraft({ ...base, subject: "Fwd: Proposta", forwardOf: "18f1a2b3c4d5e6f7" });
    const forward = toolArgs(calls, "GMAIL_CREATE_EMAIL_DRAFT")[1];
    expect(forward?.subject).toBe("Fwd: Proposta");
    expect(forward?.thread_id).toBeUndefined();
    expect(String(forward?.body)).toStartWith(
      "Rascunho.\n\n---------- Forwarded message ---------\nFrom: Bia Souza <bia@cliente.com.br>",
    );
    expect(String(forward?.body)).toContain("Veja o orçamento (https://cliente.com.br/p)");
  });

  test("organise: move, read/flag, archive, trash", async () => {
    const { connector, calls } = setup();
    const mailbox = await connector.open(gmailAccount);
    await mailbox.move("m1", "Label_12");
    await mailbox.move("m1", "INBOX");
    await mailbox.setFlags("m1", { read: true, flagged: true });
    await mailbox.setFlags("m1", {});
    await mailbox.archive("m1");
    await mailbox.trash("m1");
    await mailbox.move("m1", "TRASH");
    expect(toolArgs(calls, "GMAIL_ADD_LABEL_TO_EMAIL")).toEqual([
      { user_id: "me", message_id: "m1", add_label_ids: ["Label_12"], remove_label_ids: ["INBOX"] },
      { user_id: "me", message_id: "m1", add_label_ids: ["INBOX"], remove_label_ids: ["SPAM", "TRASH"] },
      { user_id: "me", message_id: "m1", add_label_ids: ["STARRED"], remove_label_ids: ["UNREAD"] },
      { user_id: "me", message_id: "m1", remove_label_ids: ["INBOX"] },
    ]);
    expect(toolArgs(calls, "GMAIL_MOVE_TO_TRASH")).toHaveLength(2);
    await mailbox.close();
  });

  test("attachment: re-reads the message for its name, downloads inline base64 or a file URL", async () => {
    const pdf = new Uint8Array([37, 80, 68, 70]);
    const { connector, calls } = setup(
      tool("GMAIL_GET_ATTACHMENT", (call: Call) =>
        (call.body?.arguments as Record<string, unknown> | undefined)?.attachment_id === "ANGjdJ8-att1"
          ? { file: { name: "proposta.pdf", mimetype: "application/pdf", s3url: "https://files.composio.dev/abc" } }
          : { data: Buffer.from(pdf).toString("base64url"), size: 4 },
      ),
      (c) => (c.url === "https://files.composio.dev/abc" ? new Response(pdf) : undefined),
    );
    const mailbox = await connector.open(gmailAccount);
    const file = await mailbox.attachment("18f1a2b3c4d5e6f7", "0:ANGjdJ8-att1");
    expect(file).toEqual({ filename: "proposta.pdf", contentType: "application/pdf", data: pdf });
    expect(toolArgs(calls, "GMAIL_GET_ATTACHMENT")[0]).toEqual({
      user_id: "me",
      message_id: "18f1a2b3c4d5e6f7",
      attachment_id: "ANGjdJ8-att1",
      file_name: "proposta.pdf",
    });
    const download = calls.find((c) => c.url === "https://files.composio.dev/abc");
    expect(download?.headers.get("x-api-key")).toBeNull();
    expect((await mailbox.attachment("18f1a2b3c4d5e6f7", "unknown-id")).data).toEqual(pdf);
  });
});

describe("Composio mail connector: Outlook", () => {
  const graphMessage = {
    id: "AAMk1",
    conversationId: "conv1",
    parentFolderId: "inbox-id",
    subject: "Reunião",
    from: { emailAddress: { name: "Carlos", address: "Carlos@Contoso.com" } },
    toRecipients: [{ emailAddress: { name: "Ana", address: "Ana@Contoso.com" } }],
    ccRecipients: [{ emailAddress: { address: "Ops@Contoso.com" } }],
    replyTo: [],
    receivedDateTime: "2026-10-17T09:00:00Z",
    bodyPreview: "Podemos mover?",
    isRead: true,
    flag: { flagStatus: "flagged" },
    hasAttachments: true,
    internetMessageId: "<m1@contoso.com>",
    internetMessageHeaders: [{ name: "References", value: "<a@x> <b@x>" }],
    body: { contentType: "html", content: "<p>Podemos mover para&nbsp;amanh&atilde;?</p><p>Abs,<br>Carlos</p>" },
  };
  const setup = (...handlers: Handler[]) => {
    const fake = fakeFetch(
      ...handlers,
      tool("OUTLOOK_GET_MESSAGE", graphMessage),
      tool("OUTLOOK_LIST_OUTLOOK_ATTACHMENTS", {
        response_data: {
          value: [
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "att1",
              name: "pauta.docx",
              contentType: "application/msword",
              size: 10,
              isInline: false,
            },
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "img1",
              name: "logo.png",
              contentType: "image/png",
              size: 5,
              isInline: true,
            },
          ],
        },
      }),
      tool("OUTLOOK_UPDATE_EMAIL", {}),
      tool("OUTLOOK_MOVE_MESSAGE", { id: "moved" }),
      tool("OUTLOOK_SEND_DRAFT", {}),
    );
    const client = createComposioClient({ apiKey: "k", fetch: fake.fetch });
    return { ...fake, connector: createComposioMailConnector(client) };
  };

  test("read: Graph message to text, flags, threading, file attachments only", async () => {
    const { connector, calls } = setup();
    const mailbox = await connector.open(outlookAccount);
    const message = await mailbox.read("AAMk1");
    expect(calls[0]?.body).toMatchObject({ connected_account_id: "ca_outlook", user_id: "org_org1" });
    expect(message).toMatchObject({
      id: "AAMk1",
      threadId: "conv1",
      from: { name: "Carlos", address: "carlos@contoso.com" },
      to: [{ name: "Ana", address: "ana@contoso.com" }],
      cc: [{ address: "ops@contoso.com" }],
      unread: false,
      flagged: true,
      text: "Podemos mover para amanhã?\n\nAbs,\nCarlos",
      messageIdHeader: "<m1@contoso.com>",
      references: ["<a@x>", "<b@x>"],
      attachments: [{ id: "att1", filename: "pauta.docx", contentType: "application/msword", size: 10 }],
    });
  });

  test("search: OData filter when possible, $search for text/domains with local date and unread checks", async () => {
    const { connector, calls } = setup(
      tool("OUTLOOK_LIST_MESSAGES", {
        value: [
          { ...graphMessage, id: "old", receivedDateTime: "2026-09-01T00:00:00Z", isRead: false },
          { ...graphMessage, id: "new", receivedDateTime: "2026-10-17T00:00:00Z", isRead: false },
          { ...graphMessage, id: "read", receivedDateTime: "2026-10-16T00:00:00Z", isRead: true },
        ],
      }),
    );
    const mailbox = await connector.open(outlookAccount);
    await mailbox.search({
      from: "Carlos@Contoso.com",
      subject: "O'Brien",
      since: "2026-10-01T00:00:00Z",
      unreadOnly: true,
    });
    expect(toolArgs(calls, "OUTLOOK_LIST_MESSAGES")[0]).toMatchObject({
      user_id: "me",
      folder: "inbox",
      top: 20,
      filter:
        "receivedDateTime ge 2026-10-01T00:00:00.000Z and isRead eq false and from/emailAddress/address eq 'carlos@contoso.com' and contains(subject,'O''Brien')",
    });
    const results = await mailbox.search({
      folder: "archive",
      from: "@contoso.com",
      text: "pauta",
      since: "2026-10-01T00:00:00Z",
      unreadOnly: true,
    });
    const args = toolArgs(calls, "OUTLOOK_LIST_MESSAGES")[1];
    expect(args?.search).toBe('from:contoso.com AND "pauta" AND received>=2026-10-01');
    expect(args?.filter).toBeUndefined();
    expect(args?.folder).toBe("archive");
    expect(results.map((m) => m.id)).toEqual(["new"]);
  });

  test("folders: roles from well-known names (English and Portuguese)", async () => {
    const { connector } = setup(
      tool("OUTLOOK_LIST_MAIL_FOLDERS", {
        value: [
          { id: "f1", displayName: "Caixa de Entrada" },
          { id: "f2", displayName: "Sent Items" },
          { id: "f3", displayName: "Itens Excluídos" },
          { id: "f4", displayName: "Clientes" },
          { id: "f5", displayName: "Hidden", isHidden: true },
        ],
      }),
    );
    const mailbox = await connector.open(outlookAccount);
    expect(await mailbox.listFolders()).toEqual([
      { id: "f1", name: "Caixa de Entrada", role: "inbox" },
      { id: "f2", name: "Sent Items", role: "sent" },
      { id: "f3", name: "Itens Excluídos", role: "trash" },
      { id: "f4", name: "Clientes" },
    ]);
  });

  test("send new mail; reply and forward go through a draft with exactly our recipients", async () => {
    const { connector, calls } = setup(
      tool("OUTLOOK_SEND_EMAIL", {}),
      tool("OUTLOOK_CREATE_DRAFT_REPLY", { id: "draft-reply" }),
      tool("OUTLOOK_CREATE_ME_FORWARD_DRAFT", { response_data: { id: "draft-fwd" } }),
    );
    const mailbox = await connector.open(outlookAccount);
    const base = {
      to: ["carlos@contoso.com", "bia@x.com"],
      cc: [],
      bcc: ["arquivo@contoso.com"],
      subject: "RE: Reunião",
      text: "Pode ser.",
    };
    expect(await mailbox.send({ ...base, from: "time@contoso.com" })).toEqual({ id: null });
    expect(toolArgs(calls, "OUTLOOK_SEND_EMAIL")[0]).toEqual({
      user_id: "me",
      to: "carlos@contoso.com,bia@x.com",
      subject: "RE: Reunião",
      body: "Pode ser.",
      is_html: false,
      bcc_emails: ["arquivo@contoso.com"],
      from_address: "time@contoso.com",
      save_to_sent_items: true,
    });
    await mailbox.send({ ...base, inReplyTo: "AAMk1" });
    expect(toolArgs(calls, "OUTLOOK_CREATE_DRAFT_REPLY")[0]).toEqual({
      user_id: "me",
      message_id: "AAMk1",
      comment: "Pode ser.",
    });
    expect(toolArgs(calls, "OUTLOOK_UPDATE_EMAIL")[0]).toEqual({
      user_id: "me",
      message_id: "draft-reply",
      subject: "RE: Reunião",
      to_recipients: ["carlos@contoso.com", "bia@x.com"],
      cc_recipients: [],
      bcc_recipients: ["arquivo@contoso.com"],
    });
    expect(toolArgs(calls, "OUTLOOK_SEND_DRAFT")[0]).toEqual({ user_id: "me", message_id: "draft-reply" });
    expect(await mailbox.createDraft({ ...base, forwardOf: "AAMk1" })).toEqual({ id: "draft-fwd" });
    expect(toolArgs(calls, "OUTLOOK_CREATE_ME_FORWARD_DRAFT")[0]).toEqual({
      user_id: "me",
      message_id: "AAMk1",
      comment: "Pode ser.",
    });
    expect(toolArgs(calls, "OUTLOOK_SEND_DRAFT")).toHaveLength(1);
  });

  test("organise: move, flags, archive, trash", async () => {
    const { connector, calls } = setup();
    const mailbox = await connector.open(outlookAccount);
    await mailbox.move("AAMk1", "f4");
    await mailbox.archive("AAMk1");
    await mailbox.trash("AAMk1");
    await mailbox.setFlags("AAMk1", { read: false, flagged: false });
    expect(toolArgs(calls, "OUTLOOK_MOVE_MESSAGE").map((a) => a.destination_id)).toEqual([
      "f4",
      "archive",
      "deleteditems",
    ]);
    expect(toolArgs(calls, "OUTLOOK_UPDATE_EMAIL")[0]).toEqual({
      user_id: "me",
      message_id: "AAMk1",
      is_read: false,
      flag: { flagStatus: "notFlagged" },
    });
  });

  test("attachment: name from the attachment list, bytes from contentBytes", async () => {
    const { connector, calls } = setup(
      tool("OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT", { contentBytes: Buffer.from("doc").toString("base64") }),
    );
    const mailbox = await connector.open(outlookAccount);
    const file = await mailbox.attachment("AAMk1", "att1");
    expect(file.filename).toBe("pauta.docx");
    expect(file.contentType).toBe("application/msword");
    expect(new TextDecoder().decode(file.data)).toBe("doc");
    expect(toolArgs(calls, "OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT")[0]).toEqual({
      user_id: "me",
      message_id: "AAMk1",
      attachment_id: "att1",
      file_name: "pauta.docx",
    });
  });
});

describe("mail helpers", () => {
  test("htmlToText keeps links, decodes entities, drops scripts and styles", () => {
    expect(
      htmlToText(
        '<style>.x{}</style><script>alert(1)</script><h1>T&iacute;tulo</h1><p>Ver <a href="https://a.b/c?x=1&amp;y=2">aqui</a> ou <a href="mailto:ana@x.com">ana@x.com</a> &#8212; &#x1F600;</p><table><tr><td>a</td><td>b</td></tr></table>',
      ),
    ).toBe("Título\n\nVer aqui (https://a.b/c?x=1&y=2) ou ana@x.com — 😀\n\na b");
  });

  test("parseAddressList handles quoted commas, bare addresses and Graph recipients", () => {
    expect(parseAddressList('"Souza, Bia" <BIA@X.com>; ops@x.com, nobody')).toEqual([
      { name: "Souza, Bia", address: "bia@x.com" },
      { address: "ops@x.com" },
    ]);
    expect(parseAddressList([{ emailAddress: { name: "Ana", address: "ANA@x.com" } }])).toEqual([
      { name: "Ana", address: "ana@x.com" },
    ]);
  });
});
