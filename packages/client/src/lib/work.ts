import type { TFunction } from "i18next";
import type { ConnectorDef, OrgSummary, Run, RunStep } from "../api/types";
import type { LiveCode, LiveOutput, LiveRun, LiveStep, LiveWork } from "../realtime/streams";
import { type Activity, type ActivityKind, activityVerb, appLabel, PERMISSION_TOOL, toolActivity } from "./activity";
import { appConnector } from "./connected";
import { POSTGRES_MARK } from "./databases";
import { capitalize, joinNames, lowerFirst, shortTarget } from "./format";
import { workDuration } from "./long-work";
import { MAIL_BRANDS } from "./mail";
import { catalogLabel, toolKey } from "./tool-labels";

/**
 * Whether a finished reply shows what the agent did ("Usou 4 ferramentas"): only for a person who turned it on in this
 * workspace; off by default, and off with a server that doesn't send it. The live step line shows either way.
 */
export const showsActivity = (org: Pick<OrgSummary, "showActivity"> | null | undefined) => org?.showActivity === true;

/** Fallback when a tool has no label: "github_merge_pull_request" → "github merge pull request". */
export const toolLabel = (name: string) => name.replace(/[_-]+/g, " ").trim();

/** A tool in "Usou a ferramenta …": the catalog's words, else its own name in words, without the app it starts with. */
function toolWords(t: TFunction, tool: string) {
  const worded = catalogLabel(t, tool);
  return worded ? lowerFirst(worded) : toolLabel(toolKey(tool).key || tool);
}

/** One thing the agent did (a tool call), for the work summary: what it did, in which service. */
export interface WorkItem extends Activity {
  key: string;
  tool: string;
  ms: number | null;
  failed: boolean;
  /** How many calls in a row this line stands for (five "Usou o navegador" are one line). */
  count: number;
  /** The code it ran (`run_code`, skill scripts: `input.code`/`input.command`) and what came out. */
  code?: LiveCode;
  output?: LiveOutput[];
  /** Grey words after its phrase (`toolHint`): the built-in's label or the connector tool's own name. */
  hint?: string | null;
  /** Why it failed: the first line of the tool's error, in its own words (its open view shows it). */
  why?: string | null;
  /** It failed because its arguments were refused: the tool never ran. */
  slip?: boolean;
  /** A refused command or a call the Tool Gateway refused: the refusal's code, which `toolWhy` says in words. */
  refusal?: string | null;
  /** No result: it never ran (it waited on a person, or the run stopped first). */
  held?: boolean;
  /** What it was given and what it answered, for its open line (shortened). */
  input?: string | null;
  result?: string | null;
  /** It ran without asking under "Aprovar sempre" (`tool_result` step `autoApproved`). */
  autoApproved?: AutoApproved | null;
}

/** A call a rule approved: the rule's person (null: unknown) and whether it was an "Aprovar sempre leituras" one. */
export interface AutoApproved {
  by: string | null;
  reads: boolean;
}

function autoApprovedOf(value: unknown): AutoApproved | null {
  const v = value as Partial<AutoApproved> | null | undefined;
  if (!v || typeof v !== "object") return null;
  return { by: typeof v.by === "string" ? v.by : null, reads: v.reads === true };
}

/** The quiet words after a call a rule approved: "Aprovado automaticamente (leitura sempre aprovada por Ana)". */
export function autoApprovedWords(t: TFunction, a: AutoApproved): string {
  if (!a.by) return t("chat.work.autoApprovedNobody");
  return t(a.reads ? "chat.work.autoApprovedReads" : "chat.work.autoApproved", { name: a.by });
}

/**
 * A line's grey words: none beside code, who approved it for good where a rule did, else its hint, a connector
 * tool's name by the catalog's words where it has them ("Buscar issues", not "search issues").
 */
export const toolLineHint = (t: TFunction, l: Pick<ToolLine, "code" | "hint" | "autoApproved" | "kind">) =>
  l.code
    ? null
    : l.autoApproved
      ? autoApprovedWords(t, l.autoApproved)
      : l.kind === "consulting" && l.hint
        ? (catalogLabel(t, l.hint) ?? l.hint)
        : l.hint;

/** What the agent said before a model call's tools (`model_call` step: `narration`, `turn`). */
export interface WorkNarration {
  key: string;
  turn: number;
  text: string;
  /** How many tool calls came before it (where it goes among the steps). */
  at: number;
}

export interface Work {
  steps: WorkItem[];
  /** The narration between tool calls, in order. */
  narration: WorkNarration[];
  /** Apps it used ("himetrica", "Drive"), in order of first use. */
  connectors: string[];
  durationMs: number | null;
}

