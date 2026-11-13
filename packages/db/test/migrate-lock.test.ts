import { expect, test } from "bun:test";
import postgres from "postgres";
import { createDatabase, MIGRATIONS_LOCK } from "../src/client";

/** A real server only (`TEST_DATABASE_URL`): the built-in database is one process's and takes no lock. */
const server = process.env.TEST_DATABASE_URL;

test.skipIf(!server)("processes booting together take turns on the migrations: each one is recorded once", async () => {
  const admin = postgres(server as string, { max: 1, onnotice: () => {} });
  const name = `agenteschat_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`create database ${name}`);
  const url = new URL(server as string);
  url.pathname = `/${name}`;
  const holder = postgres(url.toString(), { max: 1, onnotice: () => {} });
  // A pool of one, as the scripts open: the lock must not take the connection the migrations need.
  const processes = [0, 1].map(() => createDatabase({ url: url.toString(), poolMax: 1 }));
  try {
    await holder`select pg_advisory_lock(${MIGRATIONS_LOCK}::bigint)`;
    const runs = processes.map((p) => p.migrate());
    await Bun.sleep(300);
    const [before] = await holder`select to_regclass('drizzle.__drizzle_migrations') as t`;
    expect(before?.t).toBeNull();
    await holder`select pg_advisory_unlock(${MIGRATIONS_LOCK}::bigint)`;
    await Promise.all(runs);
    const [row] =
      await holder`select count(*)::int as n, count(distinct hash)::int as kinds from drizzle.__drizzle_migrations`;
    expect(row?.n).toBeGreaterThan(0);
    expect(row?.n).toBe(row?.kinds);
  } finally {
    await holder.end({ timeout: 5 });
    for (const p of processes) await p.close();
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end({ timeout: 5 });
  }
});
