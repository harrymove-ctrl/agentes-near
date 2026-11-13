import type { AgentMailbox, Routine, RoutineHookOutcome, ScopeGrant } from "../api/types";
import { clockHour } from "./format";

/** A plain reminder the agent posted (`meta.reminder`): shown as the agent's message with a "Reminder" label. */
export const isReminderMessage = (meta: Record<string, unknown> | undefined) => meta?.reminder === true;

/**
 * A reminder's text without the server's own prefix ("@ana Reminder: …"; older
 * messages say "Lembrete: …"), since the app shows its translated label.
 */
export function reminderBody(body: string, meta: Record<string, unknown> | undefined): string {
  if (!isReminderMessage(meta)) return body;
  return body.replace(/^((?:@[\w.-]+\s+)*)(?:Reminder|Lembrete): /, "$1");
}

/**
 * The routine an agent's message comes from (ADR 0053 §7): a routine's own message (`meta.routine` with
 * `id`, `name`, the routine run `runId`), or the reply of the run its hand-off woke, which also carries
 * the `noticeId` of the report it answers. Shown as a small tag ("Rotina «X»") that opens the routine;
 * only a reply has a report to unfold. A plain reminder is the agent's own message, so not here.
 */
export interface RoutineReply {
  id: string;
  name: string;
  /** The routine run (`routine_runs.id`). */
  runId: string | null;
  /** The `routine_handoff` notice it answers (hidden in the timeline while this answer is there). */
  noticeId: string | null;
}

export function routineReplyOf(m: { author: { type: string }; meta?: Record<string, unknown> }): RoutineReply | null {
  if (m.author.type !== "agent" || isReminderMessage(m.meta)) return null;
  const r = m.meta?.routine as Record<string, unknown> | undefined;
  if (!r || typeof r.id !== "string" || typeof r.name !== "string") return null;
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  return { id: r.id, name: r.name, runId: text(r.runId) ?? text(r.routineRunId), noticeId: text(r.noticeId) };
}

/**
 * A person's message carrying `meta.routine`: a routine's call or firing written as its creator (before
 * routines fired in their own room, ADR 0053 §4). Never shown: it isn't something the person said.
 */
export const isRoutineCall = (m: { author: { type: string }; meta?: Record<string, unknown> }) => {
  const r = m.meta?.routine as { id?: unknown } | undefined;
  return m.author.type === "person" && typeof r?.id === "string";
};

/** A webhook routine's address, for who may manage it (ADR 0106); null for any other routine or viewer. */
export const routineHookUrl = (r: Pick<Routine, "trigger">) => (r.trigger.type === "webhook" ? r.trigger.url : null);

/** A call its address refused (a wrong signature, too large, too many): nothing of it reached the routine. */
export const isRefusedHookCall = (outcome: RoutineHookOutcome) =>
  outcome === "bad_signature" || outcome === "too_large" || outcome === "rate_limited";

/**
 * A call to try a routine's address from a terminal. With `secret` (the signing secret, or a placeholder for it),
 * the body is signed the way a sending service signs it: its HMAC-SHA256 in `X-Agentes-Signature`.
 */
export function hookCurl(url: string, secret: string | null, methods: readonly string[] = ["POST"]) {
  const method = methods.includes("POST") ? "POST" : (methods.find((m) => m !== "GET") ?? "GET");
  const sign = (data: string) => `SIG=$(printf '%s' ${data} | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')`;
  const signature = `  -H "X-Agentes-Signature: sha256=$SIG"`;
  // A GET's data is its query string, and its signature covers that query string (without the `?`).
  if (method === "GET") {
    const get = `curl '${url}?text=hello'`;
    return secret === null ? get : [`SECRET='${secret}'`, sign("'text=hello'"), `${get} \\`, signature].join("\n");
  }
  const body = `{"text":"hello"}`;
  const send = (sig: string[], data: string) =>
    [`curl -X ${method} '${url}' \\`, `  -H 'Content-Type: application/json' \\`, ...sig, `  -d ${data}`].join("\n");
  if (secret === null) return send([], `'${body}'`);
  return [`SECRET='${secret}'`, `BODY='${body}'`, sign('"$BODY"'), send([`${signature} \\`], '"$BODY"')].join("\n");
}