/** A call of one app in a reply's `meta.work`: its name, app and service (as the `tool_call` step says them). */
export interface WorkCall {
  name: string;
  connector?: string;
  service?: string;
  serviceIcon?: string;
  /** How many calls it stands for (absent on replies saved before it was written). */
  n?: number;
  /** The one call beside the screens' (their cards show those steps): its time and whether it failed. */
  ms?: number;
  failed?: true;
}

/** The compact form the backend puts on the message (`meta.work`), before the steps are loaded. */
export interface WorkMeta {
  steps: number;
  /**
   * One call per service, app or screen (else per tool), in order of first use, a dozen at most: the closed block's
   * logos.
   */
  calls: WorkCall[];
  durationMs: number | null;
}

export function workMeta(meta: Record<string, unknown> | undefined): WorkMeta | null {
  const w = meta?.work as Partial<WorkMeta> | undefined;
  if (!w || typeof w.steps !== "number") return null;
  return {
    steps: w.steps,
    calls: Array.isArray(w.calls)
      ? w.calls.filter((c): c is WorkCall => typeof (c as Partial<WorkCall> | null)?.name === "string")
      : [],
    durationMs: typeof w.durationMs === "number" ? w.durationMs : null,
  };
}

/**
 * Calls the block never lists: a reaction already shows on the message it reacts to, and looking a tool up (tools on
 * demand, a big connector's directory) is how our tools load, not something done for anyone. The server's
 * `meta.work` leaves them out too (`executor.ts`).
 */
const UNLISTED: ReadonlySet<ActivityKind> = new Set(["reacting", "findingTools"]);

/** One of `meta.work`'s calls that is only lookups: ours by name, with no app it could share a logo with. */
const onlyLookups = (c: WorkCall) => !c.connector && !c.service && UNLISTED.has(toolActivity(c.name).kind);

/** A saved reply's apps before its steps load (`meta.work.calls`): the ones `toolApps` gives once they do. */
export const workApps = (calls: WorkCall[]) =>
  uniqueApps(calls.filter((c) => !onlyLookups(c)).map((c) => toolActivity(c.name, c.connector, null, c)));

/**
 * How many calls a saved reply's block shows (0: no block). A reply saved before lookups were left out counted them.
 * `skip`: calls another card on the message already shows (where it browsed); a reply saved before the calls carried
 * their count shows its total unless every call is skipped.
 */
export function workSteps(w: WorkMeta, skip: (name: string) => boolean = () => false) {
  if (w.calls.length > 0 && w.calls.every((c) => onlyLookups(c) || skip(c.name))) return 0;
  return w.calls.reduce((n, c) => (skip(c.name) && typeof c.n === "number" ? n - c.n : n), w.steps);
}

/** How the Tool Gateway answers a call whose arguments it refuses (`tools/gateway.ts`). */
const SLIP = "Invalid input:";

/** Refused for its arguments, then made right: a later call of the same tool worked (or is at it). No failure for people. */
const madeRight = (slip: { tool: string }, later: { tool: string; failed?: boolean; held?: boolean }[]) =>
  later.some((c) => c.tool === slip.tool && !c.failed && !c.held);

const DRIVE: ActivityKind[] = ["readingDrive", "writingDrive", "exportingFile", "importingFile"];
const time = (iso: string) => new Date(iso).getTime();

