import { outageKey } from "@agenteschat/client/lib/outages";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { readValueSync, STORED, writeValue } from "@/lib/storage";
import { Button, IconButton, LineIcon, Text, textLineOf } from "@/ui";
import { router } from "@/ui/navigation";
import { useFontScale } from "@/ui/text-scale";
import { useColors, useEdition } from "../shared/hooks";
import { useSurface } from "../shared/parts";
import { computerIcon, dismissedOutages, type MachineOutage, noticeText } from "./logic";
import { useMachineOutages } from "./queries";

/** Opens "Trocar o computador" for an offline computer (a native form sheet). */
export const openSwitchComputer = (machineId: string) => router.push(`/switch-computer/${machineId}`);

/**
 * Under the greeting on Conversas, as on the web: one neutral card per computer
 * that went offline with agents waiting for it, the attention color only on its icon. "O MacBook Air
 * desconectou", "Ada e Theo esperam por ele · 3 tarefas", "Trocar computador", and a close button (closed, it
 * stays closed until that computer comes back: a new outage shows again). The app has no computer
 * screen yet, so the web's "Ver computador" is left out. Shows only for who can manage the agents
 * (the endpoint refuses the others); nothing while none is offline.
 */
export function OutageNotices() {
  const { outages, data } = useMachineOutages();
  const { dismissed, dismiss } = useDismissedOutages(outages, Boolean(data));
  const shown = outages.filter((o) => !dismissed.includes(outageKey(o)));
  if (shown.length === 0) return null;
  return (
    <View style={styles.list}>
      {shown.map((o) => (
        <OutageNotice key={o.machineId} outage={o} onDismiss={() => dismiss(o)} />
      ))}
    </View>
  );
}

/** The notices the person closed (kept on the phone), forgetting those whose computer came back. */
function useDismissedOutages(outages: readonly MachineOutage[], loaded: boolean) {
  const [dismissed, setDismissed] = useState<string[]>(() => dismissedOutages(readValueSync(STORED.outagesDismissed)));
  const live = outages.map(outageKey).join(",");
  useEffect(() => {
    if (!loaded) return;
    const keys = new Set(live ? live.split(",") : []);
    setDismissed((d) => {
      const kept = d.filter((k) => keys.has(k));
      if (kept.length === d.length) return d;
      void writeValue(STORED.outagesDismissed, JSON.stringify(kept));
      return kept;
    });
  }, [loaded, live]);
  const dismiss = useCallback((o: MachineOutage) => {
    setDismissed((d) => {
      const next = [...d, outageKey(o)];
      void writeValue(STORED.outagesDismissed, JSON.stringify(next));
      return next;
    });
  }, []);
  return { dismissed, dismiss };
}

function OutageNotice({ outage: o, onDismiss }: { outage: MachineOutage; onDismiss: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  // The Cloud has no other computer to switch to, and nothing is offered while the edition isn't known.
  const edition = useEdition();
  const cloud = edition === "cloud";
  const text = noticeText(t, o, cloud);
  // The close's middle where the eye reads the title's first line, as the icon across from it.
  const fontScale = useFontScale();
  const closeTop = textLineOf("callout", fontScale).middle - CLOSE / 2;
  return (
    <View style={[styles.card, surface]}>
      <View style={styles.top}>
        <View
          style={styles.line}
          accessible
          accessibilityRole="summary"
          accessibilityLabel={`${text.a11y}. ${text.title}. ${text.sub}`}
        >
          <LineIcon name={computerIcon(o.platform)} variant="callout" size={16} color={c.amber} />
          <View style={styles.tx}>
            <Text variant="callout" tone="ink" style={styles.bold} numberOfLines={2}>
              {text.title}
            </Text>
            <Text variant="small" tone="muted" numberOfLines={2}>
              {text.sub}
            </Text>
          </View>
        </View>
        <View style={[styles.close, { marginTop: closeTop }]}>
          <IconButton icon="x" label={t("mobile.outage.dismiss")} onPress={onDismiss} />
        </View>
      </View>
      {edition === "selfhost" && (
        <Button
          variant="primary"
          size="sm"
          wide
          label={t("mobile.outage.switch")}
          onPress={() => openSwitchComputer(o.machineId)}
        />
      )}
    </View>
  );
}

/** `IconButton`'s box. */
const CLOSE = 40;

const styles = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8, gap: 10 },
  card: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  top: { flexDirection: "row", alignItems: "flex-start", gap: 4 },
  line: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "flex-start", gap: 10 },
  tx: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  // The × stands as far from the card's edge as the icon across from it, and the button doesn't grow the card.
  close: { marginBottom: -8, marginRight: -12 },
});
