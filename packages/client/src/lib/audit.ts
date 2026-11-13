import type { TFunction } from "i18next";
import type { AuditQuery, AuditRow } from "../api/types";
import { serviceKey, toolActivity } from "./activity";
import { approvalTitle } from "./approval-words";
import { billingHoldOf } from "./billing";
import { reviewFlaggedOf } from "./errors";
import { lowerFirst } from "./format";
import { stepLabel, toolWhy } from "./work";

/*
 * Configurações › Auditoria in words, for the web and the phone alike: the shortcuts on top, a row's sentence
 * (who, what), the line under it (about what, asked by whom, where), how it ended and its panel's facts.
 */

export const TOOL_CALL = "tool.call";

/** The shortcuts over the list: one view at a time. */
export type AuditShow = "all" | "problems" | "waiting" | "people";
export const AUDIT_SHOWS: readonly AuditShow[] = ["all", "problems", "waiting", "people"];

/**
 * What a shortcut and the agent filter (an agent's id, or null for every agent) ask the server. An agent: what it did
 * and what people applied from its cards (`via`, ADR 0137).
 */
export function auditQueryOf(show: AuditShow, agentId: string | null): AuditQuery {
  const agent: AuditQuery = agentId ? { via: agentId } : {};
  if (show === "problems") return { ...agent, outcome: ["refused", "failed"] };
  if (show === "waiting") return { ...agent, waiting: true };
  if (show === "people") return { actorType: "person", kind: "change" };
  return agent;
}

export const auditStr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A call that didn't go through: refused (by the Tool Gateway, a rule, a person) or failed. */
const notThrough = (row: AuditRow) =>
  row.action === TOOL_CALL && (row.outcome === "refused" || row.outcome === "failed");

/**
 * A row's reason as its panel says it: a billing hold's code (ADR 0079) and the category an automatic review hold
 * names (`review.<category>`) in words, never as they come. A call that didn't go through says why only in words, by
 * its refusal's code (`details.refusal`, as its line in the chat): what the tool said goes to the technical part.
 */
export function auditReason(t: TFunction, row: AuditRow): string | null {
  if (notThrough(row)) return toolWhy(t, { refusal: auditStr(row.details.refusal) });
  const reason = auditStr(row.details.reason);
  if (!reason || row.action !== "organization.standing_changed" || row.details.to !== "hold") return reason;
  const billing = billingHoldOf({ state: "hold", reason });
  if (billing) return t(`standing.notification.billing.${billing}`);
  const flagged = reviewFlaggedOf(reason);
  return flagged ? t(`standing.cloud.reviewWhat.${flagged}`) : reason;
}

/** Who did it, by name; null for the system (its sentence stands alone). */
export function auditActorName(t: TFunction, row: AuditRow): string | null {
  if (row.actor.type === "system") return null;
  return row.actor.name ?? t("audit.removed");
}

/** "Usou o Gmail", "Criou uma tarefa", "Aprovou um pedido", "Criou uma rotina". */
export function auditPhrase(t: TFunction, row: AuditRow): string {
  if (row.action === TOOL_CALL) {
    const kind = auditStr(row.details.kind);
    const connector = auditStr(row.details.connector);
    if (connector) return t(kind === "read" ? "audit.call.consulted" : "audit.call.used", { app: connector });
    if (kind === "computer") return t("audit.call.computer");
    // The chat's words for our own tools ("Criou uma tarefa"); its guesses from a name's prefix ("Leu o
    // Drive" for `drive_delete`) only fit reads, so anything else says the tool's name.
    const guessed = toolActivity(row.target.id, null, null);
    const activity =
      (guessed.kind === "consulting" || guessed.kind === "readingDrive") && kind !== "read"
        ? { kind: "usingTool" as const }
        : guessed;
    return stepLabel(t, { ...activity, tool: row.target.id ?? "" });
  }
  if (row.action === "agent.merged_without_asking") {
    return t("audit.change.mergedWithoutAsking", { repo: row.target.id ?? "" });
  }
  const [area = "", rest = ""] = row.action.split(".");
  if (area === "approval") {
    const status = (["approved", "refused", "expired"] as const).find((s) => s === rest);
    if (status) return t(`audit.change.approval.${status}`);
  }
  if (area === "member") {
    const what = (["joined", "left", "role_changed"] as const).find((s) => s === rest);
    if (what) return t(`audit.change.member.${what}`);
  }
  // AI apps (ADR 0119): the app's or the token's name, as it was shown when it happened.
  if (area === "apps") {
    const what = (
      ["connected", "scopes_changed", "disconnected", "token_created", "token_revoked", "message_sent"] as const
    ).find((s) => s === rest);
    const app = auditStr(row.details.app) ?? auditStr(row.details.client);
    if (what && app) return t(`audit.change.apps.${what}`, { app });
  }
  // The Vault (ADR 0144): its own sentences, since a value shown or copied and a password manager connected don't
  // read as "<verb> <area>".
  if (area === "vault") {
    const what = VAULT_ACTIONS.find((s) => s === rest);
    if (what) return t(`audit.change.vault.${what}`);
  }
  const last = (rest.split("_").at(-1) ?? "").replace("cancelled", "canceled");
  const verb = VERBS.find((v) => v === last) ?? "other";
  const where = AREAS.find((a) => a === area) ?? "other";
  return t("audit.change.pattern", {
    verb: t(`audit.change.verb.${verb}`),
    area: t(`audit.change.area.${where}`),
  });
}

