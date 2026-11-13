import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * Moving cards on a grid of spans (a board's widgets, ADR 0135) with a mouse, a finger or the keyboard. The card lifts
 * as a copy that leans the way it goes, the others slide to their new cells, a pixel well with the card's span marks
 * where it lands, and the drop is handed to the page (`onDrop`), which saves it. The browser's own drag only greys the
 * card out (WebKit often never fires its drop), works on no phone and has no keyboard way, hence pointer events.
 *
 * It has the shape and the feel of the task board's drag (`pages/issue-drag.ts`): the same press, lift, lean, flight,
 * landing and keys, for one grid instead of columns. The two are meant to become one module (ADR 0135).
 *
 * The cards slide (FLIP) on every move under the pointer or the keys, and on a change the page announces with
 * `animateNext` before making it (a resize, a removal): the next render whose order or sizes differ slides from there.
 *
 * What it reads in the page, under `root` (the grid):
 * - `[data-slot="<id>"]`: a cell, in order, its `data-w`/`data-h` its span; `[data-spot]`: the well;
 * - `[data-card]` inside a slot (else its first child): what lifts;
 * - `[data-grip]` inside a slot: the handle; it takes the focus and the keys, and a finger on it needs no hold.
 */

export interface GridItem {
  id: string;
  w: 1 | 2;
  h: 1 | 2;
}

/** A card moved: `index` counts the grid's cards without it, as on screen; `order` is every id after the move. */
export interface GridMove {
  id: string;
  index: number;
  fromIndex: number;
  order: string[];
}

export type GridEntry<T> =
  | { kind: "item"; item: T; state?: "hidden" | "landing" | "picked" }
  | { kind: "spot"; key: string; w: 1 | 2; h: 1 | 2; style: CSSProperties };

interface GridWords<T> {
  picked: (item: T) => string;
  moved: (item: T, position: number, total: number) => string;
  dropped: (item: T, position: number, total: number) => string;
  canceled: (item: T) => string;
}

export interface GridDragOptions<T extends GridItem> {
  /** The cards in the order the data has them. */
  items: T[];
  /** Off (outside Organize): nothing lifts and the page's listeners are off. */
  enabled: boolean;
  /** The page saves the new order; `false` when it took nothing, and the card goes back. */
  onDrop: (move: GridMove) => boolean;
  /** What a screen reader hears. */
  words: GridWords<T>;
}

type Move =
  /** A card under the pointer: hidden in its place, the well where it would land. */
  | { kind: "drag"; id: string; base: string[]; fromIndex: number; index: number; style: CSSProperties }
  /** A card picked with Space or Enter: it moves itself with the arrows until Space, Enter or Esc. */
  | { kind: "pick"; id: string; base: string[]; fromIndex: number; index: number }
  /** Dropped or moved: shown in its new order until the data has it. */
  | { kind: "held"; id: string; order: string[] }
  /** Sent back: hidden in its place until its copy lands there. */
  | { kind: "home"; id: string; base: string[] };

type PickMove = Extract<Move, { kind: "pick" }>;

const HOLD_MS = 260;
const MOUSE_SLOP = 5;
const TOUCH_SLOP = 8;
const FLIP_MS = 240;
const EASE = "cubic-bezier(.2,.8,.2,1)";
const LAND_EASE = "cubic-bezier(.2,.9,.25,1.15)";
/** A move the data never caught up with (a refused save) goes back to what the data says after this. */
const HELD_MS = 4000;
/** A change announced with `animateNext` that never came stops waiting after this. */
const FLIP_WAIT_MS = 3000;
/** After the well moves, the pointer goes this far before it moves again: a wide card doesn't swap back and forth. */
const SETTLE_PX = 14;
/** How close to the scroller's top or bottom edge the page starts scrolling under the card, and how fast at most. */
const EDGE = 64;
const SCROLL_STEP = 14;
/** A card leans up to this many degrees with its speed; a wide one less, the same angle sweeps more. */
const CARD_LEAN = 6;
const LEAN_WIDTH = 280;
const DRAGGING = "wb-dragging";
const KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function animate(el: Element | null | undefined, frames: Keyframe[], options: KeyframeAnimationOptions) {
  const target = el as HTMLElement | null | undefined;
  return target && typeof target.animate === "function" ? target.animate(frames, options) : null;
}

const frame = (run: () => void) =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : window.setTimeout(run, 16);
const cancelFrame = (id: number) =>
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : window.clearTimeout(id);

const inside = (r: DOMRect, x: number, y: number) => x >= r.left && x < r.right && y >= r.top && y < r.bottom;

/** Where an element sits in the layout, without the slide it may be in the middle of. */
function restRect(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  const t = typeof getComputedStyle === "function" ? getComputedStyle(el).transform : "";
  if (!t || t === "none" || typeof DOMMatrixReadOnly !== "function") return r;
  try {
    const m = new DOMMatrixReadOnly(t);
    if (!m.e && !m.f) return r;
    return new DOMRect(r.left - m.e, r.top - m.f, r.width, r.height);
  } catch {
    return r;
  }
}

/** `ids` with `id` taken out and put back at `index` (counted without it). */
function placed(ids: readonly string[], id: string, index: number) {
  const rest = ids.filter((x) => x !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  return rest;
}

/** The element that scrolls the page under the grid (the work area, else the document). */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

interface Press {
  id: string;
  slot: HTMLElement;
  x: number;
  y: number;
  /** A finger off the grip: it waits for a hold, so a swipe still scrolls. */
  hold: boolean;
  timer: number;
}

interface Gesture {
  id: string;
  base: string[];
  fromIndex: number;
  ghost: HTMLElement;
  /** Where the pointer holds the card, from its corner. */
  ox: number;
  oy: number;
  x: number;
  y: number;
  vx: number;
  last: number;
  lean: number;
  still: boolean;
  raf: number;
  index: number;
  /** The cell the pointer was last over when the well moved, and where the pointer was then. */
  over: string | null;
  atX: number;
  atY: number;
  scroller: HTMLElement | null;
}

/** The card's copy that follows the pointer, its size kept (a grid cell stretches it). */
function lift(card: HTMLElement) {
  const rect = card.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = "wb-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.style.width = `${rect.width}px`;
  const clone = card.cloneNode(true) as HTMLElement;
  clone.style.height = `${rect.height}px`;
  clone.style.margin = "0";
  // Canvases don't copy their pixels: each one is drawn again.
  const from = card.querySelectorAll("canvas");
  clone.querySelectorAll("canvas").forEach((canvas, i) => {
    const source = from[i];
    try {
      if (source) canvas.getContext("2d")?.drawImage(source, 0, 0);
    } catch {
      return;
    }
  });
  ghost.append(clone);
  document.body.append(ghost);
  return { ghost, rect };
}

/** The copy flies to `to` and then `done` runs (at once without motion or a place to go). */
function fly(ghost: HTMLElement, to: DOMRect | undefined, ms: number, done: () => void) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  const flight =
    to && !reduced()
      ? animate(
          ghost,
          [
            { transform: ghost.style.transform },
            { transform: `translate(${to.left}px, ${to.top}px) rotate(0deg) scale(1)` },
          ],
          { duration: ms, easing: LAND_EASE, fill: "forwards" },
        )
      : null;
  if (!flight) return finish();
  flight.onfinish = finish;
  flight.oncancel = finish;
  // A tab in the background runs no animation: the drop still lands.
  window.setTimeout(finish, ms + 250);
}

interface EngineContext<T extends GridItem> {
  root: RefObject<HTMLDivElement | null>;
  options: () => GridDragOptions<T>;
  move: () => Move | null;
  setMove: (next: Move | null | ((m: Move | null) => Move | null)) => void;
  say: (text: string) => void;
}

/** Everything that happens outside React's renders: the press, the copy, the page's listeners, the motion. */
function createEngine<T extends GridItem>(ctx: EngineContext<T>) {
  let press: Press | null = null;
  let gesture: Gesture | null = null;
  /** Where the cells were before a change, to slide them from there once a render shows it (`key` is the last one). */
  let flip: { rects: Map<string, DOMRect>; key: string; at: number } | null = null;
  /** The order and sizes on screen at the last render. */
  let shown = "";
  /** What to do once the next render is on screen. */
  let after: (() => void) | null = null;
  /** The slide each cell is in, so a new one starts from where it is. */
  const slides = new WeakMap<Element, Animation>();
  /** The click that ends a drag opens nothing; taken off when it comes, shortly after, or when the screen goes. */
  let swallow: ((e: MouseEvent) => void) | null = null;
  const unswallow = () => {
    if (swallow) document.removeEventListener("click", swallow, true);
    swallow = null;
  };

  const items = () => ctx.options().items;
  const itemOf = (id: string) => items().find((i) => i.id === id);
  /** The order on screen: a move waiting for the data counts. */
  const current = () => {
    const m = ctx.move();
    const ids = items().map((i) => i.id);
    if (m?.kind !== "held") return ids;
    return [...m.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !m.order.includes(id))];
  };
  const slots = () =>
    [...(ctx.root.current?.querySelectorAll<HTMLElement>("[data-slot]") ?? [])].filter((el) => !el.hidden);
  const slotOf = (id: string) =>
    [...(ctx.root.current?.querySelectorAll<HTMLElement>("[data-slot]") ?? [])].find((el) => el.dataset.slot === id);
  const gripOf = (id: string) => slotOf(id)?.querySelector<HTMLElement>("[data-grip]");
  const cardIn = (slot: HTMLElement) =>
    slot.querySelector<HTMLElement>("[data-card]") ?? (slot.firstElementChild as HTMLElement | null);
  const remember = () => {
    flip = {
      rects: new Map(slots().map((el) => [el.dataset.slot ?? "", el.getBoundingClientRect()])),
      key: shown,
      at: Date.now(),
    };
  };
  const refocus = (id: string) => () => gripOf(id)?.focus({ preventScroll: true });

  function start(p: Press, x: number, y: number) {
    const base = current();
    const fromIndex = base.indexOf(p.id);
    const card = cardIn(p.slot);
    if (!card || !p.slot.isConnected || fromIndex < 0) return;
    const { ghost, rect } = lift(card);
    const most = CARD_LEAN * Math.min(1, LEAN_WIDTH / Math.max(1, rect.width));
    const g: Gesture = {
      id: p.id,
      base,
      fromIndex,
      ghost,
      ox: x - rect.left,
      oy: y - rect.top,
      x,
      y,
      vx: 0,
      last: x,
      lean: most,
      still: reduced(),
      raf: 0,
      index: fromIndex,
      over: p.id,
      atX: x,
      atY: y,
      scroller: scrollerOf(ctx.root.current),
    };
    gesture = g;
    document.body.classList.add(DRAGGING);
    const radius = getComputedStyle(card).borderRadius;
    remember();
    ctx.setMove({
      kind: "drag",
      id: p.id,
      base,
      fromIndex,
      index: fromIndex,
      style: { minHeight: rect.height, ...(radius ? { borderRadius: radius } : {}) },
    });
    lean();
    g.raf = frame(tick);
  }

  /** A little weight: the card leans into the way it moves and settles when it stops. */
  function lean() {
    const g = gesture;
    if (!g) return;
    g.vx = g.vx * 0.8 + (g.x - g.last) * 0.2;
    g.last = g.x;
    const f = g.lean / CARD_LEAN;
    const tilt = g.still ? 0 : Math.max(-g.lean, Math.min(g.lean, (g.vx * 0.6 - 1.2) * f));
    const scale = 1 + 0.035 * f;
    g.ghost.style.transform = `translate(${g.x - g.ox}px, ${g.y - g.oy}px) rotate(${tilt}deg) scale(${scale})`;
  }

  function tick() {
    const g = gesture;
    if (!g) return;
    lean();
    // Near the top or the bottom the page scrolls under the card, faster the closer it gets.
    const page = g.scroller;
    if (page) {
      const whole = page === document.scrollingElement;
      const r = page.getBoundingClientRect();
      const top = whole ? 0 : Math.max(0, r.top);
      const low = r.bottom > 0 ? r.bottom : window.innerHeight;
      const bottom = whole ? window.innerHeight : Math.min(window.innerHeight, low);
      const was = page.scrollTop;
      const speed = (gap: number) => Math.max(2, Math.round(SCROLL_STEP * (1 - Math.max(0, gap) / EDGE)));
      if (bottom - top > EDGE * 3) {
        if (g.y > bottom - EDGE) page.scrollTop += speed(bottom - g.y);
        else if (g.y < top + EDGE) page.scrollTop -= speed(g.y - top);
      }
      if (page.scrollTop !== was) place();
    }
    g.raf = frame(tick);
  }

  /**
   * Where the card would land: over another card it takes that card's place (before it going back, after it going
   * on); past the last card, the end; over the well or a gap, where it is.
   */
  function place() {
    const g = gesture;
    const el = ctx.root.current;
    if (!g || !el) return;
    const spot = el.querySelector<HTMLElement>("[data-spot]");
    if (spot && inside(restRect(spot), g.x, g.y)) {
      g.over = null;
      return;
    }
    const others = g.base.filter((id) => id !== g.id);
    const cells = slots();
    const under = cells.find((s) => inside(restRect(s), g.x, g.y));
    let index: number;
    let over: string | null = null;
    if (under) {
      over = under.dataset.slot ?? null;
      if (!over || over === g.over) return;
      const j = others.indexOf(over);
      if (j < 0) return;
      index = j >= g.index ? j + 1 : j;
    } else {
      const lastId = others.at(-1);
      const last = lastId ? slotOf(lastId) : null;
      if (!last) return;
      const r = restRect(last);
      const bottom = Math.max(r.bottom, ...cells.map((s) => restRect(s).bottom));
      const past = g.y >= bottom || (g.y >= r.top && g.y < r.bottom && g.x >= r.right);
      if (!past) return;
      index = others.length;
    }
    if (index === g.index) {
      g.over = over;
      return;
    }
    // Right after the well moved the cells are still sliding: wait for the pointer to go on a little.
    if (Math.hypot(g.x - g.atX, g.y - g.atY) < SETTLE_PX) return;
    g.over = over;
    g.index = index;
    g.atX = g.x;
    g.atY = g.y;
    remember();
    ctx.setMove((m) => (m?.kind === "drag" && m.id === g.id ? { ...m, index } : m));
  }

  function end(cancel: boolean) {
    const g = gesture;
    if (!g) return;
    gesture = null;
    cancelFrame(g.raf);
    document.body.classList.remove(DRAGGING);
    if (cancel || g.index === g.fromIndex) return home(g);
    const spot = ctx.root.current?.querySelector<HTMLElement>("[data-spot]")?.getBoundingClientRect();
    fly(g.ghost, spot, 220, () => commit(g, spot));
  }

  /** Back where it was: the others close the gap, the copy flies home, the card shows once it lands. */
  function home(g: Gesture) {
    remember();
    if (reduced()) {
      g.ghost.remove();
      ctx.setMove(null);
      return;
    }
    ctx.setMove({ kind: "home", id: g.id, base: g.base });
    after = () => {
      const slot = slotOf(g.id);
      const card = slot ? cardIn(slot) : null;
      fly(g.ghost, card?.getBoundingClientRect(), 260, () => {
        g.ghost.remove();
        ctx.setMove((m) => (m?.kind === "home" && m.id === g.id ? null : m));
      });
    };
  }

  function commit(g: Gesture, spot: DOMRect | undefined) {
    g.ghost.remove();
    remember();
    if (spot) flip?.rects.set(g.id, spot);
    const order = placed(g.base, g.id, g.index);
    const taken =
      itemOf(g.id) !== undefined && ctx.options().onDrop({ id: g.id, index: g.index, fromIndex: g.fromIndex, order });
    ctx.setMove(taken ? { kind: "held", id: g.id, order } : null);
    after = () => landed(g.id);
  }

  /** The card settles with a small bounce, its grip in focus. */
  function landed(id: string) {
    refocus(id)();
    const slot = slotOf(id);
    const card = slot ? cardIn(slot) : null;
    if (!card || reduced()) return;
    animate(card, [{ transform: "scale(1.03)" }, { transform: "scale(.99)" }, { transform: "none" }], {
      duration: 380,
      easing: EASE,
    });
  }

  // ── Keyboard: the grip's arrows move the card; Space or Enter picks it up, the arrows carry it, Space or Enter
  //    drops it, Esc puts it back ──

  /** The place an arrow leads to: Left and Right one card, Up and Down the card above or below in the grid. */
  function stepIndex(base: string[], id: string, index: number, key: string) {
    const others = base.filter((x) => x !== id);
    const forward = key === "ArrowRight" || key === "ArrowDown";
    const one = Math.max(0, Math.min(others.length, index + (forward ? 1 : -1)));
    if (key === "ArrowLeft" || key === "ArrowRight") return one;
    const own = slotOf(id);
    const r = own ? restRect(own) : null;
    // Nothing laid out (a hidden board): one card.
    if (!r?.width || !r.height) return one;
    const cx = r.left + r.width / 2;
    const row = others
      .map((x, j) => {
        const slot = slotOf(x);
        return { j, r: slot ? restRect(slot) : null };
      })
      .filter((c): c is { j: number; r: DOMRect } =>
        c.r ? (forward ? c.r.top >= r.bottom - 1 : c.r.bottom <= r.top + 1) : false,
      );
    if (!row.length) return index;
    // The nearest row that way, then the card in it nearest across.
    const edge = forward ? Math.min(...row.map((c) => c.r.top)) : Math.max(...row.map((c) => c.r.bottom));
    const near = row
      .filter((c) => Math.abs((forward ? c.r.top : c.r.bottom) - edge) < 4)
      .sort((a, b) => Math.abs(a.r.left + a.r.width / 2 - cx) - Math.abs(b.r.left + b.r.width / 2 - cx))[0];
    if (!near) return index;
    return near.j >= index ? near.j + 1 : near.j;
  }

  function say(id: string, word: "moved" | "dropped", order: string[]) {
    const item = itemOf(id);
    if (item) ctx.say(ctx.options().words[word](item, order.indexOf(id) + 1, order.length));
  }

  function step(m: PickMove, key: string) {
    const index = stepIndex(m.base, m.id, m.index, key);
    if (index === m.index) return;
    remember();
    ctx.setMove({ ...m, index });
    after = refocus(m.id);
    say(m.id, "moved", placed(m.base, m.id, index));
  }

  function dropPick(m: PickMove) {
    const order = placed(m.base, m.id, m.index);
    say(m.id, "dropped", order);
    if (m.index === m.fromIndex) {
      ctx.setMove(null);
      after = refocus(m.id);
      return;
    }
    remember();
    const taken = ctx.options().onDrop({ id: m.id, index: m.index, fromIndex: m.fromIndex, order });
    ctx.setMove(taken ? { kind: "held", id: m.id, order } : null);
    after = () => landed(m.id);
  }

  function cancelPick(m: PickMove, back: boolean) {
    remember();
    ctx.setMove(null);
    if (back) after = refocus(m.id);
    const item = itemOf(m.id);
    if (item) ctx.say(ctx.options().words.canceled(item));
  }

  return {
    remember,

    pointerDown(e: ReactPointerEvent<HTMLElement>, item: T) {
      const m = ctx.move();
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || gesture) return;
      if (m && m.kind !== "held") return;
      const target = e.target instanceof Element ? e.target : null;
      const onGrip = Boolean(target?.closest("[data-grip]"));
      if (!onGrip && target?.closest("button, a, input, textarea, select, [role='menuitem']")) return;
      if (press) window.clearTimeout(press.timer);
      const p: Press = {
        id: item.id,
        slot: e.currentTarget,
        x: e.clientX,
        y: e.clientY,
        hold: e.pointerType === "touch" && !onGrip,
        timer: 0,
      };
      press = p;
      // On a finger, a hold picks the card up; a quick swipe still scrolls the page. The grip lifts at once.
      if (p.hold)
        p.timer = window.setTimeout(() => {
          if (press !== p) return;
          press = null;
          navigator.vibrate?.(8);
          start(p, p.x, p.y);
        }, HOLD_MS);
    },

    keyDown(e: ReactKeyboardEvent<HTMLElement>, item: T) {
      if (e.repeat && !KEYS.includes(e.key)) return;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || gesture) return;
      const m = ctx.move();
      if (m && m.kind !== "held") return;
      const base = current();
      const fromIndex = base.indexOf(item.id);
      if (fromIndex < 0) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        ctx.setMove({ kind: "pick", id: item.id, base, fromIndex, index: fromIndex });
        ctx.say(ctx.options().words.picked(item));
        return;
      }
      if (!KEYS.includes(e.key)) return;
      e.preventDefault();
      // Not picked up: each arrow is a move of its own, saved at once.
      const index = stepIndex(base, item.id, fromIndex, e.key);
      if (index === fromIndex) return;
      const order = placed(base, item.id, index);
      remember();
      if (!ctx.options().onDrop({ id: item.id, index, fromIndex, order })) return;
      ctx.setMove({ kind: "held", id: item.id, order });
      after = refocus(item.id);
      say(item.id, "moved", order);
    },

    /** The page's listeners while Organize is on; the returned function takes them off. */
    attach() {
      const onMove = (e: PointerEvent) => {
        if (gesture) {
          gesture.x = e.clientX;
          gesture.y = e.clientY;
          lean();
          place();
          return;
        }
        const p = press;
        if (!p) return;
        const distance = Math.hypot(e.clientX - p.x, e.clientY - p.y);
        if (p.hold) {
          if (distance > TOUCH_SLOP) {
            window.clearTimeout(p.timer);
            press = null;
          }
          return;
        }
        if (distance > MOUSE_SLOP) {
          press = null;
          // The card lifts where the pointer is now: start places the gesture at these coordinates.
          start(p, e.clientX, e.clientY);
        }
      };
      const onUp = () => {
        if (press) window.clearTimeout(press.timer);
        press = null;
        if (!gesture) return;
        end(false);
        unswallow();
        // Only the click that ends the drag, on the board: a click elsewhere goes through.
        const stop = (e: MouseEvent) => {
          const on = e.target instanceof Node && ctx.root.current?.contains(e.target);
          unswallow();
          if (!on) return;
          e.preventDefault();
          e.stopPropagation();
        };
        swallow = stop;
        document.addEventListener("click", stop, true);
        window.setTimeout(() => {
          if (swallow === stop) unswallow();
        }, 60);
      };
      const onCancel = () => {
        if (press) window.clearTimeout(press.timer);
        press = null;
        if (gesture) end(true);
      };
      // A press anywhere but on the picked card puts it back.
      const onDown = (e: PointerEvent) => {
        const m = ctx.move();
        if (m?.kind !== "pick") return;
        if (!(e.target instanceof Node && slotOf(m.id)?.contains(e.target))) cancelPick(m, false);
      };
      const onKey = (e: KeyboardEvent) => {
        if (gesture) {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          return end(true);
        }
        const m = ctx.move();
        if (m?.kind !== "pick") return;
        if (e.key === "Tab") return cancelPick(m, false);
        if (![...KEYS, " ", "Enter", "Escape"].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") cancelPick(m, true);
        else if (e.key === " " || e.key === "Enter") {
          if (!e.repeat) dropPick(m);
        } else step(m, e.key);
      };
      // While a card is held, a finger moves it instead of the page, and a long press opens no menu.
      const onTouch = (e: TouchEvent) => {
        if (gesture) e.preventDefault();
      };
      const onMenu = (e: Event) => {
        if (gesture || press?.hold) e.preventDefault();
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onCancel);
      document.addEventListener("pointerdown", onDown, true);
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("touchmove", onTouch, { passive: false });
      document.addEventListener("contextmenu", onMenu, true);
      window.addEventListener("blur", onCancel);
      return () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        document.removeEventListener("pointerdown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("touchmove", onTouch);
        document.removeEventListener("contextmenu", onMenu, true);
        window.removeEventListener("blur", onCancel);
        unswallow();
        if (press) window.clearTimeout(press.timer);
        press = null;
        const g = gesture;
        gesture = null;
        if (g) {
          cancelFrame(g.raf);
          g.ghost.remove();
          document.body.classList.remove(DRAGGING);
        }
        const m = ctx.move();
        if (m && m.kind !== "held") ctx.setMove(null);
      };
    },

    /**
     * After each render, before it paints: when the order or a size changed since `remember`, the cells slide (and
     * grow) from where they were; then what waited for the render runs.
     */
    settle(move: Move | null, key: string) {
      shown = key;
      const before = flip;
      if (before && (before.key !== key || Date.now() - before.at > FLIP_WAIT_MS)) flip = null;
      if (before && before.key !== key && !reduced()) {
        for (const el of slots()) {
          const b = before.rects.get(el.dataset.slot ?? "");
          if (!b) continue;
          slides.get(el)?.cancel();
          const a = el.getBoundingClientRect();
          const dx = b.left - a.left;
          const dy = b.top - a.top;
          const sx = a.width ? b.width / a.width : 1;
          const sy = a.height ? b.height / a.height : 1;
          const grew = Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01;
          if (!dx && !dy && !grew) continue;
          const from = grew
            ? { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: "0 0", opacity: 0.7 }
            : { transform: `translate(${dx}px, ${dy}px)` };
          const to = grew ? { transform: "none", transformOrigin: "0 0", opacity: 1 } : { transform: "none" };
          const slide = animate(el, [from, to], { duration: grew ? FLIP_MS + 60 : FLIP_MS, easing: EASE });
          if (slide) slides.set(el, slide);
        }
        animate(
          ctx.root.current?.querySelector("[data-spot]"),
          [
            { opacity: 0, transform: "scale(.94)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 180, easing: "ease-out" },
        );
      }
      const then = after;
      after = null;
      then?.();
      // A move waits in its order until the data has it.
      if (move?.kind === "held") {
        const ids = items().map((i) => i.id);
        if (ids.join(",") === move.order.filter((id) => ids.includes(id)).join(","))
          ctx.setMove((m) => (m === move ? null : m));
      }
    },

    /** A move the data never takes (a refused save) stops waiting, and the cards slide back. */
    hold(move: Move | null) {
      if (move?.kind !== "held") return;
      const timer = window.setTimeout(() => {
        remember();
        ctx.setMove((m) => (m === move ? null : m));
      }, HELD_MS);
      return () => window.clearTimeout(timer);
    },
  };
}

/**
 * The page's side: what each cell shows while a card moves (`entries`), the props of a cell (`cell`) and of its grip
 * (`grip`), the line a screen reader hears (`live`), and `animateNext` before a change of the page's own.
 */
export function useGridDrag<T extends GridItem>(options: GridDragOptions<T>) {
  const root = useRef<HTMLDivElement>(null);
  const [move, setMove] = useState<Move | null>(null);
  const [live, setLive] = useState("");
  const moveRef = useRef(move);
  moveRef.current = move;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [engine] = useState(() =>
    createEngine<T>({
      root,
      options: () => optionsRef.current,
      move: () => moveRef.current,
      // Known at once, before React renders it: two quick keys or a press right after a pick see the latest move.
      setMove: (next) => {
        const value = typeof next === "function" ? next(moveRef.current) : next;
        moveRef.current = value;
        setMove(value);
      },
      say: setLive,
    }),
  );
  const { enabled, items } = options;
  useEffect(() => (enabled ? engine.attach() : undefined), [engine, enabled]);

  const byId = new Map(items.map((i) => [i.id, i]));
  const ordered = (ids: readonly string[]) => [
    ...ids.flatMap((id) => byId.get(id) ?? []),
    ...items.filter((i) => !ids.includes(i.id)),
  ];
  const entries: GridEntry<T>[] = (() => {
    const m = move;
    const card = (item: T, state?: "hidden" | "landing" | "picked"): GridEntry<T> => ({ kind: "item", item, state });
    if (!m) return items.map((i) => card(i));
    if (m.kind === "held") return ordered(m.order).map((i) => card(i));
    if (m.kind === "home") return ordered(m.base).map((i) => card(i, i.id === m.id ? "landing" : undefined));
    if (m.kind === "pick")
      return ordered(placed(m.base, m.id, m.index)).map((i) => card(i, i.id === m.id ? "picked" : undefined));
    // Under the pointer: the card hidden in its place, the well with its span where it would land.
    const dragged = byId.get(m.id);
    const spot: GridEntry<T> = {
      kind: "spot",
      key: "spot",
      w: dragged?.w ?? 1,
      h: dragged?.h ?? 1,
      style: m.style,
    };
    const out: GridEntry<T>[] = [];
    let k = 0;
    for (const i of ordered(m.base)) {
      if (i.id === m.id) {
        out.push(card(i, "hidden"));
        continue;
      }
      if (k === m.index) out.push(spot);
      out.push(card(i));
      k++;
    }
    if (m.index >= k) out.push(spot);
    return out;
  })();
  const key = entries
    .map((e) =>
      e.kind === "spot" ? `spot:${e.w}${e.h}` : `${e.item.id}:${e.item.w}${e.item.h}${e.state === "hidden" ? "-" : ""}`,
    )
    .join(",");
  useLayoutEffect(() => engine.settle(move, key));
  useEffect(() => engine.hold(move), [engine, move]);

  const moving = move?.kind === "drag" || move?.kind === "pick" ? move : null;
  return {
    root,
    entries,
    /** A card is moving (under the pointer or picked up). */
    active: moving !== null,
    live,
    /** Before a change of the page's own (a resize, a removal): the cells slide when it shows. */
    animateNext: () => engine.remember(),
    cell: (item: T) =>
      enabled
        ? {
            draggable: false as const,
            onDragStart: (e: ReactDragEvent) => e.preventDefault(),
            onPointerDown: (e: ReactPointerEvent<HTMLElement>) => engine.pointerDown(e, item),
          }
        : {},
    grip: (item: T) => ({
      "data-grip": "",
      onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => engine.keyDown(e, item),
    }),
  };
}

export type GridDrag<T extends GridItem> = ReturnType<typeof useGridDrag<T>>;