/** Tool calls of a run (paired with their results), the apps it used and how long it took. */
export function workFromSteps(steps: RunStep[], run?: Pick<Run, "createdAt" | "finishedAt">): Work {
  const results = new Map<string, RunStep>();
  for (const s of steps) {
    const id = s.data.toolUseId;
    if (s.kind === "tool_result" && typeof id === "string") results.set(id, s);
  }
  const items: WorkItem[] = [];
  const narration: WorkNarration[] = [];
  const connectors: string[] = [];
  // Permission checks waiting on a person, by their request (Claude Code may ask twice while the card is open): the
  // runner asking again brings the answer.
  const waiting = new Map<string, { item: WorkItem; since: number }[]>();
  for (const s of steps) {
    if (s.kind === "model_call") {
      const text = typeof s.data.narration === "string" ? s.data.narration.trim() : "";
      if (text)
        narration.push({
          key: `say-${s.seq}`,
          turn: typeof s.data.turn === "number" ? s.data.turn : narration.length,
          text,
          at: items.length,
        });
      continue;
    }
    if (s.kind !== "tool_call") continue;
    const name = typeof s.data.name === "string" ? s.data.name : "";
    const id = typeof s.data.toolUseId === "string" ? s.data.toolUseId : `${s.seq}`;
    const result = results.get(id);
    const detail = typeof s.data.detail === "string" ? s.data.detail : null;
    const a = toolActivity(name, typeof s.data.connector === "string" ? s.data.connector : null, detail, {
      service: typeof s.data.service === "string" ? s.data.service : null,
      serviceIcon: typeof s.data.serviceIcon === "string" ? s.data.serviceIcon : null,
    });
    if (UNLISTED.has(a.kind)) continue;
    const app = a.kind === "consulting" ? a.app : DRIVE.includes(a.kind) ? "Drive" : undefined;
    if (app && !connectors.includes(app)) connectors.push(app);
    const input = (s.data.input ?? {}) as Record<string, unknown>;
    const content = typeof result?.data.content === "string" ? result.data.content : "";
    const check = name === PERMISSION_TOOL ? checkAnswer(content) : null;
    // The runner asking again about a command waiting on a person: never a line, its answer is the first ask's.
    if (check && typeof input.request_id === "string") {
      if (result && !check.request)
        for (const asked of waiting.get(input.request_id) ?? []) {
          delete asked.item.held;
          asked.item.ms = Math.max(0, time(result.createdAt) - asked.since);
          if (check.refused) {
            asked.item.failed = true;
            asked.item.why = check.why;
            asked.item.refusal = check.code;
          }
        }
      continue;
    }
    const source =
      typeof input.code === "string" ? input.code : typeof input.command === "string" ? input.command : null;
    const failed = result?.data.isError === true || check?.refused === true;
    const why = !failed ? null : check?.refused ? check.why : firstLine(content);
    const refusal = check?.code ?? (failed ? gatewayRefusal(result?.data.data) : null);
    const held = !result || Boolean(check?.request);
    const autoApproved = autoApprovedOf(result?.data.autoApproved);
    const ms = result ? Math.max(0, time(result.createdAt) - time(s.createdAt)) : null;
    // The same thing again, with nothing said in between, no code to show and both done: one line, not five. One
    // that failed or waits stays its own line, as in the live block (a later answer can still change it).
    const prev = items[items.length - 1];
    if (
      prev &&
      source === null &&
      !prev.code &&
      !prev.failed &&
      !prev.held &&
      !prev.autoApproved &&
      !autoApproved &&
      !failed &&
      !held &&
      sameActivity(prev, { ...a, tool: name }) &&
      narration[narration.length - 1]?.at !== items.length
    ) {
      prev.count += 1;
      prev.ms = prev.ms !== null && ms !== null ? prev.ms + ms : (prev.ms ?? ms);
      continue;
    }
    const item: WorkItem = {
      key: id,
      ...a,
      tool: name,
      ms,
      failed,
      ...(failed && content.startsWith(SLIP) ? { slip: true } : {}),
      count: 1,
      hint: toolHint(name, a, detail),
      why,
      ...(refusal ? { refusal } : {}),
      ...(held ? { held: true } : {}),
      ...(autoApproved ? { autoApproved } : {}),
      // A permission check opens on the whole command it checked (recorded masked), not on its JSON.
      input: source !== null ? null : typeof s.data.command === "string" ? s.data.command : shortJson(input),
      result: source === null && content && !check ? clip(content) : null,
      ...(source !== null
        ? {
            code: {
              language:
                typeof input.language === "string"
                  ? input.language
                  : typeof input.command === "string"
                    ? "bash"
                    : "python",
              source,
            },
            output: content ? [{ stream: failed ? ("stderr" as const) : ("stdout" as const), text: content }] : [],
          }
        : {}),
    };
    items.push(item);
    if (check?.request)
      waiting.set(check.request, [...(waiting.get(check.request) ?? []), { item, since: time(s.createdAt) }]);
  }
  const first = steps[0];
  const last = steps[steps.length - 1];
  const durationMs =
    run?.finishedAt && run.createdAt
      ? Math.max(0, time(run.finishedAt) - time(run.createdAt))
      : first && last
        ? Math.max(0, time(last.createdAt) - time(first.createdAt))
        : null;
  return { steps: items, narration, connectors, durationMs };
}

/** Calls that read as the same line ("Usou o navegador") with the same logo; an unknown tool's line names the tool. */
export const sameActivity = (a: Activity & { tool: string }, b: Activity & { tool: string }) =>
  a.kind === b.kind &&
  (a.app ?? "") === (b.app ?? "") &&
  (a.service ?? "") === (b.service ?? "") &&
  (a.kind !== "usingTool" || a.tool === b.tool);

/** How many tool calls the work stands for (folded lines count each call). */
export const workCalls = (w: Work) => w.steps.reduce((n, s) => n + s.count, 0);

/**
 * The live work with repeats folded: a call followed by the same kind of call (no code or output to
 * show) is dropped, so five browser steps and the one running read as "Usando o navegador…".
 */
export function foldLiveWork(work: LiveWork[]): LiveWork[] {
  const plain = (w: LiveWork | undefined) =>
    w?.kind === "call" && !w.code && w.output.length === 0 && !w.autoApproved
      ? { ...toolActivity(w.tool, w.connector, w.detail, w), tool: w.tool }
      : null;
  return work.filter((w, i) => {
    const a = plain(w);
    const b = plain(work[i + 1]);
    return !(a && b && sameActivity(a, b));
  });
}

