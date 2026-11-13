import { keys } from "@agenteschat/client";
import {
  Avatar,
  type AvatarProps,
  Button,
  cx,
  Dialog,
  DialogBody,
  DialogFooter,
  Locked,
  LogoMark,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/** The crop square on screen and the size we upload. */
export const VIEW_PX = 240;
export const OUT_PX = 512;
const MAX_ZOOM = 3;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export interface Crop {
  zoom: number;
  /** Offset of the image's top-left in the square (≤ 0). */
  x: number;
  y: number;
}

/** Scale that makes the image cover the square at zoom 1. */
export const coverScale = (w: number, h: number, view = VIEW_PX) => (w > 0 && h > 0 ? view / Math.min(w, h) : 1);

/** Keeps the image covering the square (no empty edges). */
export function clampCrop(crop: Crop, w: number, h: number, view = VIEW_PX): Crop {
  const s = coverScale(w, h, view) * crop.zoom;
  const minX = Math.min(0, view - w * s);
  const minY = Math.min(0, view - h * s);
  return { zoom: crop.zoom, x: Math.min(0, Math.max(minX, crop.x)), y: Math.min(0, Math.max(minY, crop.y)) };
}

/** The source rectangle (in image pixels) the square shows. */
export function cropRect(crop: Crop, w: number, h: number, view = VIEW_PX) {
  const s = coverScale(w, h, view) * crop.zoom;
  // `|| 0`: no negative zero.
  return { sx: -crop.x / s || 0, sy: -crop.y / s || 0, size: view / s };
}

const readAsDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

/** The square crop as JPEG base64; falls back to the original file where there is no canvas. */
/** Base64 of a file (bytes, no FileReader needed). */
export async function fileToBase64(file: Blob): Promise<string> {
  if (typeof file.arrayBuffer === "function") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }
  const url = await readAsDataUrl(file);
  return url.slice(url.indexOf(",") + 1);
}

/** The square crop (JPEG, or PNG to keep transparency); where there is no usable canvas (or it fails), the original file as is. */
export async function encode(
  file: File,
  img: HTMLImageElement | null,
  crop: Crop,
  format: "image/jpeg" | "image/png" = "image/jpeg",
) {
  try {
    const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
    const ctx = canvas?.getContext?.("2d");
    if (canvas && ctx && img && img.naturalWidth > 0 && typeof canvas.toDataURL === "function") {
      canvas.width = OUT_PX;
      canvas.height = OUT_PX;
      const r = cropRect(crop, img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, r.sx, r.sy, r.size, r.size, 0, 0, OUT_PX, OUT_PX);
      const url = canvas.toDataURL(format, 0.9);
      const data = url.slice(url.indexOf(",") + 1);
      if (url.startsWith(`data:${format}`) && data) return { imageBase64: data, contentType: format };
    }
  } catch {
    // No canvas here: send the original.
  }
  return { imageBase64: await fileToBase64(file), contentType: file.type || "image/jpeg" };
}

/** What a square image dialog shows and does (profile photo, workspace logo). */
interface ImageCropProps {
  open: boolean;
  onClose: () => void;
  title: string;
  help: string;
  /** Shown in the drop area before an image is picked. */
  placeholder: ReactNode;
  /** There is an image now: Remover shows. */
  hasImage: boolean;
  removeLabel: string;
  format?: "image/jpeg" | "image/png";
  save: (image: { imageBase64: string; contentType: string }) => Promise<unknown>;
  remove: () => Promise<unknown>;
  onSaved: () => void;
  onRemoved: () => void;
}

