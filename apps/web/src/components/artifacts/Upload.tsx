import type { ArtifactDetail } from "@agenteschat/client";
import { useUploadFile } from "@agenteschat/client";
import { fitsUpload, MAX_UPLOAD_MB } from "@agenteschat/client/lib/files";
import { Button, type ButtonProps } from "@agenteschat/ui";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUploadFailed } from "@/components/Limits";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/** One file of an upload batch, for the progress toast. */
export interface UploadItem {
  name: string;
  status: "waiting" | "sending" | "done" | "failed";
}

/**
 * Sends files to the Drive one at a time: the 50 MB limit is checked here
 * first (a translated message, nothing sent), then the server checks again.
 * `artifactId`: a new version of that file instead of a new file. `queue`:
 * the batch being sent, file by file (empty once it's over).
 */
export function useDriveUpload(onUploaded?: (saved: ArtifactDetail, file: File) => void) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const failed = useUploadFailed();
  const mutation = useUploadFile(org.id);
  const [current, setCurrent] = useState<string | null>(null);
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const mark = (i: number, status: UploadItem["status"]) =>
    setQueue((q) => q.map((item, j) => (j === i ? { ...item, status } : item)));
  const upload = async (files: File[], target?: { artifactId: string }) => {
    setQueue(files.map((f) => ({ name: f.name, status: "waiting" })));
    for (const [i, file] of files.entries()) {
      if (!fitsUpload(file)) {
        toast.show(t("files.tooLarge", { name: file.name, max: MAX_UPLOAD_MB }), "error");
        mark(i, "failed");
        continue;
      }
      setCurrent(file.name);
      mark(i, "sending");
      try {
        const saved = await mutation.mutateAsync(target ? { file, artifactId: target.artifactId } : { file });
        mark(i, "done");
        onUploaded?.(saved, file);
      } catch (error) {
        mark(i, "failed");
        failed(error);
      }
    }
    setCurrent(null);
    setQueue([]);
  };
  return { upload, busy: current !== null, current, queue };
}

/** A button that opens the file picker (the input itself stays hidden). */
export function UploadButton({
  label,
  onFiles,
  busy,
  multiple,
  size = "sm",
  variant,
  className,
  labelClassName,
}: {
  label: string;
  onFiles: (files: File[]) => void;
  busy?: boolean;
  multiple?: boolean;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  className?: string;
  /** The words in a span of this class (a bar that shows only the icon on a phone), the button titled with them. */
  labelClassName?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        size={size}
        variant={variant}
        icon="upload"
        className={className}
        loading={busy}
        disabled={busy}
        onClick={() => input.current?.click()}
        {...(labelClassName ? { title: label } : {})}
      >
        {labelClassName ? <span className={labelClassName}>{label}</span> : label}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        tabIndex={-1}
        multiple={multiple}
        aria-label={label}
        data-upload-input=""
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}
