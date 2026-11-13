import type { TFunction } from "i18next";
import {
  AGENT_ACTION_KINDS,
  type AgentAction,
  type AgentActionKind,
  type ApiRule,
  WORKSPACE_ACTION_IDS,
} from "../api/types";
import { ownActionName } from "./approval-words";
import { joinNames } from "./format";

/** A receipt's `params.rule` when it is a rule (`freq`, `timezone`); anything else is none. */
function ruleOf(value: unknown): ApiRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Partial<ApiRule>;
  return typeof r.freq === "string" && typeof r.timezone === "string" ? (r as ApiRule) : null;
}

/** "4:58" for a countdown. */
export function formatTimeLeft(ms: number) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The webhook routine whose address a receipt offers to copy ("Copiar endereço do webhook"): one the agent created or
 * changed into (or within) a webhook routine, for the person it worked for or whoever manages routines (the server
 * checks it again). Null for any other receipt.
 */
export function hookToCopy(
  a: Pick<AgentAction, "kind" | "params" | "target" | "requestedByUserId" | "undoneAt">,
  viewer: { userId: string | null; managesRoutines: boolean },
): string | null {
  const made = a.kind === "routine.created" || a.kind === "routine.updated";
  if (!made || a.params.trigger !== "webhook" || a.target.type !== "routine" || a.undoneAt) return null;
  return a.requestedByUserId === viewer.userId || viewer.managesRoutines ? a.target.id : null;
}

const KNOWN_KINDS = new Set<string>(AGENT_ACTION_KINDS);
const KNOWN_ACTIONS = new Set<string>(WORKSPACE_ACTION_IDS);

/**
 * The i18n key of a receipt's sentence: `agentActions.issue.created`… (params: `action.params`). A kind this build
 * doesn't know (an open tab, an older app) says `agentActions.other`, never its raw key.
 */
export const actionTextKey = (a: Pick<AgentAction, "kind">) =>
  KNOWN_KINDS.has(a.kind) ? `agentActions.${a.kind}` : "agentActions.other";

/** The i18n key of an action error code (`action.changed_since` → `agentActions.errors.changed_since`). */
export const actionErrorKey = (code: string) => `agentActions.errors.${code.replace(/^action\./, "")}`;

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** A created routine's actions in connected apps it does without asking (its receipt's `ownActions`). */
export const routineOwnActions = (a: Pick<AgentAction, "kind" | "params">): string[] =>
  a.kind === "routine.created" && Array.isArray(a.params.ownActions)
    ? a.params.ownActions.filter((v): v is string => typeof v === "string")
    : [];

/** The files an agent's task change brought (its receipt's `files`: their names), for the line under its sentence. */
export const receiptFiles = (a: Pick<AgentAction, "kind" | "params">): string[] =>
  a.kind.startsWith("issue.") && Array.isArray(a.params.files)
    ? a.params.files.filter((v): v is string => typeof v === "string")
    : [];

/**
 * The values (and i18next `context`) for `t(actionTextKey(a), …)`: issue
 * number and title, the changed fields in words, the assignee ("você" when it
 * is the viewer), the routine's name… The sentence marks the target with
 * `<b>…</b>` (render it as the link to the issue, page, routine…).
 */
