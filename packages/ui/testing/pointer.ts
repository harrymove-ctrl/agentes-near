/**
 * A mouse over elements laid out by hand, for tests of what follows the pointer (hover cards). happy-dom lays nothing
 * out, so `place` gives an element its box. Each step runs in `act` and lets what it started settle (Radix places a
 * popover a microtask later); `tick` moves fake timers (`jest.useFakeTimers()`).
 */
import { jest } from "bun:test";
import { act, fireEvent } from "@testing-library/react";

export const box = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;

export function place(el: Element | null, rect: DOMRect) {
  if (el) el.getBoundingClientRect = () => rect;
}

export const step = (run: () => unknown) =>
  act(async () => {
    run();
  });

export const tick = (ms: number) => step(() => jest.advanceTimersByTime(ms));

const at = (x: number, y: number) => ({ pointerType: "mouse", clientX: x, clientY: y });

export const mouse = {
  enter: (el: Element, x: number, y: number) => step(() => fireEvent.pointerEnter(el, at(x, y))),
  /** Out of `el` onto `to`; by default out of everything, so React leaves every card around `el` too. */
  leave: (el: Element, x: number, y: number, to: Element | null = null) =>
    step(() => fireEvent.pointerLeave(el, { ...at(x, y), relatedTarget: to })),
  move: (el: Element, x: number, y: number) => step(() => fireEvent.pointerMove(el, at(x, y))),
};
