import { createHash } from "node:crypto";
import type { BlobStore } from "@agenteschat/adapters";
import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { NotFoundError, ValidationError } from "./errors";
import { getMembership, invitedOrgId, requirePermission } from "./organizations";

const { users, organizationMembers, organizations } = schema;

export const AVATAR_LIMITS = { maxBytes: 2 * 1024 * 1024 };
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** The image type from its first bytes (never trust the declared type alone). */
export function sniffImage(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** An image a model reads (PNG, JPEG, WebP or GIF) by its first bytes: the APIs refuse one sent under another type. */
export const sniffModelImage = (bytes: Uint8Array) =>
  sniffImage(bytes) ?? (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 ? "image/gif" : null);

/** JPEG without EXIF/XMP (APP1), Photoshop/IPTC (APP13) or comments; the image data is untouched. */
function stripJpeg(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1] as number;
    if (marker === 0xda) break; // start of scan: the rest is image data
    const length = ((b[i + 2] as number) << 8) | (b[i + 3] as number);
    const end = i + 2 + length;
    if (end > b.length) break;
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) out.push(b.subarray(i, end));
    i = end;
  }
  out.push(b.subarray(i));
  return concat(out);
}

/** PNG without text, EXIF or time chunks. */
function stripPng(b: Uint8Array): Uint8Array {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const length = view.getUint32(i);
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const end = i + 12 + length;
    if (end > b.length) break;
    if (!["tEXt", "zTXt", "iTXt", "eXIf", "tIME"].includes(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return concat(out);
}

/** WebP without EXIF or XMP chunks (and their flags cleared). */
function stripWebp(b: Uint8Array): Uint8Array {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const chunks: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = String.fromCharCode(...b.subarray(i, i + 4));
    const size = view.getUint32(i + 4, true);
    const end = i + 8 + size + (size % 2);
    if (end > b.length + 1) break;
    if (type !== "EXIF" && type !== "XMP ") {
      const chunk = b.slice(i, Math.min(end, b.length));
      if (type === "VP8X" && chunk.length > 8) chunk[8] = (chunk[8] as number) & ~0x0c; // no EXIF / XMP flags
      chunks.push(chunk);
    }
    i = end;
  }
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  return concat([header, body]);
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The image without metadata (location, camera, names); pixels are kept as sent. */
export function stripImageMetadata(bytes: Uint8Array, type: "image/jpeg" | "image/png" | "image/webp") {
  return type === "image/jpeg" ? stripJpeg(bytes) : type === "image/png" ? stripPng(bytes) : stripWebp(bytes);
}

/** A stored photo's address; a drawn portrait keeps its recipe after it, as a fragment (`#px=1.f.s3.…`). */
const AVATAR_PATH = /^\/api\/app\/avatars\/([^/]+)\/([0-9a-f]{16}\.(jpg|png|webp))(#px=[A-Za-z0-9.]+)?$/;
/** A portrait's recipe as the apps write it: "1." and its values, letters and digits between dots (ADR 0166). */
export const PORTRAIT_CODE = /^1(\.[A-Za-z0-9]{1,24}){1,48}$/;

/**
 * An uploaded image (base64): JPEG, PNG or WebP up to 2 MB, checked by its
 * bytes, without metadata; named by a hash of its content.
 */
function readImage(input: { imageBase64: string; contentType: string }, code: "avatar" | "logo") {
  const clean = input.imageBase64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new ValidationError("The image isn't base64", `${code}.not_base64`);
  const bytes = new Uint8Array(Buffer.from(clean, "base64"));
  if (bytes.length === 0) throw new ValidationError("The image is empty", `${code}.empty`);
  if (bytes.length > AVATAR_LIMITS.maxBytes)
    throw new ValidationError("The image can be up to 2 MB", `${code}.too_large`, { maxMb: 2 });
  const type = sniffImage(bytes);
  if (!type || !TYPES[input.contentType] || type !== input.contentType) {
    throw new ValidationError("Use a JPEG, PNG or WebP image", `${code}.type`);
  }
  const body = stripImageMetadata(bytes, type);
  const file = `${createHash("sha256").update(body).digest("hex").slice(0, 16)}.${TYPES[type]}`;
  return { body, type, file };
}

/**
 * Sets a person's photo (`PUT …/me/avatar`): JPEG, PNG or WebP up to 2 MB,
 * checked by its bytes, stripped of metadata, stored in the platform bucket,
 * served by `GET /api/app/avatars/{userId}/{file}` (people sharing an org).
 * The app crops it (512×512) before sending. A portrait drawn in the app
 * (ADR 0166) is a photo like any other, sent with the recipe it was drawn
 * from: the recipe stays on the address as a fragment, which no request
 * carries, so an app that knows it draws the portrait itself and opens it
 * again to edit, and everything else shows the image.
 */
export async function setAvatar(
  deps: { db: Database; blobs: BlobStore },
  userId: string,
  input: { imageBase64: string; contentType: string; portrait?: string },
): Promise<{ avatarUrl: string }> {
  if (input.portrait !== undefined && !PORTRAIT_CODE.test(input.portrait))
    throw new ValidationError("That isn't a portrait's recipe", "avatar.portrait");
  const { body, type, file } = readImage(input, "avatar");
  await deps.blobs.put(`avatars/${userId}/${file}`, body, { contentType: type });
  const [before] = await deps.db.select({ image: users.image }).from(users).where(eq(users.id, userId));
  const avatarUrl = `/api/app/avatars/${encodeURIComponent(userId)}/${file}${input.portrait ? `#px=${input.portrait}` : ""}`;
  await deps.db.update(users).set({ image: avatarUrl, updatedAt: new Date() }).where(eq(users.id, userId));
  await removeStored(deps.blobs, userId, before?.image, file);
  return { avatarUrl };
}

/** Removes the photo (`DELETE …/me/avatar`): back to initials. */
export async function removeAvatar(deps: { db: Database; blobs: BlobStore }, userId: string) {
  const [before] = await deps.db.select({ image: users.image }).from(users).where(eq(users.id, userId));
  await deps.db.update(users).set({ image: null, updatedAt: new Date() }).where(eq(users.id, userId));
  await removeStored(deps.blobs, userId, before?.image, null);
}

async function removeStored(blobs: BlobStore, userId: string, image: string | null | undefined, keep: string | null) {
  const m = image ? AVATAR_PATH.exec(image) : null;
  if (!m || decodeURIComponent(m[1] ?? "") !== userId || m[2] === keep) return;
  await blobs.delete(`avatars/${userId}/${m[2]}`).catch(() => undefined);
}

/**
 * The stored photo for `GET /api/app/avatars/{userId}/{file}`: only for the
 * person or someone who shares an organization with them.
 */
export async function avatarFile(
  deps: { db: Database; blobs: BlobStore },
  viewerId: string,
  userId: string,
  file: string,
) {
  if (!/^[0-9a-f]{16}\.(jpg|png|webp)$/.test(file)) throw new NotFoundError("Not found");
  if (viewerId !== userId) {
    const [shared] = await deps.db
      .select({ orgId: organizationMembers.orgId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, userId),
          sql`${organizationMembers.orgId} in (select org_id from organization_members where user_id = ${viewerId})`,
        ),
      )
      .limit(1);
    if (!shared) throw new NotFoundError("Not found");
  }
  const object = await deps.blobs.get(`avatars/${userId}/${file}`);
  if (!object) throw new NotFoundError("Not found");
  return object;
}

// ── The workspace logo ───────────────────────────────────────────────────────

const LOGO_PATH = /^\/api\/app\/org-logos\/([^/]+)\/([0-9a-f]{16}\.(jpg|png|webp))$/;

/**
 * Sets the workspace logo (`PUT …/organizations/{orgId}/logo`): an admin
 * (`configure`); same checks as a photo; stored in the platform bucket and
 * served to the org's members by `GET /api/app/org-logos/{orgId}/{file}`.
 * The app crops it square (512×512) before sending. Audited.
 */
export async function setOrgLogo(
  deps: { db: Database; blobs: BlobStore },
  actorId: string,
  orgId: string,
  input: { imageBase64: string; contentType: string },
): Promise<{ logo: string }> {
  await requirePermission(deps.db, actorId, orgId, "configure");
  const { body, type, file } = readImage(input, "logo");
  await deps.blobs.put(`org-logos/${orgId}/${file}`, body, { contentType: type });
  const [before] = await deps.db
    .select({ logo: organizations.logo })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const logo = `/api/app/org-logos/${encodeURIComponent(orgId)}/${file}`;
  await deps.db.update(organizations).set({ logo }).where(eq(organizations.id, orgId));
  caches.orgs.delete(`${orgId}:`);
  await removeStoredLogo(deps.blobs, orgId, before?.logo, file);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "organization.logo_changed",
    target: { type: "organization", id: orgId },
  });
  return { logo };
}

