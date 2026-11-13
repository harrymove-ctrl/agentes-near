import type { TFunction } from "i18next";
import type {
  MachineTask,
  MachineTaskMeta,
  Message,
  Mission,
  MissionAutoApprovedMeta,
  MissionCommandMeta,
  MissionLinkMeta,
  MissionPlanChangeMeta,
  MissionPlanMeta,
  MissionReportMeta,
  MissionSetupMeta,
  MissionSuggestionMeta,
  MissionSummary,
  PlanItem,
} from "../api/types";

/**
 * Missions (ADR 0029): the pure
 * pieces the thread, the pinned card and the Missões tab share. The plan is a
 * living checklist (no phases, no gates), drawn as one pixel cell per item.
 */

/** One cell of the plan strip: done (filled), doing (moving), waiting for you (outlined), stopped with the computer (dim outline), dropped (faint diagonal), to do (faint solid). */
export type PlanCell = "done" | "doing" | "waiting" | "stopped" | "dropped" | "todo";

/** The cell of one plan item. `offline`: what was being done stopped with the computer. */
export function planCell(status: PlanItem["status"], options: { offline?: boolean } = {}): PlanCell {
  if (status === "done") return "done";
  if (status === "doing") return options.offline ? "stopped" : "doing";
  if (status === "waiting_you") return "waiting";
  if (status === "dropped") return "dropped";
  return "todo";
}

/**
 * The strip from the plan's items, in order. Dropped items are left out, as
 * in "N de M itens" (`planCounts`), so the strip and the count agree.
 */
export function planCells(items: Pick<PlanItem, "status">[], options: { offline?: boolean } = {}): PlanCell[] {
  return items.filter((i) => i.status !== "dropped").map((i) => planCell(i.status, options));
}

/** The item titles in the strip's order (dropped left out), for each cell's tooltip. */
export function planCellTitles(items: Pick<PlanItem, "status" | "title">[]): string[] {
  return items.filter((i) => i.status !== "dropped").map((i) => i.title);
}

/**
 * The strip when only the counts are known (the Missões tab's list): done
 * first, then what waits for people, then as many moving cells as tasks
 * running, then what is left.
 */
export function cellsFromCounts(
  plan: { done: number; total: number; waiting: number },
  running = 0,
  options: { offline?: boolean } = {},
): PlanCell[] {
  const total = Math.max(0, plan.total);
  const done = Math.min(total, Math.max(0, plan.done));
  const waiting = Math.min(total - done, Math.max(0, plan.waiting));
  const doing = Math.min(total - done - waiting, Math.max(0, running));
  return [
    ...Array<PlanCell>(done).fill("done"),
    ...Array<PlanCell>(waiting).fill("waiting"),
    ...Array<PlanCell>(doing).fill(options.offline ? "stopped" : "doing"),
    ...Array<PlanCell>(total - done - waiting - doing).fill("todo"),
  ];
}

/** The item titles of a mission view's strip (empty when only the counts are known). */
export function missionCellTitles(m: Pick<Mission, "plan">): string[] {
  return planCellTitles(m.plan.items ?? []);
}

/**
 * The strip of a mission view: its plan items when the server sent them
 * (`plan.items`), else the counts (an older server), with what is in
 * progress (`plan.doing`) as the moving cells.
 */
export function missionCells(
  m: Pick<Mission, "plan" | "runningTasks">,
  options: { offline?: boolean } = {},
): PlanCell[] {
  const items = m.plan.items ?? [];
  if (items.some((i) => i.status !== "dropped")) return planCells(items, options);
  return cellsFromCounts(m.plan, m.plan.doing ?? m.runningTasks, options);
}

/** "N de M itens": dropped items don't count (same as the server's plan counts). */
export function planCounts(items: Pick<PlanItem, "status">[]) {
  const live = items.filter((i) => i.status !== "dropped");
  return {
    total: live.length,
    done: live.filter((i) => i.status === "done").length,
    doing: live.filter((i) => i.status === "doing").length,
    waiting: live.filter((i) => i.status === "waiting_you").length,
  };
}

/** A mission still being worked on (the pinned card's controls, the composer commands). */
export const isOpenMission = (m: Pick<Mission, "status">) =>
  m.status === "proposed" || m.status === "active" || m.status === "paused" || m.status === "awaiting_close";

