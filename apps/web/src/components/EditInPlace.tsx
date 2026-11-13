import { Button } from "@agenteschat/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Text a person edits where it is (a task's title and description, a routine's name and prompt): on hover the pencil
 * shows; a press on the text (not on a link, a file or a button in it) or on the pencil opens the field. The pencil
 * is the keyboard's way in. Its look is `issue-inplace` (`pages/issues.css`).
 */
export function EditInPlace({ label, onEdit, children }: { label: string; onEdit: () => void; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a pointer shortcut; the pencil is the keyboard way
    <div
      className="issue-inplace"
      onClick={(e) => {
        if (e.target instanceof Element && e.target.closest("a, button, input, label, .artifact-tile")) return;
        if (window.getSelection()?.toString()) return;
        onEdit();
      }}
    >
      {children}
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon="edit"
        aria-label={label}
        title={label}
        className="issue-inplace__pen"
        onClick={onEdit}
      />
    </div>
  );
}

/** "✓ Salvo" for a moment after something edited in place is saved (as a channel's name and description show it). */
export function useSavedFlash() {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const id = setTimeout(() => setSaved(false), 1800);
    return () => clearTimeout(id);
  }, [saved]);
  return [saved, () => setSaved(true)] as const;
}

/**
 * What was just sent, shown while the item still has the value it replaced (the list refetches after each change,
 * so the old text would blink back for a moment); forgotten as soon as the item comes back changed.
 */
export function useSent<T>(fromServer: string) {
  const [sent, setSent] = useState<{ value: T; was: string } | null>(null);
  useEffect(() => {
    if (sent && sent.was !== fromServer) setSent(null);
  }, [sent, fromServer]);
  return {
    pending: sent && sent.was === fromServer ? sent.value : null,
    send: (value: T) => setSent({ value, was: fromServer }),
    clear: () => setSent(null),
  };
}

/** Focuses a field when it opens, with the caret after its text (not before it, as autofocus leaves a textarea). */
export function useFocusAtEnd<T extends HTMLInputElement | HTMLTextAreaElement>(open: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [open]);
  return ref;
}
