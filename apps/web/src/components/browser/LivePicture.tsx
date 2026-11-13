import { type BrowserFrame, browserFrameDataUrl } from "@agenteschat/client";
import { memo, type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/** A frame's picture as an image address: its bytes as a new `blob:` URL (freed by whoever made it), else `data:`. */
function pictureUrl(frame: BrowserFrame): string | null {
  if (frame.jpeg) return URL.createObjectURL(new Blob([frame.jpeg], { type: "image/jpeg" }));
  return browserFrameDataUrl(frame);
}

/**
 * The live page's picture (ADR 0040 §7.1), a component of its own so that a new frame redraws only this image. Its
 * bytes (the frame socket) become a `blob:` address the browser decodes off the main thread, its base64 (the realtime
 * socket) a `data:` one. The address is set on the image in an effect, never while rendering (a render React throws
 * away, as StrictMode's second one, would leave its address behind); each `blob:` address the image no longer shows
 * is freed once it has the newer one (or failed to), so the picture on screen never goes blank, and all of them
 * when it goes.
 */
export const LivePicture = memo(function LivePicture({
  frame,
  alt,
  imgRef,
}: {
  frame: BrowserFrame;
  alt: string;
  /** The image, for where a point lands on the page (`pagePoint` with its box). */
  imgRef: RefObject<HTMLImageElement | null>;
}) {
  /** `blob:` addresses made here and not freed yet, oldest first. */
  const made = useRef<string[]>([]);
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const src = pictureUrl(frame);
    if (!src) return;
    if (src.startsWith("blob:")) made.current.push(src);
    img.src = src;
  }, [frame, imgRef]);
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const settled = () => {
      const shown = img.getAttribute("src");
      for (const url of made.current) if (url !== shown) URL.revokeObjectURL(url);
      made.current = made.current.filter((url) => url === shown);
    };
    img.addEventListener("load", settled);
    img.addEventListener("error", settled);
    return () => {
      img.removeEventListener("load", settled);
      img.removeEventListener("error", settled);
      for (const url of made.current) URL.revokeObjectURL(url);
      made.current = [];
    };
  }, [imgRef]);
  return <img ref={imgRef} alt={alt} draggable={false} />;
});
