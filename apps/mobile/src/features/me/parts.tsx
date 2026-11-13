import { keys, useApi } from "@agenteschat/client";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ActionSheetIOS, Alert, Platform, ScrollView, StyleSheet, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { LayoutAnimationConfig } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { Locked, useToast } from "@/ui";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { type HeaderWordAction, PushedHeader } from "../shared/parts";
import { type AccountDraft, PHOTO_MAX_BASE64, photoContentType } from "./logic";

/**
 * One screen of Você's (Conta, Membros, Notificações…), pushed with the platform's push: the native bar (its back
 * button and edge swipe, the title, a word that saves on the right) over the grouped gray, which scrolls under it.
 * `footer`: a button that stays at the bottom, over the keyboard, with the page scrolling above it.
 */
export function Page({
  title,
  action,
  footer,
  locked = false,
  children,
}: {
  title: string;
  action?: HeaderWordAction;
  footer?: ReactNode;
  /** The page's form is sending: its controls are off, the page still scrolls. */
  locked?: boolean;
  children?: ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const scroll = (
    <ScrollView
      style={styles.fill}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets={!footer}
      contentContainerStyle={[styles.body, { paddingBottom: footer ? 24 : 24 + insets.bottom }]}
    >
      {/* What is there as the screen opens doesn't fade in; what loads while it is watched does (`Loaded`). */}
      <Locked when={locked}>
        <LayoutAnimationConfig skipEntering>{children}</LayoutAnimationConfig>
      </Locked>
    </ScrollView>
  );
  return (
    <View style={[styles.fill, { backgroundColor: c.grouped }]}>
      <PushedHeader title={title} solid={false} grouped {...(action ? { action } : {})} />
      {footer ? (
        <KeyboardAvoidingView behavior="padding" style={styles.fill}>
          {scroll}
          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>{footer}</View>
        </KeyboardAvoidingView>
      ) : (
        scroll
      )}
    </View>
  );
}

/**
 * Conta's form while it is open, shared with Fuso (a screen pushed over it): Conta starts it from the profile and
 * drops it when it closes; Fuso writes the zone picked and goes back.
 */
let accountDraft: AccountDraft | null = null;
const draftListeners = new Set<() => void>();

export function setAccountDraft(next: AccountDraft | null) {
  accountDraft = next;
  for (const listener of draftListeners) listener();
}

export function useAccountDraft(): AccountDraft | null {
  return useSyncExternalStore(
    (listener) => {
      draftListeners.add(listener);
      return () => {
        draftListeners.delete(listener);
      };
    },
    () => accountDraft,
  );
}

/** What a change to my profile here touches: the account, and this workspace's members and people. */
export function refreshProfile(qc: QueryClient, orgId: string) {
  void qc.invalidateQueries({ queryKey: keys.me });
  void qc.invalidateQueries({ queryKey: keys.members(orgId) });
  void qc.invalidateQueries({ queryKey: keys.people(orgId) });
}

/**
 * "Alterar foto": the system's sheet (the gallery, the camera, Remover foto when there is one), then the upload, which
 * saves on its own. Conta's link and Você's photo open it.
 */
export function useChangePhoto() {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const org = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const [uploading, setUploading] = useState(false);

  const upload = async (from: "library" | "camera") => {
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
      base64: true,
    };
    if (from === "camera") {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        toast({ title: t("mobile.me.account.noCamera"), icon: "camera" });
        return;
      }
    }
    const res =
      from === "camera"
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
    const a = res.canceled ? null : res.assets[0];
    if (!a?.base64) return;
    if (a.base64.length > PHOTO_MAX_BASE64) {
      toast({ title: t("mobile.me.account.photoTooBig"), icon: "x" });
      return;
    }
    setUploading(true);
    try {
      await api.orgs.setAvatar(org.orgId, {
        imageBase64: a.base64,
        contentType: photoContentType(a.mimeType, a.fileName, a.base64),
      });
      refreshProfile(qc, org.orgId);
      toast({ title: t("mobile.me.account.photoSaved") });
    } catch {
      toast({ title: t("mobile.me.account.photoFailed"), icon: "x" });
    } finally {
      setUploading(false);
    }
  };

  const remove = async () => {
    try {
      await api.orgs.removeAvatar(org.orgId);
      refreshProfile(qc, org.orgId);
      toast({ title: t("mobile.me.account.photoRemoved") });
    } catch {
      toast({ title: t("mobile.app.failed"), icon: "x" });
    }
  };

  const changePhoto = () => {
    const hasPhoto = Boolean(meId && dir.memberById.get(meId)?.avatarUrl);
    const labels = [
      t("mobile.me.account.fromLibrary"),
      t("mobile.me.account.fromCamera"),
      ...(hasPhoto ? [t("mobile.me.account.removePhoto")] : []),
    ];
    const run = (i: number) => {
      if (i === 0) void upload("library");
      else if (i === 1) void upload("camera");
      else if (i === 2 && hasPhoto) void remove();
    };
    if (Platform.OS === "ios")
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...labels, t("mobile.common.cancel")],
          cancelButtonIndex: labels.length,
          ...(hasPhoto ? { destructiveButtonIndex: 2 } : {}),
        },
        run,
      );
    else
      Alert.alert(t("mobile.me.account.changePhoto"), undefined, [
        ...labels.map((text, i) => ({ text, onPress: () => run(i) })),
        { text: t("mobile.common.cancel"), style: "cancel" as const },
      ]);
  };

  return { changePhoto, uploading };
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { paddingHorizontal: 16, paddingTop: 4 },
  footer: { paddingHorizontal: 16, paddingTop: 12 },
});
