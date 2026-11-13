/**
 * Small, dependency-free helpers to normalise mail coming out of providers
 * (Composio's Gmail and Outlook tool results and trigger payloads): JSON fields, HTML to plain text, address lists, dates and base64url bodies.
 */
import { decodeEntities, htmlToText } from "./html-text";
import type { MailAddress } from "./mail";

export type Obj = Record<string, unknown>;

/** A JSON object field, or `{}`. */
export const obj = (value: unknown): Obj =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** A non-empty string (a number as text), else undefined. */
export const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : typeof value === "number" ? String(value) : undefined;
/** A search's page size: 20 by default, 1 to 50. */
export const clampLimit = (limit: number | undefined) => Math.min(50, Math.max(1, Math.floor(limit ?? 20)));

export { decodeEntities, htmlToText } from "./html-text";

/** Whether a body looks like HTML rather than plain text. */
export function looksLikeHtml(text: string): boolean {
  return /<\/?(html|body|div|p|br|table|span|td|img|style|head|meta|font|b|strong|ul|li)\b[^>@]*>|<a\s[^>]*href/i.test(
    text,
  );
}

/** Plain text either way: converts when the body looks like HTML. */
export function toPlainText(body: string): string {
  return looksLikeHtml(body) ? htmlToText(body) : decodeEntities(body).replace(/\r\n/g, "\n").trim();
}

/** Collapses whitespace and cuts to `max` characters (with an ellipsis). */
export function snippetOf(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Splits an address header on commas outside quotes and angle brackets. */
function splitAddresses(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "<") angle++;
    else if (!quoted && char === ">") angle = Math.max(0, angle - 1);
    if ((char === "," || char === ";") && !quoted && angle === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** One address: `Name <a@b.c>`, `"Last, First" <a@b.c>` or `a@b.c`; null when there is no address. */
export function parseAddress(value: string): MailAddress | null {
  const trimmed = value.trim();
  const angle = /^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(trimmed);
  if (angle) {
    const name = decodeEntities(
      (angle[1] ?? "")
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim(),
    );
    const address = (angle[2] ?? "").toLowerCase();
    return name && name.toLowerCase() !== address ? { name, address } : { address };
  }
  const bare = /([^\s<>"]+@[^\s<>"]+)/.exec(trimmed);
  return bare?.[1] ? { address: bare[1].toLowerCase() } : null;
}

/** An address list header (or an array of strings / Graph recipients) into lowercase addresses. */
export function parseAddressList(value: unknown): MailAddress[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => parseAddressList(item));
  if (typeof value === "object") {
    const graph = graphRecipient(value);
    return graph ? [graph] : [];
  }
  if (typeof value !== "string") return [];
  return splitAddresses(value)
    .map(parseAddress)
    .filter((address): address is MailAddress => address !== null);
}

/** A Microsoft Graph recipient (`{ emailAddress: { name, address } }`). */
export function graphRecipient(value: unknown): MailAddress | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const inner = (record.emailAddress ?? record.email_address ?? record) as Record<string, unknown>;
  const address = typeof inner.address === "string" ? inner.address.trim().toLowerCase() : "";
  if (!address.includes("@")) return null;
  const name = typeof inner.name === "string" ? inner.name.trim() : "";
  return name && name.toLowerCase() !== address ? { name, address } : { address };
}

/**
 * A date as ISO 8601: accepts ISO strings, RFC 2822 headers and epoch
 * milliseconds or seconds (number or numeric string). Null when unreadable.
 */
export function toIsoDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  let date: Date;
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()))) {
    const n = Number(value);
    date = new Date(n < 1e12 ? n * 1000 : n);
  } else if (typeof value === "string") {
    date = new Date(value);
  } else return null;
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Decodes base64 or base64url (padding optional). */
export function decodeBase64(data: string): Uint8Array {
  const normal = data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

/** Decodes a base64url body to UTF-8 text. */
export function decodeBase64Text(data: string): string {
  return new TextDecoder().decode(decodeBase64(data));
}
