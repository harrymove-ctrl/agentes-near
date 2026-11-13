import { defineConfig } from "drizzle-kit";

// Used only by `bun run db:generate` to diff the schema into a new SQL migration.
// Generating migrations does not need a database connection.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  casing: "snake_case",
});
