/**
 * Live blocks as data (ADR 0113): what an agent describes, checked the same way by the server (before the block is
 * shown, so the agent hears what is wrong and fixes it) and the apps (which draw it with their own components). A
 * block is parts (sliders, choices, numbers, charts, tables, cards, buttons) over a shared state, with formulas in
 * our own language (`expr.ts`) for whatever follows from it. Nothing in it runs code: the apps draw what
 * `viewBlock` returns, and the agent's words only ever reach the screen as text.
 */

import {
  createBudget,
  type EvalOptions,
  type Expr,
  evalExpr,
  namesIn,
  parseExpr,
  toNumber,
  toText,
  truthy,
  type Value,
} from "./expr";

export type { Value } from "./expr";

/** How a number is written: `brl` 1200 → "R$ 1.200", `mil` 12 → "R$ 12 mil", `pct` 12.5 → "12,5%", `int` 1200 → "1.200". */
export const BLOCK_FORMATS = ["brl", "mil", "pct", "int", "number"] as const;
export type BlockFormat = (typeof BLOCK_FORMATS)[number];

export const BLOCK_LIMITS = {
  parts: 120,
  depth: 5,
  options: 12,
  items: 40,
  buttons: 6,
  columns: 8,
  rows: 200,
  compute: 40,
  label: 120,
  text: 1500,
  /** Data and starting values together, as JSON. */
  dataBytes: 60_000,
  chartPoints: 24,
  sendChars: 2000,
} as const;

/** A value's name: what a formula can read (the server's rule for a block's state, without the hyphen). */
export const BLOCK_NAME = /^[A-Za-z_]\w{0,63}$/;

/** A formula (text) or a fixed value. */
type Formula = string | number | boolean;

interface PartBase {
  /** Shown only while this formula is true. */
  when?: string;
}

export type BlockPart = PartBase &
  (
    | { type: "heading" | "text" | "note"; text: string }
    | { type: "list"; items: string[] }
    | {
        type: "slider";
        name: string;
        label: string;
        min: number;
        max: number;
        step?: number;
        value?: number;
        format?: BlockFormat;
        unit?: string;
      }
    | { type: "choice"; name: string; label?: string; options: string[]; value?: string | null }
    | {
        type: "field";
        name: string;
        label: string;
        input?: "text" | "number" | "date" | "textarea";
        placeholder?: string;
        value?: string | number;
      }
    | { type: "switch"; name: string; label: string; value?: boolean }
    | StatPart
    | { type: "stats"; items: StatPart[] }
    | { type: "result"; label: string; value: Formula; format?: BlockFormat; unit?: string }
    | {
        type: "progress";
        label?: string;
        value: Formula;
        max?: Formula;
        format?: BlockFormat;
        unit?: string;
      }
    | {
        type: "chart";
        chart: "bar" | "line" | "pie";
        label?: string;
        /** A formula giving a list of `{label, value}`. */
        data?: string;
        /** Or the points one by one, each value a formula. */
        items?: { label: string; value: Formula }[];
        unit?: string;
      }
    | {
        type: "table";
        columns: { label: string; key: string; format?: BlockFormat }[];
        /** A formula giving a list of records, or the records themselves. */
        rows: string | Record<string, Value>[];
      }
    | { type: "more"; label?: string; parts: BlockPart[] }
    | { type: "row"; parts: BlockPart[] }
    | {
        type: "card";
        label?: string;
        sub?: string;
        /** With `value`, the card is a choice: a click sets `name` to `value`. */
        name?: string;
        value?: string;
        selected?: boolean;
        parts?: BlockPart[];
      }
    | { type: "actions"; align?: "end" | "center" | "start"; buttons: BlockButton[] }
  );

type PartOf<T extends BlockPart["type"]> = Extract<BlockPart, { type: T }>;

export interface StatPart extends PartBase {
  type: "stat";
  label: string;
  value: Formula;
  format?: BlockFormat;
  unit?: string;
  /** A small line under the number; `{name}` works in it. */
  sub?: string;
  /** A formula giving "up" or "down": the small line turns green or red. */
  tone?: string;
}

export interface BlockButton {
  label: string;
  /** Values it sets, each a formula read when it is pressed. */
  set?: Record<string, Formula>;
  /** A random pick the server makes for everyone among `options` (a list, or a formula giving one). */
  draw?: { name: string; options: string[] | string };
  when?: string;
}

export interface BlockSend {
  label: string;
  /** What the person sends, `{name}` and `{name:format}` filled in. */
  text: string;
  /** Values that must be filled (or true) first. */
  needs?: string[];
  /** Why the button waits, while it does. */
  hint?: string;
}

export interface BlockSpec {
  /** Fixed data the formulas read: lists, prices, names. */
  data?: Record<string, Value>;
  /** Starting values of the shared state that no input holds (a step, a pick). */
  state?: Record<string, Value>;
  /** Values that follow from the others, in order: each formula reads the ones above it. */
  compute?: Record<string, string>;
  parts: BlockPart[];
  send?: BlockSend;
}

const PART_TYPES = new Set([
  "heading",
  "text",
  "note",
  "list",
  "slider",
  "choice",
  "field",
  "switch",
  "stat",
  "stats",
  "result",
  "progress",
  "chart",
  "table",
  "more",
  "row",
  "card",
  "actions",
]);

