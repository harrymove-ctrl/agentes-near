/**
 * The translation tools (ADR 0122):
 *   bun run i18n:missing <code> [--file app|mobile-base|mobile-features|desktop] [--group <top-level key>]
 *       writes i18n-work/<code>.todo.json: every English string the language has no translation of, or whose English
 *       changed since it was translated (`outdated`: the English then and the translation to redo), with its pt-BR
 *       text, the note written above it, its placeholders and tags, the plural forms the language needs and whether
 *       it has a feminine variant.
 *   bun run i18n:apply <code> <file.json>
 *       merges translated items ({ file, key, value, female? }) into the language's JSON files, in English's key
 *       order, after `checkLocale` passes for every key they touch, and keeps the English each was translated from in
 *       `<code>.source.json` beside them.
 *   bun run i18n:status
 *       a table per language and surface: the share of keys done, the plural forms missing and the outdated keys.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktopEn } from "../apps/desktop/src/i18n/keys.en";
import { desktopPtBR } from "../apps/desktop/src/i18n/keys.pt-BR";
import { featureKeysEn } from "../apps/mobile/src/features/i18n/keys.en";
import { featureKeysPtBR } from "../apps/mobile/src/features/i18n/keys.pt-BR";
import { mobileEn } from "../apps/mobile/src/i18n/keys.en";
import { mobilePtBR } from "../apps/mobile/src/i18n/keys.pt-BR";
import { WORDS } from "../packages/engine/src/email/words";
import { PUSH } from "../packages/engine/src/push/messages";
import { HELP } from "../packages/i18n/src/help";
import { en, ptBR } from "../packages/i18n/src/index";
import { legalDocuments } from "../packages/i18n/src/legal";
import { type AppLocale, isAppLocale, LOCALES, localeInfo } from "../packages/i18n/src/locale";
import type { LocaleStrings } from "../packages/i18n/src/plurals";
import { checkLocale, flatten, missingKeys, splitKey } from "../packages/i18n/test/check-locale";
import identical from "../packages/i18n/test/identical.json";

const ROOT = join(import.meta.dir, "..");

interface Surface {
  /** The English source file (its `/** … *\/` notes are read too), and pt-BR's. */
  enFile: string;
  ptFile: string;
  en: LocaleStrings;
  ptBR: LocaleStrings;
  /** Where a language's translation lives. */
  target: (code: AppLocale) => string;
}

export const SURFACES: Record<string, Surface> = {
  app: {
    enFile: "packages/i18n/src/en.ts",
    ptFile: "packages/i18n/src/pt-BR.ts",
    en,
    ptBR,
    target: (c) => `packages/i18n/src/locales/${c}.json`,
  },
  "mobile-base": {
    enFile: "apps/mobile/src/i18n/keys.en.ts",
    ptFile: "apps/mobile/src/i18n/keys.pt-BR.ts",
    en: mobileEn,
    ptBR: mobilePtBR,
    target: (c) => `apps/mobile/src/i18n/locales/${c}.json`,
  },
  "mobile-features": {
    enFile: "apps/mobile/src/features/i18n/keys.en.ts",
    ptFile: "apps/mobile/src/features/i18n/keys.pt-BR.ts",
    en: featureKeysEn,
    ptBR: featureKeysPtBR,
    target: (c) => `apps/mobile/src/features/i18n/locales/${c}.json`,
  },
  desktop: {
    enFile: "apps/desktop/src/i18n/keys.en.ts",
    ptFile: "apps/desktop/src/i18n/keys.pt-BR.ts",
    en: desktopEn,
    ptBR: desktopPtBR,
    target: (c) => `apps/desktop/src/i18n/locales/${c}.json`,
  },
};

/** Keys whose text must fit a narrow place: at most this many characters. */
const MAX_CHARS: Record<string, number> = { "database.urlPlaceholder": 36 };

/**
 * The notes above each key of a Biome-formatted strings file (`/** … *\/` on the lines before `key:`), by key path.
 * One property per line; an object opens with `key: {` and closes with `},`.
 */
