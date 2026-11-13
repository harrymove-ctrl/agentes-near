import type { ComputerDevice, DeviceStatus, PhoneDevice } from "@agenteschat/client";
import { useRoles } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, TextInput, type TextInputInstance, View } from "react-native";
import { ComputerPortrait } from "@/computer/ComputerPortrait";
import { useOrg } from "@/providers/org";
import { Button, Chip, fieldText, GROUPED_ROW, GroupedList, GroupedRow, Icon, InkOrbit, Text, useToast } from "@/ui";
import { AskButtons } from "../chat/asks";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useWhen } from "../shared/hooks";
import { successHaptic, useSurface } from "../shared/parts";
import { audienceText, computerPortrait, type DeviceJoin, joinFacts, phonePortrait, statusView } from "./logic";
import { useDeviceMutation } from "./queries";

/** A device's state: its chip (with its icon, the agent's face, or amber when it needs you) and the words after it. */
export function StatusLine({
  status,
  hostName,
  center = false,
}: {
  status: DeviceStatus;
  hostName?: string | null;
  /** On a device's page, under its portrait. */
  center?: boolean;
}) {
  const { t } = useTranslation();
  const when = useWhen();
  const v = statusView(t, status, when, hostName);
  const leading =
    v.icon === "spin" ? (
      <InkOrbit size={12} />
    ) : v.icon === "face" ? (
      <AgentFace agentId={v.agentId} size={14} live={false} />
    ) : undefined;
  return (
    <View style={[styles.status, center ? styles.centered : null]}>
      <Chip
        label={v.label}
        tone={v.wait ? "wait" : "neutral"}
        {...(leading ? { leading } : v.icon && v.icon !== "face" && v.icon !== "spin" ? { icon: v.icon } : {})}
      />
      {v.line ? (
        <Text variant="footnote" tone="faint">
          {v.line}
        </Text>
      ) : null}
    </View>
  );
}

/** A computer's or a phone's portrait (48 in rows, 96 on its page). */
export function DevicePortrait({
  computer,
  phone,
  size = 48,
}: {
  computer?: Pick<ComputerDevice, "os" | "status">;
  phone?: Pick<PhoneDevice, "platform" | "status">;
  size?: 48 | 96;
}) {
  const p = phone ? phonePortrait(phone) : computer ? computerPortrait(computer) : null;
  return p ? <ComputerPortrait kind={p.kind} state={p.state} size={size} /> : null;
}

/** Names for a device's rule: people by id, roles by id. */
export function useAudienceText() {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const roles = useRoles(orgId).data?.roles ?? [];
  return (audience: Parameters<typeof audienceText>[1], ownerId: string | null, hostName?: string | null) =>
    audienceText(t, audience, {
      ownerId,
      meId,
      hostName: hostName ?? null,
      nameOf: (id) => dir.memberById.get(id)?.name ?? "",
      roleName: (id) => roles.find((r) => r.id === id)?.name ?? "",
    });
}

/**
 * A computer that ran a connect link, waiting for the link's maker: "build-box wants to join Acme", its facts (system,
 * address, rough place) and Let it join / Deny. Answered here, it leaves the list by itself.
 */
export function JoinRequestCard({ request: r }: { request: DeviceJoin }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const surface = useSurface();
  return (
    <View style={[styles.card, surface]}>
      <Text variant="callout" tone="ink" style={styles.bold}>
        {t("mobile.devices.join.title", { name: r.name || r.hostname, org: org?.name ?? "" })}
      </Text>
      <Text variant="small" tone="muted">
        {joinFacts(t, r)}
      </Text>
      <View style={styles.buttons}>
        <JoinButtons request={r} />
      </View>
    </View>
  );
}

