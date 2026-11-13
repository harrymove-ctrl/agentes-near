import { expect, test } from "bun:test";
import { CHAT_TEXT_SIZES, DEFAULT_TEXT_SIZE } from "@agenteschat/client/lib/chat-look";
import { builtCss, declarations, rules } from "./built-css";

const css = await builtCss();
const last = (selector: string, property: string) =>
  declarations(css, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

/** Tamanho do texto, in px: a message's words, their reading line, and the tighter line (a bubble, Compacta, the name). */
const STEPS = {
  xs: [12, 20, 18],
  sm: [13, 22, 19],
  md: [14, 24, 20],
  lg: [16, 27, 23],
  xl: [18, 31, 26],
} as const;
/** Before the setting: 15.5px words on a 1.7 line, 14.5px on 21px in someone else's bubble. */
const BEFORE = { text: 15.5, line: 15.5 * 1.7, bubbleText: 14.5, bubbleLine: 21 };

for (const step of CHAT_TEXT_SIZES) {
  test(`${step}: the words and both their lines follow the step, and the gaps between rows stay`, () => {
    const [text, line, tight] = STEPS[step];
    const at = `[data-text-size="${step}"]`;
    expect(last(at, "--msg-text")).toBe(`${text}px`);
    expect(last(at, "--msg-line")).toBe(`${line}px`);
    expect(last(at, "--msg-line-tight")).toBe(`${tight}px`);
    // The words keep the ratios they had: about 1.7 on a row, 1.45 in a bubble and in Compacta.
    expect(line / text).toBeGreaterThanOrEqual(1.65);
    expect(line / text).toBeLessThanOrEqual(1.75);
    expect(tight / text).toBeGreaterThanOrEqual(1.4);
    expect(tight / text).toBeLessThanOrEqual(1.5);
    // The rhythm (chat-rhythm-css.test.ts) is the same at every size: no step moves a gap or a row's plate.
    for (const token of ["--msg-part-gap", "--msg-turn-gap", "--msg-card-gap", "--msg-block", "--msg-lead"])
      expect(last(at, token)).toBeUndefined();
  });
}

test("the default is md, a step smaller than the words were, in every look", () => {
  expect(DEFAULT_TEXT_SIZE).toBe("md");
  const [text, line, tight] = STEPS.md;
  expect(last(":root", "--msg-text")).toBe(`${text}px`);
  expect(last(":root", "--msg-line")).toBe(`${line}px`);
  expect(last(":root", "--msg-line-tight")).toBe(`${tight}px`);
  expect(text).toBeLessThan(BEFORE.bubbleText);
  expect(line).toBeLessThan(BEFORE.line);
  expect(tight).toBeLessThan(BEFORE.bubbleLine);
  // `lg` comes back close to the words before the setting, for whoever wants them.
  expect(Math.abs(STEPS.lg[0] - BEFORE.text)).toBeLessThanOrEqual(0.5);
  // Steps go up one by one.
  const sizes = CHAT_TEXT_SIZES.map((s) => STEPS[s]);
  for (let i = 1; i < sizes.length; i++)
    for (let k = 0; k < 3; k++) expect(sizes[i]?.[k] as number).toBeGreaterThan(sizes[i - 1]?.[k] as number);
});

test("every look's words take the step: the reading line on a row, the tighter one in a bubble and in Compacta", () => {
  expect(last(".ac-msg__text", "font-size")).toBe("var(--msg-text)");
  expect(last(".ac-msg__text", "line-height")).toBe("var(--msg-line)");
  for (const look of ["bubbles", "compact"])
    expect(last(`[data-look="${look}"]`, "--msg-line")).toBe("var(--msg-line-tight)");
  // No look, row of mine or bubble sets a number of its own for the words.
  const fixed = rules(css).flatMap((r) =>
    r.selectors
      .filter((s) => /\.ac-msg__text(?![\w-])(\s+\.md)?$/.test(s) && !s.includes(".chat-look__"))
      .flatMap((s) =>
        r.declarations
          .filter(([p, v]) => (p === "font-size" || p === "line-height") && !v.includes("var(--msg-"))
          .map(([p, v]) => `${s} ${p}: ${v}`),
      ),
  );
  expect(fixed).toEqual([]);
});

test("the name, its time and the clocks beside the words follow the step too", () => {
  expect(last(".ac-msg__head", "font-size")).toBe("var(--msg-text)");
  expect(last(".ac-msg__head", "line-height")).toBe("var(--msg-line-tight)");
  expect(last(".ac-msg__time", "font-size")).toContain("var(--msg-text)");
  for (const p of ["font-size", "line-height"]) {
    expect(last(".ac-msg__bubble-head", p)).toContain("var(--msg-");
    expect(last('.ac-msg[data-look="bubbles"] .ac-msg__head', p)).toContain("var(--msg-");
    expect(last('.ac-msg[data-look="compact"] .ac-msg__head', p)).toContain("var(--msg-");
  }
  // A grouped row's time and check, my bubble's bar and Compacta's clock and face sit on the words' first line.
  expect(last(".ac-msg__gutter-time", "line-height")).toBe("var(--msg-line)");
  expect(last(".ac-msg__aside--floating", "line-height")).toBe("var(--msg-line)");
  expect(last(".ac-msg__clock", "top")).toContain("var(--msg-line)");
  expect(last('.ac-msg[data-look="compact"] .ac-msg__avatar', "top")).toContain("var(--msg-line)");
  expect(last('.ac-msg[data-look="compact"]', "min-height")).toBe("var(--msg-line)");
  // Half of the kit's 28px icon button under that middle.
  expect(css.replace(/\s+/g, "")).toContain("top:calc(7px+var(--msg-line)/2-var(--cap-mid)-14px)");
});

test("code in a message takes the step as its words do, the default keeping its 12.5px on a 20px line", () => {
  const block = (p: string) => last(".ac-msg__text .code-card__code", p)?.replace(/\s+/g, "");
  expect(block("font-size")).toBe("calc(var(--msg-text)-1.5px)");
  expect(block("line-height")).toBe("var(--msg-line-tight)");
  expect(STEPS.md[0] - 1.5).toBe(12.5);
  expect(STEPS.md[2]).toBe(20);
  // Inline code is a share of the words, a message's or anyone's (one look); a card's code block keeps its own size.
  expect(last(".ac-inlinecode", "font-size")).toMatch(/em$/);
  expect(last(".code-card__code", "font-size")).toBe("12.5px");
  expect(last(".code-card__code", "line-height")).toBe("20px");
});

test("Compacta's event rows read like its lines at every step: sentence, time, mark and actions take the step", () => {
  const at = (part: string, p: string) =>
    last(`.channel__messages[data-look="compact"] .ac-eventpill__${part}`, p)?.replace(/\s+/g, "");
  expect(at("frame", "font-size")).toBe("calc(var(--msg-text)-1px)");
  expect(at("frame", "line-height")).toBe("var(--msg-line)");
  expect(at("frame", "min-height")).toBe("var(--msg-line)");
  expect(at("action", "font-size")).toBe("calc(var(--msg-text)-1.5px)");
  expect(at("action", "line-height")).toBe("var(--msg-line)");
  // Its time is the rows' clock, in the clock's size, and the mark stands where the small face does.
  expect(at("time", "font-size")).toBe(last(".ac-msg__clock", "font-size")?.replace(/\s+/g, ""));
  expect(at("time", "top")).toBe("calc(var(--msg-line)/2-8px)");
  expect(at("mark", "top")).toBe("calc(var(--msg-line)/2-9px)");
  // At the default: a 13px sentence and 12.5px actions on Compacta's 20px line, the mark 1px and the time 2px down.
  const [text, , tight] = STEPS.md;
  expect([text - 1, text - 1.5, tight / 2 - 9, tight / 2 - 8]).toEqual([13, 12.5, 1, 2]);
});
