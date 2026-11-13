import type { TFunction } from "i18next";
import type { WorkspaceLimits } from "../api/types";
import { formatBytes } from "./files";

/**
 * A workspace's limits in the apps (ADR 0079): numbers a billing service set, said without a plan, price or
 * currency. Platform-neutral (web and phone).
 */

/** A routing decision's reason past the workspace's platform AI for the month: only @mentions start agents. */
export const PLATFORM_CAP = "platform_cap";

/** From this share of the storage limit, the meter says that uploads pause at the limit. */
export const STORAGE_NEAR = 0.8;

/** The people and the limit when no one more fits (inviting, approving and accepting are refused); else null. */
export function membersFull(limits: WorkspaceLimits | undefined) {
  const { used, limit } = limits?.members ?? { used: 0, limit: null };
  return limit !== null && used >= limit ? { members: used, limit } : null;
}

/** "This workspace has 10 of 10 people.", or with room for one, that the plan fits 1 person. */
export const membersFullText = (t: TFunction, members: number, limit: number) =>
  limit === 1 ? t("limits.members.fullOne") : t("limits.members.full", { members, limit });

/**
 * Who makes room in a full workspace, and how. Whoever manages billing (`billing`: the permission, on a server with a
 * billing service) adds a seat below the plan's top, or changes plans at it; when the billing service says someone
 * else pays, only the payer can, so they ask the payer, by name when they see it. Anyone else asks whoever runs the
 * workspace. When the billing service says no top, as a self-hosted server never does, the general words.
 */
export function membersFullWho(t: TFunction, limits: WorkspaceLimits | undefined, billing: boolean) {
  const canAddSeats = limits?.members.canAddSeats === true;
  if (!billing) return t(canAddSeats ? "limits.members.fullMemberSeat" : "limits.members.fullMember");
  if (!canAddSeats && limits?.members.max == null) return t("limits.members.fullAdmin");
  const payer = limits?.members.payer;
  if (!payer || payer.you) return t(canAddSeats ? "limits.members.fullAddSeat" : "limits.members.fullTop");
  if (payer.name) {
    return t(canAddSeats ? "limits.members.fullAskPayerSeat" : "limits.members.fullAskPayerTop", { payer: payer.name });
  }
  return t(canAddSeats ? "limits.members.fullAskSeat" : "limits.members.fullAskTop");
}

/**
 * The phone's words for who makes room (App Store 3.1.1: nothing to buy, no way to a purchase): on a server with a
 * billing service, that the paid seats are taken and, to anyone but the payer, to talk to whoever pays. Without
 * one, as everywhere.
 */
export function membersFullWhoPhone(t: TFunction, limits: WorkspaceLimits | undefined, billingService: boolean) {
  if (!billingService) return membersFullWho(t, limits, false);
  return t(limits?.members.payer?.you ? "limits.members.fullPhonePayer" : "limits.members.fullPhone");
}

/**
 * The workspace's files against its storage limit: null without one, or on its own bucket (no limit counts
 * there). `level`: `near` from 80%, `full` at the limit.
 */
export function storageLevel(limits: WorkspaceLimits | undefined) {
  if (!limits || limits.storage.ownStorage || limits.storage.limitBytes === null) return null;
  const { usedBytes, limitBytes } = limits.storage;
  const level = usedBytes >= limitBytes ? "full" : usedBytes >= limitBytes * STORAGE_NEAR ? "near" : "ok";
  return { usedBytes, limitBytes, level } as const;
}

/**
 * A refusal by a limit in the person's words: a full workspace (`org.members_full`), the storage limit
 * (`storage.full`) or the day's uploads (`storage.daily_full`). Null for any other code.
 */
export function limitRefusalText(
  t: TFunction,
  locale: string,
  code: string | null | undefined,
  params?: Record<string, unknown> | null,
): string | null {
  const num = (key: string) => (typeof params?.[key] === "number" ? (params[key] as number) : null);
  if (code === "org.members_full") {
    const [members, limit] = [num("members"), num("limit")];
    return members !== null && limit !== null ? membersFullText(t, members, limit) : null;
  }
  const limitBytes = num("limitBytes");
  if (limitBytes === null) return null;
  if (code === "storage.full") return t("limits.storage.full", { limit: formatBytes(locale, limitBytes) });
  if (code === "storage.daily_full") return t("limits.storage.dailyFull", { limit: formatBytes(locale, limitBytes) });
  return null;
}