/** "12 s", "3 min", "21 h 55 min": past a minute, as people say it (`workDuration`). */
export function formatDuration(t: TFunction, ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? t("chat.work.seconds", { n: s }) : workDuration(t, ms);
}

/** The pieces of the header: "4 passos", "himetrica e Drive", "12 s". */
export function workHeader(t: TFunction, w: { steps: number; connectors: string[]; durationMs: number | null }) {
  return {
    steps: t("chat.work.steps", { count: w.steps }),
    connectors: w.connectors.length > 0 ? joinNames(w.connectors, t) : null,
    duration: w.durationMs !== null ? formatDuration(t, w.durationMs) : null,
  };
}

/** "Consultou o Himetrica", "Atualizou o plano", and for a tool with no words of its own "Usou a ferramenta enviar e-mail". */
export function stepLabel(t: TFunction, s: Pick<WorkItem, "kind" | "app" | "tool">) {
  return t(`chat.work.step.${s.kind}`, { app: appLabel(s), tool: toolWords(t, s.tool) });
}

/**
 * A step as one line: its phrase and what it worked on unless the phrase says it ("Atualizou uma tarefa · #131"). A
 * command refused, or still waiting on a person, says so ("Recusado: npm publish", "Rodando: npm publish").
 */
export function stepPhrase(
  t: TFunction,
  step: { tool: string; detail?: string | null; outcome?: "refused" | "waiting" },
) {
  const a = toolActivity(step.tool, null, step.detail);
  const state = step.outcome === "refused" ? "fail" : step.outcome === "waiting" ? "stop" : "done";
  const label = toolPhrase(t, { ...a, tool: step.tool, state });
  const detail = step.detail?.trim();
  return detail && detail !== a.app ? `${label} · ${detail}` : label;
}

/** Steps in a row that read the same, as one line: how many, and the last of them (its time). */
export function foldSteps<T>(steps: T[], text: (step: T) => string): { step: T; text: string; count: number }[] {
  const lines: { step: T; text: string; count: number }[] = [];
  for (const step of steps) {
    const line = text(step);
    const prev = lines.at(-1);
    if (prev?.text === line) {
      prev.count += 1;
      prev.step = step;
    } else lines.push({ step, text: line, count: 1 });
  }
  return lines;
}

/**
 * A message of a stopped run (`meta.canceled`, `true` or `{ byUserId }`) ends
 * with the server's "_Interrompido por Walter._": that line leaves the text,
 * and the note is written on the client, in the UI language, from the meta.
 * `note` is the server's line (only a fallback when the meta has no person).
 */
export function splitCanceled(body: string, meta: Record<string, unknown> | undefined) {
  const canceled = meta?.canceled;
  if (!canceled) return { body, canceled: false, byUserId: null as string | null, note: null as string | null };
  const byUserId =
    typeof canceled === "object" && canceled && typeof (canceled as { byUserId?: unknown }).byUserId === "string"
      ? ((canceled as { byUserId: string }).byUserId as string)
      : null;
  // The server also sends what the agent wrote, without the note.
  const said = typeof canceled === "object" && canceled ? (canceled as { text?: unknown }).text : undefined;
  const match = /\n*\s*_([^_\n]+)_\s*$/.exec(body);
  if (typeof said === "string")
    return { body: said, canceled: true, byUserId, note: match?.[1]?.trim().replace(/\.$/, "") ?? null };
  if (!match) return { body, canceled: true, byUserId, note: null };
  return {
    body: body.slice(0, match.index).trimEnd(),
    canceled: true,
    byUserId,
    note: (match[1] ?? "").trim().replace(/\.$/, ""),
  };
}

// ───────────────────────────── the tool block (one per reply) ─────────────────────────────

/** How long a line's open view shows of what a tool was given and answered. */
const OPEN_MAX = 1200;

const clip = (text: string, max = OPEN_MAX) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const shortJson = (input: Record<string, unknown>) => {
  if (Object.keys(input).length === 0) return null;
  try {
    return clip(JSON.stringify(input, null, 2));
  } catch {
    return null;
  }
};

/** The first line of an error, short ("Connection to app_production timed out after 5s"). */
export const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line ? clip(line, 160) : null;
};

/** A refusal's first sentence, the part that says why ("A person said no."); the rest tells the agent what to do. */
const plainWhy = (text: string) => {
  const line = firstLine(text);
  return line ? (/^.+?[.!?](?=\s|$)/.exec(line)?.[0] ?? line) : null;
};

