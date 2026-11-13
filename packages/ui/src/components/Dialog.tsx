import { Dialog as RDialog } from "radix-ui";
import {
  Children,
  type CSSProperties,
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { cx } from "../cx";
import { focusHeld, lastTabbable } from "../device";
import { Button } from "./Button";
import { SearchField } from "./Toolbar";

/** What a form inside a dialog says of its unsaved writing (`useUnsavedInDialog`), by the form. */
export const UnsavedContext = createContext<((form: object, unsaved: boolean) => void) | null>(null);

/**
 * The forms inside a dialog that hold unsaved writing (`useUnsavedInDialog`): read when a press outside or Esc comes,
 * so a keystroke redraws nothing.
 */
export function useUnsavedForms() {
  const forms = useRef(new Set<object>());
  const report = useCallback((form: object, unsaved: boolean) => {
    if (unsaved) forms.current.add(form);
    else forms.current.delete(form);
  }, []);
  return { report, held: () => forms.current.size > 0 };
}

/**
 * A form inside a `Dialog` or `DetailsDialog` (a step of a flow, an editor in the details) holds unsaved writing: the
 * dialog stays open on a press outside or Esc, as with its own `unsaved`.
 */
export function useUnsavedInDialog(unsaved: boolean) {
  const report = useContext(UnsavedContext);
  const [form] = useState(() => ({}));
  useEffect(() => {
    report?.(form, unsaved);
    return () => report?.(form, false);
  }, [report, form, unsaved]);
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Optional sentence under the title (also the accessible description). */
  description?: ReactNode;
  /**
   * At the end of the description's line but outside it (an ⓘ): the dialog stays described by the sentence alone,
   * without the ⓘ's name.
   */
  descriptionAside?: ReactNode;
  /** Accessible name of the close button, e.g. "Fechar". */
  closeLabel: string;
  /** 440 (short forms) or 600 (lists, the default). */
  width?: number;
  children: ReactNode;
  className?: string;
  /** Esc pressed: call `preventDefault()` to keep the dialog open (e.g. close an inner pane first). */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  /** Before the title (an avatar). */
  leading?: ReactNode;
  /** A live line under the title (`aria-live`): what the dialog shows now. */
  subtitle?: ReactNode;
  /** The head's own actions, before the close button. */
  actions?: ReactNode;
  /**
   * The field the dialog starts on. Unlike `autoFocus`, it holds when the dialog opens over another one: React gives
   * an autoFocus field the focus before this dialog's trap is up, and the trap of the dialog under it takes it back.
   */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * The content is a screen of its own with its own way out (a flow's ×): no head, the title for screen readers only,
   * `closeLabel` unused.
   */
  bare?: boolean;
  /**
   * It holds what the person wrote and hasn't saved: a press outside or Esc leaves it open, only its own buttons and ×
   * close it (a side panel keeps a filled field the same way).
   */
  unsaved?: boolean;
}

/**
 * Modal dialog (Radix Dialog: focus trap, Esc, focus returns to the trigger,
 * portal, `aria-modal`). Our visuals: radius-lg, overlay shadow, scrim.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  descriptionAside,
  closeLabel,
  width = 600,
  children,
  className,
  onEscapeKeyDown,
  leading,
  subtitle,
  actions,
  initialFocus,
  bare = false,
  unsaved = false,
}: DialogProps) {
  // Controlled dialogs have no Radix Trigger to return focus to, so remember
  // what had focus when it opened and give focus back on close.
  const wasOpen = useRef(false);
  const returnTo = useRef<HTMLElement | null>(null);
  if (open && !wasOpen.current && typeof document !== "undefined") {
    returnTo.current = document.activeElement as HTMLElement | null;
  }
  wasOpen.current = open;
  // Toasts float over the dialog: pressing one isn't pressing outside it, which would close it. Read as the press
  // starts, since a toast's own button can remove the toast before Radix looks, at the click.
  const onToast = useRef(false);
  useEffect(() => {
    if (!open) return;
    const pressed = (e: PointerEvent) => {
      onToast.current = e.target instanceof Element && e.target.closest(".ac-toasts") !== null;
    };
    document.addEventListener("pointerdown", pressed, true);
    return () => document.removeEventListener("pointerdown", pressed, true);
  }, [open]);
  const forms = useUnsavedForms();
  const keep = () => unsaved || forms.held();
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="ac-dialog__scrim" />
        <RDialog.Content
          className={cx("ac-dialog", className)}
          style={{ "--ac-dialog-width": `${width}px` } as CSSProperties}
          onEscapeKeyDown={(e) => {
            onEscapeKeyDown?.(e);
            if (keep()) e.preventDefault();
          }}
          // Focus starts on `initialFocus` or the dialog itself (the event's target), never on its first control, the
          // head's ×: opened from a link or by itself, a ring would sit on × with nothing pressed. Tab reaches × first;
          // a field that takes the focus on its own (autoFocus) keeps it, since Radix asks only when nothing inside
          // has it.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (initialFocus?.current ?? (e.target as HTMLElement)).focus();
          }}
          // From there, Shift+Tab goes round to the last control, as Tab from the last goes to the first (Radix wraps
          // only from its first and last controls).
          onKeyDown={(e) => {
            if (e.key !== "Tab" || !e.shiftKey || e.target !== e.currentTarget) return;
            const last = lastTabbable(e.currentTarget);
            if (!last) return;
            e.preventDefault();
            last.focus();
          }}
          onPointerDownOutside={(e) => {
            if (onToast.current || keep()) e.preventDefault();
          }}
          // React passes a portal's events up the component tree: a form sent in a dialog opened from another
          // dialog's form would send that form too.
          onSubmit={(e) => e.stopPropagation()}
          onCloseAutoFocus={(e) => {
            const target = returnTo.current;
            if (focusHeld()) e.preventDefault();
            else if (target?.isConnected) {
              e.preventDefault();
              target.focus();
            }
          }}
          // Without a description, tell Radix there is none (it warns otherwise).
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          {bare ? (
            <RDialog.Title className="ac-visually-hidden">{title}</RDialog.Title>
          ) : (
            <div className="ac-dialog__head">
              {leading && <span className="ac-dialog__lead">{leading}</span>}
              {/* Actions that don't fit beside the title go under it, the × stays on the title's line. */}
              <div className="ac-actline">
                {subtitle === undefined ? (
                  <RDialog.Title className="ac-dialog__title">{title}</RDialog.Title>
                ) : (
                  <span className="ac-dialog__titles">
                    <RDialog.Title className="ac-dialog__title">{title}</RDialog.Title>
                    <span className="ac-dialog__sub" aria-live="polite">
                      {subtitle}
                    </span>
                  </span>
                )}
                {actions && <span className="ac-dialog__acts ac-acts">{actions}</span>}
              </div>
              <span className="ac-dialog__close ac-acts">
                <RDialog.Close asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon="close"
                    className="ac-btn--glyph"
                    aria-label={closeLabel}
                  />
                </RDialog.Close>
              </span>
            </div>
          )}
          {description &&
            (descriptionAside ? (
              <p className="ac-dialog__desc">
                <RDialog.Description asChild>
                  <span>{description}</span>
                </RDialog.Description>{" "}
                {descriptionAside}
              </p>
            ) : (
              <RDialog.Description className="ac-dialog__desc">{description}</RDialog.Description>
            ))}
          <UnsavedContext.Provider value={forms.report}>{children}</UnsavedContext.Provider>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function DialogBody({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ac-dialog__body", className)} {...rest} />;
}

export function DialogFooter({
  note,
  bar,
  className,
  children,
}: {
  note?: ReactNode;
  /** Footer separated by a line (lists). */
  bar?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  // An empty footer would only stack its padding under the content: the body or list above keeps the edge instead.
  if (note == null && Children.toArray(children).length === 0) return null;
  // Beside a note the buttons are one group, so a row too narrow for both never splits them one over the other.
  return (
    <div className={cx("ac-dialog__foot", bar && "ac-dialog__foot--bar", className)}>
      {note !== undefined ? (
        <>
          <span className="ac-dialog__foot-note">{note}</span>
          <div className="ac-dialog__foot-acts">{children}</div>
        </>
      ) : (
        children
      )}
    </div>
  );
}

export interface DialogSearchListProps {
  query: string;
  onQueryChange: (query: string) => void;
  searchLabel: string;
  searchPlaceholder?: string;
  /** Shown instead of the list when nothing matches. */
  emptyText: ReactNode;
  isEmpty: boolean;
  children: ReactNode;
  listLabel?: string;
  /** False hides the search field (a short list doesn't need one). */
  search?: boolean;
}

/** The searchable-list variant: search box on top, scrolling list, empty message. */
export function DialogSearchList({
  query,
  onQueryChange,
  searchLabel,
  searchPlaceholder,
  emptyText,
  isEmpty,
  children,
  listLabel,
  search = true,
}: DialogSearchListProps) {
  return (
    <>
      {search && (
        <div className="ac-dialog__tools">
          <SearchField
            size="sm"
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
        </div>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
      <div className="ac-dialog__list" role="region" aria-label={listLabel}>
        {isEmpty ? <p className="ac-dialog__empty">{emptyText}</p> : children}
      </div>
    </>
  );
}
