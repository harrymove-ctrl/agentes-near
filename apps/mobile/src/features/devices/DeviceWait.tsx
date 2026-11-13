import { type Message, sendHelpers, usePostMessage } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { EventPillAction, EventPillText, Text, useToast } from "@/ui";
import { AskDone, AskWaiting } from "../chat/asks";
import { useMeId, useOrgId, useWhen } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { deviceWaitOf, isUp, reasonText, statusView } from "./logic";
import { useDeviceMutation, useDevices } from "./queries";

type WaitMessage = Pick<Message, "meta" | "agentRunId" | "channelId" | "threadId">;

/**
 * A run waiting for a device, in its conversation: the waiting pill (a quiet clock, "Waiting for Pixel 8", why under
 * it) with Try now, Use another device (a device the viewer may use, sent as "Use <name> instead" in the thread, which
 * the waiting run reads) and Stop waiting; once the device is back, a decided pill. Not a device wait: `fallback`.
 */
export function DeviceWait({ message, fallback }: { message: WaitMessage; fallback: ReactNode }) {
  const info = deviceWaitOf(message.meta);
  return info ? <DeviceWaitPill message={message} info={info} /> : fallback;
}

function DeviceWaitPill({
  message: m,
  info,
}: {
  message: WaitMessage;
  info: NonNullable<ReturnType<typeof deviceWaitOf>>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const when = useWhen();
  const orgId = useOrgId();
  const meId = useMeId();
  const devices = useDevices();
  const post = usePostMessage(orgId, m.channelId, { me: { id: meId ?? "" } });
  const runId = info.runId ?? m.agentRunId;
  const act = useDeviceMutation((api, org, action: "retry" | "stop") =>
    api.devices.deviceWait(org, runId ?? "", action),
  );
  if (info.over) return <AskDone done words={t("mobile.devices.wait.back", { device: info.device })} />;
  const run = (action: "retry" | "stop") =>
    act.mutate(action, { onError: (err) => toast({ title: errorText(t, err), icon: "x" }) });
  const other = async () => {
    const usable = (devices.data?.devices ?? [])
      .flatMap((d) => [d, ...d.phones])
      .filter((d) => d.mayUse && isUp(d.status) && d.name !== info.device);
    if (usable.length === 0) {
      toast({ title: t("mobile.devices.wait.none"), icon: "info" });
      return;
    }
    const key = await pickOne({
      title: t("mobile.devices.wait.other"),
      options: usable.map((d) => ({ key: d.id, label: d.name, sub: statusView(t, d.status, when).label })),
    });
    const name = usable.find((d) => d.id === key)?.name;
    if (name) sendHelpers(post).send(t("mobile.devices.wait.useInstead", { name }), m.threadId);
  };
  const why = info.reason
    ? info.reason === "offline"
      ? t("mobile.devices.status.offline")
      : reasonText(t, info.reason)
    : null;
  const line = [
    why,
    info.host ? t("mobile.devices.onHost", { host: info.host }) : null,
    info.lastSeenAt ? t("mobile.devices.status.seen", { when: when.short(info.lastSeenAt) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <AskWaiting
      forMe={false}
      mark="clock"
      words={t("mobile.devices.wait.waiting", { device: info.device })}
      actions={
        runId ? (
          <>
            <EventPillAction
              key="try"
              label={t("mobile.devices.wait.tryNow")}
              disabled={act.isPending}
              onPress={() => run("retry")}
            />
            <EventPillAction key="other" label={t("mobile.devices.wait.other")} onPress={() => void other()} />
            <EventPillAction
              key="stop"
              label={t("mobile.devices.wait.stop")}
              disabled={act.isPending}
              onPress={() => run("stop")}
            />
          </>
        ) : null
      }
      below={
        line ? (
          <EventPillText>
            <Text variant="small" tone="muted">
              {line}
            </Text>
          </EventPillText>
        ) : undefined
      }
    />
  );
}