/** The sentence in two parts, so the name can be drawn bold: `name` null for the system. */
export function auditSentence(t: TFunction, row: AuditRow, locale: string): { name: string | null; text: string } {
  const name = auditActorName(t, row);
  const text = auditPhrase(t, row);
  return { name, text: name ? lowerFirst(text, locale) : text };
}

/** The Vault's actions (ADR 0144), each with a sentence of its own. */
const VAULT_ACTIONS = [
  "item_created",
  "item_changed",
  "item_deleted",
  "item_used",
  "imported",
  "connection_added",
  "connection_changed",
  "connection_removed",
] as const;

/** A change's action is `area.what_happened`: its last word is the verb ("page_created" → created). */
const VERBS = [
  "created",
  "deleted",
  "updated",
  "changed",
  "connected",
  "disconnected",
  "reconnected",
  "removed",
  "added",
  "started",
  "stopped",
  "paused",
  "renamed",
  "restored",
  "moved",
  "activated",
  "imported",
  "shared",
  "uploaded",
  "requested",
  "delivered",
  "declined",
  "expired",
  "canceled",
  "sent",
  "push",
  "fetch",
  "exec",
  "resent",
  "revoked",
  "archived",
  "shown",
  "copied",
  "used",
] as const;
const AREAS = [
  "routine",
  "wiki",
  "mission",
  "thread",
  "channel",
  "artifact",
  "agent",
  "machine",
  "sandbox",
  "connector",
  "database",
  "mail_account",
  "mail",
  "secret",
  "skill",
  "storage",
  "organization",
  "account",
  "github_app",
  "git",
  "import",
  "webhook",
  "issue",
  "message",
  "run",
  "member",
  "invitation",
  "credential",
  "vault",
] as const;

/** What a call or a change didn't go through with, in the tool's own words (often English): the technical part's. */
export const auditToolSaid = (row: AuditRow) => (notThrough(row) ? auditStr(row.details.reason) : null);

/** A call's title as its approval card says it, in the person's language (the server's is English). */
function auditCallTitle(t: TFunction, row: AuditRow) {
  const title = auditStr(row.details.title);
  if (!title) return null;
  const input = row.details.input;
  const params = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  // The row keeps the connection's label ("GitHub"): its key tells the tool's own name apart from it.
  const label = auditStr(row.details.connector);
  return approvalTitle(t, { tool: row.target.id ?? "", title, params, connector: label ? serviceKey(label) : null });
}

/** What the row is about in its own words (the call's title in the person's words, a change's name). */
export const auditHint = (t: TFunction, row: AuditRow) =>
  (row.action === TOOL_CALL ? auditCallTitle(t, row) : auditStr(row.details.title)) ??
  auditStr(row.details.name) ??
  auditStr(row.details.label) ??
  auditStr(row.details.subject) ??
  auditStr(row.details.email);

/** Where it happened: "#geral", "conversa privada". */
export function auditWhere(t: TFunction, row: AuditRow) {
  const c = row.channel;
  if (!c) return null;
  if (c.kind === "dm") return t("audit.where.dm");
  return `#${c.name}`;
}

/** The routine behind a call, by name. */
export const auditRoutine = (row: AuditRow) => auditStr((row.details.routine as { name?: unknown } | undefined)?.name);

/** Who is behind a call: "pedido por Ana", "rotina Resumo", "por conta própria". */
export function auditBehind(t: TFunction, row: AuditRow) {
  const behind = auditStr(row.details.behind);
  if (behind === "person" && row.onBehalfOf) {
    return t("audit.behind.person", { name: row.onBehalfOf.name ?? t("audit.removed") });
  }
  if (behind === "routine") {
    const name = auditRoutine(row);
    return name ? t("audit.behind.routine", { name }) : t("audit.behind.routineAny");
  }
  if (behind === "unattended") return t("audit.behind.unattended");
  return null;
}

/** The line under the sentence: about what · who asked · where. */
export function auditSubLine(t: TFunction, row: AuditRow) {
  return [auditHint(t, row), auditBehind(t, row), auditWhere(t, row)].filter(Boolean).join(" · ");
}

/**
 * How it ended, as each app draws it: `done` (green), `waiting` (amber), `refused` and `failed` (their own
 * mark), or `neutral` (a person's decision, an expiry).
 */
