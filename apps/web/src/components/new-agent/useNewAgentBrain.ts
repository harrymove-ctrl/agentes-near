import {
  useAiAccounts,
  useBrainMachines,
  useCredentials,
  useModels,
  useNewAgentSetup,
  usePlatformKey,
} from "@agenteschat/client";
import { newAgentStart } from "@agenteschat/client/lib/agent-setup";
import { brainPickInput, brainPickOptions, planAccountOption } from "@agenteschat/client/lib/brain-picker";
import { can } from "@agenteschat/client/lib/permissions";
import { AUTO, modelChoices, usableModels } from "@agenteschat/client/lib/providers";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import type { PlanChoice } from "@/components/AgentFields";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { useOrg } from "@/components/org-context";

/**
 * What a new agent made from its card thinks with (ADR 0164), as "Criar agente" starts it (ADR 0094): the last setup
 * saved or used on other agents, where it can think for it; else a plan account of the person's own with room for one
 * more agent; else Automático on the API. `hasAi`: it will be able to think right away (else its chat asks for an AI).
 */
export function useNewAgentBrain() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const models = useModels();
  const credentials = useCredentials(org.id);
  const platform = usePlatformKey(org.id);
  const brainMachines = useBrainMachines(org.id);
  const aiAccounts = useAiAccounts(org.id);
  const lastSetup = useNewAgentSetup(org.id);
  const held = usePlanHold() !== null;
  const choices = useMemo(
    () => modelChoices(models.data?.models ?? [], credentials.data ?? [], platform.data ?? false),
    [models.data, credentials.data, platform.data],
  );
  const usable = useMemo(() => usableModels(choices), [choices]);
  const start = newAgentStart(lastSetup.data, {
    ownerIsMe: true,
    admin: can(org, "manage_agents"),
    usable,
    keys: credentials.data ?? [],
  });
  const options = useMemo(
    () =>
      brainPickOptions(t, i18n.language, {
        api: choices,
        machines: brainMachines.data ?? [],
        accounts: aiAccounts.data?.accounts ?? [],
        ownerIsMe: true,
        held,
      }),
    [t, i18n.language, choices, brainMachines.data, aiAccounts.data, held],
  );
  const own = start === null ? planAccountOption(options)?.pick : undefined;
  const plan: PlanChoice | null =
    start && start.brain !== "model"
      ? {
          kind: start.brain,
          machineId: start.machineId,
          ...(start.account ? { accountId: start.account.id, label: start.account.label } : {}),
        }
      : own && "accountId" in own && own.accountId
        ? { kind: own.kind, machineId: own.machineId, accountId: own.accountId, label: own.account, model: AUTO }
        : null;
  const onModel = start?.brain === "model" ? start : null;
  return {
    hasAi: !held && (plan !== null || onModel !== null || usable.size > 0),
    input: {
      model: onModel?.model ?? AUTO,
      credentialId: onModel?.key ?? null,
      ...(start?.autonomy ? { autonomy: start.autonomy } : {}),
    },
    /** Its plan, once it exists: the computer it thinks on, then its "Quem pensa". */
    apply: async (agentId: string) => {
      if (!plan) return;
      await api.sandbox.setTarget(org.id, agentId, plan.machineId);
      await api.agents.setBrain(org.id, agentId, start && start.brain !== "model" ? start.input : brainPickInput(plan));
    },
  };
}
