# 0122. Fourteen languages, English as the source

- Status: Accepted (foundation built; translations follow, one language at a time)
- Date: 2026-11-02
- Amends: 0035 (pt-BR was the source and the default; pushes in the device's language)
- Code: `packages/i18n/src/locale.ts` (registry), `load.ts`, `plurals.ts`, `format.ts`, `tree.ts`, `locales/*.json`,
  `glossary.json`, `test/check-locale.ts` (`@agenteschat/i18n/testing`), `test/identical.json`;
  `packages/client/src/lib/grammar.ts`, `locale-sync.ts`; `apps/web/src/i18n/index.ts`,
  `components/LanguageSelect.tsx`; `apps/mobile/src/providers/i18n.ts`, `src/i18n/merge.ts`,
  `src/features/i18n/locales.ts`; `apps/desktop/src/i18n/index.ts`; `packages/engine/src/email/words/*`,
  `push/messages/*`, `organizations.ts` (`setMyLocale`, `myAccount`); `apps/server/src/routes/app/account.ts`;
  `scripts/i18n.ts`; migration `0175_locales.sql`

## Context

The app spoke pt-BR (the source and the default) and English. The product is global: the owner decided on 14
languages everywhere people read us (web, phone, desktop, emails, pushes, server-made text, the landing): en, pt-BR,
es, fr, de, it, nl, ja, ko, zh-Hans, id, tr, pl, ru. No right-to-left language yet.

Every surface already used i18next 26 with react-i18next 17 (the phone adds expo-localization). i18next picks plural
forms with `Intl.PluralRules` (`_zero` … `_other`), supports context (`key_female`) and falls back per key; `Intl`
formats dates, numbers, money, lists and relative times. No new library is needed. A translation service (Weblate is
AGPL and self-hostable) waits for human translators.

## Decision

1. **Registry.** `LOCALES` holds each language's code, native name, English name, Intl tag, week start (CLDR; Firefox
   has no `getWeekInfo`), script and `ready`. Only ready languages are offered and detected; the server accepts every
   code. `appLocale` maps tags (pt-PT → pt-BR, es-MX → es, `in` → id, every Chinese tag → zh-Hans: Traditional Chinese
   has no translation, and Simplified reads closer than English). `intlLocale` keeps the browser's own regional tag
   (en-GB keeps 24 h and day-first dates).
2. **English is the source.** `Strings = Widen<typeof en>` types `t()`. pt-BR keeps its TypeScript file (its comments
   are notes for translators) and every other language is a JSON file; none is typed against English, so a language
   may have `_few`/`_many` or no `_one`. `checkLocale` checks each at test time: keys (missing only fails a ready
   language), plural categories per `Intl.PluralRules`, each form with its English form's `{{placeholders}}` (else
   `_other`'s; only `_zero`, and `_one` where it means 1 alone, may say the number in words, so ru's `_one`, also 21,
   keeps `{{count}}`) and tags, nothing empty, nothing
   left in English unless listed in `identical.json`, the glossary's keep-as-is names, no semicolons, the no-break
   spaces of menu paths and closing words (not for ja and zh-Hans). `fillPluralGaps` copies `_other` into `_many`
   (es, fr, it, pt-BR: round millions) and pt-BR's `_zero`.
