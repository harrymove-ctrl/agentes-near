/**
 * "Computador desconectado": when the computer that runs some agents' brain
 * (Claude Code / Codex) goes offline, the app says so once (a notice), each waiting agent says what it waits
 * for, and "Trocar computador" moves the agents to another computer that can run their brain. Pure helpers
 * shared by the web and the phone app: the notice's inputs, the waiting counts, which targets the switch
 * offers, the switch's result and the chat's waiting card.
 *
 * The shapes here are structural (only the fields read), so the API types of
 * `GET …/machines/outages` and `POST …/machines/{id}/move-agents` fit them as they are.
 */

/** The brains a computer runs. */
export type ComputerBrain = "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";

export interface OutageAgentLike {
  agentId: string;
  name: string;
  brain: ComputerBrain;
  waiting: { routines: number; conversations: number };
}

export interface OutageLike {
  machineId: string;
  name: string;
  platform: string;
  /** The workspace's own computer (ADR 0056 §10). */
  managed?: boolean;
  offlineSince: string;
  agents: readonly OutageAgentLike[];
  waitingRuns: number;
}

export type OutageTargetLike = {
  kind: "machine";
  machineId: string;
  name: string;
  platform: string;
  /** The workspace's own computer (ADR 0056 §10). */
  managed?: boolean;
  online: boolean;
  brains: readonly ComputerBrain[];
  /** "offline" | "paused" | null. */
  reasonOff: string | null;
};

/** What `move-agents` takes as `target`. */
export type MoveTarget = { kind: "machine"; machineId: string };

export interface MoveResultLike {
  moved: readonly string[];
  skipped: readonly { agentId: string; reason: string }[];
  resumed: number;
  stillWaiting: number;
}

// ── Counts and wording inputs ───────────────────────────────────────────────

/** How many tasks an agent has waiting for the computer. */
export const agentWaitingTotal = (a: Pick<OutageAgentLike, "waiting">) =>
  Math.max(0, a.waiting.routines) + Math.max(0, a.waiting.conversations);

/** The tasks waiting for a computer: the server's count, else the agents' sum. */
export function outageTaskCount(o: Pick<OutageLike, "waitingRuns" | "agents">): number {
  if (o.waitingRuns > 0) return o.waitingRuns;
  return o.agents.reduce((n, a) => n + agentWaitingTotal(a), 0);
}

/**
 * What an agent's waiting line counts ("2 rotinas esperando", "1 conversa esperando", "3 tarefas esperando"):
 * routines or conversations when only one kind waits, tasks when both do; null when nothing waits.
 */
export function agentWaitingPhrase(
  a: Pick<OutageAgentLike, "waiting">,
): { kind: "routines" | "conversations" | "tasks"; count: number } | null {
  const r = Math.max(0, a.waiting.routines);
  const c = Math.max(0, a.waiting.conversations);
  if (r === 0 && c === 0) return null;
  if (c === 0) return { kind: "routines", count: r };
  if (r === 0) return { kind: "conversations", count: c };
  return { kind: "tasks", count: r + c };
}

/** Names as a list's parts: the first two and how many more ("Ada e Theo", "Ada, Theo e mais 2"). */
export function namesParts(names: readonly string[]): { first: string; second: string | null; more: number } {
  return { first: names[0] ?? "", second: names[1] ?? null, more: Math.max(0, names.length - 2) };
}

/** The notice of one outage: the computer, who waits for it (names) and how many tasks. */
export function outageNotice(o: OutageLike) {
  return {
    machineId: o.machineId,
    computer: o.name,
    platform: o.platform,
    agents: namesParts(o.agents.map((a) => a.name)),
    agentIds: o.agents.map((a) => a.agentId),
    tasks: outageTaskCount(o),
  };
}

/** Each agent waiting for an offline computer → that computer (the first outage that lists it). */
export function waitingComputerByAgent(
  outages: readonly Pick<OutageLike, "machineId" | "name" | "agents">[] | null | undefined,
): Map<string, { machineId: string; name: string }> {
  const out = new Map<string, { machineId: string; name: string }>();
  for (const o of outages ?? [])
    for (const a of o.agents) if (!out.has(a.agentId)) out.set(a.agentId, { machineId: o.machineId, name: o.name });
  return out;
}

/** The outages worth a notice: some agent waits for the computer (newest outage first). */
export function visibleOutages<T extends Pick<OutageLike, "agents" | "offlineSince">>(
  outages: readonly T[] | null | undefined,
): T[] {
  return (outages ?? [])
    .filter((o) => o.agents.length > 0)
    .sort((a, b) => Date.parse(b.offlineSince) - Date.parse(a.offlineSince));
}

