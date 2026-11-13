import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { serializeDates } from "../src/client";

describe("a Date bound beside a raw sql expression", () => {
  test("goes to postgres.js as text, for every date type; strings from column encoders stay as they are", () => {
    const client = postgres("postgres://nobody@localhost:1/none");
    drizzle(client);
    serializeDates(client);
    const at = new Date("2026-11-06T12:00:00.000Z");
    for (const type of [1082, 1114, 1184]) {
      expect(client.options.serializers[type]?.(at)).toBe("2026-11-06T12:00:00.000Z");
      expect(client.options.serializers[type]?.("2026-01-01")).toBe("2026-01-01");
    }
  });
});
