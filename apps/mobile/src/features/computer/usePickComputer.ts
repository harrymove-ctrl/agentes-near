import { useComputerSetup, useMachines, useSetComputerTarget } from "@agenteschat/client";
import { setupView } from "@agenteschat/client/lib/computer";
import { errorText } from "@agenteschat/client/lib/errors";
import { machineTitle } from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { useToast } from "@/ui";
import { computerIcon } from "../outages/logic";
import { agentComputerPick } from "../settings/logic";
import { useDirectory, useMeId } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { errorHaptic, successHaptic } from "../shared/parts";

/**
 * Choosing an agent's computer right where it says it has none: the app's picker with the computers this person may
 * pick for it (the same rule as Computadores' "Qual computador cada agente usa", `agentComputerPick`; an offline one
 * says so), and a pick saves with a toast. Null while it loads or when this person picks none for it, so the screen
 * offers nothing it can't do.
 */
export function usePickComputer(agentId: string): (() => void) | null {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const machines = useMachines(orgId);
  const setupQ = useComputerSetup(orgId);
  const setTarget = useSetComputerTarget(orgId);
  const agent = dir.agentById.get(agentId);
  if (!agent || !machines.data) return null;
  const pick = agentComputerPick({
    agent,
    meId,
    admin: can(org, "manage_agents"),
    machines: machines.data,
    setup: setupView(setupQ.data, setupQ.dataUpdatedAt),
  });
  if (!pick.canPick) return null;
  const host = t("machines.host.label");
  const save = (m: (typeof pick.choices)[number]) => {
    const title = machineTitle(m, host);
    setTarget.mutate(
      { agentId, machineId: m.id },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("computers.agents.saved", { name: agent.name, computer: title }), icon: "check" });
        },
        onError: (err) => {
          errorHaptic();
          toast({ title: errorText(t, err), icon: "x" });
        },
      },
    );
  };
  // The app's picker: each computer with its system's mark and, when it's off, "Desligado" under its name; the one the
  // agent uses checked.
  return () =>
    void pickOne({
      title: t("computers.agents.pick", { name: agent.name }),
      value: pick.value,
      options: pick.choices.map((m) => ({
        key: m.id,
        label: machineTitle(m, host),
        ...(m.online ? {} : { sub: t("machines.offline") }),
        leading: { kind: "icon" as const, name: computerIcon(m.os) },
      })),
    }).then((key) => {
      const chosen = key ? pick.choices.find((m) => m.id === key) : undefined;
      if (chosen && key !== pick.value) save(chosen);
    });
}
