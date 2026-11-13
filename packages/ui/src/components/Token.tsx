import type { ReactNode } from "react";
import { Icon } from "../icons/Icon";

/** A picked item (a participant, a member) with a button to remove it (none without `onRemove`: it stays). */
export function Token({
  children,
  leading,
  removeLabel,
  onRemove,
  size,
}: {
  children: ReactNode;
  /** E.g. a small avatar. */
  leading?: ReactNode;
  /** "Remover Ada". */
  removeLabel?: string;
  onRemove?: () => void;
  /** `sm`: inside a field (a search's filters), clear of its edges. */
  size?: "sm";
}) {
  return (
    <span className={size ? `ac-token ac-token--${size}` : "ac-token"}>
      {leading}
      <span className="ac-token__label">{children}</span>
      {onRemove && (
        <button type="button" className="ac-token__remove" aria-label={removeLabel} onClick={onRemove}>
          <Icon name="close" size={14} />
        </button>
      )}
    </span>
  );
}

export function TokenList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className="ac-tokens" aria-label={label}>
      {children}
    </ul>
  );
}
