import { type ReactNode, useRef } from "react";
import { useWraps } from "@/hooks/useWraps";

/** A connect flow's title: its tile, then its words, whose first line starts on the tile's top once they wrap. */
export function FlowTitle({ tile, children }: { tile: ReactNode; children: ReactNode }) {
  const text = useRef<HTMLSpanElement>(null);
  const wraps = useWraps(text);
  return (
    <span className="cflow__title">
      {tile}
      <span ref={text} className={wraps ? "ac-captop" : undefined}>
        {children}
      </span>
    </span>
  );
}
