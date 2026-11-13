/**
 * Test fake — the agent browser (ADR 0040) and screen (ADR 0058), same shapes as the server's
 * `…/agents/{id}/browser`, `…/agents/{id}/desktop` and `…/browser/handoffs/*` routes. Agents start
 * without a browser or a desktop (they have no computer); tests put handoffs in
 * `fake.handoffs`, settings in `fake.settings` and desktops in `fake.desktops`.
 */
import type { AgentBrowserSettings, ApiClient, BrowserHandoff, DesktopStatus } from "@agenteschat/client";
import { ApiError, handoffScreen } from "@agenteschat/client";

export interface FakeBrowser {
  client: ApiClient["browser"];
  desktop: ApiClient["desktop"];
  settings: Map<string, AgentBrowserSettings>;
  handoffs: Map<string, BrowserHandoff>;
  /** An agent's desktop as the server would see it; its open handoff comes from `handoffs`. */
  desktops: Map<string, Partial<DesktopStatus>>;
  /** Agents whose computer this person may not watch (`GET …/desktop` answers 403). */
  forbidden: Set<string>;
  /** Agents whose screen this person may watch but not drive (`GET …/control` answers false). */
  watchOnly: Set<string>;
  /** Agents whose Chrome shows on their desktop: the desktop's state names the browser's open handoff too. */
  sameWindow: Set<string>;
}

const NO_DESKTOP: DesktopStatus = {
  available: false,
  reason: "no_desktop",
  detail: null,
  running: false,
  startedAt: null,
  controllerUserId: null,
  handoff: null,
  viewers: 0,
  canControl: false,
  held: false,
  browserOnDesktop: false,
};

const NONE: AgentBrowserSettings = {
  allowedDomains: null,
  available: false,
  reason: "no_machine",
  detail: null,
  machine: null,
};

