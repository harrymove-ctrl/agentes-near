import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { migrationsFolder } from "../src/client";
import {
  appliedMigrations,
  assertMigrationsMatch,
  checkMigrations,
  knownMigrations,
  MigrationMismatchError,
} from "../src/migration-guard";
import { createTestDatabase } from "./pglite";

const known = [
  { tag: "0000_init", hash: "a", when: 1 },
  { tag: "0001_more", hash: "b", when: 2 },
];

test("matching, pending, changed and newer-database cases", () => {
  expect(checkMigrations([{ hash: "a", createdAt: 1 }], known)).toBeNull(); // one pending: fine
  expect(checkMigrations([], known)).toBeNull();
  expect(checkMigrations([{ hash: "x", createdAt: 1 }], known)).toContain("Migration 0000_init was changed");
  expect(checkMigrations([{ hash: "a", createdAt: 9 }], known)).toContain("0000_init"); // journal date changed
  expect(
    checkMigrations(
      [
        { hash: "a", createdAt: 1 },
        { hash: "b", createdAt: 2 },
        { hash: "c", createdAt: 3 },
      ],
      known,
    ),
  ).toContain("migrated by a newer version");
  // A migration merged after a newer one with its own older date: drizzle would skip it.
  const late = [...known, { tag: "0002_late", hash: "c", when: 2 }];
  expect(checkMigrations([{ hash: "a", createdAt: 1 }], late)).toContain("0002_late is dated before 0001_more");
});

test("a migrated test database matches this build; tampering is refused before migrating", async () => {
  const { db, close } = await createTestDatabase();
  try {
    const files = knownMigrations(migrationsFolder);
    expect((await appliedMigrations(db)).length).toBe(files.length);
    await assertMigrationsMatch(db, migrationsFolder);

    // A migration file changed after it was applied (here: the record of it).
    await db.execute(
      sql`update drizzle.__drizzle_migrations set hash = 'changed' where created_at = ${files[3]?.when ?? 0}`,
    );
    const changed = await assertMigrationsMatch(db, migrationsFolder).catch((e) => e);
    expect(changed).toBeInstanceOf(MigrationMismatchError);
    expect(String(changed.message)).toContain(files[3]?.tag ?? "");
    await db.execute(
      sql`update drizzle.__drizzle_migrations set hash = ${files[3]?.hash ?? ""} where hash = 'changed'`,
    );

    // The database was migrated by a newer build.
    await db.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('future', 99999999999999)`,
    );
    await expect(assertMigrationsMatch(db, migrationsFolder)).rejects.toThrow("newer version");
  } finally {
    await close();
  }
});

test("journal dates only grow (the migrator skips a migration dated before the last applied one)", () => {
  const files = knownMigrations(migrationsFolder);
  for (let i = 1; i < files.length; i++) {
    const prev = files[i - 1];
    const cur = files[i];
    if (!prev || !cur) continue;
    expect({ tag: cur.tag, after: cur.when > prev.when }).toEqual({ tag: cur.tag, after: true });
  }
});
