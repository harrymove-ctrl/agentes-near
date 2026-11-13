import { type PhoneDevice, useLookForPhones } from "@agenteschat/client";
import { computerName } from "@agenteschat/client/lib/computer";
import {
  ANDROID_SLOW_MS,
  ANDROID_UDEV,
  ANDROID_USB_DRIVERS,
  type AndroidStage,
  type AndroidStep,
  androidNotShowing,
  androidSteps,
  type StepState,
  wifiPairLive,
  wifiPairText,
} from "@agenteschat/client/lib/devices";
import { errorText } from "@agenteschat/client/lib/errors";
import { computerKind } from "@agenteschat/client/lib/machines";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import * as Device from "expo-device";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  CodeInput,
  fieldText,
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  InkOrbit,
  Locked,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note, OpenPage, Step, StepsCard, StepText } from "../ai/parts";
import { Gap, SettingsPage } from "../settings/parts";
import { useMeId, useNow } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { goBack } from "../shared/parts";
import { androidStage, phoneFacts, phoneHosts, reasonText, thisPhoneOn } from "./logic";
import { ConnectedHero, DevicePortrait, PhoneNameField, useAudienceText } from "./parts";
import { useDevices, useWifiPairCode } from "./queries";

/** Android's Settings screens, each with the row to light up (AOSP's `:settings:fragment_args_key`). */
const SCREENS = {
  about: { action: "android.settings.DEVICE_INFO_SETTINGS", row: "build_number" },
  usb: { action: "android.settings.APPLICATION_DEVELOPMENT_SETTINGS", row: "enable_adb" },
  wifi: { action: "android.settings.APPLICATION_DEVELOPMENT_SETTINGS", row: "toggle_adb_wireless" },
} as const;

/** The computer a phone plugs into: the one named, one already seeing this phone, or the person's only one. */
function useHost(machineId: string | undefined) {
  const list = useDevices(4000);
  const meId = useMeId();
  const [picked, setPicked] = useState<string | null>(machineId ?? null);
  const devices = list.data?.devices ?? [];
  const hosts = phoneHosts(devices, meId, "android");
  const seeing = devices.find((d) => thisPhoneOn(d.phones, "android", Device.modelName));
  const host = devices.find((d) => d.id === picked) ?? seeing ?? (hosts.length === 1 ? hosts[0] : undefined);
  return { list, hosts, host, setPicked };
}

const STEP_LOOK: Record<StepState, "now" | "done" | "later"> = {
  done: "done",
  current: "now",
  needs: "now",
  waiting: "later",
};

/**
 * "Deixar agentes usarem este celular", on the Android phone itself: Developer options and USB debugging with buttons
 * that open those exact screens and Done to tick each (the computer can't see them until the phone shows up), then the
 * cable into the computer, with a live line from what the computer reports (not seen yet, no driver for it, waiting for
 * Allow, ready), and Android's own prompt drawn in the app's language. One step is open at a time, a folded one opens
 * when tapped; once the computer sees the phone, every step before Allow ticks by itself. After 30 s on the cable with
 * no phone seen, why it may not show up, for the computer's system. Ready, it says so, with the phone's name and who
 * can use it. No cable: Wireless debugging, then the QR agentes.chat shows on a computer, or the six-digit code typed
 * here.
 */
