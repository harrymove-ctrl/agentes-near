/** Same limit as the server (`ARTIFACT_LIMITS.fileBytes`): 50 MB per file version. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / 1024 / 1024;
/** Same limit as the server (`SKILL_LIMITS.assetBytes`): the images and other files a skill keeps, in MB. */
export const SKILL_ASSET_MB = 40;

/** Previews bigger than this are download-only (the bytes load into memory). Videos stream instead: any size plays. */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

export type PreviewKind = "image" | "pdf" | "video";

/**
 * The only types previewed inline (ADR 0025): raster images and PDF, loaded
 * from the download as a blob of exactly this type; videos, played by a video
 * player straight from the download (in parts), never as a page. SVG, HTML
 * and the rest are download-only.
 */
const PREVIEW: Record<string, PreviewKind> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "application/pdf": "pdf",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
};

const extension = (name: string) => {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name.trim());
  return m?.[1]?.toLowerCase() ?? "";
};

/** The names of the previewed types above. */
const PREVIEW_BY_EXTENSION: Record<string, PreviewKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  pdf: "pdf",
  mp4: "video",
  webm: "video",
  mov: "video",
};

/** `image`, `pdf`, `video` or null (download only). `contentType` may carry parameters. */
export function previewKind(contentType: string): PreviewKind | null {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return PREVIEW[base] ?? null;
}

/**
 * What a file's name says its preview is ("tela.png"), for the box a message's attachment keeps before its details
 * load: a message names its files, their types come with each file.
 */
export const previewKindOfName = (name: string): PreviewKind | null => PREVIEW_BY_EXTENSION[extension(name)] ?? null;

/** A file the viewer shows as a picture, with its zoom: a raster image small enough to load whole. */
export const isPreviewImage = (content: { contentType: string; size: number }) =>
  previewKind(content.contentType) === "image" && content.size <= MAX_PREVIEW_BYTES;

/** The clean MIME type for a preview blob (never what the browser would sniff). */
export const previewType = (contentType: string) => contentType.split(";")[0]?.trim().toLowerCase() ?? "";

/** The design system icons a file can show (all exist in `@agenteschat/ui`'s `IconName`). */
export type FileIconName = "image" | "video" | "document" | "table" | "archive" | "code" | "page" | "file";

const BY_EXTENSION: Record<string, FileIconName> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  heic: "image",
  mp4: "video",
  m4v: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  avi: "video",
  pdf: "document",
  doc: "document",
  docx: "document",
  odt: "document",
  rtf: "document",
  txt: "document",
  md: "document",
  csv: "table",
  tsv: "table",
  xls: "table",
  xlsx: "table",
  ods: "table",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  "7z": "archive",
  rar: "archive",
  json: "code",
  js: "code",
  mjs: "code",
  ts: "code",
  tsx: "code",
  jsx: "code",
  py: "code",
  rb: "code",
  go: "code",
  rs: "code",
  java: "code",
  sh: "code",
  yml: "code",
  yaml: "code",
  toml: "code",
  sql: "code",
  html: "page",
  htm: "page",
  patch: "code",
  diff: "code",
};

/** A JSON file, by its name or its type (`application/json`, `…+json`): the viewers show it formatted. */
export const isJsonFile = (name: string, contentType = "") =>
  extension(name) === "json" || /^application\/(?:[\w.-]+\+)?json$/.test(previewType(contentType));

/** An icon for a file from its name, then its type. */
export function fileIcon(name: string, contentType = ""): FileIconName {
  const byName = BY_EXTENSION[extension(name)];
  if (byName) return byName;
  const type = previewType(contentType);
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf") return "document";
  if (type.startsWith("text/")) return "document";
  if (type.includes("zip") || type.includes("compressed")) return "archive";
  return "file";
}

/** "820 bytes", "1,2 MB" in the active locale (Intl units: no strings to translate). */
export function formatBytes(locale: string, bytes: number) {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
  let value = Math.max(0, bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[i],
    // English's short byte is "byte" whatever the count ("820 byte"): the long one is plural where it should be.
    unitDisplay: i === 0 ? "long" : "short",
    maximumFractionDigits: i === 0 || value >= 10 ? 0 : 1,
  }).format(value);
}

/** Within the upload limit (checked before sending; the server checks again). */
export const fitsUpload = (file: { size: number }) => file.size <= MAX_UPLOAD_BYTES;
