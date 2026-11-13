import { cx, useScrollSides } from "@agenteschat/ui";
import { type ReactNode, useRef } from "react";

/**
 * A table's box (`.md__table`): the hairline and corners stay put while the table scrolls sideways inside, and the
 * side with more columns past it fades (`data-more`). In a message every table is the message's width, whatever its
 * columns (layout.css); a Markdown table and a chart's table view both use it.
 */
export function TableBox({ children, className }: { children: ReactNode; className?: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const more = useScrollSides(scroller);
  return (
    <div className={cx("md__table", className)} data-more={more}>
      <div ref={scroller} className="md__table-scroll">
        {children}
      </div>
    </div>
  );
}