export function AndroidSetupScreen({ machineId }: { machineId?: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { org } = useOrg();
  const { list, hosts, host, setPicked } = useHost(machineId);
  const [openedWifi, setOpenedWifi] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<AndroidStep>>(() => new Set());
  const [asked, setAsked] = useState<{ step: AndroidStep; at: AndroidStage["kind"] } | null>(null);
  const [wifi, setWifi] = useState(false);
  const [byCode, setByCode] = useState(false);
  const pairing = useWifiPairCode(host?.id ?? null);
  const hostName = host
    ? computerName(t, org?.name ?? "", { kind: host.machineKind, name: host.name }, isPersonal(org))
    : "";
  const pairedId = pairing.pairing?.phoneId;
  const phone = host
    ? ((pairedId ? host.phones.find((p) => p.id === pairedId) : undefined) ??
      thisPhoneOn(host.phones, "android", Device.modelName))
    : null;
  const stage = androidStage(phone);
  const hostDown = host?.status.kind === "offline";
  const reason = phone && phone.status.kind !== "offline" && "reason" in phone.status ? phone.status.reason : null;
  const cable: AndroidStage =
    !phone || stage === "looking"
      ? { kind: "looking" }
      : reason === "no_driver"
        ? { kind: "driver", phone }
        : { kind: "allow", phone };
  const steps = androidSteps(cable, ticked, asked?.at === cable.kind ? asked.step : null);
  const waiting = Boolean(host) && !wifi && !hostDown && cable.kind === "looking" && steps.now === "plug";
  const [since, setSince] = useState<number | null>(null);
  if (waiting !== (since !== null)) setSince(waiting ? Date.now() : null);
  const now = useNow(waiting ? 1000 : 60_000);
  const slow = since !== null && Math.max(now, Date.now()) - since >= ANDROID_SLOW_MS;
  useLookForPhones(org?.id ?? "", host?.id ?? null, Boolean(org) && !wifi && !hostDown && stage !== "done");
  if (host && phone && stage === "done") return <AndroidDone phone={phone} hostName={hostName} />;

  const open = (screen: keyof typeof SCREENS) => {
    const s = SCREENS[screen];
    Linking.sendIntent(s.action, [{ key: ":settings:fragment_args_key", value: s.row }]).then(
      () => {
        if (screen === "wifi") setOpenedWifi(true);
      },
      () => toast({ title: t("mobile.devices.android.openFailed"), icon: "x" }),
    );
  };
  const choose = async () => {
    const key = await pickOne({
      title: t("mobile.devices.android.computer"),
      options: hosts.map((h) => ({ key: h.id, label: h.name })),
      value: host?.id ?? null,
    });
    if (key) setPicked(key);
  };
  const tick = (step: AndroidStep, on: boolean) => {
    setTicked((had) => {
      const next = new Set(had);
      if (on) next.add(step);
      else next.delete(step);
      return next;
    });
    setAsked(null);
  };
  /** A step's look, and a tap that opens it while folded. */
  const fold = (step: AndroidStep) => ({
    state: STEP_LOOK[steps.states[step]],
    onPress: steps.open === step ? undefined : () => setAsked({ step, at: cable.kind }),
  });
  const shown = (step: AndroidStep) => steps.open === step;
  /** Done on a step still to do; Not done yet on a tick only the person gave. */
  const mark = (step: AndroidStep) =>
    steps.states[step] !== "done" ? (
      <Button
        size="sm"
        variant="secondary"
        icon="check"
        label={t("devices.android.done")}
        onPress={() => tick(step, true)}
      />
    ) : steps.byHand.has(step) ? (
      <Button size="sm" variant="ghost" label={t("devices.android.notYet")} onPress={() => tick(step, false)} />
    ) : null;
  const linux = computerKind(host?.os) === "linux";
  // Seen by the computer at all (Wi-Fi): Wireless debugging is on, so its first step is done whatever was tapped here.
  const seen = stage !== "looking";
  const liveLine = hostDown ? (
    <Note icon="x">{t("mobile.devices.android.hostOffline", { host: hostName })}</Note>
  ) : (
    <Note icon={<InkOrbit size={15} />} live>
      {t("mobile.devices.android.looking")}
    </Note>
  );
  return (
    <SettingsPage
      title={t("mobile.devices.android.title")}
      subtitle={host ? t("mobile.devices.android.connecting", { host: hostName }) : undefined}
    >
      {hosts.length > 1 ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              label={t("mobile.devices.android.computer")}
              value={hostName}
              menu
              onPress={() => void choose()}
            />
          </GroupedList>
        </>
      ) : null}
      {!host && list.isSuccess ? (
        <View style={styles.block}>
          <Note icon="info">{t("mobile.devices.android.noHost")}</Note>
          <Button
            size="sm"
            variant="secondary"
            label={t("mobile.devices.connect.title")}
            onPress={() => router.push("/settings/devices/connect")}
          />
        </View>
      ) : null}
      {host && !wifi ? (
        <View style={styles.steps}>
          <StepsCard>
            <Step
              n={1}
              title={t("mobile.devices.android.step1")}
              {...fold("devOptions")}
              side={
                shown("devOptions") ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="out"
                      label={t("mobile.devices.android.openAbout")}
                      onPress={() => open("about")}
                    />
                    {mark("devOptions")}
                  </>
                ) : undefined
              }
            >
              {shown("devOptions") ? <StepText>{t("mobile.devices.android.step1Text")}</StepText> : null}
            </Step>
            <Step
              n={2}
              divider
              title={t("mobile.devices.android.step2")}
              {...fold("usbDebugging")}
              side={
                shown("usbDebugging") ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="out"
                      label={t("mobile.devices.android.openDev")}
                      onPress={() => open("usb")}
                    />
                    {mark("usbDebugging")}
                  </>
                ) : undefined
              }
            />
            <Step n={3} divider title={t("mobile.devices.android.step3", { host: hostName })} {...fold("plug")}>
              {!shown("plug") ? null : cable.kind === "driver" ? (
                <>
                  <Note icon="info">
                    {t(linux ? "devices.android.noDriverLinux" : "devices.android.noDriver", { computer: hostName })}
                  </Note>
                  {linux ? <OpenPage href={ANDROID_UDEV} label={t("devices.android.udev")} /> : <DriverLinks />}
                </>
              ) : steps.states.plug === "done" ? null : (
                <>
                  {liveLine}
                  {slow ? (
                    <NotShowing
                      os={host.os}
                      onUsbDebugging={() => setAsked({ step: "usbDebugging", at: cable.kind })}
                    />
                  ) : null}
                </>
              )}
            </Step>
            <Step n={4} divider title={t("mobile.devices.android.step4")} {...fold("allow")}>
              {shown("allow") ? (
                <>
                  <StepText>{t("mobile.devices.android.step4Text")}</StepText>
                  {reason && reason !== "unauthorized" && reason !== "no_driver" ? (
                    <Note icon="info">{reasonText(t, reason, host.os)}</Note>
                  ) : null}
                  <AdbPrompt />
                </>
              ) : null}
            </Step>
          </StepsCard>
        </View>
      ) : null}
      {host && wifi ? (
        <View style={styles.steps}>
          <StepsCard>
            <Step
              n={1}
              title={t("mobile.devices.android.wifi1")}
              state={seen || openedWifi ? "done" : "now"}
              side={
                <Button
                  size="sm"
                  variant="secondary"
                  icon="out"
                  label={t("mobile.devices.android.openDev")}
                  onPress={() => open("wifi")}
                />
              }
            >
              {seen || openedWifi ? null : <StepText>{t("mobile.devices.android.wifi1Text")}</StepText>}
            </Step>
            <Step
              n={2}
              divider
              title={t("mobile.devices.android.wifi2")}
              hint={t("mobile.devices.android.wifi2Hint", { host: hostName })}
              state={seen ? "done" : openedWifi ? "now" : "later"}
            >
              <StepText>{t("mobile.devices.android.wifi2Text")}</StepText>
              {seen || byCode ? null : liveLine}
            </Step>
          </StepsCard>
          <Gap />
          {byCode ? (
            <PairByCode pairing={pairing} hostName={hostName} mac={computerKind(host.os) === "mac"} />
          ) : (
            <GroupedList>
              <GroupedRow icon="key" label={t("devices.wifiPair.useCode")} chevron onPress={() => setByCode(true)} />
            </GroupedList>
          )}
          <GroupedFooter>{t("mobile.devices.android.wifiNote")}</GroupedFooter>
        </View>
      ) : null}
      {host ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon={wifi ? "join" : "wifi"}
              label={wifi ? t("mobile.devices.android.cable") : t("mobile.devices.android.wifi")}
              {...(wifi ? {} : { sub: t("mobile.devices.android.wifiText") })}
              chevron
              onPress={() => setWifi((w) => !w)}
            />
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

/** The phone makers' USB drivers for Windows, opened on their official pages. */
function DriverLinks() {
  const { t } = useTranslation();
  return (
    <View style={styles.links}>
      <OpenPage href={ANDROID_USB_DRIVERS.google} label={t("devices.android.drivers.google")} />
      <OpenPage href={ANDROID_USB_DRIVERS.samsung} label={t("devices.android.drivers.samsung")} />
      <OpenPage href={ANDROID_USB_DRIVERS.others} label={t("devices.android.drivers.others")} />
    </View>
  );
}

/** Why a plugged phone may not show up, under the cable step after 30 s: the driver only on a Windows computer. */
function NotShowing({ os, onUsbDebugging }: { os: string; onUsbDebugging: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.help} accessibilityRole="summary">
      <Text variant="small" tone="ink" style={styles.helpTitle}>
        {t("devices.android.slow")}
      </Text>
      {androidNotShowing(os).map((item) => (
        <View key={item} style={styles.helpItem}>
          <StepText>{`•  ${t(`devices.android.help.${item}`)}`}</StepText>
          {item === "usbDebugging" ? (
            <Text variant="small" tone="ink" style={styles.helpTitle} onPress={onUsbDebugging} accessibilityRole="link">
              {t("devices.android.help.seeStep")}
            </Text>
          ) : null}
          {item === "driver" ? <DriverLinks /> : null}
        </View>
      ))}
    </View>
  );
}

