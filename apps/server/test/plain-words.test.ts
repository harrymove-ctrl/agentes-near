import { expect, test } from "bun:test";
import { join } from "node:path";
import { REMOVED_COMPUTER_MESSAGE } from "@agenteschat/engine";
import { MARKS, unplainServerWords } from "../../../packages/i18n/test/plain-marks";
import { missingLibrariesText } from "../runner/browser";
import { PAUSED } from "../runner/handlers";
import { STOPPING } from "../runner/supervisor";

const REPO = join(import.meta.dir, "..", "..", "..");

test("the API's and the runner's error words: no semicolon, no em dash", () => {
  const dirs = ["apps/server/src", "apps/server/runner", "packages/engine/src"];
  expect(unplainServerWords(dirs.map((d) => join(REPO, d)))).toEqual([]);
  // Passed by name, so the scan above doesn't read them.
  for (const words of [REMOVED_COMPUTER_MESSAGE, PAUSED, STOPPING, missingLibrariesText(["libnspr4.so"])]) {
    expect(words).not.toMatch(MARKS);
  }
});
