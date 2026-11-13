import { expect, test } from "bun:test";
import { hitCheckScript, humanSteps, selectFieldScript } from "../../runner/browser";
import { HUMAN, pointerPath, pointInBox, randomSource, typingDelays } from "../../runner/human-input";

const view = { width: 1280, height: 800 };
const total = (p: { ms: number }[]) => p.reduce((s, x) => s + x.ms, 0);

test("a path goes from where the pointer is to exactly the point, inside the viewport, in a person's time", () => {
  for (let seed = 0; seed < 200; seed++) {
    const p = pointerPath({ x: 10, y: 700 }, { x: 1100, y: 90 }, randomSource(seed), { bounds: view });
    const [first, last] = [p[0], p.at(-1)];
    expect(Math.abs((first?.x ?? 0) - 10) + Math.abs((first?.y ?? 0) - 700)).toBeLessThan(60);
    expect(last).toMatchObject({ x: 1100, y: 90 });
    expect(p.every((q) => q.x >= 0 && q.x < 1280 && q.y >= 0 && q.y < 800)).toBe(true);
    expect(total(p)).toBeGreaterThanOrEqual(130);
    expect(total(p)).toBeLessThanOrEqual(600);
    expect(p.length).toBeGreaterThan(8);
  }
});

test("it curves, is fastest in the middle, takes longer the further it goes, and a seed repeats it", () => {
  const p = pointerPath({ x: 100, y: 400 }, { x: 900, y: 400 }, randomSource(3));
  expect(Math.max(...p.map((q) => Math.abs(q.y - 400)))).toBeGreaterThan(5);
  const steps = p.slice(1).map((q, i) => Math.abs(q.x - (p[i]?.x ?? 0)));
  const middle = Math.max(...steps.slice(steps.length / 3, (2 * steps.length) / 3));
  expect(middle).toBeGreaterThan(3 * (steps[0] ?? 0));
  const near = total(pointerPath({ x: 500, y: 400 }, { x: 540, y: 400 }, randomSource(1)));
  const far = total(pointerPath({ x: 0, y: 0 }, { x: 1200, y: 780 }, randomSource(1)));
  expect(near).toBeLessThan(far);
  const again = () => pointerPath({ x: 3, y: 4 }, { x: 700, y: 500 }, randomSource(9));
  expect(again()).toEqual(again());
});

test("long moves sometimes overshoot and come back", () => {
  let past = 0;
  for (let seed = 0; seed < 200; seed++) {
    if (pointerPath({ x: 100, y: 400 }, { x: 1000, y: 400 }, randomSource(seed)).some((q) => q.x > 1005)) past++;
  }
  expect(past).toBeGreaterThan(10);
  expect(past).toBeLessThan(120);
});

test("a straight path neither curves nor overshoots: from where the line enters a box, it stays in it", () => {
  for (let seed = 0; seed < 200; seed++) {
    const path = pointerPath({ x: 100, y: 400 }, { x: 1000, y: 400 }, randomSource(seed), { straight: true });
    expect(path.every((q) => q.x <= 1000 && Math.abs(q.y - 400) <= 1)).toBe(true);
    expect(path.at(-1)).toMatchObject({ x: 1000, y: 400 });
  }
});

test("a click point is near the middle of the box and never on its edge", () => {
  const rng = randomSource(5);
  for (let i = 0; i < 500; i++) {
    const p = pointInBox({ x: 600, y: 400, width: 120, height: 40 }, rng);
    expect(p.x).toBeGreaterThanOrEqual(601);
    expect(p.x).toBeLessThanOrEqual(718);
    expect(p.y).toBeGreaterThanOrEqual(401);
    expect(p.y).toBeLessThanOrEqual(438);
  }
  expect(pointInBox({ x: 10, y: 10, width: 2, height: 2 }, rng)).toEqual({ x: 11, y: 11 });
});

test("typing waits vary around 80 ms a key, longer after punctuation", () => {
  const text = "Hello, world. This is a test of the typing, really.".repeat(4);
  const waits = typingDelays(text, randomSource(2));
  expect(waits.length).toBe(text.length);
  expect(waits[0]).toBeGreaterThanOrEqual(120);
  expect(waits[0]).toBeLessThanOrEqual(260);
  const rest = waits.slice(1);
  expect(Math.min(...rest)).toBeGreaterThanOrEqual(38);
  const mean = rest.reduce((a, b) => a + b, 0) / rest.length;
  expect(mean).toBeGreaterThan(65);
  expect(mean).toBeLessThan(100);
  const after = rest.filter((_, i) => ",.".includes(text[i] ?? ""));
  const plain = rest.filter((_, i) => /[a-z]/i.test(text[i] ?? ""));
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  expect(avg(after)).toBeGreaterThan(avg(plain) + 30);
});

const box = { x: 600, y: 400, width: 120, height: 40 };

