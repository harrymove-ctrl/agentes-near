import {
  BudgetExceededError,
  ConflictError,
  ForbiddenError,
  MachineOfflineError,
  MachinePausedError,
  MachineRequestError,
  MissingCredentialError,
  NotFoundError,
  runErrorDetail,
  TooManyError,
  UnauthorizedError,
  ValidationError,
} from "@agenteschat/engine";
import type { Hook } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { Context, Env } from "hono";
import { HTTPException } from "hono/http-exception";
import { matchedRoutes, routePath } from "hono/route";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Every API error has this shape. `code` is stable and machine-readable. */
export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "invalid_request", description: "Stable: the app translates it." }),
      message: z.string().openapi({ example: "name: Required", description: "English fallback." }),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .openapi({ description: "Values for the translated message (names, limits…)." }),
    }),
  })
  .openapi("Error");

export function apiError<S extends ContentfulStatusCode>(
  c: Context,
  status: S,
  code: string,
  message: string,
  params?: Record<string, unknown>,
) {
  return c.json({ error: { code, message, ...(params ? { params } : {}) } }, status);
}

/** OpenAPI response entry for an error status. */
export const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});

/**
 * What the apps say of a validation failure, by its first problem: the field and its kind (`too_long` for text,
 * `too_many` for a list, `missing` for an empty one of either, else `invalid`), with the limit when there is one. A
 * number out of its range is `invalid`: "shorten it" or "fill it in" would mislead. The message is the validator's
 * English, for developers.
 */
export function issueParams(
  issue: { code: string; path: PropertyKey[]; maximum?: unknown; minimum?: unknown; origin?: unknown } | undefined,
) {
  if (!issue) return undefined;
  const field = issue.path.map(String).join(".") || "body";
  const list = issue.origin === "array" || issue.origin === "set";
  const sized = list || issue.origin === "string";
  if (sized && issue.code === "too_big" && typeof issue.maximum === "number") {
    return { field, issue: list ? "too_many" : "too_long", max: issue.maximum };
  }
  if (sized && issue.code === "too_small" && Number(issue.minimum) <= 1) return { field, issue: "missing" };
  return { field, issue: "invalid" };
}

/** Turns request validation failures into our error format. */
export function validationHook<E extends Env>(): Hook<unknown, E, string, unknown> {
  return (result, c) => {
    if (!result.success) {
      const message = result.error.issues
        .map((i) => `${i.path.length > 0 ? i.path.join(".") : "body"}: ${i.message}`)
        .join(". ");
      return apiError(c, 400, "invalid_request", message, issueParams(result.error.issues[0]));
    }
  };
}

/**
 * The HTTP answer of a domain error from `@agenteschat/engine`, or of a request Hono refused: [status, code, message,
 * params], or null for another.
 */
function domainError(error: unknown): [ContentfulStatusCode, string, string, Record<string, unknown>?] | null {
  if (error instanceof UnauthorizedError) return [401, error.code, error.message];
  if (error instanceof ForbiddenError) return [403, error.code, error.message, error.params];
  if (error instanceof NotFoundError) return [404, error.code, error.message, error.params];
  if (error instanceof ConflictError) return [409, error.code, error.message, error.params];
  if (error instanceof ValidationError) return [400, error.code, error.message, error.params];
  if (error instanceof TooManyError) return [429, error.code, error.message, error.params];
  if (error instanceof BudgetExceededError) return [402, "budget_exceeded", error.message, { agentId: error.agentId }];
  if (error instanceof MissingCredentialError) {
    // `provider`: the one whose key is missing, when the message names it (the app says it in the person's words).
    const provider = runErrorDetail(error.message)?.errorParams?.provider;
    return [400, "missing_credential", error.message, provider ? { provider } : undefined];
  }
  // A connected computer (ADR 0025, ADR 0036) that can't take the request now.
  if (error instanceof MachineOfflineError) return [409, "machine.offline", error.message, { name: error.machineName }];
  if (error instanceof MachinePausedError) {
    return [409, "machine.paused", error.message, { name: error.machineName, until: error.until }];
  }
  // Not a 502: behind Cloudflare an origin's 502 never reaches the app (Cloudflare shows its own page instead).
  if (error instanceof MachineRequestError) return [503, `machine.${error.code}`, error.message];
  // Hono's own refusals: a body that isn't the JSON or form it claims to be (a dropped upload too).
  if (error instanceof HTTPException && error.status < 500) return [error.status, "invalid_request", error.message];
  return null;
}

/** Maps domain errors from `@agenteschat/engine` to HTTP responses. Returns null for unknown errors. */
export function domainErrorResponse(error: unknown, c: Context) {
  const known = domainError(error);
  return known ? apiError(c, ...known) : null;
}

/** A refusal the engine expects (what `domainErrorResponse` answers): logged quietly, never reported (ADR 0104). */
export const isExpectedError = (error: unknown) => domainError(error) !== null;

/**
 * The route a request matched as registered (`/api/app/organizations/:orgId/channels`), so its ids stay out of
 * reports: the last one with a method of its own, past the middlewares (`*`) that match everything.
 */
export function routeOf(c: Context): string {
  const handlers = matchedRoutes(c).filter((route) => route.method !== "ALL" && !route.path.endsWith("*"));
  return handlers.at(-1)?.path ?? routePath(c);
}
