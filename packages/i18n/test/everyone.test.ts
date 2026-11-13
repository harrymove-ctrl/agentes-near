import { expect, test } from "bun:test";
import { EVERYONE_WORD, everyoneWord, mentionsEveryone } from "../src/everyone";
import { STRINGS } from "../src/index";
import { LOCALE_CODES } from "../src/locale";

test("each language says its own word for everyone where the permission tells what it does", () => {
  for (const code of LOCALE_CODES) {
    const word = EVERYONE_WORD[code];
    const desc = (STRINGS[code] as { permissions?: { mention_everyone?: { desc?: string } } }).permissions
      ?.mention_everyone?.desc;
    expect(desc, code).toContain(`@${word}`);
    expect(mentionsEveryone(`@${word} ok`), code).toBe(true);
  }
  expect(everyoneWord("xx")).toBe("everyone");
});