/** What waits for people, in the order the cards show it ("2 decisões, 1 revisão"). */
export type WaitingKey = "decisions" | "provisional" | "reviews" | "suggestions" | "commands" | "deliveries";
export function waitingParts(m: Pick<Mission, "pending" | "canAct">): { key: WaitingKey; count: number }[] {
  if (!m.canAct) return [];
  const parts: { key: WaitingKey; count: number }[] = [
    { key: "decisions", count: m.pending.decisions },
    { key: "provisional", count: m.pending.provisional },
    { key: "reviews", count: m.pending.reviews },
    { key: "suggestions", count: m.pending.suggestions },
    { key: "commands", count: m.pending.commands },
    { key: "deliveries", count: m.pending.deliveries ?? 0 },
  ];
  return parts.filter((p) => p.count > 0);
}

/** "Esperando você: 2 decisões, 1 revisão" (empty when nothing waits for this person). */
export function waitingText(t: TFunction, m: Pick<Mission, "pending" | "canAct">): string {
  return waitingParts(m)
    .map((p) => t(`missions.waiting.${p.key}`, { count: p.count }))
    .join(", ");
}

/** "1 h 25", "14 min", "40 s": a span in the person's language. */
/** How often an elapsed label must tick: 1 s under a minute, 15 s under an hour, then a minute. */
export function tickFor(ageSeconds: number): number {
  if (ageSeconds < 60) return 1000;
  if (ageSeconds < 3600) return 15_000;
  return 60_000;
}

export function formatSpan(t: TFunction, seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t("missions.span.s", { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("missions.span.m", { m });
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24)
    return rest ? t("missions.span.hm", { h, m: String(rest).padStart(2, "0") }) : t("missions.span.h", { h });
  return t("missions.span.d", { count: Math.floor(h / 24) });
}

/** How long a task has run (or ran), in seconds. */
export function taskSeconds(task: Pick<MachineTask, "seconds" | "startedAt" | "status">, now = Date.now()): number {
  if (task.status === "running" && task.startedAt) return Math.max(0, (now - Date.parse(task.startedAt)) / 1000);
  return task.seconds ?? 0;
}

/** The status icon of a session row (never a colored dot). */
export type SessionState = "running" | "done" | "failed" | "interrupted" | "canceled" | "queued";
export const sessionState = (task: Pick<MachineTask, "status">): SessionState => task.status;

/** The tasks of a mission, running first, then the newest. */
export function missionTasks(tasks: MachineTask[], missionId: string): MachineTask[] {
  const rank = (t: MachineTask) => (t.status === "running" ? 0 : t.status === "queued" ? 1 : 2);
  return tasks
    .filter((t) => t.missionId === missionId && !t.resumedTaskId)
    .sort((a, b) => rank(a) - rank(b) || (a.createdAt < b.createdAt ? 1 : -1));
}

/** A pull request named in a line ("PR #431", a GitHub pull URL). */
export function prOf(text: string | null | undefined): { number: string; url: string | null } | null {
  if (!text) return null;
  const url = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/.exec(text);
  if (url?.[1]) return { number: url[1], url: url[0] };
  const short = /\bPR #(\d+)\b/i.exec(text);
  return short?.[1] ? { number: short[1], url: null } : null;
}

/** The pull request of a session: the server's `prUrl`, else (older rows) one named in its last line. */
export function taskPr(task: Pick<MachineTask, "prUrl" | "lastLine">): { number: string; url: string | null } | null {
  if (task.prUrl) {
    const n = /\/(?:pull|merge_requests)\/(\d+)/.exec(task.prUrl);
    return { number: n?.[1] ?? "", url: task.prUrl };
  }
  return prOf(task.lastLine);
}

/** "Ver saída" while it runs: the live last line joins the log when it is new (at most `max` lines kept). */
export function appendOutputLine(lines: string[], line: string | null | undefined, max = 200): string[] {
  const l = (line ?? "").trim();
  if (!l || lines.at(-1) === l) return lines;
  return [...lines, l].slice(-max);
}

/** The plan change line: "+ Notificações · − Drawer lateral" (renames and status changes too). */
export function planChangeParts(change: Pick<MissionPlanChangeMeta, "added" | "removed" | "changed">) {
  return {
    added: change.added.map((i) => i.title),
    removed: change.removed.map((i) => i.title),
    done: change.changed.filter((i) => i.to === "done").map((i) => i.title),
    renamed: change.changed.filter((i) => i.renamedFrom).map((i) => ({ from: i.renamedFrom ?? "", to: i.title })),
  };
}

/** `/summary`: the counts as lines in the person's language (the server's text is English). */
export type SummaryKey = "plan" | "doing" | "running" | "decisions" | "provisional" | "reviews" | "waiting";
export function summaryParts(s: MissionSummary): { key: SummaryKey; count: number; total?: number }[] {
  const parts: { key: SummaryKey; count: number; total?: number }[] = [
    { key: "plan", count: s.plan.done, total: s.plan.total },
    { key: "doing", count: s.plan.doing },
    { key: "running", count: s.running },
    { key: "decisions", count: s.pendingDecisions },
    { key: "provisional", count: s.provisionalDecisions },
    { key: "reviews", count: s.pendingReviews },
    { key: "waiting", count: s.plan.waiting },
  ];
  return parts.filter((p) => p.key === "plan" || p.count > 0);
}

/** Composer commands (English, like the server's): `/mission <goal>`, `/stop`, `/pause`, `/resume`, `/summary`, `/plan`. */
export const MISSION_COMMANDS = ["mission", "stop", "pause", "resume", "summary", "plan"] as const;
export type MissionCommand = (typeof MISSION_COMMANDS)[number];

export function parseMissionCommand(text: string): { command: MissionCommand; arg: string } | null {
  const m = /^\/(mission|stop|pause|resume|summary|plan)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m?.[1]) return null;
  const command = m[1].toLowerCase() as MissionCommand;
  const arg = (m[2] ?? "").trim();
  if (command === "mission" && !arg) return null;
  if (command !== "mission" && arg) return null;
  return { command, arg };
}

