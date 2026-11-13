import { type MouseEvent, type PointerEvent, useEffect, useState } from "react";
import { hoverPointer } from "../device";

/**
 * How long a card the pointer opened waits, once the pointer left it and its trigger, before it closes: back in time,
 * it stays. Radix HoverCard's own default: time to undo an overshoot (about 200 ms), short enough that a card the
 * pointer moved on from doesn't linger.
 */
export const HOVER_CLOSE_MS = 300;

/** How long the pointer rests on another trigger, while a card is open, before that one's card takes over. */
export const HOVER_SWITCH_MS = 120;

/** How a hover card is open: the pointer rests on it, or a press or a key brought it (it stays until dismissed). */
export type HoverCardOpen = false | "hover" | "press";

/** A card that opens when a mouse or a pen rests on its trigger (`useHoverCard`), for `Popover`'s `hover`. */
export interface HoverCard {
  open: HoverCardOpen;
  /** For the popover's `onOpenChange`: a press or a key opens it, Esc or a press elsewhere closes it. */
  onOpenChange: (open: boolean) => void;
  close: () => void;
  /** The trigger's handlers. */
  trigger: {
    onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
    onPointerLeave: (e: PointerEvent<HTMLElement>) => void;
    onClick: (e: MouseEvent<HTMLElement>) => void;
  };
  /** The card's ref and handlers. */
  content: {
    ref: (el: HTMLElement | null) => void;
    onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
    onPointerLeave: (e: PointerEvent<HTMLElement>) => void;
  };
}

type Point = { x: number; y: number };
type Box = { left: number; top: number; right: number; bottom: number };
/** Where the pointer is for a shown card: on it, its trigger or the gap between them; on its way there; elsewhere. */
type Where = "in" | "way" | null;

interface Card {
  open: HoverCardOpen;
  openMs: number;
  trigger: HTMLElement | null;
  content: HTMLElement | null;
  /** Where the pointer left the trigger, until it reaches the card: the tip of its way there. */
  exit: Point | null;
  opening?: ReturnType<typeof setTimeout>;
  closing?: ReturnType<typeof setTimeout>;
  render: (open: HoverCardOpen) => void;
}

/** The cards hover keeps open, outermost first: each one's trigger is inside the card before it. */
const shown: Card[] = [];
/** Cards a press or a key opened: while one is up, hover opens no card outside it (no two stacked, no lost draft). */
const pinned = new Set<Card>();
/** The pointer's last place while a card is shown. */
let pointer: Point = { x: 0, y: 0 };
let listening = false;

const inBox = (b: Box, p: Point) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;
const cross = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
/** Inside the triangle abc, its edges included. */
const inTriangle = (p: Point, a: Point, b: Point, c: Point) => {
  const turns = [cross(a, b, p), cross(b, c, p), cross(c, a, p)];
  return turns.every((n) => n >= 0) || turns.every((n) => n <= 0);
};

/** The gap between a trigger and its card, and the card's edge across it; none while they touch or aren't laid out. */
function between(t: DOMRect, c: DOMRect): { gap: Box; edge: [Point, Point] } | null {
  if (!t.width || !t.height || !c.width || !c.height) return null;
  const across = { left: Math.max(t.left, c.left), right: Math.min(t.right, c.right) };
  const along = { top: Math.max(t.top, c.top), bottom: Math.min(t.bottom, c.bottom) };
  if (c.top >= t.bottom) {
    return {
      gap: { ...across, top: t.bottom, bottom: c.top },
      edge: [
        { x: c.left, y: c.top },
        { x: c.right, y: c.top },
      ],
    };
  }
  if (c.bottom <= t.top) {
    return {
      gap: { ...across, top: c.bottom, bottom: t.top },
      edge: [
        { x: c.left, y: c.bottom },
        { x: c.right, y: c.bottom },
      ],
    };
  }
  if (c.left >= t.right) {
    return {
      gap: { ...along, left: t.right, right: c.left },
      edge: [
        { x: c.left, y: c.top },
        { x: c.left, y: c.bottom },
      ],
    };
  }
  if (c.right <= t.left) {
    return {
      gap: { ...along, left: c.right, right: t.left },
      edge: [
        { x: c.right, y: c.top },
        { x: c.right, y: c.bottom },
      ],
    };
  }
  return null;
}

