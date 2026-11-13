import { type BrowserFrameMetadata, type BrowserInputEvent, type BrowserModifiers, TEXT_EVENT_MAX } from "./live";

/**
 * A person's input on the live view (ADR 0040 §7, §14): where a click, a drag
 * or a finger on the shown frame lands on the page, and the key and text
 * events to send.
 */

/** A JPEG's pixel size from its bytes or its base64 (the start of the file is enough), or null. */
export function jpegSize(picture: string | Uint8Array): { width: number; height: number } | null {
  let bytes: Uint8Array;
  if (typeof picture !== "string") bytes = picture.subarray(0, 65536);
  else {
    try {
      const head = atob(picture.slice(0, 65536 - (65536 % 4)));
      bytes = Uint8Array.from(head, (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1] ?? 0;
    const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    // Start of frame (baseline, extended, progressive, lossless): height then width.
    if (marker >= 0xc0 && marker <= 0xc3) {
      const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
      const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

/**
 * The page size a frame shows, for mapping clicks. The stream's `deviceHeight` can be the
 * window's height while the page area is shorter (1280×720 reported, 1280×577 drawn), which
 * put every click a quarter lower than aimed; the picture's own aspect is the truth.
 */
export function frameMetadata(frame: {
  data?: string;
  jpeg?: Uint8Array;
  metadata: BrowserFrameMetadata;
}): BrowserFrameMetadata {
  const picture = frame.jpeg ?? frame.data;
  const size = picture === undefined ? null : jpegSize(picture);
  if (!size || frame.metadata.deviceWidth <= 0) return frame.metadata;
  return {
    ...frame.metadata,
    deviceHeight: Math.round((frame.metadata.deviceWidth * size.height) / size.width),
  };
}

/**
 * A point on the shown frame (relative to the element showing it, any size)
 * → page coordinates (CSS pixels of the viewport the frame was taken at).
 * Null when the point is outside the frame or the frame has no size; with
 * `clamp`, a point outside lands on the frame's nearest edge (a drag that left it).
 */
export function framePoint(
  point: { x: number; y: number },
  shown: { width: number; height: number },
  meta: Pick<BrowserFrameMetadata, "deviceWidth" | "deviceHeight">,
  clamp = false,
): { x: number; y: number } | null {
  if (shown.width <= 0 || shown.height <= 0 || meta.deviceWidth <= 0 || meta.deviceHeight <= 0) return null;
  const x = clamp ? Math.min(Math.max(point.x, 0), shown.width) : point.x;
  const y = clamp ? Math.min(Math.max(point.y, 0), shown.height) : point.y;
  if (x < 0 || y < 0 || x > shown.width || y > shown.height) return null;
  return {
    x: Math.round((x / shown.width) * meta.deviceWidth),
    y: Math.round((y / shown.height) * meta.deviceHeight),
  };
}

/**
 * The size a frame is shown at to fit `box` without distortion (letterboxed),
 * and its offset inside the box: for an element that is larger than the image.
 */
export function fitFrame(
  box: { width: number; height: number },
  meta: Pick<BrowserFrameMetadata, "deviceWidth" | "deviceHeight">,
): { width: number; height: number; left: number; top: number } {
  if (box.width <= 0 || box.height <= 0 || meta.deviceWidth <= 0 || meta.deviceHeight <= 0) {
    return { width: 0, height: 0, left: 0, top: 0 };
  }
  const scale = Math.min(box.width / meta.deviceWidth, box.height / meta.deviceHeight);
  const width = meta.deviceWidth * scale;
  const height = meta.deviceHeight * scale;
  return { width, height, left: (box.width - width) / 2, top: (box.height - height) / 2 };
}

/**
 * Where a point on an element showing the frame lands on the page. `box` is the element's
 * client rect; with `contain` the frame is drawn letterboxed inside it (object-fit: contain),
 * so the bands around the image are outside the page (null, or its edge with `clamp`).
 */
export function pagePoint(
  client: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
  meta: Pick<BrowserFrameMetadata, "deviceWidth" | "deviceHeight">,
  fit: "fill" | "contain" = "contain",
  clamp = false,
): { x: number; y: number } | null {
  const drawn = fit === "contain" ? fitFrame(box, meta) : { width: box.width, height: box.height, left: 0, top: 0 };
  return framePoint(
    { x: client.x - box.left - drawn.left, y: client.y - box.top - drawn.top },
    { width: drawn.width, height: drawn.height },
    meta,
    clamp,
  );
}

type Point = { x: number; y: number };

/**
 * The left button going down at a page point: the pointer moves there first, as a real mouse
 * does, so pages that react to the pointer arriving take it too. It stays down until `releaseEvent`.
 */
export function pressEvents(at: Point, modifiers?: BrowserModifiers): BrowserInputEvent[] {
  const mods = modifiers ? { modifiers } : {};
  return [
    { kind: "mouse", type: "mouseMoved", x: at.x, y: at.y, button: "none", ...mods },
    { kind: "mouse", type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1, ...mods },
  ];
}

/** The pointer moving with the left button down: a drag, which a slider or a map follows. */
export function dragEvent(at: Point, modifiers?: BrowserModifiers): BrowserInputEvent {
  return { kind: "mouse", type: "mouseMoved", x: at.x, y: at.y, button: "left", ...(modifiers ? { modifiers } : {}) };
}

/** The left button let go at a page point. */
export function releaseEvent(at: Point, modifiers?: BrowserModifiers): BrowserInputEvent {
  const mods = modifiers ? { modifiers } : {};
  return { kind: "mouse", type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1, ...mods };
}

/** A click at a page point: pressed and let go there. */
export function clickEvents(at: Point, modifiers?: BrowserModifiers): BrowserInputEvent[] {
  return [...pressEvents(at, modifiers), releaseEvent(at, modifiers)];
}

/** A finger that moves this far (pixels of the shown frame) before it lifts drags; one that doesn't taps. */
const TOUCH_DRAG_SLOP = 8;

/** What the fingers on the frame are doing: `over` waits for the rest of them to lift. */
export type TouchMode = "idle" | "pending" | "drag" | "scroll" | "over";

/**
 * Fingers on the shown frame, while the person is in control, as the page's mouse takes them: a
 * tap clicks where the finger landed; a finger that moves drags from there (pressed where it
 * landed, let go where it lifts); two fingers scroll the page. Points are on the shown frame;
 * `toPage` maps one to the page (null outside it, its nearest edge with `clamp`). A first finger
 * outside the page starts nothing.
 */
export function createTouchInput(toPage: (p: Point, clamp: boolean) => Point | null) {
  const fingers = new Map<number, Point>();
  let mode: TouchMode = "idle";
  let lead = -1;
  let landed: Point = { x: 0, y: 0 };
  let pressed: Point | null = null;
  let last: Point | null = null;
  const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
  const middle = () => {
    let x = 0;
    let y = 0;
    for (const p of fingers.values()) {
      x += p.x;
      y += p.y;
    }
    return { x: x / fingers.size, y: y / fingers.size };
  };
  return {
    get mode() {
      return mode;
    },
    down(id: number, p: Point): BrowserInputEvent[] {
      fingers.set(id, p);
      if (mode === "idle") {
        pressed = toPage(p, false);
        mode = pressed ? "pending" : "over";
        lead = id;
        landed = p;
      } else if (mode === "pending") mode = "scroll";
      return [];
    },
    move(id: number, p: Point): BrowserInputEvent[] {
      if (!fingers.has(id)) return [];
      const before = middle();
      fingers.set(id, p);
      if (mode === "scroll") {
        const from = toPage(before, true);
        const to = toPage(middle(), true);
        // The page follows the fingers: moving them up scrolls down.
        return from && to && !same(from, to) ? [wheelEvent(to, from.x - to.x, from.y - to.y)] : [];
      }
      if (id !== lead || !pressed) return [];
      if (mode === "pending" && Math.hypot(p.x - landed.x, p.y - landed.y) <= TOUCH_DRAG_SLOP) return [];
      if (mode !== "pending" && mode !== "drag") return [];
      const at = toPage(p, true);
      if (!at || (last && same(at, last))) return [];
      const start = mode === "pending" ? pressEvents(pressed) : [];
      mode = "drag";
      last = at;
      return [...start, dragEvent(at)];
    },
    up(id: number, p: Point): BrowserInputEvent[] {
      if (!fingers.delete(id)) return [];
      let out: BrowserInputEvent[] = [];
      if (id === lead && mode === "pending" && pressed) out = clickEvents(pressed);
      else if (id === lead && mode === "drag" && last) {
        const at = toPage(p, true) ?? last;
        out = same(at, last) ? [releaseEvent(at)] : [dragEvent(at), releaseEvent(at)];
      }
      if (id === lead || mode === "scroll") mode = "over";
      if (fingers.size === 0) {
        mode = "idle";
        last = null;
      }
      return out;
    },
    /** The touch was taken away (the system's gesture, the view going): a drag is let go where it was. */
    cancel(): BrowserInputEvent[] {
      const out = mode === "drag" && last ? [releaseEvent(last)] : [];
      fingers.clear();
      mode = "idle";
      last = null;
      return out;
    },
  };
}

/** Scrolling over the page (the wheel, or two fingers). */
export function wheelEvent(at: { x: number; y: number }, deltaX: number, deltaY: number): BrowserInputEvent {
  return { kind: "mouse", type: "mouseWheel", x: at.x, y: at.y, deltaX, deltaY };
}

/** Whole text into the page's focused field (accents and autofilled passwords included). */
export function textEvent(text: string): BrowserInputEvent | null {
  return text ? { kind: "text", text } : null;
}

/** A paste into the page's focused field: line breaks as LF, in pieces one event carries, never inside a character. */
export function pasteEvents(text: string): BrowserInputEvent[] {
  const all = text.replaceAll("\r\n", "\n");
  const out: BrowserInputEvent[] = [];
  for (let i = 0; i < all.length; ) {
    let end = Math.min(i + TEXT_EVENT_MAX, all.length);
    const last = all.charCodeAt(end - 1);
    if (end < all.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push({ kind: "text", text: all.slice(i, end) });
    i = end;
  }
  return out;
}

/** The special keys the live view sends as keys (everything else goes as text). */
export const SPECIAL_KEYS = {
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Escape: "Escape",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
} as const;

export type SpecialKey = keyof typeof SPECIAL_KEYS;

export const isSpecialKey = (key: string): key is SpecialKey => Object.hasOwn(SPECIAL_KEYS, key);

/**
 * The modifier mask of a keyboard or mouse event. Command on the person's Mac
 * becomes Control when the agent's computer isn't a Mac, so Command+A selects
 * all there too; on a Mac it stays Meta.
 */
export function modifiersOf(
  e: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
  remoteIsMac: boolean,
): BrowserModifiers {
  const meta = Boolean(e.metaKey);
  const control = Boolean(e.ctrlKey) || (meta && !remoteIsMac);
  return (e.altKey ? 1 : 0) | (control ? 2 : 0) | (meta && remoteIsMac ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** A key press (down and up): Enter, Tab, Backspace, Escape, arrows, or a shortcut letter with modifiers. */
export function keyEvents(key: string, modifiers?: BrowserModifiers): BrowserInputEvent[] {
  const code = isSpecialKey(key) ? key : key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : undefined;
  const base = { kind: "key" as const, key, ...(code ? { code } : {}), ...(modifiers ? { modifiers } : {}) };
  return [
    { ...base, type: "keyDown" },
    { ...base, type: "keyUp" },
  ];
}

/**
 * A key typed on the frame itself (the web, a hardware keyboard): special keys and shortcuts
 * as keys, a plain character as text. Null for what isn't sent (a modifier alone).
 */
export function keyboardEvents(
  e: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
  remoteIsMac: boolean,
): BrowserInputEvent[] | null {
  if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return null;
  const mods = modifiersOf(e, remoteIsMac);
  const shortcut = (mods & (1 | 2 | 4)) !== 0;
  if (isSpecialKey(e.key) || (shortcut && e.key.length === 1)) return keyEvents(e.key, mods);
  if (e.key.length === 1) return [{ kind: "text", text: e.key }];
  return null;
}