// ── Message meta ─────────────────────────────────────────────────────────────

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** `meta.missionLink`: a mission proposed here whose thread lives elsewhere (the link card). */
export function missionLinkOf(meta: Message["meta"]): MissionLinkMeta | null {
  const p = obj(meta?.missionLink);
  if (!p || !str(p.missionId) || !str(p.threadId)) return null;
  return { missionId: str(p.missionId), threadId: str(p.threadId) };
}

export function missionPlanOf(meta: Message["meta"]): MissionPlanMeta | null {
  const p = obj(meta?.missionPlan);
  if (!p || !str(p.missionId)) return null;
  return {
    missionId: str(p.missionId),
    title: str(p.title),
    goal: str(p.goal),
    computer: str(p.computer),
    executor: str(p.executor) || "claude",
  };
}

export function missionReportOf(meta: Message["meta"]): MissionReportMeta | null {
  const p = obj(meta?.missionReport);
  if (!p || !str(p.missionId)) return null;
  return {
    missionId: str(p.missionId),
    taskId: str(p.taskId),
    status: str(p.status),
    executor: str(p.executor) || "claude",
    computer: str(p.computer) || null,
    main: p.main === true,
  };
}

export function missionCardRef(meta: Message["meta"], key: "missionDecision" | "missionReview" | "missionDelivery") {
  const p = obj(meta?.[key]);
  return p && str(p.id) && str(p.missionId) ? { id: str(p.id), missionId: str(p.missionId) } : null;
}

export function missionPlanChangeOf(meta: Message["meta"]): MissionPlanChangeMeta | null {
  const p = obj(meta?.missionPlanChange);
  if (!p || !str(p.missionId)) return null;
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : []).flatMap((x) => {
      const o = obj(x);
      return o && str(o.title) ? [{ ...o, id: str(o.id), title: str(o.title) }] : [];
    });
  return {
    missionId: str(p.missionId),
    version: typeof p.version === "number" ? p.version : 0,
    added: list(p.added),
    removed: list(p.removed),
    changed: list(p.changed) as MissionPlanChangeMeta["changed"],
  };
}

export function missionSuggestionOf(meta: Message["meta"]): MissionSuggestionMeta | null {
  const p = obj(meta?.missionSuggestion);
  const status = str(p?.status);
  if (!p || !str(p.missionId) || !["pending", "accepted", "declined"].includes(status)) return null;
  return {
    status: status as MissionSuggestionMeta["status"],
    missionId: str(p.missionId),
    ...(str(p.by) ? { by: str(p.by) } : {}),
    ...(str(p.at) ? { at: str(p.at) } : {}),
  };
}