export function notesOf(source: string): Map<string, string> {
  const notes = new Map<string, string>();
  const path: string[] = [];
  let pending: string[] = [];
  let inComment = false;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (inComment || line.startsWith("/**") || line.startsWith("//")) {
      if (line.startsWith("//")) pending.push(line.slice(2).trim());
      else {
        pending.push(line.replace(/^\/\*\*?|\*\/$|^\*/g, "").trim());
        inComment = !line.endsWith("*/");
      }
      continue;
    }
    const key = line.match(/^"?([\w$-]+)"?:/)?.[1];
    if (key && path.length > 0) {
      const at = [...path.slice(1), key].join(".");
      const note = pending.filter(Boolean).join(" ");
      if (note) notes.set(at, note);
    }
    pending = [];
    if (/^(export const \w+(: \w+)? = |"?[\w$-]+"?: )\{$/.test(line)) path.push(key ?? "");
    else if (/^\}[,;)]?( satisfies \w+;)?$/.test(line)) path.pop();
  }
  return notes;
}

type Forms = string | Record<string, string>;

/** Each source base key with its text (a string, or its plural forms) and its feminine variant. */
function grouped(tree: LocaleStrings) {
  const out = new Map<string, { value: Forms; female?: Forms }>();
  for (const [key, value] of flatten(tree)) {
    const { base, context, plural } = splitKey(key);
    const entry = out.get(base) ?? { value: plural ? {} : "" };
    const slot = context ? "female" : "value";
    if (plural) {
      const forms = (typeof entry[slot] === "object" ? entry[slot] : {}) as Record<string, string>;
      forms[plural] = value;
      entry[slot] = forms;
    } else entry[slot] = value;
    out.set(base, entry);
  }
  return out;
}

const read = (file: string): LocaleStrings => {
  try {
    return JSON.parse(readFileSync(join(ROOT, file), "utf8"));
  } catch {
    return {};
  }
};

/** Where a language's file keeps the English each key was translated from ("es.json" → "es.source.json"). */
export const sourcesPath = (target: string) => target.replace(/\.json$/, ".source.json");

type Source = { value: Forms; female?: Forms };

/**
 * The keys `target` has whose English changed since they were translated (or whose English then is unknown), with
 * the English then.
 */
export function outdatedKeys(
  source: LocaleStrings,
  target: LocaleStrings,
  sources: Record<string, Source>,
): Map<string, Source | undefined> {
  const now = grouped(source);
  const out = new Map<string, Source | undefined>();
  for (const key of new Set(flatten(target).map(([k]) => splitKey(k).base))) {
    const current = now.get(key);
    if (current && JSON.stringify(current) !== JSON.stringify(sources[key])) out.set(key, sources[key]);
  }
  return out;
}

const readSources = (target: string) => read(sourcesPath(target)) as unknown as Record<string, Source>;

const textsOf = (f: Forms | undefined) => (f === undefined ? [] : typeof f === "string" ? [f] : Object.values(f));

