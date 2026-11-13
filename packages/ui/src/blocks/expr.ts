/**
 * The formula language of live blocks (ADR 0113): what an agent writes so a block can compute (a margin from a price,
 * a projection month by month, a filtered list) without running any code of its own. It is parsed and evaluated here,
 * by our own interpreter, on the server (to check a block before it is shown) and in the apps (to draw it). Nothing
 * in it can reach anything but the values handed to it: no globals, no prototypes, no loops but the list functions,
 * and every evaluation has a step budget, so a formula can be wrong but never harmful or endless.
 *
 * Syntax, close to a spreadsheet's and to JavaScript's expressions:
 * - numbers `12`, `1.5`, `2e3`; text `'Ana'` or `"Ana"`; `true`, `false`, `null`
 * - names of the block's values, `row.price`, `list[0]`, `list.length`
 * - `+ - * / %`, power `^` (or `**`), `== != < <= > >=`, `&& || !`, `cond ? a : b`
 * - lists `[1, 2]` and records `{label: 'A', value: x}`
 * - functions (`FUNCTIONS`), some taking a step `x => x.value * 2` for each item of a list
 */

export type Value = number | string | boolean | null | Value[] | { [key: string]: Value };

export type Expr =
  | { t: "lit"; v: Value }
  | { t: "name"; name: string }
  | { t: "list"; items: Expr[] }
  | { t: "record"; entries: [string, Expr][] }
  | { t: "unary"; op: "-" | "+" | "!"; arg: Expr }
  | { t: "binary"; op: string; left: Expr; right: Expr }
  | { t: "cond"; test: Expr; then: Expr; else: Expr }
  | { t: "member"; obj: Expr; key: string }
  | { t: "index"; obj: Expr; index: Expr }
  | { t: "call"; fn: string; args: Expr[] }
  | { t: "step"; params: string[]; body: Expr };

/** What any formula may take: its source, its depth, the items a list may hold and the work one evaluation may do. */
export const EXPR_LIMITS = {
  chars: 2000,
  depth: 48,
  listItems: 2000,
  textChars: 10_000,
  steps: 200_000,
} as const;

export class ExprError extends Error {
  override name = "ExprError";
}

type Token =
  | { k: "num"; v: number; at: number }
  | { k: "str"; v: string; at: number }
  | { k: "id"; v: string; at: number }
  | { k: "op"; v: string; at: number }
  | { k: "end"; at: number };