export function machineTaskOf(meta: Message["meta"]): MachineTaskMeta | null {
  const p = obj(meta?.machineTask);
  if (!p || !str(p.id)) return null;
  return {
    id: str(p.id),
    title: str(p.title),
    status: (str(p.status) || "done") as MachineTaskMeta["status"],
    exitCode: typeof p.exitCode === "number" ? p.exitCode : null,
    seconds: typeof p.seconds === "number" ? p.seconds : 0,
    computer: str(p.computer),
    executor: str(p.executor),
    ...(str(p.branch) ? { branch: str(p.branch) } : {}),
    ...(str(p.lastLine) ? { lastLine: str(p.lastLine) } : {}),
    ...(Array.isArray(p.files) ? { files: p.files.map(String) } : {}),
    ...(str(p.result) ? { result: str(p.result) } : {}),
    ...(str(p.missionId) ? { missionId: str(p.missionId) } : {}),
    ...(Array.isArray(p.blocked)
      ? {
          blocked: p.blocked
            .map((d) => obj(d))
            .flatMap((d) => (d && str(d.command) ? [{ tool: str(d.tool) || "Bash", command: str(d.command) }] : [])),
        }
      : {}),
  };
}

/**
 * `meta.missionSetup` (ADR 0044): preparing the mission's copy of the project failed
 * (the card "Não consegui preparar o projeto" with "Tentar de novo").
 */
export function missionSetupOf(meta: Message["meta"]): MissionSetupMeta | null {
  const p = obj(meta?.missionSetup);
  if (!p || str(p.state) !== "failed") return null;
  const reason = str(p.reason);
  return {
    state: "failed",
    reason: reason === "ensure" || reason === "branch_missing" ? reason : "setup",
    error: str(p.error),
    ...(str(p.branch) ? { branch: str(p.branch) } : {}),
    ...(str(p.missionId) ? { missionId: str(p.missionId) } : {}),
  };
}

/** The last `n` non-empty lines of an error's output (the setup card shows only the end). */
export function lastLines(text: string | null | undefined, n = 8): string {
  const lines = (text ?? "").replace(/\s+$/, "").split("\n");
  while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
  return lines.slice(-n).join("\n");
}

/** A commit as people may see it: the first 7 characters ("a1b2c3d"). */
export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "");

/** "a1b2c3d..e4f5a6b": the range a session changed, when the server knows both ends. */
export function taskRange(task: Pick<MachineTask, "startSha" | "endSha">): string | null {
  if (!task.startSha || !task.endSha || task.startSha === task.endSha) return null;
  return `${shortSha(task.startSha)}..${shortSha(task.endSha)}`;
}

/** `meta.missionAutoApproved`: a command allowed without a card (the quiet line). */
export function missionAutoApprovedOf(meta: Message["meta"]): MissionAutoApprovedMeta | null {
  const p = obj(meta?.missionAutoApproved);
  if (!p || !str(p.missionId) || !str(p.command)) return null;
  return {
    missionId: str(p.missionId),
    taskId: str(p.taskId),
    tool: str(p.tool) || "Bash",
    command: str(p.command),
    reason: str(p.reason) === "never" ? "never" : "low_risk",
  };
}

/** `meta.missionCommand`: the executor asks to run a command (the command card). */
export function missionCommandOf(meta: Message["meta"]): MissionCommandMeta | null {
  const p = obj(meta?.missionCommand);
  if (!p || !str(p.id) || !str(p.missionId)) return null;
  return {
    id: str(p.id),
    missionId: str(p.missionId),
    taskId: str(p.taskId),
    tool: str(p.tool) || "Bash",
    command: str(p.command),
  };
}

/**
 * The server's notices about a computer and its tasks (offline, back, a task that ended) and, ADR 0036 §8,
 * an agent's folder request on it (`machine_access_requested|granted|denied|expired`, params
 * `agent`, `folder`, `computer`, optional `command`): event lines.
 */
export function taskNoticeOf(meta: Message["meta"]): { code: string; params: Record<string, string> } | null {
  const code = str(meta?.bodyCode);
  if (!/^machine_(offline|task_[a-z]+|access_(requested|granted|denied|expired))$/.test(code)) return null;
  const params = obj(meta?.bodyParams) ?? {};
  return { code, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v ?? "")])) };
}

/**
 * Who programs, for people: "Claude Code", "Codex" (products, not jargon),
 * or the agent's own name when it does the work itself.
 */
export const executorName = (executor: string, agentName = "") =>
  executor === "codex" ? "Codex" : executor === "agent" ? agentName : "Claude Code";

/** "Claude Code no MacBook do Walter", "Ada no MacBook do Walter": who programs and where (no "via"). */
export function executorOnText(t: TFunction, executor: string, agentName: string, computer: string | null | undefined) {
  const name = executor === "agent" ? agentName : executorName(executor);
  return computer ? t("missions.executorOn", { executor: name, computer }) : name;
}

