/**
 * A message's permalink, shared by the server (links agents write and tools return), the web ("Copiar link da
 * mensagem", the pill a pasted link becomes) and the phone (its sheet, its pill, its app links): a thread's reply opens
 * in its thread, every other message (a channel's, a DM's) in its conversation, at that message (`?m=`). A file's
 * link the same way (`filePath`, `parseFileLink`).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MessagePlace {
  id: string;
  channelId: string;
  /** The thread a reply is in; a thread's root (and any other message) has none. */
  threadId?: string | null;
}

/** `/org/<org>/c/<channel>?m=<id>`, or `/org/<org>/threads/<thread>?m=<id>` for a reply. */
export function messagePath(orgId: string, m: MessagePlace): string {
  return m.threadId && m.threadId !== m.id
    ? `/org/${orgId}/threads/${m.threadId}?m=${m.id}`
    : `/org/${orgId}/c/${m.channelId}?m=${m.id}`;
}

export interface MessageLink {
  orgId: string;
  messageId: string;
  /** One of the two: where the link opens. */
  channelId: string | null;
  threadId: string | null;
}

/**
 * A message permalink (`messagePath`) in `href`: a path, or a full address on one of `origins` (this server's). Null
 * for anything else, another server's address included.
 */
export function parseMessageLink(href: string, origins: readonly string[] = []): MessageLink | null {
  const match = /^(https?:\/\/[^/?#]+)?(\/org\/[^?#]+)\?([^#]*)(#.*)?$/i.exec(href.trim());
  if (!match) return null;
  const [, origin, path = "", query = ""] = match;
  if (origin && !origins.some((o) => o.replace(/\/+$/, "").toLowerCase() === origin.toLowerCase())) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 4) return null;
  const [, orgId = "", kind, placeId = ""] = parts;
  const messageId = /(?:^|&)m=([^&]*)/.exec(query)?.[1] ?? "";
  if (!UUID.test(orgId) || !UUID.test(placeId) || !UUID.test(messageId)) return null;
  if (kind === "c") return { orgId, messageId, channelId: placeId, threadId: null };
  if (kind === "threads") return { orgId, messageId, channelId: null, threadId: placeId };
  return null;
}

/** A file's address in the app (ADR 0157): the Drive with the file open, at a version when given. */
export function filePath(orgId: string, artifactId: string, version?: number | null): string {
  return `/org/${orgId}/drive?artifact=${artifactId}${version ? `&v=${version}` : ""}`;
}

export interface FileLink {
  orgId: string;
  artifactId: string;
  /** The version it names; null for the latest. */
  version: number | null;
}

/**
 * A file's link in `href`: the app's (`filePath`), or the API's address of its bytes or its download
 * (`/api/app/organizations/<org>/artifacts/<id>/file?version=…`, which a browser's downloads keep), as a path or a
 * full address on one of `origins` (this server's). Null for anything else.
 */
export function parseFileLink(href: string, origins: readonly string[] = []): FileLink | null {
  const match = /^(https?:\/\/[^/?#]+)?(\/[^?#]*)(?:\?([^#]*))?(#.*)?$/i.exec(href.trim());
  if (!match) return null;
  const [, origin, path = "", query = ""] = match;
  if (origin && !origins.some((o) => o.replace(/\/+$/, "").toLowerCase() === origin.toLowerCase())) return null;
  const param = (name: string) => new RegExp(`(?:^|&)${name}=([^&]*)`).exec(query)?.[1] ?? "";
  const app = /^\/org\/([^/]+)\/drive\/?$/.exec(path);
  const api = /^\/api\/app\/organizations\/([^/]+)\/artifacts\/([^/]+)\/(?:file|download)\/?$/.exec(path);
  const orgId = app?.[1] ?? api?.[1] ?? "";
  const artifactId = app ? param("artifact") : (api?.[2] ?? "");
  if (!UUID.test(orgId) || !UUID.test(artifactId)) return null;
  const version = Number(param(app ? "v" : "version"));
  return { orgId, artifactId, version: Number.isInteger(version) && version > 0 ? version : null };
}
