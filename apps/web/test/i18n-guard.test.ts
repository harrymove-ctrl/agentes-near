import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { en, ptBR } from "@agenteschat/i18n";
import { legalDocuments } from "@agenteschat/i18n/legal";
import { leaves } from "../../../packages/i18n/test/leaves";
import { filesNamingMakers, MAKER_WORDS, sourceFiles, withoutComments } from "../../../packages/i18n/test/maker-words";

const REPO = join(import.meta.dir, "..", "..", "..");
const ROOTS = [join(import.meta.dir, "..", "src"), join(REPO, "packages", "ui", "src")];
/** The dev-only component gallery shows sample content on purpose. */
const SKIP_FILES = ["GalleryPage.tsx"];
/** Brand names, keys, symbols and code that stay as they are. */
const ALLOWED = [
  /^(agentes|chat|agentes\.chat|GitHub|MCP|Drive|Sentry|Linear|Slack|Claude Code|Codex|US\$|UTC)$/,
  /^[A-Z]$/,
  /^@\w+$/,
  /^https?:/,
  /^[a-z]+[-_]…$/,
];
const allowed = (s: string) => ALLOWED.some((re) => re.test(s));

describe("no hardcoded UI text", () => {
  test("JSX text and aria-label / title / placeholder / alt literals go through t()", () => {
    const offenders: string[] = [];
    for (const root of ROOTS)
      for (const f of sourceFiles(root, /\.tsx$/)) {
        if (SKIP_FILES.some((s) => f.endsWith(s))) continue;
        const source = withoutComments(readFileSync(f, "utf8"));
        const where = (i: number) => `${relative(root, f)}:${source.slice(0, i).split("\n").length}`;
        for (const m of source.matchAll(/>([^<>{}]*[A-Za-zÀ-ÿ][^<>{}]*)</g)) {
          const text = (m[1] ?? "").trim();
          // `=> Promise<…>`, `->`: types and arrows, not markup; a prop list after `<b />,`; one generic type joined
          // to the next (`Pick<…> & Partial<…>`, `Map<…> | Set<…>`).
          const prev = source[(m.index ?? 0) - 1];
          if (prev === "=" || prev === "-" || /^[,;]/.test(text) || /^[&|] *[\w.]+$/.test(text)) continue;
          // Code between generics/operators, not JSX text.
          if (!text || /=>|;|\(|\)|&&|\|\||=|\bconst\b|\breturn\b|\bnew\b|\*/.test(text) || allowed(text)) continue;
          offenders.push(`${where(m.index ?? 0)} text "${text}"`);
        }
        for (const m of source.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*[A-Za-zÀ-ÿ][^"]*)"/g)) {
          if (allowed(m[2] ?? "")) continue;
          offenders.push(`${where(m.index ?? 0)} ${m[1]}="${m[2]}"`);
        }
      }
    expect(offenders).toEqual([]);
  });
});

