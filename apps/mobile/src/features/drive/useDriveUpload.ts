import { useApi } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import * as DocumentPicker from "expo-document-picker";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/ui";
import { useOrgId } from "../shared/hooks";

/** "Enviar arquivo" on the Drive: the system's file picker, then the file into the Drive, with no conversation. */
export function useDriveUpload(onSaved: () => unknown) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pick = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    const a = res.canceled ? null : res.assets[0];
    if (!a) return;
    setBusy(true);
    try {
      // React Native's FormData sends `{ uri, name, type }` as a file part.
      const file = { uri: a.uri, name: a.name, type: a.mimeType ?? "application/octet-stream" };
      const saved = await api.artifacts.upload(orgId, file as unknown as Parameters<typeof api.artifacts.upload>[1]);
      toast({ title: t("files.uploaded", { name: saved.title }), icon: "check" });
      await onSaved();
    } catch (e) {
      toast({ title: errorText(t, e), icon: "x" });
    } finally {
      setBusy(false);
    }
  };
  return { busy, pick: () => void pick() };
}
