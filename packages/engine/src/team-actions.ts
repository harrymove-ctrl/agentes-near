import { simpleCommands } from "@agenteschat/adapters";
import {
  and,
  arrayOverlaps,
  type Database,
  desc,
  type Executor,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  or,
  schema,
} from "@agenteschat/db";
import { caches } from "./cache";
import { agentSearchChannels, enqueueIndex, registerDocumentBuilder, registerReindexSource } from "./search";
import { maskCredentials } from "./tool-detail";
import { toolKind } from "./tools/run-policy";
import type { ToolDefinition } from "./tools/types";
import { untrustedBlock } from "./untrusted";
import { isPersonalWorkspace } from "./workspace-mode";

const { teamActions, teamActionChecks, organizationSettings, agents, channels } = schema;
type TeamActionMatch = schema.TeamActionMatch;

/**
 * Team actions (ADR 0064): what agents did outside the organization becomes a
 * short searchable record, and before the next outside action on the same
 * target the agent is told once. Nothing of it goes into prompts.
 */

/** How far back an earlier action counts. */
export const TEAM_ACTION_WINDOW_MS = 30 * 24 * 3600_000;
const MAX_TARGETS = 10;
const MAX_MATCHES = 3;
const SUMMARY_CHARS = 300;

// ── What counts ───────────────────────────────────────────────────────────

/** Built-in tools that act outside though the policy table files them as internal work. */
const OUTSIDE_BY_NAME = new Set(["open_pull_request"]);

/**
 * Whether a call of this tool acts outside the organization: a connected app's write (the policy's
 * `external`) or a built-in that leaves it. A mailbox counts only when it sends: moving, labelling or
 * deleting mail touches nobody outside.
 */
export function isOutsideTool(tool: Pick<ToolDefinition, "name" | "scope" | "connectionId" | "sensitive">): boolean {
  if (OUTSIDE_BY_NAME.has(tool.name)) return true;
  if (tool.scope.startsWith("mail:")) return tool.scope === "mail:send";
  return toolKind(tool).kind === "external";
}

// ── Targets ───────────────────────────────────────────────────────────────

const EMAIL = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const URL_START = /^https?:\/\//i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Free text: what is written, not who it goes to (an email's body may name anyone). */
const TEXT_KEYS = /^(body|text|content|message|html|description|prompt|comment|notes?|title|subject|summary|why)$/i;
/** Whose it is, not where it goes. */
const SENDER_KEYS = /^(from|sender|reply_?to|author)$/i;
const PHONE_KEYS = /(phone|whatsapp|mobile|tel|^to$|^number$|^recipient)/i;
const NUMBER_KEYS = /^(number|issue_number|pull_number|pr|pr_number|issue)$/i;
const BRANCH_KEYS = /^(branch|head|head_branch)$/i;
const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "trunk", "head"]);

const normalEmail = (s: string) => `email:${s.trim().toLowerCase()}`;