export function actionTextValues(
  a: Pick<AgentAction, "kind" | "target" | "params">,
  t: TFunction,
  viewerUserId?: string,
  /** Says a routine's rule in the person's language (the web's sentence); without it, no schedule. */
  options: { schedule?: (rule: ApiRule) => string } = {},
): Record<string, string> {
  const p = a.params;
  const fields = Array.isArray(p.fields) ? p.fields : [];
  const fieldWords = (group: "issueFields" | "routineFields") =>
    fields.length
      ? joinNames(
          fields.map((f) => t(`agentActions.${group}.${f}`, { defaultValue: f })),
          t,
        )
      : t("agentActions.someFields");
  const title = str(p.title) || a.target.title || "";
  switch (a.kind) {
    case "issue.created":
    case "issue.updated":
    case "issue.assigned": {
      // No title: a limited task, named where not everyone sees it (ADR 0151).
      const v: Record<string, string> = {
        number: str(p.number) || str(a.target.number),
        title: title || t("whoSees.limited"),
      };
      if (a.kind === "issue.updated") {
        v.fields = fieldWords("issueFields");
        if (fields.length === 1 && fields[0] === "status" && p.status) {
          v.context = "status";
          v.status = t(`issues.statusLower.${str(p.status)}`, { defaultValue: str(p.status) });
        } else if (fields.length === 1 && fields[0] === "priority" && p.priority) {
          v.context = "priority";
          v.priority = t(`issues.priorityLower.${str(p.priority)}`, { defaultValue: str(p.priority) });
        }
      }
      const assigned = a.kind === "issue.assigned" || fields.includes("assignee");
      if (assigned) {
        // The server writes "person" for a member, "agent" for an agent.
        const isViewer = viewerUserId && p.assigneeType === "person" && p.assigneeId === viewerUserId;
        // To the agent itself, to the reader (each language's own "to you": "Te asigné"), or to nobody any more.
        if (a.kind === "issue.assigned") {
          if (p.assigneeIsSelf === true) v.context = "self";
          else if (isViewer) v.context = "you";
          else if (!p.assigneeId) v.context = "none";
        }
        v.assignee = isViewer ? t("agentActions.you") : str(p.assigneeName) || t("agentActions.someone");
      }
      return v;
    }
    case "memory.saved":
      return p.rule === true ? { text: str(p.text), context: "rule" } : { text: str(p.text) };
    case "memory.updated":
    case "memory.forgotten":
      return { text: str(p.text) };
    case "routine.created": {
      // When it runs, from its rule in the person's language; the server's `schedule` is English, never shown.
      const rule = ruleOf(p.rule);
      const schedule = rule && options.schedule ? options.schedule(rule) : "";
      return schedule ? { name: str(p.name) || title, schedule } : { name: str(p.name) || title, context: "bare" };
    }
    case "routine.updated": {
      const v: Record<string, string> = { name: str(p.name) || title, fields: fieldWords("routineFields") };
      if (fields.length === 1 && fields[0] === "active") v.context = p.active ? "resumed" : "paused";
      return v;
    }
    case "channel.agent_added":
      return { agentName: str(p.agentName), channel: str(p.channel) || a.target.title || "" };
    case "channel.created":
      return { name: str(p.name) || a.target.title || "" };
    case "wiki.page_created":
    case "wiki.page_edited":
      return p.restricted ? { context: "restricted" } : { title };
    case "thread.renamed":
      return { from: str(p.from), to: str(p.to) || title };
    case "routine.deleted":
      return { name: str(p.name) || title };
    case "thread.closed":
      return { title };
    case "skill.created":
    case "skill.updated":
      return { name: str(p.name) || title };
    case "agent.settings_changed": {
      const [only] = fields;
      const applied = fields.length === 1 && (only === "instructions" || only === "role" || only === "apps");
      return { agentName: str(p.agentName) || title, ...(applied ? { context: only } : {}) };
    }
    case "pr.merged":
      return p.number
        ? { repo: str(p.repo), number: str(p.number) }
        : { repo: str(p.repo), ref: str(p.ref), context: "branch" };
    case "workspace.changed": {
      // Its words as the server wrote them, and the catalog action as the sentence's context (`changed_create_role`).
      const words = Object.fromEntries(
        Object.entries(p).flatMap(([k, v]) => (k !== "action" && typeof v === "string" ? [[k, v]] : [])),
      );
      const action = str(p.action);
      return {
        ...workspaceActionWords(action, words, t),
        context: KNOWN_ACTIONS.has(action) ? workspaceActionContext(action, words) : "",
      };
    }
    default:
      // A kind the server knows and this build doesn't yet (an open tab, an older app): the key's own words.
      return {};
  }
}

/** A catalog action's sentence with its variant when it has one (`archive_channel_back`, `set_action_check_on`). */
export const workspaceActionContext = (action: string, words: Record<string, string>) =>
  words.variant ? `${action}_${words.variant}` : action;

