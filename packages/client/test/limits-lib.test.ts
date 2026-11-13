import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { ApiError } from "../src/api/http";
import type { WorkspaceLimits } from "../src/api/types";
import { errorText, invitedErrorText } from "../src/lib/errors";
import { membersFull, membersFullWho, membersFullWhoPhone, storageLevel } from "../src/lib/limits";

/** The key and its values, so a test sees which words were picked (the words themselves: packages/i18n). */
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length > 0 ? `${key} ${JSON.stringify(o)}` : key) as unknown as TFunction;

const GB = 1024 ** 3;
const limits = (over: { members?: [number, number | null]; storage?: [number, number | null, boolean?] } = {}) => {
  const [used, limit] = over.members ?? [3, null];
  const [usedBytes, limitBytes, ownStorage] = over.storage ?? [0, null];
  return {
    members: { used, limit },
    storage: { usedBytes, limitBytes, ownStorage: ownStorage ?? false },
    uploads: { usedBytes24h: 0, limitBytesPerDay: null },
  } satisfies WorkspaceLimits;
};

describe("a workspace's limits in words (ADR 0079)", () => {
  test("full only at the limit; no limit is never full", () => {
    expect(membersFull(limits({ members: [10, 10] }))).toEqual({ members: 10, limit: 10 });
    expect(membersFull(limits({ members: [11, 10] }))).toEqual({ members: 11, limit: 10 });
    expect(membersFull(limits({ members: [9, 10] }))).toBeNull();
    expect(membersFull(limits({ members: [500, null] }))).toBeNull();
    expect(membersFull(undefined)).toBeNull();
  });

  test("who makes room: a seat below the plan's top, another plan at it; general words when no top is said", () => {
    const seats = (limit: number, max: number | null) =>
      ({
        ...limits({ members: [limit, limit] }),
        members: { used: limit, limit, max, canAddSeats: max !== null && limit < max },
      }) satisfies WorkspaceLimits;
    expect(membersFullWho(t, seats(12, 15), true)).toBe("limits.members.fullAddSeat");
    expect(membersFullWho(t, seats(15, 15), true)).toBe("limits.members.fullTop");
    expect(membersFullWho(t, seats(1, 1), true)).toBe("limits.members.fullTop");
    expect(membersFullWho(t, seats(10, null), true)).toBe("limits.members.fullAdmin");
    expect(membersFullWho(t, seats(12, 15), false)).toBe("limits.members.fullMemberSeat");
    expect(membersFullWho(t, seats(15, 15), false)).toBe("limits.members.fullMember");
    // A server older than the plan's top, or none at all.
    expect(membersFullWho(t, limits({ members: [2, 2] }), true)).toBe("limits.members.fullAdmin");
    expect(membersFullWho(t, undefined, false)).toBe("limits.members.fullMember");
  });

  test("who pays: the payer adds the seat, anyone else who manages billing asks them; the phone names no purchase", () => {
    const paid = (limit: number, max: number, payer: { you: boolean; name: string | null } | null) =>
      ({
        ...limits({ members: [limit, limit] }),
        members: { used: limit, limit, max, canAddSeats: limit < max, payer },
      }) satisfies WorkspaceLimits;
    const you = { you: true, name: null };
    const ana = { you: false, name: "Ana" };
    const unseen = { you: false, name: null };
    expect(membersFullWho(t, paid(12, 15, you), true)).toBe("limits.members.fullAddSeat");
    expect(membersFullWho(t, paid(15, 15, you), true)).toBe("limits.members.fullTop");
    expect(membersFullWho(t, paid(12, 15, ana), true)).toBe('limits.members.fullAskPayerSeat {"payer":"Ana"}');
    expect(membersFullWho(t, paid(15, 15, ana), true)).toBe('limits.members.fullAskPayerTop {"payer":"Ana"}');
    expect(membersFullWho(t, paid(12, 15, unseen), true)).toBe("limits.members.fullAskSeat");
    expect(membersFullWho(t, paid(15, 15, unseen), true)).toBe("limits.members.fullAskTop");
    // Not said who pays (a billing service older than it): whoever manages billing adds the seat, as before.
    expect(membersFullWho(t, paid(12, 15, null), true)).toBe("limits.members.fullAddSeat");
    // Members read as before, whoever pays.
    expect(membersFullWho(t, paid(12, 15, ana), false)).toBe("limits.members.fullMemberSeat");

    expect(membersFullWhoPhone(t, paid(12, 15, you), true)).toBe("limits.members.fullPhonePayer");
    for (const payer of [ana, unseen, null]) {
      expect(membersFullWhoPhone(t, paid(12, 15, payer), true)).toBe("limits.members.fullPhone");
      expect(membersFullWhoPhone(t, paid(15, 15, payer), true)).toBe("limits.members.fullPhone");
    }
    expect(membersFullWhoPhone(t, limits({ members: [2, 2] }), true)).toBe("limits.members.fullPhone");
    // A self-hosted server: no billing service, the words as everywhere.
    expect(membersFullWhoPhone(t, limits({ members: [2, 2] }), false)).toBe("limits.members.fullMember");
  });

  test("files: near from 80%, full at the limit; nothing to say without a limit or on the workspace's own bucket", () => {
    expect(storageLevel(limits({ storage: [39 * GB, 50 * GB] }))?.level).toBe("ok");
    expect(storageLevel(limits({ storage: [40 * GB, 50 * GB] }))?.level).toBe("near");
    expect(storageLevel(limits({ storage: [50 * GB, 50 * GB] }))?.level).toBe("full");
    expect(storageLevel(limits({ storage: [1, null] }))).toBeNull();
    expect(storageLevel(limits({ storage: [80 * GB, 50 * GB, true] }))).toBeNull();
  });

  test("refusals say the numbers in the person's words: 1 person reads as the plan fitting one", () => {
    const full = (members: number, limit: number) =>
      errorText(t, new ApiError(409, "org.members_full", "This workspace is full", { members, limit }));
    expect(full(10, 10)).toBe('limits.members.full {"members":10,"limit":10}');
    expect(full(1, 1)).toBe("limits.members.fullOne");
    const storage = (code: string, limitBytes: number, locale?: string) =>
      errorText(t, new ApiError(409, code, "The workspace's file storage is full", { limitBytes }), locale);
    expect(storage("storage.full", 50 * GB)).toBe('limits.storage.full {"limit":"50 GB"}');
    expect(storage("storage.daily_full", 10 * GB, "pt-BR")).toBe('limits.storage.dailyFull {"limit":"10 GB"}');
    expect(storage("storage.full", 1.5 * GB, "pt-BR")).toBe('limits.storage.full {"limit":"1,5 GB"}');
    // Without its numbers: the server's own words, in English for every language.
    const bare = new ApiError(409, "storage.full", "The workspace's file storage is full");
    expect(errorText(t, bare, "en")).toBe("The workspace's file storage is full");
    expect(errorText(t, bare, "pt-BR")).toBe("The workspace's file storage is full");
  });

  test("the person an invitation is for reads whom to tell, never the numbers", () => {
    const full = new ApiError(409, "org.members_full", "This workspace is full", { members: 10, limit: 10 });
    expect(invitedErrorText(t, full)).toBe("errors.org.membersFull");
    // Any other code as everywhere, and nothing for one it doesn't know.
    const held = new ApiError(403, "org.paused", "This workspace is on hold: payment", { reason: "payment" });
    expect(invitedErrorText(t, held)).toBe("standing.billing.payment");
    expect(invitedErrorText(t, new ApiError(403, "forbidden", "This invitation was sent to a@b.c"))).toBeNull();
  });
});