function normalUrl(s: string): string | null {
  try {
    const u = new URL(s.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const path = u.pathname.replace(/\/+$/, "");
    return `url:${u.host.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

/** Digits with the country code; Brazil when a 10–11 digit number has none. */
function normalPhone(s: string): string | null {
  if (!/^[+()\d\s.-]{8,24}$/.test(s.trim())) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  const full = !s.trim().startsWith("+") && (digits.length === 10 || digits.length === 11) ? `55${digits}` : digits;
  return `phone:+${full}`;
}

const repoOf = (s: unknown) => (typeof s === "string" && REPO.test(s.trim()) ? s.trim().toLowerCase() : null);
const branchTarget = (repo: string | null, branch: string) => {
  const b = branch.replace(/^refs\/heads\//, "").trim();
  if (!b || DEFAULT_BRANCHES.has(b.toLowerCase())) return null;
  return repo ? `github:${repo}@${b}` : `branch:${b}`;
};

/**
 * The identifiers a call's input touches (ADR 0064 §2): addresses, phone numbers, URLs and GitHub
 * references, normalized. Free text (bodies, titles) is never read: a name in a message isn't who it goes to.
 */
export function callTargets(input: Record<string, unknown>, extra?: Record<string, unknown>): string[] {
  const out = new Set<string>();
  let seen = 0;
  const visit = (value: unknown, key: string, depth: number) => {
    if (out.size >= MAX_TARGETS || seen > 200 || depth > 4) return;
    if (TEXT_KEYS.test(key) || SENDER_KEYS.test(key)) return;
    if (typeof value === "string") {
      seen++;
      if (value.length > 2000) return;
      for (const part of value.split(/[,;]\s*/)) {
        const s = part.trim().replace(/^.*<([^>]+)>$/, "$1");
        if (!s) continue;
        if (EMAIL.test(s)) out.add(normalEmail(s));
        else if (URL_START.test(s)) {
          const u = normalUrl(s);
          if (u) out.add(u);
        } else if (PHONE_KEYS.test(key)) {
          const p = normalPhone(s);
          if (p) out.add(p);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) visit(v, key, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      // A GitHub repository with an issue, a pull request or a branch.
      const repo =
        repoOf(o.repo) ??
        repoOf(o.repository) ??
        (typeof o.owner === "string" && typeof o.repo === "string" ? repoOf(`${o.owner}/${o.repo}`) : null);
      if (repo) {
        for (const [k, v] of Object.entries(o)) {
          if (NUMBER_KEYS.test(k) && (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v))))
            out.add(`github:${repo}#${v}`);
          if (BRANCH_KEYS.test(k) && typeof v === "string") {
            const b = branchTarget(repo, v);
            if (b) out.add(b);
          }
        }
      }
      for (const [k, v] of Object.entries(o)) visit(v, k, depth + 1);
    }
  };
  visit(input, "", 0);
  // What the tool answered with (an opened pull request's number).
  const pr = extra?.pullRequest as { repo?: unknown; number?: unknown } | undefined;
  const repo = repoOf(pr?.repo);
  if (repo && typeof pr?.number === "number") out.add(`github:${repo}#${pr.number}`);
  return [...out].slice(0, MAX_TARGETS);
}

/** A target as people and models read it (`email:a@b.com` → `a@b.com`). */
export const shownTarget = (t: string) => t.replace(/^(email|phone|url|github|branch):/, "");

// ── Computer commands ─────────────────────────────────────────────────────

const GH_WRITES: Record<string, ReadonlySet<string>> = {
  pr: new Set(["create", "comment", "merge", "close", "edit", "review", "ready", "reopen"]),
  issue: new Set(["create", "comment", "close", "edit", "reopen", "transfer"]),
  release: new Set(["create", "edit", "upload"]),
};
const SENDS_DATA = /^(-d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form|--json|-T|--upload-file)(=.*)?$/;

const flag = (argv: string[], names: string[]) => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    for (const n of names) {
      if (a === n) return argv[i + 1] ?? null;
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return null;
};

/** git's subcommand, past its own options (`git -C dir -c k=v push …` → `push`). */
function gitVerb(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree") i++;
    else if (!a.startsWith("-")) return a;
  }
  return null;
}

/**
 * A computer command that acts outside (ADR 0064 §1): `gh` writes, `git push`, a `curl`/`wget`/`http`
 * that sends. Null for everything else, and for a line we can't follow.
 */
