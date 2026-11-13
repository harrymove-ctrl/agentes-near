import { randomInt } from "node:crypto";
import { type Executor, eq, schema } from "@agenteschat/db";
import { ConflictError, TooManyError, ValidationError } from "./errors";
import type { OutboxJob } from "./outbox";

/**
 * A code emailed to prove something, with the same rules wherever it's used (ADR 0072, ADR 0088): its digits (mirrored
 * in packages/client/src/lib/join-requests.ts), the wait before another, how long it works, its wrong tries, and per
 * address the codes an hour and a day and the wrong tries a day.
 */
export const CODE_LENGTH = 6;
export const CODE_RESEND_SECONDS = 60;
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_TRIES = 5;
export const CODE_LIMITS = { hour: 5, day: 10, wrongDay: 10 };

/** Whose error codes a refusal carries: asking to join (`join.code_wrong`…) or deleting (`reauth.code_wrong`…). */
export type CodeFlow = "join" | "reauth";

export const newCode = () => String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");

/** Milliseconds before another code may go out, after one sent at `sentAt`. */
export const codeWaitMs = (sentAt: Date | null | undefined, now: Date) =>
  sentAt ? Math.max(0, sentAt.getTime() + CODE_RESEND_SECONDS * 1000 - now.getTime()) : 0;

/**
 * A typed code (its `hash`) against the one waiting: `right`, a `miss` that counts against it, or refused before
 * comparing: none waiting, its tries used up, or expired.
 */
export function codeVerdict(
  waiting: { hash: string | null; tries: number; expiresAt: Date } | null | undefined,
  hash: string,
  now: Date,
) {
  if (!waiting?.hash) return "none" as const;
  if (waiting.tries >= CODE_TRIES) return "tries" as const;
  if (waiting.expiresAt <= now) return "expired" as const;
  return waiting.hash === hash ? ("right" as const) : ("miss" as const);
}

export function codeRefusal(flow: CodeFlow, why: "wrong" | "expired" | "tries") {
  const code = `${flow}.code_${why}`;
  if (why === "wrong") return new ValidationError("That code isn't right.", code);
  return why === "expired"
    ? new ConflictError("This code expired. Ask for a new one.", code)
    : new ConflictError("Too many tries for this code. Ask for a new one.", code);
}

export const codeWait = (flow: CodeFlow, ms: number) =>
  new TooManyError("A code was just sent. Ask for a new one in a minute.", `${flow}.code_wait`, {
    retryIn: Math.ceil(ms / 1000),
  });

export const codeLimit = (flow: CodeFlow) =>
  new TooManyError("Too many codes for this email. Try again later.", `${flow}.code_limit`);

/** The emails that hold a code, by template kind, with the start of their outbox key (`queueEmail`'s `key`). */
export const CODE_EMAILS: Readonly<Record<string, string>> = { join_code: "join-code", deletion_code: "deletion-code" };

/** A code's email holds the code and the address: its job's row goes once it can't be sent again. */
export async function forgetCodeEmail(db: Executor, job: OutboxJob) {
  const kind = (job.payload.template as { kind?: unknown } | undefined)?.kind;
  if (typeof kind !== "string" || !Object.hasOwn(CODE_EMAILS, kind)) return;
  await db.delete(schema.outbox).where(eq(schema.outbox.id, job.id));
}
