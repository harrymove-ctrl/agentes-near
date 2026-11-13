import { expect, test } from "bun:test";
import { helpEn } from "../src/help/pages.en";
import { helpPtBR } from "../src/help/pages.pt-BR";
import { en, ptBR } from "../src/index";
import { unplainCalls, unplainLeaves } from "./plain-marks";

test("the app's words and the help pages: no semicolon, no em dash", () => {
  expect([en, ptBR, helpEn, helpPtBR].flatMap((tree) => unplainLeaves(tree))).toEqual([]);
});

test("code keeps its marks, words don't", () => {
  const tree = {
    a: "Two; one",
    b: "Run `cd x; ls`",
    c: "Ana &amp; Bia",
    d: { blocks: [{ code: "cd x; ls" }] },
    e: "A — B",
    x: { code: "Code from the email; check your spam" },
    members: { column: { group: "{{name}} — {{count}}", label: "A — B" } },
  };
  expect(unplainLeaves(tree)).toEqual([
    "a: Two; one",
    "e: A — B",
    "x.code: Code from the email; check your spam",
    "members.column.label: A — B",
  ]);
});

test("the server's words: each call that answers people, never a log line", () => {
  const source = `
    throw new RunnerError("internal", "Stopped; try again");
    this.endSession(w, "The worker stopped; try again");
    this.endShows(w, \`Gone; \${why}\`);
    this.unanswered("Stopping; wait");
    throw new ChromeStartError(inUse ? "Chrome closed; another Chrome holds it" : "Chrome closed", detail);
    this.log("disconnected; reconnecting");
  `;
  expect(unplainCalls(source)).toEqual([
    "Stopped; try again",
    "The worker stopped; try again",
    "Gone; ",
    "Stopping; wait",
    "Chrome closed; another Chrome holds it",
  ]);
});
