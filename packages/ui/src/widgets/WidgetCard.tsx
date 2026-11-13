import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../components/Button";
import { CardHorizon } from "../components/CardHorizon";
import { CardMore, useCardCut } from "../components/CardMore";
import { cx } from "../cx";
import { useDarkTheme } from "../hooks/useDarkTheme";
import { Icon } from "../icons/Icon";
import { DitherLine } from "./ChartPieces";
import type { KpiWidgetSpec, WidgetSpec, WidgetStatus } from "./spec";
import { widgetTileVars } from "./tiles";
import { WidgetBody } from "./WidgetBody";

/** "Organize" on a board: the size button, remove, and the grip to drag (or move with the arrow keys). */
export interface WidgetOrganize {
  /** "Size". */
  sizeLabel: string;
  /** The size now: "S", "M", "L". */
  sizeText: string;
  removeLabel: string;
  /** "Drag to move". */
  dragLabel: string;
  onSize: () => void;
  onRemove: () => void;
  /** The grip's arrow keys: one place earlier (-1) or later (1). Without it (or `grip`), only for the pointer. */
  onMove?: (delta: -1 | 1) => void;
  /** The board's drag on the grip (its keys, `data-grip`), in place of `onMove`'s arrows. */
  grip?: ButtonHTMLAttributes<HTMLButtonElement> & { "data-grip"?: string };
}

export type WidgetCardProps = {
  title: string;
  spec: WidgetSpec | null;
  status: WidgetStatus;
  /** The agent who looks after it: its color, as `AgentAvatar` takes it. */
  color: string;
  size: { w: 1 | 2; h: 1 | 2 };
  locale: string;
  /** Under the body: who updated it and when, "updating…", or why it failed with Resolve. */
  footer: ReactNode;
  /** Before the title: the face of the agent who looks after it (the footer then only says when). */
  face?: ReactNode;
  buildingText?: string;
  /** The head's own buttons (Update now, its menu), shown on hover and focus. */
  actions?: ReactNode;
  /** The title opens the widget (its panel). */
  onOpen?: () => void;
  /** On a board in Organize: its controls in place of `actions`. */
  organize?: WidgetOrganize | null;
  /**
   * On a board: the card's height is capped (S and M one row, L two) and content past it fades out under "See more",
   * which opens the widget (`onOpen`); a card with room to spare gets the horizon at its foot.
   */
  board?: CardBoardLabels;
  className?: string;
} & Omit<HTMLAttributes<HTMLElement>, "title" | "color">;

/** A card on a board: "See more" and what it hides, for screen readers ("5 more"). */
export interface CardBoardLabels {
  seeMore: string;
  hidden: (count: number) => string;
}

const FLASH_MS = 1200;

/**
 * A widget on a board (ADR 0135): a neutral card with the cut corner, its title, the block it shows, and a footer.
 * A refresh draws a dither sweep along its top edge and dims the last data under it; new data flashes once in the
 * agent's tone and a number counts up to it. A failure greys the last data out.
 */
export function WidgetCard({
  title,
  spec,
  status,
  color,
  size,
  locale,
  footer,
  face,
  buildingText,
  actions,
  onOpen,
  organize,
  board,
  className,
  style,
  ...rest
}: WidgetCardProps) {
  const dark = useDarkTheme();
  const flash = useFlash(spec);
  const body = useRef<HTMLDivElement>(null);
  const capped = Boolean(board) && !organize;
  const cut = useCardCut(body, capped && Boolean(onOpen));
  // A number's trend already runs along the foot: no horizon under it.
  const horizon = capped && status !== "building" && !sparkOf(spec);
  const grip = (e: KeyboardEvent<HTMLButtonElement>) => {
    const delta =
      e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
    if (!delta || !organize?.onMove) return;
    e.preventDefault();
    organize.onMove(delta);
  };
  return (
    <article
      className={cx("ac-card wg", className)}
      data-state={status}
      data-kind={spec?.kind}
      data-w={size.w}
      data-h={size.h}
      data-organize={organize ? "" : undefined}
      data-capped={capped || undefined}
      data-cut={cut.cut || undefined}
      aria-label={title}
      aria-busy={status === "building" || status === "updating" || undefined}
      style={{ ...widgetTileVars(color, dark), ...style }}
      {...rest}
    >
      <span className="wg__sweep" aria-hidden="true" />
      <div className="wg__head">
        {face && <span className="wg__face">{face}</span>}
        {onOpen && !organize ? (
          <button type="button" className="wg__title" onClick={onOpen}>
            {title}
          </button>
        ) : (
          <span className="wg__title">{title}</span>
        )}
        {organize ? (
          <span className="wg__arr">
            <button
              type="button"
              className="wg__size"
              aria-label={`${organize.sizeLabel}: ${organize.sizeText}`}
              title={organize.sizeLabel}
              onClick={organize.onSize}
            >
              {organize.sizeText}
            </button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="close"
              aria-label={organize.removeLabel}
              title={organize.removeLabel}
              onClick={organize.onRemove}
            />
            {organize.onMove || organize.grip ? (
              <button
                type="button"
                className="wg__grip"
                aria-label={organize.dragLabel}
                title={organize.dragLabel}
                {...organize.grip}
                onKeyDown={organize.grip?.onKeyDown ?? grip}
              >
                <Icon name="grip" size={16} />
              </button>
            ) : (
              <span className="wg__grip" title={organize.dragLabel}>
                <Icon name="grip" size={16} />
              </span>
            )}
          </span>
        ) : (
          actions && <span className="wg__acts">{actions}</span>
        )}
      </div>
      <div ref={body} className={cx("wg__body", flash && "wg__flash")}>
        <WidgetBody
          spec={spec}
          status={status}
          color={color}
          size={size}
          locale={locale}
          buildingText={buildingText}
          sparkApart
        />
        {board && cut.cut && onOpen && (
          <CardMore
            label={board.seeMore}
            hiddenLabel={cut.hidden ? board.hidden(cut.hidden) : undefined}
            hidden={cut.hidden}
            onOpen={onOpen}
          />
        )}
      </div>
      <div className="wg__foot">{footer}</div>
      <WidgetBleed spec={status === "building" ? null : spec} color={color} size={size} />
      {horizon && <CardHorizon content={body} />}
    </article>
  );
}

/** A number's trend line, drawn apart from its body (`sparkApart`): null for anything else. */
function sparkOf(spec: WidgetSpec | null): KpiWidgetSpec["spark"] | null {
  return spec?.kind === "kpi" && spec.spark && spec.spark.length > 1 ? spec.spark : null;
}

/**
 * A number's trend at the card's bottom, edge to edge under the footer and clipped by the card's corners: the line's
 * dither runs out at the bottom edge and the last point keeps its square inside the card. Null for any other kind.
 */
export function WidgetBleed({
  spec,
  color,
  size,
}: {
  spec: WidgetSpec | null;
  color: string;
  size: { w: 1 | 2; h: 1 | 2 };
}) {
  const spark = sparkOf(spec);
  if (!spark) return null;
  return (
    <div className="wg__bleed">
      <DitherLine className="wk-spark" values={spark} color={color} height={size.h === 2 ? 120 : 56} bleed dot />
    </div>
  );
}

/** True for a moment after the data changed (not on the first draw). */
function useFlash(spec: WidgetSpec | null): boolean {
  const key = spec ? JSON.stringify(spec) : "";
  const before = useRef(key);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (before.current === key) return;
    const had = before.current !== "";
    before.current = key;
    if (!had || !key) {
      setOn(false);
      return;
    }
    setOn(true);
    const timer = setTimeout(() => setOn(false), FLASH_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return on;
}
