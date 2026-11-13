import { router } from "@/ui/navigation";

/** A personal workspace's agent: its Advanced, what one person rarely needs, on a screen of its own (ADR 0159 §3). */
export const openAgentMore = (id: string) => router.push(`/agent-more/${id}` as never);
