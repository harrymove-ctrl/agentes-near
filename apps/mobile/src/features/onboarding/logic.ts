import type { WorkspaceMode } from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { platformZoneName } from "@agenteschat/client/lib/routines";
import { webmailOf } from "@agenteschat/client/lib/text";
import type { TFunction } from "i18next";

/**
 * The phone's first run: what the workspace is for (ADR 0159), then, for a company or team, its name, asked by its
 * right hand; then its DM (ADR 0137). Pure: no React Native imports.
 */

/** The two answers to "What will you use agentes.chat for?" (ADR 0159), in this order. */
export const PURPOSES = ["personal", "team"] as const satisfies readonly WorkspaceMode[];

/**
 * The workspace an answer makes, or what one made here already is set to when a later step failed: "For me" is a
 * personal workspace named in the person's language (renamed in Settings like any other), with no name to ask; a
 * company or team is the name typed. The mode goes along either way (a server that doesn't know it ignores it).
 */
export const workspaceAnswer = (t: TFunction, purpose: WorkspaceMode, name: string) =>
  purpose === "personal"
    ? { name: t("onboarding.personal.name"), mode: "personal" as const }
    : { name: name.trim(), mode: "team" as const };

/** A save that failed: what the server's code says (a refused workspace, a restriction), else that it didn't save. */
export const stepFailedText = (t: TFunction, error: unknown, locale?: string) =>
  knownErrorText(t, error, locale) ?? t("mobile.onb.failed");

/** The phone's time zone ("America/Sao_Paulo"), or null. */
export function phoneTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** "America/Sao_Paulo" → "Sao Paulo": the city, readable. */
export function zoneCity(zone: string): string {
  const city = zone.split("/").pop() ?? zone;
  return city.replace(/_/g, " ");
}

/**
 * The time zone as people read it, in their language ("Horário Padrão de Brasília"); its city ("Sao Paulo", from the
 * id, without accents) where the platform has no name for it, or only an offset ("GMT-03:00").
 */
export function zoneLabel(zone: string, locale: string): string {
  return platformZoneName(zone, locale) ?? zoneCity(zone);
}

/** Personal mailboxes beyond the big webmails (`webmailOf`): their domain names a provider, never a company. */
const PERSONAL_DOMAINS = new Set([
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "ig.com.br",
  "globo.com",
  "globomail.com",
  "r7.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "yandex.com",
  "mail.com",
  "zoho.com",
  "tutanota.com",
  "hey.com",
  "fastmail.com",
]);

/**
 * A workspace name from a work address, for the first run's field: `ana@acme.com.br` → "Acme",
 * `bruno@loja-sol.com` → "Loja Sol". Null for a personal mailbox (Gmail, Outlook, UOL…) or no usable domain, so
 * the field starts empty there.
 */
export function orgNameFromEmail(email: string): string | null {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  if (!domain.includes(".") || webmailOf(email) || PERSONAL_DOMAINS.has(domain)) return null;
  const labels = domain.split(".").filter((l) => l && l !== "www" && l !== "mail");
  const first = labels[0];
  if (!first || first.length < 2) return null;
  return first
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toLocaleUpperCase() + w.slice(1))
    .join(" ");
}