/**
 * The six-digit way, typed on this phone: the address and the code Pair device with pairing code shows, sent to the
 * computer, which pairs and connects; the line under them follows it, and a failure leaves both to fix and send again.
 */
function PairByCode({
  pairing,
  hostName,
  mac,
}: {
  pairing: ReturnType<typeof useWifiPairCode>;
  hostName: string;
  mac: boolean;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const p = pairing.pairing;
  const busy = pairing.pending || wifiPairLive(p);
  const failed = Boolean(pairing.error) || p?.state === "failed";
  const ready = /^\S+:\d{1,5}$/.test(address.trim()) && /^\d{6}$/.test(code);
  const line = pairing.error ? errorText(t, pairing.error) : p ? wifiPairText(t, p, hostName, mac) : null;
  const send = () => {
    if (ready && !busy) pairing.pair({ address: address.trim(), code });
  };
  return (
    <View style={styles.code}>
      <Locked when={busy} style={styles.code}>
        <View>
          <GroupedHeader>{t("mobile.devices.android.codeHead")}</GroupedHeader>
          <GroupedList>
            <GroupedField label={t("devices.wifiPair.address")}>
              <TextInput
                value={address}
                onChangeText={setAddress}
                placeholder={t("devices.wifiPair.addressExample")}
                placeholderTextColor={c.faint}
                keyboardType="numbers-and-punctuation"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                maxLength={80}
                accessibilityLabel={t("devices.wifiPair.address")}
                style={[fieldText("callout"), styles.input, { color: c.ink }]}
              />
            </GroupedField>
          </GroupedList>
        </View>
        <View>
          <GroupedHeader>{t("devices.wifiPair.pairingCode")}</GroupedHeader>
          <CodeInput
            length={6}
            value={code}
            onChange={setCode}
            label={t("devices.wifiPair.pairingCode")}
            error={failed}
            onSubmit={send}
          />
          <GroupedFooter>{t("mobile.devices.android.codeNote")}</GroupedFooter>
        </View>
      </Locked>
      {line ? (
        <Note icon={failed ? "x" : <InkOrbit size={15} />} live>
          {line}
        </Note>
      ) : null}
      <Button
        variant="primary"
        wide
        label={t("devices.wifiPair.pair")}
        disabled={!ready || busy}
        loading={busy}
        onPress={send}
      />
    </View>
  );
}

/** Android's "Allow USB debugging?" as the phone draws it (Material 3), with its words in the app's language. */
function AdbPrompt() {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  // The system's own colors, not the app's: it is a drawing of Android's dialog.
  const k = scheme === "dark" ? ANDROID_DARK : ANDROID_LIGHT;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={t("mobile.devices.android.prompt.a11y")}
      style={[styles.dialog, { backgroundColor: k.surface }]}
    >
      <Text variant="callout" style={{ color: k.ink }}>
        {t("mobile.devices.android.prompt.title")}
      </Text>
      <Text variant="footnote" style={{ color: k.muted }}>
        {`${t("mobile.devices.android.prompt.fingerprint")}\n${FINGERPRINT}`}
      </Text>
      <View style={[styles.check, { borderColor: k.accent, backgroundColor: k.tint }]}>
        <View style={[styles.box, { backgroundColor: k.accent }]}>
          <Icon name="check" size={12} color={k.surface} />
        </View>
        <Text variant="footnote" style={[styles.grow, { color: k.ink }]}>
          {t("mobile.devices.android.prompt.always")}
        </Text>
      </View>
      <View style={styles.actions}>
        <Text variant="footnote" style={[styles.action, { color: k.accent }]}>
          {t("mobile.devices.android.prompt.cancel")}
        </Text>
        <Text variant="footnote" style={[styles.action, { color: k.accent }]}>
          {t("mobile.devices.android.prompt.allow")}
        </Text>
      </View>
    </View>
  );
}

