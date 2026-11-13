import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useApi } from "../api/context";
import { keys } from "../api/keys";
import type { AgentBrowserSettings, BrowserHandoff, DesktopStatus, PageTarget, ScreenKind } from "../api/types";
import { timeLeft } from "../lib/format";
import { can } from "../lib/permissions";
import { isBlankPage } from "../lib/sites";
import type { LiveWork } from "../realtime/streams";
import { noteHandoffPlace } from "./held";

export * from "./frame-bytes";
export * from "./held";
export * from "./input";
export * from "./live";
export * from "./profiles";
export * from "./trail";
export * from "./watches";

/**
 * The agent browser on connected computers (ADR 0040), shared by the web and
 * the phone app: settings, a person's turn in the browser (the request the
 * agent made, or a take over) and the live view.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The scope that lets an agent use its browser (not covered by "all tools"). */
export const BROWSER_TOOL_SCOPE = "browser:use";
/** The scope that lets an agent use apps on its desktop (it also needs Run code). */
export const DESKTOP_TOOL_SCOPE = "desktop:use";

/** The request on an agent's chat card (`meta.browserHandoff`), checked. */
export function browserHandoffOf(meta: unknown): BrowserHandoff | null {
  if (!isObject(meta)) return null;
  const h = meta.browserHandoff;
  if (!isObject(h)) return null;
  return typeof h.id === "string" && typeof h.agentId === "string" && typeof h.status === "string"
    ? (h as unknown as BrowserHandoff)
    : null;
}

/** Still waiting for someone, or someone is in it now. */
export const isOpenHandoff = (h: Pick<BrowserHandoff, "status">) => h.status === "pending" || h.status === "active";

/** Which screen a handoff is on (servers older than screens name none: the browser). */
export const handoffScreen = (h: Pick<BrowserHandoff, "screen">): ScreenKind => h.screen ?? "browser";

/**
 * The agent's request asks the person something, or to tell it something: handing back opens with the note. A question
 * mark in any script, or "tell me", "let me know" and their like.
 * ponytail: a few cue phrases in the most used languages, a server-side flag on the request if this misses too often.
 */
const ASKS_WORDS =
  /[?？؟]|\b(tell|let) me\b|\bme (diga|diz|fala|conta|avise|informe|passe|mande)\b|\b(dime|cu[eé]ntame|av[ií]same|dis-moi|sag mir)\b/i;
export const handoffWantsWords = (h: Pick<BrowserHandoff, "kind" | "instructions"> | null | undefined): boolean =>
  h?.kind === "ask" && ASKS_WORDS.test(h.instructions);

/** Waiting for someone to open it, not yet expired. */
export function isWaitingHandoff(h: Pick<BrowserHandoff, "status" | "expiresAt">, now = Date.now()): boolean {
  if (h.status !== "pending") return false;
  return !h.expiresAt || new Date(h.expiresAt).getTime() > now;
}

/**
 * Whether a waiting request is this person's to answer (its card says it waits for you, the bar above the
 * composer brings it back, its buttons show): the person it was asked of and the agent's responsible person,
 * who are both notified. Asked of no one in particular (no one behind the run and no responsible person, or a
 * desktop several people may drive), it is for whoever may control every agent's screen (`control_browsers`; a
 * desktop `control_computers`). Whose roles don't give them that screen at all (`own_browsers`, `own_computers`)
 * answers none. The server checks again when they open it (ADR 0040 §6, ADR 0058 §4).
 */
export function handoffIsMine(
  h: Pick<BrowserHandoff, "requestedForUserId" | "screen">,
  meId: string,
  ownerUserId: string | null | undefined,
  org: Parameters<typeof can>[0],
): boolean {
  const full = handoffScreen(h) === "desktop";
  if (!can(org, full ? "own_computers" : "own_browsers")) return false;
  if (ownerUserId && ownerUserId === meId) return true;
  return h.requestedForUserId
    ? h.requestedForUserId === meId
    : can(org, full ? "control_computers" : "control_browsers");
}

/** The time a waiting request has left ("24 h", "45 min"); null without a deadline or once it passed. */
export function handoffTimeLeft(t: TFunction, h: Pick<BrowserHandoff, "expiresAt">, now = Date.now()): string | null {
  return h.expiresAt ? timeLeft(t, h.expiresAt, new Date(now)) : null;
}

/** How much of a waiting request's time is left, 0–1 (the card's fuse). */
export function handoffFuse(h: Pick<BrowserHandoff, "createdAt" | "expiresAt">, now = Date.now()): number {
  if (!h.expiresAt) return 0;
  const start = new Date(h.createdAt).getTime();
  const end = new Date(h.expiresAt).getTime();
  if (end <= start) return 0;
  return Math.min(1, Math.max(0, (end - now) / (end - start)));
}

