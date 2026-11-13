import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { cx } from "../cx";
import { PixelSpinner } from "./PixelSpinner";

/** Skeletons wait this long before showing: fast loads never flash. */
export const SKELETON_DELAY_MS = 150;

/** True once `active` has lasted `ms` (false again as soon as it stops). */
export function useDelayed(active: boolean, ms = SKELETON_DELAY_MS) {
  const [shown, setShown] = useState(active && ms <= 0);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    if (ms <= 0) {
      setShown(true);
      return;
    }
    const timer = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return shown;
}

export interface SkeletonProps {
  /** `line`: a text bar; `block`: a rectangle; `circle` / `square`: avatars (square = agent, cut corner). */
  shape?: "line" | "block" | "circle" | "square";
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}

/** One placeholder shape (decorative: the group carries the label). */
export function Skeleton({ shape = "line", width, height, className, style }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cx("ac-skeleton", `ac-skeleton--${shape}`, className)}
      style={{ width, height, ...style }}
    />
  );
}

/** A skeleton that takes over from one on screen this recently (the next stage of the same load) shows at once. */
const TAKE_OVER_MS = 300;
let groupsOnScreen = 0;
let lastOnScreenAt = 0;

/** A skeleton is on screen, or was a moment ago: what replaces it continues it (no blank gap, no second entrance). */
export const skeletonOnScreen = () => groupsOnScreen > 0 || Date.now() - lastOnScreenAt < TAKE_OVER_MS;

/**
 * A loading region: `role="status"` with a label ("Carregando mensagens"). Its
 * shapes take their final size at once (no layout shift) but stay invisible
 * for `delayMs`, so fast loads never flash. One that takes over from another
 * on screen shows at once: the load goes on, it doesn't blank and start again.
 */
export function SkeletonGroup({
  label,
  delayMs = SKELETON_DELAY_MS,
  className,
  children,
}: {
  label: string;
  delayMs?: number;
  className?: string;
  children: ReactNode;
}) {
  const [takesOver] = useState(skeletonOnScreen);
  const visible = useDelayed(true, takesOver ? 0 : delayMs);
  useEffect(() => {
    if (!visible) return;
    groupsOnScreen += 1;
    return () => {
      groupsOnScreen -= 1;
      lastOnScreenAt = Date.now();
    };
  }, [visible]);
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className={cx("ac-skeleton-group", className)}
      data-visible={visible || undefined}
    >
      {children}
    </div>
  );
}

// Varied but stable widths, so rows don't look stamped.
const WIDTHS = ["92%", "74%", "58%", "84%", "66%", "40%", "78%"];
const width = (i: number) => WIDTHS[i % WIDTHS.length] ?? "70%";

/** A chat message: avatar, a name bar and 1–3 lines; `grouped` = a follow-up (no avatar or name). */
export function SkeletonMessage({
  lines = 2,
  grouped,
  agent,
  seed = 0,
}: {
  lines?: number;
  grouped?: boolean;
  agent?: boolean;
  seed?: number;
}) {
  return (
    <div className={cx("ac-skeleton-msg", grouped && "ac-skeleton-msg--grouped")}>
      {grouped ? (
        <span className="ac-skeleton-msg__gutter" />
      ) : (
        <Skeleton shape={agent ? "square" : "circle"} width="var(--name-face)" height="var(--name-face)" />
      )}
      <div className="ac-skeleton-msg__body">
        {!grouped && <Skeleton width={seed % 2 ? 96 : 128} height={12} />}
        {Array.from({ length: lines }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder lines
          <Skeleton key={i} width={width(seed + i)} />
        ))}
      </div>
    </div>
  );
}

/** A list row: optional avatar, a title and a subtitle, an optional trailing bit. */
export function SkeletonRow({
  avatar = true,
  trailing,
  seed = 0,
}: {
  avatar?: boolean;
  trailing?: boolean;
  seed?: number;
}) {
  return (
    <div className="ac-skeleton-row">
      {avatar && <Skeleton shape="circle" width={28} height={28} />}
      <div className="ac-skeleton-row__text">
        <Skeleton width={width(seed + 2)} style={{ maxWidth: 220 }} />
        <Skeleton width={width(seed + 4)} height={10} style={{ maxWidth: 320 }} />
      </div>
      {trailing && <Skeleton width={64} height={20} />}
    </div>
  );
}

/** A card: a title bar and a few lines. */
export function SkeletonCard({ lines = 3, seed = 0 }: { lines?: number; seed?: number }) {
  return (
    <div className="ac-skeleton-card">
      <Skeleton width="40%" height={14} />
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder lines
        <Skeleton key={i} width={width(seed + i)} />
      ))}
    </div>
  );
}

const CONVERSATION = [
  { lines: 2 },
  { lines: 1, grouped: true },
  { lines: 3, agent: true },
  { lines: 1 },
  { lines: 2, agent: true },
  { lines: 1, grouped: true, agent: true },
];

/**
 * The messages of `SkeletonConversation`, for a loading view that holds them in its own group (a whole conversation
 * loading): the same rows, so the view that follows it keeps them where they are.
 */
export function SkeletonConversationRows({ count = 6 }: { count?: number }) {
  return (
    <div className="ac-skeleton-conversation">
      {Array.from({ length: count }, (_, i) => {
        const p = CONVERSATION[i % CONVERSATION.length] ?? { lines: 1 };
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
        return <SkeletonMessage key={i} seed={i} {...p} />;
      })}
    </div>
  );
}

/** A realistic conversation: mixed authors, some grouped follow-ups, 1–3 lines each. */
export function SkeletonConversation({ label, count = 6 }: { label: string; count?: number }) {
  return (
    <SkeletonGroup label={label}>
      <SkeletonConversationRows count={count} />
    </SkeletonGroup>
  );
}

/** `count` rows of a list (members, PCs, routines, search results…). */
export function SkeletonList({
  label,
  count = 4,
  avatar = true,
  trailing,
  className,
}: {
  label: string;
  count?: number;
  avatar?: boolean;
  trailing?: boolean;
  className?: string;
}) {
  return (
    <SkeletonGroup label={label} className={className}>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
        <SkeletonRow key={i} seed={i} avatar={avatar} trailing={trailing} />
      ))}
    </SkeletonGroup>
  );
}

/**
 * A thin indeterminate bar at the top of a region: cached data is on screen
 * and a refresh is running. Waits `delayMs` like skeletons.
 */
export function TopProgress({
  active,
  label,
  delayMs = SKELETON_DELAY_MS,
}: {
  active: boolean;
  label: string;
  delayMs?: number;
}) {
  const shown = useDelayed(active, delayMs);
  if (!shown) return null;
  return <div className="ac-top-progress" role="progressbar" aria-label={label} aria-busy="true" />;
}

/**
 * Inline spinner (buttons, long actions): the pixel orbit, neutral. Decorative:
 * the control says what's happening. Under 16 it is the 14px orbit.
 */
export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <PixelSpinner size={size >= 32 ? 32 : size >= 24 ? 24 : size >= 16 ? 16 : 14} className={className} />;
}
