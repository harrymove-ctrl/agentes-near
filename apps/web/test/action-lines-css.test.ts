import { expect, test } from "bun:test";

const sheet = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url).pathname).text();
/** The declarations of the first rule written exactly as `selector {`, at the top level or one block deep. */
const rule = (css: string, selector: string) =>
  (css.split(`\n${selector} {`)[1] ?? css.split(`\n  ${selector} {`)[1])?.split("}")[0] ?? "";

test("words and their actions are action lines: the actions under the words when they don't fit beside them", async () => {
  const receipts = await sheet("components/agent-actions.css");
  expect(rule(receipts, ".ag-rc > .ac-actline")).toContain("flex: 1 1 0%");
  const layout = await sheet("layout.css");
  expect(rule(layout, ".chart-card__top")).toContain("padding: 6px 16px 4px");
  expect(rule(layout, ".chart-card__titles")).not.toContain("flex: 1");
  expect(rule(layout, ".code-card__top")).toContain("min-height: 38px");
  expect(rule(layout, ".code-card__top")).not.toMatch(/(^|\n)\s*height:/);
  // The code to copy never touches its copy button.
  expect(rule(layout, ".machine-command")).toContain("gap: var(--space-1)");
  // A narrow list puts an agent's Abrir under its words, past the face.
  expect(layout).toContain(".machine-page__agents {\n  container-type: inline-size;\n}");
  expect(rule(layout, ".settings-row__lead")).toContain("display: flex");
  const blocks = await sheet("components/blocks/blocks.css");
  expect(rule(blocks, ".live-block__head")).toContain("gap: var(--space-2) var(--space-4)");
  const search = await sheet("components/search/search.css");
  expect(search).toContain(
    "@media (max-width: 640px) {\n  .search-result {\n    grid-template-columns: minmax(0, 1fr);",
  );
  const review = await sheet("pages/new-agent.css");
  expect(rule(review, ".newag__rv")).toBeTruthy();
  expect(review).toContain('grid-template-areas: "k end" "v v";');
});

test("a receipt keeps no room for an action in its sentence", async () => {
  const css = await sheet("components/agent-actions.css");
  for (const gone of [".ag-rc__act", ".ag-rc__room", ".ag-rc__time", ".ag-rcg__grow"]) expect(css).not.toContain(gone);
  // The webhook address's copy button keeps its words-only face.
  expect(rule(css, ".ag-rc__btn")).toContain("background: none");
});

test("buttons side by side stand 8 apart: header glyph boxes 32, bulk pairs, a request's lone button fills on a phone", async () => {
  const header = await sheet("components/channel-header.css");
  expect(rule(header, ".channel__acts")).toContain("gap: var(--space-2)");
  expect(rule(header, ".channel__icon.ac-btn")).toContain("width: var(--control-h-sm)");
  expect(rule(header, ".channel__icon.ac-btn")).toContain("margin: 0;");
  expect(header).not.toContain("column-gap: 8px");
  const approvals = await sheet("pages/approvals.css");
  expect(rule(approvals, ".ap-group__head")).toContain("flex-direction: column");
  expect(rule(approvals, ".ap-group__head")).toContain("padding: 0");
  expect(rule(approvals, ".ap-group__acts")).toContain("gap: var(--space-2)");
  const card = await sheet("components/request-card.css");
  // A lone button with nothing else to press fills the footer; one main button beside ghosts (Depois, or a waiting
  // card's Lembrar depois and Concluído) grows into their row; two main buttons keep their widths.
  expect(rule(card, ".rq__foot:not(:has(> .ac-btn ~ .ac-btn)):not(:has(.ac-btn--ghost)) > .ac-btn")).toContain(
    "flex: 1 1 100%",
  );
  expect(card.replace(/\s+/g, " ")).toContain(
    ".rq__foot:has(.ac-btn--ghost):not(:has(> .ac-btn:not(.ac-btn--ghost) ~ .ac-btn:not(.ac-btn--ghost))) > .ac-btn:not(.ac-btn--ghost) { flex: 1 1 auto; }",
  );
  for (const [path, selector] of [
    ["components/members/members.css", ".members-sheet__acts"],
    ["pages/threads.css", ".thread-row__actions"],
    ["pages/routines.css", ".routine-row__actions"],
    ["pages/wiki.css", ".wiki-pickbar__acts"],
    ["layout.css", ".outage__acts"],
  ] as const)
    expect(rule(await sheet(path), selector)).toContain("gap: var(--space-2)");
});
