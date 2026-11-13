import {
  createContext,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
  useContext,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { cx } from "../cx";
import { InfoHint } from "./InfoHint";
import { SearchField } from "./Toolbar";

interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
  /** A `group` field's label, for a control a `<label>` can't name. */
  labelledBy?: string;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Wiring for a control inside a `Field`: id, `aria-describedby`, `aria-invalid`. */
export function useFieldControl(props: { id?: string; "aria-describedby"?: string; "aria-invalid"?: unknown }) {
  const field = useContext(FieldContext);
  const describedBy = [props["aria-describedby"], field?.describedBy].filter(Boolean).join(" ") || undefined;
  const invalid = props["aria-invalid"] === true || props["aria-invalid"] === "true" || field?.invalid === true;
  return {
    id: props.id ?? field?.id,
    "aria-describedby": describedBy,
    "aria-invalid": invalid || undefined,
    labelledBy: field?.labelledBy,
  };
}

export interface FieldProps {
  label: ReactNode;
  /** Defaults to a generated id. The control picks it up automatically. */
  id?: string;
  /**
   * Under the control only a format example ("ex.: https://acme.com/webhook") or a line that must stay in sight while
   * it is filled in. What the field is for goes behind the ⓘ (`hint`).
   */
  example?: ReactNode;
  /** Shown instead of `example`; marks the control `aria-invalid`. */
  error?: ReactNode;
  /** Something next to the label (e.g. "Esqueci minha senha"). */
  labelAside?: ReactNode;
  /** An ⓘ right after the label with what the field is for (plain sentences); it also describes the control. */
  hint?: { name: string; text: ReactNode };
  /** The control is a group of its own (`Segmented`): the label names it by `aria-labelledby`. */
  group?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}

/** A form field: always-visible label, optional ⓘ hint, a format example or an error under it, wired to its control. */
export function Field({ label, id, example, error, labelAside, hint, group, className, style, children }: FieldProps) {
  const generated = useId();
  const controlId = id ?? `f${generated.replace(/:/g, "")}`;
  const helpId = `${controlId}-help`;
  const hintId = `${controlId}-hint`;
  const showError = error !== undefined && error !== null && error !== false;
  const showHelp = !showError && example !== undefined && example !== null && example !== false;
  const describedBy = [showError || showHelp ? helpId : "", hint ? hintId : ""].filter(Boolean).join(" ");
  const labelId = `${controlId}-label`;
  const labelOnly = group ? (
    <span className="ac-field__label" id={labelId}>
      {label}
    </span>
  ) : (
    <label className="ac-field__label" htmlFor={controlId}>
      {label}
    </label>
  );
  // The ⓘ sits outside the <label>: the label stays the control's name, and pressing the ⓘ never reaches the control.
  const labelEl = hint ? (
    <span className="ac-hintline">
      {labelOnly}
      <InfoHint name={hint.name} id={hintId}>
        {hint.text}
      </InfoHint>
    </span>
  ) : (
    labelOnly
  );
  return (
    <FieldContext.Provider
      value={{
        id: controlId,
        describedBy: describedBy || undefined,
        invalid: showError,
        labelledBy: group ? labelId : undefined,
      }}
    >
      <div className={cx("ac-field", className)} style={style}>
        {labelAside ? (
          <div className="ac-field__label-row">
            {labelEl}
            {labelAside}
          </div>
        ) : (
          labelEl
        )}
        {children}
        {showHelp && (
          <span id={helpId} className="ac-field__example">
            {example}
          </span>
        )}
        {showError && (
          <span id={helpId} className="ac-field__error">
            {error}
          </span>
        )}
      </div>
    </FieldContext.Provider>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, invalid, ...rest }, ref) {
  const { labelledBy: _, ...wiring } = useFieldControl({ ...rest, "aria-invalid": invalid ?? rest["aria-invalid"] });
  return <input ref={ref} className={cx("ac-input", className)} {...rest} {...wiring} />;
});

/**
 * Fields under each other: every field, note and group the same `--form-gap` apart, more than a field's label and
 * help sit from its control (`--field-gap`). A dialog's `DialogBody` keeps the same rhythm.
 */
