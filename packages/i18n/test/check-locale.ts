/**
 * One language's strings checked against English, the source (ADR 0122): the same keys, every plural form the
 * language needs, the same placeholders and tags, nothing empty, nothing left in English, the glossary's names kept,
 * no semicolons. Shared by every surface's test (`@agenteschat/i18n/testing`) and by `bun run i18n:apply`.
 */
import glossary from "../glossary.json";
import { type AppLocale, localeInfo } from "../src/locale";
import { fillPluralGaps, type LocaleStrings } from "../src/plurals";

const PLURAL = /_(zero|one|two|few|many|other)$/;
const CONTEXT = /_female$/;

/** Every leaf key ("chat.work.steps_one") and its value. */
export function flatten(tree: LocaleStrings, prefix = ""): [string, string][] {
  return Object.entries(tree).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === "string" ? [[key, v] as [string, string]] : flatten(v, key);
  });
}

/** "a.b_female_one" → { base: "a.b", context: "female", plural: "one" }. */
export function splitKey(key: string) {
  const plural = key.match(PLURAL)?.[1];
  const noPlural = plural ? key.slice(0, -plural.length - 1) : key;
  const context = CONTEXT.test(noPlural) ? "female" : undefined;
  return { base: context ? noPlural.replace(CONTEXT, "") : noPlural, context, plural };
}

const vars = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1] ?? "");
/** `<b>…</b>`, `<1>…</1>`, `<who/>`: a lone `<folder>` is a word to translate, not a tag. */
const tags = (s: string) =>
  [...s.matchAll(/<(\/?)(\w+)\s*(\/?)>/g)]
    .filter(([, close, name, self]) => close || self || s.includes(`</${name}>`))
    .map((m) => m[0].replace(/\s/g, ""));
const sameSet = (a: string[], b: string[]) => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
const shown = (list: string[]) => [...new Set(list)].map((v) => `{{${v}}}`).join(" ") || "none";
const sameBag = (a: string[], b: string[]) => [...a].sort().join("\n") === [...b].sort().join("\n");

/** Values that may stay empty in every language: the custom role starts with no instructions. */
const EMPTY_OK = new Set(["newAgent.roles.custom.instructions"]);

export const KEEP: readonly string[] = glossary.keep;
const keepRe = (term: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u");
const KEEP_RES = KEEP.map((term) => [term, keepRe(term)] as const);

/** No letters left once placeholders, tags and the glossary's keep-as-is names are gone. */
function nothingToTranslate(s: string) {
  let rest = s.replace(/\{\{[^}]*\}\}/g, " ").replace(/<[^>]*>/g, " ");
  for (const term of KEEP) rest = rest.split(term).join(" ");
  return !/\p{L}/u.test(rest);
}

export interface CheckInput {
  source: LocaleStrings;
  target: LocaleStrings;
  code: AppLocale;
  /** Missing keys are problems only for a language people can pick: the others fall back to English. */
  ready: boolean;
  /** Keys whose value may read exactly like English (a word both languages share). */
  identical?: readonly string[];
}

/** The source keys (no plural suffix) the target has no translation of. */
export function missingKeys(source: LocaleStrings, target: LocaleStrings): string[] {
  const have = new Set(flatten(target).map(([k]) => splitKey(k).base));
  return [...new Set(flatten(source).map(([k]) => splitKey(k).base))].filter((k) => !have.has(k));
}

