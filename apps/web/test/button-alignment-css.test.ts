import { expect, test } from "bun:test";
import path from "node:path";
import { Glob } from "bun";
import { builtCss, declarations, rules } from "./built-css";

const ROOT = path.join(import.meta.dir, "../../..");
const SOURCES = ["apps/web/src", "packages/ui/src"];
/** A selector whose subject is a kit button: `.ac-btn` in its last compound. */
const BUTTON = /\.ac-btn(?![\w-])[^\s>+~]*$/;

test("a button centres its icon and words; only the rows dressed as buttons start at the left", async () => {
  const left: string[] = [];
  for (const dir of SOURCES)
    for await (const file of new Glob("**/*.css").scan(path.join(ROOT, dir)))
      for (const rule of rules(await Bun.file(path.join(ROOT, dir, file)).text()))
        if (rule.declarations.some(([p, v]) => p === "justify-content" && v !== "center"))
          left.push(...rule.selectors.filter((s) => BUTTON.test(s)));
  // The sidebar's "Criar agente" lines up with the rows around it. A board column adds a task from its head's "+".
  expect(left.sort()).toEqual([".sidebar__create.ac-btn"]);
});

test("the sign-in's 'Último usado' ships as a centred line under its provider's button", async () => {
  const css = await builtCss("src/components/auth.css");
  expect(declarations(css, ".auth-social__last")).toContainEqual(["justify-content", "center"]);
});
