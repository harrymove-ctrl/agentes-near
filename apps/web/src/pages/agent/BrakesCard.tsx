import { type AgentBrakes, BRAKES_DEFAULTS, useAgents, useUpdateAgent } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Card, CheckboxPill, Input, Segmented, Select, SettingNote, SettingRow, Switch } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { CardHead, useAgentEdit } from "./context";

const AT_ONCE = ["1", "2", "3", "5", "10"];
const PRS = ["0", "1", "2", "3", "5", "10"];

/**
 * Configurações → Autonomia sem pedido (ADR 0131): what the agent may start that nobody asked for directly (costly
 * work asks first, how many jobs at once, PRs an hour) and which agents it may call. Saved at once, outside the page's
 * save bar, by who manages agents; everyone else reads it. The defaults keep today's autonomy for normal use.
 */
export function BrakesCard() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const update = useUpdateAgent(org.id, agent.id);
  const agents = useAgents(org.id);
  const toast = useToast();
  const editable = can(org, "manage_agents");
  const saved: AgentBrakes = agent.brakes ?? BRAKES_DEFAULTS;
  const pending = update.isPending ? (update.variables?.brakes ?? {}) : {};
  const b = { ...saved, ...pending };
  const [project, setProject] = useState(b.project);
  useEffect(() => setProject(saved.project), [saved.project]);
  const save = (patch: Partial<AgentBrakes>) => {
    if (!editable) return;
    update.mutate({ brakes: patch }, { onError: () => toast.show(t("brakes.failed"), "error") });
  };
  const others = (agents.data ?? []).filter((a) => !a.former && a.id !== agent.id);
  const remembered = [
    ...b.go.map((k) => t("brakes.rememberedGo", { what: t(`brakes.cost.${k}`) })),
    ...b.never.map((k) => t("brakes.rememberedNever", { what: t(`brakes.cost.${k}`) })),
  ];
  return (
    <Card as="section" className="agp-card" aria-labelledby="agp-brakes">
      <CardHead id="agp-brakes" icon="shield" title={t("brakes.title")} subtitle={t("brakes.subtitle")} />
      <SettingRow
        title={t("brakes.costly")}
        hint={{ name: t("common.about", { label: t("brakes.costly") }), text: t("brakes.costlyHelp") }}
      >
        <Segmented
          size="sm"
          label={t("brakes.costly")}
          value={b.costly}
          disabled={!editable}
          onValueChange={(costly) => save({ costly })}
          options={[
            { value: "ask", label: t("brakes.costlyAsk") },
            { value: "go", label: t("brakes.costlyGo") },
          ]}
        />
      </SettingRow>
      {remembered.length > 0 && (
        <SettingNote icon="check">
          {remembered.join(" · ")}{" "}
          {editable && (
            <Button variant="ghost" size="sm" onClick={() => save({ go: [], never: [] })}>
              {t("brakes.forget")}
            </Button>
          )}
        </SettingNote>
      )}
      <SettingRow
        title={t("brakes.atOnce")}
        hint={{ name: t("common.about", { label: t("brakes.atOnce") }), text: t("brakes.atOnceHelp") }}
        htmlFor="agp-brakes-once"
      >
        <Select
          id="agp-brakes-once"
          size="sm"
          value={String(b.maxUnrequested)}
          disabled={!editable}
          onValueChange={(v) => save({ maxUnrequested: Number(v) })}
          options={AT_ONCE.map((n) => ({ value: n, label: n }))}
        />
      </SettingRow>
      <SettingRow
        title={t("brakes.prs")}
        hint={{ name: t("common.about", { label: t("brakes.prs") }), text: t("brakes.prsHelp") }}
        htmlFor="agp-brakes-prs"
      >
        <Select
          id="agp-brakes-prs"
          size="sm"
          value={String(b.maxPrsPerHour)}
          disabled={!editable}
          onValueChange={(v) => save({ maxPrsPerHour: Number(v) })}
          options={PRS.map((n) => ({ value: n, label: n }))}
        />
      </SettingRow>
      <SettingRow
        title={t("brakes.call")}
        hint={{ name: t("common.about", { label: t("brakes.call") }), text: t("brakes.callHelp") }}
      >
        <Segmented
          size="sm"
          label={t("brakes.call")}
          value={b.callAgents}
          disabled={!editable}
          onValueChange={(callAgents) => save({ callAgents })}
          options={[
            { value: "all", label: t("brakes.callAll") },
            { value: "some", label: t("brakes.callSome") },
            { value: "none", label: t("brakes.callNone") },
          ]}
        />
      </SettingRow>
      {b.callAgents === "some" && (
        <div className="newag__pills">
          {others.map((a) => (
            <CheckboxPill
              key={a.id}
              id={`agp-brakes-call-${a.id}`}
              checked={b.callAgentIds.includes(a.id)}
              disabled={!editable}
              onCheckedChange={(on) =>
                save({
                  callAgentIds: on ? [...b.callAgentIds, a.id] : b.callAgentIds.filter((id) => id !== a.id),
                })
              }
            >
              {`@${a.handle}`}
            </CheckboxPill>
          ))}
        </div>
      )}
      <SettingRow
        title={t("brakes.project")}
        hint={{ name: t("common.about", { label: t("brakes.project") }), text: t("brakes.projectHelp") }}
        htmlFor="agp-brakes-project"
      >
        <Input
          id="agp-brakes-project"
          value={project}
          maxLength={80}
          placeholder={t("brakes.projectPlaceholder")}
          disabled={!editable}
          onChange={(e) => setProject(e.target.value)}
          onBlur={() => project.trim() !== saved.project && save({ project: project.trim() })}
        />
      </SettingRow>
      {b.project && (
        <SettingRow title={t("brakes.otherProjects")} htmlFor="agp-brakes-other">
          <Switch
            id="agp-brakes-other"
            checked={b.otherProjects}
            disabled={!editable}
            onCheckedChange={(otherProjects) => save({ otherProjects })}
          />
        </SettingRow>
      )}
      <SettingNote icon="info" quiet>
        {t("brakes.peopleNote")}
      </SettingNote>
    </Card>
  );
}