/** Removes the workspace logo (`DELETE …/organizations/{orgId}/logo`): back to the agent mark. Audited. */
export async function removeOrgLogo(deps: { db: Database; blobs: BlobStore }, actorId: string, orgId: string) {
  await requirePermission(deps.db, actorId, orgId, "configure");
  const [before] = await deps.db
    .select({ logo: organizations.logo })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  await deps.db.update(organizations).set({ logo: null }).where(eq(organizations.id, orgId));
  caches.orgs.delete(`${orgId}:`);
  await removeStoredLogo(deps.blobs, orgId, before?.logo, null);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "organization.logo_removed",
    target: { type: "organization", id: orgId },
  });
}

async function removeStoredLogo(blobs: BlobStore, orgId: string, logo: string | null | undefined, keep: string | null) {
  const m = logo ? LOGO_PATH.exec(logo) : null;
  if (!m || decodeURIComponent(m[1] ?? "") !== orgId || m[2] === keep) return;
  await blobs.delete(`org-logos/${orgId}/${m[2]}`).catch(() => undefined);
}

/**
 * The stored logo for `GET /api/app/org-logos/{orgId}/{file}`: only for the org's members, a closed workspace's too,
 * whose mark still shows in their list of workspaces.
 */
export async function orgLogoFile(
  deps: { db: Database; blobs: BlobStore },
  viewerId: string,
  orgId: string,
  file: string,
) {
  if (!/^[0-9a-f]{16}\.(jpg|png|webp)$/.test(file)) throw new NotFoundError("Not found");
  if (!(await getMembership(deps.db, viewerId, orgId))) throw new NotFoundError("Not found");
  const object = await deps.blobs.get(`org-logos/${orgId}/${file}`);
  if (!object) throw new NotFoundError("Not found");
  return object;
}

