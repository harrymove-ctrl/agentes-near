import { describe, expect, test } from "bun:test";
import { exampleSenders, MAX_PUSH_OFFERS, pushAskAt, pushOfferDue, pushOffersFrom } from "../src/lib/push-offer";

describe("our notifications ask, before the system's prompt", () => {
  const fresh = { permission: "undetermined" as const, turnedOff: false, offers: 0 };

  test("once at the first answer, once more at the first request to approve, then never", () => {
    expect(pushOfferDue(fresh, "answer")).toBe(true);
    expect(pushOfferDue(fresh, "approval")).toBe(false);
    expect(pushOfferDue({ ...fresh, offers: 1 }, "answer")).toBe(false);
    expect(pushOfferDue({ ...fresh, offers: 1 }, "approval")).toBe(true);
    expect(pushOfferDue({ ...fresh, offers: 2 }, "approval")).toBe(false);
  });

  test("never once the device was asked, or when the person turned them off", () => {
    expect(pushOfferDue({ ...fresh, permission: "granted" }, "answer")).toBe(false);
    expect(pushOfferDue({ ...fresh, permission: "denied" }, "answer")).toBe(false);
    expect(pushOfferDue({ ...fresh, permission: null }, "answer")).toBe(false);
    expect(pushOfferDue({ ...fresh, turnedOff: true }, "answer")).toBe(false);
  });

  test("the stored count; a phone the old flow already asked gets none", () => {
    expect(pushOffersFrom(null, false)).toBe(0);
    expect(pushOffersFrom("1", false)).toBe(1);
    expect(pushOffersFrom("9", false)).toBe(MAX_PUSH_OFFERS);
    expect(pushOffersFrom("x", false)).toBe(0);
    expect(pushOffersFrom(null, true)).toBe(MAX_PUSH_OFFERS);
  });

  test("the examples come from the workspace's agents", () => {
    expect(exampleSenders(["Dev", "Infra", "Vendas", "Pesquisa"], "Um agente")).toEqual(["Dev", "Infra", "Vendas"]);
    expect(exampleSenders(["Dev", "Dev ", ""], "Um agente")).toEqual(["Dev", "Dev", "Dev"]);
    expect(exampleSenders([], "Um agente")).toEqual(["Um agente", "Um agente", "Um agente"]);
  });
});

describe("where the ask shows in a conversation (pushAskAt)", () => {
  const me = "u-renata";
  const mine = { id: "m1", author: { type: "person", id: me } };
  const answer = { id: "m2", author: { type: "agent", id: "a-iara" } };
  const at = (messages: Parameters<typeof pushAskAt>[0], s: Partial<Parameters<typeof pushAskAt>[2]> = {}) =>
    pushAskAt(messages, me, {
      held: false,
      offers: 0,
      permission: "undetermined",
      turnedOff: false,
      waitsOnMe: () => false,
      ...s,
    });

  test("under an agent's answer to someone who wrote first, never before they wrote", () => {
    expect(at([mine, answer])).toEqual({ messageId: "m2", moment: "answer" });
    expect(at([answer])).toBeNull();
    expect(at([answer, mine])).toBeNull();
    expect(at([])).toBeNull();
  });

  test("never under a team's hello, a card, a message still sending, or on a billing hold", () => {
    expect(at([mine, { ...answer, meta: { greeting: true } }])).toBeNull();
    expect(at([mine, { ...answer, meta: { actionCard: { kind: "team_proposal" } } }])).toBeNull();
    expect(at([mine, { ...answer, local: "pending" }])).toBeNull();
    expect(at([mine, answer], { held: true })).toBeNull();
  });

  test("the second time only at a request waiting on the person, then never", () => {
    const ask = { id: "m3", author: { type: "agent", id: "a-iara" }, meta: { approvalId: "ap1" } };
    const waits = (m: { id: string }) => m.id === "m3";
    expect(at([mine, answer], { offers: 1 })).toBeNull();
    expect(at([mine, answer, ask], { offers: 1, waitsOnMe: waits })).toEqual({ messageId: "m3", moment: "approval" });
    expect(at([mine, answer, ask], { offers: 0, waitsOnMe: waits })).toBeNull();
    expect(at([mine, answer, ask], { offers: 2, waitsOnMe: waits })).toBeNull();
    expect(at([mine, answer], { permission: "granted" })).toBeNull();
  });
});
