import type { TFunction } from "i18next";
import type { AccountDeletionPlan, AuthConfig, DeletionProofInput, OrgDeletion, OrgSummary } from "../api/types";
import { formatInt, formatShortDate, formatTime, joinNames } from "./format";
import { settingUp } from "./guards";
import { CODE_LENGTH, sendsEmail } from "./join-requests";
import { matchesName } from "./text";

/** Days a deleted workspace stays read-only and restorable (the engine's `WORKSPACE_DELETION_DAYS`). */
export const DELETION_DAYS = 7;

/** When a workspace deleted at `now` goes for good. */
export const deletionDueFrom = (now = new Date()) => new Date(now.getTime() + DELETION_DAYS * 86_400_000).toISOString();

/** Whether this person may restore the workspace now: an owner, before its date (`dueAt` is null once it passed). */
export const restorable = (org: Pick<OrgSummary, "role" | "deletion">, now = Date.now()) =>
  org.role === "owner" && !!org.deletion?.dueAt && Date.parse(org.deletion.dueAt) > now;

/** When it goes for good, while that's still ahead. */
const dueDate = (deletion: Pick<OrgDeletion, "dueAt">, now: number) =>
  deletion.dueAt && Date.parse(deletion.dueAt) > now ? deletion.dueAt : null;

/** The line on top of a workspace being deleted: when it goes while that's ahead, else only that it's going. */
export function deletingText(t: TFunction, locale: string, name: string, deletion: OrgDeletion, now = Date.now()) {
  const due = dueDate(deletion, now);
  return due ? t("deleting.banner", { name, date: formatShortDate(locale, due) }) : t("deleting.title", { name });
}

/** Who deleted it and when, under that line: "Você" for the person who did (`meId`). */
export function deletedByText(t: TFunction, locale: string, deletion: OrgDeletion, meId?: string): string | null {
  if (!deletion.requestedAt) return null;
  const date = formatShortDate(locale, deletion.requestedAt);
  if (meId && deletion.requestedBy?.id === meId) return t("deleting.byYou", { date });
  return t("deleting.by", { by: deletion.requestedBy?.name || t("deleting.someone"), date });
}

/**
 * The settings sections (the web's ids, which the phone's share) that stay as ever while the workspace is being
 * deleted (ADR 0088 §7): the person's own, what only reads, what is mostly read through rows and tabs (the Vault,
 * roles, skills, the agents' access: their writes are refused in words), taking its data out (import and export) and
 * its billing.
 */
export const SETTINGS_OPEN_WHILE_DELETING: ReadonlySet<string> = new Set([
  "account",
  "notifications",
  "approvals",
  "usage",
  "audit",
  "import",
  "billing",
  "about",
  "vault",
  "roles",
  "skills",
  "access",
]);

/** A settings section greyed out: the workspace is being deleted and the section would change it. */
export const settingsFrozen = (org: { deletion?: unknown } | null | undefined, section: string) =>
  !!org?.deletion && !SETTINGS_OPEN_WHILE_DELETING.has(section);

/** What `settingUp` and the standing read of a workspace, and no more: the phone's lists carry narrower rows. */
interface WorkspaceState {
  id: string;
  role?: string;
  onboarding?: unknown;
  deletion?: unknown;
  standing?: { state: string };
}

/**
 * A workspace that opens: not suspended and not still being set up. One being deleted opens too, read-only until it
 * goes (ADR 0088 §7).
 */
export const workspaceOpens = (org: WorkspaceState) => org.standing?.state !== "suspended" && !settingUp(org);

/**
 * Whether the suspended screen or the onboarding must offer deleting the account: it lives in Sua conta, inside a
 * workspace that opens, and with none this is the only way to it (App Store 5.1.1(v), ADR 0035).
 */
export const accountOutOfReach = (orgs: readonly WorkspaceState[]) => !orgs.some(workspaceOpens);

/** Where the suspended screen sends the person: their other workspaces, none suspended, those that open first. */
export function otherWorkspaces<O extends WorkspaceState>(orgs: readonly O[], orgId: string): O[] {
  const others = orgs.filter((o) => o.id !== orgId && o.standing?.state !== "suspended");
  return [...others.filter(workspaceOpens), ...others.filter((o) => !workspaceOpens(o))];
}

/**
 * The workspaces a person could delete instead of their account (ADR 0088 §1): theirs to delete, and not closed. One
 * still being set up counts: its onboarding deletes it (`soleOwnerWaysOut`).
 */