export function commandAction(
  toolName: string,
  input: Record<string, unknown>,
): { tool: string; targets: string[]; command: string } | null {
  if (toolName !== "Bash") return null;
  const command = typeof input.command === "string" ? input.command.trim() : "";
  const parts = command ? simpleCommands(command) : null;
  if (!parts) return null;
  for (const { argv } of parts) {
    const [bin, sub, verb] = argv;
    const name = (bin ?? "").split("/").pop() ?? "";
    if (name === "git" && gitVerb(argv) === "push") {
      const args = argv.slice(argv.indexOf("push") + 1).filter((a) => !a.startsWith("-"));
      const ref = args[1]?.split(":").pop() ?? "";
      const b = ref ? branchTarget(null, ref) : null;
      return { tool: "git push", targets: b ? [b] : [], command };
    }
    if (name === "gh" && sub && verb && GH_WRITES[sub]?.has(verb)) {
      const repo = repoOf(flag(argv, ["-R", "--repo"]));
      const targets: string[] = [];
      const num = argv.slice(3).find((a) => /^#?\d+$/.test(a));
      if (repo && num) targets.push(`github:${repo}#${num.replace("#", "")}`);
      const head = flag(argv, ["-H", "--head"]);
      const b = head ? branchTarget(repo, head) : null;
      if (b) targets.push(b);
      return { tool: `gh ${sub} ${verb}`, targets, command };
    }
    if (name === "gh" && sub === "api") {
      const method = (flag(argv, ["-X", "--method"]) ?? "").toUpperCase();
      const fields = argv.some((a) => /^(-f|-F|--field|--raw-field|--input)(=.*)?$/.test(a));
      if ((method && method !== "GET") || (!method && fields)) return { tool: "gh api", targets: [], command };
    }
    if (name === "curl" || name === "wget" || name === "http" || name === "https") {
      const method = (flag(argv, ["-X", "--request", "--method"]) ?? "").toUpperCase();
      const httpie = (name === "http" || name === "https") && /^(POST|PUT|PATCH|DELETE)$/i.test(sub ?? "");
      const sends =
        httpie ||
        (method !== "" && method !== "GET" && method !== "HEAD") ||
        argv.some((a) => SENDS_DATA.test(a)) ||
        (name === "wget" && argv.some((a) => /^--post-(data|file)(=.*)?$/.test(a)));
      if (!sends) continue;
      const targets = argv.flatMap((a) => (URL_START.test(a) ? [normalUrl(a)].filter((u): u is string => !!u) : []));
      return { tool: name === "https" ? "http" : name, targets: targets.slice(0, MAX_TARGETS), command };
    }
  }
  return null;
}

// ── The switch ────────────────────────────────────────────────────────────

/** Whether this org's agents check before acting (the workspace switch; on when never set). */
export async function actionCheckOn(db: Executor, orgId: string): Promise<boolean> {
  return caches.orgs.getOrLoad(`${orgId}:action-check`, async () => {
    const [row] = await db
      .select({ on: organizationSettings.actionCheck })
      .from(organizationSettings)
      .where(eq(organizationSettings.orgId, orgId));
    return row?.on ?? true;
  }) as Promise<boolean>;
}

// ── Recording ─────────────────────────────────────────────────────────────

export interface TeamActionInput {
  orgId: string;
  agentId: string;
  runId: string | null;
  channelId: string | null;
  source: "tool" | "approval" | "command";
  tool: string;
  summary: string;
  targets: string[];
  reason?: string | null;
  ref?: string | null;
}

/** Records one outside action and queues it for search. Never throws into the tool call that made it. */
export async function recordTeamAction(db: Database, input: TeamActionInput): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(teamActions)
        .values({
          orgId: input.orgId,
          agentId: input.agentId,
          runId: input.runId || null,
          channelId: input.channelId || null,
          source: input.source,
          tool: input.tool.slice(0, 120),
          summary: maskCredentials(input.summary).slice(0, SUMMARY_CHARS),
          targets: [...new Set(input.targets)].slice(0, MAX_TARGETS),
          reason: input.reason ? input.reason.slice(0, 500) : null,
          ref: input.ref ?? null,
        })
        .returning({ id: teamActions.id });
      if (row) await enqueueIndex(tx, { orgId: input.orgId, kind: "action", sourceId: row.id });
    });
  } catch {
    // The action already happened; a missing record only means one less notice later.
  }
}

/** A person said no to a command that was waiting for them: it never happened. */
export async function forgetPendingCommand(db: Database, orgId: string, ref: string): Promise<void> {
  const gone = await db
    .delete(teamActions)
    .where(and(eq(teamActions.orgId, orgId), eq(teamActions.ref, ref)))
    .returning({ id: teamActions.id })
    .catch(() => []);
  for (const r of gone) await enqueueIndex(db, { orgId, kind: "action", sourceId: r.id }).catch(() => {});
}

/**
 * One line about a call for people and search: the app (its name when it has one, else the tool's) and
 * what it was about, never its body.
 */
export function summarizeCall(tool: Pick<ToolDefinition, "name" | "connectorLabel">, input: Record<string, unknown>) {
  const about = ["subject", "title", "name"]
    .map((k) => input[k])
    .find((v): v is string => typeof v === "string" && v.trim() !== "");
  const label = tool.connectorLabel || tool.name;
  return about ? `${label} · ${about.trim().replace(/\s+/g, " ")}` : label;
}

