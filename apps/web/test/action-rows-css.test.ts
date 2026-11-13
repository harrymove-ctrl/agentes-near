import { expect, test } from "bun:test";
import { join, relative } from "node:path";
import { rules } from "./built-css";

const ROOT = join(import.meta.dir, "../../..");
const SOURCES = ["apps/web/src", "packages/ui/src"];
const files = (pattern: string) =>
  SOURCES.flatMap((dir) =>
    [...new Bun.Glob(pattern).scanSync({ cwd: join(ROOT, dir) })].map((file) => join(ROOT, dir, file)),
  );

/** The strings of a line's `className` value (a string, or an expression of strings), or all of a line continuing one. */
function classStrings(line: string) {
  const at = line.indexOf("className=");
  let scope = line;
  if (at >= 0) {
    let end = at + "className=".length;
    if (line[end] === "{")
      for (let depth = 0; end < line.length; end++) {
        if (line[end] === "{") depth++;
        else if (line[end] === "}" && --depth === 0) break;
      }
    else end = line.indexOf(line[end] ?? "", end + 1);
    scope = line.slice(at, end + 1);
  }
  return [...scope.matchAll(/(["'`])((?:(?!\1).)*)\1/g)].map((m) => (m[2] ?? "").split(/\s+|\$\{[^}]*\}/));
}

/**
 * The classes an action row carries: those given with `ac-actrow`, in the strings of the line that has it
 * (`className="settings-row ac-actrow"`, `cx(single ? "ag-rc" : "ag-rcg__it", "ac-actrow")`). A row given its
 * classes another way (over several lines, from a variable) needs `classStrings` to read that way too.
 */
async function rowClasses() {
  const found = new Set<string>();
  for (const file of files("**/*.{ts,tsx}"))
    for (const line of (await Bun.file(file).text()).split("\n")) {
      const strings = classStrings(line);
      if (!strings.some((classes) => classes.includes("ac-actrow"))) continue;
      for (const c of strings.flat()) if (/^[a-z][\w-]*[a-z\d]$/i.test(c) && c !== "ac-actrow") found.add(c);
    }
  return found;
}

/** What a selector styles: its last compound, without what its `:not()` and `:has()` say of other elements. */
function subject(selector: string) {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i] ?? "";
    if ("([".includes(c)) depth++;
    else if (")]".includes(c)) depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) start = i + 1;
  }
  let compound = selector.slice(start);
  for (let at = compound.search(/:(not|has)\(/); at >= 0; at = compound.search(/:(not|has)\(/)) {
    let end = compound.indexOf("(", at);
    for (let open = 0; end < compound.length; end++) {
      if (compound[end] === "(") open++;
      else if (compound[end] === ")" && --open === 0) break;
    }
    compound = compound.slice(0, at) + compound.slice(end + 1);
  }
  return compound;
}

test("an action row stays a row: no rule stacks an `.ac-actrow`, whose words' 24ch basis would become their height", async () => {
  const classes = await rowClasses();
  // Rows this reads today, so a change in how it reads them can't empty the list unseen.
  for (const known of ["settings-row", "rh-guidance", "roles-key", "imp-row", "ac-access__row"])
    expect([known, classes.has(known)]).toEqual([known, true]);
  const marks = [...classes].map((c) => new RegExp(`\\.${c}(?![\\w-])`));
  const stacked: string[] = [];
  for (const file of files("**/*.css"))
    for (const rule of rules(await Bun.file(file).text()))
      for (const [property, value] of rule.declarations)
        if (
          (property === "flex-direction" && /^column/.test(value)) ||
          (property === "flex-flow" && /\bcolumn/.test(value))
        )
          for (const selector of rule.selectors)
            if (marks.some((mark) => mark.test(subject(selector))))
              stacked.push(`${relative(ROOT, file)}: ${selector} {${property}: ${value}}`);
  // Where a design stacks a row's parts, the row wraps and the part on a line of its own takes `flex-basis: 100%`.
  expect(stacked).toEqual([]);
});
