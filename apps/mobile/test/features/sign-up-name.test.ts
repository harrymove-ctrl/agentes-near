import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { looksLikePassword, nameIsPassword } from "@agenteschat/client/lib/text";

/* Every phone flow that makes an account (or a request that becomes one) refuses a password equal to the name. */

const source = (file: string) => readFileSync(join(import.meta.dir, "../../src/features/auth", file), "utf8");
const GUARD =
  /nameIsPassword\(name, password\)\) \{\s*(?:\/\/[^\n]*\s*)?setPassword\(""\);\s*go\("name"\);\s*setError\(t\("auth\.flow\.nameIsPassword"\)\);/;
// An invite asks the name and the password on one step: the password is cleared there, with the name in view.
const GUARD_SAME_STEP =
  /step === "you" && nameIsPassword\(name, password\)\) \{\s*setPassword\(""\);\s*setError\(t\("auth\.flow\.nameIsPassword"\)\);/;

describe("a password typed as the name, on the phone", () => {
  for (const [file, rule, onward] of [
    ["AuthFlow.tsx", GUARD, "void signUp()"],
    ["EmailSteps.tsx", GUARD, "void signUp()"],
    ["LinkSteps.tsx", GUARD_SAME_STEP, "void ask()"],
  ] as const)
    test(`${file}: back on the name before the account, and the soft hint on the name`, () => {
      const code = source(file);
      const guard = code.search(rule);
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(code.indexOf(onward, guard));
      expect(code).toContain("<NameHint name={name} />");
    });

  test("what the guard and the hint go by", () => {
    expect(nameIsPassword("Fake#Pass1", "Fake#Pass1")).toBe(true);
    expect(nameIsPassword("Ana Souza", "Fake#Pass1")).toBe(false);
    expect(looksLikePassword("Fake#Pass1")).toBe(true);
    expect(looksLikePassword("Ana 2")).toBe(false);
  });
});
