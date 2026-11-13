import { and, type Database, eq, schema } from "@agenteschat/db";
import { getAgent } from "../agents";
import { recordAudit } from "../audit";
import { caches } from "../cache";
import { NotFoundError, ValidationError } from "../errors";
import type { MachineCaller } from "../machine-hub";
import { requirePermission } from "../organizations";
import { requireComputerManager } from "../sandbox";
import { agentBrowserStatus, type BrowserUnavailable } from "./tools";

const { agents } = schema;

/** At most this many sites in an agent's browser allowlist. */
export const MAX_BROWSER_DOMAINS = 50;
/** `example.com` or `*.example.com` (the wildcard also matches the bare domain, as in `agent-browser`). */
const DOMAIN = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,63}$/;

/** `GET …/agents/{id}/browser`: what the agent page shows about its browser. */
export interface AgentBrowserView {
  /** Sites the browser may open; null = any site. */
  allowedDomains: string[] | null;
  available: boolean;
  /** Why not, as a code for the app (null when available). */
  reason: BrowserUnavailable | null;
  /** The runner's own words when it isn't ready ("Chrome's libraries are missing…"). */
  detail: string | null;
  machine: { id: string; name: string } | null;
  /** Its default browser: a shared profile it may use (ADR 0110); null = its own. */
  profileId: string | null;
}

/** The agent's browser settings and whether its computer can serve the browser (every member may look). */
export async function getAgentBrowser(
  db: Database,
  hub: MachineCaller | undefined,
  actorId: string,
  orgId: string,
  agentId: string,
): Promise<AgentBrowserView> {
  await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  const status = await agentBrowserStatus(db, hub, orgId, agentId);
  const machine = status.machineId && status.machineName ? { id: status.machineId, name: status.machineName } : null;
  return {
    allowedDomains: agent.browserAllowedDomains ?? null,
    available: status.available,
    reason: status.available ? null : status.code,
    detail: status.available ? null : status.detail,
    machine,
    profileId: agent.browserProfileId ?? null,
  };
}

/** Cleans an allowlist: trimmed, lowercase, no duplicates; refuses anything that isn't a domain. */
export function cleanBrowserDomains(domains: string[]): string[] {
  const clean = [
    ...new Set(
      domains.map((d) =>
        d
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, ""),
      ),
    ),
  ].filter(Boolean);
  if (clean.length > MAX_BROWSER_DOMAINS) throw new ValidationError(`At most ${MAX_BROWSER_DOMAINS} sites`);
  const bad = clean.find((d) => !DOMAIN.test(d));
  if (bad) throw new ValidationError(`Not a site: ${bad}`);
  return clean;
}

/**
 * Sets the sites the agent's browser may open (ADR 0040 §4): null or an empty
 * list = any site. The agent's owner or an admin. Applies from the next
 * command (each `browser.act` carries it).
 */
export async function setAgentBrowserDomains(
  db: Database,
  hub: MachineCaller | undefined,
  actorId: string,
  orgId: string,
  agentId: string,
  domains: string[] | null,
): Promise<AgentBrowserView> {
  await requireComputerManager(db, actorId, orgId, agentId);
  const clean = domains === null ? null : cleanBrowserDomains(domains);
  const value = clean && clean.length > 0 ? clean : null;
  const [updated] = await db
    .update(agents)
    .set({ browserAllowedDomains: value, updatedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .returning({ id: agents.id });
  if (!updated) throw new NotFoundError("Agent not found");
  caches.agents.delete(`${orgId}:${agentId}`);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "agent.browser_domains_changed",
    target: { type: "agent", id: agentId },
    details: { domains: value },
  });
  return getAgentBrowser(db, hub, actorId, orgId, agentId);
}
