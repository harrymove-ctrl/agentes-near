/**
 * New migrations keep the running version working, run in CI via `bun run check:migrations`. A deploy migrates
 * while the previous version still serves (deploy/deploy.sh), and a rollback runs that version on the migrated
 * database, so a migration may not take away or change what it reads, nor require what it doesn't write. A
 * statement that drops, renames, changes a column's type, sets NOT NULL or adds a NOT NULL column without a default
 * goes in only once no running version reads (or writes) the object, with a comment that says so on the line before
 * it or at the end of its own line:
 *   -- deploy-safe: nothing reads "delayed_at" since the release before this one
 *   ALTER TABLE "machine_provisioning" DROP COLUMN "delayed_at";
 */
import { basename } from "node:path";
import { Glob } from "bun";

/** Migrations up to this number came before the check. */
export const CHECKED_AFTER = 119;
/**
 * Merged without their markers and already applied: a server refuses to start on a migration whose text changed
 * (packages/db/src/migration-guard.ts), so the markers can't be added now. 0130 (ADR 0085) turns "admin" into a role.
 */
const SHIPPED_UNMARKED = new Set(["0130_roles.sql"]);

const MARKER = /^--\s*deploy-safe:\s*\S/;

const UNSAFE: [RegExp, string][] = [
  // DROP NOT NULL only relaxes a column: what the previous version reads and writes still works.
  [/\bDROP\b(?!\s+NOT\s+NULL\b)/i, "drops"],
  [/\bRENAME\b/i, "renames"],
  [/\bALTER\s+(?:COLUMN\s+)?(?:""|\w+)\s+(?:SET\s+DATA\s+)?TYPE\b/i, "changes a column's type"],
  [/\bSET\s+NOT\s+NULL\b/i, "sets NOT NULL"],
  // The previous version's inserts don't name the new column: it has to fill itself.
  [
    /\bADD\s+COLUMN\b(?![^;]*\b(?:DEFAULT|GENERATED|serial|bigserial|smallserial)\b)[^;]*\bNOT\s+NULL\b/i,
    "adds a NOT NULL column without a default",
  ],
];

/** Text, quoted names and comments: their words aren't SQL. */
const NOT_SQL = /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*/g;

/** The statements of a migration that a running version may break on, unmarked, as `line: what it does`. */
export function unsafeStatements(sql: string): string[] {
  const hits: string[] = [];
  // A statement ends at a `;` that isn't in text, a name or a comment, and takes a comment after it on its line
  // along (a marker there is that statement's own). Blanking those keeps every offset where it was.
  const blank = sql.replace(NOT_SQL, (m) => m.replace(/[^\n]/g, " "));
  const ends = [...blank.matchAll(/;[ \t]*$|;/gm)].map((m) => m.index + m[0].length);
  let start = 0;
  let line = 1;
  for (const end of [...ends, sql.length]) {
    const statement = sql.slice(start, end);
    start = end;
    if (!(statement.match(NOT_SQL) ?? []).some((m) => MARKER.test(m))) {
      // Line breaks stay where they were, so a hit's line is right.
      const code = statement.replace(NOT_SQL, (m) =>
        m.startsWith("--") ? "" : `${m[0]}${m.replace(/[^\n]/g, "")}${m[0]}`,
      );
      for (const [pattern, what] of UNSAFE) {
        const hit = pattern.exec(code);
        if (hit) hits.push(`${line + (code.slice(0, hit.index).match(/\n/g)?.length ?? 0)}: ${what}`);
      }
    }
    line += statement.match(/\n/g)?.length ?? 0;
  }
  return hits;
}

/**
 * Journal entries whose `when` isn't later than the one before. Drizzle applies only migrations newer than the last
 * applied one's `when`, so an older one landing after it is skipped on databases already past it, silently.
 */
export function outOfOrderEntries(entries: { tag: string; when: number }[]): string[] {
  return entries.filter((e, i) => i > 0 && e.when <= (entries[i - 1] as { when: number }).when).map((e) => e.tag);
}

if (import.meta.main) {
  const journal = await Bun.file("packages/db/migrations/meta/_journal.json").json();
  const late = outOfOrderEntries(journal.entries);
  if (late.length > 0) {
    console.error(
      `Drizzle skips a migration older than the last one applied. These journal entries aren't newer than the one before them (regenerate them on top): ${late.join(", ")}`,
    );
    process.exit(1);
  }
  const problems: string[] = [];
  for (const file of [...new Glob("packages/db/migrations/*.sql").scanSync()].sort()) {
    if (Number.parseInt(basename(file), 10) <= CHECKED_AFTER || SHIPPED_UNMARKED.has(basename(file))) continue;
    for (const hit of unsafeStatements(await Bun.file(file).text())) problems.push(`${file}:${hit}`);
  }
  if (problems.length > 0) {
    console.error(
      "A deploy migrates while the previous version still serves, and a rollback runs it on the migrated database." +
        " These statements take away or change what a running version may read, or require what it doesn't write:",
    );
    console.error(problems.join("\n"));
    console.error(
      "Deploy the code that stops reading it (or that writes the new column) first. Then a later migration does it," +
        " with a comment on the line before it or at the end of its line: -- deploy-safe: <why no running version" +
        " needs it>",
    );
    process.exit(1);
  }
  console.log("migrations ok");
}
