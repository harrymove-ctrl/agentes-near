import {
  useComputerSetup,
  useConnections,
  useInvitations,
  useMachines,
  useOverview,
  useSkills,
  useStorage,
  useWorkspaceUsesApi,
} from "@agenteschat/client";
import { computerEdition } from "@agenteschat/client/lib/computer";
import { can } from "@agenteschat/client/lib/permissions";
import { settingsSectionNameKey } from "@agenteschat/client/lib/personal-view";
import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, haptics } from "@/ui";
import { router } from "@/ui/navigation";
import { OrgAvatar } from "../shared/OrgAvatar";
import { usePersonalView } from "./hooks";
import {
  areaValues,
  GROUP_LABEL,
  PERSONAL_ICON,
  personalSections,
  SETTINGS_GROUPS,
  type SettingsEntry,
  type SettingsGroup,
  type SettingsSection,
  visibleSections,
} from "./logic";
import { Gap, SettingsPage } from "./parts";

/** The rows whose group already says the rest get a shorter name (`mobile.settings.section.*`). */
const SHORT: Partial<Record<SettingsSection, string>> = {
  computers: "mobile.devices.title",
  members: "mobile.settings.section.members",
  roles: "mobile.settings.section.roles",
  access: "mobile.settings.section.access",
  connectors: "mobile.settings.section.connectors",
};

/**
 * The workspace's settings, a screen pushed from Você on the grouped gray, as the phone's own settings: the web's
 * entries as groups, each thing once. Workspace: the workspace itself (its mark, its name, what Geral holds) and GIFs.
 * Pessoas, IA e uso, Conectores, Avançado: one neutral tile and one short value per row (a count or a state), the
 * area's own screen says the rest. Owners get "Apagar <nome>" alone in red at the end, behind the
 * system's alert (one firm haptic as it confirms), then the proof and the hold. Opened often, so nothing animates
 * here beyond the rows' press highlight and the platform's push. A personal workspace gets its short list instead
 * (ADR 0159 §3, `PersonalSettingsList`).
 */
export function WorkspaceScreen() {
  const { personal, others } = usePersonalView();
  return personal ? <PersonalSettingsList others={others} /> : <TeamSettingsList />;
}

/** A team's workspace settings: every section this person opens, in the phone's groups, then deleting it. */
function TeamSettingsList() {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <SettingsPage title={t("settings.title")}>
      <SectionGroups areas={visibleSections(org)} />
      <DeleteWorkspaceRow />
    </SettingsPage>
  );
}

/**
 * A personal workspace's settings (ADR 0159 §3): one list with no group names. Your account, then About you, AI and
 * apps, Plan and usage, Vault and Computers (and People once someone else is a member), each opening the same screen
 * as in a team's; then Advanced, a screen of its own with every other section, delegated approvals and deleting the
 * workspace. Nothing here changes what anyone may open.
 */
function PersonalSettingsList({ others }: { others: number | undefined }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { main } = personalSections(org, others);
  const values = useAreaValues(main);
  return (
    <SettingsPage title={t("settings.title")}>
      <Gap />
      <GroupedList>
        <GroupedRow
          key="account"
          icon="person"
          label={t("settings.section.account")}
          chevron
          onPress={() => router.push("/me/account")}
        />
        {main.map((s) => (
          <GroupedRow
            key={s.id}
            icon={PERSONAL_ICON[s.id] ?? s.icon}
            label={t(settingsSectionNameKey(org, s.id))}
            {...(values[s.id] ? { value: values[s.id] } : {})}
            chevron
            onPress={() => router.push(s.href as never)}
          />
        ))}
      </GroupedList>
      <Gap />
      <GroupedList>
        <GroupedRow
          key="advanced"
          icon="list"
          label={t("settings.advanced")}
          chevron
          onPress={() => router.push("/settings/advanced")}
        />
      </GroupedList>
    </SettingsPage>
  );
}

