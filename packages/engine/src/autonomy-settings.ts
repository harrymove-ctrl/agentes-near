/**
 * An agent's autonomy settings (ADR 0131), apart from the brakes so the prompt's team list reads them without the
 * engine's message paths.
 */

/** A costly step: opening a PR or MR, installing packages, a long run (`LONG_STEPS` tool calls and more). */
export type CostKind = "pr" | "install" | "long";
export const COST_KINDS: readonly CostKind[] = ["pr", "install", "long"];

/** Tool calls an unrequested run makes before going on needs a go (`long`). */
export const LONG_STEPS = 40;

export interface AutonomySettings {
  /** Costly work nobody asked for directly: `ask` proposes it first, `go` does it. */
  costly: "ask" | "go";
  /** Kinds a person said "always" to (no proposal) and "never" to (refused). */
  go: CostKind[];
  never: CostKind[];
  /** Unrequested runs it may have at once. */
  maxUnrequested: number;
  /** PRs its unrequested work may open in an hour. */
  maxPrsPerHour: number;
  /** Which agents it may wake or hand work to. */
  callAgents: "all" | "some" | "none";
  callAgentIds: string[];
  /** Its project (a repository, a product): agents of different projects don't call each other unless allowed. */
  project: string;
  otherProjects: boolean;
}

/**
 * Open by default (agents act on their own and call each other, admins narrow it): costly work nobody asked for goes
 * ahead and any agent may call any other. Projects split agents only once a person sets them (`otherProjects` reads
 * only then). The caps on parallel unrequested runs and PRs an hour stay: they stop a runaway, they forbid nothing.
 */
export const AUTONOMY_DEFAULTS: AutonomySettings = {
  costly: "go",
  go: [],
  never: [],
  maxUnrequested: 2,
  maxPrsPerHour: 3,
  callAgents: "all",
  callAgentIds: [],
  project: "",
  otherProjects: false,
};

const kinds = (v: unknown) =>
  Array.isArray(v) ? [...new Set(v.filter((k): k is CostKind => COST_KINDS.includes(k as CostKind)))] : [];
const count = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/** An agent's stored `autonomy` read with the defaults; anything malformed is the default. */
export function autonomySettings(raw: unknown): AutonomySettings {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = AUTONOMY_DEFAULTS;
  return {
    costly: r.costly === "ask" ? "ask" : "go",
    go: kinds(r.go),
    never: kinds(r.never),
    maxUnrequested: count(r.maxUnrequested, 1, 20, d.maxUnrequested),
    maxPrsPerHour: count(r.maxPrsPerHour, 0, 50, d.maxPrsPerHour),
    callAgents: r.callAgents === "some" || r.callAgents === "none" ? r.callAgents : "all",
    callAgentIds: Array.isArray(r.callAgentIds)
      ? [...new Set(r.callAgentIds.filter((id): id is string => typeof id === "string"))].slice(0, 200)
      : [],
    project: typeof r.project === "string" ? r.project.trim().slice(0, 80) : "",
    otherProjects: r.otherProjects === true,
  };
}

/**
 * What to store for settings a person set (`raw`): only the fields it holds, each normalized. A field nobody chose
 * stays out, so it follows `AUTONOMY_DEFAULTS` when they change instead of keeping the default of the day it was saved.
 */
export function chosenAutonomy(raw: Record<string, unknown>): Partial<AutonomySettings> {
  const all = autonomySettings(raw);
  return Object.fromEntries(Object.entries(all).filter(([k]) => raw[k] !== undefined));
}

/**
 * Whether two agents are a supervisor and its report, either way round ("Responde a", ADR 0148 addendum): they may
 * always call each other, whatever their lists say. Who may talk to an agent (its audience) still applies.
 */
export const inLine = (
  a: { id: string; reportsToAgentId?: string | null },
  b: { id: string; reportsToAgentId?: string | null },
) => a.reportsToAgentId === b.id || b.reportsToAgentId === a.id;

/** Whether an agent with `from` settings may wake or hand work to `to` (§8): its list, and other projects. */
export function mayCall(from: unknown, to: { id: string; autonomy: unknown }): boolean {
  const f = autonomySettings(from);
  if (f.callAgents === "none") return false;
  if (f.callAgents === "some" && !f.callAgentIds.includes(to.id)) return false;
  const t = autonomySettings(to.autonomy);
  return f.otherProjects || !f.project || !t.project || f.project === t.project;
}