/** By the element under the pointer, or by their boxes without one (a scroll). */
function whereIs(card: Card, target: EventTarget | null): Where {
  const { trigger, content } = card;
  if (!trigger || !content) return null;
  const under = target instanceof Node;
  if (under && (trigger.contains(target) || content.contains(target))) return "in";
  const t = trigger.getBoundingClientRect();
  const c = content.getBoundingClientRect();
  if (!under && (inBox(t, pointer) || inBox(c, pointer))) return "in";
  const apart = between(t, c);
  if (!apart) return null;
  if (inBox(apart.gap, pointer)) return "in";
  // The triangle from where it left the trigger to the card's near edge: whatever it crosses on the way.
  return card.exit && inTriangle(pointer, card.exit, ...apart.edge) ? "way" : null;
}

const stopClosing = (card: Card) => {
  clearTimeout(card.closing);
  card.closing = undefined;
};
const closeLater = (card: Card) => {
  stopClosing(card);
  card.closing = setTimeout(() => close(card), HOVER_CLOSE_MS);
};

function set(card: Card, open: HoverCardOpen) {
  clearTimeout(card.opening);
  card.opening = undefined;
  stopClosing(card);
  card.exit = null;
  const at = shown.indexOf(card);
  if (at >= 0) shown.splice(at, 1);
  if (open === "hover") shown.push(card);
  if (open === "press") pinned.add(card);
  else pinned.delete(card);
  listen(shown.length > 0);
  card.open = open;
  card.render(open);
}

/**
 * A press or a key opens it: it takes over from the card it would have closed, and pins the cards it sits in, so
 * the pointer can go to it (portaled outside them) without them closing under it.
 */
function press(card: Card) {
  const from = leaving(card);
  if (from) close(from);
  for (const c of shown.filter((c) => inside(c, card.trigger))) set(c, "press");
  set(card, "press");
}

/** Closes it and the cards open inside it. */
function close(card: Card) {
  const at = shown.indexOf(card);
  if (at >= 0) for (const inner of shown.slice(at + 1).reverse()) set(inner, false);
  set(card, false);
}

/** The outermost shown card that opening this one closes: the first one its trigger isn't inside. */
function leaving(card: Card) {
  let holder = -1;
  shown.forEach((c, i) => {
    if (card.trigger && c.content?.contains(card.trigger)) holder = i;
  });
  return shown[holder + 1];
}

/** The pointer is on its way to this card or one inside it (or in a gap before one): it isn't there yet. */
const onItsWay = (card: Card) => shown.slice(shown.indexOf(card)).some((c) => whereIs(c, null) !== null);

/** Inside the card, or inside a card shown from inside it. */
const inside = (card: Card, el: HTMLElement | null): boolean =>
  Boolean(el && (card.content?.contains(el) || shown.some((c) => c.content?.contains(el) && inside(card, c.trigger))));

function hoverOpen(card: Card) {
  if ([...pinned].some((c) => !inside(c, card.trigger))) return;
  const from = leaving(card);
  if (from) close(from);
  set(card, "hover");
}

function wait(card: Card, ms: number) {
  clearTimeout(card.opening);
  if (ms <= 0) return hoverOpen(card);
  card.opening = setTimeout(() => {
    card.opening = undefined;
    const from = leaving(card);
    // Passing over this trigger on the way to another card: it opens once the pointer rests here.
    if (from && onItsWay(from)) wait(card, HOVER_CLOSE_MS);
    else hoverOpen(card);
  }, ms);
}

function onMove(e: globalThis.PointerEvent) {
  if (!hoverPointer(e.pointerType)) return;
  pointer = { x: e.clientX, y: e.clientY };
  let held: Where = null;
  // Innermost first: what holds a card holds the cards around it.
  for (const card of [...shown].reverse()) {
    const here = whereIs(card, e.target);
    if (here === "in" && e.target instanceof Node && card.content?.contains(e.target)) card.exit = null;
    held = held === "in" || here === "in" ? "in" : (held ?? here);
    if (held === "in") stopClosing(card);
    // On its way the wait starts over at every move: a pointer that rests there settled on something else.
    else if (held === "way" || !card.closing) closeLater(card);
  }
}

