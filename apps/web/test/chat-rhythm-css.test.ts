import { expect, test } from "bun:test";
import { CHAT_RHYTHM } from "@agenteschat/client/lib/chat-look";
import { atRule, builtCss, declarations, rules, topLevel } from "./built-css";

const SHEETS = [
  "src/styles.css",
  "src/components/agent-actions.css",
  "src/components/blocks/blocks.css",
  "src/components/browser/browser.css",
  "src/components/chat-notices.css",
  "src/components/computer-queue.css",
  "src/components/issue-work.css",
  "src/components/missions/missions.css",
  "src/components/request-card.css",
  "src/components/threads/threads.css",
];
const css = await builtCss(...SHEETS);
const last = (selector: string, property: string) =>
  declarations(css, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];
const VERTICAL = new Set(["margin", "margin-top", "margin-bottom", "margin-block", "margin-block-start"]);
const setsVertical = ([p]: readonly [string, string]) => VERTICAL.has(p);

/** Everything that stacks in a message's body or in the list, as its own rule names it. */
const PARTS = [
  "ac-msg__text",
  "ac-msg__error",
  "ac-msg__error-row",
  "ac-msg__activity",
  "ac-msg__own-time",
  "ac-receipt",
  "ac-reacts",
  "ac-tools",
  "artifact-cards",
  "thread-line",
  "thread-stub",
  "thread-closed",
  "choice-reply",
  "cn-line",
  "cn-report",
  "correction-ask",
  "cq__acts",
  "iw-card",
  "iw-line",
  "mi-created",
  "mi-evt",
  "mi-linkrow",
  "mi-suggest",
  "mi-tag",
  "rq-done",
  "rq-open",
  "cn-pill",
  "ac-eventpill",
  "brw-rq",
  "consult-pair",
  "channel__unread",
];
/** These also stand outside a message, so they keep their own top there, and only there. */
const OUTSIDE_TOO = ["rq", "brw-ac", "mi-card", "ag-rcs"];
const subject = (selector: string) =>
  selector
    .trim()
    .split(/[\s>+~]+/)
    .at(-1) ?? "";
const named = (selector: string, cls: string) => new RegExp(`\\.${cls}(?![\\w-])`).test(subject(selector));

test("one token pair per look, the same numbers the phone reads", () => {
  const { comfortable, bubbles, compact } = CHAT_RHYTHM;
  expect(CHAT_RHYTHM.left).toEqual(comfortable);
  for (const [selector, r] of [
    [":root", comfortable],
    ['[data-look="bubbles"]', bubbles],
    ['[data-look="compact"]', compact],
  ] as const) {
    expect(last(selector, "--msg-part-gap")).toBe(`${r.part}px`);
    expect(last(selector, "--msg-turn-gap")).toBe(`${r.turn}px`);
    expect(last(selector, "--msg-block")).toBe(`${r.block}px`);
  }
});

test("a card under a message stands the card gap off it, in its row or in one of its own, in every look", () => {
  for (const { card } of Object.values(CHAT_RHYTHM))
    expect(`${card}px`).toBe(last(":root", "--msg-card-gap") as string);
  const gapped = (s: string, p: string, v: string) =>
    rules(css).some(
      (r) => r.selectors.some((x) => x.includes(s)) && r.declarations.some(([k, w]) => k === p && w === v),
    );
  expect(gapped(".ac-msg__text,.ac-msg-media)~:is(.rq,", "margin-top", "var(--msg-card-gap)")).toBe(true);
  expect(gapped(".ac-msg--grouped:not(:has(.ac-msg__text)):has(.rq,", "--row-gap", "var(--msg-card-gap)")).toBe(true);
});

