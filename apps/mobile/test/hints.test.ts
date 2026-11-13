import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hintBack, hintBackOr, hintClosed, hintOpened, hintTouched, hintTouches } from "../src/ui/hints";

const at = (x: number, y: number) => ({ nativeEvent: { pageX: x, pageY: y } });

/** A hint as `InfoHint` registers it: `open` mirrors its state. */
function hint(id: string) {
  const h = {
    id,
    open: false,
    show() {
      h.open = true;
      hintOpened({ id, close: () => (h.open = false) });
    },
  };
  return h;
}

/** A tap that starts and ends at one point; `on` is the hint whose ⓘ or text it lands on. */
function tap(on?: string, from = at(10, 10), to = from) {
  hintTouches.onTouchStartCapture(from);
  if (on) hintTouched(on);
  hintTouches.onTouchEnd(to);
}

describe("an ⓘ hint on the phone", () => {
  beforeEach(() => {
    // Whatever a test left open closes, so each starts with none.
    hintBack();
  });

  test("a tap anywhere else closes it; a tap on its own ⓘ or text leaves it to the ⓘ", () => {
    const a = hint("a");
    a.show();
    tap("a");
    expect(a.open).toBe(true);
    tap();
    expect(a.open).toBe(false);
  });

  test("a scroll leaves it open, so a long text can be read; so does a touch the system took over", () => {
    const a = hint("a");
    a.show();
    tap(undefined, at(10, 10), at(10, 60));
    expect(a.open).toBe(true);
    hintTouches.onTouchStartCapture(at(10, 10));
    hintTouches.onTouchCancel();
    hintTouches.onTouchEnd(at(10, 10));
    expect(a.open).toBe(true);
  });

  test("one at a time: opening another closes the first, whichever handler runs first", () => {
    const a = hint("a");
    const b = hint("b");
    a.show();
    // The tap on b's ⓘ ends outside a: a closes, and b's own press opens b.
    tap("b");
    b.show();
    expect([a.open, b.open]).toEqual([false, true]);
    // The press may also run before the end of the touch reaches the app's view.
    hintTouches.onTouchStartCapture(at(10, 10));
    hintTouched("a");
    a.show();
    hintTouches.onTouchEnd(at(10, 10));
    expect([a.open, b.open]).toEqual([true, false]);
  });

  test("a touch starts with no owner: one that began on an ⓘ doesn't make the next one its own", () => {
    const a = hint("a");
    a.show();
    hintTouches.onTouchStartCapture(at(10, 10));
    hintTouched("a");
    hintTouches.onTouchCancel();
    tap();
    expect(a.open).toBe(false);
  });

  test("Android's back closes it, and only when one is open does it keep the screen", () => {
    const a = hint("a");
    a.show();
    expect(hintBack()).toBe(true);
    expect(a.open).toBe(false);
    expect(hintBack()).toBe(false);
  });

  test("in a sheet, which takes Android's back before the hint can, back closes the hint and the next one the sheet", () => {
    const a = hint("a");
    let closed = 0;
    const back = hintBackOr(() => {
      closed++;
    });
    a.show();
    back();
    expect([a.open, closed]).toEqual([false, 0]);
    back();
    expect(closed).toBe(1);
  });

  test("closed by its own ⓘ, or gone from the screen, it is forgotten: back leaves the screen again", () => {
    const a = hint("a");
    a.show();
    hintClosed("a");
    expect(hintBack()).toBe(false);
  });
});

/** A file of the app, as text: what wires the hint in lives in components the tests can't render. */
const SRC = join(import.meta.dir, "../src");
const source = (path: string) => readFileSync(join(SRC, path), "utf8");

describe("where the ⓘ is plugged in", () => {
  test("every tap reaches the app's outermost view, and a bottom sheet's back closes the hint first", () => {
    expect(source("providers/AppProviders.tsx")).toMatch(/<GestureHandlerRootView[^>]*\{\.\.\.hintTouches\}/);
    expect(source("ui/Sheet.tsx")).toContain("onRequestClose={hintBackOr(onClose)}");
  });

  test("the ⓘ is a button named by the hint, says whether it's open, and its text is announced", () => {
    const hint = source("ui/InfoHint.tsx");
    for (const prop of [
      'accessibilityRole="button"',
      "accessibilityLabel={name}",
      "accessibilityState={{ expanded: open }}",
      'accessibilityLiveRegion="polite"',
      "AccessibilityInfo.announceForAccessibility(text)",
    ])
      expect(hint).toContain(prop);
  });

  test('every ⓘ in the app is named "About …"', () => {
    const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx"));
    const names = files.flatMap((f) =>
      [...source(f).matchAll(/<InfoHint\b[\s\S]*?\bname=\{([^}]*)\}/g)].map((m) => m[1]),
    );
    const fields = files.flatMap((f) =>
      [...source(f).matchAll(/\bhint=\{[^}]*?\{\s*name:\s*([^,]*),/g)].map((m) => m[1]),
    );
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(fields.length).toBeGreaterThanOrEqual(1);
    for (const name of [...names, ...fields]) expect(name).toStartWith('t("common.about"');
  });
});
