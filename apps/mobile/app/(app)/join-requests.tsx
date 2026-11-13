import { useLocalSearchParams } from "expo-router";
import { JoinRequestsSheet } from "@/features/members/JoinRequestsSheet";
import { goBack } from "@/features/shared/parts";

/**
 * Requests to join through the invitation link, as a native form sheet over whatever is on screen (presentation
 * set in `_layout`; deep link `agenteschat://join-requests`; `request`: the one tapped on Membros, on top).
 */
export default function JoinRequestsRoute() {
  const { request } = useLocalSearchParams<{ request?: string }>();
  return <JoinRequestsSheet focus={request} onClose={goBack} />;
}
