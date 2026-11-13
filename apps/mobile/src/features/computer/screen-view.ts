/*
 * The camera over the agent's screen and the cursor on it (ADR 0098): in the desktop's own pixels, with `s` the scale
 * from those to points on the phone. Worklets, run on the UI thread by the gestures, and plain functions in the tests.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The desktop's size until the page says (`DESKTOP_SIZE` in the machine protocol). */
export const DEFAULT_DESKTOP: Size = { width: 1280, height: 900 };

/** The closest the view comes: past this a 1280-wide picture only blurs. */
export const MAX_SCALE = 2.4;

/** In control, the view never starts smaller than this much over the whole screen: its targets need the room. */
const CONTROL_ZOOM = 1.25;
/** Upright the box is narrow: control starts this close, so the field it stopped at reads without a pinch. */
const CONTROL_ZOOM_UPRIGHT = 2.2;

/** How near an edge of the view the cursor goes before the view follows it, as a share of the view's short side. */
const FOLLOW_MARGIN = 0.2;

/** Trackpad points a two-finger swipe takes per notch of the wheel. */
export const WHEEL_STEP = 18;

/** Points the cursor crosses on the screen per trackpad point, aiming and traveling: the pad is smaller than the view. */
const AIM_GAIN = 0.8;
const TRAVEL_GAIN = 2.8;

/** Finger speeds, in points per millisecond, up to which a move still aims and from which it travels flat out. */
const AIM_SPEED = 0.1;
const TRAVEL_SPEED = 1.2;

export const clamp = (v: number, min: number, max: number) => {
  "worklet";
  return Math.max(min, Math.min(max, v));
};

/** The whole desktop in the box. */
export const fitScale = (box: Size, desk: Size) => {
  "worklet";
  return Math.min(box.width / desk.width, box.height / desk.height);
};

/** The scale control starts at: the box filled, no bands around the picture. */
export const controlScale = (box: Size, desk: Size) => {
  "worklet";
  const fit = fitScale(box, desk);
  const zoom = box.width / box.height < desk.width / desk.height ? CONTROL_ZOOM_UPRIGHT : CONTROL_ZOOM;
  return clamp(Math.max(box.width / desk.width, box.height / desk.height, fit * zoom), fit, MAX_SCALE);
};

/** The camera's corner kept on the desktop, centered on any side the box is larger than it. */
export const boundCamera = (x: number, y: number, s: number, box: Size, desk: Size): Point => {
  "worklet";
  const w = box.width / s;
  const h = box.height / s;
  return {
    x: w >= desk.width ? (desk.width - w) / 2 : clamp(x, 0, desk.width - w),
    y: h >= desk.height ? (desk.height - h) / 2 : clamp(y, 0, desk.height - h),
  };
};

/** The camera centered on a desktop position, as far as the desktop goes. */
export const lookAt = (p: Point, s: number, box: Size, desk: Size): Point => {
  "worklet";
  return boundCamera(p.x - box.width / s / 2, p.y - box.height / s / 2, s, box, desk);
};

/** The scale changed to `next` with the desktop point under `focal` (points in the box) staying under it. */
export const zoomCamera = (camera: Point, s: number, next: number, focal: Point, box: Size, desk: Size): Point => {
  "worklet";
  const x = focal.x / s + camera.x;
  const y = focal.y / s + camera.y;
  return boundCamera(x - focal.x / next, y - focal.y / next, next, box, desk);
};

/** The desktop position under a point in the box. */
export const toDesktop = (p: Point, camera: Point, s: number, desk: Size): Point => {
  "worklet";
  return { x: clamp(p.x / s + camera.x, 0, desk.width), y: clamp(p.y / s + camera.y, 0, desk.height) };
};

/**
 * Desktop pixels per trackpad point: slow moves aim, fast ones travel (`speed` in points per millisecond), and closer
 * in the same swipe covers less of the desktop, so a swipe always feels the same size on the screen.
 */
export const cursorGain = (speed: number, s: number) => {
  "worklet";
  const fast = clamp((speed - AIM_SPEED) / (TRAVEL_SPEED - AIM_SPEED), 0, 1);
  return (AIM_GAIN + (TRAVEL_GAIN - AIM_GAIN) * fast) / s;
};

