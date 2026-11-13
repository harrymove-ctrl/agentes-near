import { type LinkPill, linkPillLabel, linkPillText } from "@agenteschat/client/lib/link-pills";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet } from "react-native";
import { serverUrl } from "@/lib/server";
import { Icon, type IconName } from "@/ui";
import { openPage } from "../ai/parts";
import { brandOf, iconUri } from "../connectors/logic";
import { useColors } from "../shared/hooks";

const KIND_ICON: Record<NonNullable<LinkPill["kind"]>, IconName> = {
  pull: "gitPull",
  merge: "gitPull",
  issue: "issue",
};

/**
 * A bare address of a known service (the web's `LinkPill`): the service's logo and a few words on a #channel's plate;
 * a tap opens the page, as any link. The message sheet's "Copiar texto" copies the message as written, address and all.
 */
export function LinkPillText({ href, pill }: { href: string; pill: LinkPill }) {
  const { t } = useTranslation();
  const c = useColors();
  const uri = iconUri(serverUrl(), pill.iconUrl);
  return (
    <RNText
      accessibilityRole="link"
      accessibilityLabel={linkPillLabel(t, pill)}
      accessibilityHint={href}
      onPress={() => openPage(href)}
      style={[styles.pill, { backgroundColor: c.sunken, color: c.ink }]}
    >
      {uri ? (
        <Image
          source={{ uri }}
          tintColor={brandOf(pill.brandColor) ?? c.ink}
          contentFit="contain"
          style={styles.mark}
        />
      ) : null}{" "}
      {pill.kind ? (
        <>
          {pill.name} <Icon name={KIND_ICON[pill.kind]} size={14} color={c.muted} />
          {pill.ref}
        </>
      ) : (
        linkPillText(t, pill)
      )}
    </RNText>
  );
}

const styles = StyleSheet.create({
  pill: { fontWeight: "600", borderRadius: 4 },
  mark: { width: 14, height: 14 },
});
