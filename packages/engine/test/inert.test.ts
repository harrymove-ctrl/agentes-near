import { describe, expect, test } from "bun:test";
import { BREAK, inertText } from "../src/email/inert";

/** Mail text as a reader sees it: the hair spaces that keep typed text from linking left out. */
const readable = (s: string) => s.replaceAll(BREAK, "");
/** What a mail client could turn into a link: a separator joined to what follows it. */
const linkable = (s: string) => /[.:@\\](?=[\p{L}\p{N}/])/u.test(s.normalize("NFKC").replaceAll("。", "."));
/** What a mail app offers to call: seven digits joined only by spaces and punctuation. */
const dialable = (s: string) => /\p{Nd}(?:[^\p{L}\p{Nd}]{0,3}\p{Nd}){6,}/u.test(s.normalize("NFKC"));
const HIDDEN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

const LURES = [
  "Your account is locked, visit acme-support.com",
  "https://acme-support.com/login",
  "www.acme-support.com",
  "mailto:billing@acme-support.com",
  "Write to billing@acme-support.com",
  "acme-support.com",
  "acme-support。com",
  "ａｃｍｅ-support．com",
  "acme-sup\u200bport.com",
  "\u202emoc.troppus-emca\u202c",
  "Security notice\nVisit acme-support.com\n\nThe team",
  `${"Urgent: verify your account now. ".repeat(3)}acme-support.com`,
  "Account locked? Call +1 (888) 555-0199",
  "Ligue 0800 555 0199 para desbloquear",
  "Call ＋１ ８８８ ５５５ ０１９９",
  "Call 888ー555ー0199",
];

const REAL_NAMES = [
  "João & Conceição Ltda.",
  "O'Brien Labs",
  "acme.dev",
  "Turma 2025-2026",
  "株式会社テスト",
  "市场部：华东区",
  "شركة النور",
  "محمد\u200cرضا",
  "Ana ❤\ufe0f",
  "\u{1f469}\u{1f3fd}\u200d\u{1f4bb} Dev Team",
  "\u{1f3f3}\ufe0f\u200d\u{1f308} Pride",
];

describe("inertText", () => {
  test("leaves no link, invisible character or line break in any lure, and caps its length", () => {
    for (const lure of LURES) {
      const inert = inertText(lure);
      expect(linkable(inert) || dialable(inert), lure).toBe(false);
      expect(inert, lure).not.toMatch(HIDDEN);
      expect([...new Intl.Segmenter().segment(readable(inert))].length, lure).toBeLessThanOrEqual(64);
    }
    // The lures carry links before it runs.
    expect(LURES.filter((lure) => linkable(lure) || dialable(lure)).length).toBeGreaterThan(8);
  });

  test("keeps a name that looks like a domain readable, as one line; a sentence's last period stays as typed", () => {
    expect(inertText("acme.dev")).toBe(`acme.${BREAK}dev`);
    expect(inertText("Acme\n\nInc.")).toBe("Acme Inc.");
    expect(inertText("Só aceitamos pessoas do time de design por enquanto.")).toBe(
      "Só aceitamos pessoas do time de design por enquanto.",
    );
    expect(inertText("Zq9 evil.com")).toBe(`Zq9 evil.${BREAK}com`);
    expect(inertText('Deploy "v1.2" (staging).')).toBe(`Deploy "v1.${BREAK}2" (staging).`);
    expect(readable(inertText("ａｃｍｅ．dev"))).toBe("ａｃｍｅ．dev");
    expect(inertText("Café Ünïcode™")).toBe("Café Ünïcode™");
  });

  test("prints real names in any script as typed, emoji sequences and joiners included", () => {
    for (const name of REAL_NAMES) {
      expect(readable(inertText(name)), name).toBe(name);
      expect(linkable(inertText(name)), name).toBe(false);
    }
    // A joiner or a presentation selector anywhere else is no part of writing.
    expect(inertText("pay\u200dpal 1\ufe0f \u200c中")).toBe("paypal 1 中");
  });

  test("prints no phone number a mail app would dial, and keeps shorter numbers", () => {
    expect(inertText("Account locked? Call +1 (888) 555-0199")).toBe("Account locked? Call +1 (888) •••-••••");
    expect(inertText("Acme 2026 Q4, order 123456")).toBe("Acme 2026 Q4, order 123456");
  });

  test("prints a run that is exactly one date or one span of years as typed", () => {
    for (const typed of ["Newsletter 09/10/2026", "Turma 2025-2026", "2026-10-09", "9.10.2026", "Turma 2025–2026"]) {
      expect(readable(inertText(typed)), typed).toBe(typed);
      expect(linkable(inertText(typed)), typed).toBe(false);
    }
  });

  test("masks every other run", () => {
    for (const [typed, printed] of [
      ["1-888-555-0199", "1-888-•••-••••"],
      ["+55 11 3025-2026", "+55 11 ••••-••••"],
      ["13/13/2026", "13/13/••••"],
      ["2025-2040", "2025-••••"],
      ["Call 09/10/2026 555", "Call 09/10/•••• •••"],
      ["Edição 42 – 09/10/2026", "Edição 42 – 09/••/••••"],
      ["０９/１０/２０２６", "０９/１０/••••"],
      ["Turma 2024-2025 2025-2026", "Turma 2024-•••• ••••-••••"],
    ] as const) {
      expect(inertText(typed), typed).toBe(printed);
    }
    // A cut through a date leaves no seven of its digits.
    expect(readable(inertText(`${"x".repeat(53)} 2026-10-09 and more`))).toBe(`${"x".repeat(53)} 2026-••-•…`);
  });

  test("cuts on a whole character at its cap, and marks the cut", () => {
    const long = `${"🙂".repeat(64)}x`;
    expect(readable(inertText(long))).toBe(`${"🙂".repeat(63)}…`);
    expect(readable(inertText("x".repeat(64)))).toBe("x".repeat(64));
    expect(inertText("word ".repeat(24), 120)).toBe("word ".repeat(24).trimEnd());
    expect(inertText("word ".repeat(30), 120)).toBe(`${"word ".repeat(23)}word…`);
    // One letter under hundreds of combining marks is a single character.
    expect(inertText(`Z${"\u0336".repeat(500)}algo`)).toBe(`Z${"\u0336".repeat(4)}algo`);
    // So is a chain of emoji joiners or of Indic viramas, which the code point cap cuts.
    for (const chain of [`${"\u{1f469}\u200d".repeat(300)}x`, `${"क्".repeat(300)}x`]) {
      const inert = inertText(chain);
      expect(Array.from(readable(inert)).length).toBeLessThanOrEqual(4 * 64);
      expect(inert).toMatch(/[^\u200d]…$/u);
    }
  });

  test("a run of more than 30 characters with no break gets one, between whole characters", () => {
    const hash = "3f2a9c1e5b7d8f0a2c4e6b8d0f1a3c5e7b9d1f3a";
    const inert = inertText(`Deploy ${hash} to production`, 120);
    expect(inert).toBe(`Deploy ${hash.slice(0, 30)}${BREAK}${hash.slice(30)} to production`);
    expect(inert).not.toMatch(/\S{31}/u);
    // The breaks after separators count: "a.b.c…" needs no more.
    expect(inertText("a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p.q.r")).not.toContain(`${BREAK}${BREAK}`);
    const emoji = "\u{1f469}\u{1f3fd}\u200d\u{1f4bb}".repeat(31);
    expect(readable(inertText(emoji))).toBe(emoji);
    expect([...new Intl.Segmenter().segment(inertText(emoji))].map((s) => s.segment)).toContain(BREAK);
  });
});
