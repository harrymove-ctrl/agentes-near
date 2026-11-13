import { useLocalSearchParams } from "expo-router";
import { SetupStepScreen } from "@/features/agents/setup/SetupStepScreen";

/**
 * One step of a setup checklist (`?step=apps|where|who|how`, the right hand's `apps`, and `about` in a personal
 * workspace), from the card in its DM or on its screen. `text`: what the person already typed or tapped on the card,
 * row 1's sentence filled in.
 */
export default function AgentStepRoute() {
  const { id, step, text } = useLocalSearchParams<{ id: string; step?: string; text?: string }>();
  return <SetupStepScreen key={`${id}-${step}`} agentId={id ?? ""} step={step} text={text} />;
}