/** Zones people pick most often, around the world; the select also keeps whatever zone a routine already has. */
export const COMMON_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Istanbul",
  "Europe/Moscow",
  "Asia/Kolkata",
  "Asia/Jakarta",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
];

/** English names (the Portuguese ones below are the default), one for every zone named there. */
const NAMES_EN: Record<keyof typeof NAMES, string> = {
  "America/Sao_Paulo": "Brasília time",
  "America/Manaus": "Amazonas time",
  "America/Fortaleza": "Fortaleza time",
  "America/Recife": "Recife time",
  "America/Belem": "Belém time",
  "America/Cuiaba": "Cuiabá time",
  "America/Rio_Branco": "Acre time",
  "America/Noronha": "Fernando de Noronha time",
  "America/New_York": "New York (US Eastern)",
  "America/Chicago": "Chicago (US Central)",
  "America/Denver": "Denver (US Mountain)",
  "America/Los_Angeles": "Los Angeles (US Pacific)",
  "America/Toronto": "Toronto",
  "America/Mexico_City": "Mexico City",
  "America/Argentina/Buenos_Aires": "Buenos Aires",
  "America/Santiago": "Santiago",
  "America/Bogota": "Bogotá",
  "America/Lima": "Lima",
  "America/Montevideo": "Montevideo",
  "America/Asuncion": "Asunción",
  "Europe/Lisbon": "Lisbon",
  "Europe/London": "London",
  "Europe/Madrid": "Madrid",
  "Europe/Paris": "Paris",
  "Europe/Berlin": "Berlin",
  "Europe/Rome": "Rome",
  "Europe/Amsterdam": "Amsterdam",
  "Atlantic/Azores": "Azores",
  "Africa/Luanda": "Luanda",
  "Africa/Maputo": "Maputo",
  "Asia/Dubai": "Dubai",
  "Asia/Kolkata": "India",
  "Asia/Singapore": "Singapore",
  "Asia/Shanghai": "Shanghai (China)",
  "Asia/Tokyo": "Tokyo",
  "Australia/Sydney": "Sydney",
  "Pacific/Auckland": "Auckland",
};
/** Our own names in Portuguese and English (the default); every other language gets the platform's (Intl). */
const namesFor = (locale?: string): Partial<Record<string, string>> =>
  locale?.startsWith("pt") ? NAMES : !locale || locale.startsWith("en") ? NAMES_EN : {};

const NAMES = {
  "America/Sao_Paulo": "horário de Brasília",
  "America/Manaus": "horário do Amazonas",
  "America/Fortaleza": "horário de Fortaleza",
  "America/Recife": "horário de Recife",
  "America/Belem": "horário de Belém",
  "America/Cuiaba": "horário de Cuiabá",
  "America/Rio_Branco": "horário do Acre",
  "America/Noronha": "horário de Fernando de Noronha",
  "America/New_York": "Nova York (Leste dos EUA)",
  "America/Chicago": "Chicago (Centro dos EUA)",
  "America/Denver": "Denver (Montanhas dos EUA)",
  "America/Los_Angeles": "Los Angeles (Pacífico dos EUA)",
  "America/Toronto": "Toronto",
  "America/Mexico_City": "Cidade do México",
  "America/Argentina/Buenos_Aires": "Buenos Aires",
  "America/Santiago": "Santiago",
  "America/Bogota": "Bogotá",
  "America/Lima": "Lima",
  "America/Montevideo": "Montevidéu",
  "America/Asuncion": "Assunção",
  "Europe/Lisbon": "Lisboa",
  "Europe/London": "Londres",
  "Europe/Madrid": "Madri",
  "Europe/Paris": "Paris",
  "Europe/Berlin": "Berlim",
  "Europe/Rome": "Roma",
  "Europe/Amsterdam": "Amsterdã",
  "Atlantic/Azores": "Açores",
  "Africa/Luanda": "Luanda",
  "Africa/Maputo": "Maputo",
  "Asia/Dubai": "Dubai",
  "Asia/Kolkata": "Índia",
  "Asia/Singapore": "Singapura",
  "Asia/Shanghai": "Xangai (China)",
  "Asia/Tokyo": "Tóquio",
  "Australia/Sydney": "Sydney",
  "Pacific/Auckland": "Auckland",
} satisfies Record<string, string>;

