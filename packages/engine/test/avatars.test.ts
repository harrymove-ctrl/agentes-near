import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryBlobStore } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  AVATAR_LIMITS,
  avatarFile,
  createAgent,
  createOrganization,
  ForbiddenError,
  getAgent,
  listMembers,
  NotFoundError,
  removeAvatar,
  setAgentAppearance,
  setAvatar,
  sniffImage,
  stripImageMetadata,
  ValidationError,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "latin1")] : p)));
const seg = (marker: number, payload: string) => {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...Buffer.from(payload, "latin1")];
};
/** A JPEG-shaped file: JFIF, EXIF with a GPS tag, a comment, then the scan. */
const JPEG = bytes(
  [0xff, 0xd8],
  seg(0xe0, "JFIF\0\x01\x01\0\0\x01\0\x01\0\0"),
  seg(0xe1, "Exif\0\0GPS:-23.55,-46.63"),
  seg(0xfe, "taken by Ana"),
  seg(0xdb, "quant-table"),
  [0xff, 0xda, 0x00, 0x04, 0x01, 0x02],
  "pixels",
  [0xff, 0xd9],
);
const chunk = (type: string, data: string) => {
  const len = data.length;
  return [
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...Buffer.from(type + data, "latin1"),
    0,
    0,
    0,
    0,
  ];
};
const PNG = bytes(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  chunk("IHDR", "\0\0\x02\0\0\0\x02\0\x08\x02\0\0\0"),
  chunk("tEXt", "Author\0Ana Souza"),
  chunk("IDAT", "pixels"),
  chunk("IEND", ""),
);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const has = (b: Uint8Array, text: string) => Buffer.from(b).includes(Buffer.from(text, "latin1"));