export function createFakeBrowser(
  log: (method: string, ...args: unknown[]) => void,
  now: () => Date,
  /** Who the session is: the person who takes control. */
  me = "u-walter",
): FakeBrowser {
  const settings = new Map<string, AgentBrowserSettings>();
  const handoffs = new Map<string, BrowserHandoff>();
  const desktops = new Map<string, Partial<DesktopStatus>>();
  const forbidden = new Set<string>();
  const watchOnly = new Set<string>();
  const sameWindow = new Set<string>();
  const openOn = (agentId: string, screen: BrowserHandoff["screen"] = "browser") =>
    [...handoffs.values()].find(
      (h) => h.agentId === agentId && handoffScreen(h) === screen && (h.status === "pending" || h.status === "active"),
    ) ?? null;
  const find = (id: string) => {
    const h = handoffs.get(id);
    if (!h) throw new ApiError(404, "not_found", "Not found");
    return h;
  };
  const end = (id: string, status: BrowserHandoff["status"], note: string | null = null) => {
    const h = { ...find(id), status, note, expiresAt: null, resolvedAt: now().toISOString() };
    handoffs.set(id, h);
    return h;
  };
  const client: ApiClient["browser"] = {
    settings: async (orgId, agentId) => {
      log("browser.settings", orgId, agentId);
      return settings.get(agentId) ?? NONE;
    },
    setDomains: async (orgId, agentId, allowedDomains) => {
      log("browser.setDomains", orgId, agentId, allowedDomains);
      const next = {
        ...(settings.get(agentId) ?? NONE),
        allowedDomains: allowedDomains?.length ? allowedDomains : null,
      };
      settings.set(agentId, next);
      return next;
    },
    agentHandoff: async (orgId, agentId, screen) => {
      log("browser.agentHandoff", orgId, agentId);
      return openOn(agentId, screen);
    },
    agentControl: async (_orgId, agentId) => !watchOnly.has(agentId),
    handoff: async (_orgId, handoffId) => find(handoffId),
    takeControl: async (orgId, handoffId) => {
      log("browser.takeControl", orgId, handoffId);
      const h = { ...find(handoffId), status: "active" as const, controllerUserId: me, expiresAt: null };
      handoffs.set(handoffId, h);
      return h;
    },
    done: async (orgId, handoffId, note) => {
      log("browser.done", orgId, handoffId, ...(note ? [note] : []));
      return end(handoffId, "done", note ?? null);
    },
    failed: async (orgId, handoffId, note) => {
      log("browser.failed", orgId, handoffId, note);
      return end(handoffId, "failed", note ?? null);
    },
    cancel: async (orgId, handoffId) => {
      log("browser.cancel", orgId, handoffId);
      return end(handoffId, "cancelled");
    },
    takeover: async (orgId, agentId, runId, screen) => {
      log("browser.takeover", orgId, agentId, ...(runId ? [runId] : []), ...(screen ? [screen] : []));
      const h: BrowserHandoff = {
        id: `takeover-${handoffs.size + 1}`,
        agentId,
        runId: runId ?? null,
        machineId: "machine-1",
        ...(screen && screen !== "browser" ? { screen } : {}),
        kind: "takeover",
        instructions: "",
        status: "active",
        requestedForUserId: null,
        controllerUserId: me,
        note: null,
        expiresAt: null,
        createdAt: now().toISOString(),
        resolvedAt: null,
      };
      handoffs.set(h.id, h);
      return h;
    },
    // Like the server: only the person in control, web addresses only, the agent's sites when it has a list.
    open: async (orgId, agentId, url) => {
      log("browser.open", orgId, agentId, url);
      const held = [...handoffs.values()].find((h) => h.agentId === agentId && h.status === "active");
      if (held?.controllerUserId !== me) {
        throw new ApiError(409, "browser.not_in_control", "Take control of the browser first");
      }
      if (typeof url !== "string") return;
      let host: string;
      try {
        const u = new URL(url.includes("://") ? url : `https://${url}`);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not a web page");
        host = u.hostname;
      } catch {
        throw new ApiError(400, "browser.bad_address", "Type a web address (https://…)");
      }
      const sites = settings.get(agentId)?.allowedDomains;
      const listed = (d: string) =>
        host === d.replace(/^\*\./, "") || (d.startsWith("*.") && host.endsWith(d.slice(1)));
      if (sites && !sites.some(listed)) {
        throw new ApiError(403, "browser.not_allowed", `${host} is outside the sites this agent may use`);
      }
    },
    stop: async (orgId, agentId) => {
      log("browser.stop", orgId, agentId);
    },
    // Like the server: only who may drive it.
    restart: async (orgId, agentId) => {
      log("browser.restart", orgId, agentId);
      if (watchOnly.has(agentId)) throw new ApiError(403, "forbidden", "You can't use this agent's browser");
    },
  };
  const desktop: ApiClient["desktop"] = {
    status: async (orgId, agentId) => {
      log("desktop.status", orgId, agentId);
      if (forbidden.has(agentId)) throw new ApiError(403, "forbidden", "You can't use this agent's desktop");
      const open = openOn(agentId, "desktop") ?? (sameWindow.has(agentId) ? openOn(agentId, "browser") : null);
      return {
        ...NO_DESKTOP,
        // Its browser card shows the screen (ADR 0058 §7); a test may say otherwise in `desktops`.
        browserOnDesktop: sameWindow.has(agentId),
        ...desktops.get(agentId),
        ...(open ? { handoff: open, controllerUserId: open.status === "active" ? open.controllerUserId : null } : {}),
      };
    },
    picture: async (orgId, agentId) => {
      log("desktop.picture", orgId, agentId);
      if (forbidden.has(agentId)) throw new ApiError(403, "forbidden", "You can't use this agent's desktop");
      const picture = { data: "c2NyZWVu", width: 1280, height: 800, capturedAt: new Date().toISOString() };
      return desktops.get(agentId)?.running ? { picture, reason: null } : { picture: null, reason: "stopped" };
    },
  };
  return { client, desktop, settings, handoffs, desktops, forbidden, watchOnly, sameWindow };
}
