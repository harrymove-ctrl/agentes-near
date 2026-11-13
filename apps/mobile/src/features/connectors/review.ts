import type { ConnectorDef, CustomServer, ToolDecision } from "@agenteschat/client";
import { catalogToolClass } from "@agenteschat/client/lib/access-levels";
import { type ConnectedItem, connectedSummary } from "@agenteschat/client/lib/connected";
import { humanize, toolsToReview } from "@agenteschat/client/lib/custom-tools";
import {
  bySubject,
  matchTool,
  partsOf,
  REVIEW_LEVELS,
  type ReviewTool,
  SENSITIVE_LEVELS,
  toolName,
} from "@agenteschat/client/lib/tool-review";
import type { TFunction } from "i18next";

/**
 * The review step of connecting a service on the phone ("O que faz", as on the web): pure pieces the sheet and
 * the tests share. No React Native imports.
 */

/**
 * Where a connect sheet is: what it does → connect → "done", the short confirmation that ends it. "Ajustar" there
 * goes on to the detail: its tools → who uses it.
 */
export type Step = "about" | "connect" | "done" | "review" | "who";

/** A catalog service starts with what agents could do there; a server by its address with connecting. */
export const CATALOG_STEPS: Step[] = ["about", "connect", "review", "who"];
// A server's tools never hold its flow: what needs a decision waits on the connection's screen.
export const ADDRESS_STEPS: Step[] = ["connect", "who"];

/** Each step's name for the progress dashes (the web's step names; "about" is the phone's own). */
export const STEP_KEYS: Record<Exclude<Step, "done">, string> = {
  about: "mobile.connectors.review.stepAbout",
  connect: "connectFlow.step.0",
  review: "connectFlow.step.1",
  who: "connectFlow.step.2",
};

/**
 * Where a sheet opens. A new service: on what it does. A connection: on who uses it (a connection opens its own
 * screen from the gallery); `start` asks for a step (back from a sign-in, its confirmation; connecting again over a
 * connection, for an admin).
 */
export function firstStep(
  existing: Pick<ConnectedItem, "needsReview"> | undefined,
  admin: boolean,
  start?: Step,
): Step {
  if (!existing) return "about";
  if (start === "connect") return admin ? "connect" : "who";
  if (start === "done" || start === "review") return admin ? start : "who";
  return "who";
}

/** What the review shows for a connection: a server's own tools, ours by scope, or nothing yet. */
export type ReviewTarget =
  | { kind: "server"; server: CustomServer }
  | { kind: "catalog"; def: ConnectorDef }
  | { kind: "loading" }
  | { kind: "none" };

/**
 * A server connected by its address (a vendor's own too) is in the servers' list under the connection's id;
 * our catalog connectors never are (their tools come with the catalog). While the list catches up with a
 * connection just made, it is loading.
 */
export function reviewTarget(
  connectionId: string,
  def: ConnectorDef | null,
  servers: CustomServer[] | undefined,
  fetching: boolean,
): ReviewTarget {
  const server = servers?.find((s) => s.id === connectionId);
  if (server) return { kind: "server", server };
  if (def?.kind === "catalog") return { kind: "catalog", def };
  return !servers || fetching ? { kind: "loading" } : { kind: "none" };
}

/**
 * The confirmation's sentence for a connection just made (the web's): who can use it and how many actions ask, or,
 * for a server whose tools no one gave a level yet, that agents get them on Continuar (`waiting`: that server).
 * `unreadable`: why its tools couldn't be read, when they couldn't. Null while the lists catch up.
 */
export function doneSummary(
  t: TFunction,
  target: ReviewTarget,
): { text: string; waiting: CustomServer | null; unreadable: string | null } | null {
  if (target.kind === "loading") return null;
  const server = target.kind === "server" ? target.server : null;
  const pending = server ? toolsToReview(server) : 0;
  const def = target.kind === "catalog" ? target.def : null;
  return {
    text: connectedSummary(t, { server, def, pending }),
    waiting: pending > 0 ? server : null,
    unreadable: server?.toolsError ?? null,
  };
}

