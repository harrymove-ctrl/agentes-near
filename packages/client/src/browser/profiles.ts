import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../api/context";
import { keys } from "../api/keys";
import type { BrowserProfile, Machine, PageTarget } from "../api/types";

/** The live view's key of a browser profile (ADR 0110): watched where an agent's id would be. */
export const profileLiveKey = (profileId: string) => `profile:${profileId}`;

/**
 * Browser profiles exist only on a single-mode computer (ADR 0110 phase 1): on a system-mode one, as the Cloud's
 * computers run, nothing about them shows. Unknown computer: hidden too. A managed computer is the Cloud's, system
 * mode even while it is prepared and its runner hasn't reported a mode yet.
 */
export const profilesApply = (m: Pick<Machine, "mode" | "kind"> | null | undefined) =>
  Boolean(m) && m?.mode !== "system" && m?.kind !== "managed";

/** The profiles a computer's page lists: its own, and none at all on a system-mode computer. */
export const machineProfiles = (profiles: BrowserProfile[] | undefined, m: Pick<Machine, "id" | "mode" | "kind">) =>
  profilesApply(m) ? (profiles ?? []).filter((p) => p.machineId === m.id) : [];

/** The workspace's browser profiles (every member sees names and who may use them); none on a server without them. */
export function useBrowserProfiles(orgId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.browserProfiles(orgId),
    queryFn: () => api.browserProfiles?.list(orgId) ?? Promise.resolve([] as BrowserProfile[]),
    enabled: enabled && Boolean(api.browserProfiles),
  });
}

/** The profiles an agent may use, oldest grant first. */
export const profilesOfAgent = (profiles: BrowserProfile[] | undefined, agentId: string) =>
  (profiles ?? []).filter((p) => p.agentIds.includes(agentId));

/** Who is using it now, for "Em uso por Ada": an agent's id, a person's, or nobody. */
export const profileUser = (p: Pick<BrowserProfile, "holder">) =>
  p.holder?.type === "agent"
    ? { agentId: p.holder.agentId }
    : p.holder?.type === "person"
      ? { userId: p.holder.userId }
      : null;

export function useBrowserProfileMutations(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const profiles = () => {
    const a = api.browserProfiles;
    if (!a) throw new Error("This server has no browser profiles");
    return a;
  };
  const refresh = () => qc.invalidateQueries({ queryKey: keys.browserProfiles(orgId) });
  const put = (p: BrowserProfile) =>
    qc.setQueryData<BrowserProfile[]>(keys.browserProfiles(orgId), (list) =>
      list ? (list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]) : [p],
    );
  return {
    create: useMutation({
      mutationFn: (input: { machineId: string; name: string; agentIds: string[] }) => profiles().create(orgId, input),
      meta: { silent: true },
      onSuccess: put,
    }),
    update: useMutation({
      mutationFn: ({ profileId, ...input }: { profileId: string; name?: string; agentIds?: string[] }) =>
        profiles().update(orgId, profileId, input),
      meta: { silent: true },
      onSuccess: put,
    }),
    remove: useMutation({
      mutationFn: (profileId: string) => profiles().remove(orgId, profileId),
      meta: { silent: true },
      onSuccess: refresh,
    }),
    takeover: useMutation({
      mutationFn: (profileId: string) => profiles().takeover(orgId, profileId),
      meta: { silent: true },
      onSuccess: put,
    }),
    handback: useMutation({
      mutationFn: (profileId: string) => profiles().handback(orgId, profileId),
      meta: { silent: true },
      onSuccess: put,
    }),
    open: useMutation({
      mutationFn: ({ profileId, url }: { profileId: string; url: PageTarget }) =>
        profiles().open(orgId, profileId, url),
      meta: { silent: true },
    }),
    setDefault: useMutation({
      mutationFn: ({ agentId, profileId }: { agentId: string; profileId: string | null }) =>
        profiles().setDefault(orgId, agentId, profileId),
      meta: { silent: true },
      onSuccess: (_v, { agentId }) => qc.invalidateQueries({ queryKey: keys.agentBrowser(orgId, agentId) }),
    }),
    request: useMutation({
      mutationFn: (agentId: string) => profiles().request(orgId, agentId),
      meta: { silent: true },
    }),
  };
}

/**
 * The profile a run's browser is in now: its latest `browser_profile` switch (by name; "own" is its own browser),
 * else the agent's default. Null: the agent's own browser.
 */
export function runProfile(
  steps: { tool: string; detail: string | null }[],
  defaultId: string | null,
  profiles: BrowserProfile[] | undefined,
): BrowserProfile | null {
  const switched = [...steps].reverse().find((s) => s.tool === "browser_profile");
  if (switched) {
    const name = switched.detail?.toLowerCase() ?? "own";
    return name === "own" ? null : ((profiles ?? []).find((p) => p.name.toLowerCase() === name) ?? null);
  }
  return defaultId ? ((profiles ?? []).find((p) => p.id === defaultId) ?? null) : null;
}
