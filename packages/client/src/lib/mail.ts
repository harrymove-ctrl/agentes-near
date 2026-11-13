/**
 * Mailboxes for agents (ADR 0038): the rules the screens share. DOM-free.
 */

import type { TFunction } from "i18next";
import type { ApiClient } from "../api/client";
import { ApiError } from "../api/http";
import type {
  AgentMailbox,
  MailAccount,
  MailActionName,
  MailConnectError,
  MailPolicy,
  MailPreset,
  ToolDecision,
} from "../api/types";
import type { Level } from "./access-levels";
import { webmailOf } from "./text";
import type { ReviewTool } from "./tool-review";

/** The cards in the catalog's "Email" group. */
export type MailChoice = "gmail" | "outlook" | "icloud" | "other";

/** `Outro email` with no preset: the person types the servers (under "Avançado"). */
export const CUSTOM_PRESET = "custom";

/**
 * The mailboxes drawn with their maker's mark, by provider or IMAP preset (the catalog cards' names too): Gmail's
 * and iCloud's in one color (Simple Icons, CC0), Outlook's in Microsoft's colors. Any other mailbox is our envelope.
 */
export const MAIL_BRANDS: Partial<Record<string, { name: string; iconUrl: string; brandColor: string | null }>> = {
  gmail: { name: "Gmail", iconUrl: "/connectors/gmail.svg", brandColor: "#EA4335" },
  outlook: { name: "Outlook", iconUrl: "/brands/outlook.svg", brandColor: null },
  icloud: { name: "iCloud", iconUrl: "/connectors/icloud.svg", brandColor: "#3693F3" },
};

export const MAIL_ERRORS: MailConnectError[] = [
  "auth",
  "imap_unreachable",
  "smtp_unreachable",
  "tls",
  "blocked_host",
  "unknown",
];

/** The error code of a failed connect or reconnect (`422 { error }`); anything else is `unknown`. */
export function mailErrorOf(error: unknown): MailConnectError {
  if (error instanceof ApiError) {
    const code = error.code as MailConnectError;
    if (MAIL_ERRORS.includes(code)) return code;
  }
  return "unknown";
}

/** The catalog card a connected mailbox belongs to. */
export function choiceOf(account: Pick<MailAccount, "provider" | "preset">): MailChoice {
  if (account.provider === "gmail") return "gmail";
  if (account.provider === "outlook") return "outlook";
  return account.preset === "icloud" ? "icloud" : "other";
}