test("a click is a checked point, a path to it, and a held press", () => {
  const s = humanSteps("click", ["@e3"], box, view, { x: 20, y: 30 }, randomSource(4));
  expect(s.check).toEqual(["eval", hitCheckScript(s.to, box, false)]);
  expect(s.moves.length).toBeGreaterThan(8);
  expect(s.moves.every((m) => m[0] === "mouse" && m[1] === "move" && m[4] === "--steps" && m[6] === "--duration")).toBe(
    true,
  );
  expect(s.moves.at(-1)?.slice(2, 4)).toEqual([String(s.to.x), String(s.to.y)]);
  const [down, wait, up] = s.act;
  expect([down, up]).toEqual([
    ["mouse", "down"],
    ["mouse", "up"],
  ]);
  expect(wait?.[0]).toBe("wait");
  expect(Number(wait?.[1])).toBeGreaterThanOrEqual(HUMAN.holdMs[0]);
  expect(Number(wait?.[1])).toBeLessThanOrEqual(HUMAN.holdMs[1]);
});

test("fill clicks, selects and types key by key; type focuses; long text and other commands go as given", () => {
  const fill = humanSteps("fill", ["@e2", "Olá a\nb"], box, view, undefined, randomSource(1));
  expect(fill.act.slice(0, 4)).toEqual([
    ["mouse", "down"],
    fill.act[1] as string[],
    ["mouse", "up"],
    ["eval", selectFieldScript(fill.to)],
  ]);
  const keys = fill.act.slice(4).filter((c) => c[0] !== "wait");
  expect(keys).toEqual([
    ["press", "O"],
    ["press", "l"],
    ["keyboard", "inserttext", "á"],
    ["press", "Space"],
    ["press", "a"],
    ["keyboard", "inserttext", "\n"],
    ["press", "b"],
  ]);
  expect(fill.act.slice(4).filter((c) => c[0] === "wait").length).toBe(7);
  const type = humanSteps("type", ["#q", "a\tb"], box, view, undefined, randomSource(1));
  expect(type.act[0]).toEqual(["focus", "#q"]);
  expect(type.act.filter((c) => c[0] === "press")).toEqual([
    ["press", "a"],
    ["press", "Tab"],
    ["press", "b"],
  ]);
  const long = humanSteps("fill", ["@e2", "x".repeat(HUMAN.typeMaxChars + 1)], box, view, undefined, randomSource(1));
  expect([long.check, long.act]).toEqual([null, [["fill", "@e2", "x".repeat(HUMAN.typeMaxChars + 1)]]]);
  expect(humanSteps("dblclick", ["@e1"], box, view, undefined, randomSource(1)).act).toEqual([["dblclick", "@e1"]]);
  expect(humanSteps("hover", ["@e1"], box, view, undefined, randomSource(1)).act).toEqual([]);
  // Filled with nothing: what was selected is erased.
  expect(humanSteps("fill", ["@e2", ""], box, view, undefined, randomSource(1)).act.at(-1)).toEqual([
    "press",
    "Backspace",
  ]);
});

test("the hit check passes on the element or inside it, on the same control as its middle, and throws on anything else", () => {
  const run = (hit: unknown, framed = false, typing = false, middle = hit) => {
    const win = {};
    const document = { elementFromPoint: (x: number) => (x === 650 ? hit : middle) };
    return () =>
      new Function("document", "window", "top", `return ${hitCheckScript({ x: 650, y: 420 }, box, typing)}`)(
        document,
        win,
        framed ? {} : win,
      );
  };
  const el = (tagName: string, [left, top, right, bottom]: number[], extra: Record<string, unknown> = {}) => ({
    tagName,
    type: "",
    isContentEditable: false,
    closest: () => null,
    getBoundingClientRect: () => ({ left, top, right, bottom }),
    ...extra,
  });
  const target = el("BUTTON", [600, 400, 720, 440]);
  expect(run(target)()).toBe(true);
  expect(run(el("SPAN", [620, 410, 700, 430], { parentElement: target }))()).toBe(true);
  // Something else of that size or smaller at the point: an overlay, or what the top page has at a frame's coordinates.
  expect(run(el("SPAN", [620, 410, 700, 430]))).toThrow("agentes:covered");
  expect(run(el("DIV", [0, 300, 1280, 800]))).toThrow("agentes:covered");
  expect(run(el("IFRAME", [600, 400, 720, 440]))).toThrow("agentes:covered");
  expect(run(target, true)).toThrow("agentes:frame");
  expect(run(null)).toThrow("agentes:covered");
  // A control of its own inside the element, and the middle isn't on it.
  const link = { tagName: "A" };
  const inside = el("A", [640, 410, 660, 430], { parentElement: target, closest: () => link });
  expect(run(inside, false, false, target)).toThrow("agentes:covered");
  expect(run(el("INPUT", [600, 400, 720, 440], { type: "email" }), false, true)()).toBe(true);
  expect(run(el("INPUT", [600, 400, 720, 440], { type: "date" }), false, true)).toThrow("agentes:not_text");
});
