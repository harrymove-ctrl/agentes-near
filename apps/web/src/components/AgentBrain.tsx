import type { BrainOption } from "@agenteschat/client";
import { planModelById } from "@agenteschat/client/lib/plans";

/** The model's label for a brain ("Opus"), a coding plan's model by its name, else the value as typed. */
export function brainModelLabel(option: BrainOption | undefined, model: string | null) {
  const value = model ?? option?.defaultModel ?? null;
  if (!value) return "";
  return option?.models.find((m) => m.value === value)?.label ?? planModelById(value)?.label ?? value;
}
