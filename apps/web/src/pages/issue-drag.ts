import { bodyTones } from "@agenteschat/ui";
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
 * Moving tasks on Tarefas (the board's columns, the list's groups) with a mouse, a finger or the keyboard. The card
 * lifts as a copy that leans the way it goes, the others make room for it, a pixel well in its size marks where it
 * lands, and the drop is handed to the page (`onDrop`), which saves it. The native drag of the browser only greys the
 * card out and draws a line, works on no phone and has no keyboard way, hence pointer events.
 *
 * What it reads in the page, under `root`:
 * - `[data-drop="<group>"]`: where cards land; its `[data-slot="<id>"]` elements are the cards, in order;
 * - `[data-col]` around a drop zone: the box the pointer is measured against (a column, a group of the list);
 * - `[data-card]` inside a slot: what lifts and what gets the focus;
 * - `[data-count="<group>"]`: a group's count, which pops when a card arrives or leaves.
 */

export interface DragGroup<T> {
  id: string;
  items: T[];
}

/** A card dropped somewhere: `index` counts the destination's cards without it, as on screen. */
export interface CardMove {
  id: string;
  from: string;
  to: string;
  index: number;
  fromIndex: number;
}

/**
 * What the page did with a drop. `changed: false` sends the card back where the data has it. `burst`: a card that got
 * done gives off a few pixels, in its agent's color (a color name) or neutral (`null`).
 */
export interface DropResult {
  changed: boolean;
  burst?: string | null;
}

export type DragEntry<T> =
  | { kind: "card"; item: T; state?: "hidden" | "landing" | "picked" }
  | { kind: "spot"; key: string; style: CSSProperties };

interface DragWords<T> {
  picked: (item: T) => string;
  moved: (item: T, group: string, position: number, total: number) => string;
  dropped: (item: T, group: string) => string;
  canceled: (item: T) => string;
}

export interface IssueDragOptions<T extends { id: string }> {
  /** The groups on screen in order (the board's columns left to right, the list's groups top to bottom). */
  groups: DragGroup<T>[];
  /** On the board Left and Right go across groups; in the list Up and Down go on into the next one. */
  layout: "board" | "list";
  onDrop: (move: CardMove) => DropResult;
  /** What a screen reader hears. */
  words: DragWords<T>;
}

type Move =
  /** A card under the pointer: it stays in its place hidden, the well where it would land. */
  | { kind: "drag"; id: string; from: string; fromIndex: number; to: string; index: number; style: CSSProperties }
  /** A card picked with Space: it moves itself with the arrows until Space, Enter or Esc. */
  | { kind: "pick"; id: string; from: string; fromIndex: number; to: string; index: number }
  /** Dropped: shown where it fell until the data has its move. */
  | { kind: "held"; id: string; to: string; index: number; item: unknown }
  /** Sent back: hidden in its place until its copy lands there. */
  | { kind: "home"; id: string };

type PickMove = Extract<Move, { kind: "pick" }>;

const HOLD_MS = 260;
const MOUSE_SLOP = 5;
const TOUCH_SLOP = 8;
const FLIP_MS = 200;
const EASE = "cubic-bezier(.2,.8,.2,1)";
const LAND_EASE = "cubic-bezier(.2,.9,.25,1.15)";
/** A dropped card the data never caught up with (a refused save) goes back to what the data says after this. */
const HELD_MS = 4000;
/** How close to an edge the board (sideways) or the page (up and down) starts scrolling under the card. */
const EDGE = 60;
const SCROLL_STEP = 12;
/** A card leans up to this many degrees with its speed; a wide row much less, the same angle sweeps the page. */
const CARD_LEAN = 6;
const ROW_LEAN = 1.2;
const DRAGGING = "issues-dragging";

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function animate(el: Element | null | undefined, frames: Keyframe[], options: KeyframeAnimationOptions) {
  const target = el as HTMLElement | null | undefined;
  return target && typeof target.animate === "function" ? target.animate(frames, options) : null;
}

const frame = (run: () => void) =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : window.setTimeout(run, 16);
const cancelFrame = (id: number) =>
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : window.clearTimeout(id);

interface Press {
  id: string;
  group: string;
  card: HTMLElement;
  x: number;
  y: number;
  touch: boolean;
  timer: number;
}