/** Let it join / Deny for a computer asking to join, on its card or on its notice in Atividade. */
export function JoinButtons({ request: r, onDone }: { request: DeviceJoin; onDone?: (joined: boolean) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const approve = useDeviceMutation((api, orgId, id: string) => api.devices.approveRequest(orgId, id, {}));
  const deny = useDeviceMutation((api, orgId, id: string) => api.devices.denyRequest(orgId, id));
  const busy = approve.isPending || deny.isPending;
  const failed = (err: unknown) => toast({ title: errorText(t, err), icon: "x" });
  return (
    <AskButtons
      primary={
        <Button
          variant="primary"
          size="card"
          wide
          label={t("mobile.devices.join.allow")}
          disabled={busy}
          onPress={() =>
            approve.mutate(r.id, {
              onSuccess: () => {
                successHaptic();
                toast({ title: t("mobile.devices.join.joined", { name: r.name || r.hostname }), icon: "check" });
                onDone?.(true);
              },
              onError: failed,
            })
          }
        />
      }
      secondary={
        <Button
          size="card"
          variant="secondary"
          wide
          label={t("mobile.devices.join.deny")}
          disabled={busy}
          onPress={() =>
            deny.mutate(r.id, {
              onSuccess: () => {
                toast({ title: t("mobile.devices.join.denied", { name: r.name || r.hostname }), icon: "x" });
                onDone?.(false);
              },
              onError: failed,
            })
          }
        />
      }
    />
  );
}

/** A device that just got ready: its portrait, the check with "Pixel 8 is connected", and what it is and where. */
export function ConnectedHero({ portrait, title, line }: { portrait: ReactNode; title: string; line: string }) {
  const c = useColors();
  return (
    <GroupedList>
      <View style={styles.hero} accessibilityLiveRegion="polite">
        {portrait}
        <View style={styles.heroTitle}>
          <View style={[styles.tick, { backgroundColor: c.ok }]}>
            <Icon name="check" size={12} color={c.bg} />
          </View>
          <Text variant="title2" tone="ink" style={styles.shrink}>
            {title}
          </Text>
        </View>
        <Text variant="small" tone="muted" style={styles.center}>
          {line}
        </Text>
      </View>
    </GroupedList>
  );
}

/** A phone's name, typed in place: saved when the keyboard closes, if it changed (who may change it only). */
export function PhoneNameField({ phone }: { phone: Pick<PhoneDevice, "id" | "name" | "mayManage"> }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const [name, setName] = useState(phone.name);
  const input = useRef<TextInputInstance | null>(null);
  const rename = useDeviceMutation((api, orgId, v: string) => api.devices.updatePhone(orgId, phone.id, { name: v }));
  const save = () => {
    const clean = name.trim();
    if (!clean || clean === phone.name) {
      setName(phone.name);
      return;
    }
    rename.mutate(clean, {
      onSuccess: () => toast({ title: t("mobile.devices.page.renamed", { name: clean }), icon: "check" }),
      onError: (err) => {
        setName(phone.name);
        toast({ title: errorText(t, err), icon: "x" });
      },
    });
  };
  const label = t("mobile.devices.page.name");
  // Read as the rows under it (the label, its value at the right edge), the pen where their chevrons are.
  if (!phone.mayManage) return <GroupedRow label={label} value={phone.name} />;
  return (
    <Pressable onPress={() => input.current?.focus()} accessible={false} style={styles.nameRow}>
      <Text variant="body" tone="ink">
        {label}
      </Text>
      <TextInput
        ref={input}
        value={name}
        onChangeText={setName}
        onEndEditing={save}
        editable={!rename.isPending}
        returnKeyType="done"
        autoCorrect={false}
        textAlign="right"
        accessibilityLabel={label}
        style={[fieldText("callout"), styles.input, { color: c.faint }]}
      />
      <Icon name="pen" size={15} color={c.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
  },
  input: { flex: 1, minWidth: 0, paddingVertical: 12, paddingHorizontal: 0 },
  hero: { alignItems: "center", gap: 8, paddingTop: 24, paddingBottom: 24, paddingHorizontal: 16 },
  heroTitle: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: "100%" },
  tick: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  shrink: { flexShrink: 1 },
  center: { textAlign: "center" },
  status: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 4, marginTop: 4 },
  centered: { justifyContent: "center", marginTop: 0 },
  card: { borderRadius: 14, padding: 16, gap: 4 },
  bold: { fontWeight: "600" },
  buttons: { marginTop: 12 },
});
