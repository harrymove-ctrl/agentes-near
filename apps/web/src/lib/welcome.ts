import { storage } from "./storage";

export * from "@agenteschat/client/lib/welcome";

/**
 * The channel's sky band: on the first visit of a new day to a workspace, the
 * first channel you open greets you and says what its agents did since your
 * last visit. Visits are kept per workspace in localStorage.
 */
const KEY = "agentes.welcome";

type Visits = Record<string, number>;

function readVisits(): Visits {
  try {
    const raw = JSON.parse(storage.get(KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Visits) : {};
  } catch {
    return {};
  }
}

/** When I last opened this workspace (ms), or null the first time. */
export function lastVisit(orgId: string): number | null {
  const at = readVisits()[orgId];
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

export function markVisit(orgId: string, now = Date.now()) {
  storage.set(KEY, JSON.stringify({ ...readVisits(), [orgId]: now }));
}