interface Gesture {
  id: string;
  from: string;
  fromIndex: number;
  ghost: HTMLElement;
  /** Where the pointer holds the card, from its corner. */
  ox: number;
  oy: number;
  x: number;
  y: number;
  left0: number;
  vx: number;
  last: number;
  row: boolean;
  still: boolean;
  raf: number;
  to: string;
  index: number;
}

/** The card's copy that follows the pointer (a list row inside a list of its own, so it keeps its grid). */
function lift(card: HTMLElement, row: boolean) {
  const rect = card.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = "issue-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.style.width = `${rect.width}px`;
  const clone = card.cloneNode(true) as HTMLElement;
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
  if (row) {
    const list = document.createElement("ul");
    list.className = "issue-list";
    const item = document.createElement("li");
    item.append(clone);
    list.append(item);
    ghost.append(list);
  } else ghost.append(clone);
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

/** A card that got done gives off a few pixels from its edges, in its agent's tones or the ink's. */
export function pixelBurst(el: HTMLElement, color: string | null) {
  const r = el.getBoundingClientRect();
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  if (!g) return;
  const pad = 40;
  const w = r.width + pad * 2;
  const h = r.height + pad * 2;
  canvas.width = w * 2;
  canvas.height = h * 2;
  canvas.className = "issue-burst";
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    left: `${r.left - pad}px`,
    top: `${r.top - pad}px`,
    width: `${w}px`,
    height: `${h}px`,
  });
  const css = getComputedStyle(el);
  const tones = color
    ? bodyTones(color)
    : ["--ink", "--ink2", "--muted", "--faint"].map((v) => css.getPropertyValue(v).trim() || "#6f6f6a");
  const pixels = Array.from({ length: 18 }, (_, i) => {
    const edge = i % 4;
    const u = Math.random();
    const x = edge === 0 || edge === 2 ? pad + u * r.width : edge === 1 ? pad + r.width : pad;
    const y = edge === 1 || edge === 3 ? pad + u * r.height : edge === 2 ? pad + r.height : pad;
    const a = Math.atan2(y - h / 2, x - w / 2) + (Math.random() - 0.5) * 0.6;
    const speed = 1.2 + Math.random() * 1.6;
    return {
      x,
      y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - 0.4,
      color: tones[(i % 3) + 1] ?? tones[0] ?? "#6f6f6a",
      size: Math.random() < 0.5 ? 3 : 4,
    };
  });
  document.body.append(canvas);
  let f = 0;
  const step = () => {
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.globalAlpha = Math.max(0, 1 - f / 34);
    for (const p of pixels) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.06;
      g.fillStyle = p.color;
      g.fillRect(Math.round(p.x) * 2, Math.round(p.y) * 2, p.size * 2, p.size * 2);
    }
    if (++f < 36) frame(step);
    else canvas.remove();
  };
  frame(step);
}

interface EngineContext<T extends { id: string }> {
  root: RefObject<HTMLDivElement | null>;
  options: () => IssueDragOptions<T>;
  move: () => Move | null;
  setMove: (next: Move | null | ((m: Move | null) => Move | null)) => void;
  say: (text: string) => void;
}

