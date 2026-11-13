/**
 * Which ⓘ hint is open, and what closes it besides its own ⓘ: a tap anywhere else, and Android's back. One hint is
 * open at a time. Pure (no React Native import), so it is unit-tested; `InfoHint` and the app's outermost view
 * (`hintTouches`) call it.
 */

export interface OpenHint {
  id: string;
  close: () => void;
}

/** How far a finger may move and still tap (points). Farther is a scroll, which leaves the hint open to read. */
const TAP_SLOP = 10;

type Touch = { nativeEvent: { pageX: number; pageY: number } };

let open: OpenHint | null = null;
/** The hint whose ⓘ or text the current touch began on: that touch is the hint's own, never "outside". */
let own: string | null = null;
let start: { x: number; y: number } | null = null;

function closeOpen(): boolean {
  if (!open) return false;
  const hint = open;
  open = null;
  hint.close();
  return true;
}

export function hintOpened(hint: OpenHint) {
  if (open?.id !== hint.id) closeOpen();
  open = hint;
}

export function hintClosed(id: string) {
  if (open?.id === id) open = null;
}

/** A touch began on this hint's ⓘ or text. */
export function hintTouched(id: string) {
  own = id;
}

/**
 * For the app's outermost view. The capture runs before the touched view's own handlers, so a touch starts with no
 * owner; a tap that ends anywhere but on the open hint closes it, whatever runs first after that.
 */
export const hintTouches = {
  onTouchStartCapture: (e: Touch) => {
    own = null;
    start = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
  },
  onTouchEnd: (e: Touch) => {
    const tap = start !== null && Math.hypot(e.nativeEvent.pageX - start.x, e.nativeEvent.pageY - start.y) <= TAP_SLOP;
    if (tap && open && own !== open.id) closeOpen();
    start = null;
  },
  onTouchCancel: () => {
    start = null;
  },
};

/** Android's back: closes the open hint, and only that (true: handled). */
export const hintBack = (): boolean => closeOpen();

/**
 * Android's back for a view that takes it before `BackHandler` does (a `Modal`'s `onRequestClose`): the open hint
 * closes first, and only a back with none open runs `close`.
 */
export const hintBackOr = (close: () => void) => () => {
  if (!closeOpen()) close();
};
