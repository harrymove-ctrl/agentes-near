import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { type StickerMood, WAVE_SECONDS } from "../agent/stickers";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";
import type { MeterSegment } from "../plan-state";
import type { AgentAppearance } from "./AgentLook";
import { AgentSticker } from "./AgentSticker";
import { InfoHint } from "./InfoHint";
import { SkyGlow } from "./PixelSky";
import { ProviderLogo } from "./ProviderLogo";

/** Neutral card (`surface-raised` + `line`). State never tints it: use a Chip. */
export function Card({
  padded,
  className,
  as: Tag = "section",
  ...rest
}: HTMLAttributes<HTMLElement> & { padded?: boolean; as?: "section" | "div" | "article" }) {
  return <Tag className={cx("ac-card", padded && "ac-card--padded", className)} {...rest} />;
}

/**
 * A card's head: the icon on a key, the title (an `h2`, with `id` for `aria-labelledby`), an ⓘ hint after it, a
 * quiet line and an action.
 */
export function CardHeader({
  icon,
  mark,
  title,
  subtitle,
  action,
  id,
  hint,
}: {
  icon?: IconName;
  /** A provider's official logo (`ProviderLogo` id) in place of the icon. */
  mark?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  id?: string;
  /** What the card is for (plain sentences), behind an ⓘ after the title. */
  hint?: { name: string; text: ReactNode };
}) {
  const heading = <h2 id={id}>{title}</h2>;
  return (
    <div className="ac-card__head ac-actline">
      <div className={cx("ac-card__lead", (icon || mark) && "ac-iconline")}>
        {(icon || mark) && (
          <span className="ac-card__key" aria-hidden="true">
            {mark ? <ProviderLogo id={mark} size="xs" /> : icon && <Icon name={icon} size={16} />}
          </span>
        )}
        <div className="ac-card__heading">
          {/* Beside the h2, never in it: the heading's name stays the title alone. */}
          {hint ? (
            <span className="ac-hintline">
              {heading}
              <InfoHint name={hint.name}>{hint.text}</InfoHint>
            </span>
          ) : (
            heading
          )}
          {subtitle && <p className="ac-card__sub">{subtitle}</p>}
        </div>
      </div>
      {action && <span className="ac-card__action">{action}</span>}
    </div>
  );
}

/** Help text at the bottom of a card, in a well ("O contexto da org entra antes destas instruções"). */
export function CardFooter({ children, icon = "info" }: { children: ReactNode; icon?: IconName | null }) {
  return (
    <p className={cx("ac-card__foot", icon && "ac-iconline")}>
      {icon && <Icon name={icon} size={14} />}
      <span>{children}</span>
    </p>
  );
}

/** How long the first-appearance stagger lasts; rows added later don't animate. */
export const LIST_STAGGER_MS = 400;

/** A bordered list of rows (members, invitations, agents). Rows rise in, staggered, only when it first appears. */
export function List({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setEntering(false), LIST_STAGGER_MS);
    return () => clearTimeout(timer);
  }, []);
  return <div className={cx("ac-list", entering && "ac-list--stagger", className)} {...rest} />;
}

export interface ListRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  /** A small avatar or an icon, on the title's first line. */
  lead?: ReactNode;
  /** Whole: a long one wraps. */
  title: string;
  /** A quiet second line ("Hoje · 21:00"). */
  meta?: ReactNode;
  trailing?: ReactNode;
}

/**
 * A neutral clickable row for short side lists (Próximos, recent items):
 * lead, title and meta. No border bar, no tint: it only lifts on hover.
 */
export function ListRow({ lead, title, meta, trailing, className, type = "button", ...rest }: ListRowProps) {
  return (
    <button type={type} className={cx("ac-row", lead ? "ac-iconline" : undefined, className)} {...rest}>
      {lead && <span className="ac-row__lead">{lead}</span>}
      <span className="ac-row__text">
        <span className="ac-row__title">{title}</span>
        {meta && <span className="ac-row__meta">{meta}</span>}
      </span>
      {trailing}
    </button>
  );
}

/** The agent's side in CSS pixels: whole multiples of the sticker's 64-cell grid stay crisp. */
const EMPTY_AGENT = { page: 128, panel: 96 } as const;

export interface EmptyStateProps {
  icon?: IconName;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** An empty place (not an error): a dithered sky glow with a pixel agent instead of the icon. */
  sky?: boolean;
  /** A pixel picture instead of the icon (`AgentSearching`), with no dashed box. Decorative: the words say it. */
  art?: ReactNode;
  /**
   * The room it has, and with it no dashed box: `page` a page or tab, centered in what's left of it; `panel` a side
   * panel, column or card; `inline` a list inside a dropdown, sidebar or sheet, compact and never with an agent.
   * Without it, the dashed box, for an error or a notice in a frame.
   */
  size?: "page" | "panel" | "inline";
  /** The agent standing over the words, in its light: a place's own agent's look, or `true` for the default one. */
  agent?: AgentAppearance | true;
  /** What the agent does. A wave plays once and holds, the other moods loop. */
  mood?: StickerMood;
}

