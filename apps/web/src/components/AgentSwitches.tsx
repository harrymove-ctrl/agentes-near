import { Icon, Switch } from "@agenteschat/ui";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { AgentAvatar } from "./AgentAvatar";
import { useOrg } from "./org-context";

/**
 * Which agents may use something (a browser profile, a Vault item, ADR 0144): the workspace's agents, each on or off,
 * the main choice raised on top.
 *
 * Without `all`, that top row turns every agent on or off. With it, the top row is its own choice, every agent now
 * and the ones added later (a Vault item's "all agents"): while it is on, the agents' own switches show on and can't
 * be turned off one by one.
 */
export function AgentSwitches({
  value,
  onChange,
  all,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  all?: { checked: boolean; onChange: (on: boolean) => void; label: string; detail?: string };
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agents = dir.agents;
  const every = agents.length > 0 && agents.every((a) => value.includes(a.id));
  const topLabel = all?.label ?? t("browser.profiles.everyone");
  // Each name is its switch's label: a press on it toggles the switch.
  const ids = useId();
  return (
    <div>
      {(all || agents.length > 1) && (
        <div className="cflow-agent cflow-agent--all">
          <span className="cflow-agent__all-icon" aria-hidden="true">
            <Icon name="members" size={16} />
          </span>
          <label className="cflow-agent__name" htmlFor={`${ids}-all`}>
            <span>{topLabel}</span>
            {all?.detail && <span className="small muted">{all.detail}</span>}
          </label>
          <Switch
            id={`${ids}-all`}
            checked={all ? all.checked : every}
            aria-label={topLabel}
            onCheckedChange={(on) => (all ? all.onChange(on) : onChange(on ? agents.map((a) => a.id) : []))}
          />
        </div>
      )}
      <ul className="cflow-agents">
        {agents.map((a) => (
          <li key={a.id} className="cflow-agent">
            <AgentAvatar agentId={a.id} name={a.name} size="sm" />
            <label className="cflow-agent__name" htmlFor={`${ids}-${a.id}`}>
              <span>{a.name}</span>
              {all && a.role && <span className="small muted">{a.role}</span>}
            </label>
            <Switch
              id={`${ids}-${a.id}`}
              checked={all?.checked || value.includes(a.id)}
              disabled={all?.checked}
              aria-label={a.name}
              onCheckedChange={(on) => onChange(on ? [...value, a.id] : value.filter((id) => id !== a.id))}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
