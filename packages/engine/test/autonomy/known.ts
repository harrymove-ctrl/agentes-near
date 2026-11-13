import { test } from "bun:test";

/**
 * Which scenarios fail on this branch, and which branch (or open item, `open:*`) turns each green
 * (ops design "autonomy as invariants", §4.2). A scenario listed here runs as `test.failing`: CI stays green while
 * the violation is known, and the scenario fails the moment it starts passing, so the entry must be removed when
 * its branch merges. `AUTONOMY_BRANCHES=a,b` treats those branches as merged (their scenarios must pass);
 * `AUTONOMY_STRICT=1` runs every scenario as a plain test.
 */
export const KNOWN: Record<string, string[]> = {};

export const merged = new Set(
  (process.env.AUTONOMY_BRANCHES ?? "")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean),
);
const strict = process.env.AUTONOMY_STRICT === "1";

/** What still has to merge before scenario `id` passes (empty: it must pass now). */
export const pendingFor = (id: string) => (KNOWN[id] ?? []).filter((b) => !merged.has(b));

/** One scenario: a plain test, or `test.failing` while a branch it needs hasn't merged. */
export function scenario(id: string, title: string, fn: () => Promise<void>, timeoutMs = 30_000) {
  const pending = pendingFor(id);
  const name = `${id} ${title}${pending.length ? ` [known: ${pending.join(", ")}]` : ""}`;
  if (pending.length && !strict) test.failing(name, fn, timeoutMs);
  else test(name, fn, timeoutMs);
}

/** A scenario of the design not written yet, with the branch it waits on and why it has no body. */
export function pending(id: string, title: string, branches: string[], why: string) {
  test.todo(`${id} ${title} [${branches.join(", ")}] (${why})`);
}