test("the list spends the two gaps: no flex gap, and a row gives its plate's room back", () => {
  expect(last(".channel__messages", "gap")).toBeUndefined();
  const row = ".channel__messages > :not(.channel__empty)";
  expect(last(row, "margin-block")).toBe("var(--row-gap) 0");
  expect(last(row, "--row-gap")).toBe("var(--msg-turn-gap)");
  expect(last(".channel__messages > .ac-msg + .ac-msg--grouped", "--row-gap")).toBe("var(--msg-part-gap)");
  expect(last(".channel__messages > .ac-msg", "margin-block")).toBe(
    "calc(var(--row-gap) - var(--msg-block)) calc(-1 * var(--msg-block))",
  );
  expect(last(".ac-msg", "padding")).toBe("var(--msg-block) var(--msg-inline)");
  // Nothing else sets a row's room: not a look, a run of my rows, or what a row holds.
  const rowRoom = rules(css)
    .filter((r) =>
      r.declarations.some(([p]) =>
        /^(padding-block|padding-top|padding-bottom|margin|margin-top|margin-bottom)$/.test(p),
      ),
    )
    .flatMap((r) =>
      r.selectors.filter((s) => /^\.ac-msg(?![\w-])[^ >+~]*$/.test(s) || /^\.ac-msg--(own|grouped)[^ >+~]*$/.test(s)),
    );
  expect(rowRoom.filter((s) => s !== ".ac-msg")).toEqual([]);
});

test("two tinted rows of a turn meet and never overlap", () => {
  for (const { part, block } of Object.values(CHAT_RHYTHM)) expect(2 * block).toBeLessThanOrEqual(part);
});

test("the list's gap is what stands above a row, whatever the row sets outside the list", () => {
  // `.channel__notice` and `.mi-card` carry a margin for where they stand alone: one class never beats the list's two.
  const weight = (s: string) => (s.match(/\.[\w-]+/g) ?? []).length;
  expect(weight(".channel__messages>:not(.channel__empty)")).toBeGreaterThan(weight(".channel__notice"));
  expect(last(".channel__messages > :is(.ac-divider,.channel__notice)", "padding-block")).toBe("0");
  expect(declarations(css, ".thread-marker").filter(([p]) => /^padding(-bottom|-block)?$/.test(p))).toEqual([]);
  // The first row of a conversation has nothing to stand off, a quiet line either.
  const quiet = rules(css).find((r) =>
    r.declarations.some(([p, v]) => p === "--row-gap" && v === "var(--msg-part-gap)"),
  );
  expect(quiet?.selectors.join()).toContain(".channel__spacer");
  expect(last(".channel__messages > .channel__spacer + *", "--row-gap")).toBe("0px");
});

test("a row is as tall as what it shows", () => {
  // The hidden time beside a grouped row's one short line, and a line box around an inline card, both added height.
  expect(last(".ac-msg__gutter", "height")).toBe("0");
  // Unseen, the time takes no room: its line hung past a row with nothing in it yet, and scrolled the list by it.
  expect(last(".ac-msg__gutter-time", "content-visibility")).toBe("hidden");
  expect(last(".ac-msg--grouped:hover .ac-msg__gutter-time", "content-visibility")).toBe("visible");
  expect(last(".choice-reply", "display")).toBe("flex");
  // A reply's quote stays 2px over its row at a phone's width: the narrow rule leaves the rows' gap alone.
  expect(atRule(css, "@media (max-width: 760px)")).not.toMatch(/\.channel__messages \.ac-msg\{[^}]*(?<!-)gap:/);
});

