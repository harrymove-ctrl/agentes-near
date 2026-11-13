import type { Approval, RunStep } from "../api/types";
import { approvalAction, approvalTraits } from "./approval-kind";
import { approvalReadsOnly } from "./approval-words";

/**
 * A request as the review on the Approvals page reads it: where it acts, the text it will publish, what it does
 * to the outside and whether it can be undone, and the run's steps before and after the decision.
 */

/** Values that hold the text the action writes (a comment, a review, a message, a page): the longest one wins. */
const TEXT_KEYS = ["body", "text", "content", "comment", "message", "markdown", "description", "note"];

/** The text the action will publish, when one of its values is it (an email shows as the email instead). */
export function approvalText(a: Pick<Approval, "params" | "email">): { key: string; text: string } | null {
  if (a.email) return null;
  let best: { key: string; text: string } | null = null;
  for (const [key, value] of Object.entries(a.params ?? {})) {
    if (!TEXT_KEYS.includes(key.toLowerCase()) || typeof value !== "string") continue;
    const text = value.trim();
    if (text && (!best || text.length > best.text.length)) best = { key, text };
  }
  return best;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) =>
  typeof v === "number" ? String(v) : typeof v === "string" && /^\d+$/.test(v.trim()) ? v.trim() : null;

/**
 * Where the action lands, short: "acme/loja #45" (a repository and its issue or pull request), "acme/loja",
 * "#infra", a path; null when its values don't say.
 */
export function approvalTarget(a: Pick<Approval, "params">): string | null {
  const p = a.params ?? {};
  const owner = str(p.owner) ?? str(p.org);
  const repo = str(p.repo) ?? str(p.repository);
  const number =
    num(p.issue_number) ?? num(p.issueNumber) ?? num(p.pull_number) ?? num(p.pullNumber) ?? num(p.number) ?? num(p.pr);
  const full = repo ? (owner && !repo.includes("/") ? `${owner}/${repo}` : repo) : null;
  if (full) return number ? `${full} #${number}` : full;
  const channel = str(p.channel);
  if (channel) return channel.startsWith("#") ? channel : `#${channel}`;
  return str(p.path) ?? str(p.project) ?? null;
}

/** What the action does to the outside: leaves the company, goes to production, sends nothing, only reads. */
export type ApprovalEffect = "external" | "production" | "unsent" | "readsOnly";
/** Whether it can be undone. */
export type ApprovalUndo = "irreversible" | "reversible" | "deletable";

export function approvalEffects(a: Pick<Approval, "tool" | "scope" | "params" | "connector">): {
  effect: ApprovalEffect | null;
  undo: ApprovalUndo | null;
} {
  const traits = approvalTraits(a);
  const effect: ApprovalEffect | null = traits.includes("production")
    ? "production"
    : traits.includes("external")
      ? "external"
      : traits.includes("unsent")
        ? "unsent"
        : approvalReadsOnly(a)
          ? "readsOnly"
          : // A connector's write lands in a service outside the app.
            a.connector && approvalAction(a) === "other"
            ? "external"
            : null;
  const undo: ApprovalUndo | null = traits.includes("irreversible")
    ? "irreversible"
    : traits.includes("deletable")
      ? "deletable"
      : traits.includes("reversible")
        ? "reversible"
        : null;
  return { effect, undo };
}

/**
 * The run's steps split at the request: what the agent did before it asked, and after the decision (the approved
 * action and what followed). A run that asked several times splits at this request's own time.
 */
export function stepsAround(
  steps: RunStep[],
  a: Pick<Approval, "createdAt" | "decidedAt" | "status">,
): { before: RunStep[]; after: RunStep[] } {
  const asked = new Date(a.createdAt).getTime();
  const decided = a.decidedAt ? new Date(a.decidedAt).getTime() : null;
  const at = (s: RunStep) => new Date(s.createdAt).getTime();
  const later = a.status === "approved" && decided !== null ? steps.filter((s) => at(s) >= decided) : [];
  // The approved call was made before the ask and answered after the decision: it reads after, with its result.
  const answered = new Set(later.flatMap((s) => (s.kind === "tool_result" ? [s.data.toolUseId] : [])));
  const held = (s: RunStep) => s.kind === "tool_call" && answered.has(s.data.toolUseId);
  return {
    before: steps.filter((s) => at(s) <= asked && !held(s)),
    after: [...steps.filter((s) => at(s) < (decided ?? 0) && held(s)), ...later],
  };
}
