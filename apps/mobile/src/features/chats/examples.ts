/**
 * The examples of what a first agent can do (Conversas empty, and the new-agent form): each fills "o que faz"
 * with `mobile.chats.first.example.<key>.what`; its title and hint are `….title` and `….hint`.
 */
export const FIRST_AGENT_EXAMPLES = [
  { key: "support", icon: "chat" },
  { key: "reports", icon: "doc" },
  { key: "weekly", icon: "clock" },
] as const;

export type FirstAgentExample = (typeof FIRST_AGENT_EXAMPLES)[number];
