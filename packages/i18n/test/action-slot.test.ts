import { expect, test } from "bun:test";
import de from "../src/locales/de.json";
import it from "../src/locales/it.json";
import pl from "../src/locales/pl.json";

// A tool's action is labelled as an imperative in these languages ("Aktualisiere …"): after a modal verb or a
// conjugated one it reads wrong ("wird Aktualisiere"), so the sentences that name it put it after a colon.
test("an approval's action comes after a colon where its label is an imperative", () => {
  for (const [code, words] of [
    ["de", de],
    ["it", it],
    ["pl", pl],
  ] as const)
    expect([code, words.approvals.review.grants.endsWith(": {{doing}}.")]).toEqual([code, true]);
  for (const [code, words] of [
    ["de", de],
    ["it", it],
  ] as const)
    expect([code, words.approval.always.noteRoutine]).toEqual([code, expect.stringContaining(": {{actions}}.")]);
});