/**
 * What a place is for when nothing is in it. First use: `size` and `agent`, a title that says what the place gives,
 * one line, and one primary button (none for who can't do it: the line says who can). No results: `size` and a way
 * to clear, with no agent. All clear: `agent` with a happy mood and no button. Never for loading or an error.
 */
export function EmptyState({
  icon,
  title,
  children,
  actions,
  className,
  sky,
  art,
  size,
  agent,
  mood = "wave",
}: EmptyStateProps) {
  const stands = agent && size !== "inline";
  const look = agent === true ? undefined : agent;
  return (
    <div
      className={cx(
        "ac-empty",
        size && `ac-empty--${size}`,
        sky && "ac-empty--sky",
        !!art && "ac-empty--art",
        className,
      )}
    >
      {sky && <SkyGlow className="ac-empty__sky" surface="--empty-surface" />}
      {stands && (
        <div className="ac-empty__agent" aria-hidden="true">
          <SkyGlow bare color={look?.color ?? "sky"} surface="--empty-surface" />
          <AgentSticker
            appearance={look}
            mood={mood}
            size={EMPTY_AGENT[size === "panel" ? "panel" : "page"]}
            playFor={mood === "wave" ? WAVE_SECONDS : undefined}
          />
        </div>
      )}
      {!!art && (
        <div className="ac-empty__art" aria-hidden="true">
          {art}
        </div>
      )}
      {icon && !sky && !art && !stands && (
        <span className="ac-empty__icon">
          <Icon name={icon} />
        </span>
      )}
      {title && <p className="ac-empty__title">{title}</p>}
      {children && <p className="ac-empty__text">{children}</p>}
      {actions && <div className="ac-empty__actions">{actions}</div>}
    </div>
  );
}

/** Inline error (or neutral notice) with an icon. */
export function Alert({
  tone = "danger",
  children,
  className,
}: {
  tone?: "danger" | "neutral";
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={cx("ac-alert ac-iconline", tone === "neutral" && "ac-alert--neutral", className)}
    >
      <Icon name="alert" />
      <span>{children}</span>
    </p>
  );
}

/** Usage meter (budget). The bar is ink unless a plan meter sets `--meter-fill` (`.ac-planmeter`). */
export function Meter({
  value,
  max,
  label,
  marks,
  part,
  segments,
}: {
  value: number;
  max: number;
  label: string;
  /** Ticks on the track, in percent (e.g. 80 for "aviso em 80%"). */
  marks?: number[];
  /** A part of `value` in full ink, the rest of the bar lighter (one agent's share of a plan's use). */
  part?: number;
  /** `value` split into pieces from the left, each in its own colours (every agent's share); the rest lighter. */
  segments?: readonly MeterSegment[];
}) {
  const exact = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const pct = Math.round(exact);
  const partPct = part !== undefined && max > 0 ? Math.min(pct, Math.round((part / max) * 100)) : null;
  const split = segments && segments.length > 0 && max > 0 ? segments : null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: the native <meter> has a native look we never show
    <div
      className={cx("ac-meter", (partPct !== null || split) && "ac-meter--parts")}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      {/* Anything above zero keeps a visible sliver, so 0.9% doesn't read as empty. */}
      <div className="ac-meter__bar" style={exact > 0 ? { width: `${pct}%`, minWidth: 6 } : { width: 0 }} />
      {partPct !== null && part !== undefined && part > 0 && (
        <div className="ac-meter__part" style={{ width: `${partPct}%`, minWidth: 6 }} />
      )}
      {split && (
        <div className="ac-meter__segs">
          {split.map((s) => (
            <i
              key={s.key}
              className="ac-meter__seg"
              style={
                {
                  width: `${Math.min(100, (s.value * 100) / max)}%`,
                  "--seg-deep": s.deep,
                  "--seg-light": s.light,
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}
      {marks?.map((m) => (
        <span key={m} className="ac-meter__mark" style={{ left: `${m}%` }} aria-hidden="true" />
      ))}
    </div>
  );
}

/** A selectable card (`aria-pressed`): role presets in onboarding and "Criar agente". */
export function OptionCard({
  pressed,
  onClick,
  agent,
  stacked,
  disabled,
  children,
  className,
}: {
  pressed: boolean;
  onClick: () => void;
  /** Cut corner: the option creates an agent. */
  agent?: boolean;
  stacked?: boolean;
  /** Shown but not choosable now (its words say why). */
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      data-disabled={disabled || undefined}
      className={cx("ac-option", agent && "ac-option--agent", stacked && "ac-option--stacked", className)}
    >
      {children}
    </button>
  );
}

/** Step bars + "Passo 2 de 4 · Contexto": `current` (from 1) is the step under way, the ones before it are done. */
export function Steps({ current, total, label }: { current: number; total: number; label: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="ac-steps" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed number of bars
            key={i}
            className="ac-steps__bar"
            data-done={i < current - 1}
            data-current={i === current - 1 || undefined}
          />
        ))}
      </div>
      <span className="ac-eyebrow">{label}</span>
    </div>
  );
}
