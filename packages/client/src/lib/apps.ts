import type { TFunction } from "i18next";
import { ApiError } from "../api/http";
import type {
  AppAccess,
  AppConsent,
  AppDisplayKind,
  AppNotification,
  AppsList,
  ConnectedApp,
  OrgStanding,
  PersonalToken,
} from "../api/types";
import { billingHoldOf, standingActive } from "./billing";
import { formatShortDate, joinNames, relativeTime } from "./format";

/*
 * AI apps (ADR 0119) in words and marks, for the web and the phone alike: which mark stands for an app, how long a
 * name is shown, and which of the consent page's states an error or an `?erro=` is.
 */

/** An app's mark (`ProviderLogo` id) from the brand the server derived from a verified address; never metadata. */
export const APP_BRANDS: Record<string, string> = {
  claude: "claude",
  openai: "openai",
  cursor: "cursor",
  vscode: "vscode",
};

/**
 * What stands for an app in a row or on the consent page: its brand's mark, the computer, or its first letter (one
 * letter is never a mark's id, so an unverified "Claude" can't draw Claude's mark).
 */
export function appMark(app: {
  brand: string | null;
  displayKind: AppDisplayKind | string;
  name: string;
}): { kind: "brand"; id: string } | { kind: "computer" } | { kind: "initial"; letter: string } {
  const id = app.brand ? APP_BRANDS[app.brand] : undefined;
  if (id) return { kind: "brand", id };
  if (app.displayKind === "loopback") return { kind: "computer" };
  return { kind: "initial", letter: [...app.name.trim()][0]?.toUpperCase() ?? "?" };
}

/** Where "Conectar um app" opens from the phone: Settings → AI apps on the web. */
export const appsSettingsUrl = (serverUrl: string, orgId: string) =>
  `${serverUrl.replace(/\/+$/, "")}/org/${encodeURIComponent(orgId)}/settings/apps`;

/** The longest name shown whole; past it the name is cut, with the whole of it in a tooltip. */
export const APP_NAME_CHARS = 40;

/** A name as the consent title shows it: `short` for the line, `full` for the tooltip when it was cut. */
export function appName(name: string): { short: string; full: string | null } {
  const chars = [...name.trim()];
  if (chars.length <= APP_NAME_CHARS) return { short: chars.join(""), full: null };
  return { short: `${chars.slice(0, APP_NAME_CHARS).join("").trimEnd()}…`, full: name.trim() };
}

/**
 * The access a consent pre-selects: `write` when asked, else `read`. Never `manage`, even when asked (every client
 * asks for it by default): creating and editing agents is something the person opts into.
 */
export const requestedAccess = (consent: AppConsent): AppAccess =>
  consent.request.access.requested.includes("write") ? "write" : "read";

/** What an app's creations are counted by, in the order its notice names them. */
const CREATED_KINDS = ["agent", "routine", "skill", "memory", "channel"] as const;

/** "Claude criou 3 agentes e 2 rotinas pelo app": the line of an `app_created` notice. */
export function appCreatedLine(t: TFunction, n: Pick<AppNotification, "latest">): string {
  const created = n.latest.created ?? {};
  const what = CREATED_KINDS.filter((k) => (created[k] ?? 0) > 0).map((k) =>
    t(`apps.created.${k}`, { count: created[k] }),
  );
  return t("apps.created.notice", { app: n.latest.title ?? "", what: joinNames(what, t) });
}

/**
 * The import's "Connect with MCP" way in: the address to connect and the request to paste, or unavailable with the
 * line saying why: apps that call from their own servers can't reach this one (a self-hosted server on a private
 * host), or the workspace is on a hold, which refuses an app's sign-in and its calls (`workRefusal`), as a new Cloud
 * workspace is until its first plan. Null while loading.
 */
