import type { BrainKind, BrainOption } from "@agenteschat/client";
import {
  BROWSER_TOOL_SCOPE,
  keys,
  useAgentBrain,
  useAgentBrowserSettings,
  useAgentScopes,
  useComputer,
  useMachines,
} from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { NO_COMPUTER } from "@/components/AgentComputer";
import { useOrg } from "@/components/org-context";
import { useAgentEdit } from "../context";

/*
 * What the agent's "Como trabalha" reads and refreshes, shared by its cells (Work.tsx) and their dialogs: who thinks
 * (this folder), where it works and the browser.
 */

/** The browser as the sentence says it: off, waiting for its computer, or on (any site / some). */
export type BrowserWord = "off" | "waiting" | "any" | "only";

/** Shared reads: who thinks, where, and the browser (members don't load the private parts). */
export function useWork() {
  const { org } = useOrg();
  const { agent, viewer } = useAgentEdit();
  const owner = viewer !== "member";
  const brain = useAgentBrain(org.id, agent.id, owner);
  const computer = useComputer(org.id, agent.id, owner);
  const browser = useAgentBrowserSettings(org.id, agent.id, owner);
  const scopes = useAgentScopes(org.id, agent.id);
  const machines = useMachines(org.id, owner);
  const granted = (scopes.data ?? []).some((s) => s.connectionId === null && s.scope === BROWSER_TOOL_SCOPE);
  const target = computer.data?.target;
  const machineId = target?.kind === "machine" ? target.machineId : NO_COMPUTER;
  const browserWord: BrowserWord = !granted
    ? "off"
    : !browser.data?.available
      ? "waiting"
      : (browser.data.allowedDomains ?? []).length > 0
        ? "only"
        : "any";
  return { brain, computer, browser, scopes, machines, granted, machineId, target, browserWord };
}

/** After a save: what depends on the computer, the brain and the browser refetches. */
export function useRefresh() {
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const qc = useQueryClient();
  return (others: readonly string[] = []) => {
    for (const key of [
      keys.agentBrain(org.id, agent.id),
      keys.aiStatus(org.id),
      keys.computer(org.id, agent.id),
      keys.agentBrowser(org.id, agent.id),
      keys.scopes(org.id, agent.id),
      keys.agentAccess(org.id, agent.id),
      keys.agents(org.id),
      keys.machines(org.id),
      // What it thinks with now is what new agents start with.
      keys.newAgentSetup(org.id),
      // The accounts' agents ("Também usada por…") changed with it.
      keys.aiAccounts(org.id),
      // Other agents a change took along ("Todos nesta conta").
      ...others.map((id) => keys.agentBrain(org.id, id)),
    ])
      void qc.invalidateQueries({ queryKey: key });
  };
}

/** Where a computer brain would run: here if it can, else the first computer that has it (on ones first). */
export type BrainMachine = { machineId: string; name: string; online: boolean; options: BrainOption[] };
export function homeFor(kind: BrainKind, current: string, machines: readonly BrainMachine[]) {
  const has = (m: BrainMachine) => m.options.some((o) => o.kind === kind && o.available);
  const here = machines.find((m) => m.machineId === current);
  if (here && has(here)) return here;
  return machines.filter(has).sort((a, b) => Number(b.online) - Number(a.online))[0] ?? null;
}
