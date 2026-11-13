import type { TFunction } from "i18next";
import type { AppNotification, SecretRequest } from "../api/types";
import { MAX_SECRET_BYTES } from "./secret-box";

/**
 * An agent's request for a secret (ADR 0027), as the web's card and the phone's both read it: where the value
 * goes (said truly for each kind), and what is wrong with a value before it is sealed.
 */

/** `https://app.example.com` → `app.example.com`. */
export function siteHost(site: string): string {
  try {
    return new URL(site).host;
  } catch {
    return site;
  }
}

/**
 * What people read for a request: the agent's label, else a plain one from its kind and site. Its `name` is the
 * agent's own (`LIA_GOOGLE_PASSWORD`) and shows nowhere.
 */
export function secretLabel(
  t: TFunction,
  r: Pick<SecretRequest, "label" | "target" | "site" | "codeDigits">,
  agent: string,
): string {
  if (r.label) return r.label;
  const target = r.target;
  const host = r.site ? siteHost(r.site) : target.kind === "site" ? siteHost(target.site) : null;
  if (host) return t(r.codeDigits ? "secret.labelCode" : "secret.labelPassword", { host });
  return target.kind === "file" ? t("secret.labelFile", { path: target.path }) : t("secret.labelKey", { agent });
}

/**
 * Where the value goes, in the person's words: into the agent's commands, a file in its folder, or only its browser's
 * typing on one site; and, while it is asked, that it replaces the key the agent holds under that name.
 */
export function secretWhere(
  t: TFunction,
  r: Pick<SecretRequest, "target" | "replaces" | "status">,
  agent: string,
): string {
  const target = r.target;
  const where =
    target.kind === "file"
      ? t("secret.targetFile", { path: target.path, agent })
      : target.kind === "site"
        ? t("secret.targetSite", { host: siteHost(target.site), agent })
        : t("secret.targetEnv", { agent });
  // Only while it is asked: once it is answered or closed, nothing is replacing anything.
  return r.replaces && r.status === "pending" ? `${where} ${t("secret.replaces", { agent })}` : where;
}

/**
 * The newest word on a request: an event and a message's copy can each lag the other (a socket that dropped, a page
 * that loaded later), and a closed request never reopens, so a closed copy beats an open one.
 */
export function latestSecret(live: SecretRequest | undefined, message: SecretRequest): SecretRequest {
  if (!live) return message;
  return live.status === "pending" && message.status !== "pending" ? message : live;
}

/**
 * Why sending was refused while the request itself may still be open: its computer can't take it now (the request
 * waits, and the person can send again), as the i18n key that says so. Null: the request ended.
 */
export function secretRefusalKey(error: unknown): "secret.computerAway" | "secret.computerPaused" | null {
  const code = (error as { code?: string }).code;
  return code === "machine.offline"
    ? "secret.computerAway"
    : code === "machine.paused"
      ? "secret.computerPaused"
      : null;
}

const CLOSED = new Set<SecretRequest["status"]>(["delivered", "declined", "expired", "canceled"]);

/**
 * How a request stands after a 409 that isn't the computer's: `fresh` when reading it again shows it ended, else as the
 * refusal says it ended. Null: it is still open, and only this card's copy was behind, so the person can send again.
 */
export function secretClosedBy(
  error: unknown,
  current: SecretRequest,
  fresh: SecretRequest | null,
): SecretRequest | null {
  if (fresh && fresh.status !== "pending") return fresh;
  const { code, params } = error as { code?: string; params?: { status?: string; endReason?: string | null } };
  const status = params?.status as SecretRequest["status"] | undefined;
  if (code !== "secret.closed" || !status || !CLOSED.has(status)) return null;
  return { ...current, status, endReason: (params?.endReason ?? null) as SecretRequest["endReason"], publicKey: null };
}

/** A request's notification (`secret_request`) in one line, as its card says it: its label, what it is for. */
export const secretNoticeLine = (n: Pick<AppNotification, "latest">) =>
  [n.latest.title, n.latest.text].filter(Boolean).join(" · ");

/** Why a value can't go yet, as the i18n key that says it, or null. */
export function secretValueProblem(value: string): "secret.empty" | "secret.tooLarge" | null {
  if (!value) return "secret.empty";
  return new TextEncoder().encode(value).byteLength > MAX_SECRET_BYTES ? "secret.tooLarge" : null;
}

const TARGETS = new Set(["env", "file", "site"]);
const STATUSES = new Set(["pending", "delivered", "declined", "expired", "canceled"]);

/** The request a message's card carries (`meta.secretRequest`), or null when it isn't one. */
export function secretRequestOf(meta: Record<string, unknown> | null | undefined): SecretRequest | null {
  const r = meta?.secretRequest as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return null;
  const target = r.target as Record<string, unknown> | undefined;
  if (
    typeof r.id !== "string" ||
    typeof r.name !== "string" ||
    typeof r.agentId !== "string" ||
    typeof r.requestedForUserId !== "string" ||
    typeof r.expiresAt !== "string" ||
    !STATUSES.has(String(r.status)) ||
    !target ||
    !TARGETS.has(String(target.kind))
  ) {
    return null;
  }
  return r as unknown as SecretRequest;
}
