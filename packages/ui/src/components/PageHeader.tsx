import type { HTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "../cx";

export interface PageHeaderProps {
  title: ReactNode;
  /**
   * The line under the title: what the page holds now (the period shown) or what it is for, in one short line. Its room
   * stays while it loads (`false`), so the page doesn't move when it arrives. Every page has it, or a `count` instead.
   */
  meta?: ReactNode;
  /**
   * How many the page holds or waits on ("2 não lidas"): on the title's row, right after it, never a line of its own
   * unless the row has no room. A page whose line would only be its count has no line under the title.
   */
  count?: ReactNode;
  /** Read out when the line changes (a calendar's period). */
  metaLive?: boolean;
  /** Before the title on its line, e.g. the way back out of a folder. */
  lead?: ReactNode;
  /** At the end of the title's line: the page's own buttons, its main one last. */
  actions?: ReactNode;
  /** Under the title: the page's tabs, search, filters or navigation. */
  children?: ReactNode;
  /** 1 for a page; 2 when the page shows inside another one (a Settings section). */
  level?: 1 | 2;
  titleId?: string;
  titleRef?: Ref<HTMLHeadingElement>;
  className?: string;
}

/**
 * Every inner page's header, one shape for all: the title (28px) with its count beside it or its line under it, the
 * page's buttons at the end of the title's line, and under them the page's bar. Pages don't style their own titles.
 */
export function PageHeader({
  title,
  meta,
  count,
  metaLive,
  lead,
  actions,
  children,
  level = 1,
  titleId,
  titleRef,
  className,
  ...rest
}: PageHeaderProps & Omit<HTMLAttributes<HTMLElement>, "title" | "children">) {
  const Heading = level === 1 ? "h1" : "h2";
  const heading = (
    <Heading className="ac-pagehead__title" id={titleId} ref={titleRef}>
      {title}
    </Heading>
  );
  return (
    <header className={cx("ac-pagehead", className)} {...rest}>
      <div className="ac-pagehead__row">
        <div className="ac-pagehead__text">
          {lead || count !== undefined ? (
            <div className="ac-pagehead__titleline">
              {lead}
              {heading}
              {count ? <p className="ac-pagehead__count">{count}</p> : null}
            </div>
          ) : (
            heading
          )}
          {meta !== undefined && (
            <p
              className="ac-pagehead__meta"
              aria-live={metaLive ? "polite" : undefined}
              // One line: a longer one ends in "…", and the whole of it shows on hover.
              title={typeof meta === "string" ? meta : undefined}
            >
              {meta}
            </p>
          )}
        </div>
        {actions && <div className="ac-pagehead__actions">{actions}</div>}
      </div>
      {children && <div className="ac-pagehead__bar">{children}</div>}
    </header>
  );
}