/** Every problem, one line each ("chat.title: no {{name}}"); empty when the language is fine. */
export function checkLocale({ source, target, code, ready, identical = [] }: CheckInput): string[] {
  const problems: string[] = [];
  const src = flatten(source);
  const filled = flatten(fillPluralGaps(code, target));
  const written = new Map(flatten(target));
  const srcByBase = new Map<string, [string, string][]>();
  for (const entry of src) {
    const { base } = splitKey(entry[0]);
    srcByBase.set(base, [...(srcByBase.get(base) ?? []), entry]);
  }
  const tgtByBase = new Map<string, [string, string][]>();
  for (const entry of filled) {
    const { base, context } = splitKey(entry[0]);
    const group = context ? `${base}_${context}` : base;
    tgtByBase.set(group, [...(tgtByBase.get(group) ?? []), entry]);
  }
  const rules = new Intl.PluralRules(localeInfo(code).intl);
  const categories = rules.resolvedOptions().pluralCategories as string[];
  // ru's `_one` is also 21, 31…: there the number must show. (pt's and fr's are also 0, which the app says apart.)
  const oneIsOnlyOne = !Array.from({ length: 199 }, (_, n) => n + 2).some((n) => rules.select(n) === "one");
  const isCjk = code === "ja" || code === "zh-Hans";
  const sameAsEn = new Set(identical);
  const enValue = new Map(src);

  if (ready) for (const base of missingKeys(source, target)) problems.push(`${base}: missing`);

  for (const [group, entries] of tgtByBase) {
    const { base } = splitKey(group);
    const srcEntries = srcByBase.get(base);
    if (!srcEntries) {
      problems.push(`${group}: not in English`);
      continue;
    }
    const srcPlural = srcEntries.some(([k]) => splitKey(k).plural);
    const forms = entries.map(([k]) => splitKey(k).plural);
    if (srcPlural) {
      for (const c of categories) if (!forms.includes(c)) problems.push(`${group}: no _${c} form`);
      for (const f of forms)
        if (!f) problems.push(`${group}: plural in English, so needs ${categories.map((c) => `_${c}`).join(" ")}`);
        else if (f !== "zero" && !categories.includes(f)) problems.push(`${group}_${f}: ${code} has no ${f} form`);
    } else if (forms.some(Boolean)) problems.push(`${group}: not plural in English`);

    for (const [key, value] of entries) {
      if (!written.has(key)) continue;
      const { plural } = splitKey(key);
      const ctx = splitKey(key).context ? "_female" : "";
      const pl = plural ? `_${plural}` : "";
      const en =
        [`${base}${ctx}${pl}`, `${base}${pl}`, `${base}${ctx}_other`, `${base}_other`, base]
          .map((k) => enValue.get(k))
          .find((v) => v !== undefined) ?? "";
      // Each form its English one's placeholders, the number included: only `_zero`, and `_one` where it means 1
      // alone, may say it in words ("one file"). Where `_one` also means 21 (ru), it says the number when
      // English's `_other` does.
      const countOptional = plural === "zero" || (plural === "one" && oneIsOnlyOne);
      const enOther = enValue.get(`${base}${ctx}_other`) ?? enValue.get(`${base}_other`) ?? "";
      const needCount =
        vars(en).includes("count") || (plural === "one" && !oneIsOnlyOne && vars(enOther).includes("count"));
      const want = [...vars(en).filter((v) => v !== "count"), ...(needCount ? ["count"] : [])];
      const drop = (list: string[]) => (countOptional ? list.filter((v) => v !== "count") : list);
      if (!sameSet(drop(vars(value)), drop(want)))
        problems.push(`${key}: placeholders ${shown(vars(value))} ≠ English ${shown(want)}`);
      if (!sameBag(tags(value), tags(en))) problems.push(`${key}: tags differ from English`);
      if (!value.trim() && !EMPTY_OK.has(base)) problems.push(`${key}: empty`);
      if (code !== "en" && value === en && !nothingToTranslate(value) && !sameAsEn.has(base))
        problems.push(`${key}: same as English`);
      for (const [term, re] of KEEP_RES)
        if (re.test(en) && !value.toLowerCase().includes(term.toLowerCase()))
          problems.push(`${key}: "${term}" must stay as is`);
      if (/[;；]/.test(value) && !/;/.test(en)) problems.push(`${key}: semicolon`);
      if (!isCjk && en.includes(" › ") && value.includes("›") && value.split(" › ").join("").includes("›"))
        problems.push(`${key}: a menu path's › needs no-break spaces`);
      if (!isCjk && / \S+$/.test(en) && !/ \S+$/.test(value))
        problems.push(`${key}: the last two words need a no-break space`);
    }
  }
  return problems;
}