/**
 * Why a line failed, under it, for people: a refusal's reason in their words (`chat.work.refusal.<code>`), else
 * nothing. What the tool said is its own text (often English, a connector's JSON): the line's open view shows it.
 * `personal`: a personal workspace's (ADR 0159), whose reasons say no team where it has its own words for one.
 */
export function toolWhy(
  t: TFunction,
  l: { why?: string | null; refusal?: string | null },
  personal = false,
): string | null {
  if (!l.refusal) return null;
  const say = t as unknown as (key: string, options: { defaultValue: string }) => string;
  const key = `chat.work.refusal.${l.refusal}`;
  return (personal && say(`${key}Personal`, { defaultValue: "" })) || say(key, { defaultValue: "" }) || null;
}

/** The Tool Gateway's own refusal of a call (`tool_result` step `data.refusal`): a word `toolWhy` says. */
const gatewayRefusal = (data: unknown) => {
  const refusal = (data as { refusal?: unknown } | null | undefined)?.refusal;
  return typeof refusal === "string" && refusal ? refusal : null;
};

/** A permission check's answer (`permission_prompt`): refused and why, or waiting on a person (its request). */
function checkAnswer(content: string) {
  let answer: Record<string, unknown> = {};
  try {
    const value = JSON.parse(content) as unknown;
    if (value && typeof value === "object") answer = value as Record<string, unknown>;
  } catch {
    // An error's text, not an answer.
  }
  const refused = answer.behavior === "deny";
  return {
    refused,
    why: refused && typeof answer.message === "string" ? plainWhy(answer.message) : null,
    code: refused && typeof answer.code === "string" ? answer.code : null,
    request: answer.status === "pending" && typeof answer.request_id === "string" ? answer.request_id : null,
  };
}

/**
 * The grey words after a line's phrase: a built-in tool's own short label (the skill, the issue, the file; the
 * engine's `toolDetail`), or a connector tool's own name without its app ("github_search_issues" → "search
 * issues", a server's whole label too: "acme_tools_find_orders" → "find orders"; a mailbox's keeps which one,
 * as its line names only the maker: "mail_vendas_search" → "vendas search"; a database's drops the name its line
 * says: "pg_analytics_query" → "query"). Never a connector's input: the live event doesn't carry it either.
 */
