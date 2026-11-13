import { type ClipboardEvent, type KeyboardEvent, useRef } from "react";
import { cx } from "../cx";

export interface CodeInputProps {
  /** How many boxes (one character each). */
  length: number;
  /** The code so far (at most `length` characters). */
  value: string;
  onChange: (value: string) => void;
  /** The whole code's accessible name ("Verification code"): the group of boxes. */
  label: string;
  /** Each box's accessible name ("Digit 2 of 6"). */
  boxLabel: (position: number, length: number) => string;
  /** Digits only (the default) with the phone's number pad; false takes letters too. */
  numeric?: boolean;
  /** Every box filled (typed, pasted or filled in by the system's one-time-code suggestion). */
  onComplete?: (value: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}

const keep = (text: string, numeric: boolean) => (numeric ? text.replace(/\D/g, "") : text.replace(/[^0-9a-z]/gi, ""));

/**
 * A code typed one character per box (a sign-in's verification code an agent's browser types, ADR 0144). Typing moves
 * to the next box, Backspace on an empty box goes back and clears it, arrows move, and a paste or the system's
 * one-time-code suggestion fills every box from the one it lands in. Each box is a field of the ruler (`ac-input`), so
 * it looks and focuses like any field.
 */
export function CodeInput({
  length,
  value,
  onChange,
  label,
  boxLabel,
  numeric = true,
  onComplete,
  invalid,
  disabled,
  autoFocus,
  className,
}: CodeInputProps) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const chars = Array.from({ length }, (_, i) => value[i] ?? "");
  const focus = (i: number) => {
    const el = boxes.current[Math.max(0, Math.min(length - 1, i))];
    el?.focus();
    el?.select();
  };
  /**
   * Puts `text` in from box `at` on, and moves to the first empty box. The code is one string, so it never has a hole:
   * a character typed past an empty box lands in the first empty one.
   */
  const put = (at: number, text: string) => {
    const clean = keep(text, numeric);
    if (!clean) return;
    const next = chars.slice();
    let i = at;
    for (const c of clean) {
      if (i >= length) break;
      next[i] = c;
      i += 1;
    }
    const code = next.join("").slice(0, length);
    onChange(code);
    focus(code.length);
    if (code.length === length) onComplete?.(code);
  };
  const clear = (i: number) => {
    const next = chars.slice();
    next[i] = "";
    // The boxes after a cleared one move left, so the code never has a hole in the middle.
    onChange(next.join(""));
  };
  const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (chars[i]) clear(i);
      else if (i > 0) {
        clear(i - 1);
        focus(i - 1);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focus(i - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focus(i + 1);
    }
  };
  const onPaste = (i: number) => (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    put(i, e.clipboardData.getData("text"));
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: one labelled group of boxes, not a fieldset with a legend
    <div role="group" aria-label={label} className={cx("ac-code", className)}>
      {chars.map((c, i) => (
        <input
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed row of boxes, one per position
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          className="ac-input ac-code__box"
          value={c}
          inputMode={numeric ? "numeric" : "text"}
          // Only the first box takes the system's suggestion: it brings the whole code, spread by `put`.
          autoComplete={i === 0 ? "one-time-code" : "off"}
          autoCapitalize="off"
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: the code is the only thing to fill in where it shows
          autoFocus={autoFocus && i === 0}
          disabled={disabled}
          aria-label={boxLabel(i + 1, length)}
          aria-invalid={invalid || undefined}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const typed = e.target.value;
            // A box holds one character: what is new is what isn't the one already there.
            put(i, typed.length > 1 && typed.startsWith(c) ? typed.slice(c.length) : typed);
          }}
          onKeyDown={onKeyDown(i)}
          onPaste={onPaste(i)}
          data-1p-ignore
        />
      ))}
    </div>
  );
}