/**
 * Sections in the phone's groups, each with its header: the workspace itself by its mark and name, the rest by a
 * neutral tile, a short name and one value. `extra`: rows a group ends with (a
 * personal workspace's delegated approvals under People); a group with none of either draws nothing.
 */
export function SectionGroups({
  areas,
  extra,
  untitled,
}: {
  areas: readonly SettingsEntry[];
  extra?: Partial<Record<SettingsGroup, ReactElement>>;
  /** The group the screen's own title already names (Advanced on the Advanced screen): its rows, no header. */
  untitled?: SettingsGroup;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const values = useAreaValues(areas);
  const name = org?.name ?? "";
  return (
    <>
      {SETTINGS_GROUPS.map((group) => {
        const rows = areas.filter((s) => s.group === group);
        const more = extra?.[group];
        if (rows.length === 0 && !more) return null;
        return (
          <Fragment key={group}>
            {group === untitled ? <Gap /> : <GroupedHeader>{t(GROUP_LABEL[group])}</GroupedHeader>}
            <GroupedList>
              {rows.map((s) =>
                s.id === "general" ? (
                  <GroupedRow
                    key={s.id}
                    leading={<OrgAvatar logo={org?.logo} size={36} />}
                    label={name}
                    sub={t("mobile.settings.editSub")}
                    chevron
                    onPress={() => router.push(s.href as never)}
                  />
                ) : (
                  <GroupedRow
                    key={s.id}
                    icon={s.icon}
                    label={t(SHORT[s.id] ?? `settings.section.${s.id}`)}
                    {...(values[s.id] ? { value: values[s.id] } : {})}
                    chevron
                    onPress={() => router.push(s.href as never)}
                  />
                ),
              )}
              {more}
            </GroupedList>
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * Owners: "Delete <name>" alone in red, behind the system's alert (one firm haptic as it confirms), then the proof and
 * the hold on a screen of its own. Nothing for anyone else, nor while it is being deleted.
 */
export function DeleteWorkspaceRow() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const name = org?.name ?? "";
  if (org?.role !== "owner" || org.deletion) return null;
  const confirmDelete = () =>
    Alert.alert(t("deleteOrg.title", { name }), t("mobile.settings.deleteAlert"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("mobile.settings.deleteAction"),
        style: "destructive",
        onPress: () => {
          // One firm tap as the destructive step is taken, in the same moment the next screen comes.
          haptics.medium();
          router.push("/settings/delete");
        },
      },
    ]);
  return (
    <>
      <Gap />
      <Gap />
      <GroupedList>
        <GroupedRow label={t("mobile.settings.deleteName", { name })} danger onPress={confirmDelete} />
      </GroupedList>
      <GroupedFooter>{t("mobile.settings.deleteFoot")}</GroupedFooter>
    </>
  );
}

/** Each area's value, as the web's tiles count (`areaValues`): asked only for the areas shown. */
function useAreaValues(areas: readonly SettingsEntry[]) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const shown = (id: string) => areas.some((s) => s.id === id);
  const overview = useOverview(orgId);
  const invitations = useInvitations(orgId, can(org, "invite_people"));
  const connections = useConnections(orgId);
  const skills = useSkills(orgId, shown("skills"));
  const machines = useMachines(orgId, shown("computers"));
  const storage = useStorage(orgId, shown("storage"));
  const edition = computerEdition(useComputerSetup(orgId, shown("storage")).data);
  const usesApi = useWorkspaceUsesApi(orgId);
  return areaValues(t, i18n.language, {
    overview: overview.data,
    usesApi,
    invitations: invitations.data?.length,
    connectors: connections.data?.filter((x) => !x.revokedAt).map((x) => x.label),
    skills: skills.data?.length,
    computers: machines.data
      ? { count: machines.data.length, online: machines.data.filter((m) => m.online).length }
      : undefined,
    storage: storage.data && edition ? { kind: storage.data.kind, edition } : undefined,
  });
}