export function toolHint(tool: string, activity: Activity, detail?: string | null) {
  // Never what the phrase already says ("Abriu a skill relatorio", "Rodou: Rerun the tests").
  if (detail?.trim()) return detail.trim() === activity.app ? null : detail.trim();
  if (activity.kind !== "consulting") return null;
  const name = tool.trim().replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
  // A connector may share its service name with a mailbox (Gmail): only `mail_` tools are a mailbox's.
  if (
    activity.service === "mail" ||
    activity.service === "postgres" ||
    (MAIL_BRANDS[activity.service ?? ""] && name.startsWith("mail_"))
  )
    return toolLabel(name.replace(activity.service === "postgres" ? /^pg_[a-z0-9]+_/ : /^mail_/, "")) || null;
  const app = (activity.app ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const parts = name.split(/[_.:]/);
  let lead = 0;
  for (let joined = ""; app && lead < parts.length - 1 && joined !== app; lead++) {
    const next = joined + (parts[lead] ?? "").toLowerCase();
    if (!app.startsWith(next) && !(lead === 0 && next.startsWith(app))) break;
    joined = next;
  }
  // A later account's tools carry its number after the app's name (`stripe_2_list_customers`).
  if (lead > 0 && lead < parts.length - 1 && /^\d+$/.test(parts[lead] ?? "")) lead++;
  return toolLabel(parts.slice(lead).join("_")) || null;
}

/** A line's state: working on it, done, it failed, or it didn't end (stopped during it, or it waits on a person). */
export type ToolState = "run" | "done" | "fail" | "stop";

/** One line of the tool block: a call (or several of the same in a row). */
export interface ToolLine extends Activity {
  key: string;
  tool: string;
  state: ToolState;
  hint: string | null;
  ms: number | null;
  count: number;
  why: string | null;
  /** Refused for its arguments and made right, or being made right: quiet, its own line. */
  slip?: boolean;
  /** A refused command: the refusal's code (`toolWhy` says it in the person's words). */
  refusal?: string | null;
  input: string | null;
  result: string | null;
  code?: LiveCode;
  output?: LiveOutput[];
  autoApproved?: AutoApproved | null;
}

/** What the block lists, in order: its calls, what the agent said between them, and the messages it read. */
export type ToolItem =
  | { kind: "call"; key: string; line: ToolLine }
  | { kind: "say"; key: string; text: string }
  | { kind: "steer"; key: string; messageId: string; now: boolean };

const sameLine = (a: ToolLine, b: Activity & { tool: string }) =>
  a.state !== "fail" && !a.code && !a.output && sameActivity(a, b);

/**
 * The live work as the block's items: a call followed by the same kind of call (no code, nothing said in
 * between, neither failed) is one line counting both, so five browser steps read "Usou o navegador ×5".
 * Reactions and tool lookups are left out (`UNLISTED`), as in `workFromSteps`. `stopped`: the run is over, so the call
 * still running shows as stopped. A call refused for its arguments reads as still at it while the agent tries again,
 * and quietly once one of the same tool works; an error only if the run ends or moves on without that.
 */
export function toolItemsLive(work: LiveWork[], stopped = false): ToolItem[] {
  const items: ToolItem[] = [];
  const listed = work.flatMap((w) =>
    w.kind === "call" && !UNLISTED.has(toolActivity(w.tool, w.connector, w.detail, w).kind) ? [w] : [],
  );
  work.forEach((w) => {
    if (w.kind === "steer") {
      items.push({ kind: "steer", key: `steer-${w.messageId}`, messageId: w.messageId, now: w.now === true });
      return;
    }
    const a = toolActivity(w.tool, w.connector, w.detail, w);
    if (UNLISTED.has(a.kind)) return;
    const later = listed.slice(listed.indexOf(w) + 1);
    const atIt = !stopped && later.every((c) => c.slip && c.tool === w.tool);
    const trying = w.slip === true && atIt && later.length === 0;
    const slip = w.slip === true && (atIt || madeRight(w, stopped ? later.filter((c) => !c.running) : later));
    // Held (it waits on a person, so it never ran) reads like a call stopped before it ended.
    const state: ToolState =
      trying || (w.running && !stopped)
        ? "run"
        : w.running || slip || (w.held && !w.failed)
          ? "stop"
          : w.failed
            ? "fail"
            : "done";
    const hasCode = Boolean(w.code) || w.output.length > 0;
    const prev = items[items.length - 1];
    const autoApproved = w.autoApproved ?? null;
    if (
      prev?.kind === "call" &&
      !hasCode &&
      state !== "fail" &&
      !slip &&
      !prev.line.slip &&
      !autoApproved &&
      !prev.line.autoApproved &&
      sameLine(prev.line, { ...a, tool: w.tool })
    ) {
      prev.line.count += 1;
      prev.line.state = state;
      prev.line.ms = prev.line.ms !== null && w.ms !== undefined ? prev.line.ms + w.ms : (prev.line.ms ?? w.ms ?? null);
      return;
    }
    items.push({
      kind: "call",
      key: w.id,
      line: {
        key: w.id,
        ...a,
        tool: w.tool,
        state,
        hint: toolHint(w.tool, a, w.detail),
        ms: w.ms ?? null,
        count: 1,
        why: w.why ? plainWhy(w.why) : null,
        ...(slip ? { slip: true } : {}),
        refusal: w.refusal ?? null,
        input: w.command ?? null,
        result: null,
        ...(autoApproved ? { autoApproved } : {}),
        ...(w.code ? { code: w.code } : {}),
        ...(w.output.length > 0 ? { output: w.output } : {}),
      },
    });
  });
  return items;
}

/** A saved run's work (`workFromSteps`) as the block's items, the narration where it was said. */
export function toolItemsSaved(work: Work): ToolItem[] {
  return work.steps.flatMap((s, i): ToolItem[] => {
    const slip = s.slip === true && madeRight(s, work.steps.slice(i + 1));
    return [
      ...work.narration.filter((n) => n.at === i).map((n) => ({ kind: "say" as const, key: n.key, text: n.text })),
      {
        kind: "call",
        key: s.key,
        line: {
          key: s.key,
          kind: s.kind,
          ...(s.app ? { app: s.app } : {}),
          ...(s.service ? { service: s.service } : {}),
          ...(s.icon ? { icon: s.icon } : {}),
          tool: s.tool,
          state: slip ? "stop" : s.failed ? "fail" : s.held ? "stop" : "done",
          ...(slip ? { slip: true } : {}),
          hint: s.hint ?? null,
          ms: s.ms,
          count: s.count,
          why: s.why ?? null,
          refusal: s.refusal ?? null,
          input: s.input ?? null,
          result: s.result ?? null,
          ...(s.autoApproved ? { autoApproved: s.autoApproved } : {}),
          ...(s.code ? { code: s.code, output: s.output ?? [] } : {}),
        },
      },
    ];
  });
}

const linesOf = (items: ToolItem[]) => items.flatMap((i) => (i.kind === "call" ? [i.line] : []));

/** How many calls the items stand for (a folded line counts each). */
export const toolCalls = (items: ToolItem[]) => linesOf(items).reduce((n, l) => n + l.count, 0);

/** How many logos the block's line stacks: a few, so its words keep the room. */
const LOGOS_MAX = 4;

/** What makes an app one logo of the block: its service, else its name, else what one of our tools does. */
export const appKey = (a: Activity) =>
  a.service ? `service:${a.service}` : a.kind === "consulting" ? `app:${a.app ?? ""}` : `kind:${a.kind}`;

/** Each app once, in order of first use, the first few. */
function uniqueApps(activities: Activity[]) {
  const apps: Activity[] = [];
  for (const a of activities) {
    if (apps.length === LOGOS_MAX) break;
    if (apps.some((b) => appKey(b) === appKey(a))) continue;
    apps.push({
      kind: a.kind,
      ...(a.app ? { app: a.app } : {}),
      ...(a.service ? { service: a.service } : {}),
      ...(a.icon ? { icon: a.icon } : {}),
    });
  }
  return apps;
}

/** The apps it used, in order of first use (the block's logos, a few at most). */
export const toolApps = (items: ToolItem[]) => uniqueApps(linesOf(items));

/**
 * How a call's logo is drawn, as the connectors screens draw the service: our own icon for one of our tools
 * (`own`), our envelope for a mailbox whose maker has no mark here (`mail`), or the service's tile: its mark,
 * else a server's own icon, else a monogram of its name.
 */
export type CallLogo =
  | { kind: "own" }
  | { kind: "mail" }
  | {
      kind: "service";
      def: Pick<ConnectorDef, "iconUrl" | "brandColor"> | null;
      image: string | null;
      label: string;
    };

/** A call's logo: its service's mark (a mailbox's maker, Postgres, the catalog's by id or name), or ours. */
export function callLogo(
  a: Activity,
  catalog: Pick<ConnectorDef, "id" | "label" | "iconUrl" | "brandColor">[],
): CallLogo {
  if (a.service === "mail") return { kind: "mail" };
  const mark = a.service === "postgres" ? { iconUrl: POSTGRES_MARK, brandColor: null } : MAIL_BRANDS[a.service ?? ""];
  if (mark) return { kind: "service", def: mark, image: null, label: a.app ?? "" };
  const def =
    (a.service ? appConnector(catalog, a.service) : null) ??
    (a.kind === "consulting" && a.app ? appConnector(catalog, a.app) : null);
  if (!def && a.kind !== "consulting") return { kind: "own" };
  return { kind: "service", def, image: a.icon ?? null, label: a.app ?? def?.label ?? "" };
}

/** The line the closed block shows while it works: the call running now, else the last one. */
export const toolNow = (items: ToolItem[]) => linesOf(items).at(-1) ?? null;

/**
 * A line's phrase: "Consultando o GitHub…" while it runs, "Consultou o GitHub" once done, "Deu erro
 * consultando o GitHub" when it failed, "Consultando o GitHub" (no dots) when the run stopped during it.
 * A command the permission check refused says so: "Recusado: Rerun the tests".
 */
export function toolPhrase(t: TFunction, l: Pick<ToolLine, "kind" | "app" | "tool" | "state">) {
  const verb = activityVerb(t, { kind: l.kind, app: l.app });
  if (l.state === "run") return `${capitalize(verb)}…`;
  if (l.state === "stop") return capitalize(verb);
  if (l.state === "fail" && l.kind === "runningCommand") return t("chat.work.refused", { app: appLabel(l) });
  if (l.state === "fail" && l.kind === "runningCommandAny") return t("chat.work.refusedAny");
  if (l.state === "fail") return t("chat.work.erred", { activity: verb });
  return t(`chat.work.step.${l.kind}`, { app: appLabel(l), tool: toolWords(t, l.tool) });
}

/** A turn quicker than this shows nothing new: its step line says the agent's own words only past it. */
export const STEP_WORDS_AFTER_MS = 5000;

/**
 * The waiting row's step line: what the agent does right now, verb first ("Usando o navegador · console.example.com…",
 * "Mexendo nos arquivos do PC · refresh.ts…"), from the same live work as its tool block; "Pensando…" while no step
 * runs; "Esperando aprovação…" while its last call waits on a person. `step`: the brain's own words for its latest call
 * (quoted), or its own call no `agent.tool` told.
 */
export function waitStep(t: TFunction, work: LiveWork[] | undefined, step?: LiveStep): string {
  const last = (work ?? []).findLast((w) => w.kind === "call");
  if (last?.kind === "call" && last.held) return t("chat.wait.held");
  if (step?.said) return t("chat.wait.said", { text: step.said });
  const now = toolNow(toolItemsLive(work ?? []));
  if (now?.state !== "run") {
    return step?.tool ? `${capitalize(activityVerb(t, toolActivity(step.tool)))}…` : t("chat.wait.thinking");
  }
  const verb = capitalize(activityVerb(t, now));
  // The folded line keeps its first call's hint; the step line names the call running now.
  const hint = last?.kind === "call" && last.running ? toolHint(last.tool, now, last.detail) : now.hint;
  const target = hint ? shortTarget(hint) : "";
  return target ? `${verb} · ${target}…` : `${verb}…`;
}

/**
 * The bar's words for one agent at work: its step with a lower-case start, after its name ("Nina consultando o Email ·
 * …"), or "escrevendo…" while it writes (`running`: its words show whole once posted) and no call runs. Its own words
 * only once the turn has gone on for `STEP_WORDS_AFTER_MS`.
 */
export function barStep(
  t: TFunction,
  run: Pick<LiveRun, "status" | "work" | "step" | "startedAt" | "workingSince">,
  locale?: string,
  now = Date.now(),
): string {
  const calling = (run.work ?? []).some((w) => w.kind === "call" && w.running);
  if (!calling && run.status === "running") return `${activityVerb(t, { kind: "writing" })}…`;
  const long = now - (run.workingSince ?? run.startedAt ?? now) >= STEP_WORDS_AFTER_MS;
  return lowerFirst(waitStep(t, run.work, long ? run.step : undefined), locale);
}

/** "1,2 s", "760 ms": a line's time, finer than the block's. */
export function formatLineTime(locale: string, ms: number) {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  if (ms < 60_000) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(ms / 1000)} s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} min`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: ms < 10 * 3600_000 ? 1 : 0 }).format(ms / 3600_000)} h`;
}

