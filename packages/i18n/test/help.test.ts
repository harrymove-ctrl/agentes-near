import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  HELP,
  HELP_PAGES,
  type HelpBlock,
  type HelpDocument,
  type HelpSlug,
  helpDocsUrl,
  helpDocument,
  helpInline,
  INSTALL_DOCS_URL,
  INSTALL_PAGE,
  isHelpSlug,
} from "../src/help";
import { en, ptBR, STRINGS } from "../src/index";
import { bannedIn, CLOUD_BANNED, SELFHOST_BANNED, TECHNICAL } from "./edition-words";
import { MAKER_WORDS, sourceFiles, withoutComments } from "./maker-words";

const REPO = join(import.meta.dir, "..", "..", "..");
const SLUGS = Object.keys(HELP_PAGES) as HelpSlug[];
const LOCALES = ["pt-BR", "en"] as const;

const blockLines = (b: HelpBlock): string[] => (typeof b === "string" ? [b] : "list" in b ? b.list : [b.code]);
/** Every line a page shows: title, summary, headings, paragraphs, list items and commands. */
const linesOf = (doc: HelpDocument) => [
  doc.title,
  doc.summary,
  ...doc.sections.flatMap((s) => [s.heading, ...s.blocks.flatMap(blockLines)]),
];
const pages = () =>
  SLUGS.flatMap((slug) => LOCALES.map((locale) => ({ slug, locale, doc: helpDocument(slug, locale) })));

describe("help pages", () => {
  test("every page in both languages, with the same sections in the same order and blocks of the same shape", () => {
    expect(SLUGS.length).toBe(11);
    // Jev's key is a self-hosted server's own; who answers a message, every edition's.
    expect([HELP_PAGES.jev, HELP_PAGES["who-answers"]]).toEqual(["selfhost", "both"]);
    for (const slug of SLUGS) {
      const pt = helpDocument(slug, "pt-BR");
      const english = helpDocument(slug, "en");
      expect(pt).not.toBe(english);
      expect(english.sections.map((s) => s.id)).toEqual(pt.sections.map((s) => s.id));
      expect(new Set(pt.sections.map((s) => s.id)).size).toBe(pt.sections.length);
      const shape = (b: HelpBlock) => (typeof b === "string" ? "p" : "list" in b ? `list:${b.list.length}` : "code");
      expect(english.sections.map((s) => s.blocks.map(shape))).toEqual(pt.sections.map((s) => s.blocks.map(shape)));
    }
    expect(helpDocument("memory", "en-GB")).toBe(helpDocument("memory", "en"));
    expect(isHelpSlug("memory")).toBe(true);
    expect(isHelpSlug("toString")).toBe(false);
  });

  test("no empty block, and no markup left over once a line is split", () => {
    for (const { slug, locale, doc } of pages()) {
      for (const s of doc.sections)
        expect({ slug, locale, id: s.id, blocks: s.blocks.length > 0 }).toMatchObject({ blocks: true });
      for (const line of linesOf(doc)) {
        expect({ slug, locale, line, empty: line.trim() === "" }).toMatchObject({ empty: false });
        // An unpaired ** would bold the rest of the line.
        const stars = line.replace(/`[^`]+`/g, "").split("**").length - 1;
        expect({ slug, locale, line, paired: stars % 2 === 0 }).toMatchObject({ paired: true });
        for (const piece of helpInline(line)) {
          const left = piece.text.includes("**") || piece.text.includes("`") || piece.text.includes("](");
          expect({ slug, locale, piece: piece.text, left }).toMatchObject({ left: false });
        }
      }
    }
  });

  test("Claude, never its maker; a Cloud page keeps to the Cloud's words; no page says the cloud", () => {
    const maker = new RegExp(MAKER_WORDS.source, "i");
    for (const { slug, locale, doc } of pages()) {
      const text = linesOf(doc).join("\n");
      expect({ slug, locale, maker: maker.test(text) }).toMatchObject({ maker: false });
      expect({ slug, locale, words: bannedIn(text, SELFHOST_BANNED) }).toMatchObject({ words: [] });
      if (HELP_PAGES[slug] !== "cloud") continue;
      expect({ slug, locale, words: bannedIn(text, CLOUD_BANNED[locale]) }).toMatchObject({ words: [] });
      expect({ slug, locale, technical: text.match(TECHNICAL)?.[0] ?? null }).toMatchObject({ technical: null });
    }
    expect(Object.values(HELP_PAGES)).toContain("cloud");
  });

  test("a path through the menus stays on one line: no-break spaces around its ›", () => {
    let paths = 0;
    for (const { doc } of pages())
      for (const line of linesOf(doc).filter((l) => l.includes("›"))) {
        paths++;
        expect({ line, alone: line.split("\u00a0›\u00a0").join("").includes("›") }).toEqual({ line, alone: false });
      }
    expect(paths).toBeGreaterThan(0);
  });

  test("a link to another help page lands on a page and a section that exist", () => {
    expect(deadHelpLinks(pages().map((p) => p.doc))).toEqual([]);
    // The check itself, on a page linking one place that exists and two that don't.
    const probe: HelpDocument = {
      title: "t",
      summary: "s",
      sections: [
        { id: "a", heading: "h", blocks: ["[x](/help/memory#proposals), [y](/help/nope), [z](/help/memory#nope)"] },
      ],
    };
    expect(deadHelpLinks([probe])).toEqual(["/help/nope", "/help/memory#nope"]);
  });

  test("no page links the repository: it isn't public yet, so the install page names SELF_HOSTING.md instead", () => {
    for (const { slug, locale, doc } of pages())
      expect({ slug, locale, github: linesOf(doc).some((l) => l.includes("github.com")) }).toMatchObject({
        github: false,
      });
    for (const doc of Object.values(HELP).map((p) => p[INSTALL_PAGE]))
      expect(doc?.sections.at(-1)?.blocks.join(" ")).toContain("`SELF_HOSTING.md`");
  });
});

