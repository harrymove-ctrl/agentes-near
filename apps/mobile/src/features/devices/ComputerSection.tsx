import { type ComputerDevice, useWifiIphones } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { computerKind } from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { Button, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Gap } from "../settings/parts";
import { useMeId, useOrgId } from "../shared/hooks";
import { openPhone } from "./DevicesScreen";
import { DevicePortrait, StatusLine, useAudienceText } from "./parts";
import { useDeviceMutation } from "./queries";

/**
 * On a computer's page, what bringing devices adds: who can use it (its owner changes it, an admin narrows it), the
 * workspace's mark for admins, the line about whose computer it is, the phones plugged into it, and on a Mac the
 * iPhones on its Wi-Fi that trust it, each with Use over Wi-Fi (for who may manage it).
 */
export function ComputerSection({ device: d, name }: { device: ComputerDevice; name: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { org } = useOrg();
  const meId = useMeId();
  const audienceText = useAudienceText();
  const mark = useDeviceMutation((api, orgId, on: boolean) =>
    api.devices.updateComputer(orgId, d.id, { belongsToWorkspace: on }),
  );
  const brought = d.machineKind === "connected";
  const admin = can(org, "configure");
  const wifi = useWifiIphones(
    useOrgId(),
    d.id,
    d.mayManage && computerKind(d.os) === "mac" && d.status.kind !== "offline",
  );
  return (
    <>
      {d.machineKind !== "managed" ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              label={t("mobile.devices.audience.label")}
              value={audienceText(d.audience, d.ownerUserId)}
              {...(d.mayManage
                ? {
                    chevron: true,
                    onPress: () => router.push({ pathname: "/settings/devices/audience", params: { id: d.id } }),
                  }
                : {})}
            />
            {brought && admin ? (
              <GroupedRow
                label={t("mobile.devices.page.belongs")}
                labelLines={2}
                hint={{
                  name: t("common.about", { label: t("mobile.devices.page.belongs") }),
                  text: t("mobile.devices.page.belongsHint"),
                }}
                toggle={d.belongsToWorkspace}
                disabled={mark.isPending}
                onPress={() =>
                  mark.mutate(!d.belongsToWorkspace, {
                    onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
                  })
                }
              />
            ) : null}
          </GroupedList>
          {brought && d.ownerUserId !== meId ? (
            <GroupedFooter>{t("mobile.devices.page.ownerReads")}</GroupedFooter>
          ) : null}
        </>
      ) : null}
      {d.phones.length > 0 || wifi.available.length > 0 ? (
        <>
          <GroupedHeader>{t("mobile.devices.page.phones")}</GroupedHeader>
          <GroupedList>
            {wifi.available.map((p) => (
              <GroupedRow
                key={p.serial}
                icon="wifi"
                label={t("mobile.devices.iphone.wifi.also", { host: name, name: p.name ?? p.model })}
                labelLines={3}
                hint={{
                  name: t("common.about", { label: t("mobile.devices.iphone.wifi.use") }),
                  text: t("mobile.devices.iphone.wifi.hint"),
                }}
                below={
                  <Button
                    size="sm"
                    variant="secondary"
                    label={t("mobile.devices.iphone.wifi.use")}
                    loading={wifi.pick.isPending && wifi.pick.variables === p.serial}
                    disabled={wifi.pick.isPending}
                    onPress={() =>
                      wifi.pick.mutate(p.serial, { onError: (err) => toast({ title: errorText(t, err), icon: "x" }) })
                    }
                  />
                }
              />
            ))}
            {d.phones.map((p) => (
              <GroupedRow
                key={p.id}
                leading={<DevicePortrait phone={p} />}
                label={p.name}
                labelLines={2}
                below={<StatusLine status={p.status} hostName={name} />}
                chevron
                onPress={() => openPhone(p.id)}
              />
            ))}
          </GroupedList>
        </>
      ) : null}
    </>
  );
}