// ── Where to (the switch's targets) ─────────────────────────────────────────

/** Why a target can't take the agents now. Server reasons (`reasonOff`) pass through as they are. */
export type TargetOffReason = "offline" | "missing_brain" | (string & {});

export interface TargetOption {
  key: string;
  target: MoveTarget;
  name: string;
  platform: string;
  /** The workspace's own computer (ADR 0056 §10). */
  managed: boolean;
  online: boolean;
  brains: ComputerBrain[];
  enabled: boolean;
  reason: TargetOffReason | null;
  /** The brain it lacks, when that is the reason. */
  missing: ComputerBrain | null;
}

/** The brains the chosen agents need. */
export function brainsNeeded(o: Pick<OutageLike, "agents">, agentIds: Iterable<string>): ComputerBrain[] {
  const ids = new Set(agentIds);
  const out: ComputerBrain[] = [];
  for (const a of o.agents) if (ids.has(a.agentId) && !out.includes(a.brain)) out.push(a.brain);
  return out;
}

/**
 * "Para onde", as on the web: every other computer, the usable ones first; one that can't take the chosen
 * agents now stays, disabled, with the reason: offline, a server reason ("paused"), or the brain it lacks.
 */
export function targetOptions(
  o: Pick<OutageLike, "machineId" | "agents">,
  targets: readonly OutageTargetLike[] | null | undefined,
  agentIds: Iterable<string>,
): TargetOption[] {
  const all = new Set(o.agents.map((a) => a.brain));
  const need = brainsNeeded(o, agentIds);
  // With nobody checked, a target is measured against everyone (the button is off anyway).
  const wanted = need.length > 0 ? need : [...all];
  const out: TargetOption[] = [];
  for (const t of targets ?? []) {
    if (t.machineId === o.machineId) continue;
    const missing = wanted.find((b) => !t.brains.includes(b)) ?? null;
    const reason: TargetOffReason | null = !t.online
      ? "offline"
      : t.reasonOff
        ? t.reasonOff
        : missing
          ? "missing_brain"
          : null;
    out.push({
      key: `m:${t.machineId}`,
      target: { kind: "machine", machineId: t.machineId },
      name: t.name,
      platform: t.platform,
      managed: t.managed === true,
      online: t.online,
      brains: [...t.brains],
      enabled: reason === null,
      reason,
      missing: reason === "missing_brain" ? missing : null,
    });
  }
  // Usable first.
  const rank = (x: TargetOption) => (x.enabled ? 0 : 1);
  return out
    .map((x, i) => ({ x, i }))
    .sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i)
    .map(({ x }) => x);
}

/** The option chosen at first: the first usable one, else none. */
export const defaultTargetKey = (options: readonly TargetOption[]) => options.find((x) => x.enabled)?.key ?? null;

/** The chosen key, kept only while it is still usable; else the default. */
export function pickedTargetKey(options: readonly TargetOption[], picked: string | null): string | null {
  if (picked && options.some((x) => x.key === picked && x.enabled)) return picked;
  return defaultTargetKey(options);
}

// ── The switch's result ─────────────────────────────────────────────────────

/** What the toast says after "Trocar": how many moved, how many tasks resumed, what still waits. */
export function moveOutcome(r: MoveResultLike) {
  return {
    moved: r.moved.length,
    skipped: r.skipped.length,
    resumed: Math.max(0, r.resumed),
    stillWaiting: Math.max(0, r.stillWaiting),
    tone: r.moved.length === 0 ? ("none" as const) : r.skipped.length > 0 ? ("partial" as const) : ("done" as const),
  };
}

// ── The chat's waiting card ─────────────────────────────────────────────────