function missing(code: AppLocale, only: { file?: string; group?: string }) {
  const categories = new Intl.PluralRules(localeInfo(code).intl).resolvedOptions().pluralCategories;
  const items = [];
  for (const [name, s] of Object.entries(SURFACES)) {
    if (only.file && only.file !== name) continue;
    const target = read(s.target(code));
    const enNotes = notesOf(readFileSync(join(ROOT, s.enFile), "utf8"));
    const ptNotes = notesOf(readFileSync(join(ROOT, s.ptFile), "utf8"));
    const source = grouped(s.en);
    const pt = grouped(s.ptBR);
    const outdated = outdatedKeys(s.en, target, readSources(s.target(code)));
    const current = grouped(target);
    for (const key of [...missingKeys(s.en, target), ...outdated.keys()]) {
      if (only.group && !key.startsWith(`${only.group}.`)) continue;
      const entry = source.get(key);
      if (!entry) continue;
      const texts = [...textsOf(entry.value), ...textsOf(entry.female), ...textsOf(pt.get(key)?.value)];
      const vars = [...new Set(texts.flatMap((t) => [...t.matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1] ?? "")))];
      const tags = [...new Set(texts.flatMap((t) => [...t.matchAll(/<\/?(\w+)\s*\/?>/g)].map((m) => m[1] ?? "")))];
      const note = [enNotes.get(key), ptNotes.get(key)].filter(Boolean).join(" ");
      const ptEntry = pt.get(key);
      items.push({
        file: name,
        key,
        en: entry.value,
        ...(entry.female ? { enFemale: entry.female } : {}),
        ...(ptEntry ? { ptBR: ptEntry.value, ...(ptEntry.female ? { ptBRFemale: ptEntry.female } : {}) } : {}),
        ...(note ? { note } : {}),
        ...(outdated.has(key)
          ? { outdated: { enBefore: outdated.get(key)?.value ?? null, translation: current.get(key) } }
          : {}),
        vars,
        tags,
        ...(typeof entry.value === "object" ? { plural: categories } : {}),
        ...(entry.female || ptEntry?.female ? { context: ["female"] } : {}),
        ...(MAX_CHARS[key] ? { maxChars: MAX_CHARS[key] } : {}),
      });
    }
  }
  return { locale: code, items };
}

/** `value` under the dotted `key` of `tree`, creating objects on the way. */
function setAt(tree: LocaleStrings, key: string, value: string) {
  const parts = key.split(".");
  let node = tree;
  for (const p of parts.slice(0, -1)) {
    const next = node[p];
    if (typeof next === "object") node = next;
    else {
      const fresh: LocaleStrings = {};
      node[p] = fresh;
      node = fresh;
    }
  }
  node[parts.at(-1) ?? ""] = value;
}

/** `target`'s keys in `source`'s order (each base key's plural forms and feminine variant together). */
function ordered(source: LocaleStrings, target: LocaleStrings): LocaleStrings {
  const have = new Map(flatten(target));
  const out: LocaleStrings = {};
  const done = new Set<string>();
  const byBase = new Map<string, string[]>();
  for (const k of have.keys()) {
    const { base } = splitKey(k);
    byBase.set(base, [...(byBase.get(base) ?? []), k]);
  }
  const ORDER = ["zero", "one", "two", "few", "many", "other"];
  const rank = (k: string) => {
    const { context, plural } = splitKey(k);
    return (context ? 10 : 0) + (plural ? ORDER.indexOf(plural) : -1);
  };
  for (const [key] of flatten(source)) {
    const { base } = splitKey(key);
    if (done.has(base)) continue;
    done.add(base);
    for (const k of (byBase.get(base) ?? []).sort((a, b) => rank(a) - rank(b))) setAt(out, k, have.get(k) ?? "");
  }
  // Keys English no longer has stay at the end, for `checkLocale` to report.
  for (const [k, v] of have) if (!done.has(splitKey(k).base)) setAt(out, k, v);
  return out;
}

const suffixed = (key: string, female: boolean, plural?: string) =>
  `${key}${female ? "_female" : ""}${plural ? `_${plural}` : ""}`;

