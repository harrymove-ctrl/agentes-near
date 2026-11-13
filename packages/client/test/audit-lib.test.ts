import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AuditRow } from "../src/api/types";
import {
  auditDetailEntries,
  auditHint,
  auditOutcome,
  auditQueryOf,
  auditReason,
  auditSentence,
  auditSubLine,
  auditToolSaid,
} from "../src/lib/audit";

// The key and its values, so each test reads which words were picked.
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${key}(${Object.values(o).join(",")})` : key) as unknown as TFunction;

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  id: "a1",
  at: "2026-10-28T12:00:00Z",
  actor: { type: "agent", id: "ag", name: "Ada" },
  action: "tool.call",
  target: { type: "tool", id: "gmail_send" },
  details: { kind: "external", connector: "Gmail", title: "Gmail: Send", behind: "person", input: {} },
  runId: "r1",
  channelId: "c1",
  channel: { id: "c1", name: "geral", kind: "channel" },
  onBehalfOf: { id: "u1", name: "Bia" },
  outcome: "done",
  approval: null,
  secret: null,
  ...over,
});

const standing = (details: Record<string, unknown>) =>
  row({ actor: { type: "system", id: null, name: null }, action: "organization.standing_changed", details });

describe("Auditoria in words (web and phone)", () => {
  test("the shortcuts and the agent ask the server for the same thing on both", () => {
    expect(auditQueryOf("all", null)).toEqual({});
    // An agent: what it did and what people applied from its cards.
    expect(auditQueryOf("problems", "ag")).toEqual({ via: "ag", outcome: ["refused", "failed"] });
    expect(auditQueryOf("waiting", null)).toEqual({ waiting: true });
    // People's changes are people's, whichever agent was picked.
    expect(auditQueryOf("people", "ag")).toEqual({ actorType: "person", kind: "change" });
  });

  test("a billing hold's reason is said in words, never as its code; any other reason as written", () => {
    expect(auditReason(t, standing({ from: "active", to: "hold", reason: "unpaid" }))).toBe(
      "standing.notification.billing.unpaid",
    );
    expect(auditReason(t, standing({ from: "hold", to: "active", reason: null }))).toBeNull();
    expect(auditReason(t, standing({ from: "active", to: "hold", reason: "Spam reports" }))).toBe("Spam reports");
    expect(auditReason(t, row({ details: { reason: "unpaid" } }))).toBe("unpaid");
  });

  test("the category an automatic review hold names is said in words; plain review and an unknown one as written", () => {
    const hold = (reason: string) => auditReason(t, standing({ from: "active", to: "hold", reason }));
    expect(hold("review.phishing_impersonation")).toBe("standing.cloud.reviewWhat.phishing_impersonation");
    expect(hold("review.fraud")).toBe("standing.cloud.reviewWhat.fraud");
    expect(hold("review")).toBe("review");
    expect(hold("review.spam")).toBe("review.spam");
  });

  test("who did what, then about what, who asked and where", () => {
    expect(auditSentence(t, row(), "en")).toEqual({ name: "Ada", text: "audit.call.used(Gmail)" });
    // About what, as the call's approval card says it, never the server's English title ("Gmail: Send").
    expect(auditSubLine(t, row())).toBe("approval.titles.action.send · audit.behind.person(Bia) · #geral");
    const expired = row({ actor: { type: "system", id: null, name: null }, action: "approval.expired", details: {} });
    expect(auditSentence(t, expired, "en")).toEqual({ name: null, text: "audit.change.approval.expired" });
    const gone = row({ actor: { type: "person", id: "u1", name: "Bia" }, action: "channel.deleted", details: {} });
    expect(auditSentence(t, gone, "en").text).toBe(
      "audit.change.pattern(audit.change.verb.deleted,audit.change.area.channel)",
    );
  });

  test("a call's title in the person's words, as its approval card says it, never the server's English", () => {
    const merge = row({
      target: { type: "tool", id: "github_merge_pull_request" },
      details: {
        kind: "external",
        connector: "GitHub",
        title: "Merge PR #12 in acme/app",
        behind: "person",
        input: { owner: "acme", repo: "app", pullNumber: 12 },
      },
    });
    const worded = "approval.titles.github.merge_pull_request(12,,acme/app,Merge PR #12 in acme/app)";
    expect(auditHint(t, merge)).toBe(worded);
    expect(auditSubLine(t, merge)).toBe(`${worded} · audit.behind.person(Bia) · #geral`);
    // A change keeps its own name.
    expect(auditHint(t, row({ action: "wiki.page_created", details: { title: "Onboarding" } }))).toBe("Onboarding");
  });

  test("a call that didn't go through says why only in words; what the tool said goes to the technical part", () => {
    const base = row().details;
    const refused = row({
      outcome: "refused",
      details: { ...base, reason: "Not allowed: this agent lacks the scope github:pr.merge", refusal: "noAccess" },
    });
    expect(auditReason(t, refused)).toBe("chat.work.refusal.noAccess()");
    expect(auditToolSaid(refused)).toBe("Not allowed: this agent lacks the scope github:pr.merge");
    const failed = row({
      outcome: "failed",
      details: { ...base, reason: "Failed: That person isn't in this conversation" },
    });
    expect(auditReason(t, failed)).toBeNull();
    expect(auditToolSaid(failed)).toBe("Failed: That person isn't in this conversation");
    // The reason an agent gave when it asked a person is its own words: it stays.
    const asked = row({ outcome: "pending", details: { ...base, reason: "To ship the fix today" } });
    expect(auditReason(t, asked)).toBe("To ship the fix today");
    expect(auditToolSaid(asked)).toBeNull();
  });

  test("a change's details never list an id, in any spelling", () => {
    const details = {
      name: "Acme",
      connectionId: "c-1",
      machineId: "m-1",
      agentIds: ["a"],
      toStorageConfigId: "s",
      delivery_id: "d",
      id: "x",
      paid: true,
      reason: "r",
    };
    expect(auditDetailEntries(details).map(([k]) => k)).toEqual(["name", "paid"]);
  });

  test("a merge done without asking says where", () => {
    const merged = row({
      action: "agent.merged_without_asking",
      target: { type: "repository", id: "acme/app" },
      details: {},
    });
    expect(auditSentence(t, merged, "en").text).toBe("audit.change.mergedWithoutAsking(acme/app)");
  });

  test("a waiting call says what became of its approval or of the secret it asked for", () => {
    expect(auditOutcome(t, row())).toMatchObject({ mood: "done", text: "audit.outcome.done" });
    const waiting = row({ outcome: "pending", approval: { id: "ap", status: "pending", decidedBy: null } });
    expect(auditOutcome(t, waiting)).toMatchObject({ mood: "waiting", text: "audit.outcome.pending" });
    const refused = row({ outcome: "pending", approval: { id: "ap", status: "refused", decidedBy: null } });
    expect(auditOutcome(t, refused)).toMatchObject({ mood: "refused", text: "audit.outcome.refusedByPerson" });
    const asked = row({ outcome: "pending", secret: { id: "s", status: "pending" } });
    expect(auditOutcome(t, asked)).toMatchObject({ mood: "waiting", text: "audit.outcome.pendingSecret" });
    const delivered = row({ outcome: "pending", secret: { id: "s", status: "delivered" } });
    expect(auditOutcome(t, delivered)).toMatchObject({ mood: "neutral", text: "audit.outcome.delivered" });
    expect(auditOutcome(t, row({ action: "routine.created", outcome: null }))).toBeNull();
  });
});