test("a message's body sets what stands between its parts, and no part sets it for itself", () => {
  expect(last(".ac-msg .ac-msg__body>*", "margin-block")).toBe("0");
  const gap = rules(css).find((r) => r.selectors.some((s) => s.includes(".ac-msg__body>:not(") && s.includes("~")));
  expect(gap?.declarations).toContainEqual(["margin-top", "var(--msg-part-gap)"]);
  const own = rules(css)
    .filter((r) => r.declarations.some(setsVertical))
    .flatMap((r) => r.selectors.filter((s) => PARTS.some((cls) => named(s, cls))))
    // A part's insides and its place in a card or a page are its own business; the body's rule, a look's too.
    .filter(
      (s) =>
        !/^\.(ac-msg__error-row\s*>|issue|mi-delivery|ac-msg\s\.ac-msg__body|ac-msg\.ac-msg(\[data-look=[^\]]+\])?\s\.ac-msg__body)/.test(
          s,
        ),
    );
  expect(own).toEqual([]);
  // Nor by what stands above it.
  const byNeighbour = rules(css)
    .filter((r) => r.declarations.some(setsVertical))
    .flatMap((r) => r.selectors.filter((s) => /^\.ac-msg(__text|-media|__head)[^ ]*[+~]/.test(s)));
  expect(byNeighbour).toEqual([]);
});

test("an event pill is a part: the body sets its top, and a bubble's tab stands on its bubble", () => {
  const tab = rules(css).find((r) =>
    r.selectors.some((s) =>
      /^\.ac-msg\.ac-msg\[data-look=.?bubbles.?\]\s\.ac-msg__body>\.ac-msg__text\+\.ac-eventpill$/.test(s),
    ),
  );
  expect(tab?.declarations).toEqual([["margin-top", "1px"]]);
  expect(
    last(
      ".ac-msg .ac-msg__body > .ac-msg__head + :is(.ac-msg__text, .ac-msg__error-row, .rq-done, .rq-open)",
      "margin-top",
    ),
  ).toBe("2px");
});

/** A length the sheet wrote (`32px`, `0`, `calc((var(--msg-line) - 32px)/2)`), in px, at the tokens' values. */
const px = (value: string | undefined): number => {
  const text = (value ?? "").replace(/var\((--[\w-]+)\)/g, (_m, token: string) => last(":root", token) ?? "").trim();
  const half = /^calc\(\(\s*(-?[\d.]+)px\s*-\s*(-?[\d.]+)px\s*\)\s*\/\s*2\s*\)$/.exec(text);
  if (half) return (Number(half[1]) - Number(half[2])) / 2;
  const plain = /^(-?[\d.]+)(?:px)?$/.exec(text);
  if (plain) return Number(plain[1]);
  throw new Error(`not a length: ${value}`);
};

test("a failed reply's reason sits under the name like the text it stands for, its buttons hung on its first line", () => {
  // Under the name: the 2px a message's text gets, never the gap between parts plus a push to centre the buttons. On
  // the text's own size and reading line, so its words stand where the text's would at every text size and look.
  const reason = ".ac-msg__error-row > .ac-msg__error";
  expect(px(last(reason, "margin"))).toBe(0);
  expect(last(reason, "font-size")).toBe("var(--msg-text)");
  expect(last(reason, "line-height")).toBe("var(--msg-line)");
  const line = px(last(reason, "line-height"));
  expect(line).toBe(24);
  // The × hangs over the reason's first line by as much as it outgrows it: centred on it, and the row no taller than
  // its words. On touch too: a small button keeps its 32 plate there, only its target grows.
  const at = (sheet: string, selector: string) =>
    declarations(sheet, selector)
      .filter(([p]) => p === "margin-block")
      .at(-1)?.[1];
  const touch = atRule(css, "@media (pointer: coarse)");
  const small = px(last(":root", "--control-h-sm"));
  const hung = px(at(topLevel(css), ".ac-msg__error-row > .ac-btn--icon"));
  expect(small + 2 * hung).toBe(line);
  expect(hung + small / 2).toBe(line / 2);
  expect(at(touch, ".ac-msg__error-row > .ac-btn--icon")).toBeUndefined();
  // Its fix (a key, a model) on a line of its own under the reason: beside it, a long reason went a word per line.
  const fix = ".ac-msg__error-row > .ac-btn:not(.ac-btn--icon)";
  const bare = (value: string | undefined) => value?.replace(/\s/g, "");
  // In the reason's column only: spanning the ×'s too, its width went to that column and squeezed the reason.
  expect(bare(last(fix, "grid-area"))).toBe("2/1");
  expect(bare(last(".ac-msg__error-row", "grid-template-columns"))).toBe("minmax(0,max-content)max-content");
  // "sem notícias há N min · Atualizar": its button hangs over its 16px line the same way.
  const quiet = px(last(".ac-msg__activity", "line-height"));
  expect(px(at(topLevel(css), ".run-quiet > .ac-btn")) * 2 + small).toBe(quiet);
  expect(at(touch, ".run-quiet > .ac-btn")).toBeUndefined();
});