/** A tool of one of the agent's screens: its browser (`browser_open`, …) or its desktop (`desktop_do`, …). */
export const isScreenTool = (tool: string | null | undefined, screen: ScreenKind) =>
  Boolean(tool?.replace(/^mcp__agentes__/, "").startsWith(`${screen}_`));

/** A tool of the agent browser (`browser_open`, `browser_click`, …). */
export const isBrowserTool = (tool: string | null | undefined) => isScreenTool(tool, "browser");

/**
 * The agent is in its browser now: its current tool, or its latest call, is a browser tool
 * (the progress bar then says so and opens the live view).
 */
export function usesBrowser(run: { tool?: string | null; work?: LiveWork[] }): boolean {
  if (isBrowserTool(run.tool)) return true;
  const work = run.work ?? [];
  for (let i = work.length - 1; i >= 0; i--) {
    const w = work[i];
    if (w?.kind === "call") return isBrowserTool(w.tool);
  }
  return false;
}

const SCREENS: readonly ScreenKind[] = ["browser", "desktop"];
/** Which of the agent's screens a tool is on, if any. */
const screenOfTool = (tool: string | null | undefined) => SCREENS.find((s) => isScreenTool(tool, s)) ?? null;

/** The agent works on its computer now: its current tool, or its latest call, is on its browser or its screen. */
export function usesScreen(run: { tool?: string | null; work?: LiveWork[] }): boolean {
  if (screenOfTool(run.tool)) return true;
  const work = run.work ?? [];
  for (let i = work.length - 1; i >= 0; i--) {
    const w = work[i];
    if (w?.kind === "call") return screenOfTool(w.tool) !== null;
  }
  return false;
}

/** One line of "what the agent is doing in its browser", from its run's live work. */
export interface BrowserStep {
  id: string;
  tool: string;
  detail: string | null;
  running: boolean;
  since?: number;
}

/** The browser calls of a run, in order (the watching card's log). */
export function browserSteps(work: LiveWork[] | undefined): BrowserStep[] {
  return (work ?? []).flatMap((w) =>
    w.kind === "call" && isBrowserTool(w.tool)
      ? [
          {
            id: w.id,
            // A computer brain's call carries the bridge's prefix (`mcp__agentes__browser_open`).
            tool: w.tool.replace(/^mcp__agentes__/, ""),
            detail: w.detail,
            running: w.running,
            ...(w.since ? { since: w.since } : {}),
          },
        ]
      : [],
  );
}

/** A step on either screen, with the screen it was on (the computer's step strip). */
export interface ScreenStep extends BrowserStep {
  screen: ScreenKind;
}

/** The calls of a run on its browser and its screen, in order. */
export function screenSteps(work: LiveWork[] | undefined): ScreenStep[] {
  return (work ?? []).flatMap((w) => {
    const screen = w.kind === "call" ? screenOfTool(w.tool) : null;
    if (!screen || w.kind !== "call") return [];
    return [
      {
        id: w.id,
        tool: w.tool.replace(/^mcp__agentes__/, ""),
        detail: w.detail,
        running: w.running,
        ...(w.since ? { since: w.since } : {}),
        screen,
      },
    ];
  });
}

/**
 * The page the agent's browser is on, as best known: the live frame's address, else the
 * site of its latest open (or new tab). Null before either exists.
 */
export function browserSiteUrl(frameUrl: string | null | undefined, steps: BrowserStep[]): string | null {
  if (frameUrl && !isBlankPage(frameUrl)) return frameUrl;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s && (s.tool === "browser_open" || s.tool === "browser_tabs") && s.detail) return s.detail;
  }
  return null;
}

/**
 * A request changed (an action's answer, `browser.handoff.updated`): every cached view of it follows.
 * `place`: the conversation the event came in (a take over's run lives there: its held card).
 */
export function applyBrowserHandoff(
  qc: QueryClient,
  orgId: string,
  handoff: BrowserHandoff,
  place?: { channelId: string; threadId: string | null },
) {
  if (place) noteHandoffPlace(handoff, place.channelId, place.threadId);
  qc.setQueryData(keys.browserHandoff(orgId, handoff.id), handoff);
  qc.setQueryData<BrowserHandoff | null>(
    keys.agentBrowserHandoff(orgId, handoff.agentId, handoffScreen(handoff)),
    (old) => (isOpenHandoff(handoff) ? handoff : old?.id === handoff.id || old === undefined ? null : old),
  );
  qc.setQueryData<DesktopStatus>(keys.agentDesktop(orgId, handoff.agentId), (old) =>
    old ? desktopWithHandoff(old, handoff) : old,
  );
  // A request asked of someone lets them drive while it is open: who may control follows it.
  void qc.invalidateQueries({ queryKey: keys.agentBrowserControl(orgId, handoff.agentId, handoffScreen(handoff)) });
}

