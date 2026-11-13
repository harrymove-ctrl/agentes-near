import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrateInSteps, migrationsFolder } from "../src/client";

const migrations = readMigrationFiles({ migrationsFolder });
/** 0215 adds channel_kind's `task`, and 0229 uses it: a server from before 0215 meets both in one update. */
const beforeTask = migrations.findIndex((m) => m.sql.some((s) => s.includes("ADD VALUE 'task'")));

test("a database several versions behind migrates in one go, enum values added and used on the way", async () => {
  expect(beforeTask).toBeGreaterThan(0);
  const pg = new PGlite({ extensions: { vector } });
  const db = drizzle(pg);
  try {
    await migrateInSteps(db, migrationsFolder, beforeTask);
    // Drizzle's own migrate runs them all in one transaction, which Postgres refuses.
    const refused = await migrate(db, { migrationsFolder }).then(
      () => "",
      (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
    );
    expect(refused).toContain('unsafe use of new value "task"');
    await migrateInSteps(db, migrationsFolder);
    const { rows } = await pg.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations");
    expect(rows[0]?.n).toBe(migrations.length);
  } finally {
    await pg.close();
  }
}, 180_000);
