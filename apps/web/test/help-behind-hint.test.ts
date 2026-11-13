import { expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";

const SRC = join(import.meta.dir, "../src");

/** Every opening tag of `name` in the app's code, as [file:line, the tag's text]. */
async function tags(name: string) {
  const out: [string, string][] = [];
  for await (const file of new Glob("**/*.tsx").scan(SRC)) {
    const text = await Bun.file(join(SRC, file)).text();
    for (const m of text.matchAll(new RegExp(`<${name}\\b`, "g"))) {
      // The tag runs to the first ">" outside braces.
      let depth = 0;
      let end = m.index ?? 0;
      for (; end < text.length; end++) {
        const c = text[end];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) break;
      }
      out.push([`${file}:${text.slice(0, m.index).split("\n").length}`, text.slice(m.index, end)]);
    }
  }
  return out;
}

test("what a setting or a field does goes behind its ⓘ: no help line under a field, a setting or a settings row", async () => {
  for (const name of ["Field", "PrefRow", "SettingRow", "AddressList", "CheckRow"]) {
    const found = (await tags(name)).filter(([, tag]) => /\shelp=/.test(tag)).map(([at]) => at);
    expect([name, found]).toEqual([name, []]);
  }
  expect((await tags("SettingRow")).filter(([, tag]) => /\sdescription=/.test(tag)).map(([at]) => at)).toEqual([]);
  const classes: string[] = [];
  for await (const file of new Glob("**/*.{tsx,css}").scan(SRC)) {
    const text = await Bun.file(join(SRC, file)).text();
    for (const old of ["settings-row__help", "ac-field__help", "ac-setrow__desc"])
      if (text.includes(old)) classes.push(`${file}: ${old}`);
  }
  expect(classes).toEqual([]);
});