describe("translated text stays as each language writes it (ADR 0122)", () => {
  const ROOTS_ALL = [
    ...ROOTS,
    join(REPO, "packages", "client", "src"),
    join(REPO, "apps", "mobile", "src"),
    join(REPO, "apps", "mobile", "app"),
    join(REPO, "apps", "desktop", "src"),
  ];
  /** The one place a translated line's first letter changes case (German keeps it; a name stays). */
  const CASE_HELPERS = join(REPO, "packages", "client", "src", "lib", "format.ts");
  test("no case change on t(…), and no two t(…) glued with a space", () => {
    const offenders: string[] = [];
    for (const root of ROOTS_ALL)
      for (const f of sourceFiles(root, /\.tsx?$/)) {
        const source = withoutComments(readFileSync(f, "utf8"));
        const where = (i: number) => `${relative(REPO, f)}:${source.slice(0, i).split("\n").length}`;
        const banned = [
          // A lowercase or capitalized form is its own key ("roles.ownerLower"): only translators know it.
          /\bt\((?:[^()]|\([^()]*\))*\)\.(?:toLowerCase|toUpperCase|toLocaleLowerCase|toLocaleUpperCase)\(/g,
          /\b(?:capitalize|lowerFirst)\(t\(/g,
          // A first letter changed elsewhere: `lowerFirst`/`capitalize` from client/lib/format, with the language.
          ...(f === CASE_HELPERS
            ? []
            : [
                /\b(?:const|function)\s+(?:lower|lowerFirst|capitalize)\b[^\n]*charAt\(0\)/g,
                /\.charAt\(0\)\.to(?:Locale)?LowerCase\([^)]*\)\s*\+\s*[\w.]+\.slice\(1\)/g,
              ]),
          // Two sentences side by side: `common.joinSentences` ("{{a}} {{b}}", no space in Japanese and Chinese).
          /`\$\{t\([^`]*\)\} \$\{t\(/g,
        ];
        for (const re of banned) for (const m of source.matchAll(re)) offenders.push(`${where(m.index ?? 0)} ${m[0]}`);
      }
    expect(offenders).toEqual([]);
  });
});

describe("a failed request in the person's words", () => {
  /** Where an error's own words are the point: Better Auth's refusal read into `AuthResult`, a framed page's script. */
  const OWN_WORDS = ["auth/better-auth.ts", "components/artifacts/HtmlFrame.tsx"];
  test("no error's own message on screen: errorText, authErrorText or the screen's own line", () => {
    const src = ROOTS[0] ?? "";
    const offenders = sourceFiles(src)
      .filter((f) => !OWN_WORDS.some((own) => f.endsWith(own)))
      .flatMap((f) => {
        const source = withoutComments(readFileSync(f, "utf8"));
        return [...source.matchAll(/\b(?:e|err|error|failed|result)\.message\b|as Error\)\.message/g)].map(
          (m) => `${relative(src, f)}:${source.slice(0, m.index).split("\n").length}`,
        );
      });
    expect(offenders).toEqual([]);
  });
});

describe("Claude and ChatGPT, not their makers, in what a person reads", () => {
  /** A legal text names the company, once, beside the product people know. */
  const MAKER = {
    en: "Anthropic, which makes Claude",
    "pt-BR": "a Anthropic, que faz o Claude",
    es: "Anthropic, que crea Claude",
    fr: "Anthropic, qui développe Claude",
    de: "Anthropic, dem Hersteller von Claude",
    it: "Anthropic, che sviluppa Claude",
    nl: "Anthropic, de maker van Claude",
    ja: "Claude を開発する Anthropic",
    ko: "Claude를 만드는 Anthropic",
    "zh-Hans": "开发 Claude 的 Anthropic",
    id: "Anthropic, yang membuat Claude",
    tr: "Claude'u geliştiren Anthropic",
    pl: "Anthropic, twórca Claude",
    ru: "Anthropic, создатель Claude",
  } as const;
  const inCopy = new RegExp(MAKER_WORDS.source, "i");

  // The phone's and the Mac app's own code: in their own tests, which run when only those apps change.
  test("the copy, the terms, and the web app's, design system's and client's code", () => {
    const copy = [
      ...leaves(en).map(([k, v]) => [`en ${k}`, v] as const),
      ...leaves(ptBR).map(([k, v]) => [`pt-BR ${k}`, v] as const),
    ]
      .filter(([, v]) => inCopy.test(String(v)))
      .map(([k]) => k);
    const legal = Object.entries(legalDocuments).flatMap(([kind, byLocale]) =>
      Object.entries(byLocale)
        .filter(([lng, doc]) => inCopy.test(JSON.stringify(doc).replaceAll(MAKER[lng as keyof typeof MAKER], "")))
        .map(([lng]) => `${kind} ${lng}`),
    );
    const words = filesNamingMakers(
      ["apps/web/src", "packages/ui/src", "packages/client/src"].map((d) => join(REPO, d)),
    );
    expect([...copy, ...legal, ...words.map((f) => relative(REPO, f))]).toEqual([]);
  });
});
