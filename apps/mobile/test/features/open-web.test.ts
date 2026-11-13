import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
const src = (path: string) => readFileSync(join(SRC, path), "utf8");

describe("a screen the app has opens in the app", () => {
  test("a screen the app has opens here: Abrir cards, the AI step's computer and links in messages", () => {
    for (const file of ["features/ai/OfferCard.tsx", "features/me/DeleteAccountScreen.tsx"]) {
      expect([file, src(file).includes("openWebPath")]).toEqual([file, true]);
    }
    // The AI step's computer has its own screen in the app now.
    expect(src("features/ai/ConnectAi.tsx")).toContain('router.push("/computer-setup" as never)');
    for (const file of [
      "features/ai/OfferCard.tsx",
      "features/ai/ConnectAi.tsx",
      "features/me/DeleteAccountScreen.tsx",
    ]) {
      expect([file, /openPage\(`\$\{serverUrl\(\)\}\/org\//.test(src(file))]).toEqual([file, false]);
    }
    expect(src("features/chat/MessageSpans.tsx")).toContain("ownLinkHref(");
  });
});
