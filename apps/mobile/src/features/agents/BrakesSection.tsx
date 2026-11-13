import { type Agent, type AgentBrakes, BRAKES_DEFAULTS, useUpdateAgent } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput } from "react-native";
import { useOrg } from "@/providers/org";
import { fieldText, GROUPED_ROW, GroupedFooter, GroupedHeader, GroupedList, GroupedRow } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";

const AT_ONCE = [1, 2, 3, 5, 10];
const PRS = [0, 1, 2, 3, 5, 10];

/** The next value of a short list, round: a row's tap steps through it. */
const nextOf = (list: number[], now: number) => list[(list.indexOf(now) + 1) % list.length] ?? list[0] ?? now;

/**
 * The web's Autonomia sem pedido (ADR 0131) on the phone: costly work nobody asked for asks first, how many such jobs
 * at once, PRs an hour, which agents it may call and its project. Saved at once by who manages agents. Settings' own
 * groups: each header over its group, each note under it.
 */
export function BrakesSection({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory();
  const c = useColors();
  const failed = useFailed();
  const update = useUpdateAgent(useOrgId(), agent.id);
  const editable = can(org, "manage_agents");
  const saved: AgentBrakes = agent.brakes ?? BRAKES_DEFAULTS;
  const b = { ...saved, ...(update.isPending ? (update.variables?.brakes ?? {}) : {}) };
  const [project, setProject] = useState(b.project);
  useEffect(() => setProject(saved.project), [saved.project]);
  const save = (patch: Partial<AgentBrakes>) => {
    if (editable) update.mutate({ brakes: patch }, { onError: failed });
  };
  const others = [...dir.agentById.values()].filter((a) => !a.former && a.id !== agent.id);
  return (
    <>
      <GroupedHeader>{t("brakes.title")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="shield"
          label={t("brakes.costly")}
          labelLines={2}
          hint={{ name: t("common.about", { label: t("brakes.costly") }), text: t("brakes.costlyHelp") }}
          toggle={b.costly === "ask"}
          disabled={!editable}
          onPress={() => save({ costly: b.costly === "ask" ? "go" : "ask" })}
        />
        <GroupedRow
          label={t("brakes.atOnce")}
          labelLines={2}
          hint={{ name: t("common.about", { label: t("brakes.atOnce") }), text: t("brakes.atOnceHelp") }}
          value={String(b.maxUnrequested)}
          disabled={!editable}
          onPress={() => save({ maxUnrequested: nextOf(AT_ONCE, b.maxUnrequested) })}
        />
        <GroupedRow
          label={t("brakes.prs")}
          labelLines={2}
          hint={{ name: t("common.about", { label: t("brakes.prs") }), text: t("brakes.prsHelp") }}
          value={String(b.maxPrsPerHour)}
          disabled={!editable}
          onPress={() => save({ maxPrsPerHour: nextOf(PRS, b.maxPrsPerHour) })}
        />
        {b.go.length + b.never.length > 0 ? (
          <GroupedRow
            label={t("brakes.forget")}
            sub={[
              ...b.go.map((k) => t("brakes.rememberedGo", { what: t(`brakes.cost.${k}`) })),
              ...b.never.map((k) => t("brakes.rememberedNever", { what: t(`brakes.cost.${k}`) })),
            ].join(" · ")}
            subLines={3}
            disabled={!editable}
            onPress={() => save({ go: [], never: [] })}
          />
        ) : null}
      </GroupedList>
      <GroupedFooter>{t("brakes.subtitle")}</GroupedFooter>
      <GroupedHeader>{t("brakes.call")}</GroupedHeader>
      <GroupedList>
        {(["all", "some", "none"] as const).map((v) => (
          <GroupedRow
            key={v}
            label={t(`brakes.call${v === "all" ? "All" : v === "some" ? "Some" : "None"}`)}
            checked={b.callAgents === v}
            disabled={!editable}
            onPress={() => save({ callAgents: v })}
          />
        ))}
        {b.callAgents === "some"
          ? others.map((a) => (
              <GroupedRow
                key={a.id}
                label={`@${a.handle}`}
                toggle={b.callAgentIds.includes(a.id)}
                disabled={!editable}
                onPress={() =>
                  save({
                    callAgentIds: b.callAgentIds.includes(a.id)
                      ? b.callAgentIds.filter((id) => id !== a.id)
                      : [...b.callAgentIds, a.id],
                  })
                }
              />
            ))
          : null}
      </GroupedList>
      <GroupedHeader hint={{ name: t("common.about", { label: t("brakes.project") }), text: t("brakes.projectHelp") }}>
        {t("brakes.project")}
      </GroupedHeader>
      <GroupedList>
        <TextInput
          value={project}
          onChangeText={setProject}
          onEndEditing={() => project.trim() !== saved.project && save({ project: project.trim() })}
          editable={editable}
          maxLength={80}
          placeholder={t("brakes.projectPlaceholder")}
          placeholderTextColor={c.faint}
          accessibilityLabel={t("brakes.project")}
          style={[styles.field, fieldText("body"), { color: c.ink }]}
        />
        {/* With a project, in the project's group: its ⓘ speaks of both. */}
        {b.project ? (
          <GroupedRow
            label={t("brakes.otherProjects")}
            toggle={b.otherProjects}
            disabled={!editable}
            onPress={() => save({ otherProjects: !b.otherProjects })}
          />
        ) : null}
      </GroupedList>
      <GroupedFooter>{t("brakes.peopleNote")}</GroupedFooter>
    </>
  );
}

const styles = StyleSheet.create({
  // A field row of a group, as "Create agent"'s.
  field: {
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.tallPadY,
  },
});
