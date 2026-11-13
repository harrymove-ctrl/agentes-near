import type { ComputerDevice } from "@agenteschat/client";
import { useComputerSetup, useMachines } from "@agenteschat/client";
import { computerName, setupPending, setupView } from "@agenteschat/client/lib/computer";
import { settingsFrozen } from "@agenteschat/client/lib/deletion";
import { can } from "@agenteschat/client/lib/permissions";
import { helpUrl } from "@agenteschat/client/lib/server";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, GroupedHeader, GroupedList, GroupedRow, Locked, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { Note, openPage } from "../ai/parts";
import { SetupWait } from "../computer/SetupWait";
import { AgentComputers, HostComputerOff } from "../settings/ComputersScreen";
import { Gap, SettingsPage } from "../settings/parts";
import { firstUseCopy } from "../shared/first-use";
import { useColors } from "../shared/hooks";
import { Loaded } from "../shared/parts";
import { DevicePortrait, JoinRequestCard, StatusLine } from "./parts";
import { useDevices } from "./queries";

export const openComputer = (id: string) => router.push(`/settings/devices/${id}`);
export const openPhone = (id: string) => router.push(`/settings/devices/phone/${id}`);
/** This phone's own guide: Android's setup, or the iPhone's steps on the Mac. */
export const openThisPhone = (machineId?: string) =>
  router.push({
    pathname: Platform.OS === "ios" ? "/settings/devices/iphone-setup" : "/settings/devices/android-setup",
    params: machineId ? { machine: machineId } : {},
  });

/**
 * Configurações › Dispositivos, as the web's: computers with the phones plugged into them nested under each (status
 * chip and words), the workspace's own computer first; the computers asking to join on top for whoever made their
 * link, with Let it join / Deny; Connect a device and this phone's own guide; which computer each agent uses.
 */
export function DevicesScreen() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const { orgId, org } = useOrg();
  const pairs = can(org, "pair_computers");
  // Being deleted, what would change the workspace is greyed out, as on the web; each device still opens its page.
  const frozen = settingsFrozen(org, "devices");
  const list = useDevices();
  const setup = useComputerSetup(orgId);
  const view = setupView(setup.data, setup.dataUpdatedAt);
  const managed = useMachines(orgId).data?.find((m) => m.kind === "managed");
  const requests = list.data?.requests ?? [];
  return (
    <SettingsPage title={t("mobile.devices.title")}>
      {/* The workspace's own computer on its way: its wait until it is ready, then it is a row like the others. */}
      {setupPending(view) ? (
        <>
          <Gap />
          <GroupedList>
            <View style={styles.wait}>
              <SetupWait view={view} online={managed?.online ?? false} />
            </View>
          </GroupedList>
        </>
      ) : null}
      {requests.length > 0 ? (
        <Loaded>
          <GroupedHeader>{t("mobile.devices.join.header")}</GroupedHeader>
          <Locked when={frozen} readable style={styles.cards}>
            {requests.map((r) => (
              <JoinRequestCard key={r.id} request={r} />
            ))}
          </Locked>
        </Loaded>
      ) : null}
      <Gap />
      {list.isLoading ? (
        <ActivityIndicator color={c.muted} style={styles.loading} />
      ) : list.isError && !list.data ? (
        <View style={styles.note}>
          <Note icon="x">{t("common.loadFailed")}</Note>
          <Button size="sm" variant="secondary" label={t("common.retry")} onPress={() => void list.refetch()} />
        </View>
      ) : (
        <DeviceList devices={list.data?.devices ?? []} pairs={pairs} />
      )}
      <Gap />
      <Locked when={frozen} readable>
        <GroupedList>
          {pairs ? (
            <GroupedRow
              icon="plus"
              label={t("mobile.devices.connect.title")}
              chevron
              onPress={() => router.push("/settings/devices/connect")}
            />
          ) : null}
          <GroupedRow
            icon="join"
            label={Platform.OS === "ios" ? t("mobile.devices.iphone.title") : t("mobile.devices.android.entry")}
            chevron
            onPress={() => openThisPhone()}
          />
        </GroupedList>
        <HostComputerOff />
        <AgentComputers />
      </Locked>
      <Gap />
      <GroupedList>
        <GroupedRow
          icon="help"
          label={t("computers.how")}
          chevron
          onPress={() => openPage(helpUrl("computers", i18n.language))}
        />
      </GroupedList>
    </SettingsPage>
  );
}

/** Every computer and, under each, the phones it reaches; each row opens its page. */
function DeviceList({ devices, pairs }: { devices: ComputerDevice[]; pairs: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  // Who can't connect one reads who does instead.
  const copy = pairs
    ? ({ title: "mobile.devices.empty.title", text: "mobile.devices.empty.text" } as const)
    : firstUseCopy("computers", pairs);
  if (devices.length === 0)
    return (
      <GroupedList>
        <View style={styles.empty}>
          <Text variant="callout" tone="ink" style={[styles.bold, styles.center]}>
            {t(copy.title)}
          </Text>
          <Text variant="small" tone="muted" style={styles.center}>
            {t(copy.text)}
          </Text>
        </View>
      </GroupedList>
    );
  return (
    <GroupedList>
      {devices.flatMap((d) => {
        const name = computerName(t, org?.name ?? "", { kind: d.machineKind, name: d.name }, isPersonal(org));
        return [
          <GroupedRow
            key={d.id}
            leading={<DevicePortrait computer={d} />}
            label={name}
            labelLines={2}
            below={<StatusLine status={d.status} />}
            chevron
            {...(d.phones.length > 0 ? { tree: "host" as const } : {})}
            onPress={() => openComputer(d.id)}
          />,
          ...d.phones.map((p, i) => (
            <GroupedRow
              key={p.id}
              leading={<DevicePortrait phone={p} />}
              label={p.name}
              labelLines={2}
              below={<StatusLine status={p.status} hostName={name} />}
              chevron
              tree={i === d.phones.length - 1 ? "end" : "mid"}
              onPress={() => openPhone(p.id)}
            />
          )),
        ];
      })}
    </GroupedList>
  );
}

const styles = StyleSheet.create({
  wait: { padding: 16 },
  cards: { gap: 12 },
  loading: { marginVertical: 16 },
  note: { paddingHorizontal: 4, paddingTop: 10, gap: 10, alignItems: "flex-start" },
  empty: { alignItems: "center", gap: 8, paddingVertical: 20, paddingHorizontal: 16 },
  bold: { fontWeight: "600" },
  center: { textAlign: "center" },
});