/**
 * The organization's current logo, no person checked: for a connected computer (`GET /api/machines/org-logo`,
 * ADR 0036: the caller authenticated the machine token, and the machine belongs to `orgId`) and an invitation's
 * page (`invitationLogoFile`). Null without a logo. `file` (a content hash) doubles as the ETag.
 */
export async function currentOrgLogo(deps: { db: Database; blobs: BlobStore }, orgId: string) {
  const [org] = await deps.db
    .select({ logo: organizations.logo })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const m = org?.logo ? LOGO_PATH.exec(org.logo) : null;
  if (!m?.[2] || decodeURIComponent(m[1] ?? "") !== orgId) return null;
  const object = await deps.blobs.get(`org-logos/${orgId}/${m[2]}`);
  if (!object) return null;
  return { file: m[2], ...object };
}

/**
 * The logo on an invitation's page (`GET /api/app/invitations/{token}/logo/{file}`, the preview's `logo`): the
 * current file of the workspace that token opens, only while the invitation or link works.
 */
export async function invitationLogoFile(deps: { db: Database; blobs: BlobStore }, token: string, file: string) {
  const orgId = await invitedOrgId(deps.db, token);
  const logo = orgId ? await currentOrgLogo(deps, orgId) : null;
  if (!logo || logo.file !== file) throw new NotFoundError("Not found");
  return logo;
}