export const deletableWorkspaces = <O extends WorkspaceState>(orgs: readonly O[]) =>
  orgs.filter((o) => o.role === "owner" && !o.deletion && o.standing?.state !== "suspended");

type ListedWorkspace = Pick<OrgSummary, "id" | "name" | "createdAt" | "standing"> & {
  deletion?: Pick<OrgDeletion, "dueAt">;
};

/**
 * What a list says beside a workspace's name, by id: a closed one says so wherever it is, with its date when it's being
 * deleted. Two of a person's workspaces with the same name differ by that, else by when each was made (down to the time
 * when that's the same day). Any other workspace has no entry, so it looks as it always did.
 */
export function workspaceNotes(t: TFunction, locale: string, orgs: readonly ListedWorkspace[], now = Date.now()) {
  const state = ({ deletion, standing }: ListedWorkspace) => {
    if (deletion) {
      const due = dueDate(deletion, now);
      return due ? t("deleting.row", { date: formatShortDate(locale, due) }) : t("deleting.rowLate");
    }
    return standing?.state === "suspended" ? t("standing.row") : null;
  };
  const day = ({ createdAt }: ListedWorkspace) => (createdAt ? formatShortDate(locale, createdAt) : null);
  const made = (org: ListedWorkspace, twins: ListedWorkspace[]) => {
    if (!org.createdAt) return null;
    const sameDay = twins.some((o) => day(o) === day(org));
    const date = sameDay ? `${day(org)}, ${formatTime(locale, org.createdAt)}` : day(org);
    return t("shell.createdOn", { date });
  };
  const notes = new Map<string, string>();
  for (const org of orgs) {
    const said = state(org);
    const twins = orgs.filter((o) => o.id !== org.id && matchesName(o.name, org.name));
    const note = [said, twins.some((o) => state(o) === said) ? made(org, twins) : null].filter(Boolean).join(" · ");
    if (note) notes.set(org.id, note);
  }
  return notes;
}

/** A workspace's name in a flat list (a button, a select, a native menu), with its note from `workspaceNotes`. */
export const workspaceLabel = (name: string, note: string | undefined) => (note ? `${name} (${note})` : name);

/** The waiting screen's line: when the account goes for good, while that's still ahead. */
export function accountDeletingText(t: TFunction, locale: string, dueAt: string | null, now = Date.now()) {
  return dueAt && Date.parse(dueAt) > now
    ? t("accountDeleting.text", { due: formatShortDate(locale, dueAt) })
    : t("accountDeleting.textLate");
}

/** What proves it's the person before deleting: a code emailed to them, their password, or a password added first. */
export type DeletionProof = "code" | "password" | "addPassword";

/**
 * The proof deleting takes (ADR 0088 §2): a code emailed to the person where the server sends email, else their
 * password, which an account without one adds first.
 */
export const deletionProof = (
  config: Pick<AuthConfig, "passwordReset"> | undefined,
  hasPassword: boolean | undefined,
): DeletionProof => (sendsEmail(config) ? "code" : hasPassword === false ? "addPassword" : "password");

/** What the deletion sends as its proof, and whether it can yet: all the code's digits once one went out, or a password. */
export function proofToSend(kind: DeletionProof, typed: { sent: boolean; code: string; password: string }) {
  const input: DeletionProofInput =
    kind === "code" ? { code: typed.code } : kind === "password" ? { password: typed.password } : {};
  const ready =
    kind === "code" ? typed.sent && typed.code.length === CODE_LENGTH : kind === "password" && typed.password !== "";
  return { input, ready };
}

/** One line of what deleting the account does, by what it is about (the apps pick an icon for each). */
export interface AccountDeletionLine {
  kind: "when" | "closes" | "leaves" | "computers" | "staysBehind" | "plan" | "messages" | "serverOwner";
  text: string;
  /** What stays behind (`staysBehind`), each with the settings section of its workspace where it is disconnected. */
  links?: { label: string; orgId: string; section: "usage" | "connectors" }[];
}

/** Where a key, a connection, a mailbox or a database someone added is disconnected: its workspace's settings. */
export const staysBehindSection = (kind: AccountDeletionPlan["staysBehind"][number]["kind"]) =>
  kind === "key" ? ("usage" as const) : ("connectors" as const);

/**
 * The ways out of a workspace that keeps the account (`soleOwner`), as the web app's paths: make someone else an
 * owner, or delete it. One still being set up has neither page yet: its onboarding is where it's finished, and where
 * it's deleted.
 */
