import { describe, expect, spyOn, test } from "bun:test";
import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import {
  createFakeEmailSender,
  createLogEmailSender,
  createMillionSendSender,
  createSmtpEmailSender,
  EmailError,
} from "../src";

const msg = { to: ["ana@example.com"], subject: "Oi", html: "<p>Oi</p>", text: "Oi", idempotencyKey: "invite:1" };
/** A picture the HTML shows as `cid:logo-ink@agentes.chat`. */
const logo = {
  cid: "logo-ink@agentes.chat",
  filename: "logo-ink.png",
  contentType: "image/png",
  content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
};

describe("MillionSend sender", () => {
  test("POST /emails with bearer key, Resend-compatible fields and an Idempotency-Key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sender = createMillionSendSender({
      apiKey: "ms_test",
      from: "agentes <ping@agentes.chat>",
      replyTo: "suporte@agentes.chat",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ id: "0b6f…" });
      }) as unknown as typeof fetch,
    });
    expect(await sender.send({ ...msg, tags: [{ name: "kind", value: "invitation" }] })).toEqual({ id: "0b6f…" });
    const headers = new Headers(calls[0]?.init.headers);
    expect(calls[0]?.url).toBe("https://api.millionsend.com/emails");
    expect(headers.get("authorization")).toBe("Bearer ms_test");
    expect(headers.get("idempotency-key")).toBe("invite:1");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      from: "agentes <ping@agentes.chat>",
      to: ["ana@example.com"],
      subject: "Oi",
      html: "<p>Oi</p>",
      text: "Oi",
      reply_to: "suporte@agentes.chat",
      tags: [{ name: "kind", value: "invitation" }],
    });
  });

  test("pictures attached to the message go as attachments with their content id", async () => {
    const bodies: unknown[] = [];
    const sender = createMillionSendSender({
      apiKey: "k",
      from: "f@x.y",
      fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ id: "e1" });
      }) as unknown as typeof fetch,
    });
    await sender.send({ ...msg, inline: [logo] });
    expect(bodies[0]).toMatchObject({
      attachments: [
        {
          filename: "logo-ink.png",
          content: "iVBORw==",
          content_type: "image/png",
          content_id: "logo-ink@agentes.chat",
        },
      ],
    });
    await sender.send(msg);
    expect(bodies[1]).not.toHaveProperty("attachments");
  });

  test("409 (same idempotency key) counts as sent; 429/5xx retry; 4xx don't", async () => {
    const reply = (status: number) =>
      createMillionSendSender({
        apiKey: "k",
        from: "f@x.y",
        fetch: (async () =>
          Response.json({ statusCode: status, name: "x", message: "m" }, { status })) as unknown as typeof fetch,
      });
    expect((await reply(409).send(msg)).id).toBe("duplicate:invite:1");
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [422, false],
      [403, false],
    ] as const) {
      const error = await reply(status)
        .send(msg)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EmailError);
      expect((error as EmailError).retryable).toBe(retryable);
    }
  });

  test("saveContact creates the contact; one that exists (409) gets its properties merged by email", async () => {
    const calls: { url: string; method?: string; body: unknown }[] = [];
    const sender = createMillionSendSender({
      apiKey: "k",
      from: "f@x.y",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
        return init.method === "POST"
          ? Response.json({ statusCode: 409, name: "conflict", message: "exists" }, { status: 409 })
          : Response.json({ object: "contact", id: "c1" });
      }) as unknown as typeof fetch,
    });
    await sender.saveContact?.({ email: "ana+x@example.com", properties: { waitlist: "confirmed" } });
    expect(calls).toEqual([
      {
        url: "https://api.millionsend.com/contacts",
        method: "POST",
        body: { email: "ana+x@example.com", properties: { waitlist: "confirmed" } },
      },
      {
        url: "https://api.millionsend.com/contacts/ana%2Bx%40example.com",
        method: "PATCH",
        body: { properties: { waitlist: "confirmed" } },
      },
    ]);
    const refused = await createMillionSendSender({
      apiKey: "k",
      from: "f@x.y",
      fetch: (async () => Response.json({ message: "plan limit" }, { status: 403 })) as unknown as typeof fetch,
    })
      .saveContact?.({ email: "a@b.co", properties: {} })
      .catch((e: unknown) => e);
    expect((refused as EmailError).retryable).toBe(false);
  });

  test("saveContact with a null only patches (it removes the key); a contact it doesn't find is fine", async () => {
    const calls: { method?: string; body: unknown }[] = [];
    let status = 200;
    const sender = createMillionSendSender({
      apiKey: "k",
      from: "f@x.y",
      fetch: (async (_url: string, init: RequestInit) => {
        calls.push({ method: init.method, body: JSON.parse(String(init.body)) });
        return Response.json({}, { status });
      }) as unknown as typeof fetch,
    });
    await sender.saveContact?.({ email: "ana@example.com", properties: { account_created_at: null } });
    status = 404;
    await sender.saveContact?.({ email: "ana@example.com", properties: { account_created_at: null } });
    expect(calls).toEqual([
      { method: "PATCH", body: { properties: { account_created_at: null } } },
      { method: "PATCH", body: { properties: { account_created_at: null } } },
    ]);
  });

  test("dev fallback logs instead of sending; the fake records", async () => {
    const lines: unknown[] = [];
    const log = createLogEmailSender((line, data) => lines.push([line, data]));
    expect(log.delivers).toBe(false);
    await log.send(msg);
    expect(JSON.stringify(lines)).toContain("ana@example.com");
    const fake = createFakeEmailSender();
    await fake.send(msg);
    expect(fake.sent).toEqual([msg]);
  });

  test("the base URL is configurable (any Resend-compatible API)", async () => {
    const urls: string[] = [];
    const sender = createMillionSendSender({
      apiKey: "k",
      from: "f@x.y",
      baseURL: "https://mail.example.com/api/",
      fetch: (async (url: string) => {
        urls.push(url);
        return Response.json({ id: "e1" });
      }) as unknown as typeof fetch,
    });
    await sender.send(msg);
    expect(urls).toEqual(["https://mail.example.com/api/emails"]);
  });
});