export function aiAppImport(
  t: TFunction,
  list: Pick<AppsList, "serverUrl" | "serverPublic"> | undefined,
  standing: Pick<OrgStanding, "state" | "reason"> | null | undefined,
) {
  if (!list) return null;
  if (!list.serverPublic) return { available: false as const, note: t("onboarding.import.aiApp.private") };
  if (!standingActive(standing))
    return {
      available: false as const,
      note: t(billingHoldOf(standing) ? "onboarding.import.aiApp.held" : "onboarding.import.aiApp.paused"),
    };
  return {
    available: true as const,
    url: list.serverUrl,
    prompt: t("onboarding.import.aiApp.prompt", { url: list.serverUrl }),
  };
}

/** The workspace a consent pre-selects: the current one, else the first one that isn't paused. */
export const defaultWorkspace = (consent: AppConsent) =>
  (consent.workspaces.find((w) => w.current && !w.paused) ?? consent.workspaces.find((w) => !w.paused))?.id;

/** The consent page's error states (`apps.consent.error.*`). */
export type ConsentError =
  | "app_desconhecido"
  | "endereco_de_retorno"
  | "pedido_invalido"
  | "expirado"
  | "indisponivel"
  | "muitas_tentativas"
  | "workspace_paused"
  | "not_member";

const SPA_ERRORS = [
  "app_desconhecido",
  "endereco_de_retorno",
  "pedido_invalido",
  "expirado",
  "indisponivel",
  "muitas_tentativas",
] as const satisfies readonly ConsentError[];

/** `?erro=` as the server sends it, or null for anything else. */
export const consentErrorParam = (value: unknown) => SPA_ERRORS.find((e) => e === value) ?? null;

/** Which state a failed call is: unknown, used or expired requests read as expired (back to the app). */
export function consentErrorOf(error: unknown): ConsentError {
  if (!(error instanceof ApiError)) return "indisponivel";
  if (error.status === 429) return "muitas_tentativas";
  if (error.code === "workspace_paused") return "workspace_paused";
  if (error.code === "not_member") return "not_member";
  if (error.status === 404 || error.status === 409 || error.status === 410) return "expirado";
  return "indisponivel";
}

/** Nothing connected and no token: the page shows its empty state. */
export const isAppsEmpty = (list: AppsList | undefined) => !!list && list.apps.length === 0 && list.tokens.length === 0;

/**
 * The app that just connected: a grant new since `seen` (the ids the dialog opened with), or one connected again
 * since `since` (ms): connecting an app that is already connected keeps its grant and moves its time forward.
 */
export const newlyConnected = (list: AppsList | undefined, seen: ReadonlySet<string>, since: number) =>
  list?.apps.find((a) => !seen.has(a.id) || Date.parse(a.connectedAt) >= since) ?? null;

/** A connected app's line under its name: where it runs, whose (in the whole workspace's list), when connected and used. */
export function appFacts(t: TFunction, locale: string, app: ConnectedApp, now = new Date()) {
  return [
    app.displayKind === "loopback" ? t("apps.onThisComputer") : app.host,
    app.person ? t("apps.of", { name: app.person.name }) : null,
    t("apps.connectedAt", { when: relativeTime(t, locale, app.connectedAt, now) }),
    app.lastUsedAt ? t("apps.usedAt", { when: relativeTime(t, locale, app.lastUsedAt, now) }) : t("apps.neverUsed"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A personal token's line under its name: whose, when it expires, when it was used. */
export function tokenFacts(t: TFunction, locale: string, token: PersonalToken, now = new Date()) {
  return [
    token.person ? t("apps.of", { name: token.person.name }) : null,
    token.expiresAt
      ? t("apps.tokens.expires", { date: formatShortDate(locale, token.expiresAt) })
      : t("apps.tokens.noExpiry"),
    token.lastUsedAt ? t("apps.usedAt", { when: relativeTime(t, locale, token.lastUsedAt, now) }) : t("apps.neverUsed"),
  ]
    .filter(Boolean)
    .join(" · ");
}
