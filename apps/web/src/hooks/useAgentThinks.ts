import type { Agent } from "@agenteschat/client";
import { useAiStatus, useModels } from "@agenteschat/client";
import { brainLine } from "@agenteschat/client/lib/brain";
import { apiModelName, apiProviderOf, autoMakerOf } from "@agenteschat/client/lib/providers";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/**
 * Who thinks: on a plan, the model by the plan that pays for it ("Sonnet pelo plano do Claude"), else the API model, or
 * on Automático the maker of the key it runs on ("Claude"), as the right hand's panel names its key.
 */
export function useAgentThinks(agent: Agent | undefined) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const models = useModels();
  const status = useAiStatus(org.id).data;
  if (!agent) return null;
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const maker = autoMakerOf(status, agent.id);
  const model = apiModelName(t, agent.model, models.data?.models.find((m) => m.id === agent.model)?.label, maker);
  const thinks = brainLine(t, agent.brain, model, { owner: owner?.name.split(" ")[0], agents: dir.agents });
  // The API's maker when it thinks through a key.
  return { ...thinks, mark: thinks.mark ?? maker ?? apiProviderOf(agent.model, models.data?.models ?? []) };
}