/**
 * A catalog action's words in the reader's language: what the server can't say (a bare availability, a kind of
 * notification) said here, so "Mudei seu status: ausente" never reads "away".
 */
export function workspaceActionWords(action: string, words: Record<string, string>, t: TFunction) {
  if (action === "set_my_status" && !words.what && words.availability) {
    const key = words.availability === "auto" ? "online" : words.availability;
    return { ...words, what: t(`presence.lower.${key}` as never, { defaultValue: words.availability }) as string };
  }
  if (action === "set_notifications" && words.category)
    return {
      ...words,
      category: t(`noticePrefs.category.${words.category}.title` as never, { defaultValue: words.category }) as string,
    };
  return words;
}

/** A translated sentence's `<b>…</b>` marks as runs, for a surface that draws them itself (React Native has no HTML). */
export function boldRuns(text: string): { text: string; bold: boolean }[] {
  const out: { text: string; bold: boolean }[] = [];
  const re = /<b>([\s\S]*?)<\/b>/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false });
    if (m[1]) out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out;
}

type Values = Record<string, string>;
const hashed = (key: string) => (v: Values) => (v[key] ? `#${v[key]}` : "");
const named = (key: string) => (v: Values) => v[key] ?? "";

interface Blend {
  /** Each change's reference in the row ("#58", a routine's name). */
  ref: (v: Values) => string;
  /** What the changes of one row share besides the kind (one assignee, one agent, one repository, the same fields). */
  same?: (a: AgentAction, v: Values) => unknown;
  /** Contexts with a sentence of their own when several are said together (`_self`, `_rule`). */
  contexts?: string[];
  /** Said in words rather than named (a memory): the kind's own sentence, with all of them in this value. */
  slot?: string;
}

/**
 * The kinds whose changes blend into one row (`receiptRows`). The row says `agentActions.several.<kind>`, or the kind's
 * own sentence for a `slot`.
 * ponytail: a workspace change, a renamed conversation, a branch merge and a restricted page stay one row each, their
 * sentences saying more than a name. Give them `several` sentences once agents make many of them in one reply.
 */
const BLENDS: Partial<Record<AgentActionKind, Blend>> = {
  "issue.created": { ref: hashed("number") },
  "issue.updated": { ref: hashed("number"), same: (a) => a.params.fields },
  "issue.assigned": {
    ref: hashed("number"),
    same: (a) => [a.params.assigneeType ?? null, a.params.assigneeId ?? null],
    contexts: ["self", "you", "none"],
  },
  "memory.saved": { ref: named("text"), contexts: ["rule"], slot: "text" },
  "memory.updated": { ref: named("text"), slot: "text" },
  "memory.forgotten": { ref: named("text"), slot: "text" },
  "routine.created": { ref: named("name") },
  "routine.updated": { ref: named("name"), same: (a) => a.params.fields },
  "routine.deleted": { ref: named("name") },
  "channel.agent_added": { ref: hashed("channel"), same: (a, v) => a.params.agentId ?? v.agentName },
  "channel.created": { ref: hashed("name") },
  "wiki.page_created": { ref: named("title") },
  "wiki.page_edited": { ref: named("title") },
  "thread.closed": { ref: named("title") },
  "skill.created": { ref: named("name") },
  "skill.updated": { ref: named("name") },
  "agent.settings_changed": { ref: named("agentName") },
  "pr.merged": { ref: hashed("number"), same: (_a, v) => v.repo },
};

/**
 * A sentence that says what changed (a status, a priority, paused or resumed, an agent's instructions, role or apps): a
 * row of several would drop it, so each such change keeps its row.
 */
const SAYS_WHAT = new Set(["status", "priority", "paused", "resumed", "instructions", "role", "apps"]);
/** Fields whose words are one routine's ("o que pode fazer sozinha", "quando posta"): never said of several. */
const OWN_FIELDS = new Set(["access", "report"]);

