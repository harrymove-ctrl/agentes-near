import { describe, expect, test } from "bun:test";
import type { ApprovalEmail, RunStep } from "../src/index";
import { approvalEffects, approvalTarget, approvalText, stepsAround } from "../src/lib/approval-review";

const email: ApprovalEmail = {
  verb: "send",
  mailbox: "support@acme.com",
  provider: "iCloud",
  from: "support@acme.com",
  to: ["ana@acme.com"],
  cc: [],
  bcc: [],
  subject: "Re: Question",
  body: "Thanks!",
  original: null,
};

describe("the text a request will publish", () => {
  test("the longest of its text values, by key in any case, trimmed", () => {
    expect(
      approvalText({ params: { body: "Looks good", description: "A longer description of the change" }, email: null }),
    ).toEqual({ key: "description", text: "A longer description of the change" });
    expect(approvalText({ params: { Body: "  Ship it  " }, email: null })).toEqual({ key: "Body", text: "Ship it" });
  });

  test("only text keys count: a long title, a number or blank text is no text", () => {
    expect(
      approvalText({ params: { title: "A title much longer than the body itself", body: "Short" }, email: null }),
    ).toEqual({ key: "body", text: "Short" });
    expect(approvalText({ params: { body: "   ", text: 42, comment: null }, email: null })).toBeNull();
    expect(approvalText({ params: {}, email: null })).toBeNull();
  });

  test("an email shows as the email, never as its text", () => {
    expect(approvalText({ params: { body: "Thanks!" }, email })).toBeNull();
  });
});

describe("where a request acts", () => {
  test("a repository and its issue or pull request", () => {
    expect(approvalTarget({ params: { owner: "acme", repo: "loja", issue_number: 45 } })).toBe("acme/loja #45");
    expect(approvalTarget({ params: { owner: "acme", repo: "loja", pullNumber: "12" } })).toBe("acme/loja #12");
    expect(approvalTarget({ params: { org: "acme", repository: "loja", pr: 7 } })).toBe("acme/loja #7");
  });

  test("a repository already written with its owner keeps it; a number that isn't one is left out", () => {
    expect(approvalTarget({ params: { owner: "other", repo: "acme/loja" } })).toBe("acme/loja");
    expect(approvalTarget({ params: { repo: "acme/loja", number: "abc" } })).toBe("acme/loja");
    expect(approvalTarget({ params: { repo: "loja" } })).toBe("loja");
  });

  test("a channel with its #, a path, a project; null when its values don't say", () => {
    expect(approvalTarget({ params: { channel: "infra" } })).toBe("#infra");
    expect(approvalTarget({ params: { channel: "#infra" } })).toBe("#infra");
    expect(approvalTarget({ params: { path: "docs/plan.md" } })).toBe("docs/plan.md");
    expect(approvalTarget({ params: { project: "site" } })).toBe("site");
    expect(approvalTarget({ params: { issue_number: 45 } })).toBeNull();
    expect(approvalTarget({ params: {} })).toBeNull();
  });
});

describe("what a request does to the outside", () => {
  const of = (tool: string, scope: string, params: Record<string, unknown> = {}, connector: string | null = null) =>
    approvalEffects({ tool, scope, params, connector });

  test("a send leaves the company for good; a publish leaves it", () => {
    expect(of("send_email", "mail:send")).toEqual({ effect: "external", undo: "irreversible" });
    expect(of("linkedin_publish_post", "custom:conn-social:write", {}, "custom:conn-social")).toEqual({
      effect: "external",
      undo: null,
    });
  });

  test("a merge can be undone; a deploy goes to production, as does a value that names it", () => {
    expect(of("merge_pull_request", "github:pr.merge", {}, "github")).toEqual({ effect: null, undo: "reversible" });
    expect(of("run_workflow", "github:actions.run", {}, "github")).toEqual({
      effect: "production",
      undo: "reversible",
    });
    expect(of("update_config", "custom:conn-ops:write", { env: "prod" })).toEqual({ effect: "production", undo: null });
  });

  test("a draft sends nothing and can be deleted", () => {
    expect(of("draft_email", "mail:draft")).toEqual({ effect: "unsent", undo: "deletable" });
  });

  test("a read only reads, also through a connector", () => {
    expect(of("get_issue", "custom:conn-linear:approval", {}, "custom:conn-linear")).toEqual({
      effect: "readsOnly",
      undo: null,
    });
    expect(of("list_rows", "custom:conn-db:read")).toEqual({ effect: "readsOnly", undo: null });
  });

  test("a connector's write lands outside the app; one of our own tools says nothing", () => {
    expect(of("update_issue", "custom:conn-linear:write", {}, "custom:conn-linear")).toEqual({
      effect: "external",
      undo: null,
    });
    expect(of("goal_upsert", "panel:write")).toEqual({ effect: null, undo: null });
  });
});

describe("a run's steps around a request", () => {
  const T0 = Date.parse("2026-11-04T10:00:00.000Z");
  const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
  const step = (seq: number, kind: string, seconds: number, data: Record<string, unknown> = {}): RunStep => ({
    seq,
    kind,
    data,
    createdAt: at(seconds),
  });
  const seqs = (steps: RunStep[]) => steps.map((s) => s.seq);
  // Asked at 0 s, decided at 300 s: the approved call was made at the ask and answered after the decision.
  const steps = [
    step(1, "model_call", -120),
    step(2, "tool_call", -60, { toolUseId: "t1", name: "get_pull_request" }),
    step(3, "tool_result", -59, { toolUseId: "t1" }),
    step(4, "tool_call", 0, { toolUseId: "t2", name: "merge_pull_request" }),
    step(5, "model_call", 120),
    step(6, "tool_result", 301, { toolUseId: "t2" }),
    step(7, "model_call", 360),
  ];

  test("approved: what it did before it asked, then the approved call with its answer and what followed", () => {
    const around = stepsAround(steps, { createdAt: at(0), decidedAt: at(300), status: "approved" });
    expect(seqs(around.before)).toEqual([1, 2, 3]);
    // The held call moves after, first; a step between the ask and the decision is in neither.
    expect(seqs(around.after)).toEqual([4, 6, 7]);
  });

  test("a call answered before the decision stays before", () => {
    const answered = steps.map((s) => (s.seq === 6 ? { ...s, createdAt: at(200) } : s));
    const around = stepsAround(answered, { createdAt: at(0), decidedAt: at(300), status: "approved" });
    expect(seqs(around.before)).toEqual([1, 2, 3, 4]);
    expect(seqs(around.after)).toEqual([7]);
  });

  test("waiting, refused or approved without a time: nothing after, nothing moved", () => {
    const pending = stepsAround(steps, { createdAt: at(0), decidedAt: null, status: "pending" });
    expect(seqs(pending.before)).toEqual([1, 2, 3, 4]);
    expect(pending.after).toEqual([]);
    const refused = stepsAround(steps, { createdAt: at(0), decidedAt: at(300), status: "refused" });
    expect(seqs(refused.before)).toEqual([1, 2, 3, 4]);
    expect(refused.after).toEqual([]);
    expect(stepsAround(steps, { createdAt: at(0), decidedAt: null, status: "approved" }).after).toEqual([]);
  });

  test("a run that asked again later splits at this request's own time", () => {
    const around = stepsAround(steps, { createdAt: at(-60), decidedAt: null, status: "pending" });
    expect(seqs(around.before)).toEqual([1, 2]);
  });
});
