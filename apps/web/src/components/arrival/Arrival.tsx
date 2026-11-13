import { useAiStatus } from "@agenteschat/client";
import { teamThinks } from "@agenteschat/client/lib/no-ai";
import { useEffect, useState } from "react";
import { useConnectAi, useMayConnectAi } from "@/components/ConnectAi";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { ARRIVAL_BETA_ONLY, ARRIVAL_PARAM } from "@/lib/arrival";
import { useOpenParam } from "@/lib/open-param";
import { BetaDialog } from "./BetaDialog";

/**
 * Right after the onboarding (ADR 0160): the beta notice, then Connect an AI with the team on its stage, for a
 * person who has an AI to connect while some agent has none. Asked for by the address, once: the mark is dropped as
 * it opens, so a reload or Back shows neither again. `?arrival=beta` is the notice alone: the onboarding already
 * asked for the AI in its own step, or the plan was left for later and its row leads the right hand's card (ADR 0162).
 */
export function Arrival() {
  const { org } = useOrg();
  const [asked, clear] = useOpenParam(ARRIVAL_PARAM);
  // The value it was asked with, kept once the address drops it; null: nothing to show.
  const [beta, setBeta] = useState<string | null>(null);
  const connect = useConnectAi();
  const mayConnect = useMayConnectAi();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per link
  useEffect(() => {
    if (asked === null) return;
    setBeta(asked);
    clear(null);
  }, [asked]);
  if (beta === null) return null;
  // Every agent already thinks (a workspace joined with its AI in place): nothing to connect.
  const allThink =
    teamThinks(
      dir.agents.map((a) => a.id),
      status.data,
    ) === true;
  return (
    <BetaDialog
      onContinue={() => {
        const was = beta;
        setBeta(null);
        if (was !== ARRIVAL_BETA_ONLY && mayConnect && !allThink) connect?.open({ arrival: true });
      }}
    />
  );
}
