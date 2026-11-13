import { Popover as RPopover } from "radix-ui";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { cx } from "../cx";
import { EDGE_ROOM } from "../floating";
import { useFieldControl } from "./Field";

/** Every `step` minutes of the day: "00:00", "00:15", … */
export function timeOptions(step = 15) {
  // Hard bound: at least 15 minutes between options, so at most 96 of them.
  const safe = Number.isFinite(step) ? Math.max(15, Math.round(step)) : 15;
  const out: string[] = [];
  for (let m = 0; m < 24 * 60 && out.length < 96; m += safe) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
}

/** What people type → "HH:MM": "9" → 09:00, "930" → 09:30, "9h15" → 09:15. Null when invalid. */
export function normalizeTime(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return null;
  let h: number;
  let m: number;
  const sep = t.match(/^(\d{1,2})[:h.](\d{0,2})$/);
  if (sep) {
    h = Number(sep[1]);
    m = sep[2] ? Number(sep[2]) : 0;
  } else if (/^\d{1,4}$/.test(t)) {
    if (t.length <= 2) {
      h = Number(t);
      m = 0;
    } else {
      h = Number(t.slice(0, t.length - 2));
      m = Number(t.slice(-2));
    }
  } else return null;
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface TimeSelectProps {
  /** "HH:MM". */
  value: string;
  onChange: (value: string) => void;
  /** Minutes between suggestions (default 15). */
  step?: number;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}

/**
 * Time of day: a text box you can type in ("930", "9h30") with our list of
 * 15-minute steps (combobox pattern: arrows move, Enter picks, Esc closes).
 * Never the native time input.
 */
export function TimeSelect({ value, onChange, step = 15, id, disabled, className, ...rest }: TimeSelectProps) {
  const wiring = useFieldControl({ id });
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  const options = useMemo(() => timeOptions(step), [step]);
  // Follow the value from outside only when it really changes.
  const lastValue = useRef(value);
  useEffect(() => {
    if (lastValue.current === value) return;
    lastValue.current = value;
    setDraft(value);
  }, [value]);

  // Open near the current value; typed digits jump to the first match.
  const typed = draft.replace(/\D/g, "");
  const anchorIndex = (() => {
    const exact = options.indexOf(normalizeTime(draft) ?? value);
    if (exact >= 0) return exact;
    if (typed) {
      const i = options.findIndex((o) => o.replace(":", "").startsWith(typed.padStart(typed.length > 2 ? 4 : 2, "0")));
      if (i >= 0) return i;
    }
    return Math.max(0, options.indexOf(value));
  })();
  useEffect(() => {
    if (!open) return;
    const i = active >= 0 ? active : anchorIndex;
    const box = list.current?.parentElement;
    // Only scroll a list that actually scrolls (never in layout-less test DOMs).
    if (!box || box.scrollHeight <= box.clientHeight) return;
    list.current?.querySelector(`[data-index="${i}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, anchorIndex]);

  const commit = (next: string | null) => {
    if (next && next !== value) onChange(next);
    const shown = next ?? value;
    if (shown !== draft) setDraft(shown);
    if (open) setOpen(false);
    if (active !== -1) setActive(-1);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const from = active >= 0 ? active : anchorIndex;
      const next = open ? from + (e.key === "ArrowDown" ? 1 : -1) : from;
      setOpen(true);
      setActive(Math.min(options.length - 1, Math.max(0, next)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(open && active >= 0 ? (options[active] ?? null) : normalizeTime(draft));
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  };
  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <RPopover.Root
      open={open}
      onOpenChange={(o) => {
        if (o !== open) setOpen(o);
      }}
    >
      <RPopover.Anchor asChild>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          className={cx("ac-input ac-time", className)}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
          aria-label={rest["aria-label"]}
          id={wiring.id}
          aria-describedby={wiring["aria-describedby"]}
          aria-invalid={wiring["aria-invalid"]}
          disabled={disabled}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (active !== -1) setActive(-1);
            if (!open) setOpen(true);
          }}
          onClick={() => {
            if (!open) setOpen(true);
          }}
          onKeyDown={onKey}
          onBlur={() => {
            // Only when something changed: a blur must never reopen or re-render in a loop.
            if (open || draft !== value) commit(normalizeTime(draft));
          }}
        />
      </RPopover.Anchor>
      <RPopover.Portal>
        <RPopover.Content
          className="ac-menu ac-time__list"
          align="start"
          sideOffset={4}
          collisionPadding={EDGE_ROOM}
          // Focus stays in the text box (combobox).
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            const input = document.getElementById(wiring.id ?? "");
            if (e.target instanceof Node && input?.contains(e.target)) e.preventDefault();
          }}
        >
          <div ref={list} role="listbox" id={listId} aria-label={rest["aria-label"]}>
            {options.map((o, i) => (
              <div
                key={o}
                id={optionId(i)}
                role="option"
                tabIndex={-1}
                data-index={i}
                aria-selected={o === value}
                data-active={i === (active >= 0 ? active : -1) || undefined}
                className="ac-menu__item ac-time__option"
                // Keep focus in the text box: pick on pointer down.
                onPointerDown={(e) => {
                  e.preventDefault();
                  commit(o);
                }}
                onClick={() => commit(o)}
                onKeyDown={() => {}}
              >
                <span className="ac-menu__label tabular">{o}</span>
              </div>
            ))}
          </div>
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
