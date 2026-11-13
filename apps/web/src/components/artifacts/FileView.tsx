import type { ArtifactFileContent } from "@agenteschat/client";
import { useArtifactBlob } from "@agenteschat/client";
import {
  fileIcon,
  formatBytes,
  isJsonFile,
  MAX_PREVIEW_BYTES,
  previewKind,
  previewType,
} from "@agenteschat/client/lib/files";
import { Icon, Spinner, Tip, VideoPlayer, type VideoPlayerLabels } from "@agenteschat/ui";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { CodeBlock } from "@/components/CodeBlock";
import { useOrg } from "@/components/org-context";
import { ImageZoom } from "./ImageZoom";

/** Object URLs for blobs (swappable: test DOMs may lack `URL.createObjectURL`). */
export const objectUrls = {
  create(blob: Blob): string | null {
    return typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : null;
  },
  revoke(url: string) {
    if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
  },
};

/** "relatorio.pdf · 1,2 MB" with the type's icon. */
export function FileSummary({ content }: { content: ArtifactFileContent }) {
  const { i18n } = useTranslation();
  return (
    <span className="file-summary">
      <span className="file-summary__icon">
        <Icon name={fileIcon(content.name, content.contentType)} />
      </span>
      <span className="file-summary__text">
        <span className="file-summary__name" title={content.name}>
          {content.name}
        </span>
        <span className="small muted tabular">{formatBytes(i18n.language, content.size)}</span>
      </span>
    </span>
  );
}

/** The video player's words in the active language. */
export function useVideoLabels(): VideoPlayerLabels {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      play: t("files.video.play"),
      pause: t("files.video.pause"),
      replay: t("files.video.replay"),
      seek: t("files.video.seek"),
      volume: t("files.video.volume"),
      mute: t("files.video.mute"),
      unmute: t("files.video.unmute"),
      speed: (speed: number) => t("files.video.speed", { speed }),
      fullscreen: t("files.video.fullscreen"),
      exitFullscreen: t("files.video.exitFullscreen"),
      open: t("files.video.open"),
    }),
    [t],
  );
}

/** Images up to this size get a thumbnail in the chat card (bigger ones only in the viewer). */
export const MAX_THUMB_BYTES = 8 * 1024 * 1024;

/** The blob of a previewable file as an object URL of exactly the allowed type (null until loaded). */
export function usePreviewUrl(artifactId: string, version: number, contentType: string, enabled: boolean) {
  const { org } = useOrg();
  const blob = useArtifactBlob(org.id, artifactId, version, enabled);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob.data) return;
    // Exactly the allowed type, whatever the server or the bytes say.
    const typed = new Blob([blob.data], { type: previewType(contentType) });
    const next = objectUrls.create(typed);
    setUrl(next);
    return () => {
      if (next) objectUrls.revoke(next);
    };
  }, [blob.data, contentType]);
  return { url, failed: blob.isError };
}

/**
 * A video on a chat message: our player in the tile's one box, played right there in parts (it starts at once,
 * whatever its size); its corner group opens the viewer, then the caller's actions; `tip`, its name and size, on hover
 * or the keys' focus, as a picture's. One this browser can't play (a codec it lacks) shows `fallback` instead, the
 * file's tile.
 */
export function FileVideo({
  content,
  artifactId,
  version,
  onOpen,
  actions,
  fallback,
  tip,
}: {
  content: ArtifactFileContent;
  artifactId: string;
  version: number;
  onOpen: () => void;
  actions?: ReactNode;
  fallback: ReactNode;
  tip?: string;
}) {
  const { org } = useOrg();
  const api = useApi();
  const [failed, setFailed] = useState(false);
  const labels = useVideoLabels();
  if (failed) return <>{fallback}</>;
  return (
    <div className="artifact-tile" data-kind="video">
      <Tip className="artifact-tile__tip" tip={tip} look="ac-msg__tip">
        <VideoPlayer
          src={api.artifacts.fileUrl(org.id, artifactId, { version })}
          name={content.name}
          labels={labels}
          onOpen={onOpen}
          actions={actions}
          onFailed={() => setFailed(true)}
        />
      </Tip>
    </div>
  );
}

/**
 * An uploaded file in the viewer (its name, size and Baixar are in the viewer's header): an inline preview only for
 * raster images and PDF (a blob of exactly that type, never the file's own origin), videos in our player (a media
 * element never runs the file as a page), and the text of small text files, read-only (JSON formatted, as a code
 * block reads it).
 */
export function FileView({
  content,
  artifactId,
  version,
  title,
  onSwipe,
}: {
  content: ArtifactFileContent;
  artifactId: string;
  version: number;
  title: string;
  /** A picture: a finger's sideways swipe moves to the next or previous one. */
  onSwipe?: ((dir: 1 | -1) => void) | undefined;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const kind = previewKind(content.contentType);
  // A video streams from the download: any size plays. The rest load whole, up to the preview limit.
  const canPreview = kind !== null && (kind === "video" || content.size <= MAX_PREVIEW_BYTES);
  const { url, failed } = usePreviewUrl(artifactId, version, content.contentType, canPreview && kind !== "video");
  const [videoFailed, setVideoFailed] = useState(false);
  const videoLabels = useVideoLabels();

  // A video fills the viewer, with its controls.
  if (kind === "video") {
    return (
      <div className="file-view file-view--image">
        {videoFailed ? (
          <p className="small muted">{t("files.previewFailed")}</p>
        ) : (
          <VideoPlayer
            key={`${artifactId}:${version}`}
            variant="viewer"
            src={api.artifacts.fileUrl(org.id, artifactId, { version })}
            name={content.name}
            labels={videoLabels}
            onFailed={() => setVideoFailed(true)}
          />
        )}
      </div>
    );
  }

  // A picture fills the viewer, with its zoom: its stage at once, the picture as soon as its bytes are here.
  if (kind === "image" && canPreview && !failed) {
    return (
      <div className="file-view file-view--image">
        <ImageZoom key={url} src={url} alt={t("files.imageAlt", { title })} onSwipe={onSwipe} />
      </div>
    );
  }
  return (
    <div className={kind === "image" && canPreview ? "file-view file-view--image" : "file-view"}>
      {canPreview && (
        <div className={kind === "pdf" ? "file-view__preview file-view__preview--pdf" : "file-view__preview"}>
          {failed ? (
            <p className="small muted">{t("files.previewFailed")}</p>
          ) : !url ? (
            <span className="row small muted" style={{ gap: 8 }} role="status">
              <Spinner />
              {t("files.previewLoading")}
            </span>
          ) : (
            <iframe className="file-view__pdf" src={url} title={t("files.pdfFrame", { title })} />
          )}
        </div>
      )}
      {kind !== null && !canPreview && <p className="small muted">{t("files.tooBigToPreview")}</p>}
      {kind === null &&
        content.text !== undefined &&
        (isJsonFile(content.name, content.contentType) ? (
          <CodeBlock lang="json" text={content.text} />
        ) : (
          <pre className="file-view__text">
            <code>{content.text}</code>
          </pre>
        ))}
      {kind === null && content.text === undefined && <p className="small muted">{t("files.downloadOnly")}</p>}
    </div>
  );
}