/** The browser's zone, if it has one. */
export function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** An IANA zone the browser knows ("America/Sao_Paulo"). */
export function isTimeZone(zone: string) {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * "horário de Brasília" (the zone's name, without the offset). A zone we don't name goes by the platform's name in
 * `locale` ("Horário da Europa Central"): its IANA id only where the platform has no name for it.
 */
export const timezoneName = (timeZone: string, locale?: string) =>
  timeZone === "UTC" || timeZone === "Etc/UTC"
    ? "UTC"
    : (namesFor(locale)[timeZone] ?? platformZoneName(timeZone, locale) ?? timeZone);

/**
 * The platform's name for a zone in `locale` ("Horário do Nepal"). Never a bare offset ("GMT-03:00", what an engine
 * without zone names gives a city's zone), except for a zone that is only an offset ("Etc/GMT+3").
 */
export function platformZoneName(timeZone: string, locale?: string): string | undefined {
  try {
    const name = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    return name && (timeZone.startsWith("Etc/") || !/^(GMT|UTC)/.test(name)) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** A one-off's moment in its own zone: { weekday: "qui", date: "16/10", time: "09:00", zone: "horário de Brasília" }. */
export function onceParts(locale: string, at: string, timeZone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    }).formatToParts(new Date(at));
  } catch {
    parts = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(at));
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  // Day/month order and 12h/24h follow the locale.
  const fmt = (opts: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat(locale, { ...opts, timeZone }).format(new Date(at));
    } catch {
      return new Intl.DateTimeFormat(locale, opts).format(new Date(at));
    }
  };
  return {
    weekday: get("weekday").replace(/\.$/, ""),
    date: fmt({ day: "2-digit", month: "2-digit" }),
    time: fmt({ hour: clockHour(locale), minute: "2-digit" }),
    zone: timezoneName(timeZone, locale),
  };
}

/** The selector's name for a zone: "Horário de Brasília", "Nova York (Leste dos EUA)", "UTC". */
export function zoneDisplayName(timeZone: string, locale?: string): string | undefined {
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return "UTC";
  const name = namesFor(locale)[timeZone];
  return name ? name.charAt(0).toLocaleUpperCase() + name.slice(1) : undefined;
}

/**
 * What a routine's mailbox or connection picker offers for its agent (the server refuses one the agent can't read):
 * the ones it reads, and the one already picked when it doesn't, so the picker never shows empty. `cantRead`: the agent
 * can't read the picked one, or any. `reads` undefined: not known yet, every one shows.
 */
export function triggerChoices<T extends { id: string }>(
  items: T[],
  reads: ((id: string) => boolean) | undefined,
  picked: string,
): { options: T[]; cantRead: boolean } {
  if (!reads) return { options: items, cantRead: false };
  const current = items.find((i) => i.id === picked && !reads(i.id));
  const readable = items.filter((i) => reads(i.id));
  return { options: current ? [current, ...readable] : readable, cantRead: Boolean(current) || readable.length === 0 };
}

/** Whether the agent reads a mailbox, from its levels (`GET …/agents/{id}/mail`). */
export const mailboxReader = (levels: AgentMailbox[]) => (accountId: string) =>
  levels.some((m) => m.accountId === accountId && m.level !== "none");

/** Whether the agent reads a connection's tools, from its grants (a custom connection's `custom:<id>:read`). */
export const connectionReader = (grants: ScopeGrant[]) => (connectionId: string) =>
  grants.some((g) => g.connectionId === connectionId && g.scope === `custom:${connectionId}:read`);