/**
 * The desktop's state once a handoff changed: its own handoff, or the one it already named (the browser's,
 * when its Chrome shows on the desktop; only the server knows that one holds it, so a new one waits for it).
 */
export function desktopWithHandoff(status: DesktopStatus, handoff: BrowserHandoff): DesktopStatus {
  const known = status.handoff?.id === handoff.id;
  if (!isOpenHandoff(handoff)) return known ? { ...status, handoff: null, controllerUserId: null } : status;
  if (!known && handoffScreen(handoff) !== "desktop") return status;
  return { ...status, handoff, controllerUserId: handoff.status === "active" ? handoff.controllerUserId : null };
}

export const useAgentBrowserSettings = (orgId: string, agentId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentBrowser(orgId, agentId),
    queryFn: () => api.browser.settings(orgId, agentId),
    enabled,
    retry: false,
  });
};

/** Saves the sites an agent's browser may open (null: any site). */
export function useUpdateAgentBrowserSettings(orgId: string, agentId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (allowedDomains: string[] | null) => api.browser.setDomains(orgId, agentId, allowedDomains),
    meta: { silent: true },
    onSuccess: (saved: AgentBrowserSettings) => qc.setQueryData(keys.agentBrowser(orgId, agentId), saved),
  });
}

/**
 * The agent's open request or take over (who is in control) on that screen, if any. `staleTime`:
 * how long a fetched answer is trusted (the realtime event keeps it current meanwhile).
 */
export const useAgentBrowserHandoff = (
  orgId: string,
  agentId: string,
  enabled = true,
  staleTime = 0,
  screen: ScreenKind = "browser",
) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentBrowserHandoff(orgId, agentId, screen),
    queryFn: () => api.browser.agentHandoff(orgId, agentId, screen),
    enabled,
    retry: false,
    staleTime,
  });
};

/**
 * Whether this person may drive the agent's screen (take over, open a page, type): admins, its owner, and the
 * person an open request was asked of (ADR 0040). Watchers who may not see no Assumir.
 */
export const useAgentScreenControl = (
  orgId: string,
  agentId: string,
  enabled = true,
  screen: ScreenKind = "browser",
) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentBrowserControl(orgId, agentId, screen),
    queryFn: () => api.browser.agentControl(orgId, agentId, screen),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
};

export const useBrowserHandoff = (orgId: string, handoffId: string | null | undefined) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.browserHandoff(orgId, handoffId ?? ""),
    queryFn: () => api.browser.handoff(orgId, handoffId ?? ""),
    enabled: Boolean(handoffId),
    retry: false,
  });
};

/** "Assumir" from a run's card: the run it is bound to (its card stays in that conversation); `screen`: the browser by default. */
export interface TakeoverInput {
  agentId: string;
  runId?: string;
  screen?: ScreenKind;
}

/** "Pronto" or "Devolver" with what the person wants the agent to know (it reads it as their words). */
export interface DoneInput {
  handoffId: string;
  note?: string;
}

/** A site the person in control opens in the agent's browser (a bare host gets https://), or an arrow. */
export interface OpenPageInput {
  agentId: string;
  url: PageTarget;
}

/** The code a request that already ended answers with. */
export const HANDOFF_OVER = "browser.handoff_over";

/**
 * "Abrir" (take control), "Pronto"/"Devolver", "Não consegui", cancel, "Assumir" while
 * watching, opening a site while in control, "Parar" (close the agent's browser) and "Tentar de
 * novo" (restart it), as React Query mutations (`.mutate`, `.isPending`). Each answer updates the
 * cached request.
 */
