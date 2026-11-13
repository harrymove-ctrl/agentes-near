import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
const src = (path: string) => readFileSync(join(SRC, path), "utf8");

describe("an agent's event proposal, on the phone too", () => {
  test("an agent's event proposal is a card in the conversation, confirmed or dropped there", () => {
    const card = src("features/ai/OfferCard.tsx");
    expect(card).toContain('card.kind === "calendar_proposal"');
    expect(card).toContain("useCalendarProposal");
  });
});
