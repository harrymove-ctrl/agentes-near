import { join } from "node:path";
import { build } from "vite";

const WEB = join(import.meta.dir, "..");

/**
 * Stylesheets as the production build writes them: Vite's own CSS pipeline (its minifier and targets). The app's
 * own unless `inputs` names others (paths under apps/web, a page's or a component's), built together.
 */
export async function builtCss(...inputs: string[]) {
  const out = await build({
    configFile: false,
    logLevel: "silent",
    root: WEB,
    build: {
      write: false,
      rollupOptions: { input: (inputs.length ? inputs : ["src/styles.css"]).map((i) => join(WEB, i)) },
    },
  });
  return (Array.isArray(out) ? out : [out])
    .flatMap((o) => ("output" in o ? o.output : []))
    .flatMap((o) => (o.type === "asset" && o.fileName.endsWith(".css") ? [String(o.source)] : []))
    .join("\n");
}

/**
 * A stylesheet without its comments and its at-rule blocks (`@media`, `@supports`…): what applies at every width. A
 * cascade layer's block (`@layer base { … }`: the kit and the app's base sheets) applies at every width, so it keeps
 * what applies at every width inside it.
 */
export function topLevel(css: string) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@") {
      out += text[i];
      continue;
    }
    const open = text.indexOf("{", i);
    const semi = text.indexOf(";", i);
    if (open < 0 || (semi >= 0 && semi < open)) {
      i = semi < 0 ? text.length : semi;
      continue;
    }
    let depth = 0;
    let end = open;
    for (; end < text.length; end++) {
      if (text[end] === "{") depth++;
      else if (text[end] === "}" && --depth === 0) break;
    }
    if (/^@layer\b/.test(text.slice(i, open))) out += topLevel(text.slice(open + 1, end));
    i = end;
  }
  return out;
}

/** A block's condition as the minifier writes it: `(max-width: 720px)` as `(width<=720px)`, spaces out. */
const condition = (query: string) =>
  query
    .replace(/\(\s*max-(width|height)\s*:\s*([\d.]+px)\s*\)/g, "($1<=$2)")
    .replace(/\(\s*min-(width|height)\s*:\s*([\d.]+px)\s*\)/g, "($1>=$2)")
    .replace(/\s+/g, "")
    .toLowerCase();

/**
 * The rules of every block opened as `block` (`@media (max-width: 720px)`, `@supports (…)`), however its condition is
 * written, as one sheet.
 */
export function atRule(css: string, block: string) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const name = block.match(/^@[\w-]+/)?.[0] ?? "@media";
  const wanted = condition(block.slice(name.length));
  let out = "";
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    const open = text.indexOf("{", at);
    if (condition(text.slice(at + name.length, open)) !== wanted) continue;
    let depth = 0;
    let end = open;
    for (; end < text.length; end++) {
      if (text[end] === "{") depth++;
      else if (text[end] === "}" && --depth === 0) break;
    }
    out += `${text.slice(open + 1, end)}\n`;
  }
  return out;
}

/** A selector as the minifier writes it: spaces and quotes out, `::before` as `:before`. */
const normal = (selector: string) =>
  selector
    .replace(/\s*([>+~,()])\s*/g, "$1")
    .replace(/="([^"]*)"/g, "=$1")
    .replace(/::(before|after)\b/g, ":$1")
    .replace(/\s+/g, " ")
    .trim();

/** Every rule, in order (an at-rule block's too), as its selectors, normalised, and its [property, value] pairs. */
export function rules(css: string) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: splitList(normal(m[1] ?? "")),
    declarations: (m[2] ?? "")
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()] as const),
  }));
}

/** The declarations of every rule whose selector list holds `selector`, in order, as [property, value]. */
export function declarations(css: string, selector: string) {
  const wanted = normal(selector);
  return rules(css)
    .filter((r) => r.selectors.includes(wanted))
    .flatMap((r) => r.declarations);
}

/** A selector list's selectors, split on its top-level commas only (`:is(a, b)` stays one). */
function splitList(list: string) {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  return [...out, list.slice(start)];
}