export type AuditMood = "done" | "waiting" | "refused" | "failed" | "neutral";
/** The mark beside the words (each app has its own icon for it). */
export type AuditMark = "check" | "block" | "clock" | "stop" | "alert" | "waiting";
export interface AuditOutcome {
  mood: AuditMood;
  mark: AuditMark;
  text: string;
}

/**
 * How it ended: a call's outcome (a waiting call says what became of its approval or of the secret it asked
 * for); an approval's decision. Null for the rest.
 */
export function auditOutcome(t: TFunction, row: AuditRow): AuditOutcome | null {
  if (row.action === TOOL_CALL) {
    if (row.outcome === "pending" && row.approval && row.approval.status !== "pending") {
      const s = row.approval.status;
      if (s === "approved") return { mood: "neutral", mark: "check", text: t("audit.outcome.approved") };
      if (s === "refused") return { mood: "refused", mark: "block", text: t("audit.outcome.refusedByPerson") };
      if (s === "expired") return { mood: "neutral", mark: "clock", text: t("audit.outcome.expired") };
      return { mood: "neutral", mark: "stop", text: t("audit.outcome.canceled") };
    }
    if (row.outcome === "pending" && row.secret && row.secret.status !== "pending") {
      const s = row.secret.status;
      if (s === "delivered") return { mood: "neutral", mark: "check", text: t("audit.outcome.delivered") };
      if (s === "declined") return { mood: "refused", mark: "block", text: t("audit.outcome.declined") };
      if (s === "expired") return { mood: "neutral", mark: "clock", text: t("audit.outcome.expired") };
      return { mood: "neutral", mark: "stop", text: t("audit.outcome.canceled") };
    }
    if (row.outcome === "done") return { mood: "done", mark: "check", text: t("audit.outcome.done") };
    if (row.outcome === "failed") return { mood: "failed", mark: "alert", text: t("audit.outcome.failed") };
    if (row.outcome === "refused") return { mood: "refused", mark: "block", text: t("audit.outcome.refused") };
    if (row.outcome === "pending") {
      const text = row.secret ? t("audit.outcome.pendingSecret") : t("audit.outcome.pending");
      return { mood: "waiting", mark: "waiting", text };
    }
    return null;
  }
  if (row.action === "approval.approved") return { mood: "neutral", mark: "check", text: t("audit.outcome.approved") };
  if (row.action === "approval.refused") {
    return { mood: "neutral", mark: "block", text: t("audit.outcome.refusedByPerson") };
  }
  if (row.action === "approval.expired") return { mood: "neutral", mark: "clock", text: t("audit.outcome.expired") };
  return null;
}

/** Which heading the reason gets in the panel ("Por que foi recusado", "O que deu errado"…). */
export const auditReasonKey = (row: AuditRow) =>
  row.outcome === "refused" || row.outcome === "failed" || row.outcome === "pending" ? row.outcome : "other";

/** The approval as it stands now: "Aprovado por Ana", "Ainda ninguém respondeu". */
export function auditApprovalText(t: TFunction, a: NonNullable<AuditRow["approval"]>) {
  const who = a.decidedBy?.name ?? t("audit.panel.someone");
  if (a.status === "pending") return t("audit.panel.approvalWaiting");
  if (a.status === "approved") return t("audit.panel.approvalApproved", { name: who });
  if (a.status === "refused") return t("audit.panel.approvalRefused", { name: who });
  if (a.status === "expired") return t("audit.panel.approvalExpired");
  return t("audit.panel.approvalCanceled");
}

/** The secret a call asked for, as it stands now: "Entregue", "Recusado", "Ainda ninguém respondeu". */
export function auditSecretText(t: TFunction, s: NonNullable<AuditRow["secret"]>) {
  if (s.status === "pending") return t("audit.panel.approvalWaiting");
  if (s.status === "delivered") return t("audit.panel.secretDelivered");
  if (s.status === "declined") return t("audit.panel.secretDeclined");
  if (s.status === "expired") return t("audit.panel.approvalExpired");
  return t("audit.panel.approvalCanceled");
}

/** A value the audit kept hidden (a secret-looking field's). */
export const AUDIT_HIDDEN = "***";

/** A change's details worth showing: never an id (`connectionId`, `agentIds`…), nor the call's own fields. */
const HIDDEN_DETAILS = new Set(["kind", "behind", "input", "reason", "refusal", "routine"]);
const AN_ID = /(?:^ids?|Ids?|_ids?)$/;
export function auditDetailEntries(details: Record<string, unknown>): [string, unknown][] {
  return Object.entries(details).filter(([k, v]) => !HIDDEN_DETAILS.has(k) && !AN_ID.test(k) && v !== null && v !== "");
}

/** A kept value as text (a nested one as JSON). */
export const auditValueText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
