import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AppNotification } from "../src/api/types";
import { ACCOUNT_BLOCKED, holdText, LEGAL_EMAIL, restrictionLine, suspendedText } from "../src/lib/errors";
import { restrictionOf, workspaceHeadline } from "../src/lib/notifications";
import { endSentence } from "../src/lib/text";

/** The key and its values, so a test sees which words were picked (the words themselves: packages/i18n). */
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length > 0 ? `${key} ${JSON.stringify(o)}` : key) as unknown as TFunction;

const EMAIL = `{"email":"${LEGAL_EMAIL}"}`;
const CONTEST = `standing.cloud.contest ${EMAIL}`;
const REVIEW_FOR = (category: string) =>
  `standing.cloud.reviewFor {"email":"${LEGAL_EMAIL}","what":"standing.cloud.reviewWhat.${category}"}`;
const cloud = { cloud: true };

describe("a restriction's line on agentes.chat Cloud, by its kind, never its stored reason", () => {
  test("the automatic review hold, an operator's shown reason, a silent one", () => {
    expect(restrictionLine(t, "org.paused", { reason: "review", ...cloud })).toBe(`standing.cloud.review ${EMAIL}`);
    expect(restrictionLine(t, "run.org_paused", { reason: "review", cloud: "true" })).toBe(
      `standing.cloud.review ${EMAIL}`,
    );
    expect(restrictionLine(t, "org.paused", { reason: "Terms 5: phishing", ...cloud })).toBe(
      `standing.onHold {"reason":"Terms 5: phishing"}. ${CONTEST}`,
    );
    expect(restrictionLine(t, "run.org_suspended", { reason: "Terms 5: spam", cloud: "true" })).toBe(
      `standing.suspendedFor {"reason":"Terms 5: spam"}. ${CONTEST}`,
    );
    // Silent: only that it is paused, nothing to contest.
    expect(restrictionLine(t, "org.paused", cloud)).toBe("standing.paused");
    expect(restrictionLine(t, "org.suspended", cloud)).toBe("standing.suspended");
  });

  test("the automatic review hold names what was flagged; a category it doesn't know reads as plain review", () => {
    expect(restrictionLine(t, "org.paused", { reason: "review.phishing_impersonation", ...cloud })).toBe(
      REVIEW_FOR("phishing_impersonation"),
    );
    expect(restrictionLine(t, "run.org_paused", { reason: "review.fraud", cloud: "true" })).toBe(REVIEW_FOR("fraud"));
    expect(holdText(t, { state: "hold", reason: "review.account_takeover", cloud: true })).toBe(
      REVIEW_FOR("account_takeover"),
    );
    for (const reason of ["review.spam", "review."])
      expect(restrictionLine(t, "org.paused", { reason, ...cloud })).toBe(`standing.cloud.review ${EMAIL}`);
  });

  test("an ended plan's hold is a billing matter: its own words, nothing to contest", () => {
    expect(restrictionLine(t, "org.paused", { reason: "ended", ...cloud })).toBe("standing.billing.ended");
    expect(restrictionLine(t, "run.org_paused", { reason: "ended", cloud: "true" })).toBe("standing.billing.ended");
    expect(holdText(t, { state: "hold", reason: "ended", cloud: true })).toBe("standing.billing.ended");
  });

  test("a held agent: a network rule's or the team's", () => {
    expect(restrictionLine(t, "agent.paused", { kind: "network", ...cloud })).toBe(
      `standing.cloud.agentNetwork ${EMAIL}`,
    );
    expect(restrictionLine(t, "run.agent_paused", { kind: "operator", cloud: "true" })).toBe(
      `standing.cloud.agentOperator ${EMAIL}`,
    );
    // A run refused before the kinds were kept: the plain line.
    expect(restrictionLine(t, "run.agent_paused", { cloud: "true" })).toBe("standing.agentPaused");
  });

  test("a blocked account: abuse, a legal hold, anything else; a refused workspace", () => {
    expect(restrictionLine(t, ACCOUNT_BLOCKED, { kind: "abuse", ...cloud })).toBe(
      `standing.cloud.blockedAbuse ${EMAIL}`,
    );
    expect(restrictionLine(t, ACCOUNT_BLOCKED, { kind: "legal", ...cloud })).toBe(
      `standing.cloud.blockedLegal ${EMAIL}`,
    );
    expect(restrictionLine(t, ACCOUNT_BLOCKED, { kind: "other", ...cloud })).toBe(`auth.accountBlocked. ${CONTEST}`);
    expect(restrictionLine(t, "org.create_refused", cloud)).toBe(`standing.cloud.createRefused ${EMAIL}`);
  });
});