function apply(code: AppLocale, file: string) {
  const { items } = JSON.parse(readFileSync(file, "utf8")) as {
    items: { file: string; key: string; value: Forms; female?: Forms }[];
  };
  const problems: string[] = [];
  const writes: [string, LocaleStrings][] = [];
  for (const [name, s] of Object.entries(SURFACES)) {
    const mine = items.filter((i) => i.file === name);
    if (mine.length === 0) continue;
    const target = read(s.target(code));
    const flat = new Map(flatten(target));
    for (const item of mine) {
      for (const k of [...flat.keys()]) if (splitKey(k).base === item.key) flat.delete(k);
      for (const [female, forms] of [
        [false, item.value],
        [true, item.female],
      ] as const) {
        if (forms === undefined) continue;
        if (typeof forms === "string") flat.set(suffixed(item.key, female), forms);
        else for (const [p, v] of Object.entries(forms)) flat.set(suffixed(item.key, female, p), v);
      }
    }
    const next: LocaleStrings = {};
    for (const [k, v] of flat) setAt(next, k, v);
    const touched = new Set(mine.map((i) => i.key));
    const found = checkLocale({
      source: s.en,
      target: next,
      code,
      ready: false,
      identical: (identical[name as keyof typeof identical] as Record<string, string[]>)[code] ?? [],
    }).filter((p) => touched.has(splitKey(p.split(":")[0] ?? "").base));
    for (const item of mine) {
      const max = MAX_CHARS[item.key];
      if (max && textsOf(item.value).some((t) => t.length > max)) problems.push(`${item.key}: over ${max} characters`);
    }
    problems.push(...found.map((p) => `${name} ${p}`));
    const tree = ordered(s.en, next);
    writes.push([s.target(code), tree]);
    // The English each key now stands for: its own when written here, else what it was translated from.
    const was = readSources(s.target(code));
    const now = grouped(s.en);
    const sources = Object.fromEntries(
      [...new Set(flatten(tree).map(([k]) => splitKey(k).base))].flatMap((k) => {
        const from = touched.has(k) ? now.get(k) : was[k];
        return from ? [[k, from]] : [];
      }),
    );
    writes.push([sourcesPath(s.target(code)), sources as unknown as LocaleStrings]);
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  for (const [path, tree] of writes) writeFileSync(join(ROOT, path), `${JSON.stringify(tree, null, 2)}\n`);
  console.log(`${items.length} items written`);
}

/** The share of English's keys a language has, per surface, and its plural forms missing. */
function status() {
  const rows = LOCALES.filter((l) => l.code !== "en").map(({ code }) => {
    const cells = Object.entries(SURFACES).map(([, s]) => {
      const target = code === "pt-BR" ? s.ptBR : read(s.target(code));
      const total = new Set(flatten(s.en).map(([k]) => splitKey(k).base)).size;
      const done = total - missingKeys(s.en, target).length;
      const plurals = checkLocale({ source: s.en, target, code, ready: false }).filter((p) => / form$/.test(p)).length;
      const stale = code === "pt-BR" ? 0 : outdatedKeys(s.en, target, readSources(s.target(code))).size;
      const notes = [plurals ? `${plurals} plural` : "", stale ? `${stale} outdated` : ""].filter(Boolean).join(", ");
      return `${Math.floor((done / total) * 100)}%${notes ? ` (${notes})` : ""}`;
    });
    const leaves = (o: object): number =>
      Object.values(o).reduce<number>(
        (n, v) => n + (v && typeof v === "object" && !Array.isArray(v) ? leaves(v) : 1),
        0,
      );
    const share = (have: number, all: number) => `${Math.floor((have / all) * 100)}%`;
    return [
      code,
      ...cells,
      share(leaves(WORDS[code]), leaves(WORDS.en)),
      share(Object.keys(PUSH[code]).length, Object.keys(PUSH.en).length),
      share(Object.keys(HELP[code]).length, Object.keys(HELP.en).length),
      share([legalDocuments.terms[code], legalDocuments.privacy[code]].filter(Boolean).length, 2),
    ];
  });
  const head = ["", ...Object.keys(SURFACES), "email", "push", "help", "legal"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  for (const r of [head, ...rows]) console.log(r.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  "));
}

if (import.meta.main) {
  const [command, code, ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (command === "status") status();
  else if (!isAppLocale(code) || code === "en" || code === "pt-BR") {
    console.error("Usage: bun run i18n:missing <code> | i18n:apply <code> <file> | i18n:status (code: es, fr, de, …)");
    process.exit(1);
  } else if (command === "missing") {
    const todo = missing(code, { file: flag("file"), group: flag("group") });
    mkdirSync(join(ROOT, "i18n-work"), { recursive: true });
    const out = join(ROOT, "i18n-work", `${code}.todo.json`);
    writeFileSync(out, `${JSON.stringify(todo, null, 2)}\n`);
    console.log(`${todo.items.length} items → ${out}`);
  } else if (command === "apply" && rest[0]) apply(code, rest[0]);
  else {
    console.error("Usage: bun run i18n:apply <code> <file>");
    process.exit(1);
  }
}