test("in Compacta a pill's time stays one line in the clock's column, however long", () => {
  const time = '.channel__messages[data-look="compact"] .ac-eventpill__time';
  expect(last(time, "white-space")).toBe("nowrap");
  // Overflow goes left, into the row's inset, so its clock still ends where the rows' clocks end.
  expect(last(time, "display")).toBe("flex");
  expect(last(time, "justify-content")).toBe("flex-end");
  expect(last(time, "width")).toBe("40px");
});

test("a card that also stands alone keeps its own margin only outside a message", () => {
  // The body's rule (`.ac-msg .ac-msg__body>*`) is the kit's, in a layer under the page sheets, so it can't outrank a
  // card's own rule: the card's margin is scoped out of a message body, at its one class's weight.
  for (const cls of OUTSIDE_TOO) {
    const own = rules(css)
      .filter((r) => r.declarations.some(setsVertical))
      .flatMap((r) => r.selectors);
    expect(own).toContain(`:where(:not(.ac-msg__body))>.${cls}`);
    expect(own).not.toContain(`.${cls}`);
  }
});

test("the agents' line is the conversation's width, the pair on its middle, and takes the list's gap", () => {
  expect(last(".consult-pair", "display")).toBe("grid");
  expect(last(".consult-pair", "grid-template-columns")).toBe("minmax(16px,1fr) minmax(0,auto) minmax(16px,1fr)");
  expect(last(".consult-pair", "margin")).toBeUndefined();
  // The hidden chevron keeps no room on one side only.
  expect(last(".consult-pair__chev", "position")).toBe("absolute");
  expect(last(".consult-pair__row", "padding")).toBe("var(--space-1) 20px");
  // Inside a message it leaves the row's body for the same width.
  expect(last(".ag-rc--talk", "margin-left")).toBe("calc(-1 * var(--msg-lead))");
  // And comes short of the list's by what a look's rows stand in from it: the two lines end on the same point.
  expect(last(".ag-rcs .ag-rc--talk > .consult-pair", "padding-inline")).toBe("calc(16px - var(--msg-inline))");
  expect(last(".consult-pair", "padding-inline")).toBe("16px");
  expect(last('.ac-msg[data-look="compact"]', "--msg-inline")).toBe("12px");
  // Between turns there too: the turn's gap on both sides, the body's part gap and the line's own room.
  expect(last(".ag-rcs .ag-rc--talk", "padding-block")).toBe("calc(var(--msg-turn-gap) - var(--msg-part-gap))");
  // A message that ends on it: what follows takes the part gap, which the line's room makes a turn's.
  const after = rules(css).find((r) =>
    r.selectors.some((s) => s.includes(".ag-rc--talk:last-child") && s.endsWith("+*")),
  );
  expect(after?.declarations).toContainEqual(["--row-gap", "var(--msg-part-gap)"]);
  // Two in a row stack at the part gap: the room under the first, the stack's 6px and this margin add up to it.
  expect(last(".ag-rcs--stack", "gap")).toBe("6px");
  const next = rules(css).find((r) => r.selectors.some((s) => s.endsWith(".ag-rc--talk+.ag-rc--talk")));
  expect(next?.declarations).toContainEqual(["padding-top", "0"]);
  expect(next?.declarations).toContainEqual([
    "margin-top",
    "calc(2 * var(--msg-part-gap) - var(--msg-turn-gap) - 6px)",
  ]);
});