/** `meta.brainUnavailable` of a `brain_unavailable` message. */
export interface BrainUnavailableInfo {
  brain: ComputerBrain;
  code: string;
  machineId: string | null;
  agentId: string | null;
  resetsAt: string | null;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The message's `brainUnavailable` (only on body code `brain_unavailable`); null otherwise. */
export function brainUnavailableOf(meta: Record<string, unknown> | null | undefined): BrainUnavailableInfo | null {
  if (meta?.bodyCode !== "brain_unavailable") return null;
  const b = meta.brainUnavailable;
  if (!b || typeof b !== "object") return null;
  const x = b as Record<string, unknown>;
  return {
    brain:
      x.brain === "codex" ||
      x.brain === "cursor" ||
      x.brain === "opencode" ||
      x.brain === "grok" ||
      x.brain === "antigravity"
        ? x.brain
        : "claude_code",
    code: str(x.code) ?? "",
    machineId: str(x.machineId),
    agentId: str(x.agentId),
    resetsAt: str(x.resetsAt),
  };
}

/**
 * The note waits for its computer to come back (the waiting card), not for room on one that is there (`busy`) nor
 * for a plan's limit to reset: those stay the agent's own words, never "the computer is back".
 */
export const waitsForComputer = (info: Pick<BrainUnavailableInfo, "machineId" | "code"> | null) =>
  Boolean(info?.machineId) && info?.code !== "busy" && info?.code !== "plan_limit";

/**
 * Where the card stands: still waiting (the computer is in the outages and lists the agent), moved (the
 * computer is still out but the agent no longer waits for it), or back (the computer left the outages).
 * Unknown when the outages aren't loaded or the message doesn't say which computer.
 */
export type WaitCardState =
  | { kind: "waiting"; machineId: string; computer: string; waiting: OutageAgentLike | null }
  | { kind: "moved"; machineId: string; computer: string }
  | { kind: "back"; machineId: string }
  | { kind: "unknown" };

export function waitCardState(
  info: Pick<BrainUnavailableInfo, "machineId" | "agentId">,
  outages: readonly OutageLike[] | null | undefined,
  authorId: string | null,
): WaitCardState {
  if (!info.machineId || !outages) return { kind: "unknown" };
  const o = outages.find((x) => x.machineId === info.machineId);
  if (!o) return { kind: "back", machineId: info.machineId };
  const agentId = info.agentId ?? authorId;
  const agent = agentId ? (o.agents.find((a) => a.agentId === agentId) ?? null) : null;
  if (agentId && !agent) return { kind: "moved", machineId: o.machineId, computer: o.name };
  return { kind: "waiting", machineId: o.machineId, computer: o.name, waiting: agent };
}

/**
 * One card per agent and computer: of the `brain_unavailable` messages, the ones a newer message of the same
 * agent about the same computer (in the same conversation) replaces, and the ones the agent moved past (it wrote
 * anything later there: its answer). Ids to hide.
 */
export function supersededBrainNotices(
  messages: readonly {
    id: string;
    threadId: string | null;
    author: { type: string; id: string | null };
    meta?: Record<string, unknown> | null;
    createdAt: string;
  }[],
): Set<string> {
  const newest = new Map<string, { id: string; at: number }>();
  const hide = new Set<string>();
  const lastSaid = new Map<string, number>();
  for (const m of messages) {
    if (m.author.type !== "agent" || !m.author.id) continue;
    const key = `${m.threadId ?? ""}|${m.author.id}`;
    lastSaid.set(key, Math.max(lastSaid.get(key) ?? 0, Date.parse(m.createdAt)));
  }
  for (const m of messages) {
    const info = brainUnavailableOf(m.meta);
    if (!info) continue;
    const agent = info.agentId ?? (m.author.type === "agent" ? m.author.id : null);
    if (!agent) continue;
    const key = `${m.threadId ?? ""}|${agent}|${info.machineId ?? info.brain}`;
    const at = Date.parse(m.createdAt);
    if ((lastSaid.get(`${m.threadId ?? ""}|${agent}`) ?? 0) > at) hide.add(m.id);
    const prev = newest.get(key);
    if (!prev) newest.set(key, { id: m.id, at });
    else if (at >= prev.at) {
      hide.add(prev.id);
      newest.set(key, { id: m.id, at });
    } else hide.add(m.id);
  }
  return hide;
}

// ── Live ────────────────────────────────────────────────────────────────────

/** Org events after which the outages are asked again: a computer's status changed, agents were moved. */
export const isOutageEvent = (event: { type: string }) =>
  event.type === "machine.status" || event.type === "machine.agents_moved";

/** `move-agents` refusals (HTTP 409/404) the UI explains; anything else is a plain failure. */
export const MOVE_ERRORS = [
  "machine.target_offline",
  "machine.target_not_found",
  "machine.target_same",
  "machine.target_paused",
  "machine.not_found",
] as const;
export type MoveError = (typeof MOVE_ERRORS)[number];

/** The refusal's code when it is one of `MOVE_ERRORS`; null otherwise. */
export function moveErrorOf(err: unknown): MoveError | null {
  const code = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : null;
  return typeof code === "string" && (MOVE_ERRORS as readonly string[]).includes(code) ? (code as MoveError) : null;
}
