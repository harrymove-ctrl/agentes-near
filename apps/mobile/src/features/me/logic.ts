import { ApiError, type StartChoice } from "@agenteschat/client";
import { startPlace } from "@agenteschat/client/lib/home";

/**
 * Você's pure logic: the Conta form (what changed, what is wrong with it, the server's error as our
 * text), the photo's upload type and the app's version line.
 */

/** A person's @ (the server's rule, `PERSON_HANDLE_PATTERN`): 2 to 32 lowercase letters, numbers, - or _. */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** "  @Ana " → "ana" (what the server stores). */
export const normalizeHandle = (value: string) => value.trim().replace(/^@/, "").toLowerCase();

export interface AccountDraft {
  name: string;
  handle: string;
  /** IANA zone; null = the workspace's. */
  zone: string | null;
}

export type AccountProblem = "nameEmpty" | "handleInvalid";

/** What is wrong with the form (shown under it; OK stays off). */
export function accountProblem(draft: AccountDraft): AccountProblem | null {
  if (!draft.name.trim()) return "nameEmpty";
  if (!HANDLE_PATTERN.test(normalizeHandle(draft.handle))) return "handleInvalid";
  return null;
}

/** The calls Conta's OK makes: the name (the account) and the @ and zone (this workspace), only if changed. */
export function accountChanges(
  initial: AccountDraft,
  draft: AccountDraft,
): { name?: string; profile?: { handle?: string; timezone?: string | null } } {
  const out: { name?: string; profile?: { handle?: string; timezone?: string | null } } = {};
  const name = draft.name.trim();
  if (name !== initial.name.trim()) out.name = name;
  const handle = normalizeHandle(draft.handle);
  const profile: { handle?: string; timezone?: string | null } = {};
  if (handle !== normalizeHandle(initial.handle)) profile.handle = handle;
  if (draft.zone !== initial.zone) profile.timezone = draft.zone;
  if (Object.keys(profile).length > 0) out.profile = profile;
  return out;
}

/** The server's error code for a handle as our text's key (`mobile.me.account.*`); null = the generic one. */
export function handleErrorKey(code: string | undefined): "handleInvalid" | "handleTaken" | "handleAgent" | null {
  if (code === "handle.invalid") return "handleInvalid";
  if (code === "handle.taken") return "handleTaken";
  if (code === "handle.taken_by_agent") return "handleAgent";
  return null;
}

/**
 * The type the photo upload accepts (JPEG, PNG or WebP). The server checks the bytes against the declared type, and
 * the picker's crop re-encodes to JPEG while it may still report the source's type (a PNG logo comes back as JPEG
 * bytes named PNG), so the bytes decide first; the reported type and the name only when there are no bytes.
 */
export function photoContentType(
  mimeType: string | null | undefined,
  fileName?: string | null,
  base64?: string | null,
): "image/jpeg" | "image/png" | "image/webp" {
  const head = (base64 ?? "").replace(/^data:[^;]+;base64,/, "").slice(0, 16);
  if (head.startsWith("/9j/")) return "image/jpeg";
  if (head.startsWith("iVBORw0KGgo")) return "image/png";
  if (head.startsWith("UklGR")) return "image/webp";
  const mime = mimeType?.toLowerCase() ?? "";
  const ext = fileName?.toLowerCase().split(".").pop() ?? "";
  if (mime === "image/png" || (!mime && ext === "png")) return "image/png";
  if (mime === "image/webp" || (!mime && ext === "webp")) return "image/webp";
  return "image/jpeg";
}

/**
 * The upload's limit in base64 characters: the server takes up to 2 MB of image (`AVATAR_LIMITS`), which is
 * 2,796,204 characters of base64; its own 3,000,000-character cap on the field is looser than the image's.
 */
export const PHOTO_MAX_BASE64 = 2_796_000;

/** "N com você" in Do workspace: open issues (not done or canceled) assigned to me. */
export function openIssuesWithMe(
  issues: readonly { status: string; assignee: { type: string; id: string } | null }[] | undefined,
  meId: string | null,
): number {
  if (!issues || !meId) return 0;
  return issues.filter(
    (i) => i.assignee?.type === "person" && i.assignee.id === meId && i.status !== "done" && i.status !== "canceled",
  ).length;
}

/**
 * A server from before account deletion had a preflight (`GET /account/deletion` answers 404): it deletes with no
 * proof within 10 minutes of a sign-in and says the rest itself, so the screen falls back to its fixed lines and the
 * hold (pure).
 */
export const preflightMissing = (error: unknown) => error instanceof ApiError && error.status === 404;

// ── What opens when the app starts (ADR 0108) ───────────────────────────────

/** The last conversation opened in each workspace on this phone (`STORED.lastPlace`, JSON by workspace id). */
export function placesOf(raw: string | null): Record<string, string> {
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The places with this workspace's set to `href` (a conversation's link). */
export const withPlace = (raw: string | null, orgId: string, href: string) =>
  JSON.stringify({ ...placesOf(raw), [orgId]: href });

/** The conversation a link opens (`/chat/<channelId>?thread=…`), if it is one. */
export const chatChannelOf = (href: string) => /^\/chat\/([^/?#]+)/.exec(href)?.[1] ?? null;

/** Whether I'm in a conversation: one of my channels, or one of my DMs (`GET /channels` lists no DM). */
export function inConversation(
  channels: readonly { id: string; isMember: boolean }[],
  dms: readonly { channelId: string }[],
): (channelId: string) => boolean {
  const mine = new Set([...channels.filter((c) => c.isMember).map((c) => c.id), ...dms.map((d) => d.channelId)]);
  return (id) => mine.has(id);
}

/**
 * What the app pushes over Conversas when it starts: the chosen channel, or the last conversation opened here, while
 * the person is still in it; null for Conversas itself.
 */
export function startHref(
  choice: StartChoice | undefined,
  places: string | null,
  orgId: string,
  inChannel: (channelId: string) => boolean,
): string | null {
  const last = placesOf(places)[orgId];
  const lastChannel = typeof last === "string" ? chatChannelOf(last) : null;
  const place = startPlace(choice, { last: lastChannel && inChannel(lastChannel) ? (last ?? null) : null, inChannel });
  if (place.kind === "channel") return `/chat/${place.channelId}`;
  return place.kind === "last" ? place.place : null;
}

/**
 * The workspaces beyond the one open, for Você's workspace row (ADR 0154): how many more there are, over the
 * servers signed in to, and on how many other servers they sit (0: all on this one). A server that didn't answer
 * counts as another server with nothing known of it, so the row still says there is more elsewhere.
 */
export function workspacesBeyond(
  groups: readonly { current: boolean; orgs: readonly { id: string }[]; failed: boolean }[],
  openOrgId: string | null,
): { others: number; servers: number } {
  let others = 0;
  let servers = 0;
  for (const g of groups) {
    const here = g.orgs.filter((o) => !(g.current && o.id === openOrgId)).length;
    others += here;
    if (!g.current && (here > 0 || g.failed)) servers += 1;
  }
  return { others, servers };
}