/** A sample key's fingerprint: the drawing shows where it goes, the phone shows the real one. */
const FINGERPRINT = "5A:3F:C2:8E:41:D7:09:B6:2C:E5:73:1A:F8:64:9D:0B";
const ANDROID_LIGHT = {
  surface: "#ece6f0",
  ink: "#1d1b20",
  muted: "#49454f",
  accent: "#0b57d0",
  tint: "rgba(11,87,208,0.08)",
};
const ANDROID_DARK = {
  surface: "#2b2930",
  ink: "#e6e0e9",
  muted: "#cac4d0",
  accent: "#a8c7fa",
  tint: "rgba(168,199,250,0.12)",
};

/** The phone is ready: its portrait, "Pixel 8 is connected", its name and who can use it, and Done. */
function AndroidDone({ phone: p, hostName }: { phone: PhoneDevice; hostName: string }) {
  const { t } = useTranslation();
  const audienceText = useAudienceText();
  return (
    <SettingsPage
      title={t("mobile.devices.android.title")}
      bottom={<Button variant="primary" wide label={t("mobile.common.done")} onPress={goBack} />}
    >
      <Gap />
      <ConnectedHero
        portrait={<DevicePortrait phone={p} size={96} />}
        title={t("mobile.devices.android.done", { name: p.name })}
        line={phoneFacts(t, p, hostName)}
      />
      <Gap />
      <GroupedList>
        <PhoneNameField key={p.name} phone={p} />
        <GroupedRow
          label={t("mobile.devices.audience.label")}
          value={audienceText(p.audience, p.ownerUserId, hostName)}
          chevron
          onPress={() => router.push({ pathname: "/settings/devices/audience", params: { id: p.id } })}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.devices.page.shareNote", { host: hostName })}</GroupedFooter>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  block: { paddingHorizontal: 4, paddingTop: 16, gap: 12, alignItems: "flex-start" },
  links: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  help: { marginTop: 8, gap: 6 },
  helpTitle: { fontWeight: "600" },
  helpItem: { gap: 4 },
  steps: { paddingTop: 12 },
  code: { gap: 16 },
  input: { flex: 1, minWidth: 0, paddingVertical: 12, paddingHorizontal: 0 },
  dialog: { marginTop: 8, borderRadius: 20, paddingTop: 16, paddingHorizontal: 16, paddingBottom: 8, gap: 4 },
  check: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 8,
    marginHorizontal: -8,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 2,
  },
  box: { width: 16, height: 16, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 4, marginTop: 4 },
  action: { fontWeight: "500", paddingVertical: 8, paddingHorizontal: 12 },
  grow: { flex: 1, minWidth: 0 },
});