// ── The check ─────────────────────────────────────────────────────────────

export type TeamCheck = { proceed: true; reason: string | null } | { proceed: false; notice: string; checkId: string };

const GO: TeamCheck = { proceed: true, reason: null };

/**
 * Before an outside call (ADR 0064 §4). Goes on when the switch is off, the call has no target, nothing in
 * the last 30 days matches, or this run was already told about these targets (the agent decided to go on:
 * its `why`, if any, is kept). Otherwise the call is held once and the agent gets one line.
 */
export async function checkTeamAction(
  db: Database,
  ctx: { orgId: string; agentId: string; runId: string; channelId: string },
  call: { tool: string; targets: string[]; why?: string | null },
  now = new Date(),
): Promise<TeamCheck> {
  if (!ctx.runId || call.targets.length === 0) return GO;
  if (!(await actionCheckOn(db, ctx.orgId))) return GO;
  const told = await db
    .update(teamActionChecks)
    .set({ outcome: "repeated", reason: call.why?.slice(0, 500) || null })
    .where(
      and(
        eq(teamActionChecks.orgId, ctx.orgId),
        eq(teamActionChecks.runId, ctx.runId),
        arrayOverlaps(teamActionChecks.targets, call.targets),
      ),
    )
    .returning({ id: teamActionChecks.id });
  if (told.length > 0) return { proceed: true, reason: call.why?.trim() || "went on after the notice" };
  const rows = await db
    .select()
    .from(teamActions)
    .where(
      and(
        eq(teamActions.orgId, ctx.orgId),
        arrayOverlaps(teamActions.targets, call.targets),
        gt(teamActions.createdAt, new Date(now.getTime() - TEAM_ACTION_WINDOW_MS)),
        or(isNull(teamActions.runId), ne(teamActions.runId, ctx.runId)),
      ),
    )
    .orderBy(desc(teamActions.createdAt))
    .limit(MAX_MATCHES);
  if (rows.length === 0) return GO;
  const visible = new Set(await agentSearchChannels(db, ctx.orgId, ctx.agentId, ctx.channelId));
  const matches: TeamActionMatch[] = rows.map((r) => {
    const shown = r.agentId === ctx.agentId || (r.channelId !== null && visible.has(r.channelId));
    return {
      actionId: r.id,
      agentId: shown ? r.agentId : null,
      tool: shown ? r.tool : null,
      summary: shown ? r.summary : null,
      channelId: shown ? r.channelId : null,
      targets: r.targets.filter((t) => call.targets.includes(t)),
      at: r.createdAt.toISOString(),
    };
  });
  const [check] = await db
    .insert(teamActionChecks)
    .values({
      orgId: ctx.orgId,
      runId: ctx.runId,
      agentId: ctx.agentId,
      tool: call.tool.slice(0, 120),
      targets: call.targets,
      matches,
    })
    .returning({ id: teamActionChecks.id });
  const names = await namesOf(db, ctx.orgId, matches);
  return {
    proceed: false,
    checkId: check?.id ?? "",
    notice: teamNoticeText(matches, names, ctx.agentId, now, await isPersonalWorkspace(db, ctx.orgId)),
  };
}

async function namesOf(db: Executor, orgId: string, matches: TeamActionMatch[]) {
  const agentIds = [...new Set(matches.flatMap((m) => (m.agentId ? [m.agentId] : [])))];
  const channelIds = [...new Set(matches.flatMap((m) => (m.channelId ? [m.channelId] : [])))];
  const [agentRows, channelRows] = await Promise.all([
    agentIds.length
      ? db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)))
      : [],
    channelIds.length
      ? db
          .select({ id: channels.id, name: channels.name, kind: channels.kind })
          .from(channels)
          .where(and(eq(channels.orgId, orgId), inArray(channels.id, channelIds)))
      : [],
  ]);
  return {
    agents: new Map(agentRows.map((a) => [a.id, a.name])),
    channels: new Map(channelRows.map((c) => [c.id, c.kind === "channel" ? `#${c.name}` : "a direct conversation"])),
  };
}

