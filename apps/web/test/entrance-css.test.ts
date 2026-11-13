import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, rules, topLevel } from "./built-css";

// A password manager placing its icon in a field sets `animation: none !important` on the field's container and then
// removes it (Proton Pass), which replays a keyframe entrance there on every keystroke that empties or fills the
// field. The entrances run as transitions from `@starting-style` instead: once, when the step is inserted.
test.each([
  [
    ["src/components/auth.css", "src/components/invite/invite.css"],
    [".auth__bubble", ".auth__step", ".auth__fix"],
  ],
  [["src/pages/onboarding.css"], [".onb__body", ".onb__say", ".onb__answer", ".onb__actions"]],
])(
  "%p: each step's entrance plays once, from its starting style, never as a keyframe animation",
  async (files, selectors) => {
    const css = await builtCss(...files);
    for (const selector of selectors) {
      const own = declarations(topLevel(css), selector);
      expect(own.some(([p, v]) => p === "transition" && v.includes("opacity"))).toBe(true);
      expect(declarations(atRule(css, "@starting-style"), selector)).toContainEqual(["opacity", "0"]);
      // Nor anywhere else that styles it (the invite dialog's sent screen times the host's bubble and the answer).
      const styling = rules(css).filter((r) => r.selectors.some((s) => s.endsWith(selector)));
      expect(styling.flatMap((r) => r.declarations).filter(([p]) => p.startsWith("animation"))).toEqual([]);
    }
  },
);
