import { formatPercent } from "@agenteschat/client/lib/format";
import {
  clampPan,
  clickZoom,
  fitScale,
  fitView,
  isZoomed,
  lensLayout,
  lensMag,
  type Point,
  panBy,
  type Size,
  stepZoom,
  wheelIntent,
  ZOOM_MAX,
  type ZoomView,
  zoomAt,
} from "@agenteschat/client/lib/zoom";
import { Button, Spinner } from "@agenteschat/ui";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMatchMedia } from "@/hooks/useMatchMedia";
import { STORAGE_KEYS, storage } from "@/lib/storage";

const HOVER = "(hover: hover) and (pointer: fine)";
/** A press that moves less than this is a click, not a drag. */
const CLICK_SLOP = 4;
/** A second click this soon after a click zoomed in is a double-click: it keeps the zoom instead of fitting back. */
const DOUBLE_CLICK_MS = 400;
/** Arrow keys move the zoomed picture this share of the stage. */
const ARROW_STEP = 0.1;
const GESTURES = ["gesturestart", "gesturechange", "gestureend"];
/** The floating zoom bar's height and its gap above the stage's bottom edge: the lens pane stays clear of it. */
const BAR_ROOM = 52;
/** A finger moving a fitted picture this far sideways lets go onto the next or previous one. */
const SWIPE_MIN = 48;

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * A picture filling its box, fitted (never past its real size), with zoom: the hover lens and its magnified pane
 * (mouse only, switchable), a click to zoom in at the pointer and back, the wheel or a pinch around the cursor, a
 * drag or two fingers on a trackpad to move, − / % / + / Ajustar / 100% on a bar floating over the picture (shown on
 * hover, on focus and while zoomed), and the keys + − 0 1, the arrows and Esc (back to fitted, then the dialog
 * closes). With `onSwipe`, a finger drags a fitted picture sideways to the next or previous one. No `src` yet: the
 * stage waits for it.
 */
