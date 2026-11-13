import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { useDragScroll } from "../src";

afterEach(cleanup);

function Board() {
  const ref = useRef<HTMLDivElement>(null);
  useDragScroll(ref, ".wrap, .col");
  return (
    <div ref={ref} className="wrap" data-testid="wrap">
      <div className="col" data-testid="col">
        <button type="button">Card</button>
      </div>
    </div>
  );
}

function setup() {
  const view = render(<Board />);
  const wrap = view.getByTestId("wrap");
  Object.defineProperty(wrap, "scrollWidth", { value: 2000 });
  Object.defineProperty(wrap, "clientWidth", { value: 800 });
  wrap.scrollLeft = 300;
  return { view, wrap };
}

const mouse = { pointerType: "mouse", pointerId: 1, button: 0 };

describe("a board a mouse drags sideways", () => {
  test("a press on its empty space and a drag slide it with the pointer, and it stays where it was let go when motion is reduced", () => {
    const media = spyOn(window, "matchMedia").mockImplementation(
      (q: string) => ({ matches: q.includes("reduce"), media: q }) as MediaQueryList,
    );
    try {
      const { view, wrap } = setup();
      fireEvent.pointerDown(view.getByTestId("col"), { ...mouse, clientX: 500 });
      fireEvent.pointerMove(document, { ...mouse, clientX: 400 });
      expect(wrap.scrollLeft).toBe(400);
      expect(wrap.style.cursor).toBe("grabbing");
      fireEvent.pointerUp(document, { ...mouse, clientX: 380 });
      expect(wrap.style.cursor).toBe("");
      fireEvent.pointerMove(document, { ...mouse, clientX: 0 });
      expect(wrap.scrollLeft).toBe(400);
    } finally {
      media.mockRestore();
    }
  });

  test("a press on a card, words or a button keeps its own: the board doesn't move", () => {
    const { view, wrap } = setup();
    fireEvent.pointerDown(view.getByRole("button", { name: "Card" }), { ...mouse, clientX: 500 });
    fireEvent.pointerMove(document, { ...mouse, clientX: 300 });
    expect(wrap.scrollLeft).toBe(300);
  });

  test("a finger pans it natively: no drag of ours", () => {
    const { view, wrap } = setup();
    fireEvent.pointerDown(view.getByTestId("col"), { ...mouse, pointerType: "touch", clientX: 500 });
    fireEvent.pointerMove(document, { ...mouse, pointerType: "touch", clientX: 300 });
    expect(wrap.scrollLeft).toBe(300);
  });

  test("shift and an up-and-down wheel slide it sideways, even over a column; a sideways wheel stays the browser's", () => {
    const { view, wrap } = setup();
    // happy-dom's WheelEvent carries no modifier keys; a browser's does.
    const wheel = (init: WheelEventInit) => {
      const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(e, "shiftKey", { value: Boolean(init.shiftKey) });
      fireEvent(view.getByTestId("col"), e);
    };
    wheel({ deltaY: 120, shiftKey: true });
    expect(wrap.scrollLeft).toBe(420);
    wheel({ deltaY: -120, shiftKey: true });
    expect(wrap.scrollLeft).toBe(300);
    wheel({ deltaX: 50, shiftKey: true });
    wheel({ deltaY: 120 });
    expect(wrap.scrollLeft).toBe(300);
  });
});
