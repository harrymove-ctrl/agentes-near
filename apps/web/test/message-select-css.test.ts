import { describe, expect, test } from "bun:test";

const ROOT = new URL("../../../", import.meta.url).pathname;

/** Each rule's selectors and its `user-select`, comments left out. */
async function userSelect(path: string) {
  const css = (await Bun.file(ROOT + path).text()).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const [, list = "", body = ""] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const value = /(?:^|;)\s*user-select\s*:\s*([a-z]+)/.exec(body)?.[1];
    if (!value) continue;
    for (const selector of list.split(",")) out.set(selector.trim(), value);
  }
  return out;
}

describe("copying a message gives its text, never blank lines after it", () => {
  test("the row's chrome selects nothing; its text and its cards' text still select", async () => {
    const rules = await userSelect("packages/ui/src/styles/components.css");
    for (const selector of [
      ".ac-msg__head",
      ".ac-msg__foot",
      ".ac-msg__actions",
      ".ac-msg .ac-visually-hidden",
      ".ac-msg .ac-reacts",
      ".ac-msg .ac-receipt",
    ])
      expect([selector, rules.get(selector)]).toEqual([selector, "none"]);
    // A routine's report, a consulted agent's answer, a failure's reason: real text inside the row, copyable.
    for (const selector of [".ac-msg", ".ac-msg__body", ".ac-msg__text", ".ac-msg__error", ".cn-report"])
      expect([selector, rules.get(selector)]).toEqual([selector, undefined]);
  });
});
