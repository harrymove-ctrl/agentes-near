import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import { LOCALE_CODES } from "@agenteschat/i18n/locale";
import i18next, { type TFunction } from "i18next";
import { actionCardOf, costlyProposalOf, mayDecideCostly, mayRememberCostly } from "../src/lib/action-cards";
import { serverBody } from "../src/lib/message-body";

/** The autonomy brakes in the apps (ADR 0131): the proposal card and the server's own lines, in every language. */

const tOf = (lng: string) => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as unknown as TFunction;
};

const card = {
  kind: "autonomy_proposal",
  signalId: "s1",
  agentId: "a1",
  cost: "install",
  what: "npm i hyperfine",
  forUserId: "u1",
  state: "open",
  decidedByUserId: null,
};

test("a proposal card: read from the message, and decided by its person, the agent's owner or an admin", () => {
  expect(actionCardOf({ actionCard: card })).toEqual(costlyProposalOf({ actionCard: card }));
  const parsed = costlyProposalOf({ actionCard: { ...card, cost: "weird", state: "weird" } });
  expect(parsed).toMatchObject({ cost: "pr", state: "open" });
  if (!parsed) throw new Error("no card");
  const owner = () => "u2";
  expect(mayDecideCostly(parsed, "u1", owner, false)).toBe(true);
  expect(mayDecideCostly(parsed, "u2", owner, false)).toBe(true);
  expect(mayDecideCostly(parsed, "u3", owner, true)).toBe(true);
  expect(mayDecideCostly(parsed, "u3", owner, false)).toBe(false);
  // "Sempre" and "Nunca" change the agent: not for the person the card is for alone.
  expect(mayRememberCostly(parsed, "u1", owner, false)).toBe(false);
  expect(mayRememberCostly(parsed, "u2", owner, false)).toBe(true);
  expect(mayRememberCostly(parsed, "u3", owner, true)).toBe(true);
});

test("the server's own lines read in every language, never as the English fallback", () => {
  for (const lng of LOCALE_CODES) {
    const t = tOf(lng);
    const status = serverBody(t, "FALLBACK", {
      bodyCode: "talker_status",
      bodyParams: { minutes: "3", steps: "12", kind: "coding", subject: "" },
    });
    const proposal = serverBody(t, "FALLBACK", { bodyCode: "autonomy_proposal", bodyParams: { cost: "pr" } });
    const digest = serverBody(t, "FALLBACK", {
      bodyCode: "autonomy_digest",
      bodyParams: { count: "3", lines: "• x ×3" },
    });
    const loop = serverBody(t, "FALLBACK", { bodyCode: "autonomy_loop", bodyParams: { count: "3", title: "x" } });
    for (const text of [status, proposal, digest, loop]) {
      expect({ lng, text: text.includes("FALLBACK") || text.includes("{{") }).toEqual({ lng, text: false });
    }
    expect(digest).toContain("• x ×3");
  }
});
