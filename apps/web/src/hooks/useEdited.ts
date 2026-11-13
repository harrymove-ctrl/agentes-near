import { useState } from "react";

/**
 * Whether a form's values changed since it opened: what a stray click outside or an Esc would lose (`Dialog`'s
 * `unsaved`). What it opened with (a name to rename, an event to edit) doesn't count. `values` must be JSON.
 */
export function useEdited(open: boolean, values: unknown): boolean {
  const now = JSON.stringify(values);
  const [start, setStart] = useState<string | null>(open ? now : null);
  if (open && start === null) setStart(now);
  if (!open && start !== null) setStart(null);
  return open && start !== null && now !== start;
}