/** One key for the changes a row may say together; null for a change that keeps a row of its own. */
function blendKey(a: AgentAction, v: Values): string | null {
  const how = BLENDS[a.kind];
  // A webhook routine's row copies its own address.
  const own = a.kind.startsWith("routine.") && a.params.trigger === "webhook";
  const fields = Array.isArray(a.params.fields) ? a.params.fields : [];
  if (!how?.ref(v) || own || SAYS_WHAT.has(v.context ?? "") || fields.some((f) => OWN_FIELDS.has(String(f))))
    return null;
  const context = v.context && how.contexts?.includes(v.context) ? v.context : "";
  // Undone by one person, or doing the same on its own: the line under the row stays true for all of it.
  const undone = a.undoneAt ? (a.undoneByUserId ?? "") : null;
  return JSON.stringify([a.kind, context, how.same?.(a, v) ?? null, undone, routineOwnActions(a)]);
}

/** A row of an agent's receipts: one change, or several of one kind said once. */
export interface ReceiptRow {
  /** Its changes, in order. */
  actions: AgentAction[];
  /** Several: the different things they name, each with a change that opens it ("#58" opens that task). */
  refs: { text: string; action: AgentAction }[] | null;
}

/**
 * The receipts in rows: two or more changes of one kind about different things are one row, where the first of them
 * was ("Criei as tarefas #58, #59 e #60"); any other change is a row of its own, and so is each change of a thing
 * changed twice with nothing else beside it. A thing is its target (a routine renamed in between is still one), but a
 * merged pull request is its number: every merge in a repository has the repository as its target.
 */
export function receiptRows(list: readonly AgentAction[], t: TFunction, viewerUserId?: string): ReceiptRow[] {
  const groups = new Map<string, { a: AgentAction; ref: string }[]>();
  const order: (string | AgentAction)[] = [];
  for (const a of list) {
    const v = actionTextValues(a, t, viewerUserId);
    const key = blendKey(a, v);
    if (key === null) {
      order.push(a);
      continue;
    }
    const item = { a, ref: BLENDS[a.kind]?.ref(v) ?? "" };
    const group = groups.get(key);
    if (group) group.push(item);
    else {
      groups.set(key, [item]);
      order.push(key);
    }
  }
  return order.flatMap((entry): ReceiptRow[] => {
    if (typeof entry !== "string") return [{ actions: [entry], refs: null }];
    const group = groups.get(entry) ?? [];
    const things = new Map(
      group.map(({ a, ref }) => [a.kind === "pr.merged" ? ref : a.target.id || ref, { text: ref, action: a }]),
    );
    const refs = [...things.values()];
    const actions = group.map(({ a }) => a);
    return refs.length < 2 ? actions.map((a) => ({ actions: [a], refs: null })) : [{ actions, refs }];
  });
}

/** The files a row's changes brought, each once, for the line under it ("Anexei print.png e log.txt"). */
export const rowFiles = (row: ReceiptRow): string[] => [
  ...new Set(row.actions.flatMap((a) => (a.undoneAt ? [] : receiptFiles(a)))),
];

/** A part of a row's sentence: bold where it names a thing, with the change whose target it opens. */
export interface ReceiptPiece {
  text: string;
  bold: boolean;
  opens?: AgentAction;
}

/**
 * A reference's place in a sentence, so the list's own words go between them ("#58, #59 e #60"): private-use
 * characters, which no translation and no name holds.
 */
const SLOT_OPEN = "\uE000";
const SLOT_CLOSE = "\uE001";
const slot = (i: number) => `${SLOT_OPEN}${i}${SLOT_CLOSE}`;
const SLOTS = new RegExp(`${SLOT_OPEN}(\\d+)${SLOT_CLOSE}`);

/**
 * `t` with a key built at run time (a kind), which the app's typed keys can't name. Its `context` picks the context's
 * own sentence (`issue.assigned_self`), falling back to the kind's where a language has none.
 */
const say = (t: TFunction, key: string, values: Record<string, string>, context?: string) =>
  (t as unknown as (key: string, values: Record<string, string>) => string)(
    key,
    context ? { ...values, context } : values,
  );