/** The links in these pages to a help page, or a section of one, that doesn't exist. */
function deadHelpLinks(docs: HelpDocument[]): string[] {
  return docs
    .flatMap(linesOf)
    .flatMap(helpInline)
    .flatMap((piece) => {
      if (piece.kind !== "link" || !piece.href.startsWith("/help/")) return [];
      const [slug = "", id] = piece.href.slice("/help/".length).split("#");
      const found = isHelpSlug(slug) && (!id || helpDocument(slug, "en").sections.some((s) => s.id === id));
      return found ? [] : [piece.href];
    });
}

/** The arguments of each `helpUrl(…)` call, split at the commas outside brackets and strings. */
function helpUrlCalls(source: string): string[][] {
  const calls: string[][] = [];
  for (const m of source.matchAll(/\bhelpUrl\(/g)) {
    const args: string[] = [];
    let start = (m.index ?? 0) + m[0].length;
    let depth = 0;
    let quote = "";
    for (let i = start; i < source.length; i++) {
      const c = source.charAt(i);
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if ("([{".includes(c)) depth++;
      else if (depth > 0) {
        if (")]}".includes(c)) depth--;
      } else if (c === "," || c === ")") {
        args.push(source.slice(start, i).trim());
        start = i + 1;
        if (c === ")") break;
      }
    }
    calls.push(args);
  }
  return calls;
}

/** The help pages the apps link to, as `[slug, section]`: `helpUrl("<slug>", …, "<section>")` and `<HelpLink …>`. */
function linksIn(source: string): [string, string | undefined][] {
  const literal = (arg = "") => /^"([^"]+)"$/.exec(arg)?.[1];
  const calls = helpUrlCalls(source).flatMap(([slug, , section]): [string, string | undefined][] => {
    const page = literal(slug);
    return page ? [[page, literal(section)]] : [];
  });
  const tags = [...source.matchAll(/<HelpLink\b([^>]*)>/g)].map((m) => {
    const attrs = m[1] ?? "";
    return [/\bslug="([^"]+)"/.exec(attrs)?.[1] ?? "", /\bsection="([^"]+)"/.exec(attrs)?.[1]] as [
      string,
      string | undefined,
    ];
  });
  return [...calls, ...tags];
}

describe("links to the help pages", () => {
  test("are read from a call or a tag, with or without a section", () => {
    expect(linksIn('host.openExternal(helpUrl("run-on-your-computer", i18n.language, "who"))')).toEqual([
      ["run-on-your-computer", "who"],
    ]);
    expect(linksIn('Linking.openURL(helpUrl("memory", locale))')).toEqual([["memory", undefined]]);
    // A language worked out in the call, over lines.
    expect(linksIn('helpUrl("computers", lang(), "folders")')).toEqual([["computers", "folders"]]);
    expect(
      linksIn('helpUrl(\n  "computers",\n  locale.slice(0, 2) === "en" ? "en" : "pt-BR",\n  "folders",\n)'),
    ).toEqual([["computers", "folders"]]);
    // A page in a variable can't be read here: HelpLink's own call.
    expect(linksIn("helpUrl(slug, i18n.language, section)")).toEqual([]);
    expect(linksIn('<HelpLink slug="import" section="other-apps">{t("x")}</HelpLink>')).toEqual([
      ["import", "other-apps"],
    ]);
    expect(linksIn('<HelpLink\n  slug="wiki"\n>')).toEqual([["wiki", undefined]]);
  });

  test("every app links only to pages and sections that exist", () => {
    const apps = readdirSync(join(REPO, "apps"))
      .map((app) => join(REPO, "apps", app, "src"))
      .filter((dir) => existsSync(dir));
    const wrong: string[] = [];
    for (const file of apps.flatMap((dir) => sourceFiles(dir, /\.tsx?$/)))
      for (const [slug, section] of linksIn(withoutComments(readFileSync(file, "utf8")))) {
        const ids = isHelpSlug(slug) ? helpDocument(slug, "en").sections.map((s) => s.id) : null;
        if (!ids || (section && !ids.includes(section))) wrong.push(`${relative(REPO, file)}: ${slug}#${section}`);
      }
    expect(wrong).toEqual([]);
  });
});

