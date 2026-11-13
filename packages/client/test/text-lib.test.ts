import { expect, test } from "bun:test";
import { plainLine, plainLines } from "../src/lib/markdown";
import {
  around,
  emailTypoFix,
  excerpt,
  holdsText,
  jwtEmail,
  looksLikePassword,
  matchesName,
  nameIsPassword,
  webmailOf,
} from "../src/lib/text";

test("a name typed to confirm: case, extra spaces, width forms and invisible characters aside, never a part", () => {
  expect(matchesName(" new  AGENT ", "New agent")).toBe(true);
  expect(matchesName("Jose\u0301", "José")).toBe(true);
  expect(matchesName("Ａｃｍｅ", "Acme")).toBe(true);
  // A zero-width space or a soft hyphen put in the name can't make it untypeable.
  expect(matchesName("Acme Corp", "Ac\u200Bme Cor\u00ADp")).toBe(true);
  expect(matchesName("Acme \u200B Corp", "acme corp")).toBe(true);
  expect(matchesName("New", "New agent")).toBe(false);
  expect(matchesName("New agent 2", "New agent")).toBe(false);
  expect(matchesName("", "Acme")).toBe(false);
  // A name of nothing but those needs nothing typed.
  expect(matchesName("", "\u200B\u2060")).toBe(true);
});

test("a misspelled webmail domain gets one fix; anything else is left alone", () => {
  expect(emailTypoFix("Marina@Gmial.com ")).toBe("marina@gmail.com");
  expect(emailTypoFix("ana@hotmail.con")).toBe("ana@hotmail.com");
  expect(emailTypoFix("ana@uol.com")).toBe("ana@uol.com.br");
  expect(emailTypoFix("ana@gmail.com")).toBeNull();
  expect(emailTypoFix("ana@acme.com.br")).toBeNull();
  expect(emailTypoFix("ana")).toBeNull();
  expect(emailTypoFix("a@b@gmial.com")).toBeNull();
});

test("a value put into a sentence: what comes before and after its last place there", () => {
  expect(around("Passo 2 de 4 · Limpando para começar do zero", "Limpando para começar do zero")).toEqual([
    "Passo 2 de 4 · ",
    "",
  ]);
  expect(around("Step 2 · Starting it up, then Starting it up", "Starting it up")).toEqual([
    "Step 2 · Starting it up, then ",
    "",
  ]);
  expect(around("Faltam uns 6 min", "6")).toEqual(["Faltam uns ", " min"]);
  expect(around("Faltam uns 6 min", "7")).toBeNull();
  expect(around("Faltam uns 6 min", "")).toBeNull();
});

test("the webmail to open after sending an e-mail", () => {
  expect(webmailOf("ana@gmail.com")?.name).toBe("Gmail");
  expect(webmailOf("ana@hotmail.com")?.name).toBe("Outlook");
  expect(webmailOf("ana@icloud.com")?.name).toBe("iCloud Mail");
  expect(webmailOf("ana@yahoo.com.br")?.name).toBe("Yahoo Mail");
  expect(webmailOf("ana@acme.com.br")).toBeNull();
});

test("a text's start: whole sentences and lines while they fit, never a stop before the ellipsis", () => {
  const ada =
    "Investigates first: reads the code and the related tasks and errors before answering, and comes back with what it found and a concrete PR proposal with a test.\nWorks in branches and opens small PRs. For big changes, opens the PR as a draft and explains the plan there.\nNever merges alone: asks a person for review.";
  const start = excerpt(ada, 280);
  expect(start).toEndWith("explains the plan there.");
  expect(start.split("\n")).toHaveLength(2);
  expect(start).not.toContain("…");
  // Short enough: the whole text, as it is.
  expect(excerpt("  Answers support tickets.  ", 280)).toBe("Answers support tickets.");
  // A line with no full stop ends where the line does; a list's items are lines without their marks.
  expect(excerpt("- Reads the tickets\n- Answers with sources\n- Hands off refunds to a person", 45)).toBe(
    "Reads the tickets\nAnswers with sources",
  );
  // Never more than its lines, however short they are.
  const list = Array.from({ length: 10 }, (_, i) => `${i + 1}. Step ${i + 1}`).join("\n");
  expect(excerpt(list, 280)).toBe("Step 1\nStep 2\nStep 3");
  expect(excerpt(list, 280, 1)).toBe("Step 1");
  // One sentence longer than the room: cut at a word, the mark after it, never after a comma.
  expect(excerpt("Reads every ticket, the customer's history and the help center before it answers", 40)).toBe(
    "Reads every ticket, the customer's…",
  );
  // A number's dot isn't a sentence's end.
  expect(excerpt("Keeps version 2.5 of the API working until March and then moves everyone to 3.0 for good", 30)).toBe(
    "Keeps version 2.5 of the API…",
  );
});

