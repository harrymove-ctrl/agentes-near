import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { internalNotes, isPrivate } from "./check-boundaries";

test("only the listed docs, the prototypes and the team's rules are forbidden here", () => {
  for (const path of [
    "docs/planejamento.md",
    "docs/prototipo/a.html",
    "docs/design/telas/A.html",
    ".claude/rules/internal-docs.md",
  ]) {
    expect(isPrivate(path)).toBe(true);
  }
  for (const path of [
    "CLAUDE.md",
    "docs/adr/0002-editions-and-modules.md",
    "docs/design/README.md",
    "docs/planejamento.md.bak",
  ]) {
    expect(isPrivate(path)).toBe(false);
  }
});

test("a planning decision id in running text is caught", () => {
  const prose = [
    "The inbox (D46): mentions",
    "// D60: our tools",
    "Implements planejamento D18a.",
    "D9–D13",
    "D58's step 2",
    "(D18/D20 in planning)",
    "D104: the next hundred",
  ];
  for (const line of prose) expect(internalNotes(line)).toHaveLength(1);
  expect(internalNotes("ok\n(D33, revised by D45)\nok")).toEqual([
    "2: cites a planning decision id: cite the ADR or state the reason itself",
  ]);
});

test("ids in code, data and product names are not decision ids", () => {
  const lines = [
    "Workers, KV, R2 and D1 of the account.",
    "R2 e D1 da conta.",
    "Workers, KV, R2 und D1 des Kontos.",
    "Workers, KV, R2, D1 보기",
    "Workers, KV, R2 и D1 аккаунта.",
    "color: #D1D5DB;",
    "sha512-ab/D45+x==",
    "sha512-ab/D45/x==",
    "D2C",
    "3D",
  ];
  for (const line of lines) expect(internalNotes(line)).toEqual([]);
});

test("pointers to the private docs, prototype screens and artifacts are caught", () => {
  const lines = [
    "(telas/Example.html, C)",
    "Copy follows docs/design/telas exactly.",
    "Example.dc.html: the home",
    "see docs/planejamento.md",
    "https://claude.ai/artifact/abc",
  ];
  for (const line of lines) expect(internalNotes(line).length).toBeGreaterThan(0);
  const fine = [
    "help.yahoo.com/kb/SLN4075.html",
    "apps/web/index.html",
    "Faz telas e protótipos.",
    "Planejamento da sprint",
  ];
  for (const line of fine) expect(internalNotes(line)).toEqual([]);
});

test("a hashed word is caught in any case, alone or in a hyphenated name, never inside another word", () => {
  const words = new Set([createHash("sha256").update("acmecorp").digest("hex")]);
  expect(internalNotes("Same split as AcmeCorp's dashboard", words)).toHaveLength(1);
  expect(internalNotes("the acmecorp-cloud repo", words)).toHaveLength(1);
  expect(internalNotes("acmecorporation", words)).toEqual([]);
});
