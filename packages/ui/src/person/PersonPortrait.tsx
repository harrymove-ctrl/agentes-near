import { useLayoutEffect, useRef } from "react";
import { cx } from "../cx";
import { cropFor, type PersonRecipe, renderPerson } from "./engine.js";

let drawable: boolean | undefined;
/** Whether this environment has a 2D canvas (asked once). Without one, a portrait shows as its image. */
export function canDrawPortraits(): boolean {
  if (drawable === undefined) {
    try {
      drawable = typeof document !== "undefined" && Boolean(document.createElement("canvas").getContext?.("2d"));
    } catch {
      drawable = false;
    }
  }
  return drawable;
}

/**
 * A person's pixel portrait (ADR 0166), filling its box: the face alone up to
 * 48 px, the whole bust above (`crop` says otherwise). Each cell is a whole
 * number of device pixels, so it stays crisp at any size.
 */
export function PersonPortrait({
  recipe,
  crop,
  className,
}: {
  recipe: Partial<PersonRecipe>;
  crop?: "face" | "full";
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const code = JSON.stringify(recipe);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `code` is the recipe by value
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    // The box is the canvas's parent: its size says how many cells to show and how large to draw them.
    const side = el.parentElement?.clientWidth || el.clientWidth || 36;
    const ratio = typeof devicePixelRatio === "number" ? Math.max(1, devicePixelRatio) : 1;
    renderPerson(el, recipe, { crop: crop ?? cropFor(side), px: side * ratio });
  }, [code, crop]);
  return <canvas ref={canvas} className={cx("ac-portrait", className)} />;
}
