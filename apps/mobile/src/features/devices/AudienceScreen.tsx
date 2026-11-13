import type { DeviceAudience } from "@agenteschat/client";
import { useRoles } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { firstName } from "@agenteschat/client/lib/format";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet } from "react-native";
import { useOrg } from "@/providers/org";
import { EmptyState, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { RoleMark } from "../dashboards/parts";
import { Gap, SettingsPage } from "../settings/parts";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { goBack, successHaptic, tapHaptic } from "../shared/parts";
import { findDevice, narrowsAudience } from "./logic";
import { useDeviceMutation, useDevices } from "./queries";

const MODES: DeviceAudience["mode"][] = ["owner", "everyone", "people"];

/**
 * "Quem pode usar" a computer or an Android phone, as an agent's audience reads: only its owner, everyone, or some
 * people and roles. Its owner picks any; an admin on someone else's device only narrows it (the rest is off).
 */
export function DeviceAudienceScreen({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const list = useDevices();
  const found = findDevice(list.data?.devices, deviceId);
  if (!found) {
    return (
      <SettingsPage title={t("mobile.devices.audience.label")}>
        {list.isLoading ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : (
          <EmptyState title={t("mobile.devices.page.notFound")} subtitle={t("mobile.devices.page.notFoundText")} />
        )}
      </SettingsPage>
    );
  }
  const { computer, phone } = found;
  const device = phone ?? computer;
  return (
    <AudienceForm
      key={device.id}
      deviceId={device.id}
      phone={Boolean(phone)}
      name={device.name}
      ownerId={device.ownerUserId}
      saved={device.audience ?? computer.audience}
      singleUser={!phone && computer.machineKind === "connected" && !computer.systemMode}
      hostName={computer.name}
    />
  );
}

function AudienceForm({
  deviceId,
  phone,
  name,
  ownerId,
  saved,
  singleUser,
  hostName,
}: {
  deviceId: string;
  phone: boolean;
  name: string;
  ownerId: string | null;
  saved: DeviceAudience;
  singleUser: boolean;
  hostName: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const roles = useRoles(orgId);
  const [audience, setAudience] = useState<DeviceAudience>(saved);
  const save = useDeviceMutation<DeviceAudience>((api, org, a) =>
    phone
      ? api.devices.updatePhone(org, deviceId, { audience: a })
      : api.devices.updateComputer(org, deviceId, { audience: a }),
  );
  const mine = ownerId !== null && ownerId === meId;
  const ownerName = firstName(ownerId ? (dir.memberById.get(ownerId)?.name ?? "") : "");
  // Someone else's device: only what narrows its rule as it stands.
  const allowed = (a: DeviceAudience) => mine || narrowsAudience(saved, a);
  const canAdd = (kind: "userIds" | "roleIds", id: string) =>
    mine || saved.mode === "everyone" || saved[kind].includes(id) || audience[kind].includes(id);
  const roleList = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r)));
  const people = [...dir.memberById.values()].filter((m) => m.userId !== ownerId);
  const valid = audience.mode !== "people" || audience.userIds.length + audience.roleIds.length > 0;
  const changed = JSON.stringify(audience) !== JSON.stringify(saved);
  const pick = (mode: DeviceAudience["mode"]) => {
    tapHaptic();
    setAudience((a) => ({ ...a, mode }));
  };
  const flip = (kind: "userIds" | "roleIds", id: string) => {
    tapHaptic();
    setAudience((a) => ({ ...a, [kind]: a[kind].includes(id) ? a[kind].filter((x) => x !== id) : [...a[kind], id] }));
  };
  const submit = () =>
    save.mutate(audience.mode === "people" ? audience : { mode: audience.mode, userIds: [], roleIds: [] }, {
      onSuccess: () => {
        successHaptic();
        toast({ title: t("mobile.devices.audience.saved"), icon: "check" });
        goBack();
      },
      onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
    });
  const modeLabel = (mode: DeviceAudience["mode"]) =>
    mode === "owner" && !mine
      ? t("mobile.devices.audience.mode.ownerOf", { name: ownerName })
      : t(`mobile.devices.audience.mode.${mode}`);
  const modeText = (mode: DeviceAudience["mode"]) =>
    mode === "owner" && !mine
      ? t("mobile.devices.audience.modeText.ownerOf", { name: ownerName })
      : t(`mobile.devices.audience.modeText.${mode}`);
  const warning =
    audience.mode === "everyone"
      ? phone
        ? t("mobile.devices.audience.phoneOnly", { host: hostName })
        : singleUser && mine
          ? t("mobile.devices.audience.runsAs")
          : null
      : null;
  return (
    <SettingsPage
      title={t("mobile.devices.audience.label")}
      subtitle={name}
      locked={save.isPending}
      action={{ label: t("common.save"), onPress: submit, disabled: !valid || !changed || save.isPending }}
    >
      <Gap />
      <GroupedList>
        {MODES.map((mode) => (
          <GroupedRow
            key={mode}
            label={modeLabel(mode)}
            sub={modeText(mode)}
            subLines={2}
            checked={audience.mode === mode}
            {...(allowed({ mode, userIds: audience.userIds, roleIds: audience.roleIds })
              ? { onPress: () => pick(mode) }
              : { faint: true, disabled: true })}
          />
        ))}
      </GroupedList>
      {mine ? null : <GroupedFooter>{t("mobile.devices.audience.narrowOnly", { name: ownerName })}</GroupedFooter>}
      {warning ? <GroupedFooter>{warning}</GroupedFooter> : null}
      {audience.mode === "people" ? (
        <>
          <GroupedHeader>{t("mobile.devices.audience.people")}</GroupedHeader>
          <GroupedList>
            {roleList.map((r) => (
              <GroupedRow
                key={r.id}
                leading={<RoleMark color={r.color} size={22} />}
                label={r.name}
                checked={audience.roleIds.includes(r.id)}
                {...(canAdd("roleIds", r.id)
                  ? { onPress: () => flip("roleIds", r.id) }
                  : { faint: true, disabled: true })}
              />
            ))}
            {people.map((m) => (
              <GroupedRow
                key={m.userId}
                leading={<Face who={{ type: "person", id: m.userId }} size={26} live={false} />}
                label={m.name}
                checked={audience.userIds.includes(m.userId)}
                {...(canAdd("userIds", m.userId)
                  ? { onPress: () => flip("userIds", m.userId) }
                  : { faint: true, disabled: true })}
              />
            ))}
          </GroupedList>
          {valid ? null : <GroupedFooter>{t("mobile.devices.audience.pickSomeone")}</GroupedFooter>}
        </>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  loading: { marginVertical: 16 },
});