describe("SMTP sender", () => {
  test("sends html and text from the configured sender, with the reply-to", async () => {
    const mails: Mail.Options[] = [];
    const sender = createSmtpEmailSender({
      url: "smtps://u:p@smtp.example.com",
      from: "agentes <ping@example.com>",
      replyTo: "suporte@example.com",
      transport: {
        sendMail: async (mail: Mail.Options) => {
          mails.push(mail);
          return { messageId: "<m1@example.com>", envelope: { from: "ping@example.com", to: ["ana@example.com"] } };
        },
      },
    });
    expect(sender.delivers).toBe(true);
    expect(await sender.send(msg)).toEqual({ id: "<m1@example.com>" });
    expect(mails).toEqual([
      {
        from: "agentes <ping@example.com>",
        to: ["ana@example.com"],
        subject: "Oi",
        html: "<p>Oi</p>",
        text: "Oi",
        replyTo: "suporte@example.com",
      },
    ]);
    // nodemailer builds a valid message from it.
    const json = createSmtpEmailSender({
      url: "smtp://unused",
      from: "agentes <ping@example.com>",
      transport: nodemailer.createTransport({ jsonTransport: true }),
    });
    expect((await json.send(msg)).id).toMatch(/^<.+>$/);
  });

  test("pictures attached to the message carry their content id, so the HTML's cid: finds them", async () => {
    const json = nodemailer.createTransport({ jsonTransport: true });
    const built: string[] = [];
    const sender = createSmtpEmailSender({
      url: "smtp://unused",
      from: "f@x.y",
      transport: {
        sendMail: async (mail: Mail.Options) => {
          const info = await json.sendMail(mail);
          built.push(String(info.message));
          return info;
        },
      },
    });
    await sender.send({ ...msg, inline: [logo] });
    const message = JSON.parse(built[0] ?? "{}") as { attachments?: Record<string, unknown>[] };
    expect(message.attachments).toEqual([
      expect.objectContaining({ filename: "logo-ink.png", contentType: "image/png", cid: "logo-ink@agentes.chat" }),
    ]);
  });

  test("5xx answers (recipient refused, bad login) don't retry; 4xx and connection failures do", async () => {
    // nodemailer's errors carry the server's reply code as `responseCode`; a dropped connection has none.
    for (const [responseCode, retryable] of [
      [550, false],
      [535, false],
      [451, true],
      [undefined, true],
    ] as const) {
      const error = Object.assign(new Error(`server said ${responseCode}`), { responseCode });
      const sender = createSmtpEmailSender({
        url: "smtp://unused",
        from: "f@x.y",
        transport: {
          sendMail: async () => {
            throw error;
          },
        },
      });
      const failure = await sender.send(msg).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(EmailError);
      expect((failure as EmailError).retryable).toBe(retryable);
      expect((failure as EmailError).message).toBe(`SMTP send failed: server said ${responseCode}`);
    }
  });

  test("smtp:// requires STARTTLS unless the URL opts out", () => {
    const created = spyOn(nodemailer, "createTransport");
    try {
      createSmtpEmailSender({ url: "smtp://u:p@smtp.example.com:587", from: "f@x.y" });
      createSmtpEmailSender({ url: "smtp://relay.internal:25?requireTLS=false", from: "f@x.y" });
      const requireTLS = created.mock.results.map(
        (r) =>
          (r.value as unknown as { transporter: { options: { requireTLS?: boolean } } }).transporter.options.requireTLS,
      );
      expect(requireTLS).toEqual([true, false]);
    } finally {
      created.mockRestore();
    }
  });
});