/** Everything that happens outside React's renders: the press, the copy, the page's listeners, the motion. */
function createEngine<T extends { id: string }>(ctx: EngineContext<T>) {
  let press: Press | null = null;
  let gesture: Gesture | null = null;
  /** Where the cards were before the next render, to slide them from there. */
  let flip: Map<string, DOMRect> | null = null;
  /** What to do once the next render is on screen. */
  let after: (() => void) | null = null;
  /** The click that ends a drag opens nothing; taken off when it comes, shortly after, or when the screen goes. */
  let swallow: ((e: MouseEvent) => void) | null = null;
  const unswallow = () => {
    if (swallow) document.removeEventListener("click", swallow, true);
    swallow = null;
  };

  const groups = () => ctx.options().groups;
  const itemOf = (id: string) => {
    for (const g of groups()) {
      const item = g.items.find((i) => i.id === id);
      if (item) return item;
    }
    return undefined;
  };
  const itemsOf = (group: string) => groups().find((g) => g.id === group)?.items ?? [];
  const othersIn = (group: string, id: string) => itemsOf(group).filter((i) => i.id !== id);
  const indexIn = (group: string, id: string) => itemsOf(group).findIndex((i) => i.id === id);
  const slots = () =>
    [...(ctx.root.current?.querySelectorAll<HTMLElement>("[data-slot]") ?? [])].filter((el) => !el.hidden);
  const rects = () => new Map(slots().map((el) => [el.dataset.slot ?? "", el.getBoundingClientRect()]));
  const remember = () => {
    flip = rects();
  };
  const cardOf = (id: string) => ctx.root.current?.querySelector<HTMLElement>(`[data-slot="${id}"] [data-card]`);

  function start(p: Press, x: number, y: number) {
    const slot = p.card.closest<HTMLElement>("[data-slot]");
    const fromIndex = indexIn(p.group, p.id);
    if (!slot || !p.card.isConnected || fromIndex < 0) return;
    const row = slot.tagName === "LI";
    const { ghost, rect } = lift(p.card, row);
    const g: Gesture = {
      id: p.id,
      from: p.group,
      fromIndex,
      ghost,
      ox: x - rect.left,
      oy: y - rect.top,
      x,
      y,
      left0: rect.left,
      vx: 0,
      last: row ? y : x,
      row,
      still: reduced(),
      raf: 0,
      to: p.group,
      index: fromIndex,
    };
    gesture = g;
    document.body.classList.add(DRAGGING);
    const radius = getComputedStyle(p.card).borderRadius;
    ctx.setMove({
      kind: "drag",
      id: p.id,
      from: p.group,
      fromIndex,
      to: p.group,
      index: fromIndex,
      style: { height: rect.height, ...(radius && !row ? { borderRadius: radius } : {}) },
    });
    lean();
    g.raf = frame(tick);
  }

  /** A little weight: the card leans into the way it moves and settles when it stops. */
  function lean() {
    const g = gesture;
    if (!g) return;
    const at = g.row ? g.y : g.x;
    g.vx = g.vx * 0.8 + (at - g.last) * 0.2;
    g.last = at;
    const most = g.row ? ROW_LEAN : CARD_LEAN;
    const tilt = g.still ? 0 : Math.max(-most, Math.min(most, g.vx * (g.row ? 0.1 : 0.6) - (g.row ? 0.3 : 1.2)));
    // A row only goes up and down: sideways means nothing in a list.
    const x = g.row ? g.left0 : g.x - g.ox;
    const scale = g.row ? 1.01 : 1.035;
    g.ghost.style.transform = `translate(${x}px, ${g.y - g.oy}px) rotate(${tilt}deg) scale(${scale})`;
  }

  function tick() {
    const g = gesture;
    if (!g) return;
    lean();
    // Near an edge the board (or the page) scrolls under the card.
    const el = ctx.root.current;
    let scrolled = false;
    const board = el?.querySelector<HTMLElement>(".issues-boardwrap");
    if (board) {
      const r = board.getBoundingClientRect();
      const was = board.scrollLeft;
      if (r.width > 0 && g.x > r.right - EDGE) board.scrollLeft += SCROLL_STEP;
      else if (r.width > 0 && g.x < r.left + EDGE) board.scrollLeft -= SCROLL_STEP;
      scrolled ||= board.scrollLeft !== was;
    }
    // A column whose cards scroll on their own (a board that fills the window) scrolls under the card near its ends.
    for (const list of el?.querySelectorAll<HTMLElement>(".issues-col__cards") ?? []) {
      if (list.scrollHeight <= list.clientHeight) continue;
      const r = list.getBoundingClientRect();
      if (g.x < r.left || g.x > r.right || g.y < r.top || g.y > r.bottom) continue;
      const was = list.scrollTop;
      // A third of a short column at most at each end, so its middle stays a place to drop.
      const edge = Math.min(EDGE, r.height / 3);
      if (g.y > r.bottom - edge) list.scrollTop += SCROLL_STEP;
      else if (g.y < r.top + edge) list.scrollTop -= SCROLL_STEP;
      scrolled ||= list.scrollTop !== was;
    }
    const page = el?.closest<HTMLElement>(".shell__main");
    if (page) {
      const r = page.getBoundingClientRect();
      const was = page.scrollTop;
      const top = Math.max(0, r.top);
      const bottom = Math.min(window.innerHeight, r.bottom > 0 ? r.bottom : window.innerHeight);
      if (g.y > bottom - EDGE) page.scrollTop += SCROLL_STEP;
      else if (g.y < top + EDGE) page.scrollTop -= SCROLL_STEP;
      scrolled ||= page.scrollTop !== was;
    }
    if (scrolled) place();
    g.raf = frame(tick);
  }

  /** The group nearest the pointer, and the place in it: before the first card whose middle is below. */
  function place() {
    const g = gesture;
    const el = ctx.root.current;
    if (!g || !el) return;
    let best: HTMLElement | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const zone of el.querySelectorAll<HTMLElement>("[data-drop]")) {
      const r = (zone.closest<HTMLElement>("[data-col]") ?? zone).getBoundingClientRect();
      const dx = g.x < r.left ? r.left - g.x : g.x > r.right ? g.x - r.right : 0;
      const dy = g.y < r.top ? r.top - g.y : g.y > r.bottom ? g.y - r.bottom : 0;
      // Sideways counts more: on the board the column under the pointer wins over the one below it.
      const distance = dx * 3 + dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = zone;
      }
    }
    if (!best) return;
    const to = best.dataset.drop ?? "";
    const cards = [...best.querySelectorAll<HTMLElement>("[data-slot]")].filter((s) => !s.hidden);
    const k = cards.findIndex((s) => {
      const r = s.getBoundingClientRect();
      return g.y < r.top + r.height / 2;
    });
    const index = k < 0 ? cards.length : k;
    if (to === g.to && index === g.index) return;
    g.to = to;
    g.index = index;
    remember();
    ctx.setMove((m) => (m?.kind === "drag" && m.id === g.id ? { ...m, to, index } : m));
  }

  function end(cancel: boolean) {
    const g = gesture;
    if (!g) return;
    gesture = null;
    cancelFrame(g.raf);
    document.body.classList.remove(DRAGGING);
    if (cancel || (g.to === g.from && g.index === g.fromIndex)) return home(g);
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
    ctx.setMove({ kind: "home", id: g.id });
    after = () =>
      fly(g.ghost, cardOf(g.id)?.getBoundingClientRect(), 260, () => {
        g.ghost.remove();
        ctx.setMove((m) => (m?.kind === "home" && m.id === g.id ? null : m));
      });
  }

  function commit(g: Gesture, spot: DOMRect | undefined) {
    g.ghost.remove();
    const before = rects();
    if (spot) before.set(g.id, spot);
    flip = before;
    const item = itemOf(g.id);
    const result = item
      ? ctx.options().onDrop({ id: g.id, from: g.from, to: g.to, index: g.index, fromIndex: g.fromIndex })
      : { changed: false };
    ctx.setMove(result.changed && item ? { kind: "held", id: g.id, to: g.to, index: g.index, item } : null);
    after = () => landed(g.id, g.from, g.to, result);
  }

  /** The card settles with a small bounce, the counts pop, a task done gives off its pixels. */
  function landed(id: string, from: string, to: string, result: DropResult) {
    const card = cardOf(id);
    card?.focus({ preventScroll: true });
    if (!card || reduced()) return;
    animate(card, [{ transform: "scale(1.03)" }, { transform: "scale(.99)" }, { transform: "none" }], {
      duration: 380,
      easing: EASE,
    });
    if (result.changed && from !== to) for (const group of [from, to]) bump(group);
    if (result.burst !== undefined) pixelBurst(card, result.burst);
  }

  function bump(group: string) {
    for (const el of ctx.root.current?.querySelectorAll(`[data-count="${group}"]`) ?? [])
      animate(el, [{ transform: "scale(1)" }, { transform: "scale(1.45)" }, { transform: "scale(1)" }], {
        duration: 360,
        easing: EASE,
      });
  }

  // ── Keyboard: Space picks the card up, the arrows move it, Space or Enter drops it, Esc puts it back ──

  function step(m: PickMove, key: string) {
    const { groups: list, layout, words } = ctx.options();
    const at = list.findIndex((g) => g.id === m.to);
    const room = (group: string) => othersIn(group, m.id).length;
    const forward = key === "ArrowDown" || key === "ArrowRight";
    let to = m.to;
    let index = m.index;
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const next = layout === "board" ? list[at + (forward ? 1 : -1)] : undefined;
      if (!next) return;
      to = next.id;
      index = Math.min(m.index, room(next.id));
    } else {
      if (forward ? m.index < room(m.to) : m.index > 0) index = m.index + (forward ? 1 : -1);
      else {
        const next = layout === "list" ? list[at + (forward ? 1 : -1)] : undefined;
        if (!next) return;
        to = next.id;
        index = forward ? 0 : room(next.id);
      }
    }
    remember();
    ctx.setMove({ ...m, to, index });
    after = () => cardOf(m.id)?.focus();
    const item = itemOf(m.id);
    if (item) ctx.say(words.moved(item, to, index + 1, room(to) + 1));
  }

  function dropPick(m: PickMove) {
    const { words, onDrop } = ctx.options();
    const item = itemOf(m.id);
    if (!item) return ctx.setMove(null);
    ctx.say(words.dropped(item, m.to));
    if (m.to === m.from && m.index === m.fromIndex) {
      ctx.setMove(null);
      return;
    }
    remember();
    const result = onDrop({ id: m.id, from: m.from, to: m.to, index: m.index, fromIndex: m.fromIndex });
    ctx.setMove(result.changed ? { kind: "held", id: m.id, to: m.to, index: m.index, item } : null);
    after = () => landed(m.id, m.from, m.to, result);
  }

  function cancelPick(m: PickMove, refocus: boolean) {
    remember();
    ctx.setMove(null);
    if (refocus) after = () => cardOf(m.id)?.focus();
    const item = itemOf(m.id);
    if (item) ctx.say(ctx.options().words.canceled(item));
  }

  return {
    pointerDown(e: ReactPointerEvent<HTMLElement>, item: T, group: string) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || ctx.move() || gesture) return;
      if (e.target instanceof Element && e.target.closest("button, input, textarea, select")) return;
      if (press) window.clearTimeout(press.timer);
      const p: Press = {
        id: item.id,
        group,
        card: e.currentTarget,
        x: e.clientX,
        y: e.clientY,
        touch: e.pointerType === "touch",
        timer: 0,
      };
      press = p;
      // On a finger, a hold picks the card up; a quick swipe still scrolls the board.
      if (p.touch)
        p.timer = window.setTimeout(() => {
          if (press !== p) return;
          press = null;
          navigator.vibrate?.(8);
          start(p, p.x, p.y);
        }, HOLD_MS);
    },

    keyDown(e: ReactKeyboardEvent<HTMLElement>, item: T, group: string) {
      if (e.key !== " " || e.repeat || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (ctx.move() || gesture) return;
      const fromIndex = indexIn(group, item.id);
      if (fromIndex < 0) return;
      e.preventDefault();
      ctx.setMove({ kind: "pick", id: item.id, from: group, fromIndex, to: group, index: fromIndex });
      ctx.say(ctx.options().words.picked(item));
    },

    /** The page's listeners while the screen is open; the returned function takes them off. */
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
        if (p.touch) {
          if (distance > TOUCH_SLOP) {
            window.clearTimeout(p.timer);
            press = null;
          }
          return;
        }
        if (distance > MOUSE_SLOP) {
          press = null;
          start(p, e.clientX, e.clientY);
        }
      };
      const onUp = () => {
        if (press) window.clearTimeout(press.timer);
        press = null;
        if (!gesture) return;
        end(false);
        unswallow();
        // Only the click that ends the drag, on the board or the list: a click elsewhere (the toast's Desfazer)
        // goes through.
        const stop = (e: MouseEvent) => {
          const on = e.target instanceof Element && e.target.closest(".issues-boardwrap, .issues-groups");
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
        if (!(e.target instanceof Node && cardOf(m.id)?.contains(e.target))) cancelPick(m, false);
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
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter", "Escape"].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") cancelPick(m, true);
        else if (e.key === " " || e.key === "Enter") dropPick(m);
        else step(m, e.key);
      };
      // While a card is held, a finger moves it instead of the page, and a long press opens no menu.
      const onTouch = (e: TouchEvent) => {
        if (gesture) e.preventDefault();
      };
      const onMenu = (e: Event) => {
        if (gesture || press?.touch) e.preventDefault();
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
      };
    },

    /** After each render, before it paints: the cards slide from where they were, and what waited for it runs. */
    settle(move: Move | null) {
      const before = flip;
      flip = null;
      if (before && !reduced()) {
        for (const el of slots()) {
          const b = before.get(el.dataset.slot ?? "");
          if (!b) continue;
          const a = el.getBoundingClientRect();
          const dx = b.left - a.left;
          const dy = b.top - a.top;
          if (dx || dy)
            animate(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
              duration: FLIP_MS,
              easing: EASE,
            });
        }
        animate(
          ctx.root.current?.querySelector("[data-spot]"),
          [
            { opacity: 0, transform: "scaleY(.6)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 160, easing: "ease-out" },
        );
      }
      const then = after;
      after = null;
      then?.();
      // A dropped card waits where it fell until the data has its move (or says otherwise).
      if (move?.kind === "held" && itemOf(move.id) !== move.item) {
        remember();
        ctx.setMove((m) => (m === move ? null : m));
      }
    },

    /** A drop the data never takes (a refused save) stops waiting. */
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
 * The page's side: where each card goes while one moves (`entries`), how many each group shows, the group a card
 * would land in, the props of a card (`card`), and the line a screen reader hears (`live`).
 */
export function useIssueDrag<T extends { id: string }>(options: IssueDragOptions<T>) {
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
  useEffect(() => engine.attach(), [engine]);
  useLayoutEffect(() => engine.settle(move));
  useEffect(() => engine.hold(move), [engine, move]);

  const itemOf = (id: string) => {
    for (const g of options.groups) {
      const item = g.items.find((i) => i.id === id);
      if (item) return item;
    }
    return undefined;
  };

  const entries = (group: string): DragEntry<T>[] => {
    const items = options.groups.find((g) => g.id === group)?.items ?? [];
    const card = (item: T, state?: "hidden" | "landing" | "picked"): DragEntry<T> => ({ kind: "card", item, state });
    const m = move;
    if (!m) return items.map((i) => card(i));
    if (m.kind === "home") return items.map((i) => card(i, i.id === m.id ? "landing" : undefined));
    if (m.kind === "drag") {
      const out: DragEntry<T>[] = [];
      const spot: DragEntry<T> = { kind: "spot", key: `spot:${m.to}:${m.index}`, style: m.style };
      let k = 0;
      for (const i of items) {
        if (i.id === m.id) {
          out.push(card(i, "hidden"));
          continue;
        }
        if (m.to === group && k === m.index) out.push(spot);
        out.push(card(i));
        k++;
      }
      if (m.to === group && m.index >= k) out.push(spot);
      return out;
    }
    // Picked or just dropped: the card shows where it goes.
    const item = itemOf(m.id) ?? (m.kind === "held" ? (m.item as T) : undefined);
    const rest = items.filter((i) => i.id !== m.id);
    if (m.to !== group || !item) return rest.map((i) => card(i));
    const at = Math.min(m.index, rest.length);
    return [
      ...rest.slice(0, at).map((i) => card(i)),
      card(item, m.kind === "pick" ? "picked" : undefined),
      ...rest.slice(at).map((i) => card(i)),
    ];
  };

  const moving = move?.kind === "drag" || move?.kind === "pick" ? move : null;
  return {
    root,
    entries,
    /** The cards a group holds on screen (a card under the pointer still counts where it came from). */
    count: (group: string) => entries(group).filter((e) => e.kind === "card").length,
    /** A card is moving: empty groups show, each saying what a drop there does. */
    active: moving !== null,
    /** The group the moving card would land in. */
    over: moving?.to ?? null,
    live,
    card: (item: T, group: string) => ({
      draggable: false as const,
      onDragStart: (e: ReactDragEvent) => e.preventDefault(),
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => engine.pointerDown(e, item, group),
      onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => engine.keyDown(e, item, group),
    }),
  };
}

export type IssueDrag<T extends { id: string }> = ReturnType<typeof useIssueDrag<T>>;
