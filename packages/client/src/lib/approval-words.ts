import type { TFunction } from "i18next";
import type { Approval, ApprovalCoverView, ApprovalRule, CardDelegate } from "../api/types";
import { serviceKey } from "./activity";
import { aheadPhase, approvalAction, emailTitleWords, sqlReadsTarget } from "./approval-kind";
import { humanize } from "./custom-tools";
import { formatShortDate, formatTime, lowerFirst, relativeDay } from "./format";
import { agentGrammar } from "./grammar";
import { catalogLabel, labelIsName, toolKey } from "./tool-labels";
import { partsOf, toolName } from "./tool-review";

/**
 * An approval in the person's words, the same on the web and the phone: its title, what the agent wants
 * to do ("Ada quer ver stack trace do evento"), whether it only looks, and its values as label and value.
 */

type Tt = (key: string, options?: Record<string, unknown>) => string;

/** The git tool whose grants "Aprovar sempre" keeps by target (`owner/repo:branch`, engine `git/branches.ts`). */
const BRANCH_PUSH = "request_branch_push";

/** The app's own tools whose approval title it says in the person's language (`approval.titles.*`). */
const OWN_TITLES = new Set([
  "run_code",
  "upload_file",
  "run_skill_script",
  "post_message",
  "request_permission",
  "delete_branches",
  BRANCH_PUSH,
  "vault_make_password",
]);

/** GitHub's actions whose server title says what they touch (engine `connectors/catalog.ts`), by their own name. */
const GITHUB_TITLES = new Set([
  "merge_pull_request",
  "pull_request_review_write",
  "actions_run_trigger",
  "delete_repository",
]);

/** What `request_approval` was asked for (mission tools): `approval.titles.request_approval.*`. */
const ASKED_ACTIONS = new Set(["merge", "deploy", "rollback"]);

/**
 * A connection's tools start with its id, or for a server connected by address (`custom:…`) its name in a word:
 * "Slack (Acme): Send" → `slack`, `slack_2`.
 */
function connectionPrefix(approval: Pick<Approval, "title"> & Partial<Pick<Approval, "connector">>) {
  const named = serviceKey(approval.title.split(": ")[0] ?? "").replace(/[^a-z0-9_]/g, "");
  return approval.connector && !approval.connector.startsWith("custom") ? approval.connector : named;
}

/** The tool's own name, without what its connection adds: `slack_2_SLACK_SEND_MESSAGE` → `SEND_MESSAGE`. */
function ownToolName(approval: Pick<Approval, "tool" | "title"> & Partial<Pick<Approval, "connector">>) {
  const prefix = connectionPrefix(approval);
  return prefix ? approval.tool.replace(new RegExp(`^(?:${prefix}(?:_\\d+)?_)+`, "i"), "") : approval.tool;
}

const say = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

/**
 * The approval's title, in the person's language: the app's own tools, email ("Salvar um rascunho de resposta
 * para…"), a connector tool that runs another by name ("Ver stack trace do evento", not "Sentry: Execute sentry
 * tool"), GitHub's sensitive actions and what a mission asks by name, then the action or the tool in words. The server's
 * title stays only for a tool whose name holds no verb: there it is the one name the tool has.
 */
export const approvalTitle = (t: TFunction, approval: TitledApproval): string =>
  wordedTitle(t, approval) ?? approval.title;

type TitledApproval = Pick<Approval, "tool" | "title" | "params" | "email"> &
  Partial<Pick<Approval, "connector" | "scope">>;