describe("a self-hosted server: the words it always had", () => {
  test("every restriction, whatever kind or reason it carries", () => {
    expect(restrictionLine(t, "org.paused", { reason: "review" })).toBe('standing.onHold {"reason":"review"}');
    expect(restrictionLine(t, "org.paused", { reason: "review.fraud" })).toBe(
      'standing.onHold {"reason":"review.fraud"}',
    );
    expect(restrictionLine(t, "org.paused", { reason: "Terms 5: phishing" })).toBe(
      'standing.onHold {"reason":"Terms 5: phishing"}',
    );
    expect(restrictionLine(t, "org.suspended", { reason: "spam" })).toBe('standing.suspendedFor {"reason":"spam"}');
    expect(restrictionLine(t, "agent.paused", { kind: "network" })).toBe("standing.agentPaused");
    expect(restrictionLine(t, ACCOUNT_BLOCKED, { kind: "abuse" })).toBe("auth.accountBlocked");
    expect(restrictionLine(t, ACCOUNT_BLOCKED, null)).toBe("auth.accountBlocked");
    expect(restrictionLine(t, "org.create_refused", undefined)).toBe("standing.createRefused");
    expect(restrictionLine(t, "budget_exceeded", cloud)).toBeNull();
  });

  test("the suspended screen: why when told, with how to contest it only on the Cloud", () => {
    expect(suspendedText(t, { reason: "spam" })).toBe('standing.suspendedFor {"reason":"spam"}');
    expect(suspendedText(t, { reason: "spam", cloud: true })).toBe(
      `standing.suspendedFor {"reason":"spam"}. ${CONTEST}`,
    );
    expect(suspendedText(t, { reason: null, cloud: true })).toBe("standing.screen.text");
    expect(suspendedText(t, undefined)).toBe("standing.screen.text");
  });
});

describe("a restriction's notice in the inbox reads as the restriction itself", () => {
  const notice = (latest: AppNotification["latest"]) => ({ kind: "org_standing" as const, latest });
  const line = (latest: AppNotification["latest"]) => {
    const r = restrictionOf(notice(latest));
    return r ? restrictionLine(t, r.code, r.facts) : null;
  };

  test("a held agent: its headline names the agent, and it reads the hold's line", () => {
    const held = notice({ statusTo: "agent_hold", holdKind: "network" });
    expect(workspaceHeadline(held)).toBe("standing.notification.agentHold");
    expect(restrictionOf(held)).toEqual({ code: "agent.paused", facts: { kind: "network", cloud: true } });
    expect(line(held.latest)).toBe(`standing.cloud.agentNetwork ${EMAIL}`);
    expect(workspaceHeadline(notice({ statusTo: "hold" }))).toBe("standing.notification.hold");
  });

  test("the workspace on agentes.chat Cloud: the review line, an operator's reason with how to contest it", () => {
    expect(line({ statusTo: "hold", text: "review", cloud: true })).toBe(`standing.cloud.review ${EMAIL}`);
    expect(line({ statusTo: "hold", text: "review.illegal_content", cloud: true })).toBe(REVIEW_FOR("illegal_content"));
    expect(line({ statusTo: "hold", text: "Terms 5: phishing", cloud: true })).toBe(
      `standing.onHold {"reason":"Terms 5: phishing"}. ${CONTEST}`,
    );
    expect(line({ statusTo: "suspended", text: "Terms 5: spam", cloud: true })).toBe(
      `standing.suspendedFor {"reason":"Terms 5: spam"}. ${CONTEST}`,
    );
    // Its own text: back to work, with no reason, or from a self-hosted server.
    for (const latest of [
      { statusTo: "active", text: "reactivated", cloud: true },
      { statusTo: "hold", cloud: true },
      { statusTo: "hold", text: "review" },
    ])
      expect(restrictionOf(notice(latest))).toBeNull();
    expect(restrictionOf({ kind: "mention", latest: { statusTo: "agent_hold", text: "x", cloud: true } })).toBeNull();
  });
});

test("a sentence gets its full stop once", () => {
  expect(endSentence("Terms 5: phishing")).toBe("Terms 5: phishing.");
  for (const done of ["Paused.", "Why?", "Stop!", "Wait…"]) expect(endSentence(done)).toBe(done);
});
