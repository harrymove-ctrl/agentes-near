import { Link } from "@tanstack/react-router";
import { type AnchorHTMLAttributes, createContext, type ReactNode, useContext } from "react";
import { useOrg } from "@/components/org-context";
import { inPlaceClick } from "@/lib/navigate";

/**
 * An item whose details dialog opens over whatever page the person is on (`DetailsHost`). `usage_queue` is an agent's
 * line waiting on its plan (its id), which has no page of its own to link to; `tab` "skipped" opens it on what it
 * skipped.
 */
export type DetailsItem = { kind: "routine" | "approval" | "usage_queue"; id: string; tab?: "skipped" };

export const OpenDetailsContext = createContext<((item: DetailsItem) => void) | null>(null);

const PAGE = { routine: "/org/$orgId/routines", approval: "/org/$orgId/approvals" } as const;

/**
 * A link to an item's details: a plain click opens them in place, so the conversation keeps its place; the href
 * (its page with `?open=`) serves a new tab and a modified click, and outside a workspace's pages.
 */
export function DetailsLink({
  item,
  onClick,
  ...rest
}: { item: DetailsItem & { kind: keyof typeof PAGE }; children: ReactNode } & Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
>) {
  const { org } = useOrg();
  const open = useContext(OpenDetailsContext);
  return (
    <Link
      to={PAGE[item.kind]}
      params={{ orgId: org.id }}
      search={{ open: item.id }}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (open && !e.defaultPrevented) inPlaceClick(e, () => open(item));
      }}
    />
  );
}