test("instructions in Markdown read as plain words: past headings and rules, without marks", () => {
  const soul = [
    "# SOUL.md - Who You Are",
    "",
    "_You're not a chatbot. You're becoming someone._",
    "",
    "## Core Truths",
    "",
    '**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" and just help. Actions speak louder than filler words.',
    "",
    "**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring.",
    "",
    "---",
    "",
    "Read the [style guide](https://example.com/guide) first.",
  ].join("\n");
  const page = excerpt(soul, 280);
  expect(page).toStartWith("You're not a chatbot. You're becoming someone.\nBe genuinely helpful, not performatively");
  expect(page).toEndWith("amusing or boring.");
  expect(page).not.toMatch(/[#_*…]/);
  expect(excerpt(soul, 240)).toEndWith("filler words.\nHave opinions.");
  // The team card's line: the first one, in whole sentences.
  expect(excerpt(soul, 160, 1)).toBe("You're not a chatbot. You're becoming someone.");
  expect(plainLines(soul).at(-1)).toBe("Read the style guide first.");
  expect(
    plainLines(
      "> Run `pg_query` on my_table, see ![the map](map.png) and [[Processos/Onboarding|o onboarding]].\n\n```\nrm -rf /\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
    ),
  ).toEqual(["Run pg_query on my_table, see the map and o onboarding."]);
});

test("the address in an ID token's email claim, whatever its base64url and padding; nothing from anything else", () => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = (claims: unknown) => `${part({ alg: "RS256", kid: "k" })}.${part(claims)}.c2ln`;
  // "???>>>" puts "_" and "-" (base64url's own) in the payload; the others leave out each length of padding.
  for (const nonce of ["???>>>", "a", "ab", "abc"]) {
    expect(jwtEmail(token({ nonce, email: "ana@icloud.com", email_verified: "true" }))).toBe("ana@icloud.com");
  }
  expect(jwtEmail(token({ sub: "001" }))).toBeUndefined();
  expect(jwtEmail(token({ email: "not an address" }))).toBeUndefined();
  expect(jwtEmail(token(null))).toBeUndefined();
  expect(jwtEmail("not.a-token!")).toBeUndefined();
  expect(jwtEmail("")).toBeUndefined();
});

test("holdsText: the same words, spacing aside, never a word cut in the middle", () => {
  expect(holdsText("Achei: o painel.\n\nPreciso da sua sessão.", "Achei: o painel. Preciso  da sua sessão.")).toBe(
    true,
  );
  expect(holdsText("Vou ver. Depois te conto.", "Vou ver.")).toBe(true);
  expect(holdsText("Vou verificar o painel.", "Vou ver")).toBe(false);
  expect(holdsText("Okay, feito.", "Ok")).toBe(false);
  expect(holdsText("Outra coisa.", "Vou ver.")).toBe(false);
});

test("holdsText: a long piece of the text is in it even where it was cut mid-word", () => {
  const whole =
    "Se você me passar o `build.gradle`, eu respondo com base neles. Quando o acesso for liberado, eu retomo.";
  expect(holdsText(whole, whole.slice(whole.indexOf("dle`")))).toBe(true);
  expect(holdsText(whole, whole.slice(0, whole.indexOf("eles.")))).toBe(true);
});

test("a name that looks like a password: no space, a digit and a symbol; real names never", () => {
  for (const name of ["Fake#Pass1", "S3nh@forte", " hunter2!xyz ", "P4ss#word", "كلمة١٢٣$سر"])
    expect(looksLikePassword(name)).toBe(true);
  for (const name of [
    "Ana 2",
    "Ana",
    "José da Silva",
    "Jean-Luc",
    "O'Neil",
    "D’Ávila",
    "Dr. Müller",
    "Ana-Clara2",
    "Nguyễn Văn An",
    "李小龙",
    "محمد بن سلمان",
    "Владимир",
    "ジョン・スミス2世",
    "Gal·la2024x",
    "J.R.R.Tolkien3",
    "R2-D2",
    "Fake#Pass1 Souza",
    "abc$1",
    "",
  ])
    expect(looksLikePassword(name)).toBe(false);
});

test("the password chosen is the name typed: trimmed, exact, never an empty name", () => {
  expect(nameIsPassword("Fake#Pass1 ", "Fake#Pass1")).toBe(true);
  expect(nameIsPassword("Fake#Pass1", "admin$10")).toBe(false);
  expect(nameIsPassword("Ana Souza", "outra-senha-1")).toBe(false);
  expect(nameIsPassword("  ", "  ")).toBe(false);
});

test("plainLine: a message's words on one line, every mark gone, code and tables included", () => {
  expect(plainLine("**Das 31 clínicas**, 14 _não_ [confirmaram](https://x.co) @ana")).toBe(
    "Das 31 clínicas, 14 não confirmaram @ana",
  );
  expect(plainLine("## Faltas\n\n- `Sorriso`\n- Aurora\n\n> dito ontem\n\n---")).toBe(
    "Faltas Sorriso Aurora dito ontem",
  );
  expect(plainLine("Veja:\n\n```sql\nselect 1\nfrom a\n```\nFim")).toBe("Veja: select 1 from a Fim");
  expect(plainLine("| Clínica | Faltas |\n| --- | ---: |\n| Sorriso | 23 |")).toBe("Clínica Faltas Sorriso 23");
});

test("plainLine: a collapsed block, a checklist and a lone ** in a sentence", () => {
  expect(plainLine("<details><summary>Ver **mais**</summary>\n\ncorpo\n\n</details>")).toBe("Ver mais corpo");
  expect(plainLine("<details><summary>Cortado")).toBe("Cortado");
  expect(plainLines("<details><summary>Ver mais</summary>\n\ncorpo\n\n</details>")).toEqual(["Ver mais", "corpo"]);
  expect(plainLine("- [ ] fazer\n- [x] feito")).toBe("fazer feito");
  expect(plainLine("2 ** 3 = 8")).toBe("2 ** 3 = 8");
});

test("plainLine: given what will show, it reads no further", () => {
  expect(plainLine(`curto ${"longo ".repeat(100)}`, 10).length).toBeLessThanOrEqual(80);
});

test("plainLine: a text cut in the middle leaves no half marks", () => {
  expect(plainLine("```sql\nselect nome from cli")).toBe("select nome from cli");
  expect(plainLine("Antes **negrito cortad")).toBe("Antes negrito cortad");
  expect(plainLine("| Clínica | Faltas |\n| --- | --")).toBe("Clínica · Faltas");
});
