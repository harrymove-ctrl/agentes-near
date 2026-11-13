import { cx } from "../cx";
import { Icon } from "../icons/Icon";

/**
 * "✓ Salvo" beside what a person edits in place and saves on leaving the field (a channel's name and description,
 * a task's title): it fades in when `shown`, the caller turns it off a moment later. The span stays in the page so a
 * screen reader hears it appear.
 */
export function SavedNote({ shown, label, className }: { shown: boolean; label: string; className?: string }) {
  return (
    <span className={cx("ac-saved", className)} data-show={shown || undefined} aria-live="polite">
      {shown && (
        <>
          <Icon name="check" />
          {label}
        </>
      )}
    </span>
  );
}
