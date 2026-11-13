import type { AppLocale } from "./locale";

/**
 * The mention of everyone in a conversation (Discord's `@everyone`), one word per language: each person types and
 * reads their own, and the message stores only that it mentions everyone (`meta.mentionsEveryone`). Any language's
 * word works for anyone. Changing one leaves old messages' word as plain text.
 */
export const EVERYONE_WORD: Record<AppLocale, string> = {
  en: "everyone",
  "pt-BR": "todos",
  es: "todos",
  fr: "tous",
  de: "alle",
  it: "tutti",
  nl: "iedereen",
  ja: "全員",
  ko: "모두",
  "zh-Hans": "所有人",
  id: "semua",
  tr: "herkes",
  pl: "wszyscy",
  ru: "все",
};

export const EVERYONE_WORDS: readonly string[] = [...new Set(Object.values(EVERYONE_WORD))];

/** The word a reader of `locale` types and sees (English for a language without one). */
export const everyoneWord = (locale: string): string => EVERYONE_WORD[locale as AppLocale] ?? EVERYONE_WORD.en;

export const isEveryoneWord = (word: string): boolean => EVERYONE_WORDS.includes(word.toLowerCase());

/**
 * `@todos`, `@everyone`, `@全員`… as a mention: the handles' bounds (not inside a word or an email, nothing of a word
 * glued after), in any script.
 */
const EVERYONE_MENTION = new RegExp(`(^|[^\\p{L}\\p{N}_@.])@(${EVERYONE_WORDS.join("|")})(?![\\p{L}\\p{N}_@-])`, "iu");

/** Whether a text mentions everyone in some language. */
export const mentionsEveryone = (text: string): boolean => EVERYONE_MENTION.test(text);
