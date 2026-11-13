import { expect, test } from "bun:test";
import path from "node:path";
import { atRule, declarations, topLevel } from "./built-css";

const ROOT = path.join(import.meta.dir, "../../..");
const sheet = (file: string) => Bun.file(path.join(ROOT, file)).text();
const last = (pairs: (readonly [string, string])[], property: string) => pairs.findLast(([p]) => p === property)?.[1];

test("a narrow task card wraps its facts between facts, never inside one or past its edge", async () => {
  const kit = await sheet("packages/ui/src/styles/components.css");
  // "Pergunta algo" and "PR #109" side by side ran off a board card's right edge: no plates now, one line of facts.
  expect(last(declarations(kit, ".ac-factline"), "flex-wrap")).toBe("wrap");
  // A fact is as wide as its words, so it moves down whole. Only one alone wider than the card (a long repository's
  // link, a long label) wraps its own words, never past the card's padding.
  const fact = declarations(kit, ".ac-factline__fact");
  expect(last(fact, "white-space")).toBeUndefined();
  expect(last(fact, "max-width")).toBe("100%");
  expect(last(fact, "overflow-wrap")).toBe("anywhere");
  expect(last(declarations(kit, '.ac-factline__fact[data-tone="label"]'), "overflow-wrap")).toBe("anywhere");
});

test("a task's state moves whole under the name, and one longer than the card wraps inside it", async () => {
  const issues = await sheet("apps/web/src/pages/issues.css");
  // "Bloqueado · não terminou: …" with a run's reason drew past a 248px card on one line.
  const state = declarations(issues, ".issue-card__state");
  expect(last(state, "display")).toBe("inline-block");
  expect(last(state, "max-width")).toBe("100%");
  expect(last(state, "white-space")).toBeUndefined();
});

test("a wide task row's parts share their first line: what wraps grows down from it, never floats to the middle", async () => {
  const issues = await sheet("apps/web/src/pages/issues.css");
  // A stopped run's reason five lines tall beside the title centred "#135 Gerar o relatório" against its third line.
  expect(last(declarations(topLevel(issues), ".issue-list__row"), "align-items")).toBe("baseline");
});

test("on a phone a task row is stacked as a card: its facts wrap under its title, from the row's start", async () => {
  const issues = await sheet("apps/web/src/pages/issues.css");
  // "Pede aprovação" beside the face ran 23px past its column and 9px past the row at 390px.
  const narrow = atRule(issues, "@media (max-width: 720px)");
  expect(last(declarations(narrow, ".issue-list__row"), "flex-direction")).toBe("column");
  expect(last(declarations(narrow, ".issue-list__row > .issue-card__facts"), "justify-content")).toBe("flex-start");
  // The number joins the facts there.
  expect(last(declarations(narrow, ".issue-list__row > .issue-card__facts > :first-child"), "display")).toBe(
    "inline-flex",
  );
});

test("a version's note longer than its line breaks instead of running past its card", async () => {
  const kit = await sheet("packages/ui/src/styles/components.css");
  const drive = await sheet("apps/web/src/pages/drive.css");
  // "alerta confirmado15:15:57Brasília,link/ts/ação" ran past the version card's right edge, in the file viewer's
  // versions and in the Drive's. break-word, not anywhere: no box sizes itself differently for it.
  expect(last(declarations(kit, ".ac-navcard"), "overflow-wrap")).toBe("break-word");
  expect(last(declarations(drive, ".drive-versions__text"), "overflow-wrap")).toBe("break-word");
  // The wiki's versions and an agent's quoted reason on a browser request: text in a flex row, which only anywhere
  // lets shrink below its longest word.
  const wiki = await sheet("apps/web/src/pages/wiki.css");
  const browser = await sheet("apps/web/src/components/browser/browser.css");
  expect(last(declarations(wiki, ".wiki-history__item"), "overflow-wrap")).toBe("anywhere");
  expect(last(declarations(browser, ".brw-rq__why"), "overflow-wrap")).toBe("anywhere");
  // A toast's names and titles (a setor someone named) ran under its × and past its edge.
  expect(last(declarations(kit, ".ac-toast__text"), "overflow-wrap")).toBe("break-word");
  // Not the whole app: a word in an already squeezed box would break letter by letter.
  expect(last(declarations(kit, "body"), "overflow-wrap")).toBeUndefined();
});
