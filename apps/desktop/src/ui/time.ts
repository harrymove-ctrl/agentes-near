import { clockHour } from "@agenteschat/client/lib/format";
import type { TFunction } from "i18next";

/** "agora", "2 min", "3 h" since a time. */
export function since(iso: string, t: TFunction, now: number = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return t("desktop.common.now");
  const min = Math.floor(ms / 60_000);
  if (min < 60) return t("desktop.common.minutes", { count: min });
  return t("desktop.common.hours", { count: Math.floor(min / 60) });
}

/** "16:24" (today) or "sex., 9:00" (another day), in the app's language. */
export function clock(iso: string, locale: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(locale, { hour: clockHour(locale), minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
}

/** A day heading for dates older than yesterday: "12 de outubro". */
export function dayLabel(day: Date, locale: string): string {
  return day.toLocaleDateString(locale, { day: "numeric", month: "long" });
}

/** "0:41", "2:14", "1:05:09": how long, ticking. */
export function elapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The last part of a path, for showing a folder by its name. */
export function baseName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** `/Users/ana/Documents/x` → `~/Documents/x` when we know the home prefix. */
export function shortPath(path: string): string {
  const m = /^\/Users\/[^/]+(\/.*)?$/.exec(path);
  return m ? `~${m[1] ?? ""}` : path;
}

/** A folder as the person knows it: iCloud Drive by that name, its folders after "›", else `shortPath`. */
export function folderLabel(path: string): string {
  const m = /^\/Users\/[^/]+\/Library\/Mobile Documents\/com~apple~CloudDocs(\/.*)?$/.exec(path);
  if (!m) return shortPath(path);
  return ["iCloud Drive", ...(m[1] ?? "").split("/").filter(Boolean)].join("\u00a0›\u00a0");
}

/** Where the server here keeps its backups (`backups/` in its folder `dir`), with the folder's own separator. */
export const backupsFolder = (dir: string) => `${dir}${dir.includes("\\") ? "\\" : "/"}backups`;

/** Today at 3:00 on this computer's clock, the nightly backup's time. */
export function nightAt(): Date {
  const at = new Date();
  at.setHours(3, 0, 0, 0);
  return at;
}

/** "Ada, Bento e Lia" / "Ada, Bento and Lia". */
export function listNames(names: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

/** `{{name}}` placeholders filled in without i18next (the cover's small bundle); unknown ones stay as they are. */
export const fillIn = (text: string, vars: Record<string, string>) =>
  text.replace(/\{\{(\w+)\}\}/g, (all, key: string) => vars[key] ?? all);
