import { oneLine } from "./text";

/**
 * The email an approval would write, as its card shows it (From, To,
 * Subject, the text, the message it answers). Mail tools store it in the
 * approval's `detail` in one fixed text format (`mailDetail`), and the
 * approvals read it back (`parseMailDetail`); the format lives only here.
 */
export interface MailPreview {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** The message this one answers or forwards (its sender may be unknown). */
  original: { subject: string; from: string | null } | null;
}

/** "Re: Re: Question" → "Question": the subject of the message being answered. */
export const withoutReplyPrefix = (subject: string) => subject.replace(/^\s*((re|res|fw|fwd|enc)\s*:\s*)+/i, "");

const HEADERS = {
  from: "From",
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
  subject: "Subject",
  originalSubject: "Original-Subject",
  originalFrom: "Original-From",
} as const;

/** Header lines, a blank line, then the text (already cut by the caller). */
export function mailDetail(p: MailPreview) {
  const line = (key: string, value: string) => `${key}: ${oneLine(value, 500)}`;
  return [
    line(HEADERS.from, p.from),
    line(HEADERS.to, p.to.join(", ")),
    ...(p.cc.length > 0 ? [line(HEADERS.cc, p.cc.join(", "))] : []),
    ...(p.bcc.length > 0 ? [line(HEADERS.bcc, p.bcc.join(", "))] : []),
    line(HEADERS.subject, p.subject),
    ...(p.original ? [line(HEADERS.originalSubject, p.original.subject)] : []),
    ...(p.original?.from ? [line(HEADERS.originalFrom, p.original.from)] : []),
    "",
    p.body,
  ].join("\n");
}

/** The preview back from `mailDetail`'s text; null when the detail isn't in that format. */
export function parseMailDetail(detail: string): MailPreview | null {
  const cut = detail.indexOf("\n\n");
  const head = cut === -1 ? detail : detail.slice(0, cut);
  const body = cut === -1 ? "" : detail.slice(cut + 2);
  const values = new Map<string, string>();
  for (const line of head.split("\n")) {
    const at = line.indexOf(": ");
    if (at <= 0) return null;
    values.set(line.slice(0, at), line.slice(at + 2));
  }
  if (!values.has(HEADERS.from) || !values.has(HEADERS.subject)) return null;
  const list = (key: string) =>
    (values.get(key) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const originalSubject = values.get(HEADERS.originalSubject);
  return {
    from: values.get(HEADERS.from) ?? "",
    to: list(HEADERS.to),
    cc: list(HEADERS.cc),
    bcc: list(HEADERS.bcc),
    subject: values.get(HEADERS.subject) ?? "",
    body,
    original:
      originalSubject !== undefined
        ? { subject: originalSubject, from: values.get(HEADERS.originalFrom) ?? null }
        : null,
  };
}
