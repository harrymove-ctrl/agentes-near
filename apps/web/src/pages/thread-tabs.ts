import type { ThreadTab } from "@agenteschat/client";

// Apart from the threads page so the route's search check doesn't load the page itself.

/** "Missões" sits between "Com trabalho" and "Fechadas" (ADR 0029 §11); the sidebar's "Missões" opens it. */
export const THREAD_TABS = ["all", "working", "missions", "closed", "archived"] as const satisfies readonly ThreadTab[];
export type ThreadsTab = (typeof THREAD_TABS)[number];
