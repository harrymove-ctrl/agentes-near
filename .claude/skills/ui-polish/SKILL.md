---
name: ui-polish
description: agentes.chat UI rules and routine. Use before any UI, CSS, layout, spacing, alignment, component, screen, page, dialog, card, chat, menu, toolbar, form, email or on-screen copy change in agentes.chat (apps/web, packages/ui, apps/mobile, apps/desktop), and for any design review or polish pass. Every rule is a number. The routine fixes the kit component, sweeps every sibling, keeps the CI geometry check green, shoots before and after at 1280 and 390, and runs break-ui and Impeccable's audit.
---

# UI polish for agentes.chat

Measure, don't eyeball. Vision misses 1 to 2 px errors, source review can't see pixels, and a screenshot diff shows what changed, not what's wrong. Check the rendered screen.

## The kit's numbers (packages/ui tokens)

- Three control heights: 32 (toolbars, list filters, in-row actions, composer), 40 (forms, page and dialog buttons, search, selects, sidebar items), 48 (only the main action of a full screen). Radius is 30% of the height. Pills only for labels you don't press.
- Spacing steps 4, 8, 12, 16, 24, 32. Form fields 16 apart, a label 4 from its control. List rows 8 above and below (`--row-py`, 12 on touch): one line 36, with a 24 face 40, with a 32 control 48. Cards 16 inside (`--card-pad`). A plated button stays 8 from its row's or card's edges (`--action-clear`). A row of actions (`.ac-acts`) puts 16 between what the eye sees, on touch too, and two plated buttons 8 apart. A small button keeps its 32 plate on touch: its target grows to 44 past it (`--touch-target`), up and down only when it has words.
- Every page starts at `--page-top` (its title's line on the sidebar's workspace row, 20 on phones) and `--page-x` (24, 16 under 640). Header, toolbar and content 16 apart, list groups 24 (`.ac-groups`).
- No raw px for padding, gaps or heights. Use the tokens.
- Rounded inside rounded: inner radius is the outer radius minus the gap between them.
- Fonts are fixed: Source Sans 3 (the app, titles too), JetBrains Mono (code), Funnel Display (brand), Doto (dot type), Onest and Martian Mono (the kit's defaults, the desktop app). Never swap or "improve" them, whatever a tool suggests. A new font gets `--cap-mid` and `--cap-top` measured again.

## Rules

Layout
1. One spacing, padding and toolbar on every page: search on the left, tabs, filters and selects on the right. The page title starts at the same top and side on every page. From 761 the toolbar keeps one row, the search giving way down to 160. When even that can't fit it takes two rows (the search and the actions, then the filters in one sideways row). The search never goes under 160, on a phone either: when the actions don't fit beside it, it takes the top row alone and the actions lead the filters' row. Never a control alone on a row: a lone small filter shares a row, a lone segmented control fills its own.
2. Dense but comfortable, like Resend. When a screen feels crowded, regroup and space it. Don't just delete.
3. Content takes all the width it has. Fields in one form fill its width, each control as wide as its stack.
4. A leading square (face, icon tile, logo) never owns a column while the text beside it is squeezed: face, name and role on one line, text and controls full width below. A square beside 3 or more lines is a bug. This covers cards and the inbox. A DM has no face column at all, its header already says who it is.
5. Chat messages: the name's capitals start at the face's top (`.ac-faceline` with `.ac-captop`), and message text uses the full column width.
6. A dialog's inner card reads square-ish, never a wide flat strip.

Alignment and spacing
7. Controls side by side share one height. Shrink the taller one.
8. Gaps between buttons are even and never zero: plated buttons 8 apart, icon buttons' plates 8 apart, header glyph boxes 32 and 8 apart. Header icon buttons get no plate on hover or press, only the icon colour changes.
9. Faces, tiles and controls stay at least 8 from every row edge and divider, also inside a highlighted or bordered row. Top padding equals bottom, left equals right.
10. Icons, ⓘ and count badges centre on the capitals' middle within 1 px (`.ac-iconline`, `0.5lh - var(--cap-mid)`), also inside a line of words. A face beside one line centres on it. Words right after an inline face share its baseline. Initials sit optically centred in their tile.
11. A picture taller than 1.25 lines beside 2 or more lines: the first line's capitals start at its top (`.ac-captop`). A step badge beside a name and a subtitle centres on the whole two-line block.
12. Menu rows are their kind's height, 2 apart, the menu's padding 4: a line 32, a name with its description 50, a row with a face 36 (40, 58 and 44 on touch). Every option in one select is the same height, a description line never makes one taller. A select never shows empty. A people select shows a small face.
13. List times end on one right edge. A list heading (GroupHeading) sits on its list's outer edge, 8 above it, 16 under the toolbar.
14. Text and placeholders sit vertically centred in their inputs.
15. Borders and shadows survive rounded corners. Hover backgrounds stay inside their row. A scrolling parent never cuts a control's ring.
16. One class keeps one height, padding and gap on every screen.

Text
17. Wrap meaning, never cut it with an ellipsis. Give a fact value the room to stay on one line. No row wraps word by word. Words and their actions (a title and its buttons, a notice and its fix, a toast and Desfazer) are an action line (`.ac-actline`, phone `ACT_LINE`): the actions sit beside the words only while the words fit on one line there, else on a row of their own under the words, from their edge. A close × stays beside the title, outside the line. Ver detalhes and every toggle like it go under their words. Only one small control that keeps its place (a switch, a select, a chevron) ends a row with `.ac-actrow`.
18. No button covers text. Desfazer never takes its own column: it goes at the end of its sentence, or under it when there's no room.
19. Badge, pill and button text 4.5:1 (3:1 for large text) in both themes. An unread or waiting count at least 3:1 against what's behind it.
20. Less text: a title, at most one short sentence, the controls. Help goes behind an ⓘ beside its label, a title plus one sentence (Field's and SettingRow's `hint`). Under a field only a format example (`example`) or an error. Under a setting only what must stay in sight (`status`). Background reading goes to a site page, linked once. Cut sentences that only reassure.
21. No semicolons in product copy, in any language or surface. No em dashes, except member group headers like "DONO — 1". Long "·" chains read dense.
22. Links use the house link style, never the browser's blue underline. Third-party products and AI providers show their official logo, never a generic icon. Text between backticks is an inline code pill (`.ac-inlinecode`) wherever formatted words show: a message, a document, an agent's words on a card.

Components
23. On phones, a card's lone primary button is full width (at least 90% of the card).
24. Bulk actions (Aprovar tudo, Agora não para todos) are compact and aligned, never tall floating buttons.
25. Cards inside a message share one width and stand apart from the row's hover in both themes. A group of one shows the item itself, not "Used 1 tool".
26. A link that only shows one dialog opens it in place. It never navigates away.
27. Calendar events follow Google Calendar's look, with no curved accent border.
28. A long-running screen always has a way out (stop or back). A failure says what happened and offers a retry.
29. Motion is smooth. Nothing pops in, not a new card, not an opened thread.
30. Scrolling columns hide their thumb until hover.
31. Emails carry the agentes.chat look in light and dark clients.

Discord-style layout
32. Members column on the right, open by default on desktop, toggled from the header. Roles have configurable colours and their marks are full circles.
33. Agents hold no roles. Their card shows "Quem pode falar" as plain lines (mark or face, then name) with an "Editar" link, never pills.
34. Unread is a bold name and a left pill. A red count only for mentions.
35. The left sidebar has one "Mensagens diretas" section. The pinned bar under the header stays.

## Routine for every UI change

1. A big batch (many screens or reports): show proposals first, with the before, the after and the reporter's exact words per item. Build after the go-ahead.
2. Fix the kit component in packages/ui, where every caller routes through, not the one screen.
3. Sweep: grep every place the pattern appears in apps/web, packages/ui, apps/mobile and apps/desktop, including places nobody reported, and fix them in the same change. The phone gets the same fix.
4. Run break-ui on worst-case data at real widths (below).
5. Run Impeccable's audit and triage the hook's findings (below).
6. Keep the geometry check green. CI's Geometry step lays out every screen the tests reach at 1280 and 320 (`scripts/geometry`). Locally run only `bun test scripts/geometry/check.test.ts`. A rule here with no check yet gets one in `scripts/geometry/rules.js`, with a bad and a good fixture. Update `baseline.json` only after fixing offenders or for a verified false positive.
7. Measure what ships. The build can order CSS differently from dev (a `translate` beside a `transform` was dropped once). Check the build's CSS too.
8. Shots before and after at 1280 and 390, light and dark when colour changed, with toggled states open (menus, Advanced sections, expanded rows, hover). After shipping, publish one before and after page. Each release also gets a visual sweep for problems nobody reported.
9. Done means every clause of the ask is checked on a real screen.

## break-ui

Run the break-ui skill on any component or screen that renders data: names, emails, counts, titles, translations, empty and huge lists. Look at the component's real container width, at 320 and at the widest, and in dark mode. Feed the worst case through the component's test fixture, so CI's geometry check keeps measuring it. Its dev-only toggle never ships.

## Impeccable

- Its hook runs by itself after every Edit or Write of a UI file, and again at Stop. Fix real findings. For a false positive, say why in your reply. Add an ignore only with `--local` (git-excluded), never in the shared `.impeccable/config.json` of this public repo without approval.
- Before calling a screen done, run `/impeccable audit <target>`. It only reports.
- For a fast deterministic pass over many files, run the launcher in the impeccable skill's folder: `scripts/impeccable detect <paths>`.
- In this repo, don't run the commands that write project files or change the product's look: `init`, `document`, `extract`, `critique` (it saves reports into the repo), `live`, `generate`, `craft`, `shape`, `bolder`, `overdrive`, `colorize`, `delight`, `pin`, `hooks on` or `hooks off`. Its live mode stays off (`IMPECCABLE_LIVE_COPY_AGENT=off`). Never take its font advice.
- Keep frontend-design and design-taste-frontend off app screens.