// ───────────────────────────── one call on its own ─────────────────────────────

/** The work is one call: its line stands alone, no "Usou 1 ferramenta" to open (two or more keep the block). */
export const oneCall = (items: ToolItem[]) => toolCalls(items) === 1;

/**
 * Our own reads that only feed the answer: the reply states what they found, so a card saying "Conferiu o próprio
 * uso" adds nothing. Anything that changes something, reaches an app, a file, the PC or a screen is not here.
 */
const QUIET_READS: ReadonlySet<ActivityKind> = new Set([
  "checkingUsage",
  "gettingContext",
  "searchingMemory",
  "findingAgent",
  "checkingComputer",
  "checkingCalendar",
  "readingIssues",
  "listingTasks",
  "checkingTask",
  "listingReminders",
  "listingRoutines",
  "readingWiki",
  "consultingSkill",
  "openingSkill",
  "readingConversation",
  "readingDashboards",
]);

/** A step running this long is no quick read: its card stays. */
const LONG_STEP_MS = 4000;

/**
 * One quick internal read that ended well, with nothing of its own to show (no code, no output). Ours only: another
 * MCP server's `list_issues` takes our kind's name (`toolActivity`) but reached an outside app.
 */
export const quietLine = (
  l: Pick<ToolLine, "tool" | "service" | "kind" | "state" | "count" | "ms" | "code" | "output">,
) =>
  l.count === 1 &&
  !l.service &&
  (!/^mcp__/i.test(l.tool) || /^mcp__agentes__/i.test(l.tool)) &&
  l.state === "done" &&
  QUIET_READS.has(l.kind) &&
  !l.code &&
  !l.output?.length &&
  (l.ms === null || l.ms < LONG_STEP_MS);

