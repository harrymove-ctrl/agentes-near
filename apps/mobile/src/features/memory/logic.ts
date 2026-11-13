import type { Agent, Memory } from "@agenteschat/client";

/** How many rows each list under the sky shows. */
export const LIST_COUNT = 5;

/** The filter "Tudo" and one per agent that knows something, the one who knows most first. */
export function agentFilters(memories: Memory[], agents: Pick<Agent, "id" | "name">[], all: string) {
  const count = new Map<string, number>();
  for (const m of memories) count.set(m.agentId, (count.get(m.agentId) ?? 0) + 1);
  const each = agents
    .filter((a) => count.has(a.id))
    .map((a) => ({ key: a.id, label: a.name, count: count.get(a.id) ?? 0 }))
    .sort((a, b) => b.count - a.count);
  return [{ key: "all", label: all }, ...each];
}

export const inAgent = (memories: Memory[], agent: string) =>
  agent === "all" ? memories : memories.filter((m) => m.agentId === agent);

/** "Aprenderam agora há pouco": the newest. */
export const justLearned = (memories: Memory[]) =>
  [...memories].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, LIST_COUNT);

/** "Mais usadas": what was used, most first. */
export const mostUsed = (memories: Memory[]) =>
  memories
    .filter((m) => m.uses > 0)
    .sort((a, b) => b.uses - a.uses)
    .slice(0, LIST_COUNT);

export function searchMemories(memories: Memory[], q: string) {
  const needle = q.trim().toLowerCase();
  return memories.filter((m) => `${m.summary ?? ""} ${m.text}`.toLowerCase().includes(needle));
}
