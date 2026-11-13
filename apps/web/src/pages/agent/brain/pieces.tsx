import type { BrainSpeed, PlanUsage } from "@agenteschat/client";
import { SPEEDS } from "@agenteschat/client/lib/brain-advanced";
import { type ContextLimit, contextSize } from "@agenteschat/client/lib/context-limits";
import { planMeterText } from "@agenteschat/client/lib/plan-usage";
import { AUTO } from "@agenteschat/client/lib/providers";
import {
  Icon,
  InfoHint,
  planLevel,
  planLine,
  planWindows,
  prefersReducedMotion,
  Radio,
  RadioGroup,
  Segmented,
  Switch,
} from "@agenteschat/ui";
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

/*
 * The pieces of "Quem pensa" (ADR 0032 §5, addendum 2026-11-10), drawn like the rest of the dialogs under the sky: no
 * card inside the dialog, a line per setting (its name, then its value), state in words.
 */

/**
 * The account's limits under its row, one line per window: its name, a bar, how much is used and when it renews
 * ("Semana ▬ 86% renova sáb 18:00"). Numbers out of date say how old they are.
 */
export function PlanWindows({ usage }: { usage: PlanUsage }) {
  const { t, i18n } = useTranslation();
  const text = planMeterText(t, i18n.language);
  const now = Date.now();
  const rows = planWindows(usage, now);
  const line = planLine(usage, text, now);
  if (rows.length === 0) return null;
  return (
    <div className="bd-wins">
      {rows.map((w, i) => {
        const name = text.window(w);
        const renews = w.resetsAt && Date.parse(w.resetsAt) > now ? text.resets(w.resetsAt) : null;
        return (
          <div key={`${w.kind}:${w.label ?? i}`} className="bd-win" data-level={planLevel(w.used)}>
            <span className="bd-win__name">{name}</span>
            <span className="bd-win__bar" aria-hidden="true">
              <i style={{ "--used": `${Math.min(100, w.used)}%` } as CSSProperties} />
            </span>
            <span className="bd-win__n">{w.used}%</span>
            <small className="bd-win__at">{renews}</small>
          </div>
        );
      })}
      {line?.stale && line.age && <small className="bd-wins__age">{line.age}</small>}
    </div>
  );
}

/**
 * A setting on one line: its name, its value, and the way in (a chevron to its screen, or down for what opens under
 * it). Without `onOpen` it only says the value.
 */
export function BrainLine({
  label,
  value,
  lead,
  onOpen,
  folds = false,
  opensDialog = false,
  open = false,
  controls,
}: {
  label: string;
  value: ReactNode;
  lead?: ReactNode;
  onOpen?: () => void;
  /** It opens under itself (`Fold`), not a screen of its own. */
  folds?: boolean;
  /** It opens a dialog of its own over this one; else it goes on to another screen of the same dialog. */
  opensDialog?: boolean;
  open?: boolean;
  /** The fold it opens. */
  controls?: string;
}) {
  const body = (
    <>
      <span className="bd-line__k">{label}</span>
      <span className="bd-line__v">
        {lead}
        <span className="bd-line__text">{value}</span>
      </span>
    </>
  );
  if (!onOpen) return <div className="bd-line bd-line--still">{body}</div>;
  return (
    <button
      type="button"
      className="bd-line"
      onClick={onOpen}
      {...(folds
        ? { "aria-expanded": open, "aria-controls": controls }
        : opensDialog
          ? { "aria-haspopup": "dialog" as const }
          : {})}
    >
      {body}
      <Icon name={folds ? "chevronDown" : "chevronRight"} size={16} className="bd-line__chev" />
    </button>
  );
}

/** What a line opens under itself: it grows open and closes back, out of reach while closed. */
export function Fold({ id, open, children }: { id: string; open: boolean; children: ReactNode }) {
  return (
    <div className="bd-fold" id={id} data-open={open || undefined}>
      <div className="bd-fold__clip" inert={!open}>
        <div className="bd-fold__in">{children}</div>
      </div>
    </div>
  );
}

/**
 * A switch on its line: the words first, their ⓘ right after them (outside the label, so pressing it never flips the
 * switch), the switch at the end on the first line.
 */
