import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
// @ts-expect-error: @babel/core ships no types (the build's React compiler brings it), and the parse is walked untyped
import { parseSync } from "@babel/core";
import { sourceFiles } from "../../../packages/i18n/test/maker-words";

// Babel's first parse replaces `Error.prepareStackTrace` for good, with a rewriter that hands every stack to the one
// before it. Bun's own refuses anything but a real Error, so once this file ran, `Error.captureStackTrace` on a plain
// object threw in every later file of the run: Vite's bundled follow-redirects does that while it loads, which broke
// each stylesheet test (`built-css.ts`). The runtime's own come back when this file is done.
const runtimeStack = { prepare: Error.prepareStackTrace, limit: Error.stackTraceLimit };
afterAll(() => {
  Error.prepareStackTrace = runtimeStack.prepare;
  Error.stackTraceLimit = runtimeStack.limit;
});

const REPO = join(import.meta.dir, "..", "..", "..");
const ROOTS = [join(import.meta.dir, "..", "src"), join(REPO, "packages", "ui", "src")];

/** The dialog's own sections, each on the dialog's inset (`--dialog-pad`). */
const SECTIONS = new Set(["DialogBody", "DialogFooter", "DialogSearchList"]);
/** Wrappers whose children are the sections. */
const WRAPPERS = new Set(["form", "Suspense", "Locked"]);
/**
 * Custom sections, each with its own inset on `--dialog-pad`, or full bleed on purpose under a rule (the catalog's
 * grid, a channel's settings with their nav).
 */
const OWN_INSET =
  /\b(ac-dialog__\w+|cflow__steps|catalog__tools|catalog__body|catalog-svc__body|catalog-svc__act|channel-settings|ac-steps|pu-drawer__body)\b/;
/** Components from other files that render sections (checked where they are defined). */
const SECTION_COMPONENTS = new Set([
  "ConnectFlow",
  "ConnectedDone",
  "ConnectedRepos",
  "ConnectorSky",
  "EndpointForm",
  "ServiceDialog",
  "SkyStrip",
  "ComputerStage",
  "ProfilePhotoDialog",
  "AndroidFlow",
  "IphoneFlow",
  "FlowFooter",
  "JoinRequestForm",
]);

// biome-ignore lint/suspicious/noExplicitAny: Babel's AST, walked by node type
type Node = any;

const tagName = (n: Node): string =>
  n.type === "JSXIdentifier"
    ? n.name
    : n.type === "JSXMemberExpression"
      ? `${tagName(n.object)}.${tagName(n.property)}`
      : "";
const className = (el: Node, source: string): string => {
  const attr = el.openingElement.attributes.find((a: Node) => a.name?.name === "className");
  return attr?.value ? source.slice(attr.value.start, attr.value.end) : "";
};

/** What a component defined in the same file returns: the JSX of its `return`s (or its arrow's body). */
function returnsOf(ast: Node, name: string): Node[] {
  const found: Node[] = [];
  const collect = (fn: Node) => {
    if (fn.body.type !== "BlockStatement") return found.push(fn.body);
    const walk = (n: Node) => {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "ReturnStatement" && n.argument) found.push(n.argument);
      if (/Function/.test(n.type) && n !== fn) return;
      for (const k in n) if (k !== "loc") for (const v of [n[k]].flat()) if (v && typeof v === "object") walk(v);
    };
    walk(fn.body);
  };
  const walk = (n: Node) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "FunctionDeclaration" && n.id?.name === name) collect(n);
    if (n.type === "VariableDeclarator" && n.id?.name === name && /Function/.test(n.init?.type ?? "")) collect(n.init);
    for (const k in n) if (k !== "loc") for (const v of [n[k]].flat()) if (v && typeof v === "object") walk(v);
  };
  walk(ast);
  return found;
}

function offendersIn(file: string): string[] {
  const source = readFileSync(file, "utf8");
  if (!/<Dialog\b/.test(source)) return [];
  const ast = parseSync(source, {
    filename: file,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["jsx", "typescript"] },
  });
  const out: string[] = [];
  const at = (n: Node) => `${relative(REPO, file)}:${n.loc.start.line}`;
  const seen = new Set<string>();
  // A node the dialog renders between its head and its edge: a section, or something that renders sections.
  const check = (n: Node, depth = 0): void => {
    if (!n || depth > 6) return;
    switch (n.type) {
      case "JSXText":
        if (n.value.trim()) out.push(`${at(n)} text "${n.value.trim()}" outside a section`);
        return;
      case "JSXExpressionContainer":
        check(n.expression, depth);
        return;
      case "JSXEmptyExpression":
      case "NullLiteral":
      case "BooleanLiteral":
      case "Identifier":
      case "MemberExpression":
        return;
      case "LogicalExpression":
        check(n.right, depth);
        return;
      case "ConditionalExpression":
        check(n.consequent, depth);
        check(n.alternate, depth);
        return;
      case "JSXFragment":
        for (const c of n.children) check(c, depth);
        return;
      case "JSXElement": {
        const tag = tagName(n.openingElement.name);
        // Another dialog opens over this one (its own portal), checked where it is written.
        if (SECTIONS.has(tag) || /Dialog$/.test(tag) || SECTION_COMPONENTS.has(tag)) return;
        if (OWN_INSET.test(className(n, source))) return;
        if (WRAPPERS.has(tag)) {
          for (const c of n.children) check(c, depth);
          return;
        }
        const own = /^[A-Z]/.test(tag) ? returnsOf(ast, tag) : [];
        if (own.length > 0) {
          if (seen.has(tag)) return;
          seen.add(tag);
          for (const r of own) check(r, depth + 1);
          return;
        }
        out.push(`${at(n)} <${tag}> outside the dialog's sections (DialogBody / DialogFooter)`);
        return;
      }
      default:
        out.push(`${at(n)} ${n.type} outside the dialog's sections`);
    }
  };
  const walk = (n: Node) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "JSXElement" && tagName(n.openingElement.name) === "Dialog") {
      const bare = n.openingElement.attributes.some((a: Node) => a.name?.name === "bare");
      if (!bare) for (const c of n.children) check(c);
    }
    for (const k in n) if (k !== "loc") for (const v of [n[k]].flat()) if (v && typeof v === "object") walk(v);
  };
  walk(ast);
  return out;
}

describe("dialog sections", () => {
  test("everything under a dialog's head sits in a section on the dialog's inset", () => {
    const offenders = ROOTS.flatMap((root) => sourceFiles(root, /\.tsx$/).flatMap(offendersIn));
    expect(offenders).toEqual([]);
  });
});
