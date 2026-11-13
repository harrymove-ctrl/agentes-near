import type { ArtifactRef } from "@agenteschat/client";
import { fileIcon, fitsUpload, formatBytes, MAX_UPLOAD_MB, previewKind } from "@agenteschat/client/lib/files";
import { ComposerFile, type IconName } from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { objectUrls } from "@/components/artifacts/FileView";
import { useUploadFailed } from "@/components/Limits";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

const MAX_ATTACHMENTS = 10;

/** A file picked for the next comment: uploading, uploaded (with its Drive ref) or failed. */
export interface PendingFile {
  key: string;
  name: string;
  icon: IconName;
  size: number;
  /** An image's local thumbnail (an object URL, revoked when the file leaves the box). */
  preview?: string;
  status: "uploading" | "done" | "failed";
  ref?: ArtifactRef;
}

/**
 * Files for a composer that isn't the chat (an issue comment): each one goes
 * to the Drive right away (in `channelId`, or the org's Drive), sending waits
 * for them. Gives the composer its `attachments` and `onFiles`.
 */
export function useComposerFiles(channelId: string | null, focus?: () => void) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const failed = useUploadFailed();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const previews = useRef(new Set<string>());
  const drop = (keep: (f: PendingFile) => boolean) => {
    for (const f of files) {
      if (keep(f) || !f.preview) continue;
      objectUrls.revoke(f.preview);
      previews.current.delete(f.preview);
    }
    setFiles((prev) => prev.filter(keep));
  };
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) objectUrls.revoke(url);
      urls.clear();
    };
  }, []);
  const add = (list: File[]) => {
    const room = MAX_ATTACHMENTS - files.length;
    if (list.length > room) toast.show(t("channel.tooManyFiles", { max: MAX_ATTACHMENTS }), "error");
    for (const file of list.slice(0, Math.max(0, room))) {
      if (!fitsUpload(file)) {
        toast.show(t("files.tooLarge", { name: file.name, max: MAX_UPLOAD_MB }), "error");
        continue;
      }
      const key = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const update = (patch: Partial<PendingFile>) =>
        setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));
      const preview = previewKind(file.type) === "image" ? (objectUrls.create(file) ?? undefined) : undefined;
      if (preview) previews.current.add(preview);
      setFiles((prev) => [
        ...prev,
        { key, name: file.name, icon: fileIcon(file.name, file.type), size: file.size, preview, status: "uploading" },
      ]);
      api.artifacts
        .upload(org.id, file, channelId ? { channelId } : {})
        .then((saved) => update({ status: "done", ref: { id: saved.id, version: saved.version, title: saved.title } }))
        .catch((error) => {
          update({ status: "failed" });
          failed(error);
        });
    }
    focus?.();
  };
  const attached = files.flatMap((f) => (f.status === "done" && f.ref ? [f.ref] : []));
  return {
    attached,
    /** The files as they are now, for a box that draws them its own way (the new-issue form's grid). */
    items: files,
    remove: (key: string) => drop((x) => x.key !== key),
    uploading: files.some((f) => f.status === "uploading"),
    onFiles: add,
    clear: () => drop(() => false),
    attachments:
      files.length > 0
        ? files.map((f) => (
            <ComposerFile
              key={f.key}
              name={f.name}
              icon={f.icon}
              preview={f.preview}
              detail={formatBytes(i18n.language, f.size)}
              status={f.status}
              statusLabel={
                f.status === "uploading"
                  ? t("channel.uploading")
                  : f.status === "failed"
                    ? t("channel.uploadFailed")
                    : undefined
              }
              removeLabel={t("channel.removeFile", { name: f.name })}
              onRemove={() => drop((x) => x.key !== f.key)}
            />
          ))
        : undefined,
  };
}
