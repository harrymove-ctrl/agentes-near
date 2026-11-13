import type { AgentQuestion } from "../api/types";

/** Whether an agent's question waits on this person: it is for them, or for anyone in the conversation. */
export const questionWaitsOn = (q: Pick<AgentQuestion, "requestedForUserId">, meId: string | null | undefined) =>
  !q.requestedForUserId || q.requestedForUserId === meId;
