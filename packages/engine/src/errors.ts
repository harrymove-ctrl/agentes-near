/**
 * Domain errors. The HTTP layer maps them to status codes (`apps/server/src/http/errors.ts`).
 * Each may carry a stable `code` and `params` the app translates (`t(code, params)`);
 * `message` is the English fallback.
 */
export type ErrorParams = Record<string, string | number | boolean | string[] | null>;

export class ForbiddenError extends Error {
  constructor(
    message = "You don't have permission to do this",
    readonly code: string = "forbidden",
    readonly params?: ErrorParams,
  ) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** No account to act for (HTTP 401): it was deleted while a cached session cookie still names it. */
export class UnauthorizedError extends Error {
  constructor(
    message = "Sign in to continue",
    readonly code: string = "unauthorized",
  ) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends Error {
  constructor(
    message = "Not found",
    readonly code: string = "not_found",
    readonly params?: ErrorParams,
  ) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  /** The API error code (`conflict`, `version_conflict`, `slug_taken`…). */
  constructor(
    message: string,
    readonly code: string = "conflict",
    readonly params?: ErrorParams,
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly code: string = "invalid_request",
    readonly params?: ErrorParams,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Too many of something for now (HTTP 429). */
export class TooManyError extends Error {
  constructor(
    message: string,
    readonly code: string = "rate_limited",
    readonly params?: ErrorParams,
  ) {
    super(message);
    this.name = "TooManyError";
  }
}

/**
 * This server's own setup is wrong where only whoever runs it can fix it (a provider refused its OAuth app's client id
 * or secret), so no retry helps. The apps say why by its code, and it is reported like a failure, never logged quietly
 * as a refusal.
 */
export class MisconfiguredError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly params?: ErrorParams,
  ) {
    super(message);
    this.name = "MisconfiguredError";
  }
}

/** The agent reached its monthly budget. Checked before every model call. */
export class BudgetExceededError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly spentNanoUsd: number,
    public readonly budgetNanoUsd: number,
    /** Only other calls' reservations left no room: spend is under budget and there is room again soon. */
    public readonly byReservations = false,
  ) {
    super("This agent has used its monthly budget");
    this.name = "BudgetExceededError";
  }
}

/** The person behind a run reached their monthly AI limit (ADR 0141). Checked before every call made for them. */
export class PersonLimitError extends Error {
  constructor(
    public readonly personId: string,
    public readonly spentNanoUsd: number,
    public readonly limitNanoUsd: number,
  ) {
    super("This person has used their monthly AI limit");
    this.name = "PersonLimitError";
  }
}

/** No usable provider credential (none configured, revoked, or no platform key in this edition). */
export class MissingCredentialError extends Error {
  /** A job that hits it fails at once: retrying can't add a key (the outbox reads this flag). */
  readonly retryable = false;

  constructor(message = "This agent has no usable provider credential") {
    super(message);
    this.name = "MissingCredentialError";
  }
}

/** Unique-violation detection that works with postgres.js and PGlite. */
export function isUniqueViolation(error: unknown): boolean {
  let e: unknown = error;
  for (let i = 0; i < 4 && e; i++) {
    if ((e as { code?: string }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** The first error in `error`'s cause chain with a string `code` (the driver's, under Drizzle's wrapper), or null. */
function codedError(error: unknown): { code: string; message?: string } | null {
  let e: unknown = error;
  for (let i = 0; i < 4 && e; i++) {
    if (typeof (e as { code?: unknown }).code === "string") return e as { code: string; message?: string };
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The Postgres message of a data exception (SQLSTATE class 22: a value the database refuses), which fails the
 * same way on every try; null for anything else. Works with postgres.js and PGlite (Drizzle wraps the error).
 */
export function dataExceptionMessage(error: unknown): string | null {
  const e = codedError(error);
  return e?.code.startsWith("22") ? e.message || e.code : null;
}

/**
 * The message of the coded error under `error` (a driver's or a domain error's), never Drizzle's
 * "Failed query: <SQL> params: <values>" wrapper; null when nothing in the chain has a code.
 */
export const codedErrorMessage = (error: unknown): string | null => {
  const e = codedError(error);
  return e ? e.message || e.code : null;
};

const DOMAIN_ERRORS = new Set([
  "ForbiddenError",
  "UnauthorizedError",
  "NotFoundError",
  "ConflictError",
  "ValidationError",
  "TooManyError",
  "MisconfiguredError",
  "BudgetExceededError",
  "PersonLimitError",
  "MissingCredentialError",
]);

/**
 * An error nobody wrote for the caller: not one of the domain errors above, nor a plain `Error` (whose message a tool
 * wrote for the model). A `TypeError`, a database error, a timeout: the app itself failing.
 */
export function isUnexpectedError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return error.constructor !== Error && !DOMAIN_ERRORS.has(error.name);
}
