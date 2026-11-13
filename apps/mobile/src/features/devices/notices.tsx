import { type AppNotification, useNotificationAction } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { firstName } from "@agenteschat/client/lib/format";
import { computerKind } from "@agenteschat/client/lib/machines";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { ComputerIcon } from "@/computer/ComputerPortrait";
import { useOrg } from "@/providers/org";
import { Button, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { AskButtons } from "../chat/asks";
import { useColors, useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { Tile } from "../shared/parts";
import { WaitingCard } from "../shared/WaitingCard";
import { type DeviceNotice, deviceHref, deviceNoticeOf, deviceNoticeTitle, joinFacts } from "./logic";
import { JoinButtons } from "./parts";
import { useDeviceMutation, useDevices } from "./queries";

/** Whom the agent works for, by first name ("" when it's the viewer or nobody says). */
export function useNoticePerson(n: Pick<AppNotification, "kind" | "source" | "latest">) {
  const dir = useDirectory();
  const id = deviceNoticeOf(n)?.forUserId;
  return id ? firstName(dir.nameOf({ type: "person", id })) : "";
}

/**
 * A device notification waiting on the viewer, as Atividade's cards: a computer asking to join (its card with Let it
 * join / Deny), or an agent asking to use their device (Allow once / No, and "Always allow Rui" under them).
 */
export function DeviceNoticeCard({ item: n, first }: { item: AppNotification; first: boolean }) {
  const d = deviceNoticeOf(n);
  if (!d) return null;
  return d.kind === "device.join_request" ? <JoinNotice n={n} d={d} /> : <AccessNotice n={n} d={d} first={first} />;
}

function useDone(n: AppNotification) {
  const act = useNotificationAction(useOrgId());
  return () => act.mutate({ type: "done", item: n, done: true });
}

function JoinNotice({ n, d }: { n: AppNotification; d: DeviceNotice }) {
  const { t } = useTranslation();
  const c = useColors();
  const { org } = useOrg();
  const when = useWhen();
  const requests = useDevices().data?.requests;
  const done = useDone(n);
  const request = requests?.find((r) => r.id === d.requestId) ?? (requests?.length === 1 ? requests[0] : undefined);
  const kind = { icon: "laptop" as const, label: t("mobile.devices.notice.kind") };
  if (request)
    return (
      <WaitingCard
        leading={
          <Tile>
            <ComputerIcon kind={computerKind(request.os)} size={18} color={c.muted} />
          </Tile>
        }
        name={request.name || request.hostname}
        kind={kind}
        title={t("mobile.devices.join.title", { name: request.name || request.hostname, org: org?.name ?? "" })}
        where={when.short(n.updatedAt)}
        decision={<JoinButtons request={request} onDone={done} />}
      >
        <Text variant="small" tone="muted">
          {joinFacts(t, request)}
        </Text>
      </WaitingCard>
    );
  // Answered elsewhere, or out of time: the card opens the devices.
  return (
    <WaitingCard
      kind={kind}
      title={deviceNoticeTitle(t, d, "", "", org?.name ?? "")}
      where={when.short(n.updatedAt)}
      action={{ label: t("mobile.activityNow.open"), onPress: () => router.push("/settings/devices") }}
    />
  );
}

function AccessNotice({ n, d, first }: { n: AppNotification; d: DeviceNotice; first: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const when = useWhen();
  const dir = useDirectory();
  const person = useNoticePerson(n);
  const done = useDone(n);
  const decide = useDeviceMutation((api, orgId, decision: "once" | "always" | "no") =>
    api.devices.decideAccess(orgId, d.requestId ?? "", decision),
  );
  const agent = n.actors.find((a) => a.type === "agent");
  const name = dir.nameOf(agent ? { type: "agent", id: agent.id } : null);
  const answer = (decision: "once" | "always" | "no") =>
    decide.mutate(decision, { onSuccess: done, onError: (err) => toast({ title: errorText(t, err), icon: "x" }) });
  const button = (decision: "once" | "no", label: string, primary: boolean) => (
    <Button
      variant={primary ? "primary" : "secondary"}
      size="card"
      wide
      label={label}
      disabled={decide.isPending || !d.requestId}
      onPress={() => answer(decision)}
    />
  );
  return (
    <WaitingCard
      agentId={agent?.id ?? null}
      name={name}
      kind={{ icon: "laptop", label: t("mobile.devices.notice.kind") }}
      title={deviceNoticeTitle(t, d, name, person, "")}
      where={when.short(n.updatedAt)}
      onPress={() => router.push(deviceHref(d))}
      decision={
        <View style={styles.decide}>
          <AskButtons
            primary={button("once", t("mobile.devices.notice.allowOnce"), first)}
            secondary={button("no", t("mobile.devices.notice.no"), false)}
          />
          <Button
            variant="ghost"
            size="card"
            wide
            label={t("mobile.devices.notice.always", { name: person || name })}
            disabled={decide.isPending || !d.requestId}
            onPress={() => answer("always")}
          />
        </View>
      }
    >
      {d.doing ? (
        <Text variant="small" tone="muted">
          {d.doing}
        </Text>
      ) : null}
    </WaitingCard>
  );
}

/** Under an inbox row: Stop while an agent holds the viewer's phone. */
export function DeviceNoticeActions({ item: n }: { item: AppNotification }) {
  const { t } = useTranslation();
  const toast = useToast();
  const done = useDone(n);
  const d = deviceNoticeOf(n);
  const stop = useDeviceMutation((api, orgId, id: string) => api.devices.stopPhone(orgId, id));
  if (d?.kind !== "device.in_use" || !d.phoneId || n.doneAt) return null;
  const phoneId = d.phoneId;
  return (
    <View style={styles.row}>
      <Button
        variant="secondary"
        size="sm"
        label={t("mobile.devices.notice.stop")}
        disabled={stop.isPending}
        onPress={() =>
          stop.mutate(phoneId, { onSuccess: done, onError: (err) => toast({ title: errorText(t, err), icon: "x" }) })
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  decide: { gap: 8 },
  row: { flexDirection: "row" },
});
