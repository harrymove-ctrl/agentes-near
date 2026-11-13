/**
 * Time zones for our selector: every IANA zone the browser knows (or a short
 * static list), with the live UTC offset, a friendly name when the app has
 * one, the region, and a search that understands cities, ids and offsets.
 */

import { fold } from "./search";

/** When `Intl.supportedValuesOf` isn't there. */
export const FALLBACK_ZONES = [
  "UTC",
  "America/Sao_Paulo",
  "America/Manaus",
  "America/Fortaleza",
  "America/Recife",
  "America/Belem",
  "America/Cuiaba",
  "America/Rio_Branco",
  "America/Noronha",
  "America/Argentina/Buenos_Aires",
  "America/Santiago",
  "America/Bogota",
  "America/Lima",
  "America/Mexico_City",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "Europe/Lisbon",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Africa/Luanda",
  "Africa/Maputo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

export function allZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list?.length) return list.includes("UTC") ? list : ["UTC", ...list];
  } catch {
    // older engines
  }
  return FALLBACK_ZONES;
}

/** Minutes east of UTC for `timeZone` at `at` (−180 for São Paulo). */
export function offsetMinutes(timeZone: string, at = new Date()): number {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part ?? "");
    if (!m) return 0;
    const v = Number(m[2]) * 60 + Number(m[3]);
    return m[1] === "-" ? -v : v;
  } catch {
    return 0;
  }
}

/** "UTC−3", "UTC+5:30", "UTC". */
export function offsetLabel(minutes: number): string {
  if (minutes === 0) return "UTC";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${minutes < 0 ? "−" : "+"}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

export type ZoneRegion = "suggested" | "America" | "Europe" | "Asia" | "Africa" | "Oceania" | "Antarctica" | "Other";

/** Display order of the regions after "Sugeridos". */
const REGIONS: ZoneRegion[] = ["America", "Europe", "Asia", "Africa", "Oceania", "Antarctica", "Other"];
/** IANA areas → our regions (oceans join the nearest continent). */
const AREA: Record<string, ZoneRegion> = {
  America: "America",
  Europe: "Europe",
  Arctic: "Europe",
  Atlantic: "Europe",
  Asia: "Asia",
  Indian: "Asia",
  Africa: "Africa",
  Australia: "Oceania",
  Pacific: "Oceania",
  Antarctica: "Antarctica",
};
export const regionOf = (zone: string): ZoneRegion => AREA[zone.split("/")[0] ?? ""] ?? "Other";

/** Places in the EU or the EEA whose IANA zone isn't under `Europe/`. */
const EUROPEAN_ELSEWHERE = new Set([
  "Atlantic/Canary",
  "Atlantic/Madeira",
  "Atlantic/Azores",
  "Africa/Ceuta",
  "Asia/Nicosia",
  "Asia/Famagusta",
  "Atlantic/Reykjavik",
  "Indian/Reunion",
  "Indian/Mayotte",
  "America/Guadeloupe",
  "America/Martinique",
  "America/Cayenne",
  "America/Marigot",
]);

/** Every `Europe/…` zone (a little wider than the EU, the EEA and the UK), plus the places above. */
export const isEuropeanTimeZone = (zone: string) => zone.startsWith("Europe/") || EUROPEAN_ELSEWHERE.has(zone);

/** "Sao_Paulo" → "Sao Paulo"; "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export const cityOf = (zone: string) => (zone.split("/").pop() ?? zone).replace(/_/g, " ");

export interface ZoneOption {
  zone: string;
  /** Friendly name ("Horário de Brasília"), else the city. */
  name: string;
  offset: number;
  offsetLabel: string;
  region: ZoneRegion;
  /** Lowercase, accent-free text the search looks at. */
  haystack: string;
}

export function zoneOption(zone: string, nameOf?: (zone: string) => string | undefined, at = new Date()): ZoneOption {
  const offset = offsetMinutes(zone, at);
  const name = nameOf?.(zone) ?? (zone === "UTC" ? "UTC" : cityOf(zone));
  return {
    zone,
    name,
    offset,
    offsetLabel: offsetLabel(offset),
    region: regionOf(zone),
    haystack: fold(`${name} ${zone.replace(/[_/]/g, " ")} ${zone}`),
  };
}

/** Options, suggested first (in the given order), then the rest by region and offset. */
export function zoneOptions(
  suggested: string[],
  nameOf?: (zone: string) => string | undefined,
  at = new Date(),
  zones = allZones(),
): { suggested: ZoneOption[]; rest: ZoneOption[] } {
  const seen = new Set<string>();
  const top: ZoneOption[] = [];
  for (const z of suggested) {
    if (!z || seen.has(z)) continue;
    seen.add(z);
    top.push(zoneOption(z, nameOf, at));
  }
  const rest = zones
    .filter((z) => !seen.has(z))
    .map((z) => zoneOption(z, nameOf, at))
    .sort(
      (a, b) =>
        REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region) || a.offset - b.offset || a.name.localeCompare(b.name),
    );
  return { suggested: top, rest };
}

/** An offset typed in the search ("-3", "gmt-3", "utc+5:30", "−3") in minutes, else null. */
export function parseOffsetQuery(q: string): number | null {
  const m = /^(?:utc|gmt)?\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?$/.exec(q.trim().toLowerCase());
  if (!m) {
    if (/^(utc|gmt)$/.test(q.trim().toLowerCase())) return 0;
    return null;
  }
  const v = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "+" ? v : -v;
}

/** Matches by name, city, country words, IANA id or offset. */
export function filterZones(list: ZoneOption[], query: string): ZoneOption[] {
  const q = query.trim();
  if (!q) return list;
  const offset = parseOffsetQuery(q);
  if (offset !== null) return list.filter((o) => o.offset === offset);
  const words = fold(q).split(/\s+/).filter(Boolean);
  return list.filter((o) => words.every((w) => o.haystack.includes(w)));
}