/** A catalog connector's tools, read-only, classified by our scopes (the web's catalog review). */
export function catalogReviewTools(t: TFunction, def: ConnectorDef): ReviewTool[] {
  return def.tools.map((tool) => {
    const parts = partsOf(tool.name, def.id);
    const level = catalogToolClass(tool);
    return {
      name: tool.name,
      label: toolName(t, parts, tool.name),
      description: "",
      subject: parts.subject,
      level,
      suggested: level,
      reason: null,
      sensitive: tool.sensitive,
      pending: false,
      savedLabel: humanize(tool.name),
    };
  });
}

/** The person's choices so far (saved on Continuar): each tool's level, and the waiting ones they decided. */
export interface ReviewState {
  levels: Record<string, ToolDecision>;
  decided: Set<string>;
}

export const emptyReview = (): ReviewState => ({ levels: {}, decided: new Set() });

/** A tool's level: the person's choice, else the server's (its decision or our suggestion). */
export const chosenLevel = (state: ReviewState, tool: ReviewTool): ToolDecision =>
  state.levels[tool.name] ?? tool.level;

/** Still in "Precisam da sua decisão": the name couldn't decide it and the person hasn't yet. */
export const isWaiting = (state: ReviewState, tool: ReviewTool) => tool.pending && !state.decided.has(tool.name);

/** The levels a tool can take (sensitive ones only ask or are off). */
export const choicesOf = (tool: ReviewTool): ToolDecision[] =>
  tool.levels ?? (tool.sensitive ? SENSITIVE_LEVELS : REVIEW_LEVELS);

/** Picking a level; on a waiting tool it is also the decision (it leaves the group). */
export function choose(state: ReviewState, tool: ReviewTool, level: ToolDecision): ReviewState {
  return {
    levels: { ...state.levels, [tool.name]: level },
    decided: tool.pending ? new Set([...state.decided, tool.name]) : state.decided,
  };
}

/** "OK" on a waiting tool: keeps the level it shows. */
export const confirm = (state: ReviewState, tool: ReviewTool): ReviewState =>
  choose(state, tool, chosenLevel(state, tool));

/** "Aceitar as sugestões": every waiting tool keeps its suggestion. */
export function acceptAll(state: ReviewState, tools: ReviewTool[]): ReviewState {
  const waiting = tools.filter((x) => isWaiting(state, x)).map((x) => x.name);
  return { levels: state.levels, decided: new Set([...state.decided, ...waiting]) };
}

/** "Rever as sugestões": the decided ones wait again (their levels stay). */
export const reviewAgain = (state: ReviewState): ReviewState => ({ levels: state.levels, decided: new Set() });

export interface SubjectGroup {
  subject: string;
  label: string;
  /** Every tool of the subject (its count and summary). */
  tools: ReviewTool[];
  /** The ones the search matches (`tech`: matched by the technical name, shown under it). */
  hits: { tool: ReviewTool; tech: boolean }[];
}

/** Tools by subject, only subjects the search matches, as the web lists them. */
export function subjectsOf(t: TFunction, tools: ReviewTool[], query: string): SubjectGroup[] {
  return bySubject(t, tools)
    .map((g) => ({ ...g, hits: g.tools.map((tool) => ({ tool, ...matchTool(tool, query) })).filter((m) => m.ok) }))
    .filter((g) => g.hits.length > 0);
}

/** The waiting tools the search matches. */
export function waitingHits(state: ReviewState, tools: ReviewTool[], query: string) {
  return tools
    .filter((x) => isWaiting(state, x))
    .map((tool) => ({ tool, ...matchTool(tool, query) }))
    .filter((m) => m.ok);
}

/** Back from a sign-in that finished on the link route: Conectores opens that connection's confirmation. */
export const returnHref = (connectionId: string) => ({
  pathname: "/connectors" as const,
  params: { connected: connectionId },
});