/** "via Claude Code no MacBook", or "Dev no MacBook" when the agent itself works there. */
export function viaText(t: TFunction, executor: string, agentName: string, computer: string | null | undefined) {
  if (executor === "agent") {
    return computer ? t("missions.byAgent", { agent: agentName, computer }) : agentName;
  }
  const name = executorName(executor);
  return computer ? t("missions.via", { executor: name, computer }) : t("missions.viaNoComputer", { executor: name });
}

// ── The `.agentes/` files, as the panel draws them ───────────────────────────

/** A checklist line's mark (the server writes `[ ]`, `[~]`, `[!]`, `[x]`, `[-]`). */
export type CheckState = "todo" | "doing" | "waiting" | "done" | "dropped";
const CHECK: Record<string, CheckState> = {
  " ": "todo",
  "~": "doing",
  "!": "waiting",
  x: "done",
  X: "done",
  "-": "dropped",
};

export type MdLine =
  | { kind: "h1" | "h2" | "p" | "li" | "quote"; text: string }
  | { kind: "check"; text: string; state: CheckState; note?: string }
  | { kind: "blank" };

/** A small Markdown subset (headings, checklists, bullets, quotes, paragraphs), line by line. */
export function mdLines(content: string): MdLine[] {
  return content.split("\n").map((raw): MdLine => {
    const l = raw.trimEnd();
    if (!l.trim()) return { kind: "blank" };
    if (l.startsWith("# ")) return { kind: "h1", text: l.slice(2) };
    if (/^#{2,6} /.test(l)) return { kind: "h2", text: l.replace(/^#{2,6} /, "") };
    const ck = /^\s*[-*] \[( |x|X|~|!|-)\] (.*?)(?: \((.+)\)| · (.+))?$/.exec(l);
    if (ck) {
      const note = ck[3] ?? ck[4];
      return { kind: "check", state: CHECK[ck[1] ?? " "] ?? "todo", text: ck[2] ?? "", ...(note ? { note } : {}) };
    }
    if (/^\s*[-*] /.test(l)) return { kind: "li", text: l.replace(/^\s*[-*] /, "") };
    if (l.startsWith("> ")) return { kind: "quote", text: l.slice(2) };
    return { kind: "p", text: l };
  });
}

/** Lines of `next` that weren't in `prev` (a new note, a new decision): they fade in. */
export function newLineIndexes(prev: string | null | undefined, next: string): Set<number> {
  if (prev == null) return new Set();
  const before = new Map<string, number>();
  for (const l of prev.split("\n")) before.set(l, (before.get(l) ?? 0) + 1);
  const out = new Set<number>();
  next.split("\n").forEach((l, i) => {
    const n = before.get(l) ?? 0;
    if (n > 0) before.set(l, n - 1);
    else if (l.trim()) out.add(i);
  });
  return out;
}

/** The small diff of an edit found on the machine ("- …" / "+ …" lines). */
export function editDiff(diff: string | undefined): { kind: "add" | "del"; text: string }[] {
  return (diff ?? "")
    .split("\n")
    .filter((l) => l.startsWith("- ") || l.startsWith("+ "))
    .map((l) => ({ kind: l.startsWith("+") ? ("add" as const) : ("del" as const), text: l.slice(2) }));
}

/**
 * The repository a mission's findings point into: the agent's GitHub entry
 * named like the mission's folder, else its only repository (never a whole
 * account). Null when unknown.
 */
export function findingsRepo(repos: string[] | undefined, repoDir: string): string | null {
  const list = (repos ?? []).filter((r) => !r.endsWith("/*") && r.includes("/"));
  const folder =
    repoDir
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase() ?? "";
  const named = list.find((r) => r.split("/")[1]?.toLowerCase() === folder);
  return named ?? (list.length === 1 ? (list[0] ?? null) : null);
}

/**
 * Where a finding's ref opens (`ReviewPrompt.swift:41`, `src/a.ts:12`, a
 * link): a link as is; a path with a line in the repository (a bare file
 * name: GitHub's code search in it). Null when there is nowhere to go.
 */
export function findingRefUrl(ref: string, repo: string | null): string | null {
  if (/^https?:\/\//i.test(ref)) return ref;
  if (!repo) return null;
  const m = /^([\w./@-]+\.[\w]+)(?::(\d+))?(?:-\d+)?$/.exec(ref.trim());
  if (!m?.[1]) return null;
  const path = m[1].replace(/^\.?\//, "");
  if (!path.includes("/")) {
    return `https://github.com/search?q=${encodeURIComponent(`repo:${repo} path:${path}`)}&type=code`;
  }
  return `https://github.com/${repo}/blob/HEAD/${path}${m[2] ? `#L${m[2]}` : ""}`;
}
