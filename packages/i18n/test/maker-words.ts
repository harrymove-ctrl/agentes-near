import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every file under `dir` whose path matches `ext`. */
export const sourceFiles = (dir: string, ext = /\.tsx?$/): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path, ext);
    return ext.test(path) ? [path] : [];
  });

/** Source without its comments; a `//` in a string or a URL stays. */
export const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

/**
 * What people read names the product they know: Claude, never "Anthropic"; a ChatGPT account, never a Codex or an
 * OpenAI one ("OpenAI" stays for its API keys). Code keeps the provider's id, `anthropic`, so in code only the
 * capitalized word counts; copy is checked ignoring case.
 */
export const MAKER_WORDS = /Anthropic|\b(?:Codex|OpenAI) [Aa]ccounts?\b|\b[Cc]ontas? d[oa] (?:Codex|OpenAI)\b/;

/** The files under `dirs` whose code, outside comments, says one of `MAKER_WORDS`. */
export const filesNamingMakers = (dirs: string[]) =>
  dirs
    .flatMap((dir) => sourceFiles(dir))
    .filter((file) => MAKER_WORDS.test(withoutComments(readFileSync(file, "utf8"))));
