import { createContext, createElement, type ReactNode, useContext, useMemo } from "react";
import type { ApiClient } from "./client";

/** A person's 👍/👎 on an agent's message: the platform plays the agent's face (web: `playAgentReaction`). */
export type AgentReactionEffect = (messageId: string, kind: "up" | "down") => void;

/** What the hooks need from the platform: the API client and optional effects. */
export interface ApiContextValue {
  client: ApiClient;
  onAgentReaction?: AgentReactionEffect;
}

const ApiContext = createContext<ApiContextValue | null>(null);

/** Provides the API client to the hooks (web and phone app alike). */
export function ApiProvider({
  client,
  onAgentReaction,
  children,
}: {
  client: ApiClient;
  onAgentReaction?: AgentReactionEffect;
  children?: ReactNode;
}) {
  const value = useMemo(() => ({ client, onAgentReaction }), [client, onAgentReaction]);
  return createElement(ApiContext.Provider, { value }, children);
}

function useApiContext(): ApiContextValue {
  const value = useContext(ApiContext);
  if (!value) throw new Error("useApi must be used inside ApiProvider");
  return value;
}

export function useApi(): ApiClient {
  return useApiContext().client;
}

/** The platform's agent reaction effect, if any. */
export function useAgentReaction(): AgentReactionEffect | undefined {
  return useApiContext().onAgentReaction;
}

const CardViaContext = createContext<string | undefined>(undefined);

/**
 * The right hand's card whose rows act here (ADR 0137 §4): its message id goes with the decisions and people changes
 * made inside it, so the audit reads them "via" the right hand. The server ignores a card that doesn't name them.
 */
export function CardVia({ messageId, children }: { messageId: string; children?: ReactNode }) {
  return createElement(CardViaContext.Provider, { value: messageId }, children);
}

export const useCardVia = () => useContext(CardViaContext);
