import type { AgentTab } from "@agenteschat/client/lib/agent-edit";

/**
 * An agent's page in the panel, asked from outside the conversation's page (a sidebar row's settings button): the page
 * on screen opens it beside what it shows. With none on screen the ask waits, for the one the caller goes to.
 */
const EVENT = "agentes:agent-panel";
let pending: { agentId: string; tab?: AgentTab; keep?: boolean } | null = null;

/**
 * True when a conversation on screen took it; otherwise it waits for the next one to mount. `keep`: what only ever
 * opens it leaves it as it is when it's open on this agent, where an opener asked again closes it.
 */
export function requestAgentPanel(agentId: string, tab?: AgentTab, keep?: boolean) {
  pending = { agentId, tab, keep };
  window.dispatchEvent(new CustomEvent(EVENT));
  return pending === null;
}

/** What was asked, once (the page then opens its panel); null otherwise. */
export function takeAgentPanel() {
  const ask = pending;
  pending = null;
  return ask;
}

export function onAgentPanel(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
