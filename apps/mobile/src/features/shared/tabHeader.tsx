import { useMe } from "@agenteschat/client";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { type HeaderAction, haptics, PersonAvatar } from "@/ui";
import { router } from "@/ui/navigation";
import { useColors, useDirectory, useMeId } from "./hooks";
import { OrgAvatar } from "./OrgAvatar";
import { usePersonPhoto } from "./photo";

/** The workspace's logo in the bar, and your photo on its corner. */
const ORG = 34;
const ME = 18;
/** The ring around your photo, in the page's color, lifting it off the logo. */
const RING = 2;

/**
 * Your name and photo as the directory has them (as Você shows them): `me` comes from the session, which the server
 * caches for minutes, so a new photo only reached the bar later. A personal workspace's mark (ADR 0159).
 */
export function useMyFace(): { name: string; photo: ReturnType<typeof usePersonPhoto> } {
  const me = useMe();
  const meId = useMeId();
  const dir = useDirectory();
  const mine = meId ? dir.memberById.get(meId) : undefined;
  const photo = usePersonPhoto(mine?.avatarUrl ?? mine?.image ?? me.data?.user.image);
  return { name: me.data?.user.name ?? "", photo };
}

/**
 * The bar of the three tabs: on the left the workspace you are in (its logo, your photo small on its corner)
 * opens Você; "+" on the right pushes "New" (start a conversation or create something), in the native bar. A personal
 * workspace (ADR 0159) is yours: your photo alone, at the logo's size, and the label names only Você.
 */
export function useTabHeader(): { left: ReactNode; actions: HeaderAction[] } {
  const { t } = useTranslation();
  const { org } = useOrg();
  const personal = isPersonal(org);
  const c = useColors();
  const face = useMyFace();
  const actions: HeaderAction[] = [
    { icon: "plus", sf: "plus", label: t("mobile.new.title"), onPress: () => router.push("/new") },
  ];
  return {
    left: (
      <Pressable
        onPress={() => router.push("/me")}
        // Holding the mark opens the workspaces as a sheet (ADR 0154): one light tap as it commits, the sheet is the
        // system's form sheet. A tap still opens Você.
        onLongPress={() => {
          haptics.light();
          router.push("/workspaces-sheet");
        }}
        delayLongPress={350}
        accessibilityRole="button"
        accessibilityLabel={org?.name && !personal ? `${t("mobile.me.title")}, ${org.name}` : t("mobile.me.title")}
        accessibilityHint={t("mobile.me.workspacesHoldHint")}
        hitSlop={6}
        style={({ pressed }) => [personal ? styles.solo : styles.box, pressed ? styles.pressed : null]}
      >
        {personal ? (
          <PersonAvatar name={face.name || "?"} size={ORG} photo={face.photo} />
        ) : (
          <>
            <OrgAvatar logo={org?.logo} size={ORG} />
            <View style={[styles.me, { borderColor: c.bg, backgroundColor: c.bg }]}>
              <PersonAvatar name={face.name || "?"} size={ME} photo={face.photo} />
            </View>
          </>
        )}
      </Pressable>
    ),
    actions,
  };
}

const styles = StyleSheet.create({
  // Room for the photo on the logo's corner.
  box: { width: ORG + 6, height: ORG + 6 },
  // A personal workspace: your photo alone.
  solo: { width: ORG, height: ORG },
  pressed: { opacity: 0.6 },
  me: { position: "absolute", right: 0, bottom: 0, borderRadius: (ME + RING * 2) / 2, borderWidth: RING },
});
