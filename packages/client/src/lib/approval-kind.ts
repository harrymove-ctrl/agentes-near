import type { Approval, ApprovalEmail } from "../api/types";
import type { Words } from "./routine-view";

/**
 * What an approval would do, the same on the web and the phone: its verb (the
 * primary button, "Aprovar merge"), how risky it is (high risk takes a hold,
 * never a click) and what it touches, said as chips.
 */

export type ApprovalAction = "merge" | "deploy" | "rollback" | "publish" | "delete" | "send" | "draft" | "other";

export type ApprovalTrait = "production" | "irreversible" | "reversible" | "external" | "unsent" | "deletable";

/** A mailbox's scopes say exactly what a mail tool does (ADR 0038); never guessed from its name. */
const MAIL_ACTION: Record<string, ApprovalAction> = {
  "mail:draft": "draft",
  "mail:send": "send",
  "mail:delete": "delete",
  "mail:organize": "other",
  "mail:read": "other",
};

/** The verb of the action, from the tool and scope the agent asked for. */
export function approvalAction(a: Pick<Approval, "tool" | "scope">): ApprovalAction {
  const mail = MAIL_ACTION[a.scope];
  if (mail) return mail;
  const text = `${a.tool} ${a.scope}`.toLowerCase();
  if (text.includes("merge")) return "merge";
  if (text.includes("rollback")) return "rollback";
  if (text.includes("deploy") || text.includes("workflow") || text.includes("actions.run")) return "deploy";
  if (/delete|remove|destroy|drop|purge/.test(text)) return "delete";
  if (/send|email|mail\b|sms/.test(text) && !text.includes("post_message")) return "send";
  if (text.includes("share") || text.includes("publish")) return "publish";
  return "other";
}

/** Production, can't be undone, or leaves the company: approving takes a hold. A draft stays in the mailbox. */
export function approvalRisk(a: Pick<Approval, "tool" | "scope">): "high" | "normal" {
  const action = approvalAction(a);
  return action === "deploy" || action === "rollback" || action === "delete" || action === "send" ? "high" : "normal";
}

/** An "Aprovar sempre leituras" rule's action prefix; mirrors engine `approval-rules.ts` `SQL_READS`. */
const SQL_READS = "sql-read:";

/** What an "Aprovar sempre leituras" kind or rule is kept by (`project_id=abc`), or null when it isn't one. */
export function sqlReadsTarget(action: string | undefined): string | null {
  return action?.startsWith(SQL_READS) ? action.slice(SQL_READS.length) : null;
}

/**
 * "Aprovar sempre" shows on the card: the server offers it on this request, the person may decide it, and approving
 * takes no hold (what is high risk is never approved for good). "Sempre nesta rotina" reaches a routine's own job, a
 * send included: the server already left merges, deploys, payments and deletions out.
 */
export const approveAlwaysOffered = (a: Pick<Approval, "status" | "canDecide" | "approveAlways" | "tool" | "scope">) =>
  a.status === "pending" &&
  a.canDecide &&
  Boolean(a.approveAlways) &&
  (Boolean(a.approveAlways?.routineId) || approvalRisk(a) !== "high");

/**
 * Where an action prepared ahead (`runAt`, `schedule_action`) stands: waiting for a person (`asking`), approved and
 * waiting for its time (`scheduled`), or done (`ran`); ended without running: approved but its run didn't do it in
 * time (`lapsed`), not approved by its time (`unapproved`) or withdrawn (`canceled`). Null for an action that runs
 * once approved, or a refused one.
 */
export function aheadPhase(
  a: Pick<Approval, "runAt" | "status" | "executedAt" | "decidedAt">,
): "asking" | "scheduled" | "ran" | "lapsed" | "unapproved" | "canceled" | null {
  if (!a.runAt) return null;
  if (a.executedAt) return "ran";
  if (a.status === "pending") return "asking";
  if (a.status === "approved") return "scheduled";
  if (a.status === "expired") return a.decidedAt ? "lapsed" : "unapproved";
  return a.status === "canceled" ? "canceled" : null;
}

/** What the action touches: only what the request itself says. */
export function approvalTraits(a: Pick<Approval, "tool" | "scope" | "params">): ApprovalTrait[] {
  const action = approvalAction(a);
  if (action === "draft") return ["unsent", "deletable"];
  const values = Object.values(a.params ?? {})
    .filter((v) => typeof v === "string")
    .join(" ")
    .toLowerCase();
  const traits: ApprovalTrait[] = [];
  if (action === "deploy" || action === "rollback" || /\bprod(uction)?\b/.test(values)) traits.push("production");
  if (action === "delete" || action === "send") traits.push("irreversible");
  else if (action === "merge" || action === "deploy") traits.push("reversible");
  if (action === "send" || action === "publish") traits.push("external");
  return traits;
}

/**
 * What a mail approval does, in words (`approval.email.title.*`): "Salvar um rascunho de resposta para
 * ana@acme.com", "Enviar um e-mail para ana@acme.com e mais 2", "Responder…", "Encaminhar…".
 */
export function emailTitleWords(email: ApprovalEmail): Words {
  const all = [...email.to, ...email.cc, ...email.bcc];
  const more = Math.max(0, all.length - 1);
  const values = { to: all[0] ?? "", more };
  // One recipient has its own key: a count-keyed plural reads "and 0 more" where `_one` is missing (ja, zh-Hans).
  const tail = more > 0 ? "More" : "";
  if (email.verb !== "draft") return { key: `approval.email.title.${email.verb}${tail}`, values };
  if (all.length === 0) return { key: "approval.email.title.draftNoTo", values };
  return { key: `approval.email.title.${email.original ? "draftReply" : "draft"}${tail}`, values };
}