describe("the install page", () => {
  test("is a self-hosted page, at agentes.chat/docs in English for the CLI and the settings", () => {
    expect(HELP_PAGES[INSTALL_PAGE]).toBe("selfhost");
    expect(INSTALL_DOCS_URL).toBe("https://agentes.chat/docs/install-on-a-server");
    expect(helpDocsUrl(INSTALL_PAGE, "pt-BR")).toBe("https://agentes.chat/pt/docs/install-on-a-server");
  });

  test("every self-hosted pointer outside this package says its URL, and none points at the repository's file", () => {
    const files = [
      "install.sh",
      "deploy/backup/backup.sh",
      "packages/setup/src/lib.ts",
      "packages/setup/README.md",
      "packages/setup/package.json",
      "packages/config/src/schema.ts",
      ".env.example",
    ];
    for (const file of files) {
      const text = readFileSync(join(REPO, file), "utf8");
      expect({ file, url: text.includes(INSTALL_DOCS_URL) }).toEqual({ file, url: true });
      expect({ file, github: text.includes("blob/main/SELF_HOSTING.md") }).toEqual({ file, github: false });
    }
  });
});

describe("the ⓘ's name", () => {
  test("names the label it explains, in both languages", () => {
    expect(en.common.about).toBe("About {{label}}");
    expect(ptBR.common.about).toBe("Sobre {{label}}");
  });
});

describe("help pages in every language", () => {
  test("every language has every page: the apps link to the docs in the reader's language with no fallback", () => {
    for (const [code, pages] of Object.entries(HELP))
      expect({ code, missing: SLUGS.filter((slug) => !pages[slug]) }).toEqual({ code, missing: [] });
  });

  test("an old address goes to its docs page, English where the language has none, the index where none exists", () => {
    expect(helpDocsUrl("memory", "pt-BR")).toBe("https://agentes.chat/pt/docs/memory");
    expect(helpDocsUrl("memory", "zh-Hans")).toBe("https://agentes.chat/zh/docs/memory");
    expect(helpDocsUrl("memory", "ja")).toBe("https://agentes.chat/ja/docs/memory");
    expect(helpDocsUrl(undefined, "de")).toBe("https://agentes.chat/de/docs");
    expect(helpDocsUrl("nope", "en")).toBe("https://agentes.chat/docs");
    const ja = HELP.ja.memory;
    delete HELP.ja.memory;
    try {
      expect(helpDocsUrl("memory", "ja")).toBe("https://agentes.chat/docs/memory");
    } finally {
      HELP.ja.memory = ja;
    }
  });

  test("Approvals names the controls the app has, in each language's own words for them", () => {
    const keys = [
      "approval.always.button",
      "approval.always.routine",
      "agentPage.tabs.access",
      "permissions.approve_actions.title",
      "approvalCover.title",
    ];
    const at = (tree: unknown, key: string) =>
      key
        .split(".")
        .reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), tree);
    for (const [code, pages] of Object.entries(HELP)) {
      const text = linesOf(pages.approvals ?? helpDocument("approvals", "en")).join("\n");
      const words = STRINGS[code as keyof typeof STRINGS];
      const missing = keys.filter((k) => !text.includes(String(at(words, k) ?? at(STRINGS.en, k))));
      expect({ code, missing }).toEqual({ code, missing: [] });
    }
  });

  const shape = (b: HelpBlock) => (typeof b === "string" ? "p" : "list" in b ? `list:${b.list.length}` : "code");
  for (const [code, pages] of Object.entries(HELP)) {
    test(`${code}: each page it has matches English section by section, and the rest show in English`, () => {
      for (const [slug, doc] of Object.entries(pages) as [HelpSlug, HelpDocument][]) {
        const english = HELP.en[slug];
        expect(doc.sections.map((s) => s.id)).toEqual(english?.sections.map((s) => s.id) ?? []);
        doc.sections.forEach((s, i) => {
          expect(s.blocks.map(shape)).toEqual(english?.sections[i]?.blocks.map(shape) ?? []);
        });
      }
      for (const slug of SLUGS) expect(helpDocument(slug, code)).toBe(pages[slug] ?? (HELP.en[slug] as HelpDocument));
    });
  }
});
