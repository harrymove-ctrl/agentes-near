import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("what breaks outside (app)'s own boundary gets ScreenError with Tentar de novo, never the app closing", () => {
  const layout = readFileSync(join(import.meta.dir, "../app/_layout.tsx"), "utf8");
  // Under the providers (its theme and words), above the gate: the auth screens and the overlays outside the Stack.
  expect(layout).toMatch(
    /<AppProviders>\s*<ErrorBoundary fallback=\{\(error, reset\) => <ScreenError error=\{error as Error\} retry=\{async \(\) => reset\(\)\} \/>\}>\s*<Gate \/>\s*<\/ErrorBoundary>\s*<\/AppProviders>/,
  );
});