export function SwitchLine({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="bd-switch">
      <span className="bd-switch__k ac-hintline">
        <label htmlFor={id}>{label}</label>
        {hint && (
          <InfoHint name={t("common.about", { label })} id={`${id}-hint`}>
            {hint}
          </InfoHint>
        )}
      </span>
      <Switch
        id={id}
        {...(hint ? { "aria-describedby": `${id}-hint` } : {})}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}

/** Velocidade: Padrão or Rápida, and what Rápida costs. */
export function SpeedField({ value, onChange }: { value: BrainSpeed; onChange: (value: BrainSpeed) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <Segmented
        className="agp-brainseg"
        label={t("agentPage.work.brain.speed")}
        value={value}
        onValueChange={onChange}
        options={SPEEDS.map((s) => ({ value: s, label: t(`agentPage.work.brain.speeds.${s}`) }))}
      />
      <p className="bd-fold__hint">{t("agentPage.work.brain.speedText")}</p>
    </>
  );
}

/** The context limit: Automático, then the sizes under the model's window, with what the chosen one means. */
export function ContextField({
  value,
  options,
  onChange,
}: {
  value: ContextLimit | null;
  options: readonly ContextLimit[];
  onChange: (value: ContextLimit | null) => void;
}) {
  const { t } = useTranslation();
  const shown = value !== null && options.includes(value) ? value : null;
  return (
    <>
      <Segmented
        className="agp-brainseg"
        label={t("agentPage.work.brain.context")}
        value={shown === null ? AUTO : String(shown)}
        onValueChange={(v) => onChange(v === AUTO ? null : (options.find((n) => String(n) === v) ?? null))}
        options={[
          { value: AUTO, label: t("brain.auto.label") },
          ...options.map((n) => ({ value: String(n), label: contextSize(n) })),
        ]}
      />
      <p className="bd-fold__hint">{t(`agentPage.work.brain.contextText.${shown ?? "auto"}`)}</p>
    </>
  );
}

/** One choice of a list of choices (the models, the computers): its name, its line, what it needs. */
export interface PickOption {
  value: string;
  label: string;
  description?: string;
  /** A third line, quieter: what it needs from the plan's account. */
  hint?: string;
  group?: string;
  disabled?: boolean;
  /** More words a search finds it by. */
  keywords?: string;
}

/** Past this many choices the list scrolls under a search. */
const PICKS_SEARCHED = 10;

/**
 * Choices as rows with a radio, the same rows as the accounts' without a mark: grouped under their maker where there
 * are several, a long list under a search.
 */
export function PickList({
  options,
  value,
  onChange,
  label,
  searchLabel,
}: {
  options: readonly PickOption[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  /** The search's words, for a long list. */
  searchLabel?: string;
}) {
  const { t } = useTranslation();
  const dom = useId();
  const [query, setQuery] = useState("");
  const long = options.length > PICKS_SEARCHED && searchLabel !== undefined;
  // Each word on its own, so a maker's name and the model's ("nvidia free") find it in any order.
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length
    ? options.filter((o) => {
        const text = `${o.label} ${o.group ?? ""} ${o.keywords ?? ""}`.toLowerCase();
        return words.every((w) => text.includes(w));
      })
    : options;
  const grouped = new Set(options.map((o) => o.group ?? "")).size > 1;
  const row = (o: PickOption) => (
    <label
      key={o.value}
      htmlFor={`${dom}-${o.value}`}
      className="arrival-have__row bd-pick"
      data-state={o.value === value ? "checked" : "unchecked"}
      data-disabled={o.disabled ? "" : undefined}
    >
      <Radio value={o.value} id={`${dom}-${o.value}`} disabled={o.disabled} />
      <span className="arrival-have__text">
        <span className="arrival-have__title">{o.label}</span>
        {o.description && <span className="arrival-have__line">{o.description}</span>}
        {o.hint && <span className="arrival-have__line bd-pick__hint">{o.hint}</span>}
      </span>
    </label>
  );
  const groups: { name: string; rows: PickOption[] }[] = [];
  for (const o of shown) {
    const name = o.group ?? "";
    const group = groups.find((x) => x.name === name);
    if (group) group.rows.push(o);
    else groups.push({ name, rows: [o] });
  }
  const list =
    shown.length === 0 ? (
      <p className="arrival-have__none">{t("models.noResults")}</p>
    ) : (
      groups.map((x) => (
        <Fragment key={x.name || "-"}>
          {grouped && x.name && words.length === 0 && <p className="arrival-opts__label">{x.name}</p>}
          {x.rows.map(row)}
        </Fragment>
      ))
    );
  return (
    <RadioGroup className="arrival-have" aria-label={label} value={value} onValueChange={onChange}>
      {long ? (
        <>
          <label className="arrival-have__search">
            <Icon name="search" size={16} />
            <input
              type="search"
              value={query}
              placeholder={searchLabel}
              aria-label={searchLabel}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="arrival-have__scroll">{list}</div>
        </>
      ) : (
        list
      )}
    </RadioGroup>
  );
}

/**
 * The dialog's height glides from one screen to the next (`key` changes) instead of jumping: the box keeps its old
 * height for a frame, then eases to the new one. Nothing moves with reduced motion.
 */
export function useGlide<T extends HTMLElement>(key: unknown) {
  const ref = useRef<T>(null);
  const last = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new screen (`key`) glides from the last height
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = last.current;
    el.style.height = "";
    el.style.transition = "";
    const to = el.getBoundingClientRect().height;
    last.current = to;
    if (from === null || Math.abs(from - to) < 2 || prefersReducedMotion()) return;
    el.style.height = `${from}px`;
    void el.offsetHeight;
    el.style.transition = "height 280ms cubic-bezier(0.2, 0.8, 0.2, 1)";
    el.style.height = `${to}px`;
    const settle = () => {
      el.style.height = "";
      el.style.transition = "";
    };
    const timer = setTimeout(settle, 340);
    el.addEventListener("transitionend", settle, { once: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener("transitionend", settle);
    };
  }, [key]);
  // What changes inside one screen (a line opening, a note) moves where the next glide starts from.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      if (!el.style.height) last.current = el.getBoundingClientRect().height;
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return ref;
}
