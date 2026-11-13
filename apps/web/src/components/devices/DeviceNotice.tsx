import type { AppNotification } from "@agenteschat/client";
import { type DeviceNotice, deviceNoticeOf, joinFacts } from "@agenteschat/client/lib/devices";
import { errorText } from "@agenteschat/client/lib/errors";
import { firstName } from "@agenteschat/client/lib/format";
import { Button, cx, ProviderLogo } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import type { Dir } from "@/components/NotificationParts";
import { useOrg } from "@/components/org-context";
import { TYPED_VALUES } from "@/i18n";
import { useToast } from "@/lib/toast";
import { JoinRequestDialog } from "./dialogs";
import { osMark } from "./parts";
import { useDecideAccess, useDenyRequest, useDevices, useStopPhone } from "./queries";

/** The agent and the person it works for, as a notice names them: "Lia (for Rui)", or the agent alone. */
function whoFor(dir: Dir, d: DeviceNotice, t: (key: string, o?: Record<string, unknown>) => string) {
  const agent = d.agentId ? (dir.anyAgent(d.agentId)?.name ?? t("channel.unknownAgent")) : "";
  const person = (d.userId ? dir.memberById.get(d.userId)?.name : undefined) ?? d.forName;
  return person && agent ? t("devices.notice.agentFor", { agent, person: firstName(person) }) : agent;
}

/** A device notice's line: who wants what of which device. */
export function DeviceHeadline({ n, dir }: { n: AppNotification; dir: Dir }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const d = deviceNoticeOf(n);
  if (!d) return null;
  const tt = t as unknown as (key: string, o?: Record<string, unknown>) => string;
  const values =
    d.kind === "device.join_request"
      ? { name: d.join?.name ?? d.device, org: org.name }
      : { who: whoFor(dir, d, tt), deviceName: d.device };
  const key = {
    "device.join_request": "devices.notice.join",
    "device.in_use": "devices.notice.inUse",
    "device.access_request": "devices.notice.access",
    "device.waiting": "devices.notice.waiting",
  }[d.kind];
  return <Trans i18nKey={key as never} values={values} components={{ b: <b /> }} {...TYPED_VALUES} />;
}

/** The face of a device notice: the agent that uses or asks for the device, else the joining computer's system. */
export function DeviceFace({ n, className }: { n: AppNotification; className?: string }) {
  const d = deviceNoticeOf(n);
  if (!d) return null;
  if (d.agentId) return <AgentAvatar agentId={d.agentId} name="" size="md" className={className} />;
  return (
    <span className={cx("nt-sys", className)} aria-hidden="true">
      <ProviderLogo id={osMark(d.join?.os ?? "")} size="xs" />
    </span>
  );
}

/** Where a device notice opens: the phone's or computer's page, or the list for a computer asking to join. */
export function deviceTarget(n: AppNotification): string | null {
  const d = deviceNoticeOf(n);
  if (!d) return null;
  if (d.phoneId) return `phones/${d.phoneId}`;
  if (d.machineId && d.kind !== "device.join_request") return d.machineId;
  return "";
}

/** The decision's buttons: a row under an inbox row's text, or in a waiting card's foot (`inline`). */
function Wrap({
  inline,
  onClick,
  children,
}: {
  inline: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: ReactNode;
}) {
  return inline ? (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps the card's own click away from its buttons
    <span className="ac-acts" onClick={onClick} onKeyDown={() => {}}>
      {children}
    </span>
  ) : (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps the row's own click away from its buttons
    <div className="nt-steprow ac-acts" onClick={onClick} onKeyDown={() => {}}>
      {children}
    </div>
  );
}

/** A device notice's second line: a joining computer's facts, or what the agent is doing. */
export function deviceNoticeLine(t: TFunction, n: AppNotification): string | null {
  const d = deviceNoticeOf(n);
  if (!d) return null;
  // The server writes a joining computer's facts as one line (`latest.text`: "Linux · 203.0.113.7 · Frankfurt").
  if (d.join?.os)
    return joinFacts(t, { hostname: d.join.name, os: d.join.os, arch: "", ip: d.join.ip, location: d.join.location });
  return d.text;
}

/**
 * A device notice's own decision, in the row: Let it join or Deny a computer, Stop an agent on the person's phone,
 * Allow once, Always or No to someone's agent asking for a device.
 */
export function DeviceNoticeActions({ n, inline = false }: { n: AppNotification; inline?: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const devices = useDevices(org.id);
  const deny = useDenyRequest(org.id);
  const stop = useStopPhone(org.id);
  const decide = useDecideAccess(org.id);
  const [joining, setJoining] = useState(false);
  const d = deviceNoticeOf(n);
  if (!d || n.doneAt) return null;
  const fail = (err: unknown) => toast.show(errorText(t, err), "error");
  const busy = deny.isPending || stop.isPending || decide.isPending;
  const request = d.requestId ? devices.data?.requests.find((r) => r.id === d.requestId) : undefined;
  const answer = (decision: "once" | "always" | "no") =>
    d.requestId &&
    decide.mutate(
      { id: d.requestId, decision },
      { onSuccess: () => toast.show(t(`devices.notice.decided.${decision}`, { deviceName: d.device })), onError: fail },
    );
  // Clicks here are the row's own: they never open it.
  const keep = (e: React.MouseEvent) => e.stopPropagation();
  if (d.kind === "device.join_request" && d.requestId && request)
    return (
      <Wrap inline={inline} onClick={keep}>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => setJoining(true)}>
          {t("devices.request.letJoin")}
        </Button>
        <Button
          size="sm"
          loading={deny.isPending}
          disabled={busy}
          onClick={() =>
            d.requestId &&
            deny.mutate(d.requestId, {
              onSuccess: () => toast.show(t("devices.request.denied", { name: request.name })),
              onError: fail,
            })
          }
        >
          {t("devices.request.deny")}
        </Button>
        <JoinRequestDialog request={joining ? request : null} onClose={() => setJoining(false)} />
      </Wrap>
    );
  if (d.kind === "device.in_use" && d.phoneId)
    return (
      <Wrap inline={inline} onClick={keep}>
        <Button
          size="sm"
          icon="stop"
          loading={stop.isPending}
          disabled={busy}
          onClick={() =>
            d.phoneId &&
            stop.mutate(d.phoneId, {
              onSuccess: () => toast.show(t("devices.stopped", { name: d.device })),
              onError: fail,
            })
          }
        >
          {t("devices.stop")}
        </Button>
      </Wrap>
    );
  if (d.kind === "device.access_request" && d.requestId)
    return (
      <Wrap inline={inline} onClick={keep}>
        <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => answer("once")}>
          {t("devices.notice.once")}
        </Button>
        <Button size="sm" icon="check" disabled={busy} onClick={() => answer("always")}>
          {t("devices.notice.always")}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => answer("no")}>
          {t("devices.notice.no")}
        </Button>
      </Wrap>
    );
  return null;
}
