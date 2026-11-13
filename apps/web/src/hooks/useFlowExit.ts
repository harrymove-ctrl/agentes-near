import { useNavigate } from "@tanstack/react-router";
import type { MouseEvent } from "react";
import { returnPlace } from "@/lib/return-to";

/**
 * A flow's way out ("Cancelar", ×, "Voltar ao chat") as a link's props: back to where the flow was opened from
 * (`returnPlace`), in this tab through the router, or in another one when the person asks for it (⌘/Ctrl-click).
 */
export function useFlowExit(orgId: string) {
  const navigate = useNavigate();
  const href = returnPlace(orgId);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    void navigate({ href: returnPlace(orgId) });
  };
  return { href, onClick };
}
