import { describe, expect, test } from "bun:test";
import type { MessageStructureObject, SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import {
  createImapConnectionTester,
  createImapMailConnector,
  createImapPoller,
  type ImapMailbox,
  type ImapMailboxStatus,
  type ImapMessageMeta,
  type ImapSession,
  MAIL_PRESETS,
  type MailAccountRef,
  MailAuthError,
  MailError,
  type SmtpClient,
} from "../src";
import {
  classifyTestError,
  decodePartText,
  encodeMessageId,
  findTextPart,
  folderRole,
  foldersWithRoles,
  forwardBody,
  forwardSubject,
  htmlToText,
  listAttachments,
  parseMessage,
  parseMessageId,
  planPoll,
  queryToSearch,
  replyHeaders,
  replySubject,
  searchLimit,
  toMailError,
} from "../src/imap-parse";

// ---------------------------------------------------------------------------
// Fixtures

const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

const PLAIN = crlf(`From: "Ana Souza" <Ana@Example.COM>
To: bob@x.com, "Carla" <CARLA@x.com>
Cc: dan@x.com
Reply-To: replies@example.com
Subject: Hello
Message-ID: <m1@example.com>
References: <r0@example.com>
Date: Tue, 13 Oct 2026 10:00:00 +0000
Content-Type: text/plain; charset=utf-8

Hi Bob,

Can we meet?

> On Monday Bob wrote:
>> earlier message
>> more
`);

const HTML_ONLY = crlf(`From: news@shop.com
To: bob@x.com
Subject: Offer
Message-ID: <m2@shop.com>
Date: Wed, 14 Oct 2026 10:00:00 +0000
Content-Type: text/html; charset=utf-8

<html><head><style>p{color:red}</style></head><body><p>Hello <b>world</b></p><p>See <a href="https://shop.com/deal">the deal</a> &amp; more&nbsp;now</p><blockquote>quoted reply</blockquote><script>alert(1)</script></body></html>
`);

const MULTIPART = crlf(`From: ana@example.com
To: bob@x.com
Subject: Report
Message-ID: <m3@example.com>
Date: Thu, 15 Oct 2026 10:00:00 +0000
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8

Report attached.
--b1
Content-Type: application/pdf; name="report.pdf"
Content-Disposition: attachment; filename="report.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--b1--
`);
const MULTIPART_STRUCTURE: MessageStructureObject = {
  type: "multipart/mixed",
  childNodes: [
    { part: "1", type: "text/plain", parameters: { charset: "utf-8" }, encoding: "7bit", size: 17 },
    {
      part: "2",
      type: "application/pdf",
      parameters: { name: "report.pdf" },
      disposition: "attachment",
      dispositionParameters: { filename: "report.pdf" },
      encoding: "base64",
      size: 12,
    },
  ],
};

const LATIN1 = crlf(`From: =?ISO-8859-1?Q?Jo=E3o?= <joao@exemplo.com.br>
To: bob@x.com
Subject: =?ISO-8859-1?Q?Reuni=E3o_amanh=E3?=
Message-ID: <m4@exemplo.com.br>
Date: Fri, 16 Oct 2026 10:00:00 -0300
Content-Type: text/plain; charset=ISO-8859-1
Content-Transfer-Encoding: quoted-printable

Ol=E1, ser=E1 =E0s 10h na sala de reuni=F5es.
`);

const bodyOf = (raw: string) => Buffer.from(raw.slice(raw.indexOf("\r\n\r\n") + 4), "latin1");

// ---------------------------------------------------------------------------
// Fake IMAP server (in memory) and SMTP

interface FakeMessage {
  uid: number;
  flags: Set<string>;
  raw: Buffer;
  structure: MessageStructureObject;
  parts: Record<string, Buffer>;
  decoded: Record<string, Buffer>;
}

interface FakeFolder {
  uidValidity: number;
  uidNext: number;
  specialUse?: string;
  messages: FakeMessage[];
}

class FakeImap implements ImapSession {
  folders = new Map<string, FakeFolder>();
  calls: string[] = [];
  current: { path: string; readOnly: boolean } | null = null;
  loggedOut = false;
  uidPlus = true;

  folder(path: string, uidValidity = 7, specialUse?: string): FakeFolder {
    const folder: FakeFolder = { uidValidity, uidNext: 1, messages: [], ...(specialUse ? { specialUse } : {}) };
    this.folders.set(path, folder);
    return folder;
  }

  add(
    path: string,
    raw: string,
    options: {
      flags?: string[];
      structure?: MessageStructureObject;
      parts?: Record<string, Buffer>;
      decoded?: Record<string, Buffer>;
      uid?: number;
    } = {},
  ): number {
    const folder = this.folders.get(path) ?? this.folder(path);
    const uid = options.uid ?? folder.uidNext;
    folder.uidNext = Math.max(folder.uidNext, uid + 1);
    const contentType = /^Content-Type: ([^;\r\n]+)(?:;\s*charset=([^\s;\r\n]+))?/im.exec(raw);
    const encoding = /^Content-Transfer-Encoding: (\S+)/im.exec(raw)?.[1];
    folder.messages.push({
      uid,
      flags: new Set(options.flags ?? []),
      raw: Buffer.from(raw, "latin1"),
      structure: options.structure ?? {
        type: contentType?.[1]?.toLowerCase() ?? "text/plain",
        ...(contentType?.[2] ? { parameters: { charset: contentType[2] } } : {}),
        ...(encoding ? { encoding } : {}),
      },
      parts: options.parts ?? { "1": bodyOf(raw) },
      decoded: options.decoded ?? {},
    });
    return uid;
  }

  private open_(): FakeFolder {
    if (!this.current) throw new Error("no folder open");
    const folder = this.folders.get(this.current.path);
    if (!folder) throw new Error("no such folder");
    return folder;
  }

  private writable(): FakeFolder {
    if (!this.current || this.current.readOnly) throw new Error("folder is read-only (EXAMINE)");
    return this.open_();
  }

  private message(uid: number): FakeMessage | undefined {
    return this.open_().messages.find((m) => m.uid === uid);
  }

  async list(): Promise<ImapMailbox[]> {
    return [...this.folders.entries()].map(([path, f]) => ({
      path,
      name: path.split("/").pop() ?? path,
      delimiter: "/",
      ...(f.specialUse ? { specialUse: f.specialUse } : {}),
      flags: [],
    }));
  }

  async open(path: string, options: { readOnly: boolean }): Promise<ImapMailboxStatus> {
    const folder = this.folders.get(path);
    if (!folder) throw Object.assign(new Error("Mailbox doesn't exist"), { mailboxMissing: true });
    this.calls.push(`${options.readOnly ? "EXAMINE" : "SELECT"} ${path}`);
    this.current = { path, readOnly: options.readOnly };
    return {
      path,
      uidValidity: folder.uidValidity,
      uidNext: folder.uidNext,
      exists: folder.messages.length,
      readOnly: options.readOnly,
    };
  }

  async search(criteria: SearchObject): Promise<number[]> {
    this.calls.push(`SEARCH ${JSON.stringify(criteria)}`);
    const folder = this.open_();
    const out: number[] = [];
    for (const m of folder.messages) {
      const parsed = await simpleParser(m.raw);
      if (criteria.seen === false && m.flags.has("\\Seen")) continue;
      if (criteria.from && !parsed.from?.text.toLowerCase().includes(criteria.from.toLowerCase())) continue;
      if (criteria.subject && !parsed.subject?.toLowerCase().includes(criteria.subject.toLowerCase())) continue;
      if (typeof criteria.uid === "string") {
        const start = Number(criteria.uid.split(":")[0]);
        if (m.uid < start) continue;
      }
      const header = criteria.header?.["message-id"];
      if (typeof header === "string" && parsed.messageId !== header) continue;
      out.push(m.uid);
    }
    // Like `N:*` on a real server: the last message always matches.
    if (typeof criteria.uid === "string" && !out.length && folder.messages.length) {
      out.push(folder.messages[folder.messages.length - 1]?.uid ?? 0);
    }
    return out;
  }

  async fetchMeta(uids: number[]): Promise<ImapMessageMeta[]> {
    this.calls.push(`FETCH meta ${uids.join(",")}`);
    const out: ImapMessageMeta[] = [];
    for (const uid of uids) {
      const m = this.message(uid);
      if (!m) continue;
      const parsed = await simpleParser(m.raw);
      const list = (v: typeof parsed.to) => (Array.isArray(v) ? v : v ? [v] : []).flatMap((a) => a.value);
      out.push({
        uid,
        flags: [...m.flags],
        envelope: {
          ...(parsed.date ? { date: parsed.date } : {}),
          ...(parsed.subject ? { subject: parsed.subject } : {}),
          from: list(parsed.from).map((a) => ({ name: a.name, address: a.address })),
          to: list(parsed.to).map((a) => ({ name: a.name, address: a.address })),
          cc: list(parsed.cc).map((a) => ({ name: a.name, address: a.address })),
        },
        bodyStructure: m.structure,
      });
    }
    return out;
  }

  async fetchPart(uids: number[], part: string, maxBytes: number): Promise<Map<number, Uint8Array>> {
    this.calls.push(`FETCH BODY.PEEK[${part}]<0.${maxBytes}> ${uids.join(",")}`);
    const out = new Map<number, Uint8Array>();
    for (const uid of uids) {
      const body = this.message(uid)?.parts[part];
      if (body) out.set(uid, body.subarray(0, maxBytes));
    }
    return out;
  }

  async fetchSource(uid: number): Promise<Uint8Array | null> {
    this.calls.push(`FETCH BODY.PEEK[] ${uid}`);
    return this.message(uid)?.raw ?? null;
  }

  async download(uid: number, part: string): Promise<{ data: Uint8Array } | null> {
    this.calls.push(`FETCH BODY.PEEK[${part}] ${uid}`);
    const data = this.message(uid)?.decoded[part];
    return data ? { data } : null;
  }

  async append(path: string, raw: Uint8Array, flags: string[]): Promise<{ uid?: number; uidValidity?: number }> {
    this.calls.push(`APPEND ${path} ${flags.join(" ")}`);
    const folder = this.folders.get(path);
    if (!folder) throw new Error("no such folder");
    const uid = this.add(path, Buffer.from(raw).toString("latin1"), { flags });
    return this.uidPlus ? { uid, uidValidity: folder.uidValidity } : {};
  }

  async move(uid: number, destination: string): Promise<void> {
    this.calls.push(`MOVE ${uid} ${destination}`);
    const from = this.writable();
    const to = this.folders.get(destination);
    if (!to) throw new Error("no such folder");
    const index = from.messages.findIndex((m) => m.uid === uid);
    const [m] = from.messages.splice(index, 1);
    if (m) to.messages.push({ ...m, uid: to.uidNext++ });
  }

  async addFlags(uid: number, flags: string[]): Promise<void> {
    this.writable();
    this.calls.push(`STORE ${uid} +FLAGS ${flags.join(" ")}`);
    for (const f of flags) this.message(uid)?.flags.add(f);
  }

  async removeFlags(uid: number, flags: string[]): Promise<void> {
    this.writable();
    this.calls.push(`STORE ${uid} -FLAGS ${flags.join(" ")}`);
    for (const f of flags) this.message(uid)?.flags.delete(f);
  }

  async create(path: string): Promise<void> {
    this.calls.push(`CREATE ${path}`);
    this.folder(path, 99);
  }

  async logout(): Promise<void> {
    this.loggedOut = true;
  }
}

class FakeSmtp implements SmtpClient {
  sent: { envelope: { from: string; to: string[] }; raw: string }[] = [];
  verifyError: unknown = null;
  async send(envelope: { from: string; to: string[] }, raw: Uint8Array) {
    this.sent.push({ envelope, raw: Buffer.from(raw).toString("utf8") });
  }
  async verify() {
    if (this.verifyError) throw this.verifyError;
  }
  close() {}
}

const PASSWORD = "app-secret-pass";

function account(overrides: Partial<NonNullable<MailAccountRef["imap"]>> = {}): MailAccountRef {
  return {
    id: "acc_1",
    orgId: "org_1",
    provider: "imap",
    via: "imap",
    address: "bob@x.com",
    imap: {
      host: "imap.mail.me.com",
      port: 993,
      smtpHost: "smtp.mail.me.com",
      smtpPort: 587,
      username: "bob@x.com",
      password: PASSWORD,
      sentFolder: null,
      ...overrides,
    },
  };
}

function mailbox() {
  const imap = new FakeImap();
  imap.folder("INBOX");
  imap.folder("Sent Messages", 7, "\\Sent");
  imap.folder("Drafts", 7, "\\Drafts");
  imap.folder("Deleted Messages", 7, "\\Trash");
  const smtp = new FakeSmtp();
  const checked: string[] = [];
  const options = {
    connectImap: async () => imap,
    createSmtp: () => smtp,
    checkHost: async (host: string) => {
      checked.push(host);
    },
  };
  return { imap, smtp, checked, options };
}

// ---------------------------------------------------------------------------
// Pure helpers

describe("message ids", () => {
  test("encode and parse back, folder with ':' '/' and accents", () => {
    for (const folder of ["INBOX", "Itens Enviados", "Work/2026:Q4", "Arquivo%"]) {
      const id = encodeMessageId({ folder, uidValidity: 4_000_000_000, uid: 42 });
      expect(parseMessageId(id)).toEqual({ folder, uidValidity: 4_000_000_000, uid: 42 });
    }
  });

  test("garbage is a MailError", () => {
    for (const bad of ["", "INBOX", "INBOX:1", "INBOX:x:1", "INBOX:1:0", "%E0%A4%A:1:2", ":1:2"]) {
      expect(() => parseMessageId(bad)).toThrow(MailError);
    }
  });
});

describe("search criteria", () => {
  test("MailQuery → IMAP SEARCH", () => {
    expect(
      queryToSearch({
        from: " @example.com ",
        to: "bob@x.com",
        subject: "Invoice",
        text: "boleto",
        since: "2026-10-01",
        before: "2026-10-10",
        unreadOnly: true,
      }),
    ).toEqual({
      from: "@example.com",
      to: "bob@x.com",
      subject: "Invoice",
      text: "boleto",
      since: new Date("2026-10-01"),
      before: new Date("2026-10-10"),
      seen: false,
    });
    expect(queryToSearch({})).toEqual({ all: true });
    expect(() => queryToSearch({ since: "yesterday-ish" })).toThrow(MailError);
  });

  test("limit: default 20, max 50", () => {
    expect(searchLimit(undefined)).toBe(20);
    expect(searchLimit(500)).toBe(50);
    expect(searchLimit(0)).toBe(1);
    expect(searchLimit(7)).toBe(7);
  });
});

describe("folder roles", () => {
  const box = (path: string, specialUse?: string, flags: string[] = []): ImapMailbox => ({
    path,
    name: path.split(".").pop() ?? path,
    delimiter: ".",
    flags,
    ...(specialUse ? { specialUse } : {}),
  });

  test("special-use flags", () => {
    expect(folderRole(box("INBOX"))).toBe("inbox");
    expect(folderRole(box("Foo", "\\Sent"))).toBe("sent");
    expect(folderRole(box("Foo", "\\Junk"))).toBe("spam");
    expect(folderRole(box("[Gmail].All Mail", "\\All"))).toBe("all");
    expect(folderRole(box("Bar", undefined, ["\\HasNoChildren", "\\Archive"]))).toBe("archive");
  });

  test("common names in Portuguese and English", () => {
    expect(folderRole(box("INBOX.Enviados"))).toBe("sent");
    expect(folderRole(box("Itens Enviados"))).toBe("sent");
    expect(folderRole(box("Sent Messages"))).toBe("sent");
    expect(folderRole(box("Rascunhos"))).toBe("drafts");
    expect(folderRole(box("Lixeira"))).toBe("trash");
    expect(folderRole(box("Itens Excluídos"))).toBe("trash");
    expect(folderRole(box("Deleted Messages"))).toBe("trash");
    expect(folderRole(box("Lixo Eletrônico"))).toBe("spam");
    expect(folderRole(box("Junk"))).toBe("spam");
    expect(folderRole(box("Arquivo"))).toBe("archive");
    expect(folderRole(box("Projects"))).toBeUndefined();
  });

  test("one folder per role (special-use wins), \\Noselect hidden, nested names readable", () => {
    const rows = foldersWithRoles([
      box("INBOX"),
      box("INBOX.Sent"),
      box("Enviados", "\\Sent"),
      box("[Gmail]", undefined, ["\\Noselect"]),
      box("INBOX.Clientes.ACME"),
    ]);
    expect(rows.map((r) => [r.id, r.name, r.role])).toEqual([
      ["INBOX", "Inbox", "inbox"],
      ["INBOX.Sent", "INBOX/Sent", undefined],
      ["Enviados", "Enviados", "sent"],
      ["INBOX.Clientes.ACME", "INBOX/Clientes/ACME", undefined],
    ]);
  });
});

describe("structure", () => {
  test("attachments are leaf parts with a filename or attachment disposition (not inline images)", () => {
    const structure: MessageStructureObject = {
      type: "multipart/mixed",
      childNodes: [
        {
          part: "1",
          type: "multipart/related",
          childNodes: [
            { part: "1.1", type: "text/html" },
            { part: "1.2", type: "image/png", disposition: "inline", parameters: { name: "logo.png" }, id: "<logo>" },
          ],
        },
        ...(MULTIPART_STRUCTURE.childNodes?.slice(1) ?? []),
        { part: "3", type: "message/rfc822", size: 100, childNodes: [{ part: "3.1", type: "text/plain" }] },
      ],
    };
    expect(listAttachments(structure)).toEqual([
      { id: "2", filename: "report.pdf", contentType: "application/pdf", size: 9 },
      { id: "3", filename: "message.eml", contentType: "message/rfc822", size: 100 },
    ]);
    expect(findTextPart(structure)?.part).toBe("1.1");
    expect(findTextPart(MULTIPART_STRUCTURE)?.part).toBe("1");
    expect(findTextPart({ type: "text/plain" })?.part).toBe("1");
  });

  test("snippet part decoding: quoted-printable ISO-8859-1, base64 HTML", async () => {
    const latin = { type: "text/plain", parameters: { charset: "ISO-8859-1" }, encoding: "quoted-printable" };
    expect(await decodePartText(bodyOf(LATIN1), latin)).toContain("Olá, será às 10h na sala de reuniões.");
    const html = Buffer.from(Buffer.from("<p>Oi <a href='https://a.b/c'>link</a></p>").toString("base64"));
    expect((await decodePartText(html, { type: "text/html", encoding: "base64" })).trim()).toBe(
      "Oi link (https://a.b/c)",
    );
  });
});

describe("HTML to text", () => {
  test("drops scripts and styles, keeps links as 'text (url)', blocks as lines, decodes entities", () => {
    const text = htmlToText(
      `<style>.a{}</style><p>Hi&nbsp;there &amp; &#233;&#x00e7;</p><div>Line<br>two</div><ul><li>one</li><li>two</li></ul><a href="https://x.y/z?a=1&amp;b=2">open</a> <a href="mailto:a@b.c">a@b.c</a><script>x()</script>`,
    );
    expect(text).toBe("Hi there & éç\n\nLine\ntwo\n\n- one\n- two\nopen (https://x.y/z?a=1&b=2) a@b.c");
  });

  test("javascript: links lose the url", () => {
    expect(htmlToText(`<a href="javascript:evil()">click</a>`)).toBe("click");
  });
});

describe("MIME → MailMessage", () => {
  const meta = (uid: number, structure?: MessageStructureObject, flags: string[] = []): ImapMessageMeta => ({
    uid,
    flags,
    ...(structure ? { bodyStructure: structure } : {}),
  });

  test("plain text: lowercase addresses, reply-to, threading headers, quotes kept", async () => {
    const message = await parseMessage(Buffer.from(PLAIN), meta(5, { type: "text/plain" }, ["\\Seen"]), "INBOX", 7);
    expect(message.id).toBe("INBOX:7:5");
    expect(message.from).toEqual({ name: "Ana Souza", address: "ana@example.com" });
    expect(message.to).toEqual([{ address: "bob@x.com" }, { name: "Carla", address: "carla@x.com" }]);
    expect(message.cc).toEqual([{ address: "dan@x.com" }]);
    expect(message.replyTo).toEqual([{ address: "replies@example.com" }]);
    expect(message.messageIdHeader).toBe("<m1@example.com>");
    expect(message.references).toEqual(["<r0@example.com>"]);
    expect(message.subject).toBe("Hello");
    expect(message.date).toBe("2026-10-13T10:00:00.000Z");
    expect(message.unread).toBe(false);
    expect(message.text).toContain("> On Monday Bob wrote:\n>> earlier message");
    expect(message.snippet.startsWith("Hi Bob, Can we meet?")).toBe(true);
    expect(message.attachments).toEqual([]);
  });

  test("where the server delivered it: Delivered-To (repeated) and X-Original-To, lowercase", async () => {
    const raw = crlf(
      `Delivered-To: Suporte@Acme.com\nDelivered-To: ana@icloud.com\nX-Original-To: <suporte@acme.com>\n${PLAIN}`,
    );
    const message = await parseMessage(Buffer.from(raw), meta(6, { type: "text/plain" }), "INBOX", 7);
    expect(message.deliveredTo).toEqual(["suporte@acme.com", "ana@icloud.com"]);
    expect((await parseMessage(Buffer.from(PLAIN), meta(5), "INBOX", 7)).deliveredTo).toBeUndefined();
  });

  test("HTML only → text", async () => {
    const message = await parseMessage(Buffer.from(HTML_ONLY), meta(1, { type: "text/html" }), "INBOX", 7);
    expect(message.text).toContain("Hello world");
    expect(message.text).toContain("the deal (https://shop.com/deal) & more now");
    expect(message.text).toContain("quoted reply");
    expect(message.text).not.toContain("alert");
    expect(message.text).not.toContain("color:red");
    expect(message.unread).toBe(true);
  });

  test("multipart with attachment: ids are IMAP part numbers", async () => {
    const message = await parseMessage(Buffer.from(MULTIPART), meta(2, MULTIPART_STRUCTURE), "INBOX", 7);
    expect(message.text).toBe("Report attached.");
    expect(message.hasAttachments).toBe(true);
    expect(message.attachments).toEqual([{ id: "2", filename: "report.pdf", contentType: "application/pdf", size: 9 }]);
  });

  test("ISO-8859-1 encoded-word subject and quoted-printable body", async () => {
    const message = await parseMessage(Buffer.from(LATIN1, "latin1"), meta(3), "INBOX", 7);
    expect(message.subject).toBe("Reunião amanhã");
    expect(message.from).toEqual({ name: "João", address: "joao@exemplo.com.br" });
    expect(message.text).toBe("Olá, será às 10h na sala de reuniões.");
  });

  test("very long bodies are capped", async () => {
    const raw = crlf(`From: a@b.c\nSubject: big\nContent-Type: text/plain\n\n${"x".repeat(250_000)}\n`);
    const message = await parseMessage(Buffer.from(raw), meta(9), "INBOX", 7);
    expect(message.text.length).toBeLessThan(200_100);
    expect(message.text.endsWith("[…truncated]")).toBe(true);
  });
});

describe("reply and forward", () => {
  test("headers chain the original's references, then its Message-ID", () => {
    expect(replyHeaders({ messageIdHeader: "<m1@x>", references: ["<r0@x>"] })).toEqual({
      inReplyTo: "<m1@x>",
      references: ["<r0@x>", "<m1@x>"],
    });
    expect(replyHeaders({ messageIdHeader: "<m1@x>" })).toEqual({ inReplyTo: "<m1@x>", references: ["<m1@x>"] });
    expect(replyHeaders({})).toEqual({});
  });

  test("subjects", () => {
    expect(replySubject("", "Hello")).toBe("Re: Hello");
    expect(replySubject("Hello", "Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Hello", "Hello")).toBe("RE: Hello");
    expect(replySubject("Res: Olá", "Olá")).toBe("Res: Olá");
    expect(forwardSubject("", "Report")).toBe("Fwd: Report");
    expect(forwardSubject("ENC: Report", "Report")).toBe("ENC: Report");
  });

  test("forward body quotes the original below", () => {
    const body = forwardBody("FYI", {
      id: "INBOX:7:1",
      from: { name: "Ana", address: "ana@example.com" },
      to: [{ address: "bob@x.com" }],
      cc: [],
      subject: "Report",
      date: "2026-10-15T10:00:00.000Z",
      snippet: "",
      unread: false,
      hasAttachments: false,
      text: "Report attached.",
      replyTo: [],
      attachments: [],
    });
    expect(body).toBe(
      "FYI\n\n---------- Forwarded message ----------\nFrom: Ana <ana@example.com>\nDate: 2026-10-15T10:00:00.000Z\nSubject: Report\nTo: bob@x.com\n\nReport attached.",
    );
  });
});

describe("errors", () => {
  test("auth failures → MailAuthError (IMAP and SMTP)", () => {
    expect(toMailError(Object.assign(new Error("x"), { authenticationFailed: true }))).toBeInstanceOf(MailAuthError);
    expect(toMailError(Object.assign(new Error("x"), { serverResponseCode: "AUTHENTICATIONFAILED" }))).toBeInstanceOf(
      MailAuthError,
    );
    expect(toMailError(Object.assign(new Error("535 bad"), { code: "EAUTH", responseCode: 535 }))).toBeInstanceOf(
      MailAuthError,
    );
  });

  test("timeouts, resets and throttling retry; the rest doesn't", () => {
    for (const code of ["ETIMEOUT", "ECONNRESET", "ETHROTTLE", "NoConnection", "ESOCKET"]) {
      const error = toMailError(Object.assign(new Error("x"), { code }));
      expect(error).toBeInstanceOf(MailError);
      expect((error as MailError).retryable).toBe(true);
    }
    expect((toMailError(Object.assign(new Error("busy"), { responseCode: 421 })) as MailError).retryable).toBe(true);
    expect((toMailError(new Error("Mailbox doesn't exist")) as MailError).retryable).toBe(false);
  });

  test("the password never leaks", () => {
    const b64 = Buffer.from(PASSWORD).toString("base64");
    const error = toMailError(new Error(`LOGIN bob ${PASSWORD} failed / AUTH PLAIN ${b64}`), PASSWORD);
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).not.toContain(b64);
  });

  test("connection test reasons", () => {
    expect(classifyTestError(Object.assign(new Error("x"), { authenticationFailed: true }), "imap")).toBe("auth");
    expect(classifyTestError(Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" }), "imap")).toBe("tls");
    expect(classifyTestError(new Error("self signed certificate"), "smtp")).toBe("tls");
    expect(classifyTestError(Object.assign(new Error("x"), { code: "ENOTFOUND" }), "imap")).toBe("imap_unreachable");
    expect(classifyTestError(Object.assign(new Error("x"), { code: "ECONNECTION" }), "smtp")).toBe("smtp_unreachable");
    expect(classifyTestError(new Error("weird"), "imap")).toBe("unknown");
  });
});

describe("poll state", () => {
  test("null state or a new UIDVALIDITY start from now", () => {
    expect(planPoll(null, { uidValidity: 7, uidNext: 101 })).toEqual({
      fetchFrom: null,
      state: { lastUid: 100, uidValidity: 7 },
    });
    expect(planPoll({ lastUid: 50, uidValidity: 6 }, { uidValidity: 7, uidNext: 3 })).toEqual({
      fetchFrom: null,
      state: { lastUid: 2, uidValidity: 7 },
    });
  });

  test("same UIDVALIDITY fetches after lastUid; nothing new skips the search", () => {
    expect(planPoll({ lastUid: 50, uidValidity: 7 }, { uidValidity: 7, uidNext: 60 })).toEqual({
      fetchFrom: 51,
      state: { lastUid: 50, uidValidity: 7 },
    });
    expect(planPoll({ lastUid: 59, uidValidity: 7 }, { uidValidity: 7, uidNext: 60 }).fetchFrom).toBeNull();
  });
});

describe("presets", () => {
  test("well-formed, unique ids, no Gmail/Outlook, custom last", () => {
    const ids = MAIL_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("icloud");
    expect(ids.at(-1)).toBe("custom");
    for (const preset of MAIL_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect([993, 143]).toContain(preset.imapPort);
      expect([465, 587]).toContain(preset.smtpPort);
      if (preset.id !== "custom") {
        expect(preset.imapHost).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
        expect(preset.smtpHost).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
        expect(preset.imapHost).not.toMatch(/gmail|outlook|office365/);
      }
      if (preset.appPasswordUrl) expect(preset.appPasswordUrl.startsWith("https://")).toBe(true);
    }
    expect(MAIL_PRESETS.find((p) => p.id === "icloud")).toMatchObject({
      imapHost: "imap.mail.me.com",
      imapPort: 993,
      smtpHost: "smtp.mail.me.com",
      smtpPort: 587,
    });
  });
});

// ---------------------------------------------------------------------------
// Connector, poller and tester over the fakes

describe("IMAP connector", () => {
  test("checks both hosts before connecting; a blocked host is a MailError", async () => {
    const { options, checked } = mailbox();
    await createImapMailConnector(options).open(account());
    expect(checked).toEqual(["imap.mail.me.com", "smtp.mail.me.com"]);
    const blocked = createImapMailConnector({
      ...options,
      checkHost: async (host) => {
        if (host.startsWith("smtp")) throw new Error("private address");
      },
    });
    await expect(blocked.open(account())).rejects.toBeInstanceOf(MailError);
  });

  test("listFolders: roles from special-use", async () => {
    const { options } = mailbox();
    const provider = await createImapMailConnector(options).open(account());
    expect(await provider.listFolders()).toEqual([
      { id: "INBOX", name: "Inbox", role: "inbox" },
      { id: "Sent Messages", name: "Sent Messages", role: "sent" },
      { id: "Drafts", name: "Drafts", role: "drafts" },
      { id: "Deleted Messages", name: "Deleted Messages", role: "trash" },
    ]);
  });

  test("search and read only EXAMINE and peek: flags never change", async () => {
    const { imap, options } = mailbox();
    imap.add("INBOX", PLAIN);
    imap.add("INBOX", HTML_ONLY);
    imap.add("INBOX", MULTIPART, {
      structure: MULTIPART_STRUCTURE,
      parts: { "1": Buffer.from("Report attached.") },
      decoded: { "2": Buffer.from("%PDF-1.4\n") },
    });
    imap.add("INBOX", LATIN1, { flags: ["\\Seen", "\\Flagged"] });
    const provider = await createImapMailConnector(options).open(account());

    const all = await provider.search({ limit: 3 });
    expect(all.map((m) => m.subject)).toEqual(["Reunião amanhã", "Report", "Offer"]);
    expect(all[0]).toMatchObject({
      id: "INBOX:7:4",
      unread: false,
      flagged: true,
      snippet: "Olá, será às 10h na sala de reuniões.",
    });
    expect(all[1]).toMatchObject({ hasAttachments: true, snippet: "Report attached." });
    expect(all[2]?.snippet).toBe("Hello world See the deal (https://shop.com/deal) & more now quoted reply");

    const unread = await provider.search({ unreadOnly: true, from: "ana" });
    expect(unread.map((m) => m.id)).toEqual(["INBOX:7:3", "INBOX:7:1"]);

    const message = await provider.read("INBOX:7:3");
    expect(message.attachments).toEqual([{ id: "2", filename: "report.pdf", contentType: "application/pdf", size: 9 }]);
    const file = await provider.attachment("INBOX:7:3", "2");
    expect(file.filename).toBe("report.pdf");
    expect(Buffer.from(file.data).toString()).toBe("%PDF-1.4\n");
    await expect(provider.attachment("INBOX:7:3", "1")).rejects.toThrow("Attachment not found");

    expect(imap.calls.filter((c) => /^(SELECT|STORE|MOVE|APPEND)/.test(c))).toEqual([]);
    expect(imap.calls.filter((c) => c.startsWith("EXAMINE")).length).toBeGreaterThan(0);
    expect(imap.folders.get("INBOX")?.messages.map((m) => [...m.flags])).toEqual([[], [], [], ["\\Seen", "\\Flagged"]]);
  });

  test("a changed UIDVALIDITY → message no longer available", async () => {
    const { imap, options } = mailbox();
    imap.add("INBOX", PLAIN);
    const provider = await createImapMailConnector(options).open(account());
    await expect(provider.read("INBOX:6:1")).rejects.toThrow("Message no longer available");
    await expect(provider.read("INBOX:7:99")).rejects.toThrow("Message no longer available");
  });

  test("send a reply: SMTP envelope has Bcc, wire has no Bcc header, threading headers, sent copy with Bcc", async () => {
    const { imap, smtp, options } = mailbox();
    imap.add("INBOX", PLAIN);
    const provider = await createImapMailConnector(options).open(account());
    const result = await provider.send({
      to: ["ana@example.com"],
      cc: [],
      bcc: ["boss@x.com"],
      subject: "",
      text: "Yes, Tuesday works.",
      inReplyTo: "INBOX:7:1",
    });
    expect(result.id).toMatch(/^<[0-9a-f-]+@x\.com>$/);
    expect(smtp.sent).toHaveLength(1);
    const wire = smtp.sent[0];
    expect(wire?.envelope).toEqual({ from: "bob@x.com", to: ["ana@example.com", "boss@x.com"] });
    expect(wire?.raw).not.toMatch(/^Bcc:/im);
    const parsed = await simpleParser(Buffer.from(wire?.raw ?? ""));
    expect(parsed.subject).toBe("Re: Hello");
    expect(parsed.inReplyTo).toBe("<m1@example.com>");
    expect(parsed.references).toEqual(["<r0@example.com>", "<m1@example.com>"]);
    expect(parsed.messageId).toBe(result.id ?? "");

    expect(imap.calls).toContain("APPEND Sent Messages \\Seen");
    const copy = imap.folders.get("Sent Messages")?.messages[0];
    expect(copy?.flags.has("\\Seen")).toBe(true);
    const copyParsed = await simpleParser(copy?.raw ?? Buffer.alloc(0));
    expect(copyParsed.messageId).toBe(result.id ?? "");
    expect(copyParsed.bcc).toBeDefined();
  });

  test("Gmail/Outlook hosts keep their own sent copy: no APPEND", async () => {
    const { imap, smtp, options } = mailbox();
    const provider = await createImapMailConnector(options).open(account({ host: "imap.gmail.com" }));
    await provider.send({ to: ["a@b.c"], cc: [], bcc: [], subject: "Hi", text: "x" });
    expect(smtp.sent).toHaveLength(1);
    expect(imap.calls.some((c) => c.startsWith("APPEND"))).toBe(false);
  });

  test("a failed sent copy doesn't fail the send", async () => {
    const { imap, smtp, options } = mailbox();
    const logs: string[] = [];
    const provider = await createImapMailConnector({ ...options, log: (line) => logs.push(line) }).open(
      account({ sentFolder: "Missing" }),
    );
    expect(await provider.send({ to: ["a@b.c"], cc: [], bcc: [], subject: "Hi", text: "x" })).toHaveProperty("id");
    expect(smtp.sent).toHaveLength(1);
    expect(logs).toEqual(["mail: could not save the sent copy"]);
    expect(imap.calls).toContain("APPEND Missing \\Seen");
  });

  test("SMTP auth failure → MailAuthError; no recipients → MailError", async () => {
    const { options } = mailbox();
    const failing = createImapMailConnector({
      ...options,
      createSmtp: () => ({
        send: async () => {
          throw Object.assign(new Error(`535 Authentication failed for ${PASSWORD}`), {
            code: "EAUTH",
            responseCode: 535,
          });
        },
        verify: async () => {},
        close: () => {},
      }),
    });
    const provider = await failing.open(account());
    const error = await provider.send({ to: ["a@b.c"], cc: [], bcc: [], subject: "Hi", text: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(MailAuthError);
    expect(String(error.message)).not.toContain(PASSWORD);
    await expect(provider.send({ to: [], cc: [], bcc: [], subject: "Hi", text: "x" })).rejects.toThrow("No recipients");
  });

  test("forward: original quoted below, its attachments attached", async () => {
    const { imap, smtp, options } = mailbox();
    imap.add("INBOX", MULTIPART, {
      structure: MULTIPART_STRUCTURE,
      parts: { "1": Buffer.from("Report attached.") },
      decoded: { "2": Buffer.from("%PDF-1.4\n") },
    });
    const provider = await createImapMailConnector(options).open(account());
    await provider.send({
      to: ["carla@x.com"],
      cc: [],
      bcc: [],
      subject: "",
      text: "See below",
      forwardOf: "INBOX:7:1",
    });
    const parsed = await simpleParser(Buffer.from(smtp.sent[0]?.raw ?? ""));
    expect(parsed.subject).toBe("Fwd: Report");
    expect(parsed.text).toContain("See below\n\n---------- Forwarded message ----------");
    expect(parsed.text).toContain("Report attached.");
    expect(parsed.attachments.map((a) => [a.filename, a.contentType, a.content.toString()])).toEqual([
      ["report.pdf", "application/pdf", "%PDF-1.4\n"],
    ]);
  });

  test("createDraft appends to Drafts with \\Draft and returns its id (also without UIDPLUS)", async () => {
    const { imap, smtp, options } = mailbox();
    const provider = await createImapMailConnector(options).open(account());
    const draft = await provider.createDraft({ to: ["a@b.c"], cc: [], bcc: ["z@b.c"], subject: "Draft", text: "x" });
    expect(draft.id).toBe("Drafts:7:1");
    expect(imap.calls).toContain("APPEND Drafts \\Draft \\Seen");
    expect(smtp.sent).toHaveLength(0);
    const saved = await simpleParser(imap.folders.get("Drafts")?.messages[0]?.raw ?? Buffer.alloc(0));
    expect(saved.bcc).toBeDefined();

    imap.uidPlus = false;
    const second = await provider.createDraft({ to: ["a@b.c"], cc: [], bcc: [], subject: "Draft 2", text: "y" });
    expect(second.id).toBe("Drafts:7:2");
  });

  test("move, flags, archive (created when missing) and trash use SELECT", async () => {
    const { imap, options } = mailbox();
    imap.add("INBOX", PLAIN);
    imap.add("INBOX", HTML_ONLY);
    imap.add("INBOX", LATIN1);
    imap.folder("Work");
    const provider = await createImapMailConnector(options).open(account());

    await provider.setFlags("INBOX:7:1", { read: true, flagged: true });
    expect([...(imap.folders.get("INBOX")?.messages[0]?.flags ?? [])]).toEqual(["\\Seen", "\\Flagged"]);
    await provider.setFlags("INBOX:7:1", { read: false });
    expect([...(imap.folders.get("INBOX")?.messages[0]?.flags ?? [])]).toEqual(["\\Flagged"]);

    await provider.move("INBOX:7:1", "Work");
    await provider.archive("INBOX:7:2");
    await provider.trash("INBOX:7:3");
    expect(imap.calls).toContain("CREATE Archive");
    expect(imap.folders.get("Work")?.messages).toHaveLength(1);
    expect(imap.folders.get("Archive")?.messages).toHaveLength(1);
    expect(imap.folders.get("Deleted Messages")?.messages).toHaveLength(1);
    expect(imap.folders.get("INBOX")?.messages).toHaveLength(0);
    expect(imap.calls.filter((c) => c.startsWith("SELECT"))).toHaveLength(5);
  });

  test("a refused login → MailAuthError; close logs out", async () => {
    const refused = createImapMailConnector({
      connectImap: async () => {
        throw Object.assign(new Error("Invalid credentials"), { authenticationFailed: true });
      },
    });
    const provider = await refused.open(account());
    await expect(provider.listFolders()).rejects.toBeInstanceOf(MailAuthError);

    const { imap, options } = mailbox();
    const ok = await createImapMailConnector(options).open(account());
    await ok.listFolders();
    await ok.close();
    expect(imap.loggedOut).toBe(true);
    await expect(ok.listFolders()).rejects.toThrow("closed");
  });
});

describe("IMAP poller", () => {
  test("null state: nothing, starts from now", async () => {
    const { imap, options } = mailbox();
    imap.add("INBOX", PLAIN);
    imap.add("INBOX", HTML_ONLY);
    const poller = createImapPoller(options);
    expect(await poller.newMessages(account(), "INBOX", null)).toEqual({
      messages: [],
      state: { lastUid: 2, uidValidity: 7 },
    });
    expect(imap.calls).toEqual(["EXAMINE INBOX"]);
    expect(imap.loggedOut).toBe(true);
  });

  test("UIDVALIDITY changed: reset, nothing returned", async () => {
    const { imap, options } = mailbox();
    imap.add("INBOX", PLAIN);
    const result = await createImapPoller(options).newMessages(account(), "INBOX", { lastUid: 40, uidValidity: 3 });
    expect(result).toEqual({ messages: [], state: { lastUid: 1, uidValidity: 7 } });
  });

  test("new messages after lastUid, oldest first, limited, state advanced (peek only)", async () => {
    const { imap, options } = mailbox();
    imap.add("INBOX", PLAIN);
    imap.add("INBOX", HTML_ONLY);
    imap.add("INBOX", MULTIPART, { structure: MULTIPART_STRUCTURE, parts: { "1": Buffer.from("Report attached.") } });
    imap.add("INBOX", LATIN1);
    const poller = createImapPoller(options);
    const first = await poller.newMessages(account(), "INBOX", { lastUid: 1, uidValidity: 7 }, { limit: 2 });
    expect(first.messages.map((m) => m.subject)).toEqual(["Offer", "Report"]);
    expect(first.state).toEqual({ lastUid: 3, uidValidity: 7 });
    const second = await poller.newMessages(account(), "INBOX", first.state);
    expect(second.messages.map((m) => m.id)).toEqual(["INBOX:7:4"]);
    expect(second.state).toEqual({ lastUid: 4, uidValidity: 7 });
    const third = await poller.newMessages(account(), "INBOX", second.state);
    expect(third).toEqual({ messages: [], state: { lastUid: 4, uidValidity: 7 } });
    expect(imap.calls.some((c) => c.startsWith("SELECT"))).toBe(false);
    expect(imap.folders.get("INBOX")?.messages.every((m) => m.flags.size === 0)).toBe(true);
  });
});

describe("IMAP connection tester", () => {
  test("ok with the detected sent folder", async () => {
    const { options } = mailbox();
    expect(await createImapConnectionTester(options).test(account())).toEqual({
      ok: true,
      sentFolder: "Sent Messages",
    });
  });

  test("blocked host, refused login, TLS, SMTP unreachable", async () => {
    const { options, smtp } = mailbox();
    const blocked = createImapConnectionTester({
      ...options,
      checkHost: async () => {
        throw new Error("blocked");
      },
    });
    expect(await blocked.test(account())).toEqual({ ok: false, error: "blocked_host" });

    const imapError = (error: unknown) =>
      createImapConnectionTester({
        ...options,
        connectImap: async () => {
          throw error;
        },
      }).test(account());
    expect(await imapError(Object.assign(new Error("x"), { authenticationFailed: true }))).toEqual({
      ok: false,
      error: "auth",
    });
    expect(await imapError(Object.assign(new Error("x"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }))).toEqual({
      ok: false,
      error: "tls",
    });
    expect(await imapError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toEqual({
      ok: false,
      error: "imap_unreachable",
    });

    smtp.verifyError = Object.assign(new Error("x"), { code: "ETIMEDOUT" });
    expect(await createImapConnectionTester(options).test(account())).toEqual({ ok: false, error: "smtp_unreachable" });
    smtp.verifyError = Object.assign(new Error("x"), { code: "EAUTH", responseCode: 535 });
    expect(await createImapConnectionTester(options).test(account())).toEqual({ ok: false, error: "auth" });
  });

  test("a hung server times out", async () => {
    const tester = createImapConnectionTester({
      connectTimeoutMs: 20,
      connectImap: () => new Promise(() => {}),
    });
    expect(await tester.test(account())).toEqual({ ok: false, error: "imap_unreachable" });
  });
});