/**
 * A row's sentence in parts: a change on its own says its sentence with its target in bold ("Criei a tarefa **#58** ·
 * …"), several say one with each reference in bold, opening that one ("Criei as tarefas **#58**, **#59** e **#60**"),
 * or their kind's own sentence with all their words in it ("Guardei na **memória**: a regra e o prazo").
 */
export function receiptPieces(
  row: ReceiptRow,
  t: TFunction,
  viewerUserId?: string,
  options: { schedule?: (rule: ApiRule) => string } = {},
): ReceiptPiece[] {
  const [first] = row.actions;
  if (!first) return [];
  const { context, ...values } = actionTextValues(first, t, viewerUserId, options);
  const refs = row.refs;
  const how = BLENDS[first.kind];
  if (!refs || how?.slot) {
    // What a memory keeps is words: all of them in the kind's own sentence, each opening its own memory.
    const all =
      refs && how?.slot
        ? {
            [how.slot]: joinNames(
              refs.map((_, i) => slot(i)),
              t,
            ),
          }
        : {};
    return parts(say(t, actionTextKey(first), { ...values, ...all }, context), refs, first, false);
  }
  const own = context && how?.contexts?.includes(context) ? context : undefined;
  const refsText = joinNames(
    refs.map((_, i) => slot(i)),
    t,
  );
  return parts(say(t, `agentActions.several.${first.kind}`, { ...values, refs: refsText }, own), refs, null, true);
}

/**
 * A sentence's parts: its `<b>` marks open `marked` (a change on its own: its target), each reference's place its own
 * change, in bold when it names the thing (`named`: "#58", a routine's name) and plain when it is its words (a memory).
 */
function parts(text: string, refs: ReceiptRow["refs"], marked: AgentAction | null, named: boolean): ReceiptPiece[] {
  return text.split(SLOTS).flatMap((part, i): ReceiptPiece[] => {
    if (i % 2 === 0) return boldRuns(part).map((r) => (r.bold && marked ? { ...r, opens: marked } : r));
    const ref = refs?.[Number(part)];
    return ref ? [{ text: ref.text, bold: named, opens: ref.action }] : [];
  });
}

/**
 * The lines under a row, each one line there and whole in its list: the files its changes brought, what a created
 * routine does on its own, and who undid it (`undoneBy`: the name as the screen knows the person).
 */
export function receiptUnder(
  row: ReceiptRow,
  t: TFunction,
  undoneBy: string | null,
): { files: string | null; own: string | null; undone: string | null } {
  const [first] = row.actions;
  const files = rowFiles(row);
  const own = first ? routineOwnActions(first) : [];
  return {
    files: files.length ? t("agentActions.issue.files", { names: joinNames(files, t) }) : null,
    own: own.length
      ? t("agentActions.routine.ownActions", {
          actions: joinNames(
            own.map((name) => ownActionName(t, name)),
            t,
          ),
        })
      : null,
    undone: first?.undoneAt && undoneBy ? t("agentActions.undoneBy", { name: undoneBy }) : null,
  };
}

/** Each change of a row on its own: its sentence as a row of its own says it, and the files that went with it. */
export function receiptLines(
  row: ReceiptRow,
  t: TFunction,
  viewerUserId?: string,
  options: { schedule?: (rule: ApiRule) => string } = {},
): { action: AgentAction; text: string; files: string | null }[] {
  return row.actions.map((a) => {
    const text = receiptPieces({ actions: [a], refs: null }, t, viewerUserId, options)
      .map((p) => p.text)
      .join("");
    const files = rowFiles({ actions: [a], refs: null });
    return {
      action: a,
      text,
      files: files.length ? t("agentActions.issue.files", { names: joinNames(files, t) }) : null,
    };
  });
}

/** A row's whole words, for its tip: each change and its files, one a line. */
export const receiptTip = (...args: Parameters<typeof receiptLines>): string =>
  receiptLines(...args)
    .flatMap((l) => (l.files ? [l.text, l.files] : [l.text]))
    .join("\n");