/**
 * A finger rolling the view sideways: the camera goes as far as it can, and what it couldn't take is left for the page
 * under the finger, in points, positive going down it.
 */
export const dragView = (camera: Point, s: number, change: Point, box: Size, desk: Size) => {
  "worklet";
  const to = boundCamera(camera.x - change.x / s, camera.y - change.y / s, s, box, desk);
  return { camera: to, left: -change.y - (to.y - camera.y) * s };
};

/** Whether the cursor stands on the desktop's edge: it can go no further that way. */
export const atDesktopEdge = (cursor: Point, desk: Size) => {
  "worklet";
  return cursor.x <= 0 || cursor.y <= 0 || cursor.x >= desk.width || cursor.y >= desk.height;
};

/** The camera moved just enough to keep the cursor inside the view's margin. */
export const followCursor = (camera: Point, s: number, cursor: Point, box: Size, desk: Size): Point => {
  "worklet";
  const margin = Math.min(box.width, box.height) * FOLLOW_MARGIN;
  const px = (cursor.x - camera.x) * s;
  const py = (cursor.y - camera.y) * s;
  let { x, y } = camera;
  if (px < margin) x -= (margin - px) / s;
  else if (px > box.width - margin) x += (px - box.width + margin) / s;
  if (py < margin) y -= (margin - py) / s;
  else if (py > box.height - margin) y += (py - box.height + margin) / s;
  return boundCamera(x, y, s, box, desk);
};

/**
 * The box changed size under the same view (the keyboard came or went): the zoom the person had stays, as far as the
 * new box allows, and the view moves only as much as keeps the cursor in sight.
 */
export const keepView = (camera: Point, s: number, cursor: Point, box: Size, desk: Size) => {
  "worklet";
  const next = clamp(s, fitScale(box, desk), MAX_SCALE);
  return { s: next, camera: followCursor(camera, next, cursor, box, desk) };
};

/** How soon after a tap a touch that moves presses and drags: a trackpad's tap and drag. */
export const TAP_DRAG_MS = 300;

/**
 * Pressing and dragging with one finger (selecting text, moving a window, a slider). A hold where the finger rests
 * presses the left button, and so does a touch soon after a tap once it moves. The button is let go when the finger
 * lifts, wherever it went: the hold's own gesture ends once the finger travels a few points, so the lift lets go,
 * never the hold.
 */
export interface Drag {
  /** When the last tap that clicked was; null is none, or one that only let go of a press. */
  tapAt: number | null;
  /** This touch: plain, `armed` (it came soon after a tap: moving presses), or `down` (the button is held). */
  touch: "plain" | "armed" | "down";
  /** This touch pressed the button: its tap is no click, since its lift lets go. Kept until the next touch. */
  pressed: boolean;
}

export const DRAG_REST: Drag = { tapAt: null, touch: "plain", pressed: false };

/** What a finger did: came down, started moving, held still, tapped (a quick lift), lifted (any end). */
export type DragEvent = "touch" | "move" | "hold" | "tap" | "lift";

/** What goes to the screen: the button pressed or let go where the cursor is, or a click. */
export type DragAct = "press" | "release" | "click" | null;

/** The next state of the finger's drag, and what it sends. The tap and the lift may come in either order. */
export const dragStep = (d: Drag, event: DragEvent, at: number): { drag: Drag; act: DragAct } => {
  "worklet";
  switch (event) {
    case "touch": {
      const soon = d.tapAt !== null && at - d.tapAt <= TAP_DRAG_MS;
      // A lift that never came lets go first.
      return {
        drag: { tapAt: d.tapAt, touch: soon ? "armed" : "plain", pressed: false },
        act: d.touch === "down" ? "release" : null,
      };
    }
    case "move":
      if (d.touch !== "armed") return { drag: d, act: null };
      return { drag: { ...d, touch: "down", pressed: true }, act: "press" };
    case "hold":
      if (d.touch === "down") return { drag: d, act: null };
      return { drag: { ...d, touch: "down", pressed: true }, act: "press" };
    case "tap":
      return d.pressed ? { drag: { ...d, tapAt: null }, act: null } : { drag: { ...d, tapAt: at }, act: "click" };
    case "lift":
      return { drag: { ...d, touch: "plain" }, act: d.touch === "down" ? "release" : null };
  }
};