function ago(at: string, now: Date) {
  const min = Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * The one line the agent gets (English, like every prompt); summaries are outside text, so they go in the envelope.
 * `personal`: a personal workspace's (ADR 0159), where one person and their agents act, not a team.
 */
export function teamNoticeText(
  matches: TeamActionMatch[],
  names: { agents: Map<string, string>; channels: Map<string, string> },
  selfId: string,
  now = new Date(),
  personal = false,
): string {
  const lines = matches.map((m) => {
    const on = m.targets.map(shownTarget).join(", ");
    if (!m.agentId) {
      const someone = personal ? "Someone" : "Someone on the team";
      return `- ${someone} already acted on ${on} ${ago(m.at, now)} (in a conversation you can't see).`;
    }
    const other = personal ? "Another agent" : "A teammate";
    const who = m.agentId === selfId ? "You" : (names.agents.get(m.agentId) ?? other);
    const where = m.channelId ? ` in ${names.channels.get(m.channelId) ?? "another conversation"}` : "";
    const what = m.summary ? `: ${untrustedBlock("team action", m.summary, SUMMARY_CHARS)}` : ".";
    return `- ${who} already acted on ${on} ${ago(m.at, now)}${where}${what}`;
  });
  return [
    personal ? "Not done: this was already done." : "Not done: the team already did this.",
    ...lines,
    "Don't repeat it. If it's still needed (a follow-up, a correction, an answer to a reply), call it again with a `why` saying why. Say in your reply what you didn't do and why.",
  ].join("\n");
}

// ── On the reply ──────────────────────────────────────────────────────────

/** What the app shows under the reply: an outside action the agent didn't repeat, and whose it found. */
export interface TeamCheckView {
  id: string;
  tool: string;
  targets: string[];
  matches: {
    agentId: string | null;
    agentName: string | null;
    channelId: string | null;
    channelName: string | null;
    summary: string | null;
    at: string;
  }[];
}

/** The run's held checks not yet on a message, as the reply's `meta.teamChecks` (the server writes it). */
export async function runChecksForReply(db: Executor, orgId: string, runId: string): Promise<TeamCheckView[]> {
  const rows = await db
    .select()
    .from(teamActionChecks)
    .where(
      and(
        eq(teamActionChecks.orgId, orgId),
        eq(teamActionChecks.runId, runId),
        isNull(teamActionChecks.messageId),
        eq(teamActionChecks.outcome, "held"),
      ),
    );
  if (rows.length === 0) return [];
  const names = await namesOf(
    db,
    orgId,
    rows.flatMap((r) => r.matches),
  );
  return rows.map((r) => ({
    id: r.id,
    tool: r.tool,
    targets: r.targets.map(shownTarget),
    matches: r.matches.map((m) => ({
      agentId: m.agentId,
      agentName: m.agentId ? (names.agents.get(m.agentId) ?? null) : null,
      channelId: m.channelId,
      channelName: m.channelId ? (names.channels.get(m.channelId)?.replace(/^#/, "") ?? null) : null,
      summary: m.summary,
      at: m.at,
    })),
  }));
}

/** These checks are on this message now. */
export async function linkRunChecks(db: Executor, orgId: string, ids: string[], messageId: string) {
  if (ids.length === 0) return;
  await db
    .update(teamActionChecks)
    .set({ messageId })
    .where(and(eq(teamActionChecks.orgId, orgId), inArray(teamActionChecks.id, ids)));
}

// ── Search ────────────────────────────────────────────────────────────────

registerDocumentBuilder("action", async (db, orgId, id) => {
  const [a] = await db
    .select()
    .from(teamActions)
    .where(and(eq(teamActions.orgId, orgId), eq(teamActions.id, id)));
  // No channel = nobody's to read (an empty list would mean the whole org).
  if (!a?.channelId) return null;
  return {
    orgId,
    kind: "action",
    sourceId: a.id,
    channelIds: [a.channelId],
    title: a.tool,
    body: [a.summary, ...a.targets.map(shownTarget)].join("\n"),
    createdAt: a.createdAt,
  };
});

registerReindexSource("action", async (db, orgId) =>
  (await db.select({ id: teamActions.id }).from(teamActions).where(eq(teamActions.orgId, orgId))).map((r) => r.id),
);
