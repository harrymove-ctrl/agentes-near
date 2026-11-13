import type { ErrorReportsConfig } from "@agenteschat/client";
import { noAnswer } from "@agenteschat/client/lib/errors";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { reloadingForNewVersion } from "./app-version";

/** Who and where, for the reports from now on: internal ids and the route's pattern (`/org/$orgId/c/$channelId`). */
export interface ErrorScope {
  route?: string;
  orgId?: string;
  userId?: string;
}

/** The reporting SDK once loaded (`error-sdk.ts`). */
export interface ErrorSdk {
  capture(error: unknown, eventId: string): void;
  scope(scope: ErrorScope): void;
}

/** The short id the error screen shows, also a tag of its report so support can look it up. */
export const shortErrorId = (eventId: string) => eventId.slice(0, 8);

/** Errors kept while the server hasn't said yet where reports go, at most. */
const MAX_WAITING = 20;

let sdk: ErrorSdk | null = null;
let off = false;
let waiting: { error: unknown; id: string }[] = [];
let scope: ErrorScope = {};
const sent = new WeakMap<object, string>();
/** Reports the SDK took past its own dedupe, by id: a code support can find. */
const taken = new Set<string>();
const listeners = new Set<() => void>();

function markTaken(id: string) {
  taken.add(id);
  for (const listener of listeners) listener();
}

/** Whether the report `id` is on its way: the error screen gives its code only then. */
export const reportTaken = (id: string | undefined) => id !== undefined && taken.has(id);

/** `listener` hears each report taken (`useSyncExternalStore`). */
export function onReportTaken(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reports an error the app caught (ADR 0104), once however often it is reported. Returns the report's id, or
 * undefined when this server takes no reports. The router's not-found and redirects are no errors, and neither is a
 * request that got no answer (the network, a restart: nothing to fix) or a page's file from before a deploy while the
 * app reloads into the new version.
 */
export function reportError(error: unknown): string | undefined {
  if (off || reloadingForNewVersion() || noAnswer(error) || isNotFound(error) || isRedirect(error)) return undefined;
  const key = typeof error === "object" && error !== null ? error : null;
  const known = key && sent.get(key);
  if (known) return known;
  // A report's id is 32 hex characters; `crypto.randomUUID` is missing on a plain-http address, this isn't.
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  if (key) sent.set(key, id);
  if (sdk) sdk.capture(error, id);
  else if (waiting.length < MAX_WAITING) waiting.push({ error, id });
  return id;
}

export function setErrorScope(next: ErrorScope) {
  scope = next;
  sdk?.scope(next);
}

const early = (event: ErrorEvent | PromiseRejectionEvent) =>
  void reportError("reason" in event ? event.reason : (event.error ?? event.message));

/** The page's own errors until the SDK's handlers take over (or none will): they wait for the first report. */
export function catchEarlyErrors() {
  window.addEventListener("error", early);
  window.addEventListener("unhandledrejection", early);
}

/**
 * Reports go where this server says (`auth-config`'s `errorReports`), with the SDK loaded only then; null: nowhere,
 * and the errors kept so far are dropped.
 */
export async function startErrorReports(config: ErrorReportsConfig | null, load = () => import("./error-sdk")) {
  sdk = null;
  off = !config;
  try {
    if (config) sdk = (await load()).startSdk(config, markTaken);
  } catch {
    off = true;
  }
  window.removeEventListener("error", early);
  window.removeEventListener("unhandledrejection", early);
  const kept = waiting;
  waiting = [];
  if (!sdk) return;
  sdk.scope(scope);
  for (const { error, id } of kept) sdk.capture(error, id);
}
