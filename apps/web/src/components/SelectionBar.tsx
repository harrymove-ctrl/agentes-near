import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The glass bar of a multi-select (Drive, Threads): fixed at the bottom of the work area, centered on it.
 * Hung from `.shell__work`, beside the sidebar: inside the page it would sit under the list (the page's
 * entrance animation, `page-in` with fill `both`, keeps the page a containing block, so neither `sticky` nor
 * `fixed` reaches the bottom on a short list).
 */
export function SelectionBar({ label, children }: { label: string; children: ReactNode }) {
  return createPortal(
    <div className="drive-selbar" role="toolbar" aria-label={label}>
      {children}
    </div>,
    document.querySelector(".shell__work") ?? document.body,
  );
}
