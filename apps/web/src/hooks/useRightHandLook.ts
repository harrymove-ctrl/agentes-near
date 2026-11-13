import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";

/** The right hand's look, for an empty place with no agent of its own: the default one until it's known. */
export function useRightHandLook() {
  const { org } = useOrg();
  return lookOf(rightHandOf(useDirectory(org.id).agents)) ?? true;
}
