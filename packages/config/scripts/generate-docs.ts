/**
 * Regenerates `.env.example` from `src/schema.ts`. Run with `bun run docs:env`
 * from the repo root. `--check` exits non-zero when the file is stale (also
 * asserted by the config tests, so CI catches it).
 */
import { resolve } from "node:path";
import { type EnvVarDefinition, envVars } from "../src/schema";

const root = resolve(import.meta.dir, "../../..");
const envExamplePath = resolve(root, ".env.example");

const entries = Object.entries(envVars) as [string, EnvVarDefinition][];
const sections = [...new Set(entries.map(([, d]) => d.section))];

function defaultOf(def: EnvVarDefinition): string | undefined {
  const parsed = def.schema.safeParse(undefined);
  return parsed.success && parsed.data !== undefined ? String(parsed.data) : undefined;
}

const isRequired = (def: EnvVarDefinition) => !def.schema.safeParse(undefined).success;

function renderEnvExample(): string {
  const lines = [
    "# Generated from packages/config/src/schema.ts — do not edit by hand.",
    "# Run `bun run docs:env` after changing the schema.",
    "# Copy to `.env` and fill in the required values. Tests never read this file.",
    "",
  ];
  for (const section of sections) {
    lines.push(`# ── ${section} ${"─".repeat(Math.max(0, 60 - section.length))}`, "");
    for (const [name, def] of entries.filter(([, d]) => d.section === section)) {
      const fallback = defaultOf(def);
      const required = isRequired(def);
      lines.push(`# ${def.description.replaceAll("**", "").replaceAll("`", "")}`);
      if (def.example) lines.push(`# Example: ${def.example}`);
      lines.push(required ? "# Required." : fallback === undefined ? "# Optional." : `# Default: ${fallback}`);
      lines.push(`${required ? "" : "# "}${name}=${required ? "" : (fallback ?? "")}`, "");
    }
  }
  return lines.join("\n");
}

const content = renderEnvExample();

if (process.argv.includes("--check")) {
  const file = Bun.file(envExamplePath);
  if (!(await file.exists()) || (await file.text()) !== content) {
    console.error(`Stale generated file (run \`bun run docs:env\`): ${envExamplePath}`);
    process.exit(1);
  }
} else {
  await Bun.write(envExamplePath, content);
  console.log("Wrote .env.example");
}
