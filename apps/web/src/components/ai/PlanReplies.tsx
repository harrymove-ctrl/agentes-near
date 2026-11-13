import { type CodingPlan, planReplies } from "@agenteschat/client/lib/plans";
import { InfoHint, Switch } from "@agenteschat/ui";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { usePersonalView } from "@/hooks/usePersonalView";

/**
 * Whether a plan's panel shows "Answers other people": alone in a personal workspace there is nobody else to answer,
 * so off it waits until someone joins (ADR 0159); on, it shows, to turn it off. The agent's page always shows it.
 */
export function usePlanRepliesShown(on: boolean) {
  return !usePersonalView().solo || on;
}

/**
 * "Atende outras pessoas" (ADR 0059 §5): off, an agent on its owner's plan answers only them; on, everyone who may
 * talk to it. Under it, a line saying which, on which plan (whose, to an admin), and the plan's terms behind its ⓘ.
 * A plan's panel and the agent's page draw the same.
 */
export function PlanReplies({
  on,
  onChange,
  agent,
  owner,
  brain,
  plan,
  coding,
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** The agent's name, or null for every agent of a plan's panel ("Atendem outras pessoas"). */
  agent: string | null;
  /** The plan's owner's first name, to anyone else (an admin); absent: the viewer's own plan. */
  owner?: string;
  brain: "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";
  /** The account's plan as the CLI says it (`max`, `team`…): a seat has its own words. */
  plan?: string | null;
  /** A coding plan, named by the line, its maker's words behind the ⓘ. */
  coding?: CodingPlan;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const says = planReplies(t, { on, agent, owner, brain, plan, coding });
  return (
    <div className="plan-replies">
      <label htmlFor={id}>{t(agent === null ? "aiAccounts.share.switchAll" : "aiAccounts.share.switch")}</label>
      <Switch
        id={id}
        checked={on}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-describedby={`${id}-line ${id}-terms`}
      />
      <span className="plan-replies__terms ac-hintline">
        <span id={`${id}-line`}>{says.line}</span>
        <InfoHint name={says.about} id={`${id}-terms`}>
          {says.text}
        </InfoHint>
      </span>
    </div>
  );
}
