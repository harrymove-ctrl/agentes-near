import { readCapped } from "@agenteschat/adapters";
import { CODING_PLANS, type CodingPlan, learnPlanModels, PLAN_IDS, readPlanModels } from "@agenteschat/providers/plans";

const LIST_TIMEOUT_MS = 10_000;
/** OpenCode Go's was 36 KB on 2026-11-06. */
const LIST_MAX_BYTES = 2_000_000;

async function readList(url: string, read: typeof fetch): Promise<unknown> {
  try {
    const answer = await read(url, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    const bytes = answer.ok ? await readCapped(answer, LIST_MAX_BYTES) : null;
    return bytes && JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Reads each plan's public list of models (`modelsUrl`) into this process. A list that's down, slow, too big or
 * unreadable changes nothing: the plan goes on with what it last said, or the table.
 */
export async function refreshPlanModels(read: typeof fetch = fetch) {
  for (const id of PLAN_IDS) {
    const plan: CodingPlan = CODING_PLANS[id];
    if (plan.modelsUrl) learnPlanModels({ [id]: readPlanModels(plan, await readList(plan.modelsUrl, read)) });
  }
}
