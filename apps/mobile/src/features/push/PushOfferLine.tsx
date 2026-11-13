import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { pushPermission } from "@/lib/push";
import { usePush } from "@/providers/push";
import { ACT_LINE, Button, LineIcon, Text, useToast } from "@/ui";
import { useColors } from "../shared/hooks";

/**
 * The moment to ask for notifications: right after an agent said it will take a while, in its conversation, as
 * one event line ("Quer saber quando a Dora terminar?") with one button, "Avisar", which opens the system's prompt
 * at once. Replaces the sheet that opened by itself over the first home: the question comes where it makes sense,
 * once. Whoever says no sees it again only in Você › Notificações. `agent`: the agent's name; `onDone`: the line
 * can go (asked, or dismissed by the system's answer).
 */
export function PushOfferLine({ agent, onDone }: { agent: string; onDone?: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const { ask, markOffered } = usePush();
  const [asking, setAsking] = useState(false);

  const turnOn = async () => {
    if (asking) return;
    setAsking(true);
    markOffered();
    const ok = await ask().catch(() => false);
    // Allowed but not registered (the server didn't take this phone): say so; a "no" to the system says nothing.
    const allowed = ok || (await pushPermission()) === "granted";
    setAsking(false);
    onDone?.();
    if (ok) toast({ title: t("mobile.push.ask.done"), icon: "bell" });
    else if (allowed) toast({ title: t("mobile.push.ask.failed"), icon: "x" });
  };

  return (
    <View style={styles.line} accessibilityLiveRegion="polite">
      <LineIcon name="bell" size={16} color={c.ink2} variant="subhead" />
      {/* Ativar under the words, from their edge, once they take more than their line. */}
      <View style={[ACT_LINE.row, styles.text]}>
        <Text variant="subhead" tone="ink2" style={ACT_LINE.text}>
          {t("mobile.push.offer.line", { name: agent })}
        </Text>
        <Button variant="primary" size="sm" label={t("mobile.push.offer.action")} loading={asking} onPress={turnOn} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The event line's column: text starts at 62, like a message's.
  line: { flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 62, paddingRight: 16, paddingTop: 12 },
  text: { flex: 1, minWidth: 0, alignItems: "center", columnGap: 16, rowGap: 8 },
});
