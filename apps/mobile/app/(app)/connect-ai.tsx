import { ConnectAiSheet } from "@/features/ai/ConnectAi";

/**
 * "Conectar uma IA" as pushed screens, one question each: from Você, an agent's no-AI reply, or the computer
 * being ready (`?ready=1`).
 */
export default function ConnectAiRoute() {
  return <ConnectAiSheet />;
}