function wordedTitle(t: TFunction, approval: TitledApproval): string | null {
  if (approval.email) {
    const words = emailTitleWords(approval.email);
    return (t as unknown as Tt)(words.key, words.values);
  }
  const inner = innerTool(approval);
  if (inner) return toolName(t, partsOf(inner), inner);
  const p = approval.params ?? {};
  if (OWN_TITLES.has(approval.tool))
    return t(`approval.titles.${approval.tool}`, {
      language: say(p.language),
      path: say(p.path),
      skill: say(p.skill),
      channel: say(p.channel).replace(/^#/, ""),
      permission: permissionLabel(t, say(p.permission), approval.title),
      repo: say(p.repo),
      branch: say(p.branch),
      ...(Array.isArray(p.branches) ? { count: p.branches.length } : {}),
      defaultValue: approval.title,
    });
  if (approval.tool === "request_approval") {
    const action = ASKED_ACTIONS.has(say(p.action)) ? say(p.action) : "other";
    return t(`approval.titles.request_approval.${action}`, { target: say(p.target), defaultValue: approval.title });
  }
  const own = ownToolName(approval);
  if (GITHUB_TITLES.has(own) && p.owner && p.repo)
    return t(`approval.titles.github.${own}`, {
      number: say(p.pullNumber),
      method: say(p.method),
      repo: `${say(p.owner)}/${say(p.repo)}`,
      defaultValue: approval.title,
    });
  // A database's question: the server's title is the connection's name after "Query".
  if (/^pg_[a-z0-9_]+_query$/.test(approval.tool))
    return t("approval.titles.pg_query", { target: approval.title.replace(/^Query /, "") });
  // Composio's executor: the server's title lists the actions it would run ("Slack: SLACK_SEND_MESSAGE, …").
  const said = approval.title.slice(approval.title.indexOf(": ") + 2);
  if (/^[A-Z0-9_]+(, [A-Z0-9_]+)*$/.test(said))
    return said
      .split(", ")
      .map((slug) => actionName(t, slug))
      .join(", ");
  const parts = partsOf(own);
  // The action is guessed from any word of the name: a read that names one ("list_merge_requests") is still a read.
  const action = approvalAction({ tool: approval.tool, scope: approval.scope ?? "" });
  if (action !== "other" && !(parts.verb && READ_VERBS.has(parts.verb))) return t(`approval.titles.action.${action}`);
  // A custom server's tool someone named on its review keeps that name (the server's title says it after the colon).
  const named = approval.title.includes(": ") ? said : "";
  if (approval.connector?.startsWith("custom") && named && !labelIsName(named, own)) return null;
  // A common tool by the catalog's words, a verb in its name or not ("Gerar imagem", not "Higgsfield: Generate image").
  return catalogLabel(t, own) ?? (parts.verb ? toolName(t, parts, own) : null);
}

/**
 * A request card's kind line: what's waiting on this person says so, anyone else reads it in words with no "you"
 * (`ask.kindOther`, where the kind's own words have one).
 */
export const askKindWords = (t: TFunction, kind: string, mine: boolean) =>
  (t as unknown as (keys: string[]) => string)(
    mine ? [`ask.kind.${kind}`] : [`ask.kindOther.${kind}`, `ask.kind.${kind}`],
  );

/** What a card with no why of its own leads with, as the agent asking: of this person only when it waits on them. */
export const approvalAskLine = (t: TFunction, mine: boolean, count?: number) =>
  count === undefined
    ? t(mine ? "approval.askPlain" : "approval.askPlainOther")
    : t(mine ? "approval.askMany" : "approval.askManyOther", { count });

/** What `request_permission` asks to turn on: a built-in scope in the person's language, a connector by its name. */
function permissionLabel(t: TFunction, permission: string, title: string) {
  const fromServer = title.replace(/^Turn on: /, "");
  if (!permission || permission.startsWith("connector:")) return fromServer;
  return (t as unknown as Tt)(`scopes.${permission.replace(/[^a-zA-Z0-9]/g, "_")}.label`, { defaultValue: fromServer });
}

/** Verbs that only look (the backend classifies connector tools by the same words). */
const READ_VERBS = new Set([
  "get",
  "list",
  "search",
  "read",
  "describe",
  "query",
  "check",
  "estimate",
  "fetch",
  "find",
  "view",
  "show",
  "count",
  "preview",
  "lookup",
]);

/** A connector tool that runs another one by name (`{ name, arguments }`): that tool's name, when it reads as one. */
function innerTool(approval: Pick<Approval, "params"> & Partial<Pick<Approval, "connector">>): string | null {
  const name = approval.params?.name;
  if (!approval.connector || typeof name !== "string" || !/^[a-z][a-z0-9_]*$/i.test(name)) return null;
  return partsOf(name).verb ? name : null;
}

/**
 * What it will do, said after "Ada quer …": the title's own words (`approvalTitle`) with a lower-case start, never the
 * server's English: a tool with no verb in its name goes by that name.
 */
export function approvalDoing(
  t: TFunction,
  approval: Pick<Approval, "tool" | "title" | "params" | "connector" | "scope" | "email">,
  locale: string,
) {
  // "Ver …" → "ver …"; an acronym ("PR #42") stays.
  return lowerFirst(wordedTitle(t, approval) ?? toolName(t, partsOf(approval.tool), approval.tool), locale);
}

/** It only looks: asked under a read scope, or its tool's name starts with a reading verb. */
export function approvalReadsOnly(approval: Pick<Approval, "tool" | "scope" | "params" | "connector">) {
  if (approval.scope.endsWith(":read")) return true;
  const verb = partsOf(innerTool(approval) ?? approval.tool).verb;
  return verb !== null && READ_VERBS.has(verb);
}

/**
 * Its values in words, label and value ("Issue id", "ACME-177"), one level into objects, without the inner
 * tool's name. Lists keep them short (`long: false`, at most `max`); the details show every one.
 */
export function approvalValues(
  approval: Pick<Approval, "params" | "connector" | "email">,
  {
    max = Number.POSITIVE_INFINITY,
    long = false,
    locale,
  }: {
    max?: number;
    long?: boolean;
    /** Numbers in the locale's format ("97.000"); grouped from five digits, so a year or an id stays as is. */
    locale?: string;
  } = {},
): [string, string][] {
  // Grouped from five digits by hand: Hermes reads `useGrouping` as a boolean, so "min2" would group a year.
  const formatNumber = locale
    ? (v: number) =>
        new Intl.NumberFormat(locale, { maximumFractionDigits: 4, useGrouping: Math.abs(v) >= 10000 }).format(v)
    : null;
  // An email is said by its sentence and its letter; its fields aren't values.
  if (approval.email) return [];
  const skip = innerTool(approval) ? "name" : null;
  const out: [string, string][] = [];
  const plain = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  const walk = (obj: Record<string, unknown>, top: boolean) => {
    for (const [k, v] of Object.entries(obj)) {
      if (top && k === skip) continue;
      if (plain(v)) {
        const text = typeof v === "number" && formatNumber ? formatNumber(v) : String(v).trim();
        if (text && (long || text.length <= 60)) out.push([humanize(k), text]);
      } else if (Array.isArray(v) && v.length > 0 && v.every(plain)) {
        // A list of names (the branches to delete) is one value; on a card it is cut, never left out.
        const text = v.map(String).join(", ");
        out.push([humanize(k), long || text.length <= 60 ? text : `${text.slice(0, 59)}…`]);
      } else if (top && v && typeof v === "object" && !Array.isArray(v)) walk(v as Record<string, unknown>, false);
    }
  };
  walk(approval.params ?? {}, true);
  return out.slice(0, max);
}

/**
 * Its values on one line ("Role: seller · Month: 2026-10 · Revenue: 97.000"): what tells apart two requests
 * for the same tool, on the card while it waits and on the line once decided. The raw call stays in the details.
 */
export const approvalSummary = (approval: Pick<Approval, "params" | "connector" | "email">, locale: string, max = 4) =>
  approvalValues(approval, { max, locale })
    .map(([label, value]) => `${label}: ${value}`)
    .join(" · ");

/**
 * A request's line under its title: a connector's values in words (`approvalSummary`); any other's own detail, but
 * not the tool's code name it may start with (`github.merge_pull_request · …`, a call kept after its connection
 * went), which the title already says in words: its values in words instead, else the rest of the line.
 */
export function approvalDetail(
  approval: Pick<Approval, "detail" | "tool" | "params" | "connector" | "email">,
  locale: string,
) {
  if (approval.connector) return approvalSummary(approval, locale);
  const [first = "", ...rest] = approval.detail.split(" · ");
  if (rest.length === 0 || toolKey(first).key !== toolKey(approval.tool).key) return approval.detail;
  return approvalSummary(approval, locale) || rest.join(" · ");
}

/** Articles in an action's slug (`GITHUB_CREATE_AN_ISSUE_COMMENT`) that only make its words longer. */
const SLUG_ARTICLES = new Set(["a", "an", "the"]);

/**
 * An action a tool runs for the agent (Composio's slugs), in words: what it does, then its app as it writes its name
 * ("Comentar numa issue (GitHub)"). The slug itself is for a title on hover.
 */
export function actionName(t: TFunction, slug: string) {
  const known = toolKey(slug);
  const [first = "", ...rest] = slug.toLowerCase().split("_");
  const name = known.app ? known.key : rest.filter((w) => !SLUG_ARTICLES.has(w)).join("_");
  return name ? `${toolName(t, partsOf(name, null, true), name)} (${known.app ?? humanize(first)})` : humanize(slug);
}

/** One of a routine's own actions (`Routine.ownActions`) in words: a Composio slug (upper case) by its app, else the tool's name. */
export const ownActionName = (t: TFunction, name: string) =>
  /^[A-Z0-9_]+$/.test(name) ? actionName(t, name) : toolName(t, partsOf(name), name);

/** A remembered push (`owner/repo:branch`) in words: "enviar para ana/fix em acme/app". */
function pushWords(t: TFunction, target: string) {
  const at = target.indexOf(":");
  return t("approval.always.pushTo", { repo: target.slice(0, at), branch: target.slice(at + 1) });
}

/** A command rule's tool (no connection, its action the command's kind); mirrors engine `approval-rules.ts` `COMMAND_RULE_TOOL`. */
export const COMMAND_RULE_TOOL = "command";

/** What "Aprovar sempre" covers on a card, in words: each action the tool runs, else the tool itself. */
export function approveAlwaysWords(t: TFunction, approval: Pick<Approval, "approveAlways">) {
  const kind = approval.approveAlways;
  if (!kind) return "";
  if (kind.routineId) return kind.actions.map((name) => ownActionName(t, name)).join(", ");
  if (kind.tool === COMMAND_RULE_TOOL) return kind.actions.join(", ");
  if (kind.tool === BRANCH_PUSH) return kind.actions.map((target) => pushWords(t, target)).join(", ");
  const tool = toolName(t, partsOf(kind.tool), kind.tool);
  if (sqlReadsTarget(kind.actions[0]) !== null) return tool;
  return kind.actions.length > 0 ? kind.actions.map((slug) => actionName(t, slug)).join(", ") : tool;
}

/**
 * "Aprovar sempre", "Aprovar sempre leituras" where only the SQL reads of one project would be covered, or "Sempre
 * nesta rotina" on a routine's card.
 */
export const approveAlwaysLabel = (t: TFunction, approval: Pick<Approval, "approveAlways">) =>
  t(
    approval.approveAlways?.routineId
      ? "approval.always.routine"
      : sqlReadsTarget(approval.approveAlways?.actions[0]) === null
        ? "approval.always.button"
        : "approval.always.reads",
  );

/** The name of the routine "Sempre nesta rotina" keeps a kind for; null on any other card. */
export function alwaysRoutineName(t: TFunction, approval: Pick<Approval, "approveAlways" | "origin">) {
  if (!approval.approveAlways?.routineId) return null;
  const origin = approval.origin;
  return (origin?.kind === "routine" && origin.routineName) || t("approval.always.thisRoutine");
}

/**
 * The line under "Aprovar sempre", on the card's face: exactly what approving for good covers (with any values, one
 * branch, or only the reads of one project) and where to undo it.
 */
export function approveAlwaysHint(
  t: TFunction,
  approval: Pick<Approval, "approveAlways"> & Partial<Pick<Approval, "origin">>,
  agentName: string,
) {
  const routine = alwaysRoutineName(t, { origin: null, ...approval });
  if (routine) return t("approval.always.noteRoutine", { routine, actions: approveAlwaysWords(t, approval) });
  const target = sqlReadsTarget(approval.approveAlways?.actions[0]);
  const key =
    target !== null
      ? target
        ? "approval.always.noteReads"
        : "approval.always.noteReadsAll"
      : approval.approveAlways?.tool === BRANCH_PUSH
        ? "approval.always.noteTarget"
        : approval.approveAlways?.tool === COMMAND_RULE_TOOL
          ? "approval.always.noteCommand"
          : "approval.always.note";
  return t(key, { ...agentGrammar(agentName), actions: approveAlwaysWords(t, approval), target: target ?? "" });
}

/** Where a rule applies, for its list: the connection's name, or the agent's computer for a command. */
export const approvalRuleServer = (t: TFunction, rule: Pick<ApprovalRule, "server">) =>
  rule.server ?? t("approval.always.computer");

/** A rule the agent runs without asking, in words: a push by its branch, its action, else the tool as labelled. */
export function approvalRuleWords(
  t: TFunction,
  rule: Pick<ApprovalRule, "tool" | "action" | "toolLabel"> & { connectionId?: string | null },
) {
  const target = sqlReadsTarget(rule.action);
  if (target !== null) {
    const words = t("approval.always.readsRule", { tool: rule.toolLabel });
    return target ? `${words} · ${target}` : words;
  }
  if (rule.tool === BRANCH_PUSH && rule.action) return pushWords(t, rule.action);
  if (rule.tool === COMMAND_RULE_TOOL && !rule.connectionId) return rule.action;
  if (rule.action) return actionName(t, rule.action);
  return labelIsName(rule.toolLabel, rule.tool) ? toolName(t, partsOf(rule.tool), rule.tool) : rule.toolLabel;
}

/** How an action prepared ahead ended without running, in a line (its card, Aprovações, the phone's sheet). */
export function aheadEndLine(t: TFunction, a: Pick<Approval, "runAt" | "status" | "executedAt" | "decidedAt">) {
  const phase = aheadPhase(a);
  return phase === "lapsed" || phase === "unapproved" || phase === "canceled" ? t(`approval.ahead.${phase}`) : null;
}

/**
 * How a decided approval ended, as the line that takes its card's place says it, the same on the web and the
 * phone: "Aprovado por você", "Recusado por Ana", "Expirou", "Cancelado".
 */
export function decisionOutcome(
  t: TFunction,
  a: Pick<Approval, "status" | "decidedByUserId" | "decidedForUserId">,
  meId: string | null,
  nameOf: (userId: string) => string | undefined,
): string {
  if (a.status === "expired" || a.status === "canceled") return t(`approvals.status.${a.status}`);
  const approved = a.status === "approved";
  const by = a.decidedByUserId;
  // Someone covering decided it (ADR 0139): "Aprovado por Bruno, cobrindo Ana".
  const covered = a.decidedForUserId;
  if (by && covered) {
    const verb = approved ? "Approved" : "Refused";
    if (by === meId) return t(`approval.outcome${verb}ByYouCovering`, { for: nameOf(covered) ?? "" });
    if (covered === meId) return t(`approval.outcome${verb}CoveringYou`, { name: nameOf(by) ?? "" });
    return t(`approval.outcome${verb}Covering`, { name: nameOf(by) ?? "", for: nameOf(covered) ?? "" });
  }
  if (by && by === meId) return t(approved ? "approval.outcomeApprovedByYou" : "approval.outcomeRefusedByYou");
  const name = by ? nameOf(by) : undefined;
  if (name) return t(approved ? "approval.outcomeApprovedBy" : "approval.outcomeRefusedBy", { name });
  return t(approved ? "approvals.status.approved" : "approvals.status.refused");
}

/** Who an approval waits for, by name: the people `request_approval` asked (ADR 0126), else the agent's owner. */
export const approvalWaitsFor = (approval: Pick<Approval, "approvers">, ownerName: string | undefined) =>
  approval.approvers?.label || ownerName;

/**
 * Who a shared card's requests wait for: one `request_approval` and an ordinary approval of the same agent can share
 * a card while different people decide them, so every distinct name of the waiting requests (all of them once none
 * waits).
 */
export function approvalGroupWaitsFor(items: Pick<Approval, "approvers" | "status">[], ownerName: string | undefined) {
  const waiting = items.filter((a) => a.status === "pending");
  const names = new Set((waiting.length > 0 ? waiting : items).map((a) => approvalWaitsFor(a, ownerName)));
  return [...names].filter(Boolean).join(", ") || undefined;
}

/**
 * The keys that let someone decide any approval of its kind, as the server's `decidingKeys` (engine `approvals.ts`):
 * `approve_actions`; turning on access for good (`request_permission`), the keys that give it on the agent's page.
 */
export function approvalDecidingKeys(a: Pick<Approval, "tool" | "params">): string[] {
  if (a.tool !== "request_permission") return ["approve_actions"];
  const permission = a.params?.permission;
  return typeof permission === "string" && permission.startsWith("browser-profile:")
    ? ["manage_agents", "manage_connectors"]
    : ["manage_agents"];
}

/**
 * The line saying the person whose request it is decides it too, as an approver by role (ADR 0126): while it waits
 * and once they decided it. Null for any other approval.
 */
export function requesterDecidesLine(t: TFunction, a: Pick<Approval, "approvers" | "status" | "decidedByUserId">) {
  const asked = a.approvers;
  if (!asked?.requesterDecides || !asked.requestedByUserId) return null;
  if (a.status !== "pending" && a.decidedByUserId !== asked.requestedByUserId) return null;
  return t("approval.requesterDecides");
}

/** Whom I cover, in a line (ADR 0139): "Quando a pessoa estiver fora · até 10 de nov. · Cobrindo agora". */
export function coveringLine(t: TFunction, locale: string, c: Pick<ApprovalCoverView, "mode" | "endsAt" | "active">) {
  return [
    t(c.mode === "always" ? "approvalCover.always" : "approvalCover.coveringWhileOut"),
    c.endsAt ? t("approvalCover.coveringUntil", { date: formatShortDate(locale, c.endsAt) }) : null,
    c.active ? t("approvalCover.coveringNow") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * What the right hand did with a card (ADR 0139 §2), in a line: "Aprovado pelo Gerente em nome de Ana", "O Gerente
 * passou para você: …". What is only about the person it decided for (passed, out of reach, its own, a cap) is said
 * to them alone: null for anyone else.
 */
export function delegateLine(
  t: TFunction,
  d: CardDelegate,
  meId: string | null,
  nameOf: (userId: string) => string | undefined,
  rightHandName: string,
): string | null {
  const mine = d.forUserId === meId;
  const name = rightHandName;
  const forName = nameOf(d.forUserId) ?? "";
  switch (d.state) {
    case "deciding":
      return mine
        ? t("rightHandApprovals.card.decidingForYou", { name })
        : t("rightHandApprovals.card.deciding", { name, for: forName });
    case "approved":
      return mine
        ? t("rightHandApprovals.card.approvedForYou", { name })
        : t("rightHandApprovals.card.approved", { name, for: forName });
    case "undone":
      return d.undoneByUserId === meId
        ? t("rightHandApprovals.card.undoneByYou")
        : t("rightHandApprovals.card.undoneBy", { name: nameOf(d.undoneByUserId ?? "") ?? "" });
    default:
      if (!mine) return null;
      if (d.state === "passed")
        return d.reason
          ? t("rightHandApprovals.card.passedWhy", { name, reason: d.reason })
          : t("rightHandApprovals.card.passed", { name });
      return t(`rightHandApprovals.card.${d.state}`, { name });
  }
}

/** "Desfazer arquiva a Triagem. Vale até 09:42.": what Desfazer does, and until when. */
export function delegateUndoLine(t: TFunction, locale: string, d: CardDelegate, agentName: string | null) {
  const end = d.undoUntil ? new Date(d.undoUntil) : null;
  // It lasts a day: tomorrow's word ("amanhã", "tomorrow") before the hour when it ends then.
  const tomorrow = end && end.toDateString() !== new Date().toDateString() ? `${relativeDay(locale, 1)}, ` : "";
  const until = end ? `${tomorrow}${formatTime(locale, end.toISOString())}` : "";
  return agentName
    ? t("rightHandApprovals.card.undoArchives", { name: agentName, until })
    : t("rightHandApprovals.card.undoSettings", { until });
}
