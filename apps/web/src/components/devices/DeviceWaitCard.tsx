import type { Message } from "@agenteschat/client";
import { type DeviceWait, waitEndedText, waitText } from "@agenteschat/client/lib/devices";
import { errorText } from "@agenteschat/client/lib/errors";
import { clockAt } from "@agenteschat/client/lib/format";
import { computerKind } from "@agenteschat/client/lib/machines";
import { ComputerIcon, EventPillAction, Icon, Menu, MenuItem, MenuNote, ProviderLogo } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useChannelActions } from "@/components/channel-actions";
import { useOrg } from "@/components/org-context";
import { RequestDone, RequestOpen } from "@/components/RequestCard";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { useDevices, useDeviceWait } from "./queries";

/**
 * An agent's run parked until a device can take it (`meta.deviceWait`): one waiting pill (it waits for the device, not
 * for the viewer) with Try now, Use another device and Stop waiting, the why under it. Once the server ends the wait
 * (`state` past `waiting`, live through `device_wait.updated`), one quiet line saying how, never live buttons.
 */
export function DeviceWaitCard({ wait, message }: { wait: DeviceWait; message: Pick<Message, "author"> }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const devices = useDevices(org.id);
  const act = useDeviceWait(org.id);
  const actions = useChannelActions();
  const dir = useDirectory(org.id);
  const agent = message.author.type === "agent" && message.author.id ? dir.agentById.get(message.author.id) : undefined;
  const owner = wait.ownerUserId ? (dir.memberById.get(wait.ownerUserId)?.name ?? null) : null;
  if (wait.state !== "waiting") {
    const text = waitEndedText(t, wait, owner);
    return (
      <RequestDone
        done={wait.state === "back" || wait.state === "allowed" || wait.state === "retried"}
        label={text}
        time={wait.endedAt ? clockAt(i18n.language, wait.endedAt) : undefined}
      >
        {text}
      </RequestDone>
    );
  }
  const title = t("devices.wait.title", { deviceName: wait.deviceName });
  const run = (action: "retry" | "stop") =>
    wait.runId &&
    act.mutate({ runId: wait.runId, action }, { onError: (err) => toast.show(errorText(t, err), "error") });
  // Devices the people here may point agents at, besides the one it waits for, that can take work now.
  const others = (devices.data?.devices ?? [])
    .flatMap((d) => [d, ...d.phones])
    .filter((d) => d.mayUse && d.id !== wait.deviceId && d.status.kind !== "offline" && d.status.kind !== "needs_you");
  return (
    <RequestOpen
      mine={false}
      icon="waiting"
      label={title}
      action={
        wait.runId ? (
          <>
            <EventPillAction disabled={act.isPending} onClick={() => run("retry")}>
              {t("devices.wait.tryNow")}
            </EventPillAction>
            <Menu
              label={t("devices.wait.useAnother")}
              trigger={<EventPillAction>{t("devices.wait.useAnother")}</EventPillAction>}
            >
              {others.length === 0 ? (
                <MenuNote>{t("devices.wait.noOther")}</MenuNote>
              ) : (
                others.map((d) => (
                  <MenuItem
                    key={d.id}
                    leading={
                      "platform" in d ? (
                        <Icon name="phone" size={16} />
                      ) : (
                        <ComputerIcon kind={computerKind(d.os)} size={16} />
                      )
                    }
                    onSelect={() =>
                      actions?.resend(
                        agent
                          ? t("devices.wait.useInstead", { handle: agent.handle, name: d.name })
                          : t("devices.wait.useInsteadPlain", { name: d.name }),
                      )
                    }
                  >
                    {d.name}
                  </MenuItem>
                ))
              )}
            </Menu>
            <EventPillAction disabled={act.isPending} onClick={() => run("stop")}>
              {t("devices.wait.stop")}
            </EventPillAction>
          </>
        ) : undefined
      }
      below={
        <p className="ac-iconline">
          {wait.platform && <ProviderLogo id={wait.platform === "ios" ? "apple" : "android"} size="xs" />}
          {waitText(t, i18n.language, wait, { owner })}
        </p>
      }
    >
      {title}
    </RequestOpen>
  );
}