describe("photo bytes", () => {
  test("type comes from the bytes; metadata is removed and the image data kept", () => {
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(bytes("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(bytes("<svg onload=alert(1)>"))).toBeNull();

    const jpeg = stripImageMetadata(JPEG, "image/jpeg");
    expect(has(jpeg, "GPS")).toBe(false);
    expect(has(jpeg, "taken by Ana")).toBe(false);
    expect(has(jpeg, "JFIF")).toBe(true);
    expect(has(jpeg, "quant-table")).toBe(true);
    expect(has(jpeg, "pixels")).toBe(true);

    const png = stripImageMetadata(PNG, "image/png");
    expect(has(png, "Ana Souza")).toBe(false);
    expect(has(png, "IHDR")).toBe(true);
    expect(has(png, "IDAT")).toBe(true);
    expect(has(png, "IEND")).toBe(true);

    const webp = stripImageMetadata(
      bytes(
        "RIFF",
        [0, 0, 0, 0],
        "WEBP",
        "VP8X",
        [10, 0, 0, 0, 0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        "EXIF",
        [4, 0, 0, 0],
        "GPS!",
        "VP8 ",
        [2, 0, 0, 0],
        "px",
      ),
      "image/webp",
    );
    expect(has(webp, "GPS!")).toBe(false);
    expect(has(webp, "VP8 ")).toBe(true);
    expect(webp[20]).toBe(0); // EXIF/XMP flags cleared
    expect(new DataView(webp.buffer).getUint32(4, true)).toBe(webp.length - 8);
  });
});

describe("profile photo", () => {
  test("set, replace and remove; served only to people sharing an org; on the members list", async () => {
    f = await setup();
    const blobs = createMemoryBlobStore();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const zed = await addUser(f.db, "zed");
    await createOrganization(f.db, zed.id, { name: "Other" });

    await expect(
      setAvatar({ db: f.db, blobs }, bia.id, { imageBase64: b64(JPEG), contentType: "image/png" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      setAvatar({ db: f.db, blobs }, bia.id, { imageBase64: b64(bytes("<svg/>")), contentType: "image/jpeg" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      setAvatar({ db: f.db, blobs }, bia.id, { imageBase64: "not base64!", contentType: "image/jpeg" }),
    ).rejects.toBeInstanceOf(ValidationError);
    const big = new Uint8Array(AVATAR_LIMITS.maxBytes + 1);
    big.set(JPEG);
    await expect(
      setAvatar({ db: f.db, blobs }, bia.id, { imageBase64: b64(big), contentType: "image/jpeg" }),
    ).rejects.toBeInstanceOf(ValidationError);

    const first = await setAvatar({ db: f.db, blobs }, bia.id, {
      imageBase64: `data:image/jpeg;base64,${b64(JPEG)}`,
      contentType: "image/jpeg",
    });
    expect(first.avatarUrl).toMatch(new RegExp(`^/api/app/avatars/${bia.id}/[0-9a-f]{16}\\.jpg$`));
    const file = first.avatarUrl.split("/").at(-1) as string;
    const stored = await avatarFile({ db: f.db, blobs }, f.owner.id, bia.id, file);
    expect(stored.contentType).toBe("image/jpeg");
    expect(has(stored.body, "GPS")).toBe(false);
    expect(await avatarFile({ db: f.db, blobs }, bia.id, bia.id, file)).toBeTruthy();
    // zed shares no organization with bia.
    await expect(avatarFile({ db: f.db, blobs }, zed.id, bia.id, file)).rejects.toBeInstanceOf(NotFoundError);
    await expect(avatarFile({ db: f.db, blobs }, f.owner.id, bia.id, "../x.jpg")).rejects.toBeInstanceOf(NotFoundError);

    const members = await listMembers(f.db, f.org.id);
    expect(members.find((m) => m.userId === bia.id)?.avatarUrl).toBe(first.avatarUrl);
    expect(members.find((m) => m.userId === f.owner.id)?.avatarUrl).toBeNull();

    const second = await setAvatar({ db: f.db, blobs }, bia.id, { imageBase64: b64(PNG), contentType: "image/png" });
    expect(second.avatarUrl).toEndWith(".png");
    expect([...blobs.objects.keys()]).toEqual([`avatars/${bia.id}/${second.avatarUrl.split("/").at(-1)}`]);

    // A portrait drawn in the app is a photo that keeps its recipe after the address; the file is found the same way.
    const drawn = await setAvatar({ db: f.db, blobs }, bia.id, {
      imageBase64: b64(PNG),
      contentType: "image/png",
      portrait: "1.f.s3.wavy.dark",
    });
    expect(drawn.avatarUrl).toBe(`${second.avatarUrl}#px=1.f.s3.wavy.dark`);
    expect((await listMembers(f.db, f.org.id)).find((m) => m.userId === bia.id)?.avatarUrl).toBe(drawn.avatarUrl);
    expect(blobs.objects.size).toBe(1);
    await expect(
      setAvatar({ db: f.db, blobs }, bia.id, { imageBase64: b64(PNG), contentType: "image/png", portrait: "1.<x>" }),
    ).rejects.toBeInstanceOf(ValidationError);
    // A photo after it replaces the portrait's file, and removing clears either.
    await setAvatar({ db: f.db, blobs }, bia.id, { imageBase64: b64(JPEG), contentType: "image/jpeg" });
    expect([...blobs.objects.keys()]).toHaveLength(1);
    await setAvatar({ db: f.db, blobs }, bia.id, {
      imageBase64: b64(PNG),
      contentType: "image/png",
      portrait: "1.m.s1.short.black",
    });

    await removeAvatar({ db: f.db, blobs }, bia.id);
    expect(blobs.objects.size).toBe(0);
    const [row] = await f.db
      .select({ image: schema.users.image })
      .from(schema.users)
      .where(eq(schema.users.id, bia.id));
    expect(row?.image).toBeNull();
  });

  test("a sign-in provider's image is not reported as an uploaded photo", async () => {
    f = await setup();
    await f.db
      .update(schema.users)
      .set({ image: "https://lh3.example/photo.jpg" })
      .where(eq(schema.users.id, f.owner.id));
    const [me] = await listMembers(f.db, f.org.id);
    expect(me).toMatchObject({ image: "https://lh3.example/photo.jpg", avatarUrl: null });
    // Removing keeps provider images out of the bucket logic (nothing to delete).
    await removeAvatar({ db: f.db, blobs: createMemoryBlobStore() }, f.owner.id);
  });
});

describe("agent appearance", () => {
  test("allow-list only; owner or admins, audited; null goes back to the default", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const look = { color: "teal", eyes: "happy", accessory: "headphones" };
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.appearance).toBeNull();

    await expect(setAgentAppearance(f.db, bia.id, f.org.id, f.agent.id, look)).rejects.toBeInstanceOf(ForbiddenError);
    for (const bad of [
      { ...look, color: "red" },
      { ...look, eyes: "laser" },
      { ...look, accessory: "<script>" },
      { eyes: "happy" },
    ]) {
      await expect(setAgentAppearance(f.db, f.owner.id, f.org.id, f.agent.id, bad)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }

    const updated = await setAgentAppearance(f.db, f.owner.id, f.org.id, f.agent.id, look);
    expect(updated.appearance).toEqual(look);
    const [audit] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "agent.appearance_changed")));
    expect(audit).toMatchObject({ actorId: f.owner.id, targetId: f.agent.id, details: { from: null, to: look } });

    // bia owns her own agent and can dress it; a missing accessory means none.
    const hers = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Bot", handle: "bot", ownerUserId: bia.id },
      { model: "claude-sonnet-5-5" },
    );
    expect(
      (await setAgentAppearance(f.db, bia.id, f.org.id, hers.id, { color: "rose", eyes: "dots" })).appearance,
    ).toEqual({
      color: "rose",
      eyes: "dots",
      accessory: "none",
    });
    expect((await setAgentAppearance(f.db, f.owner.id, f.org.id, f.agent.id, null)).appearance).toBeNull();
  });

  test("a custom color is a #rrggbb in the same field, stored lowercase; presets still pass", async () => {
    f = await setup();
    const look = { color: "#1A2B3C", eyes: "round", accessory: "none" };
    expect((await setAgentAppearance(f.db, f.owner.id, f.org.id, f.agent.id, look)).appearance).toEqual({
      ...look,
      color: "#1a2b3c",
    });
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.appearance?.color).toBe("#1a2b3c");
    for (const color of ["#12345", "#1234567", "123456", "#ggg000", "rgb(1,2,3)", " #123456"]) {
      await expect(
        setAgentAppearance(f.db, f.owner.id, f.org.id, f.agent.id, { ...look, color }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(
      (await setAgentAppearance(f.db, f.owner.id, f.org.id, f.agent.id, { ...look, color: "violet" })).appearance,
    ).toEqual({ ...look, color: "violet" });
  });
});
