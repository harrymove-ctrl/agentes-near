/**
 * A help page on the site (`/help/<slug>`) as data: the background reading that stays off the app's screens, in
 * pt-BR and English. Inline text may carry `**bold**`, `` `code` ``, `[text](/help/<slug>#<id>)` or
 * `[text](https://…)`, and bare `https://` links (`helpInline`). A path through the app's menus has no-break spaces
 * around its "›", as in the app's own strings.
 */
export type HelpBlock = string | { list: string[] } | { code: string };

export interface HelpSection {
  /** Anchor on the page (`#folders`), the same in every language. */
  id: string;
  heading: string;
  blocks: HelpBlock[];
}

export interface HelpDocument {
  title: string;
  /** One line under the title. */
  summary: string;
  sections: HelpSection[];
}