export function ImageZoom({
  src,
  alt,
  onSwipe,
}: {
  src: string | null;
  alt: string;
  onSwipe?: ((dir: 1 | -1) => void) | undefined;
}) {
  const { t, i18n } = useTranslation();
  const hintId = useId();
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Size | null>(null);
  const [img, setImg] = useState<Size | null>(null);
  const [broken, setBroken] = useState(false);
  const [view, setView] = useState<ZoomView | null>(null);
  const [animate, setAnimate] = useState(false);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [dragging, setDragging] = useState(false);
  /** How far a finger has dragged the fitted picture sideways (`onSwipe`). */
  const [swipe, setSwipe] = useState(0);
  const [lensOn, setLensOn] = useState(() => storage.get(STORAGE_KEYS.imageLens) !== "0");
  const hover = useMatchMedia(HOVER);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{
    start: Point;
    view: ZoomView;
    moved: boolean;
    pinch?: { d: number; mid: Point };
    /** The finger left of a pinch: it moves a zoomed picture, never swipes to another one. */
    pinched?: boolean;
  } | null>(null);
  const zoomedInAt = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;

  const fit = img && stage ? fitScale(img, stage) : 1;
  const zoomed = Boolean(view && img && stage && isZoomed(view, img, stage));

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    // The layout size, not getBoundingClientRect: the dialog opens with a scale animation that would shrink the fit.
    const measure = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) setStage({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A new stage size keeps a zoomed picture where it is (inside the bounds) and refits a fitted one.
  useEffect(() => {
    if (!img || !stage) return;
    setView((v) => (v && isZoomed(v, img, stage) ? clampPan(v, img, stage) : fitView(img, stage)));
  }, [img, stage]);

  const go = useCallback((next: ZoomView, smooth: boolean) => {
    setAnimate(smooth);
    setView(next);
  }, []);

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = stageRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  // The wheel needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !img || !stage) return;
    // Safari sends a trackpad pinch as its own gesture events, not a ctrl wheel, and zooms the page unless stopped.
    // `scale` counts from the gesture's start. A touch pinch also fires them there: the pointers handle that one.
    let last = 1;
    let gesturing = false;
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      if (!v) return;
      const intent = wheelIntent(e);
      // A browser that sends both for one pinch zooms once, by the gesture.
      if (gesturing && intent === "pinch") {
        e.preventDefault();
        return;
      }
      if (intent === "scroll") {
        // Two fingers on a trackpad move a zoomed picture; on a fitted one there is nothing to move.
        if (!isZoomed(v, img, stage)) return;
        e.preventDefault();
        go(panBy(v, -e.deltaX, -e.deltaY, img, stage), false);
        return;
      }
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.h : 1;
      const k = Math.exp(-e.deltaY * unit * (intent === "pinch" ? 0.01 : 0.002));
      const r = el.getBoundingClientRect();
      go(zoomAt(v, v.scale * k, { x: e.clientX - r.left, y: e.clientY - r.top }, img, stage), false);
    };
    const onGesture = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
      const v = viewRef.current;
      gesturing = e.type !== "gestureend";
      if (e.type === "gesturestart") last = 1;
      if (e.type !== "gesturechange" || !v || !g.scale || pointers.current.size > 1) return;
      const r = el.getBoundingClientRect();
      const at = { x: (g.clientX ?? r.left + r.width / 2) - r.left, y: (g.clientY ?? r.top + r.height / 2) - r.top };
      go(zoomAt(v, (v.scale * g.scale) / last, at, img, stage), false);
      last = g.scale;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    for (const type of GESTURES) el.addEventListener(type, onGesture);
    return () => {
      el.removeEventListener("wheel", onWheel);
      for (const type of GESTURES) el.removeEventListener(type, onGesture);
    };
  }, [img, stage, go]);

  // On the window, in the capture phase: ahead of the dialog's own Esc, which then sees it handled and stays open.
  useEffect(() => {
    if (!img || !stage) return;
    const onKey = (e: KeyboardEvent) => {
      const el = stageRef.current;
      const v = viewRef.current;
      const target = e.target as HTMLElement | null;
      const scope = el?.closest('[role="dialog"]') ?? el;
      if (!el || !v || !target || !scope?.contains(target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]')) return;
      const center = { x: stage.w / 2, y: stage.h / 2 };
      const f = fitScale(img, stage);
      const isIn = isZoomed(v, img, stage);
      const step = { x: stage.w * ARROW_STEP, y: stage.h * ARROW_STEP };
      const next = (() => {
        switch (e.key) {
          case "+":
          case "=":
            return zoomAt(v, stepZoom(v.scale, 1, f), center, img, stage);
          case "-":
          case "_":
            return zoomAt(v, stepZoom(v.scale, -1, f), center, img, stage);
          case "0":
            return fitView(img, stage);
          case "1":
            return zoomAt(v, 1, center, img, stage);
          case "Escape":
            return isIn ? fitView(img, stage) : null;
          case "ArrowLeft":
            return isIn ? panBy(v, step.x, 0, img, stage) : null;
          case "ArrowRight":
            return isIn ? panBy(v, -step.x, 0, img, stage) : null;
          case "ArrowUp":
            return isIn ? panBy(v, 0, step.y, img, stage) : null;
          case "ArrowDown":
            return isIn ? panBy(v, 0, -step.y, img, stage) : null;
          default:
            return null;
        }
      })();
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      go(next, true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [img, stage, go]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !view) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const all = [...pointers.current.values()];
    if (all.length === 1) gesture.current = { start: p, view, moved: false };
    else if (all.length === 2 && all[0] && all[1]) {
      gesture.current = {
        start: middle(all[0], all[1]),
        view,
        moved: true,
        pinch: { d: distance(all[0], all[1]), mid: middle(all[0], all[1]) },
      };
      // The first finger's sideways pull ends here: the pinch zooms the picture where it really is.
      setSwipe(0);
    }
    setAnimate(false);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = local(e);
    if (e.pointerType === "mouse") setPointer(p);
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g || !img || !stage) return;
    const all = [...pointers.current.values()];
    if (g.pinch && all[0] && all[1]) {
      const mid = middle(all[0], all[1]);
      const z = zoomAt(g.view, (g.view.scale * distance(all[0], all[1])) / g.pinch.d, g.pinch.mid, img, stage);
      setView(panBy(z, mid.x - g.pinch.mid.x, mid.y - g.pinch.mid.y, img, stage));
      return;
    }
    if (!g.moved && distance(p, g.start) > CLICK_SLOP) {
      g.moved = true;
      if (isZoomed(g.view, img, stage)) setDragging(true);
    }
    if (!g.moved) return;
    if (isZoomed(g.view, img, stage)) setView(panBy(g.view, p.x - g.start.x, p.y - g.start.y, img, stage));
    else if (onSwipe && e.pointerType !== "mouse" && !g.pinched) setSwipe(p.x - g.start.x);
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    const left = [...pointers.current.values()];
    if (left[0]) {
      // One finger of a pinch lifted: the other carries on as a drag, still the pinch's (it never swipes).
      if (viewRef.current) gesture.current = { start: left[0], view: viewRef.current, moved: true, pinched: true };
      return;
    }
    gesture.current = null;
    setDragging(false);
    const v = viewRef.current;
    // A finger dragged the fitted picture: onto the next or previous one when it went far enough sideways, else back.
    if (
      g?.moved &&
      !g.pinch &&
      !g.pinched &&
      onSwipe &&
      e.pointerType !== "mouse" &&
      img &&
      stage &&
      !isZoomed(g.view, img, stage)
    ) {
      setAnimate(true);
      setSwipe(0);
      const p = local(e);
      const dx = p.x - g.start.x;
      if (e.type === "pointerup" && Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(p.y - g.start.y))
        onSwipe(dx < 0 ? 1 : -1);
      return;
    }
    if (e.type !== "pointerup" || !g || g.moved || !v || !img || !stage) return;
    if (isZoomed(v, img, stage)) {
      if (e.timeStamp - zoomedInAt.current > DOUBLE_CLICK_MS) go(fitView(img, stage), true);
      return;
    }
    zoomedInAt.current = e.timeStamp;
    go(zoomAt(v, clickZoom(fitScale(img, stage)), local(e), img, stage), true);
  };

  const center = () => ({ x: (stage?.w ?? 0) / 2, y: (stage?.h ?? 0) / 2 });
  const zoomTo = (scale: number) => view && img && stage && go(zoomAt(view, scale, center(), img, stage), true);
  const toggleLens = () => {
    storage.set(STORAGE_KEYS.imageLens, lensOn ? "0" : "1");
    setLensOn(!lensOn);
  };

  const box = view && img ? { x: view.x, y: view.y, w: img.w * view.scale, h: img.h * view.scale } : null;
  const inBox =
    box &&
    pointer &&
    pointer.x >= box.x &&
    pointer.x <= box.x + box.w &&
    pointer.y >= box.y &&
    pointer.y <= box.y + box.h;
  const mag = lensMag(fit);
  const lens =
    hover && lensOn && !zoomed && !dragging && stage && box && pointer && inBox
      ? lensLayout({ w: stage.w, h: stage.h - BAR_ROOM }, box, pointer, mag)
      : null;
  const percent = formatPercent(i18n.language, Math.round((view?.scale ?? 1) * 100));

  return (
    <div className="izoom" data-zoomed={zoomed || undefined}>
      {/* biome-ignore lint/a11y/useSemanticElements: a picture's stage, not a set of form fields */}
      <div
        ref={stageRef}
        className="izoom__stage"
        role="group"
        aria-label={alt}
        aria-describedby={hintId}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the keys zoom and move the picture once it has focus
        tabIndex={0}
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={() => setPointer(null)}
      >
        {src && (
          <img
            className="izoom__img"
            src={src}
            alt={alt}
            draggable={false}
            decoding="async"
            data-animate={animate || undefined}
            data-ready={Boolean(view && img) || undefined}
            style={
              view && img
                ? {
                    width: img.w,
                    height: img.h,
                    transform: `translate(${view.x + swipe}px, ${view.y}px) scale(${view.scale})`,
                  }
                : { visibility: "hidden" }
            }
            onLoad={(e) => {
              const el = e.currentTarget;
              // An SVG without a size of its own takes the stage's.
              const st = stageRef.current;
              setImg({ w: el.naturalWidth || st?.clientWidth || 1, h: el.naturalHeight || st?.clientHeight || 1 });
            }}
            onError={() => setBroken(true)}
          />
        )}
        {!img && (
          <span className="izoom__status row small muted" role="status">
            {broken ? (
              t("files.previewFailed")
            ) : (
              <>
                <Spinner />
                {t("files.previewLoading")}
              </>
            )}
          </span>
        )}
        {lens && box && src && (
          <>
            <span
              className="izoom__lens"
              aria-hidden="true"
              style={{ left: lens.lens.x, top: lens.lens.y, width: lens.lens.w, height: lens.lens.h }}
            />
            <span
              className="izoom__pane"
              aria-hidden="true"
              style={{ left: lens.pane.x, top: lens.pane.y, width: lens.pane.w, height: lens.pane.h }}
            >
              <img
                src={src}
                alt=""
                style={{
                  width: box.w * mag,
                  height: box.h * mag,
                  transform: `translate(${lens.offset.x}px, ${lens.offset.y}px)`,
                }}
              />
            </span>
          </>
        )}
      </div>
      <div className="izoom__bar">
        <p id={hintId} className="izoom__hint small muted">
          {hover
            ? t(zoomed ? "files.zoom.hintZoomed" : "files.zoom.hint")
            : t(zoomed ? "files.zoom.hintZoomedTouch" : "files.zoom.hintTouch")}
        </p>
        <div className="izoom__tools ac-acts" role="toolbar" aria-label={t("files.zoom.toolbar")}>
          {hover && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="search"
              aria-label={t("files.zoom.lens")}
              title={t("files.zoom.lens")}
              aria-pressed={lensOn}
              onClick={toggleLens}
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="dash"
            aria-label={t("files.zoom.out")}
            title={t("files.zoom.out")}
            disabled={!zoomed}
            onClick={() => zoomTo(stepZoom(view?.scale ?? fit, -1, fit))}
          />
          <span className="izoom__level tabular">{percent}</span>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="plus"
            aria-label={t("files.zoom.in")}
            title={t("files.zoom.in")}
            disabled={(view?.scale ?? 0) >= ZOOM_MAX}
            onClick={() => zoomTo(stepZoom(view?.scale ?? fit, 1, fit))}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={!zoomed}
            onClick={() => img && stage && go(fitView(img, stage), true)}
          >
            {t("files.zoom.fit")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="izoom__actual"
            aria-label={t("files.zoom.actual")}
            title={t("files.zoom.actual")}
            disabled={Math.abs((view?.scale ?? 1) - 1) < 1e-3}
            onClick={() => zoomTo(1)}
          >
            {formatPercent(i18n.language, 100)}
          </Button>
        </div>
      </div>
    </div>
  );
}
