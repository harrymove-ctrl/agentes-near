import type { Agent, AgentAccess } from "@agenteschat/client";
import { keys } from "@agenteschat/client";
import { useQueries } from "@tanstack/react-query";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";

/**
 * Every agent's access tree, one query per agent (the same cache as the agent
 * page): the matrix, "Quem pode usar" and the "who uses it" of Conectores.
 */
export function useAgentsAccess(agents: Agent[], enabled = true) {
  const api = useApi();
  const { org } = useOrg();
  const queries = useQueries({
    queries: agents.map((a) => ({
      queryKey: keys.agentAccess(org.id, a.id),
      queryFn: () => api.access.get(org.id, a.id),
      enabled,
      retry: false,
    })),
  });
  const byAgent = new Map<string, AgentAccess>();
  queries.forEach((q, i) => {
    const a = agents[i];
    if (a && q.data) byAgent.set(a.id, q.data);
  });
  return {
    byAgent,
    loading: queries.some((q) => q.isLoading),
    /** Some tree is being read again (cached ones may be from before a change on the server). */
    fetching: queries.some((q) => q.isFetching),
    /** The server has no access API (404). */
    unavailable: queries.some((q) => (q.error as { status?: number } | null)?.status === 404),
  };
}
