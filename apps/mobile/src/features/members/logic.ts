import type {
  BatchInviteResult,
  Channel,
  InvitationWithStatus,
  JoinRequest,
  Member,
  OrgRole,
  Person,
} from "@agenteschat/client";
import {
  daysBetween,
  formatShortDate,
  lowerFirst,
  namesText,
  relativeTime,
  timeLeft,
} from "@agenteschat/client/lib/format";
import { askedLabel } from "@agenteschat/client/lib/join-requests";
import { personalRoleKey } from "@agenteschat/client/lib/personal-view";
import { grants, rolesOf } from "@agenteschat/client/lib/roles";
import { addressesIn } from "@agenteschat/client/lib/text";
import type { TFunction } from "i18next";

/** "agora", "há 2 h", "ontem", "em 22 out": when something happened, to follow a verb. */
export function whenWords(t: TFunction, locale: string, iso: string, now = new Date()) {
  if (daysBetween(iso, now) > 1) return t("members.when.on", { date: formatShortDate(locale, iso) });
  return relativeTime(t, locale, iso, now);
}

/**
 * A request to join's chips, as on the web: "Not verified" only where nobody proved the address (a server without
 * email, or a request typed before codes), then when it was asked. A server from before codes sends only
 * `confirmed`, which meant the same there. A member's suggestion says who made it instead: nobody at that address
 * asked, and approving it sends the email invitation, so its address has nothing to prove here (ADR 0090 §7).
 */
export function requestChips(
  t: TFunction,
  locale: string,
  r: Pick<JoinRequest, "createdAt" | "verified" | "confirmed" | "suggestedBy">,
  now = new Date(),
): { unverified: string | null; asked: string } {
  const by = r.suggestedBy ?? null;
  return {
    unverified: by || (r.verified ?? r.confirmed) ? null : t("members.requests.unverified"),
    asked: by
      ? t("members.requests.suggested", { name: by, when: whenWords(t, locale, r.createdAt, now) })
      : askedLabel(t, locale, r.createdAt, now),
  };
}

/** A waiting request's line on Membros: how it came, the address, and that nobody proved it. */
export function waitingLine(
  t: TFunction,
  locale: string,
  r: Pick<JoinRequest, "email" | "createdAt" | "verified" | "confirmed" | "suggestedBy">,
  now = new Date(),
) {
  const when = whenWords(t, locale, r.createdAt, now);
  const how = r.suggestedBy
    ? t("members.requests.suggested", { name: r.suggestedBy, when })
    : t("members.requests.viaLink", { when });
  const { unverified } = requestChips(t, locale, r, now);
  return [how, r.email, unverified ? lowerFirst(unverified, locale) : null].filter(Boolean).join(" · ");
}

/** The tapped request on top of the review, the others as they came. */
export function focusedFirst<R extends { id: string }>(requests: readonly R[], focus: string | undefined): R[] {
  return [...requests].sort((a, b) => (a.id === focus ? 0 : 1) - (b.id === focus ? 0 : 1));
}

/** The people of the workspace as Membros lists them: by name, in the person's language's order. */
export function membersByName<M extends { name: string }>(members: readonly M[], locale?: string): M[] {
  return [...members].sort((a, b) => a.name.localeCompare(b.name, locale, { sensitivity: "base" }));
}

/**
 * A person's roles on Membros (ADR 0085): "Dono" first for an owner, then their roles top first, joined; nothing for
 * someone with no role (what everyone may do goes without saying).
 */
export function roleLine(
  t: TFunction,
  person: Pick<Member, "role" | "roleIds">,
  roles: readonly OrgRole[],
): string | undefined {
  const names = [...(person.role === "owner" ? [t("roles.owner")] : []), ...rolesOf(person, roles).map((r) => r.name)];
  return names.length > 0 ? names.join(" · ") : undefined;
}

