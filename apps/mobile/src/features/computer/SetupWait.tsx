import { useComputerSetup, useMachines, useMe } from "@agenteschat/client";
import {
  etaLine,
  promisesEmail,
  SETUP_STEPS,
  type SetupView,
  setupEta,
  setupNoticeTitleKey,
  setupPending,
  setupPortrait,
  setupView,
  statusRestatesChip,
  useEtaNow,
  WORKSPACE_COMPUTER_KIND,
} from "@agenteschat/client/lib/computer";
import { modeKey, workspaceModeOf } from "@agenteschat/client/lib/workspace-mode";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { ComputerIcon, ComputerPortrait } from "@/computer/ComputerPortrait";
import { useOrg, useOrgMaybe } from "@/providers/org";
import { Button, type IconName, InfoHint, LineIcon, SheetScreen, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { useColors, useOrgId } from "../shared/hooks";
import { useSurface } from "../shared/parts";
import { setupNoticeLine } from "./logic";

/** This workspace's computer on its way, or null where people connect their own (`pair`). */
export function useSetupView(): SetupView | null {
  const q = useComputerSetup(useOrgId());
  return setupView(q.data, q.dataUpdatedAt);
}

/**
 * The workspace a wait is read about: `orgId` (the first run's, made before one is chosen in the app), else the
 * one chosen. `name` stands in until `me` lists it.
 */
export interface WaitWorkspace {
  orgId: string;
  name: string;
}

/**
 * The time left now, on the clock every time line shares (`useEtaNow`), and whether "we'll email you" holds for
 * this person: only owners get the email. A workspace on hold shows neither: its provisioner waits too. `now`:
 * that clock's time, while it waits. `org`: the workspace's name; `mode`: its mode, whose words name the computer
 * (a personal one's is its person's agents', ADR 0159).
 */
export function useSetupWait(view: SetupView | null, workspace?: WaitWorkspace) {
  const chosen = useOrgMaybe();
  const me = useMe().data;
  const orgId = workspace?.orgId ?? chosen?.orgId;
  const org = me?.organizations.find((o) => o.id === orgId) ?? (orgId === chosen?.orgId ? chosen?.org : null);
  const live = view && setupPending(view) && org?.standing?.state !== "hold" ? view : null;
  const now = useEtaNow(live !== null);
  return {
    now: live ? now : null,
    /** Lines about the wait show (not ready, not on hold). */
    live: live !== null,
    eta: live ? setupEta(live, now) : null,
    emailed: live !== null && org?.role === "owner" && promisesEmail(live, now),
    email: me?.user.email ?? "",
    org: org?.name ?? workspace?.name ?? "",
    mode: workspaceModeOf(org),
  };
}

/** The four steps as bars: the ones done full, the current one half. */
function Steps({ n, total }: { n: number; total: number }) {
  const c = useColors();
  return (
    <View style={styles.steps} importantForAccessibility="no-hide-descendants">
      {Array.from({ length: total }, (_, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed bars, never reordered
          key={i}
          style={[styles.bar, { backgroundColor: i < n ? c.ink : c.line, opacity: i === n - 1 ? 0.5 : 1 }]}
        />
      ))}
    </View>
  );
}

function Line({ icon, text }: { icon: IconName; text: string }) {
  const c = useColors();
  return (
    <View style={styles.line}>
      <LineIcon variant="small" name={icon} size={16} color={c.muted} />
      <Text variant="small" tone="muted" style={styles.grow}>
        {text}
      </Text>
    </View>
  );
}

/**
 * The workspace's computer on its way, as the web's preparing screen: the server's portrait, "Computador da Acme"
 * with its ⓘ (one user per agent), the steps ("Passo 3 de 4 · Instalando os programas") or why it waits, the time
 * left, who hears when it's ready (owners, by email) and the size. `said`: the screen's header names the computer
 * and says where it is, so the name and a line that would only say it again stay out.
 */
export function SetupWait({
  view,
  online = false,
  workspace,
  said = false,
}: {
  view: SetupView;
  online?: boolean;
  /** The first run's workspace (no workspace is chosen in the app yet). */
  workspace?: WaitWorkspace;
  said?: boolean;
}) {
  const { t } = useTranslation();
  const wait = useSetupWait(view, workspace);
  const name = t(modeKey(wait, "computerSetup.title"), { org: wait.org });
  return (
    <View style={styles.wait}>
      <View style={styles.head}>
        <ComputerPortrait kind={WORKSPACE_COMPUTER_KIND} state={setupPortrait(view, online)} size={96} />
        {said ? null : (
          <InfoHint name={t("common.about", { label: name })} text={t("computerSetup.users")} variant="title" center>
            <Text variant="title" style={styles.center}>
              {name}
            </Text>
          </InfoHint>
        )}
        {view.step ? (
          <>
            <Steps n={view.stepNumber} total={SETUP_STEPS.length} />
            <Text variant="small" tone="muted" style={styles.center}>
              {t("computerSetup.stepOf", { n: view.stepNumber, total: SETUP_STEPS.length, step: t(view.textKey) })}
            </Text>
          </>
        ) : said && statusRestatesChip(view) ? null : (
          <Text variant="small" tone="muted" style={styles.center}>
            {t(view.textKey)}
          </Text>
        )}
        {wait.eta ? (
          <Text variant="callout" tone="ink" accessibilityLiveRegion="polite" style={[styles.center, styles.bold]}>
            {etaLine(t, wait.eta)}
          </Text>
        ) : null}
      </View>
      {wait.live ? (
        <Line
          icon={wait.emailed ? "mail" : "bell"}
          text={wait.emailed ? t("computerSetup.email.you", { email: wait.email }) : t("computerSetup.email.here")}
        />
      ) : null}
      {view.specs ? <Line icon="server" text={t("computerSetup.specs", view.specs)} /> : null}
    </View>
  );
}

/** The whole wait, opened from the notice: it turns Ready once the computer is, live. */
export function ComputerSetupSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const view = useSetupView();
  const managed = useMachines(orgId).data?.find((m) => m.kind === "managed");
  return (
    <SheetScreen>
      {view ? <SetupWait view={view} online={managed?.online ?? false} /> : null}
      <Button variant="secondary" wide label={t("mobile.common.close")} onPress={onClose} />
    </SheetScreen>
  );
}

