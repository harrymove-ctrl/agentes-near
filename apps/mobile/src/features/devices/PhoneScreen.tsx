import { computerName } from "@agenteschat/client/lib/computer";
import { iphoneOverWifi, personInControl } from "@agenteschat/client/lib/devices";
import { errorText } from "@agenteschat/client/lib/errors";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { EmptyState, GroupedFooter, GroupedList, GroupedRow, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { confirmAction, Gap, SettingsPage } from "../settings/parts";
import { useColors, useMeId } from "../shared/hooks";
import { goBack } from "../shared/parts";
import { openThisPhone } from "./DevicesScreen";
import { findDevice, phoneFacts } from "./logic";
import { PhoneLive } from "./PhoneLive";
import { DevicePortrait, PhoneNameField, StatusLine, useAudienceText } from "./parts";
import { useDeviceMutation, useDevices } from "./queries";

/**
 * One phone, reached through a computer: its portrait and state, its screen live (`PhoneLive`), what it is and where,
 * its name, who can use it (an iPhone follows its Mac), Stop while an agent holds it (its owner, admins, or whom the
 * agent works for), Forget.
 */
export function PhoneScreen({ phoneId }: { phoneId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const { org } = useOrg();
  const meId = useMeId();
  const list = useDevices();
  const audienceText = useAudienceText();
  const stop = useDeviceMutation((api, orgId, id: string) => api.devices.stopPhone(orgId, id));
  const forget = useDeviceMutation((api, orgId, id: string) => api.devices.forgetPhone(orgId, id));
  const found = findDevice(list.data?.devices, phoneId);
  const p = found?.phone;
  if (!found || !p) {
    return (
      <SettingsPage title={t("mobile.devices.title")}>
        {list.isLoading ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : (
          <View style={styles.missing}>
            <EmptyState title={t("mobile.devices.page.notFound")} subtitle={t("mobile.devices.page.notFoundText")} />
          </View>
        )}
      </SettingsPage>
    );
  }
  const host = computerName(
    t,
    org?.name ?? "",
    { kind: found.computer.machineKind, name: found.computer.name },
    isPersonal(org),
  );
  const s = p.status;
  const holder = s.kind === "in_use" ? s : null;
  // An iPhone follows its Mac: its row shows and changes the Mac's rule (the footer says so).
  const ruled = p.audience ? p : found.computer;
  // A person in control gives it back on its screen instead.
  const mayStop =
    holder !== null && personInControl(s) !== meId && (p.mayManage || (meId !== null && holder.userId === meId));
  // The guide is for the phone in hand: an iPhone's steps on an iPhone, Android's on Android.
  const guide =
    s.kind === "needs_you" && (Platform.OS === "ios") === (p.platform === "ios") && p.phoneKind === "device";
  // An iPhone over Wi-Fi is let go, not forgotten: it comes back only if picked again.
  const wifi = iphoneOverWifi(p);
  const askForget = () =>
    confirmAction({
      title: wifi
        ? t("mobile.devices.iphone.wifi.stopTitle", { name: p.name })
        : t("mobile.devices.page.forgetTitle", { name: p.name }),
      text: wifi ? t("mobile.devices.iphone.wifi.stopText", { host }) : t("mobile.devices.page.forgetText", { host }),
      action: wifi ? t("mobile.devices.iphone.wifi.stop") : t("mobile.devices.page.forget"),
      cancel: t("common.cancel"),
      onConfirm: () =>
        forget.mutate(p.id, {
          onSuccess: () => {
            toast({
              title: wifi
                ? t("mobile.devices.iphone.wifi.stopped", { name: p.name })
                : t("mobile.devices.page.forgotten", { name: p.name }),
              icon: "check",
            });
            goBack();
          },
          onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
        }),
    });
  return (
    <SettingsPage title={p.name}>
      <View style={styles.head}>
        <DevicePortrait phone={p} size={96} />
        <StatusLine status={s} hostName={host} center />
        <Text variant="small" tone="muted" style={styles.center}>
          {phoneFacts(t, p, host)}
        </Text>
        {holder?.label ? (
          <Text variant="small" tone="muted" style={styles.center}>
            {holder.label}
          </Text>
        ) : null}
      </View>
      <Gap />
      <PhoneLive key={p.id} phone={p} host={host} />
      {guide ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="help"
              label={t("mobile.devices.page.showHow")}
              chevron
              onPress={() => openThisPhone(found.computer.id)}
            />
          </GroupedList>
        </>
      ) : null}
      <Gap />
      <GroupedList>
        <PhoneNameField key={p.name} phone={p} />
        <GroupedRow
          label={t("mobile.devices.audience.label")}
          value={audienceText(ruled.audience, ruled.ownerUserId, host)}
          {...(ruled.mayManage
            ? {
                chevron: true,
                onPress: () => router.push({ pathname: "/settings/devices/audience", params: { id: ruled.id } }),
              }
            : {})}
        />
      </GroupedList>
      <GroupedFooter>
        {p.audience ? t("mobile.devices.page.shareNote", { host }) : t("mobile.devices.page.followsHost")}
      </GroupedFooter>
      {mayStop || p.mayManage ? (
        <>
          <Gap />
          <GroupedList>
            {mayStop && holder ? (
              <GroupedRow
                icon="stop"
                label={t("mobile.devices.page.stop", { name: holder.agentName ?? holder.userName ?? "" })}
                disabled={stop.isPending}
                onPress={() =>
                  stop.mutate(p.id, {
                    onSuccess: () =>
                      toast({
                        title: t("mobile.devices.page.stopped", {
                          device: p.name,
                          name: holder.agentName ?? holder.userName ?? "",
                        }),
                        icon: "check",
                      }),
                    onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
                  })
                }
              />
            ) : null}
            {p.mayManage ? (
              <GroupedRow
                icon="x"
                label={wifi ? t("mobile.devices.iphone.wifi.stop") : t("mobile.devices.page.forget")}
                danger
                disabled={forget.isPending}
                onPress={askForget}
              />
            ) : null}
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  loading: { marginVertical: 16 },
  missing: { paddingTop: 40 },
  head: { alignItems: "center", gap: 8, paddingTop: 10, paddingBottom: 6, paddingHorizontal: 8 },
  center: { textAlign: "center" },
});