/** A person's line on Membros: their @handle, their roles ("Membro" with none), then when they were last here. */
export function memberLine(
  t: TFunction,
  locale: string,
  person: Pick<Person, "role" | "roleIds" | "online" | "lastSeenAt" | "joinedAt"> & { handle?: string },
  roles: readonly OrgRole[],
  now = new Date(),
) {
  const handle = person.handle ? `@${person.handle} · ` : "";
  const seen = person.online
    ? t("members.activeNow")
    : person.lastSeenAt
      ? t("members.seen", { when: relativeTime(t, locale, person.lastSeenAt, now) })
      : t("members.joined", { when: formatShortDate(locale, person.joinedAt) });
  return `${handle}${roleLine(t, person, roles) ?? t("roles.member")} · ${lowerFirst(seen, locale)}`;
}

/** The people who may invite here (ADR 0085): the owners, and whoever holds a role that gives it. */
export function invitersOf(people: readonly Pick<Person, "name" | "role" | "roleIds">[], roles: readonly OrgRole[]) {
  return people
    .filter((p) => p.role === "owner" || rolesOf(p, roles).some((r) => grants(r.permissions).has("invite_people")))
    .map((p) => p.name);
}

/** The invitations that still work, the newest first; past its date one no longer opens, whatever the list says. */
export function pendingInvitations<I extends Pick<InvitationWithStatus, "status" | "expiresAt" | "createdAt">>(
  invitations: readonly I[],
  now = new Date(),
): I[] {
  return invitations
    .filter((i) => i.status === "pending" && new Date(i.expiresAt).getTime() > now.getTime())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The names of an invitation's roles ("Admin, Financeiro"), "Membro" with none. */
export function invitationRoles(
  t: TFunction,
  invitation: Pick<InvitationWithStatus, "role" | "roleIds">,
  roles: readonly OrgRole[],
) {
  if (invitation.role === "owner") return t("roles.owner");
  const names = roles.filter((r) => (invitation.roleIds ?? []).includes(r.id)).map((r) => r.name);
  return names.length > 0 ? names.join(", ") : t("roles.member");
}

/** Who sent an invitation, for its sheet: "convite seu" for the person looking. */
export function invitationSender(
  t: TFunction,
  invitation: Pick<InvitationWithStatus, "invitedBy">,
  me: string | null | undefined,
) {
  if (!invitation.invitedBy) return null;
  return invitation.invitedBy === me
    ? t("members.invitations.mine")
    : t("members.invitations.by", { name: invitation.invitedBy });
}

/** A sent invitation's line: its roles, who sent it (on its sheet), then when it stops working. */
export function invitationLine(
  t: TFunction,
  locale: string,
  invitation: Pick<InvitationWithStatus, "role" | "roleIds" | "expiresAt">,
  roles: readonly OrgRole[],
  extra: { resentUntil?: string | undefined; sender?: string | null | undefined } = {},
  now = new Date(),
) {
  const state = extra.resentUntil
    ? t("members.invitations.resentState", { date: formatShortDate(locale, extra.resentUntil) })
    : t("members.invitations.expires", { left: timeLeft(t, invitation.expiresAt, now) ?? "" });
  return [invitationRoles(t, invitation, roles), extra.sender, lowerFirst(state, locale)].filter(Boolean).join(" · ");
}

/**
 * The keys of what a sent invitation's actions say: a server that sends no email sends nothing again, the same link
 * for longer. One sent before links lasted gets a new link instead, and its old one stops opening (ADR 0090).
 */
export const sentWords = (emails: boolean) =>
  emails
    ? ({ copied: "copied", resent: "resent", newLink: "newLink" } as const)
    : ({ copied: "copiedNoEmail", resent: "resentNoEmail", newLink: "newLinkNoEmail" } as const);

/**
 * The role an address joins with, in Invite people's words: its name, or Member with none. A personal workspace says
 * its two plain choices instead (ADR 0159 §4, `personalRoleKey`): "Uses the agents" for none (or a role no longer
 * there) and "Helps you run it" for its helper role; any other role still by its name. Only the words: the same role.
 */
export function joinRoleWord(t: TFunction, roles: readonly OrgRole[], roleId: string | null, personal: boolean) {
  const role = roles.find((r) => r.id === roleId) ?? null;
  const plain = personal ? personalRoleKey(roles, role?.id ?? null) : null;
  return plain ? t(plain) : (role?.name ?? t("roles.member"));
}

/** An address on Convidar pessoas and the role it joins with (`null`: a member, no role past everyone's). */
export interface InviteAddress {
  email: string;
  valid: boolean;
  roleId: string | null;
}

/** The addresses with the new ones in `text` after them, read the way mail apps and spreadsheets paste them. */
export function withAddresses(addresses: readonly InviteAddress[], text: string): InviteAddress[] {
  const seen = new Set(addresses.map((a) => a.email));
  return [
    ...addresses,
    ...addressesIn(text)
      .filter((a) => !seen.has(a.email))
      .map((a) => ({ ...a, roleId: null })),
  ];
}

/**
 * What the field holds after a change (the phone has no paste event, so a paste shows as many characters at once
 * that make a list): a paste or a separator typed at the end hands all of it to `withAddresses`.
 */
export function readTyped(before: string, after: string): { add: string; keep: string } {
  if (!after.replace(/[\s,;]/g, "")) return { add: "", keep: "" };
  const pasted = after.length - before.length > 1 && /[\s,;<]/.test(after.trim());
  return pasted || /[\s,;]$/.test(after) ? { add: after, keep: "" } : { add: "", keep: after };
}

/** What becomes of an address: goes out, needs fixing, or is left out for being in or invited already. */
export function addressState(
  address: Pick<InviteAddress, "email" | "valid">,
  members: ReadonlySet<string>,
  invited: ReadonlySet<string>,
): "ok" | "bad" | "member" | "invited" {
  if (!address.valid) return "bad";
  return members.has(address.email) ? "member" : invited.has(address.email) ? "invited" : "ok";
}

/** Who stays after sending: only addresses to fix (someone in or invited already was just said). */
export function addressesLeft(addresses: readonly InviteAddress[], results: readonly BatchInviteResult[]) {
  const fix = new Set(results.filter((r) => r.status === "invalid_email").map((r) => r.email));
  return addresses.filter((a) => !a.valid || fix.has(a.email));
}

/** The one toast of a batch (the phone shows one at a time): what went out, then whatever was refused and why. */
export function batchNews(
  t: TFunction,
  results: readonly BatchInviteResult[],
  channels: readonly string[],
): { title: string; subtitle?: string; failed: boolean } | null {
  const sent = results.filter((r) => r.status === "invited");
  const refused = results
    .filter((r) => r.status !== "invited")
    .map((r) => t(`members.batch.${r.status}`, { email: r.email }));
  const names = namesText(t, [...channels], channels.length);
  const also = channels.length > 0 ? t("members.dialog.alsoIn", { channels: names }) : null;
  const first = sent[0];
  const [title, ...rest] = first
    ? [
        sent.length === 1
          ? t("members.dialog.sent", { email: first.email })
          : t("members.dialog.sentMany", { count: sent.length }),
        ...(also ? [also] : []),
        ...refused,
      ]
    : refused;
  if (!title) return null;
  return { title, ...(rest.length > 0 ? { subtitle: rest.join(" ") } : {}), failed: !first };
}

/** The channels they can be added to, as on the web: the public ones and the private ones I'm in; #general always. */
export function offeredChannels<C extends Pick<Channel, "id" | "name" | "visibility" | "isMember">>(
  channels: readonly C[],
) {
  const general = channels.find((c) => c.name === "general");
  return {
    general,
    others: channels.filter((c) => c.id !== general?.id && (c.visibility === "public" || c.isMember)),
  };
}

/** What a suggestion's refusal says, about the person suggested (the server's codes, ADR 0090 §7). */
export function suggestRefusal(code: string | null | undefined) {
  return SUGGEST_REFUSALS[code ?? ""];
}

const SUGGEST_REFUSALS: Record<string, "member" | "invited" | "waiting" | "full" | "invalid" | undefined> = {
  "join.member": "member",
  "join.invited": "invited",
  "join.waiting": "waiting",
  "join.full": "full",
  "join.invalid_email": "invalid",
};