const OPS = ["=>", "**", "==", "!=", "<=", ">=", "&&", "||", "===", "!=="];
const SINGLE = "+-*/%^<>!?:()[]{},.";

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      const text = m?.[0] ?? c;
      out.push({ k: "num", v: Number(text), at: i });
      i += text.length;
      continue;
    }
    if (c === "'" || c === '"') {
      let s = "";
      let j = i + 1;
      for (;;) {
        const d = src[j];
        if (d === undefined) throw new ExprError(`Text started at ${i + 1} never ends`);
        if (d === c) break;
        if (d === "\\") {
          const e = src[j + 1];
          s += e === "n" ? "\n" : e === "t" ? "\t" : (e ?? "");
          j += 2;
          continue;
        }
        s += d;
        j++;
      }
      out.push({ k: "str", v: s, at: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_À-ɏ]/.test(c)) {
      const m = /^[A-Za-z_À-ɏ][\wÀ-ɏ]*/.exec(src.slice(i));
      const text = m?.[0] ?? c;
      out.push({ k: "id", v: text, at: i });
      i += text.length;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (three === "===" || three === "!==") {
      out.push({ k: "op", v: three.slice(0, 2), at: i });
      i += 3;
      continue;
    }
    if (OPS.includes(two)) {
      out.push({ k: "op", v: two, at: i });
      i += 2;
      continue;
    }
    if (SINGLE.includes(c)) {
      out.push({ k: "op", v: c, at: i });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected "${c}" at ${i + 1}`);
  }
  out.push({ k: "end", at: src.length });
  return out;
}

/** Binary operators, loosest first. */
const LEVELS: string[][] = [["||"], ["&&"], ["==", "!="], ["<", "<=", ">", ">="], ["+", "-"], ["*", "/", "%"]];

/** A formula's tree, or an `ExprError` that says where it went wrong. */
export function parseExpr(src: string): Expr {
  if (typeof src !== "string") throw new ExprError("A formula must be text");
  if (src.length > EXPR_LIMITS.chars) throw new ExprError("This formula is too long");
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p] as Token;
  const isOp = (v: string) => {
    const t = peek();
    return t.k === "op" && t.v === v;
  };
  const take = (v: string) => {
    if (!isOp(v)) {
      const t = peek();
      throw new ExprError(
        t.k === "end" ? `Expected "${v}" at the end` : `Expected "${v}" at ${t.at + 1}, found ${show(t)}`,
      );
    }
    p++;
  };
  const show = (t: Token) => (t.k === "end" ? "the end" : `"${String(t.v)}"`);
  const deeper = () => {
    if (++depth > EXPR_LIMITS.depth) throw new ExprError("This formula is nested too deep");
  };

  function expression(): Expr {
    deeper();
    try {
      return ternary();
    } finally {
      depth--;
    }
  }

  function ternary(): Expr {
    const test = binary(0);
    if (!isOp("?")) return test;
    p++;
    const then = expression();
    take(":");
    return { t: "cond", test, then, else: expression() };
  }

  function binary(level: number): Expr {
    if (level >= LEVELS.length) return unary();
    let left = binary(level + 1);
    for (;;) {
      const t = peek();
      if (t.k !== "op" || !(LEVELS[level] as string[]).includes(t.v)) return left;
      p++;
      left = { t: "binary", op: t.v, left, right: binary(level + 1) };
    }
  }

  function unary(): Expr {
    const t = peek();
    if (t.k === "op" && (t.v === "-" || t.v === "+" || t.v === "!")) {
      p++;
      deeper();
      try {
        return { t: "unary", op: t.v, arg: unary() };
      } finally {
        depth--;
      }
    }
    return power();
  }

  function power(): Expr {
    const base = postfix();
    if (isOp("^") || isOp("**")) {
      p++;
      return { t: "binary", op: "^", left: base, right: unary() };
    }
    return base;
  }

  function postfix(): Expr {
    let e = primary();
    for (;;) {
      if (isOp(".")) {
        p++;
        const t = peek();
        if (t.k !== "id") throw new ExprError(`Expected a name after "." at ${t.at + 1}`);
        p++;
        e = { t: "member", obj: e, key: t.v };
      } else if (isOp("[")) {
        p++;
        const index = expression();
        take("]");
        e = { t: "index", obj: e, index };
      } else if (isOp("(")) {
        if (e.t !== "name") throw new ExprError(`Only a function name can be called (at ${peek().at + 1})`);
        p++;
        const args: Expr[] = [];
        if (!isOp(")")) {
          do args.push(argument());
          while (isOp(",") && ++p);
        }
        take(")");
        if (!Object.hasOwn(FUNCTIONS, e.name)) throw new ExprError(`There is no function "${e.name}"`);
        e = { t: "call", fn: e.name, args };
      } else return e;
    }
  }

  /** A function's argument: a step (`x => …`, `(a, i) => …`) or a value. */
  function argument(): Expr {
    const t = peek();
    const next = toks[p + 1];
    if (t.k === "id" && next?.k === "op" && next.v === "=>") {
      p += 2;
      return { t: "step", params: [t.v], body: expression() };
    }
    if (t.k === "op" && t.v === "(") {
      // `(a, i) => …`: a list of names, a closing parenthesis, then the arrow.
      let q = p + 1;
      const params: string[] = [];
      while (toks[q]?.k === "id") {
        params.push(String((toks[q] as { v: string }).v));
        const sep = toks[q + 1];
        if (sep?.k === "op" && sep.v === ",") q += 2;
        else {
          q++;
          break;
        }
      }
      const close = toks[q];
      const arrow = toks[q + 1];
      if (close?.k === "op" && close.v === ")" && arrow?.k === "op" && arrow.v === "=>") {
        p = q + 2;
        return { t: "step", params, body: expression() };
      }
    }
    return expression();
  }

  function primary(): Expr {
    const t = peek();
    if (t.k === "num") {
      p++;
      return { t: "lit", v: t.v };
    }
    if (t.k === "str") {
      p++;
      return { t: "lit", v: t.v };
    }
    if (t.k === "id") {
      p++;
      if (t.v === "true") return { t: "lit", v: true };
      if (t.v === "false") return { t: "lit", v: false };
      if (t.v === "null") return { t: "lit", v: null };
      return { t: "name", name: t.v };
    }
    if (t.k === "op" && t.v === "(") {
      p++;
      const e = expression();
      take(")");
      return e;
    }
    if (t.k === "op" && t.v === "[") {
      p++;
      const items: Expr[] = [];
      if (!isOp("]")) {
        do {
          if (isOp("]")) break;
          items.push(expression());
        } while (isOp(",") && ++p);
      }
      take("]");
      return { t: "list", items };
    }
    if (t.k === "op" && t.v === "{") {
      p++;
      const entries: [string, Expr][] = [];
      if (!isOp("}")) {
        do {
          if (isOp("}")) break;
          const k = peek();
          if (k.k !== "id" && k.k !== "str") throw new ExprError(`Expected a field name at ${k.at + 1}`);
          p++;
          const key = String(k.v);
          if (isOp(":")) {
            p++;
            entries.push([key, expression()]);
          } else if (k.k === "id") entries.push([key, { t: "name", name: key }]);
          else throw new ExprError(`Expected ":" after "${key}"`);
        } while (isOp(",") && ++p);
      }
      take("}");
      return { t: "record", entries };
    }
    throw new ExprError(t.k === "end" ? "The formula ends too soon" : `Unexpected ${show(t)} at ${t.at + 1}`);
  }

  const tree = expression();
  if (peek().k !== "end") throw new ExprError(`Unexpected ${show(peek())} at ${peek().at + 1}`);
  return tree;
}

/** Every name a formula reads, besides the ones its own steps bring in: to check a block's formulas up front. */
export function namesIn(e: Expr, bound: ReadonlySet<string> = new Set(), out = new Set<string>()): Set<string> {
  switch (e.t) {
    case "name":
      if (!bound.has(e.name)) out.add(e.name);
      break;
    case "list":
      for (const i of e.items) namesIn(i, bound, out);
      break;
    case "record":
      for (const [, v] of e.entries) namesIn(v, bound, out);
      break;
    case "unary":
      namesIn(e.arg, bound, out);
      break;
    case "binary":
      namesIn(e.left, bound, out);
      namesIn(e.right, bound, out);
      break;
    case "cond":
      namesIn(e.test, bound, out);
      namesIn(e.then, bound, out);
      namesIn(e.else, bound, out);
      break;
    case "member":
      namesIn(e.obj, bound, out);
      break;
    case "index":
      namesIn(e.obj, bound, out);
      namesIn(e.index, bound, out);
      break;
    case "call":
      for (const a of e.args) namesIn(a, bound, out);
      break;
    case "step":
      namesIn(e.body, new Set([...bound, ...e.params]), out);
      break;
    case "lit":
      break;
  }
  return out;
}

/** Where a formula reads its names: the block's values, and the step's own names inside a step. */
export type Scope = (name: string) => Value | undefined;

export interface EvalOptions {
  /** How `fmt(x, 'brl')` writes a value: the apps' own formatting. */
  format?: (value: Value, format: string) => string;
}

/** One evaluation's work so far, shared by the formulas evaluated with it. */
export interface Budget {
  steps: number;
  options: EvalOptions;
}

const isRecord = (v: Value | undefined): v is { [key: string]: Value } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const truthy = (v: Value | undefined) =>
  !(v === null || v === undefined || v === false || v === 0 || v === "" || (typeof v === "number" && Number.isNaN(v)));

/** A value as a number, the way a spreadsheet reads it: "12" is 12, empty and null are 0. */
export function toNumber(v: Value | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return 0;
    const n = Number(s.replace(",", "."));
    return Number.isNaN(n) ? Number.NaN : n;
  }
  return Number.NaN;
}

export function toText(v: Value | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(v);
}

const numberLike = (v: Value | undefined) =>
  typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)));

function equal(a: Value | undefined, b: Value | undefined): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (typeof a === "number" || typeof b === "number") {
    if (numberLike(a) && numberLike(b)) return toNumber(a) === toNumber(b);
    return false;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(a: Value, b: Value): number {
  if (typeof a === "string" && typeof b === "string" && !(numberLike(a) && numberLike(b))) return a.localeCompare(b);
  return toNumber(a) - toNumber(b);
}

const list = (v: Value | undefined, fn: string): Value[] => {
  if (Array.isArray(v)) return v;
  throw new ExprError(`${fn}() needs a list`);
};

const capList = (items: Value[]) => {
  if (items.length > EXPR_LIMITS.listItems) throw new ExprError("A list in this block is too long");
  return items;
};

const capText = (s: string) => {
  if (s.length > EXPR_LIMITS.textChars) throw new ExprError("A text in this block is too long");
  return s;
};

/** A step passed to a list function, ready to call with an item and its index. */
type Step = (item: Value, index: number) => Value;

interface FnContext {
  run: Budget;
  arg: (i: number) => Value;
  step: (i: number) => Step | null;
  count: number;
}

const numbersOf = (c: FnContext): number[] => {
  if (c.count === 1) {
    const only = c.arg(0);
    if (Array.isArray(only)) return only.map(toNumber);
  }
  return Array.from({ length: c.count }, (_, i) => toNumber(c.arg(i)));
};

const mapped = (c: FnContext, fn: string): Value[] => {
  const items = list(c.arg(0), fn);
  const f = c.step(1);
  return f ? items.map((x, i) => f(x, i)) : items;
};

/** The only functions a formula can call. */
const FUNCTIONS: Record<string, (c: FnContext) => Value> = {
  min: (c) => Math.min(...numbersOf(c)),
  max: (c) => Math.max(...numbersOf(c)),
  abs: (c) => Math.abs(toNumber(c.arg(0))),
  round: (c) => {
    const d = Math.max(0, Math.min(10, Math.trunc(toNumber(c.arg(1)))));
    const f = 10 ** d;
    return Math.round(toNumber(c.arg(0)) * f) / f;
  },
  floor: (c) => Math.floor(toNumber(c.arg(0))),
  ceil: (c) => Math.ceil(toNumber(c.arg(0))),
  sqrt: (c) => Math.sqrt(toNumber(c.arg(0))),
  pow: (c) => toNumber(c.arg(0)) ** toNumber(c.arg(1)),
  log: (c) => Math.log(toNumber(c.arg(0))),
  exp: (c) => Math.exp(toNumber(c.arg(0))),
  clamp: (c) => Math.min(toNumber(c.arg(2)), Math.max(toNumber(c.arg(1)), toNumber(c.arg(0)))),
  number: (c) => toNumber(c.arg(0)),
  text: (c) => capText(toText(c.arg(0))),
  fmt: (c) => {
    const v = c.arg(0);
    const f = toText(c.arg(1));
    return c.run.options.format ? c.run.options.format(v, f) : toText(v);
  },
  lower: (c) => toText(c.arg(0)).toLowerCase(),
  upper: (c) => toText(c.arg(0)).toUpperCase(),
  trim: (c) => toText(c.arg(0)).trim(),
  len: (c) => {
    const v = c.arg(0);
    return Array.isArray(v) || typeof v === "string" ? v.length : isRecord(v) ? Object.keys(v).length : 0;
  },
  sum: (c) => mapped(c, "sum").reduce<number>((a, x) => a + toNumber(x), 0),
  avg: (c) => {
    const xs = mapped(c, "avg");
    return xs.length ? xs.reduce<number>((a, x) => a + toNumber(x), 0) / xs.length : 0;
  },
  count: (c) => {
    const items = list(c.arg(0), "count");
    const f = c.step(1);
    return f ? items.filter((x, i) => truthy(f(x, i))).length : items.length;
  },
  map: (c) => {
    const f = c.step(1);
    if (!f) throw new ExprError("map() needs a step, like map(list, x => x * 2)");
    return list(c.arg(0), "map").map((x, i) => f(x, i));
  },
  filter: (c) => {
    const f = c.step(1);
    if (!f) throw new ExprError("filter() needs a step, like filter(list, x => x.value > 0)");
    return list(c.arg(0), "filter").filter((x, i) => truthy(f(x, i)));
  },
  find: (c) => {
    const f = c.step(1);
    if (!f) throw new ExprError("find() needs a step, like find(list, x => x.name == 'A')");
    return list(c.arg(0), "find").find((x, i) => truthy(f(x, i))) ?? null;
  },
  sort: (c) => {
    const f = c.step(1);
    const items = [...list(c.arg(0), "sort")];
    const keyed = items.map((x, i) => ({ x, k: f ? f(x, i) : x }));
    keyed.sort((a, b) => compare(a.k, b.k));
    return keyed.map((e) => e.x);
  },
  reverse: (c) => [...list(c.arg(0), "reverse")].reverse(),
  slice: (c) => {
    const v = c.arg(0);
    const from = Math.trunc(toNumber(c.arg(1)));
    const to = c.count > 2 ? Math.trunc(toNumber(c.arg(2))) : undefined;
    if (typeof v === "string") return v.slice(from, to);
    return list(v, "slice").slice(from, to);
  },
  first: (c) => list(c.arg(0), "first")[0] ?? null,
  last: (c) => {
    const items = list(c.arg(0), "last");
    return items[items.length - 1] ?? null;
  },
  range: (c) => {
    const a = Math.trunc(toNumber(c.arg(0)));
    const [from, to] = c.count > 1 ? [a, Math.trunc(toNumber(c.arg(1)))] : [0, a];
    const by = c.count > 2 ? toNumber(c.arg(2)) : 1;
    if (!(by > 0) || !Number.isFinite(from) || !Number.isFinite(to)) throw new ExprError("range() needs whole numbers");
    const out: Value[] = [];
    for (let i = from; i < to; i += by) {
      out.push(i);
      if (out.length > EXPR_LIMITS.listItems) throw new ExprError("A list in this block is too long");
    }
    return out;
  },
  includes: (c) => {
    const v = c.arg(0);
    const x = c.arg(1);
    if (typeof v === "string") return v.toLowerCase().includes(toText(x).toLowerCase());
    return list(v, "includes").some((y) => equal(y, x));
  },
  join: (c) =>
    capText(
      list(c.arg(0), "join")
        .map(toText)
        .join(c.count > 1 ? toText(c.arg(1)) : ", "),
    ),
  if: (c) => (truthy(c.arg(0)) ? c.arg(1) : c.count > 2 ? c.arg(2) : null),
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS);

function evaluate(e: Expr, scope: Scope, run: Budget): Value {
  if (++run.steps > EXPR_LIMITS.steps) throw new ExprError("This block computes too much");
  switch (e.t) {
    case "lit":
      return e.v;
    case "name": {
      const v = scope(e.name);
      if (v === undefined) throw new ExprError(`There is no value "${e.name}"`);
      return v;
    }
    case "list":
      return capList(e.items.map((i) => evaluate(i, scope, run)));
    case "record": {
      const out: { [key: string]: Value } = {};
      for (const [k, v] of e.entries) out[k] = evaluate(v, scope, run);
      return out;
    }
    case "unary": {
      const v = evaluate(e.arg, scope, run);
      if (e.op === "!") return !truthy(v);
      return e.op === "-" ? -toNumber(v) : toNumber(v);
    }
    case "binary": {
      if (e.op === "&&") {
        const l = evaluate(e.left, scope, run);
        return truthy(l) ? evaluate(e.right, scope, run) : l;
      }
      if (e.op === "||") {
        const l = evaluate(e.left, scope, run);
        return truthy(l) ? l : evaluate(e.right, scope, run);
      }
      const l = evaluate(e.left, scope, run);
      const r = evaluate(e.right, scope, run);
      switch (e.op) {
        case "+":
          if (Array.isArray(l) && Array.isArray(r)) return capList([...l, ...r]);
          if ((typeof l === "string" && !numberLike(l)) || (typeof r === "string" && !numberLike(r)))
            return capText(toText(l) + toText(r));
          if (typeof l === "string" && typeof r === "string") return capText(l + r);
          return toNumber(l) + toNumber(r);
        case "-":
          return toNumber(l) - toNumber(r);
        case "*":
          return toNumber(l) * toNumber(r);
        case "/":
          return toNumber(l) / toNumber(r);
        case "%":
          return toNumber(l) % toNumber(r);
        case "^":
          return toNumber(l) ** toNumber(r);
        case "==":
          return equal(l, r);
        case "!=":
          return !equal(l, r);
        case "<":
          return compare(l, r) < 0;
        case "<=":
          return compare(l, r) <= 0;
        case ">":
          return compare(l, r) > 0;
        case ">=":
          return compare(l, r) >= 0;
      }
      throw new ExprError(`Unknown operator "${e.op}"`);
    }
    case "cond":
      return truthy(evaluate(e.test, scope, run)) ? evaluate(e.then, scope, run) : evaluate(e.else, scope, run);
    case "member": {
      const o = evaluate(e.obj, scope, run);
      if (e.key === "length" && (Array.isArray(o) || typeof o === "string")) return o.length;
      // Own fields only: a record from a block's data never leads anywhere else.
      return isRecord(o) && Object.hasOwn(o, e.key) ? (o[e.key] as Value) : null;
    }
    case "index": {
      const o = evaluate(e.obj, scope, run);
      const i = evaluate(e.index, scope, run);
      if (Array.isArray(o) || typeof o === "string") {
        const n = Math.trunc(toNumber(i));
        const at = n < 0 ? o.length + n : n;
        return o[at] ?? null;
      }
      const key = toText(i);
      return isRecord(o) && Object.hasOwn(o, key) ? (o[key] as Value) : null;
    }
    case "call": {
      const fn = FUNCTIONS[e.fn];
      if (!fn) throw new ExprError(`There is no function "${e.fn}"`);
      const cache: (Value | undefined)[] = [];
      return fn({
        run,
        count: e.args.length,
        arg: (i) => {
          const a = e.args[i];
          if (!a) return null;
          if (a.t === "step") throw new ExprError(`${e.fn}() takes a value there, not a step`);
          if (cache[i] === undefined) cache[i] = evaluate(a, scope, run);
          return cache[i] as Value;
        },
        step: (i) => {
          const a = e.args[i];
          if (!a) return null;
          if (a.t !== "step") throw new ExprError(`${e.fn}() takes a step there, like x => x.value`);
          return (item, index) => {
            const [p0, p1] = a.params;
            return evaluate(a.body, (n) => (n === p0 ? item : n === p1 ? index : scope(n)), run);
          };
        },
      });
    }
    case "step":
      throw new ExprError("A step (x => …) only goes inside map, filter, sum, sort and the like");
  }
}

/** One evaluation: its own step budget, shared by every formula evaluated with the same `budget`. */
export function createBudget(options: EvalOptions = {}): Budget {
  return { steps: 0, options };
}

/** A formula's value. Throws `ExprError` when it is wrong (an unknown name, too much work). */
export function evalExpr(e: Expr, scope: Scope, budget: Budget = createBudget()): Value {
  const v = evaluate(e, scope, budget);
  return typeof v === "number" && Object.is(v, -0) ? 0 : v;
}