export class BlockSpecError extends Error {
  override name = "BlockSpecError";
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A block as the agent sent it, checked and cleaned: every part known, every name valid, every formula parsed and
 * reading only names the block has. Throws `BlockSpecError` saying where (`parts[2].value: …`), for the agent to fix.
 */
export function parseBlockSpec(raw: unknown): BlockSpec {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new BlockSpecError("spec is not valid JSON");
    }
  }
  if (!isObject(raw)) throw new BlockSpecError("spec must be an object with parts");
  const c = new Checker();
  return c.spec(raw);
}

/** Collects names and formulas while it cleans a spec, then checks every formula reads only known names. */
class Checker {
  private parts = 0;
  private inputs = new Map<string, string>();
  private implicit = new Set<string>();
  private formulas: { at: string; expr: Expr; extra?: ReadonlySet<string> }[] = [];

  spec(raw: Record<string, unknown>): BlockSpec {
    const out: BlockSpec = { parts: [] };
    const data = this.values(raw.data, "data");
    const state = this.values(raw.state, "state");
    if (JSON.stringify({ data, state }).length > BLOCK_LIMITS.dataBytes) throw new BlockSpecError("data is too large");
    if (data) out.data = data;
    if (state) out.state = state;
    const declared = new Set<string>();
    const declare = (name: string, at: string) => {
      if (declared.has(name)) throw new BlockSpecError(`${at}: the name "${name}" is used twice`);
      declared.add(name);
    };
    for (const k of Object.keys(data ?? {})) declare(k, "data");
    for (const k of Object.keys(state ?? {})) declare(k, "state");
    if (!Array.isArray(raw.parts) || raw.parts.length === 0) throw new BlockSpecError("parts must be a list of parts");
    out.parts = this.partList(raw.parts, "parts", 1);
    for (const [name, at] of this.inputs) {
      if (declared.has(name)) throw new BlockSpecError(`${at}: the name "${name}" is used twice`);
      declared.add(name);
    }
    for (const name of this.implicit) {
      // A button or a card sets state; fixed data never changes.
      if (data && Object.hasOwn(data, name))
        throw new BlockSpecError(`"${name}" is in data, which no button or card can set`);
      declared.add(name);
    }
    // Names a formula may read: everything above, then each computed value once it is computed.
    const known = new Set(declared);
    if (raw.compute !== undefined) {
      if (!isObject(raw.compute)) throw new BlockSpecError("compute must be an object of name: formula");
      const entries = Object.entries(raw.compute);
      if (entries.length > BLOCK_LIMITS.compute) throw new BlockSpecError("compute has too many values");
      const compute: Record<string, string> = {};
      for (const [name, f] of entries) {
        const at = `compute.${name}`;
        if (!BLOCK_NAME.test(name)) throw new BlockSpecError(`${at}: "${name}" is not a valid name`);
        if (declared.has(name)) throw new BlockSpecError(`${at}: the name "${name}" is used twice`);
        const src = typeof f === "number" || typeof f === "boolean" ? String(f) : f;
        if (typeof src !== "string") throw new BlockSpecError(`${at}: must be a formula`);
        const expr = this.parse(src, at);
        this.reads(expr, known, at);
        compute[name] = src;
        declared.add(name);
        known.add(name);
      }
      out.compute = compute;
    }
    if (raw.send !== undefined) out.send = this.send(raw.send);
    for (const f of this.formulas) this.reads(f.expr, f.extra ? new Set([...known, ...f.extra]) : known, f.at);
    return out;
  }

  private values(v: unknown, at: string): Record<string, Value> | undefined {
    if (v === undefined || v === null) return undefined;
    if (!isObject(v)) throw new BlockSpecError(`${at} must be an object of name: value`);
    for (const k of Object.keys(v))
      if (!BLOCK_NAME.test(k)) throw new BlockSpecError(`${at}: "${k}" is not a valid name`);
    return JSON.parse(JSON.stringify(v)) as Record<string, Value>;
  }