export function useBrowserHandoffMutations(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const apply = (h: BrowserHandoff) => applyBrowserHandoff(qc, orgId, h);
  // It ended meanwhile: the card settles now, even if the event that said so never came.
  const settle = (error: unknown, handoffId: string) => {
    if ((error as { code?: string }).code !== HANDOFF_OVER) return;
    void api.browser.handoff(orgId, handoffId).then(apply, () => undefined);
  };
  return {
    takeControl: useMutation({
      mutationFn: (handoffId: string) => api.browser.takeControl(orgId, handoffId),
      meta: { silent: true },
      onSuccess: apply,
      onError: settle,
    }),
    done: useMutation({
      mutationFn: (v: string | DoneInput) =>
        typeof v === "string" ? api.browser.done(orgId, v) : api.browser.done(orgId, v.handoffId, v.note),
      meta: { silent: true },
      onSuccess: apply,
      onError: (error, v) => settle(error, typeof v === "string" ? v : v.handoffId),
    }),
    /** 403 `browser.not_allowed` (outside the agent's sites), 409 `browser.not_in_control`, 400 `browser.bad_address` / `browser.open_failed`. */
    open: useMutation({
      mutationFn: ({ agentId, url }: OpenPageInput) => api.browser.open(orgId, agentId, url),
      meta: { silent: true },
    }),
    failed: useMutation({
      mutationFn: ({ handoffId, note }: { handoffId: string; note?: string }) =>
        api.browser.failed(orgId, handoffId, note),
      meta: { silent: true },
      onSuccess: apply,
      onError: (error, v) => settle(error, v.handoffId),
    }),
    cancel: useMutation({
      mutationFn: (handoffId: string) => api.browser.cancel(orgId, handoffId),
      meta: { silent: true },
      onSuccess: apply,
      onError: settle,
    }),
    takeover: useMutation({
      mutationFn: (v: string | TakeoverInput) =>
        typeof v === "string"
          ? api.browser.takeover(orgId, v)
          : api.browser.takeover(orgId, v.agentId, v.runId, v.screen),
      meta: { silent: true },
      onSuccess: apply,
    }),
    stop: useMutation({
      mutationFn: (agentId: string) => api.browser.stop(orgId, agentId),
      meta: { silent: true },
    }),
    /** "Tentar de novo" on a page that never came (who may drive it). */
    restart: useMutation({
      mutationFn: (agentId: string) => api.browser.restart(orgId, agentId),
      meta: { silent: true },
    }),
  };
}

/**
 * The same actions as plain functions returning promises (the phone app's
 * shape): each rejects with the API error (409 when someone else has it).
 * `pending` is true while any of them runs.
 */
export function useBrowserHandoffActions(orgId: string) {
  const m = useBrowserHandoffMutations(orgId);
  return {
    takeControl: (handoffId: string) => m.takeControl.mutateAsync(handoffId),
    done: (handoffId: string, note?: string) => m.done.mutateAsync(note ? { handoffId, note } : handoffId),
    failed: (handoffId: string, note?: string) => m.failed.mutateAsync({ handoffId, ...(note ? { note } : {}) }),
    cancel: (handoffId: string) => m.cancel.mutateAsync(handoffId),
    takeover: (agentId: string, runId?: string, screen?: ScreenKind) =>
      m.takeover.mutateAsync(
        runId || screen ? { agentId, ...(runId ? { runId } : {}), ...(screen ? { screen } : {}) } : agentId,
      ),
    stop: (agentId: string) => m.stop.mutateAsync(agentId),
    /** Not in `pending`, as `open`: the browser may take a while to come back. */
    restart: (agentId: string) => m.restart.mutateAsync(agentId),
    /** Not in `pending`: a page may take a while to open, and the rest stays usable meanwhile. */
    open: (agentId: string, url: PageTarget) => m.open.mutateAsync({ agentId, url }),
    opening: m.open.isPending,
    pending:
      m.takeControl.isPending ||
      m.done.isPending ||
      m.failed.isPending ||
      m.cancel.isPending ||
      m.takeover.isPending ||
      m.stop.isPending,
  };
}

/** A view that waited this long for the agent's page (opening, reconnecting) says it couldn't open it, with Try again. */
export const BROWSER_STUCK_MS = 75_000;

/**
 * Whether a view has waited `BROWSER_STUCK_MS` for the agent's page (`waiting`: it shows opening or reconnecting)
 * without it coming. Waiting again starts over, and so does a new `attempt` (Try again).
 */
export function useBrowserStuck(waiting: boolean, attempt = 0): boolean {
  const [since, setSince] = useState<number | null>(null);
  const [, rerender] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt starts the wait over
  useEffect(() => {
    if (!waiting) {
      setSince(null);
      return;
    }
    setSince(Date.now());
    // Read again just after the time is up: the answer is the clock's.
    const timer = setTimeout(() => rerender((n) => n + 1), BROWSER_STUCK_MS + 100);
    return () => clearTimeout(timer);
  }, [waiting, attempt]);
  return waiting && since !== null && Date.now() - since >= BROWSER_STUCK_MS;
}