export function FormStack({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ac-form", className)} {...rest} />;
}

/** A form's buttons outside a dialog, the primary last, as `DialogFooter` lays them out in one. */
export function FormActions({
  note,
  className,
  children,
}: {
  note?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cx("ac-form__actions", className)}>
      {note !== undefined && <span className="ac-dialog__foot-note">{note}</span>}
      {children}
    </div>
  );
}

const LockedContext = createContext(false);

/** True inside a `Locked` that's on: for what a fieldset can't reach, such as a contenteditable or a drop zone. */
export function useLocked() {
  return useContext(LockedContext);
}

/**
 * `<Locked when={sending}>` turns off every control inside, keeping its text, while its action runs or once its result
 * is final. A Cancel that really cancels stays outside. CSS says `:disabled`, never `[disabled]`, to see a fieldset's.
 */
export function Locked({ when, children }: { when: boolean; children: ReactNode }) {
  const outer = useLocked();
  const box = useRef<HTMLFieldSetElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  // Read while rendering: by a layout effect Chromium has already taken the focus off a disabled control.
  if (when && !focused.current) {
    const active = document.activeElement;
    if (active instanceof HTMLElement && box.current?.contains(active)) focused.current = active;
  }
  useLayoutEffect(() => {
    if (when) return;
    const active = document.activeElement;
    if (!active || active === document.body) focused.current?.focus({ preventScroll: true });
    focused.current = null;
  }, [when]);
  return (
    <LockedContext.Provider value={when || outer}>
      <fieldset ref={box} className="ac-locked" disabled={when}>
        {children}
      </fieldset>
    </LockedContext.Provider>
  );
}

/** A border-box height that fits the text: `scrollHeight` leaves the border out. */
function fitText(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

/**
 * A section's heading inside a picker's list ("Papéis"), with the line under it that says what picking one means: a
 * real gap between the two, as a field's label and its help have.
 */
export function PickerHeading({ label, description }: { label: ReactNode; description?: ReactNode }) {
  return (
    <div className="ac-picker-head">
      <span className="ac-field__label">{label}</span>
      {description && <span className="ac-picker-head__desc">{description}</span>}
    </div>
  );
}

/**
 * A textarea as tall as its text (up to its CSS max-height), measured again when the text changes and when a new
 * width rewraps it (a window resize, a sidebar opening). `on` false leaves its height alone.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, on = true) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again whenever the text changes
  useLayoutEffect(() => {
    if (on && ref.current) fitText(ref.current);
  }, [ref, value, on]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitText(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, on]);
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** As tall as its text (a controlled `value`), growing and shrinking with it. */
  autoGrow?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, rows = 4, autoGrow = false, ...rest },
  ref,
) {
  const { labelledBy: _, ...wiring } = useFieldControl({ ...rest, "aria-invalid": invalid ?? rest["aria-invalid"] });
  const box = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => box.current as HTMLTextAreaElement, []);
  useAutoGrow(box, String(rest.value ?? ""), autoGrow);
  return <textarea ref={box} rows={rows} className={cx("ac-input", className)} {...rest} {...wiring} />;
});

/**
 * Input with a fixed prefix, e.g. "agentes.chat/" + address, or a small action inside its end (a ghost `sm` icon
 * button: the + that adds what's typed).
 */
export const AffixInput = forwardRef<HTMLInputElement, InputProps & { prefix?: ReactNode; action?: ReactNode }>(
  function AffixInput({ prefix, action, className, invalid, ...rest }, ref) {
    const { labelledBy: _, ...wiring } = useFieldControl({ ...rest, "aria-invalid": invalid ?? rest["aria-invalid"] });
    return (
      <div className={cx("ac-input-affix", className)}>
        {prefix && <span className="ac-input-affix__prefix">{prefix}</span>}
        <input ref={ref} {...rest} {...wiring} />
        {action && <span className="ac-input-affix__action">{action}</span>}
      </div>
    );
  },
);

/**
 * Search box above a list: the shared SearchField (a field of the ruler; `size="sm"` in
 * dialogs and panels). Kept under this name for existing screens.
 */
export const SearchInput = SearchField;