export const soleOwnerWaysOut = (orgId: string, settingUp: boolean) =>
  settingUp
    ? { people: "/onboarding", delete: "/onboarding?delete=1" }
    : { people: `/org/${orgId}/settings/members`, delete: `/org/${orgId}/settings/general?delete=1` };

/**
 * What a workspace that closes with the account holds, in words: "3 agentes e 40 mensagens" with `common`'s list,
 * null when it holds nothing, undefined from an older server, which doesn't say.
 */
function contentsText(t: TFunction, locale: string, org: AccountDeletionPlan["closes"][number]) {
  if (org.agents === undefined || org.messages === undefined) return undefined;
  const parts = [
    org.agents > 0 ? t("deleteAccount.agentCount", { count: org.agents, value: formatInt(locale, org.agents) }) : "",
    org.messages > 0
      ? t("deleteAccount.messageCount", { count: org.messages, value: formatInt(locale, org.messages) })
      : "",
  ].filter(Boolean);
  return parts.length > 0 ? joinNames(parts, t) : null;
}

/**
 * What deleting the account does, in the person's words, from its preflight: when it goes and how to come back before
 * that, each workspace that closes with it and what it holds (one being deleted already on its own date) and those they leave, per workspace the computers removed
 * and what stays behind with where to disconnect each, where plans are billed (`billing`) that those they pay for stop
 * renewing with nothing refunded, that their messages stay, and, on a self-hosted server they set up, that its settings
 * lose their owner here. `notes` (`workspaceNotes`) tells apart those with the same name.
 */
export function accountDeletionLines(
  t: TFunction,
  locale: string,
  plan: AccountDeletionPlan,
  {
    cloud,
    billing = false,
    now = new Date(),
    notes,
  }: { cloud: boolean; billing?: boolean; now?: Date; notes?: ReadonlyMap<string, string> },
): AccountDeletionLine[] {
  const label = (org: { id: string; name: string }) => workspaceLabel(org.name, notes?.get(org.id));
  const names = (items: { name: string }[]) =>
    joinNames(
      items.map((i) => i.name),
      t,
    );
  const orgName = (orgId: string) => {
    const org = plan.leaves.find((o) => o.id === orgId);
    return org ? label(org) : "";
  };
  const byOrg = <T extends { orgId: string }>(items: T[]) => {
    const groups = new Map<string, T[]>();
    for (const item of items) groups.set(item.orgId, [...(groups.get(item.orgId) ?? []), item]);
    return [...groups];
  };
  const date = formatShortDate(locale, deletionDueFrom(now));
  const lines: AccountDeletionLine[] = [{ kind: "when", text: t("deleteAccount.when", { date }) }];
  for (const org of plan.closes) {
    if (org.deletion) continue;
    const what = contentsText(t, locale, org);
    const name = label(org);
    const text =
      what === undefined
        ? t("deleteAccount.closes", { name, date })
        : what === null
          ? t("deleteAccount.closesEmpty", { name, date })
          : t("deleteAccount.closesWith", { name, what, date });
    lines.push({ kind: "closes", text });
  }
  for (const { name, deletion } of plan.closes) {
    if (!deletion) continue;
    const text = deletion.dueAt
      ? t("deleteAccount.closing", { name, date: formatShortDate(locale, deletion.dueAt) })
      : t("deleteAccount.closingLate", { name });
    lines.push({ kind: "closes", text });
  }
  if (plan.leaves.length > 0)
    lines.push({ kind: "leaves", text: t("deleteAccount.leaves", { names: joinNames(plan.leaves.map(label), t) }) });
  for (const [orgId, computers] of byOrg(plan.computers)) {
    const text = t("deleteAccount.computers", {
      count: computers.length,
      name: orgName(orgId),
      computers: names(computers),
    });
    lines.push({ kind: "computers", text });
  }
  for (const [orgId, items] of byOrg(plan.staysBehind))
    lines.push({
      kind: "staysBehind",
      text: t("deleteAccount.staysBehind", { name: orgName(orgId) }),
      links: items.map((item) => ({
        label: t("deleteAccount.disconnect", { name: item.name }),
        orgId,
        section: staysBehindSection(item.kind),
      })),
    });
  if (billing && plan.closes.length + plan.leaves.length > 0)
    lines.push({ kind: "plan", text: t("deleteAccount.plan") });
  lines.push({ kind: "messages", text: t("deleteAccount.messages") });
  if (plan.serverOwner && !cloud) lines.push({ kind: "serverOwner", text: t("deleteAccount.serverOwner") });
  return lines;
}
