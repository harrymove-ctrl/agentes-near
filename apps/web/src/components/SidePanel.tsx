import { cx } from "@agenteschat/ui";
import { type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useModalSheet } from "@/hooks/useModalSheet";
import { leaveAnimated, takeOverLeaving } from "@/lib/leave";

/**
 * Every side pane (a thread, search's results, an agent's page, a task's conversation or steps, Auditoria's details, a
 * DM's side on a narrow window): a card floating 10px in from the window's top, right and bottom over a scrim that dims
 * the whole window, the sidebar included (`.thread-panel` in threads.css; the geometry guard's `floating` rule). A
 * click on the scrim closes it; everything behind is inert while it is open and the focus comes back when it goes. Esc
 * is the pane's own (`useEscClose`): a pane with steps inside (search, then a thread) goes back a step first. It slides
 * in from the right and out again; a pane replacing another in the same commit just swaps.
 * `className` sizes it (`thread-panel--wide`, `tm-panel`, `dm-side--float`).
 */
export function SidePanel({
  label,
  onClose,
  className,
  panelRef,
  children,
}: {
  label: string;
  onClose: () => void;
  className?: string;
  panelRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const own = useRef<HTMLElement>(null);
  const ref = panelRef ?? own;
  const scrim = useRef<HTMLButtonElement>(null);
  useModalSheet(ref, ".thread-panel__scrim");
  useLayoutEffect(() => {
    const panel = ref.current;
    const dim = scrim.current;
    if (takeOverLeaving()) for (const el of [panel, dim]) el?.setAttribute("data-swap", "");
    return () => leaveAnimated([dim, panel]);
  }, [ref]);
  // In <body>: `fixed` is the window's whatever the page does (a page's entrance holds a transform that would keep the
  // scrim off the sidebar), and everything else, #root, goes inert under it.
  return createPortal(
    <>
      <button
        ref={scrim}
        type="button"
        className="thread-panel__scrim"
        tabIndex={-1}
        aria-label={t("common.close")}
        onClick={onClose}
      />
      <aside ref={ref} tabIndex={-1} className={cx("thread-panel", className)} aria-label={label}>
        {children}
      </aside>
    </>,
    document.body,
  );
}