3. **Loading.** Every desktop window loads one language and English (`loadStrings`, one chunk each;
   `loadDesktopI18n`), and the next on a switch. The web loads only the person's language when it is ready (§2: it
   holds every key), English too only with one that isn't, and that file comes with the app instead of after it: the
   build gives index.html each language's file (`vite-locale-preload.ts`) and its inline script preloads the one
   `savedLocale()` picks (`test/locale-preload.test.ts` keeps the two picks one). The phone requires the shared strings lazily (Metro runs a module on
   first `require`); its own and the desktop's small files (about 25 KB a language) are in the bundle. Native lists
   (expo `locales`, `supportedLocales`, the Mac's `CFBundleLocalizations`) name only ready languages, since the stores
   show them; a test keeps them equal to the ready set. i18next: `fallbackLng: "en"`, `supportedLngs: LOCALE_CODES`, `load: "currentOnly"`.
4. **Agent gender is context.** `agentGrammar(name)` returns `{ name, context }` (`female` for names ending in "a");
   every string that agreed with the agent through fragments (`{{The}}`, `{{article}}`, `{{she}}`…) was rewritten
   once into `key` and `key_female`. Sentences about two agents and about providers ("chave do Claude") were rewritten
   without articles; `providerGrammar` is gone.
5. **One language per person.** `users.locale` (emails, pushes) plus `users.locale_auto` (default true). A device
   shows: its own pick not yet sent (signed out, or a send that failed), else a language kept on the device while the
   server has none picked (a pick from before the server kept them), sent as picked, else a language picked anywhere
   (`locale_auto` false), else its own language ("Automático"), telling the server when that differs
   (`PATCH /api/app/me { locale, auto }`). Before sign-in: this device's pick, the landing's `agentes_locale` cookie,
   the browser's languages, English. Pickers: "Automático (detected)" then each language by its own name, in Settings,
   on the sign-in pages and on the phone's Language page. A help page's switch changes that page only (`?lang=`).
   The desktop's own windows (tray, Preferences, cover) run on the computer's runner token, not a person's session,
   so they never read `/me`: their language is a per-computer choice in Preferences, else the system's. The workspace
   window is the web app and follows the person's language like any browser.
6. **Server text.** Email words per language (`email/words/<code>.ts`, deep-merged over English, counts through
   `plural()`), push words per language over English, pushes in `users.locale` before the device's, the workspace
   computer's default name from the shared strings, dates and money through Intl and the registry, the CJK system
   fonts in the email stack. Jobs queued without a language render in English. A refusal code the app has no line for shows the server's words in English and a plain line by kind of
   refusal in every other language (`untranslatedText`); a guard test keeps new person-facing codes in `KNOWN`. A run's turn names the person's app language (for a file's
   title or a form's labels); replies still follow the language the person writes in.
7. **Formatting.** `@agenteschat/i18n/format`: `plural`, `formatList`, `formatMoneyUsd`, `formatDate`, `formatTime`,
   `relativeTime`, `dayMonthOrder`. Lists of names go through `joinNames(names, t)`, i18next's `list` format in
   `format.list` (Intl.ListFormat: "Ada, Atlas, and Theo", "Ada、Atlas、Theo"); "and N more" is the list's last item.
   A typed day follows `dayMonthOrder`. No case change on `t()` itself (a lowercase form is its own key); a fragment's
   first letter changes only through `lowerFirst`/`capitalize` in `client/lib/format`, with the language where the
   caller has it (German keeps it, Turkish dotted i); a name like "GitHub" always stays. No two `t()` glued with a space (`common.joinSentences`); guards
   in the web's tests cover the web, the phone, the desktop and the client.
8. **Fonts.** No web font download: Japanese, Korean and Chinese use each system's face after the Latin one, no
   `font-size-adjust`, strict line breaks, no italics; the desktop's Russian titles use Onest (Funnel Display has no
   Cyrillic). The phone's large titles use the system face already; its Funnel Display is only the wordmark and a
   document card's head (the document's own language, not the app's). Linux packages recommend `fonts-noto-cjk`. PDFs with CJK need embedded fonts (a follow-up).
9. **Translating.** `bun run i18n:missing <code>` lists what a language lacks, and what was translated from English
   that has changed since (`outdated`, with the English then), with its notes, placeholders, plural forms and feminine
   variant; `i18n:apply` merges a translated file after `checkLocale` and keeps each key's English in
   `<code>.source.json` beside the language; `i18n:status` shows each language's share and outdated keys per surface.
   A reviewer sets `ready: true` (and adds the language's native lists and iOS permission texts). Machine translation
   only with that review.

## Consequences

- Every new string is written in English first; a pt-BR string is a translation like the others.
- A language not ready is still accepted everywhere and shows English for what it lacks.
- pt-BR's defaults changed to English for people with no language (old email jobs, the waiting list's default).
- Open: Traditional Chinese readers get Simplified; Spanish register; whether Terms and Privacy translations ship
  before a lawyer reads them (each carries "English prevails"); help pages on the landing; the app host's
  `robots.txt` and 404s for files (research findings awaiting approval); PDF fonts.
