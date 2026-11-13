import { useAiStatus } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { mayConnectAi, noAiStatusKey } from "@agenteschat/client/lib/no-ai";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import { Button, Icon, InfoHint, LineIcon, Text, useReducedMotion } from "@/ui";
import { BUTTON_SIZES } from "@/ui/Button";
import { openConnectAi } from "../ai/NoAiCard";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import type { NoAiBannerView } from "./no-ai-banner";

/**
 * Above the box, as on the web (ADR 0061): an agent's DM whose agent has no AI says so, and a conversation
 * with agents in a workspace with no AI at all says the agents don't have one yet, each with Conectar
 * (./no-ai-banner.ts decides which, and when the agent's no-AI card right above says it already).
 */
export function NoAiBanner({ banner }: { banner: NoAiBannerView }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const reduced = useReducedMotion();
  const { orgId, org } = useOrg();
  const status = useAiStatus(orgId);
  const meId = useMeId();
  const agent = banner.kind === "agent" ? dir.agentById.get(banner.agentId) : undefined;
  const name = banner.kind === "agent" ? (agent?.name ?? t("channel.unknownAgent")) : "";
  const action = banner.kind === "agent" ? t("noAi.action") : t("noAi.banner.orgAction");
  const connect = () => openConnectAi(banner.agentId ? { agentId: banner.agentId } : {});
  const acts = banner.kind === "org" || mayConnectAi(agent, meId, org);
  return (
    <Animated.View
      entering={reduced ? undefined : FadeInDown.duration(220)}
      exiting={reduced ? undefined : FadeOut.duration(160)}
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: c.sunken }]}
    >
      {/* The sentence wraps: the icon stays on its first line, which shares the button's middle (centred on the
          whole banner they floated between lines). */}
      {acts ? (
        <View style={styles.atButton}>
          <Icon name="bolt" size={15} color={c.ink2} />
        </View>
      ) : (
        <LineIcon variant="small" name="bolt" size={15} color={c.ink2} />
      )}
      <View style={[styles.text, acts ? styles.textAtButton : null]}>
        {banner.kind === "agent" ? (
          <Text variant="small" tone="ink2" style={styles.strong}>
            {t(noAiStatusKey(status.data, banner.agentId), agentGrammar(name))}
          </Text>
        ) : banner.askInChat ? (
          <InfoHint name={t("common.about", { label: action })} text={t("noAi.banner.orgHint")} variant="small">
            <Text variant="small" tone="ink2" style={styles.strong}>
              {t("noAi.banner.org")}
            </Text>
          </InfoHint>
        ) : (
          <Text variant="small" tone="ink2" style={styles.strong}>
            {t("noAi.banner.org")}
          </Text>
        )}
      </View>
      {acts ? <Button variant="secondary" size="sm" label={action} onPress={connect} /> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // The connection line's shape ("tato com canto"), in the quiet fill.
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginHorizontal: 4,
    marginBottom: 6,
    paddingVertical: 6,
    paddingLeft: 10,
    paddingRight: 6,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
    borderBottomLeftRadius: 3,
  },
  text: { flex: 1, minWidth: 0 },
  // The small button's height: the first line (20) and the icon sit on its middle.
  atButton: { height: BUTTON_SIZES.sm.height, justifyContent: "center" },
  textAtButton: { paddingTop: (BUTTON_SIZES.sm.height - 20) / 2 },
  strong: { fontWeight: "600" },
});
