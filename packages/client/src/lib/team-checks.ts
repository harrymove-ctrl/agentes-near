import type { TeamCheck } from "../api/types";

/** The team checks a message carries (`meta.teamChecks`, ADR 0064), if any. */
export const teamChecksOf = (meta: Record<string, unknown> | undefined): TeamCheck[] =>
  Array.isArray(meta?.teamChecks) ? (meta.teamChecks as TeamCheck[]) : [];

/** What a target is, for its icon: an address, a phone number, a page, or code. */
export function targetKind(target: string): "email" | "phone" | "code" | "url" | "other" {
  if (/^\+\d{8,15}$/.test(target)) return "phone";
  // Before addresses: a branch (`acme/app@fix/login`) has an @ too.
  if (/^[\w.-]+\/[\w.-]+[#@]/.test(target)) return "code";
  if (/^[^\s@/]+@[^\s@/]+$/.test(target)) return "email";
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(target)) return "url";
  return "other";
}