/** The turn's only tool work is a quiet read (`quietLine`): no card, live, kept or saved. */
export const quietWork = (items: ToolItem[]) => {
  const lines = linesOf(items);
  return lines.length === 1 && lines[0] !== undefined && quietLine(lines[0]);
};

/**
 * A saved reply's lone call (`meta.work` of one step) as its line, before the run's steps load: what it did, from
 * `meta.work.calls`; how long it took and whether it failed, from `meta.work.ms` and `failed` (the call's own, when
 * the screens' steps sit beside it). A reply saved before the server wrote those reads as done, in the reply's own
 * time (unknown, `ms: null`, beside other calls). Null when the reply made no call, or several.
 */
export function savedOneLine(
  meta: Record<string, unknown> | undefined,
  skip: (name: string) => boolean = () => false,
): ToolLine | null {
  const w = workMeta(meta);
  if (!w) return null;
  // Besides the calls another card shows, one call left: its line.
  const rest = w.calls.filter((c) => !skip(c.name));
  const call = workSteps(w, skip) === 1 && rest.length === 1 ? rest[0] : undefined;
  if (!call) return null;
  const { ms, failed } = (w.steps === 1 ? (meta?.work ?? {}) : call) as { ms?: unknown; failed?: unknown };
  const a = toolActivity(call.name, call.connector, null, call);
  return {
    key: `one-${call.name}`,
    ...a,
    tool: call.name,
    state: failed === true ? "fail" : "done",
    hint: toolHint(call.name, a),
    ms: typeof ms === "number" ? ms : w.steps === 1 ? w.durationMs : null,
    count: 1,
    why: null,
    input: null,
    result: null,
  };
}