/** A scroll that takes the trigger from under the pointer closes its card at once. */
function onScroll(e: Event) {
  const scrolled = e.target instanceof Node ? e.target : null;
  let held = false;
  for (const card of [...shown].reverse()) {
    const { trigger, content } = card;
    if (!trigger || !content) continue;
    held ||= inBox(trigger.getBoundingClientRect(), pointer) || inBox(content.getBoundingClientRect(), pointer);
    if (!held && scrolled?.contains(trigger)) close(card);
  }
}

function listen(on: boolean) {
  if (on === listening || typeof document === "undefined") return;
  listening = on;
  if (on) {
    document.addEventListener("pointermove", onMove, { capture: true, passive: true });
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  } else {
    document.removeEventListener("pointermove", onMove, { capture: true });
    document.removeEventListener("scroll", onScroll, { capture: true });
  }
}

/**
 * A card that opens when a mouse or a pen rests `openMs` on its trigger (a touch never opens it, a press or a key
 * does, with `onOpenChange`). It stays open while the pointer crosses from the trigger to it: through the gap between
 * them and over whatever lies in the triangle from where the pointer left the trigger to the card's near edge. Off
 * them, it closes `HOVER_CLOSE_MS` later. One card at a time: resting on another trigger opens that one's card
 * instead, after a short rest, and a scroll that takes the trigger from under the pointer closes it. Cards inside a card (a
 * member's profile in the member list) open beside it. A card a press or a key opened stays until Esc or a press
 * elsewhere, and pins the cards it sits in; while it is up hover opens nothing outside it.
 */
export function useHoverCard(openMs: number): HoverCard {
  const [open, render] = useState<HoverCardOpen>(false);
  const [card] = useState<Card>(() => ({ open: false, openMs, trigger: null, content: null, exit: null, render }));
  useEffect(() => () => close(card), [card]);
  const [handlers] = useState(() => ({
    onOpenChange: (o: boolean) => (o ? press(card) : close(card)),
    close: () => close(card),
    trigger: {
      onPointerEnter: (e: PointerEvent<HTMLElement>) => {
        if (!hoverPointer(e.pointerType) || card.open === "press") return;
        card.trigger = e.currentTarget;
        pointer = { x: e.clientX, y: e.clientY };
        if (card.open === "hover") {
          stopClosing(card);
          card.exit = null;
          return;
        }
        const from = leaving(card);
        // Straight onto another trigger, not over it on the way to an open card: its card takes over after a short
        // rest (a sweep across names opens none), and the open one stays until then.
        if (from && !onItsWay(from)) {
          for (const c of shown.slice(shown.indexOf(from))) stopClosing(c);
          return wait(card, Math.min(card.openMs, HOVER_SWITCH_MS));
        }
        wait(card, from ? Math.max(card.openMs, HOVER_CLOSE_MS) : card.openMs);
      },
      onPointerLeave: (e: PointerEvent<HTMLElement>) => {
        if (!hoverPointer(e.pointerType)) return;
        pointer = { x: e.clientX, y: e.clientY };
        clearTimeout(card.opening);
        card.opening = undefined;
        if (card.open !== "hover") return;
        card.exit = pointer;
        closeLater(card);
      },
      // A press on the trigger of a card hover opened pins it, instead of Radix's toggle closing it.
      onClick: (e: MouseEvent<HTMLElement>) => {
        if (e.defaultPrevented || card.open !== "hover") return;
        e.preventDefault();
        press(card);
      },
    },
    content: {
      ref: (el: HTMLElement | null) => {
        card.content = el;
      },
      // Only holds off the close, never opens: a card the keys opened under a resting mouse would come back after.
      onPointerEnter: (e: PointerEvent<HTMLElement>) => {
        if (!hoverPointer(e.pointerType) || card.open !== "hover") return;
        pointer = { x: e.clientX, y: e.clientY };
        stopClosing(card);
        card.exit = null;
      },
      onPointerLeave: (e: PointerEvent<HTMLElement>) => {
        if (!hoverPointer(e.pointerType) || card.open !== "hover") return;
        pointer = { x: e.clientX, y: e.clientY };
        closeLater(card);
      },
    },
  }));
  return { open, ...handlers };
}