/**
 * On Conversas while the workspace's own computer is on its way, in the outage notices' style: "Preparando o
 * computador da Acme" (in line, its name alone) and the time left (or where it is). It opens the whole wait in a
 * sheet. Everyone sees it.
 */
export function SetupNotice() {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const { org } = useOrg();
  const view = useSetupView();
  const wait = useSetupWait(view);
  if (!setupPending(view)) return null;
  const title = t(modeKey(org, setupNoticeTitleKey(view)), { org: org?.name ?? "" });
  const line = setupNoticeLine(t, view, wait.eta, wait.emailed);
  return (
    <View style={styles.list}>
      {/* It opens a screen: the press shows, with no haptic (plain navigation). */}
      <Pressable
        onPress={() => router.push("/computer-setup")}
        accessibilityRole="button"
        accessibilityLabel={line ? `${title}. ${line}` : title}
        style={({ pressed }) => [styles.card, surface, pressed && styles.pressed]}
      >
        <LineIcon variant="callout" size={22}>
          <ComputerIcon kind={WORKSPACE_COMPUTER_KIND} size={22} color={c.muted} />
        </LineIcon>
        <View style={styles.grow}>
          <Text variant="callout" tone="ink" style={styles.bold} numberOfLines={2}>
            {title}
          </Text>
          {line ? (
            <Text variant="small" tone="muted" numberOfLines={2}>
              {line}
            </Text>
          ) : null}
        </View>
        {/* On the title's line, as the icon on the left: in the card's middle it floated between the lines. */}
        <LineIcon variant="callout" name="right" size={16} color={c.faint} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wait: { gap: 12 },
  head: { alignItems: "center", gap: 8, paddingBottom: 4 },
  center: { textAlign: "center" },
  bold: { fontWeight: "600" },
  steps: { flexDirection: "row", gap: 6, alignSelf: "stretch", paddingHorizontal: 24, paddingTop: 4 },
  bar: { flex: 1, height: 4, borderRadius: 999 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  grow: { flex: 1, minWidth: 0 },
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  card: {
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  pressed: { opacity: 0.85 },
});
