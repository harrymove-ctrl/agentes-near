import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/api/context";
import { desktopListsWorkspaces, thisMac } from "@/lib/desktop";
import { type WorkspaceGroup, workspaceGroups } from "@/lib/workspaces";

/**
 * The workspace menu's "Your workspaces" in the desktop app (ADR 0154): this server's workspaces with their unread
 * counts, and every other server's the app reads, by server. Null outside the app (and in older apps): the menu
 * stays as it is there.
 */
export function useWorkspaceGroups(input: {
  orgs: { id: string; name: string; logo?: string | null }[];
  currentOrgId: string;
}): WorkspaceGroup[] | null {
  const on = desktopListsWorkspaces();
  const api = useApi();
  const unread = useQuery({
    queryKey: ["me", "unread"],
    queryFn: () => api.account.unread(),
    enabled: on,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const others = useQuery({
    queryKey: ["desktop", "workspaces"],
    queryFn: () => thisMac.workspaces(),
    enabled: on,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  // Whether this page's server is the one the app runs on this computer: named so, never by its address.
  const place = useQuery({
    queryKey: ["desktop", "thisMac"],
    queryFn: () => thisMac.status(),
    enabled: on,
    staleTime: 60_000,
  });
  if (!on) return null;
  return workspaceGroups({
    here: window.location.origin,
    thisComputer: place.data?.local === true,
    orgs: input.orgs,
    currentOrgId: input.currentOrgId,
    unread: unread.data?.organizations ?? null,
    others: others.data ?? [],
  });
}