  private parse(src: string, at: string): Expr {
    try {
      return parseExpr(src);
    } catch (e) {
      throw new BlockSpecError(`${at}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private reads(expr: Expr, known: ReadonlySet<string>, at: string) {
    for (const name of namesIn(expr)) {
      if (!known.has(name)) throw new BlockSpecError(`${at}: there is no value "${name}"`);
    }
  }

  /** A formula to check once every name is known. */
  private formula(v: unknown, at: string, extra?: ReadonlySet<string>): Formula {
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v !== "string" || !v.trim()) throw new BlockSpecError(`${at}: must be a formula or a number`);
    this.formulas.push({ at, expr: this.parse(v, at), ...(extra ? { extra } : {}) });
    return v;
  }

  private text(v: unknown, at: string, max: number = BLOCK_LIMITS.label, required = true): string {
    if (v === undefined || v === null || v === "") {
      if (required) throw new BlockSpecError(`${at} is missing`);
      return "";
    }
    if (typeof v !== "string" && typeof v !== "number") throw new BlockSpecError(`${at} must be text`);
    const s = String(v);
    if (s.length > max) throw new BlockSpecError(`${at} is too long`);
    return s;
  }

  /** Text with `{name}` in it: each name must exist. */
  private filled(v: unknown, at: string, max: number, required = true): string {
    const s = this.text(v, at, max, required);
    for (const m of s.matchAll(FILL)) this.formulas.push({ at, expr: { t: "name", name: m[1] as string } });
    return s;
  }

  private name(v: unknown, at: string): string {
    if (typeof v !== "string" || !BLOCK_NAME.test(v))
      throw new BlockSpecError(`${at}: needs a name (letters, digits, _)`);
    return v;
  }

  private input(name: string, at: string) {
    if (this.inputs.has(name)) throw new BlockSpecError(`${at}: the name "${name}" is used twice`);
    this.inputs.set(name, at);
  }

  private format(v: unknown, at: string): BlockFormat | undefined {
    if (v === undefined || v === null || v === "") return undefined;
    if (!BLOCK_FORMATS.includes(v as BlockFormat)) {
      throw new BlockSpecError(`${at}: format is one of ${BLOCK_FORMATS.join(", ")}`);
    }
    return v as BlockFormat;
  }

  private number(v: unknown, at: string): number {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new BlockSpecError(`${at} must be a number`);
    return v;
  }

  private partList(raw: unknown, at: string, depth: number): BlockPart[] {
    if (!Array.isArray(raw)) throw new BlockSpecError(`${at} must be a list of parts`);
    if (depth > BLOCK_LIMITS.depth) throw new BlockSpecError(`${at}: parts are nested too deep`);
    return raw.map((p, i) => this.part(p, `${at}[${i}]`, depth));
  }

  private part(raw: unknown, at: string, depth: number): BlockPart {
    if (++this.parts > BLOCK_LIMITS.parts) throw new BlockSpecError("this block has too many parts");
    if (!isObject(raw)) throw new BlockSpecError(`${at} must be an object with a type`);
    if (typeof raw.type !== "string" || !PART_TYPES.has(raw.type)) {
      throw new BlockSpecError(`${at}: type "${String(raw.type)}" is not a part (${[...PART_TYPES].join(", ")})`);
    }
    const type = raw.type as BlockPart["type"];
    const base: PartBase = {};
    if (raw.when !== undefined) {
      if (typeof raw.when !== "string") throw new BlockSpecError(`${at}.when must be a formula`);
      this.formula(raw.when, `${at}.when`);
      base.when = raw.when;
    }
    const L = BLOCK_LIMITS;
    switch (type) {
      case "heading":
      case "text":
      case "note":
        return { ...base, type, text: this.filled(raw.text, `${at}.text`, L.text) };
      case "list": {
        if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > L.items)
          throw new BlockSpecError(`${at}.items must list 1 to ${L.items} lines`);
        return { ...base, type, items: raw.items.map((x, i) => this.filled(x, `${at}.items[${i}]`, L.text)) };
      }
      case "slider": {
        const name = this.name(raw.name, `${at}.name`);
        this.input(name, at);
        const min = this.number(raw.min, `${at}.min`);
        const max = this.number(raw.max, `${at}.max`);
        if (max <= min) throw new BlockSpecError(`${at}: max must be more than min`);
        const step = raw.step === undefined ? undefined : this.number(raw.step, `${at}.step`);
        if (step !== undefined && step <= 0) throw new BlockSpecError(`${at}.step must be more than 0`);
        const value = raw.value === undefined ? undefined : this.number(raw.value, `${at}.value`);
        return {
          ...base,
          type,
          name,
          label: this.text(raw.label, `${at}.label`),
          min,
          max,
          ...(step !== undefined ? { step } : {}),
          ...(value !== undefined ? { value } : {}),
          ...this.formatAndUnit(raw, at),
        };
      }
      case "choice": {
        const name = this.name(raw.name, `${at}.name`);
        this.input(name, at);
        const options = this.options(raw.options, `${at}.options`);
        let value: string | null | undefined;
        if (raw.value === null || raw.value === "") value = null;
        else if (raw.value !== undefined) {
          value = String(raw.value);
          if (!options.includes(value)) throw new BlockSpecError(`${at}.value must be one of the options`);
        }
        const label = this.text(raw.label, `${at}.label`, L.label, false);
        return { ...base, type, name, ...(label ? { label } : {}), options, ...(value !== undefined ? { value } : {}) };
      }
      case "field": {
        const name = this.name(raw.name, `${at}.name`);
        this.input(name, at);
        const input = raw.input ?? "text";
        if (!["text", "number", "date", "textarea"].includes(input as string))
          throw new BlockSpecError(`${at}.input is text, number, date or textarea`);
        const placeholder = this.text(raw.placeholder, `${at}.placeholder`, L.label, false);
        const value =
          raw.value === undefined || raw.value === null
            ? undefined
            : typeof raw.value === "number"
              ? raw.value
              : this.text(raw.value, `${at}.value`, L.text);
        return {
          ...base,
          type,
          name,
          label: this.text(raw.label, `${at}.label`),
          input: input as "text" | "number" | "date" | "textarea",
          ...(placeholder ? { placeholder } : {}),
          ...(value !== undefined ? { value } : {}),
        };
      }
      case "switch": {
        const name = this.name(raw.name, `${at}.name`);
        this.input(name, at);
        return { ...base, type, name, label: this.text(raw.label, `${at}.label`), value: raw.value === true };
      }
      case "stat":
        return { ...base, ...this.stat(raw, at) };
      case "stats": {
        if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > 6)
          throw new BlockSpecError(`${at}.items must list 1 to 6 stats`);
        return {
          ...base,
          type,
          items: raw.items.map((x, i) => {
            if (!isObject(x)) throw new BlockSpecError(`${at}.items[${i}] must be a stat`);
            return this.stat(x, `${at}.items[${i}]`);
          }),
        };
      }
      case "result":
        return {
          ...base,
          type,
          label: this.text(raw.label, `${at}.label`),
          value: this.formula(raw.value, `${at}.value`),
          ...this.formatAndUnit(raw, at),
        };
      case "progress": {
        const label = this.text(raw.label, `${at}.label`, L.label, false);
        return {
          ...base,
          type,
          ...(label ? { label } : {}),
          value: this.formula(raw.value, `${at}.value`),
          ...(raw.max !== undefined ? { max: this.formula(raw.max, `${at}.max`) } : {}),
          ...this.formatAndUnit(raw, at),
        };
      }
      case "chart": {
        const chart = raw.chart ?? "bar";
        if (chart !== "bar" && chart !== "line" && chart !== "pie")
          throw new BlockSpecError(`${at}.chart is bar, line or pie`);
        const label = this.text(raw.label, `${at}.label`, L.label, false);
        const unit = this.text(raw.unit, `${at}.unit`, 8, false);
        const out: PartOf<"chart"> = {
          ...base,
          type,
          chart: chart as "bar" | "line" | "pie",
          ...(label ? { label } : {}),
          ...(unit ? { unit } : {}),
        };
        if (typeof raw.data === "string") {
          this.formula(raw.data, `${at}.data`);
          return { ...out, data: raw.data };
        }
        if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > L.chartPoints)
          throw new BlockSpecError(`${at} needs data (a formula) or 1 to ${L.chartPoints} items`);
        return {
          ...out,
          items: raw.items.map((x, i) => {
            if (!isObject(x)) throw new BlockSpecError(`${at}.items[${i}] must be {label, value}`);
            return {
              label: this.text(x.label, `${at}.items[${i}].label`),
              value: this.formula(x.value, `${at}.items[${i}].value`),
            };
          }),
        };
      }
      case "table": {
        if (!Array.isArray(raw.columns) || raw.columns.length === 0 || raw.columns.length > L.columns)
          throw new BlockSpecError(`${at}.columns must list 1 to ${L.columns} columns`);
        const columns = raw.columns.map((x, i) => {
          if (!isObject(x)) throw new BlockSpecError(`${at}.columns[${i}] must be {label, key}`);
          const format = this.format(x.format, `${at}.columns[${i}]`);
          return {
            label: this.text(x.label, `${at}.columns[${i}].label`),
            key: this.text(x.key, `${at}.columns[${i}].key`, 64),
            ...(format ? { format } : {}),
          };
        });
        let rows: string | Record<string, Value>[];
        if (typeof raw.rows === "string") {
          this.formula(raw.rows, `${at}.rows`);
          rows = raw.rows;
        } else if (Array.isArray(raw.rows) && raw.rows.length <= L.rows && raw.rows.every(isObject)) {
          rows = JSON.parse(JSON.stringify(raw.rows)) as Record<string, Value>[];
        } else throw new BlockSpecError(`${at}.rows must be a formula or up to ${L.rows} records`);
        return { ...base, type, columns, rows };
      }
      case "more": {
        const label = this.text(raw.label, `${at}.label`, L.label, false);
        return {
          ...base,
          type,
          ...(label ? { label } : {}),
          parts: this.partList(raw.parts, `${at}.parts`, depth + 1),
        };
      }
      case "row":
        return { ...base, type, parts: this.partList(raw.parts, `${at}.parts`, depth + 1) };
      case "card": {
        const label = this.text(raw.label, `${at}.label`, L.label, false);
        const sub = this.text(raw.sub, `${at}.sub`, L.label, false);
        const out: PartOf<"card"> = { ...base, type, ...(label ? { label } : {}), ...(sub ? { sub } : {}) };
        if (raw.name !== undefined) {
          out.name = this.name(raw.name, `${at}.name`);
          out.value = this.text(raw.value, `${at}.value`);
          this.implicit.add(out.name);
        }
        if (raw.selected === true) out.selected = true;
        if (raw.parts !== undefined) out.parts = this.partList(raw.parts, `${at}.parts`, depth + 1);
        return out;
      }
      case "actions": {
        if (!Array.isArray(raw.buttons) || raw.buttons.length === 0 || raw.buttons.length > L.buttons)
          throw new BlockSpecError(`${at}.buttons must list 1 to ${L.buttons} buttons`);
        const align = raw.align ?? "end";
        if (align !== "end" && align !== "center" && align !== "start")
          throw new BlockSpecError(`${at}.align is end, center or start`);
        return {
          ...base,
          type,
          align: align as "end" | "center" | "start",
          buttons: raw.buttons.map((b, i) => this.button(b, `${at}.buttons[${i}]`)),
        };
      }
    }
    throw new BlockSpecError(`${at}: unknown part`);
  }

  private stat(raw: Record<string, unknown>, at: string): StatPart {
    const sub = this.filled(raw.sub, `${at}.sub`, BLOCK_LIMITS.label, false);
    const out: StatPart = {
      type: "stat",
      label: this.text(raw.label, `${at}.label`),
      value: this.formula(raw.value, `${at}.value`),
      ...this.formatAndUnit(raw, at),
      ...(sub ? { sub } : {}),
    };
    if (raw.tone !== undefined) {
      if (typeof raw.tone !== "string") throw new BlockSpecError(`${at}.tone must be a formula`);
      this.formula(raw.tone, `${at}.tone`);
      out.tone = raw.tone;
    }
    if (raw.when !== undefined && typeof raw.when === "string") {
      this.formula(raw.when, `${at}.when`);
      out.when = raw.when;
    }
    return out;
  }

  private formatAndUnit(raw: Record<string, unknown>, at: string) {
    const format = this.format(raw.format, `${at}.format`);
    const unit = this.text(raw.unit, `${at}.unit`, 12, false);
    return { ...(format ? { format } : {}), ...(unit ? { unit } : {}) };
  }

  private options(v: unknown, at: string): string[] {
    const list = typeof v === "string" ? v.split("|") : v;
    if (!Array.isArray(list)) throw new BlockSpecError(`${at} must be a list of options`);
    const options = list.map((o, i) => this.text(o, `${at}[${i}]`).trim()).filter(Boolean);
    if (options.length < 2 || options.length > BLOCK_LIMITS.options)
      throw new BlockSpecError(`${at} must list 2 to ${BLOCK_LIMITS.options} options`);
    if (new Set(options).size !== options.length) throw new BlockSpecError(`${at}: options must differ`);
    return options;
  }

  private button(raw: unknown, at: string): BlockButton {
    if (!isObject(raw)) throw new BlockSpecError(`${at} must be {label, set or draw}`);
    const out: BlockButton = { label: this.text(raw.label, `${at}.label`, 40) };
    if (raw.set !== undefined) {
      if (!isObject(raw.set) || Object.keys(raw.set).length === 0)
        throw new BlockSpecError(`${at}.set must be an object of name: formula`);
      const set: Record<string, Formula> = {};
      for (const [name, f] of Object.entries(raw.set)) {
        if (!BLOCK_NAME.test(name)) throw new BlockSpecError(`${at}.set: "${name}" is not a valid name`);
        set[name] = this.formula(f, `${at}.set.${name}`);
        this.implicit.add(name);
      }
      out.set = set;
    }
    if (raw.draw !== undefined) {
      if (!isObject(raw.draw)) throw new BlockSpecError(`${at}.draw must be {name, options}`);
      const name = this.name(raw.draw.name, `${at}.draw.name`);
      this.implicit.add(name);
      const options =
        typeof raw.draw.options === "string"
          ? (this.formula(raw.draw.options, `${at}.draw.options`) as string)
          : this.drawOptions(raw.draw.options, `${at}.draw.options`);
      out.draw = { name, options };
    }
    if (!out.set && !out.draw) throw new BlockSpecError(`${at} needs set or draw: what it does when pressed`);
    if (raw.when !== undefined) {
      if (typeof raw.when !== "string") throw new BlockSpecError(`${at}.when must be a formula`);
      this.formula(raw.when, `${at}.when`);
      out.when = raw.when;
    }
    return out;
  }

  private drawOptions(v: unknown, at: string): string[] {
    if (!Array.isArray(v) || v.length < 2 || v.length > 100)
      throw new BlockSpecError(`${at} must list 2 to 100 options`);
    return v.map((o, i) => this.text(o, `${at}[${i}]`, 200));
  }

  private send(raw: unknown): BlockSend {
    if (!isObject(raw)) throw new BlockSpecError("send must be {label, text}");
    const out: BlockSend = {
      label: this.text(raw.label, "send.label", 40),
      text: this.filled(raw.text, "send.text", BLOCK_LIMITS.sendChars),
    };
    if (raw.needs !== undefined) {
      const needs = typeof raw.needs === "string" ? raw.needs.split(/[,|]/).map((s) => s.trim()) : raw.needs;
      if (!Array.isArray(needs)) throw new BlockSpecError("send.needs must be a list of names");
      out.needs = needs.filter(Boolean).map((n, i) => {
        const name = this.name(n, `send.needs[${i}]`);
        this.formulas.push({ at: `send.needs[${i}]`, expr: { t: "name", name } });
        return name;
      });
    }
    const hint = this.text(raw.hint, "send.hint", 200, false);
    if (hint) out.hint = hint;
    return out;
  }
}

/** `{name}` and `{name:format}` in a text. */
const FILL = /\{([A-Za-z_]\w{0,63})(?::(\w+))?\}/g;

// ---------------------------------------------------------------------------------------------------------------
// Drawing: the spec and its state, as the parts the apps show.

export interface BlockWords {
  locale: string;
  /** How "thousand" is written after a `mil` value ("mil", "k"). */
  thousand: string;
}

/** A value written for a person: the formats of the kit, and "–" for nothing. */
export function formatBlockValue(
  v: Value | undefined,
  format: string | undefined,
  unit: string | undefined,
  words: BlockWords,
) {
  if (v === undefined || v === null || (typeof v === "number" && !Number.isFinite(v))) return "–";
  const num = (x: number, digits = 1) =>
    new Intl.NumberFormat(words.locale, { maximumFractionDigits: digits }).format(x);
  const asNumber = typeof v === "number" ? v : toNumber(v);
  const numeric = typeof v === "number" || (format && format !== "number" && Number.isFinite(asNumber));
  if (numeric && format && format !== "number") {
    if (format === "brl") return `R$ ${num(asNumber, 0)}`;
    if (format === "mil") return `R$ ${num(asNumber, 1)}${words.thousand === "k" ? "k" : ` ${words.thousand}`}`;
    if (format === "pct") return `${num(asNumber, 1)}%`;
    if (format === "int") return num(asNumber, 0);
  }
  if (typeof v === "number") return `${num(v)}${unit ? ` ${unit}` : ""}`;
  if (typeof v === "boolean") return v ? "✓" : "–";
  return toText(v);
}

export type BlockViewPart = { key: string } & (
  | { kind: "heading" | "text" | "note"; text: string }
  | { kind: "list"; items: string[] }
  | {
      kind: "slider";
      name: string;
      label: string;
      min: number;
      max: number;
      step: number;
      value: number;
      shown: string;
    }
  | { kind: "choice"; name: string; label: string; options: string[]; value: string | null }
  | {
      kind: "field";
      name: string;
      label: string;
      input: "text" | "number" | "date" | "textarea";
      placeholder: string;
      value: string;
    }
  | { kind: "switch"; name: string; label: string; value: boolean }
  | { kind: "stats"; items: BlockViewStat[] }
  | {
      kind: "result";
      label: string;
      text: string;
      /** The value's name when it shows one value as it is: a draw on it rolls into place. */
      name: string | null;
    }
  | { kind: "progress"; label: string; share: number; text: string }
  | { kind: "chart"; chart: "bar" | "line" | "pie"; label: string; labels: string[]; values: number[]; unit: string }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "more"; label: string; parts: BlockViewPart[] }
  | { kind: "row"; parts: BlockViewPart[] }
  | {
      kind: "card";
      label: string;
      sub: string;
      /** A card that is a choice: pressing it sets `name` to `value`. */
      pick: { name: string; value: string } | null;
      selected: boolean;
      parts: BlockViewPart[];
    }
  | { kind: "actions"; align: "end" | "center" | "start"; buttons: BlockViewButton[] }
);

export interface BlockViewStat {
  key: string;
  label: string;
  text: string;
  sub: string;
  tone: "up" | "down" | null;
}

export interface BlockViewButton {
  key: string;
  label: string;
  /** The values it sets, read now. */
  set: Record<string, Value> | null;
  draw: { name: string; options: string[] } | null;
  /** The block's only button: drawn as the main action. */
  lead: boolean;
}

export interface BlockView {
  parts: BlockViewPart[];
  send: { label: string; text: string; ready: boolean; hint: string } | null;
  /** Every value the block holds now: data, state, inputs and what follows from them (what the agent reads too). */
  values: Record<string, Value>;
  /** What went wrong in a formula, by where it is. */
  errors: string[];
}

/** A block's formulas, parsed once. */
export interface CompiledBlock {
  spec: BlockSpec;
  expr: (src: Formula) => Expr;
  /** Every input and implicit state value, with what it starts as. */
  defaults: Record<string, Value>;
}

/** Parses each formula once, on first use. */
export function compileBlock(spec: BlockSpec): CompiledBlock {
  const cache = new Map<string, Expr>();
  const expr = (src: Formula): Expr => {
    if (typeof src !== "string") return { t: "lit", v: src };
    let e = cache.get(src);
    if (!e) {
      e = parseExpr(src);
      cache.set(src, e);
    }
    return e;
  };
  const defaults: Record<string, Value> = { ...(spec.state ?? {}) };
  const walk = (parts: BlockPart[]) => {
    for (const p of parts) {
      if (p.type === "slider") defaults[p.name] = clampStep(p.value ?? p.min, p.min, p.max, p.step);
      else if (p.type === "choice") defaults[p.name] = p.value === undefined ? (p.options[0] ?? null) : p.value;
      else if (p.type === "field") defaults[p.name] = p.value ?? "";
      else if (p.type === "switch") defaults[p.name] = p.value === true;
      else if (p.type === "card" && p.name && !(p.name in defaults))
        defaults[p.name] = p.selected ? (p.value ?? null) : null;
      else if (p.type === "actions") {
        for (const b of p.buttons) {
          for (const n of Object.keys(b.set ?? {})) if (!(n in defaults)) defaults[n] = null;
          if (b.draw && !(b.draw.name in defaults)) defaults[b.draw.name] = null;
        }
      }
      if ("parts" in p && p.parts) walk(p.parts);
    }
  };
  walk(spec.parts);
  // A card marked selected wins over an empty start of the same name.
  const marked = (parts: BlockPart[]) => {
    for (const p of parts) {
      if (p.type === "card" && p.name && p.selected && defaults[p.name] === null) defaults[p.name] = p.value ?? null;
      if ("parts" in p && p.parts) marked(p.parts);
    }
  };
  marked(spec.parts);
  return { spec, expr, defaults };
}

const clampStep = (v: number, min: number, max: number, step = 1) => {
  const n = Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
  const snapped = min + Math.round((n - min) / step) * step;
  return Math.min(max, Number(snapped.toFixed(10)));
};

/**
 * What a block shows now, from everyone's state: each part with its values read and written out, hidden parts left
 * out, and the text the send button would send. Pure, so the web, the phone and the server draw the same thing.
 */
export function viewBlock(compiled: CompiledBlock, state: Record<string, unknown>, words: BlockWords): BlockView {
  const { spec, expr, defaults } = compiled;
  const errors: string[] = [];
  const format = (v: Value, f: string) => formatBlockValue(v, f, undefined, words);
  const options: EvalOptions = { format };
  const budget = createBudget(options);
  const values: Record<string, Value> = { ...(spec.data ?? {}) };
  for (const [k, start] of Object.entries(defaults)) {
    const v = Object.hasOwn(state, k) ? (state[k] as Value) : start;
    values[k] = v === undefined ? null : v;
  }
  const scope = (n: string) => (Object.hasOwn(values, n) ? values[n] : undefined);
  const read = (src: Formula, at: string): Value => {
    try {
      return evalExpr(expr(src), scope, budget);
    } catch (e) {
      errors.push(`${at}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  for (const [name, src] of Object.entries(spec.compute ?? {})) values[name] = read(src, `compute.${name}`);
  const fill = (text: string) =>
    text.replace(FILL, (_, name: string, f?: string) => formatBlockValue(values[name], f, undefined, words));

  const parts = (list: BlockPart[], at: string): BlockViewPart[] => {
    const out: BlockViewPart[] = [];
    list.forEach((p, i) => {
      const key = `${at}.${i}`;
      if (p.when !== undefined && !truthy(read(p.when, `${key}.when`))) return;
      const v = part(p, key);
      if (v) out.push(v);
    });
    return out;
  };

  const stat = (p: StatPart, key: string): BlockViewStat => {
    const tone = p.tone ? toText(read(p.tone, `${key}.tone`)) : "";
    return {
      key,
      label: p.label,
      text: formatBlockValue(read(p.value, `${key}.value`), p.format, p.unit, words),
      sub: p.sub ? fill(p.sub) : "",
      tone: tone === "up" || tone === "down" ? tone : null,
    };
  };

  const part = (p: BlockPart, key: string): BlockViewPart | null => {
    switch (p.type) {
      case "heading":
      case "text":
      case "note":
        return { key, kind: p.type, text: fill(p.text) };
      case "list":
        return { key, kind: "list", items: p.items.map(fill) };
      case "slider": {
        const value = clampStep(toNumber(values[p.name]), p.min, p.max, p.step);
        return {
          key,
          kind: "slider",
          name: p.name,
          label: p.label,
          min: p.min,
          max: p.max,
          step: p.step ?? 1,
          value,
          shown: formatBlockValue(value, p.format, p.unit, words),
        };
      }
      case "choice": {
        const v = values[p.name];
        const value = typeof v === "string" && p.options.includes(v) ? v : null;
        return { key, kind: "choice", name: p.name, label: p.label ?? "", options: p.options, value };
      }
      case "field":
        return {
          key,
          kind: "field",
          name: p.name,
          label: p.label,
          input: p.input ?? "text",
          placeholder: p.placeholder ?? "",
          value: toText(values[p.name]),
        };
      case "switch":
        return { key, kind: "switch", name: p.name, label: p.label, value: truthy(values[p.name]) };
      case "stat":
        return { key, kind: "stats", items: [stat(p, key)] };
      case "stats":
        return {
          key,
          kind: "stats",
          items: p.items
            .map((s, i) => ({ s, k: `${key}.${i}` }))
            .filter(({ s, k }) => s.when === undefined || truthy(read(s.when, `${k}.when`)))
            .map(({ s, k }) => stat(s, k)),
        };
      case "result": {
        const e = expr(p.value);
        return {
          key,
          kind: "result",
          label: p.label,
          text: formatBlockValue(read(p.value, `${key}.value`), p.format, p.unit, words),
          name: e.t === "name" ? e.name : null,
        };
      }
      case "progress": {
        const v = toNumber(read(p.value, `${key}.value`));
        const max = p.max === undefined ? 100 : toNumber(read(p.max, `${key}.max`));
        const share = max > 0 && Number.isFinite(v) ? Math.min(1, Math.max(0, v / max)) : 0;
        return {
          key,
          kind: "progress",
          label: p.label ?? "",
          share,
          text: formatBlockValue(v, p.format, p.unit, words),
        };
      }
      case "chart": {
        let points: { label: string; value: number }[] = [];
        if (p.data !== undefined) {
          const d = read(p.data, `${key}.data`);
          if (Array.isArray(d)) {
            points = d
              .filter((x): x is Record<string, Value> => typeof x === "object" && x !== null && !Array.isArray(x))
              .map((x) => ({ label: toText(x.label ?? null), value: toNumber(x.value ?? null) }));
          } else if (d !== null) errors.push(`${key}.data: must give a list of {label, value}`);
        } else {
          points = (p.items ?? []).map((x, i) => ({
            label: x.label,
            value: toNumber(read(x.value, `${key}.items.${i}`)),
          }));
        }
        points = points.filter((x) => Number.isFinite(x.value)).slice(0, BLOCK_LIMITS.chartPoints);
        return {
          key,
          kind: "chart",
          chart: p.chart,
          label: p.label ?? "",
          labels: points.map((x) => x.label.slice(0, 60)),
          values: points.map((x) => x.value),
          unit: p.unit ?? "",
        };
      }
      case "table": {
        const raw: Value = typeof p.rows === "string" ? read(p.rows, `${key}.rows`) : p.rows;
        const list: Value[] = Array.isArray(raw) ? raw.slice(0, BLOCK_LIMITS.rows) : [];
        if (raw !== null && !Array.isArray(raw)) errors.push(`${key}.rows: must give a list of records`);
        return {
          key,
          kind: "table",
          columns: p.columns.map((c) => c.label),
          rows: list.map((r) =>
            p.columns.map((c) => {
              const cell = typeof r === "object" && r !== null && !Array.isArray(r) ? r[c.key] : null;
              return cell === undefined || cell === null ? "" : formatBlockValue(cell, c.format, undefined, words);
            }),
          ),
        };
      }
      case "more":
        return { key, kind: "more", label: p.label ?? "", parts: parts(p.parts, key) };
      case "row":
        return { key, kind: "row", parts: parts(p.parts, key) };
      case "card": {
        const pick = p.name && p.value !== undefined ? { name: p.name, value: p.value } : null;
        const selected = pick ? toText(values[pick.name]) === pick.value : p.selected === true;
        return {
          key,
          kind: "card",
          label: p.label ?? "",
          sub: p.sub ?? "",
          pick,
          selected,
          parts: parts(p.parts ?? [], key),
        };
      }
      case "actions": {
        const buttons: BlockViewButton[] = [];
        p.buttons.forEach((b, i) => {
          const k = `${key}.${i}`;
          if (b.when !== undefined && !truthy(read(b.when, `${k}.when`))) return;
          let set: Record<string, Value> | null = null;
          if (b.set) {
            set = {};
            for (const [n, f] of Object.entries(b.set)) set[n] = read(f, `${k}.set.${n}`);
          }
          let draw: BlockViewButton["draw"] = null;
          if (b.draw) {
            const opts =
              typeof b.draw.options === "string" ? read(b.draw.options, `${k}.draw.options`) : b.draw.options;
            const list = Array.isArray(opts) ? opts.map(toText).filter(Boolean).slice(0, 100) : [];
            if (list.length >= 2) draw = { name: b.draw.name, options: list };
          }
          buttons.push({ key: k, label: b.label, set, draw, lead: false });
        });
        return buttons.length ? { key, kind: "actions", align: p.align ?? "end", buttons } : null;
      }
    }
    return null;
  };

  const shown = parts(spec.parts, "parts");
  // The only button showing is the block's main action, as in the kit.
  const allButtons: BlockViewButton[] = [];
  const gather = (list: BlockViewPart[]) => {
    for (const p of list) {
      if (p.kind === "actions") allButtons.push(...p.buttons);
      if ("parts" in p) gather(p.parts);
    }
  };
  gather(shown);
  if (allButtons.length === 1) (allButtons[0] as BlockViewButton).lead = true;

  let send: BlockView["send"] = null;
  if (spec.send) {
    const text = fill(spec.send.text).replace(/\s+/g, " ").trim().slice(0, BLOCK_LIMITS.sendChars);
    const ready = (spec.send.needs ?? []).every((n) => truthy(values[n])) && text !== "";
    send = { label: spec.send.label, text, ready, hint: ready ? "" : (spec.send.hint ?? "") };
  }
  return { parts: shown, send, values, errors };
}

/**
 * A spec checked and drawn once from its starting state: the server's last check before a block is shown. Returns
 * what went wrong (formulas that fail on the block's own data), for the agent to fix.
 */
export function dryRunBlock(spec: BlockSpec): string[] {
  try {
    return viewBlock(compileBlock(spec), {}, { locale: "en", thousand: "k" }).errors;
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
}

/** The values a person's change would set: an input's new value, clamped to what the part takes. */
export function inputValue(part: BlockViewPart, raw: unknown): Value | undefined {
  switch (part.kind) {
    case "slider":
      return clampStep(toNumber(raw as Value), part.min, part.max, part.step);
    case "choice":
      return typeof raw === "string" && part.options.includes(raw) ? raw : undefined;
    case "field":
      if (part.input === "number") {
        const s = typeof raw === "string" ? raw.trim() : String(raw ?? "");
        return s === "" ? "" : toNumber(s);
      }
      return typeof raw === "string" ? raw.slice(0, BLOCK_LIMITS.text) : undefined;
    case "switch":
      return raw === true;
    default:
      return undefined;
  }
}

/** Which kind a block's content is: our parts, or the agent's own page (which runs only when a person asks). */
export const isSpecBlock = (content: { spec?: unknown; html?: unknown }) => content.spec !== undefined;

/** The words a block shows, as plain text: what search finds when a person keeps it in the Drive. */
export function blockSpecText(spec: BlockSpec): string {
  const out: string[] = [];
  const walk = (parts: BlockPart[]) => {
    for (const p of parts) {
      if ("label" in p && typeof p.label === "string") out.push(p.label);
      if ("text" in p && typeof p.text === "string") out.push(p.text);
      if (p.type === "list") out.push(...p.items);
      if (p.type === "choice") out.push(...p.options);
      if (p.type === "card" && p.sub) out.push(p.sub);
      if (p.type === "stats") out.push(...p.items.map((s) => s.label));
      if (p.type === "table") out.push(...p.columns.map((c) => c.label));
      if (p.type === "actions") out.push(...p.buttons.map((b) => b.label));
      if ("parts" in p && p.parts) walk(p.parts);
    }
  };
  walk(spec.parts);
  if (spec.send) out.push(spec.send.label);
  return out.join("\n");
}