/** A square image: drop or pick an image, zoom and drag to frame the square, then Salvar (or Remover). */
export function ImageCropDialog({
  open,
  onClose,
  title,
  help,
  placeholder,
  hasImage,
  removeLabel,
  format = "image/jpeg",
  save: send,
  remove: drop,
  onSaved,
  onRemoved,
}: ImageCropProps) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [crop, setCrop] = useState<Crop>({ zoom: 1, x: 0, y: 0 });
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; crop: Crop } | null>(null);

  useEffect(() => {
    if (open) return;
    setFile(null);
    setUrl(null);
    setCrop({ zoom: 1, x: 0, y: 0 });
    setError(null);
  }, [open]);
  useEffect(
    () => () => {
      if (url && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
    },
    [url],
  );

  const choose = async (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) return setError(t("photo.notImage"));
    if (f.size > MAX_PHOTO_BYTES) return setError(t("photo.tooBig"));
    setError(null);
    setFile(f);
    setCrop({ zoom: 1, x: 0, y: 0 });
    setSize({ w: 0, h: 0 });
    setUrl(typeof URL.createObjectURL === "function" ? URL.createObjectURL(f) : await readAsDataUrl(f));
  };
  const save = useMutation({
    mutationFn: async () => {
      if (!file) return;
      await send(await encode(file, img.current, crop, format));
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: drop,
    onSuccess: () => {
      onRemoved();
      onClose();
    },
  });
  const busy = save.isPending || remove.isPending;
  const zoomBy = (d: number) =>
    setCrop((c) => clampCrop({ ...c, zoom: Math.min(MAX_ZOOM, Math.max(1, c.zoom + d)) }, size.w, size.h));
  const scale = coverScale(size.w, size.h) * crop.zoom;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={help}
      closeLabel={t("common.close")}
      width={420}
    >
      <Locked when={busy}>
        <DialogBody>
          <input
            ref={input}
            type="file"
            accept="image/*"
            className="ac-visually-hidden"
            aria-label={t("photo.pick")}
            onChange={(e) => void choose(e.target.files?.[0])}
          />
          {url ? (
            <div className="photo-crop">
              <div
                className="photo-crop__frame"
                role="img"
                aria-label={t("photo.preview")}
                onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
                  if (busy) return;
                  drag.current = { x: e.clientX, y: e.clientY, crop };
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d) return;
                  setCrop(
                    clampCrop(
                      { ...d.crop, x: d.crop.x + e.clientX - d.x, y: d.crop.y + e.clientY - d.y },
                      size.w,
                      size.h,
                    ),
                  );
                }}
                onPointerUp={() => {
                  drag.current = null;
                }}
              >
                <img
                  ref={img}
                  src={url}
                  alt=""
                  draggable={false}
                  onLoad={(e) => {
                    const el = e.currentTarget;
                    setSize({ w: el.naturalWidth, h: el.naturalHeight });
                    // Centered to start.
                    const s = coverScale(el.naturalWidth, el.naturalHeight);
                    setCrop({
                      zoom: 1,
                      x: (VIEW_PX - el.naturalWidth * s) / 2,
                      y: (VIEW_PX - el.naturalHeight * s) / 2,
                    });
                  }}
                  style={
                    size.w > 0
                      ? {
                          width: size.w * scale,
                          height: size.h * scale,
                          transform: `translate(${crop.x}px, ${crop.y}px)`,
                        }
                      : { width: "100%", height: "100%", objectFit: "cover" }
                  }
                />
              </div>
              <div className="row" style={{ gap: 6, justifyContent: "center" }}>
                <Button size="sm" variant="ghost" onClick={() => zoomBy(-0.25)} disabled={crop.zoom <= 1}>
                  {t("photo.zoomOut")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => zoomBy(0.25)} disabled={crop.zoom >= MAX_ZOOM}>
                  {t("photo.zoomIn")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => input.current?.click()}>
                  {t("photo.other")}
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="photo-drop"
              data-over={over || undefined}
              onClick={() => input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                if (!busy) void choose(e.dataTransfer?.files?.[0]);
              }}
            >
              {placeholder}
              <span style={{ fontWeight: 600 }}>{t("photo.drop")}</span>
              <span className="small muted">{t("photo.dropHelp")}</span>
            </button>
          )}
          {error && (
            <p className="small" role="alert" style={{ color: "var(--danger)", margin: 0 }}>
              {error}
            </p>
          )}
        </DialogBody>
      </Locked>
      <DialogFooter>
        {hasImage && !file && (
          <Button
            variant="danger"
            onClick={() => remove.mutate()}
            loading={remove.isPending}
            disabled={remove.isPending}
          >
            {removeLabel}
          </Button>
        )}
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={!file || save.isPending}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** "Foto do perfil": the person's photo, theirs in every organization. */
export function ProfilePhotoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const members = qc.getQueryData<{ userId: string; avatarUrl?: string | null }[]>(keys.members(org.id));
  const done = () => {
    void qc.invalidateQueries({ queryKey: keys.members(org.id) });
    void qc.invalidateQueries({ queryKey: keys.people(org.id) });
  };
  return (
    <ImageCropDialog
      open={open}
      onClose={onClose}
      title={t("photo.title")}
      help={t("photo.help")}
      placeholder={<Avatar name={me.user.name} size="lg" imageUrl={undefined} />}
      hasImage={Boolean(members?.find((m) => m.userId === me.user.id)?.avatarUrl)}
      removeLabel={t("photo.remove")}
      save={(image) => api.orgs.setAvatar(org.id, image)}
      remove={() => api.orgs.removeAvatar(org.id)}
      onSaved={() => {
        done();
        toast.show(t("photo.saved"));
      }}
      onRemoved={() => {
        done();
        toast.show(t("photo.removed"));
      }}
    />
  );
}

/** "Logo do workspace": an admin's square logo (PNG keeps transparency); everyone in the org sees it. */
export function OrgLogoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const done = () => {
    void qc.invalidateQueries({ queryKey: keys.me });
    void qc.invalidateQueries({ queryKey: keys.org(org.id) });
  };
  return (
    <ImageCropDialog
      open={open}
      onClose={onClose}
      title={t("orgLogo.title")}
      help={t("orgLogo.help")}
      placeholder={<OrgMark logo={org.logo} size={56} />}
      hasImage={Boolean(org.logo)}
      removeLabel={t("orgLogo.remove")}
      format="image/png"
      save={(image) => api.orgs.setLogo(org.id, image)}
      remove={() => api.orgs.removeLogo(org.id)}
      onSaved={() => {
        done();
        toast.show(t("orgLogo.saved"));
      }}
      onRemoved={() => {
        done();
        toast.show(t("orgLogo.removed"));
      }}
    />
  );
}

/** My face as this workspace shows it: my photo, else my initials. */
export function MyFace(props: Omit<AvatarProps, "name" | "imageUrl">) {
  const { org, me } = useOrg();
  const photo = useDirectory(org.id).memberById.get(me.user.id)?.image ?? me.user.image;
  return <Avatar {...props} name={me.user.name} imageUrl={photo} />;
}

/** The workspace's mark: its logo when there is one, else the agent mark. */
export function OrgMark({ logo, size = 28, className }: { logo?: string | null; size?: number; className?: string }) {
  if (logo) return <img className={cx("org-mark", className)} src={logo} alt="" width={size} height={size} />;
  return <LogoMark className={className} size={size} />;
}