/** What to log in with for a preset: the address, or only the part before the @. */
export function loginOf(preset: Pick<MailPreset, "username"> | null | undefined, address: string): string {
  const a = address.trim();
  return preset?.username === "local" ? (a.split("@")[0] ?? a) : a;
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN = /^@[^\s@]+\.[^\s@]+$/;

export const isAddress = (value: string) => ADDRESS.test(value.trim());

/**
 * The webmail of an address that can't sign in to iCloud Mail ("Gmail"), even when it is the person's Apple
 * Account: the iCloud form's hint. Null for Apple's own domains and custom ones (iCloud+ domains are custom).
 */
export function notIcloudMail(address: string): string | null {
  const webmail = webmailOf(address);
  return webmail && webmail.name !== "iCloud Mail" ? webmail.name : null;
}

/** An address (`ana@empresa.com`) or a whole domain (`@empresa.com`). */
export const isAddressOrDomain = (value: string) => {
  const v = value.trim().toLowerCase();
  return ADDRESS.test(v) || DOMAIN.test(v);
};

/** Typed text → the addresses/domains in it (split on commas, spaces, semicolons), lowercased, valid only. */
export function splitAddresses(text: string): { valid: string[]; invalid: string[] } {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  return { valid: parts.filter(isAddressOrDomain), invalid: parts.filter((p) => !isAddressOrDomain(p)) };
}

/** Typed text → the email addresses in it (no `@domains`), lowercased; anything else is invalid. */
export function splitEmails(text: string): { valid: string[]; invalid: string[] } {
  const { valid, invalid } = splitAddresses(text);
  return { valid: valid.filter(isAddress), invalid: [...invalid, ...valid.filter((v) => !isAddress(v))] };
}

/** Every address a mailbox sends as: its own first, then its other addresses. */
export const mailboxAddresses = (account: Pick<MailAccount, "address" | "aliases">) => [
  ...new Set([account.address, ...account.aliases]),
];

/** The rules' "Enviar como" when the agent isn't pinned to one address. */
export const AUTO_FROM = "auto";

export const DEFAULT_DAILY_CAP = 25;

/** The connectors' level (Sem acesso · Ler · Ler e escrever) as the mail API says it. */
export const toMailLevel = (level: Level): AgentMailbox["level"] => (level === "write" ? "read_write" : level);
/** And back: the mail API's level as the connectors' (an agent without any is `none`). */
export const fromMailLevel = (level: AgentMailbox["level"] | undefined): Level =>
  level === "read_write" ? "write" : (level ?? "none");

/** Sets an agent's level on a mailbox and keeps its delete switch and rules there (what "Quem usa" changes). */
export async function setMailLevel(
  api: Pick<ApiClient, "mail">,
  orgId: string,
  agentId: string,
  accountId: string,
  level: Level,
) {
  const saved = (await api.mail.agent(orgId, agentId)).find((m) => m.accountId === accountId);
  return api.mail.setAgent(orgId, agentId, accountId, {
    level: toMailLevel(level),
    canDelete: saved?.canDelete ?? false,
    policy: saved?.policy ?? defaultPolicy(),
  });
}

/**
 * What a viewer may do with an agent's access to a mailbox (same rule as the backend): only who connected it gives
 * or widens it, to an agent that talks to them; whoever manages the agent (admins, its owner) may also take it away.
 */
export function mailAccessOf(
  account: Pick<MailAccount, "ownerUserId">,
  viewer: { userId: string | null; talks: boolean; managesAgent: boolean },
): { gives: boolean; removes: boolean } {
  const owns = !!viewer.userId && account.ownerUserId === viewer.userId;
  return { gives: owns && viewer.talks, removes: owns || viewer.managesAgent };
}

/** A new agent's rules for a mailbox: every folder, anyone, asks before each send. */
export const defaultPolicy = (): MailPolicy => ({
  folders: [],
  senders: [],
  windowDays: null,
  allowedRecipients: [],
  dailySendCap: DEFAULT_DAILY_CAP,
  sendWithoutAsking: false,
  fromAddress: null,
});

/** "Enviar sem pedir aprovação" needs "Só enviar para"; without it, it is off. */
export function normalizePolicy(policy: MailPolicy): MailPolicy {
  return policy.allowedRecipients.length === 0 && policy.sendWithoutAsking
    ? { ...policy, sendWithoutAsking: false }
    : policy;
}

export const canSendWithoutAsking = (policy: Pick<MailPolicy, "allowedRecipients">) =>
  policy.allowedRecipients.length > 0;

/** What the email connector does, grouped as the connect flow's step 2 shows it. */
export const MAIL_ACTIONS = {
  read: ["search", "read", "folders"],
  write: ["draft", "organize"],
  approval: ["send", "reply", "forward"],
  off: ["delete"],
} as const;

export type MailAction = (typeof MAIL_ACTIONS)[keyof typeof MAIL_ACTIONS][number];

/** The newest mailbox (back from Gmail/Outlook: the one that just came in). */
export function newestAccount(accounts: MailAccount[]): MailAccount | null {
  return [...accounts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

/** Each action's usual level and the levels it can take in "O que faz" (the standard tool review). */
const ACTION_LEVELS: Record<MailActionName, { level: "read" | "write" | "approval"; levels: ToolDecision[] }> = {
  search: { level: "read", levels: ["read", "off"] },
  read: { level: "read", levels: ["read", "off"] },
  folders: { level: "read", levels: ["read", "off"] },
  draft: { level: "write", levels: ["write", "approval", "off"] },
  organize: { level: "write", levels: ["write", "approval", "off"] },
  send: { level: "approval", levels: ["approval", "off"] },
  reply: { level: "approval", levels: ["approval", "off"] },
  forward: { level: "approval", levels: ["approval", "off"] },
  delete: { level: "approval", levels: ["approval", "off"] },
};

/** A mailbox's actions as the standard tool review shows them, with the mailbox's current choices. */
export function mailReviewTools(t: TFunction, account: Pick<MailAccount, "offActions" | "askActions">): ReviewTool[] {
  return (Object.keys(ACTION_LEVELS) as MailActionName[]).map((name) => {
    const { level, levels } = ACTION_LEVELS[name];
    const label = t(`mail.action.${name}.name`);
    const current: ToolDecision = account.offActions.includes(name)
      ? "off"
      : account.askActions.includes(name)
        ? "approval"
        : level;
    return {
      name,
      label,
      description: t(`mail.action.${name}.text`),
      subject: name === "folders" ? "folder" : "email",
      level: current,
      suggested: level,
      reason: null,
      sensitive: level === "approval",
      pending: false,
      savedLabel: label,
      levels,
    };
  });
}

/** What the review's choices mean for the mailbox: actions turned off, and those that must ask. */
export function mailActionsFrom(tools: ReviewTool[], levels: Record<string, ToolDecision>) {
  const of = (tool: ReviewTool) => levels[tool.name] ?? tool.level;
  const names = (want: ToolDecision) =>
    tools.filter((tool) => of(tool) === want).map((tool) => tool.name as MailActionName);
  return {
    offActions: names("off"),
    askActions: names("approval").filter((n) => ACTION_LEVELS[n].level !== "approval"),
  };
}

/** Whether the review's choices change the mailbox (unchanged, there is nothing to save). */
export function mailActionsChanged(
  account: Pick<MailAccount, "offActions" | "askActions">,
  chosen: ReturnType<typeof mailActionsFrom>,
) {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
  return !same(chosen.offActions, account.offActions) || !same(chosen.askActions, account.askActions);
}
