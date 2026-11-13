#!/usr/bin/env python3
from __future__ import annotations
"""
Generates high-craft photographic/editorial studio plates and transparent cutouts
in video/public/photos/ using Pillow 11 for the 7 choreographed motion acts.
"""

import math
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

PHOTOS_DIR = Path(__file__).resolve().parent.parent / "public" / "photos"


def add_film_grain(img: Image.Image, seed: int, amount: float = 9.0) -> Image.Image:
    rng = random.Random(seed)
    w, h = img.size
    # Fast tileable grain pattern
    tile = Image.new("RGB", (128, 128))
    px = tile.load()
    for y in range(128):
        for x in range(128):
            g = int(128 + rng.uniform(-amount, amount))
            px[x, y] = (g, g, g)
    grain_layer = Image.new("RGB", (w, h))
    for y in range(0, h, 128):
        for x in range(0, w, 128):
            grain_layer.paste(tile, (x, y))
    return Image.blend(img, grain_layer, 0.08)


def draw_studio_backdrop(w: int, h: int, top_rgb: tuple[int, int, int], bot_rgb: tuple[int, int, int], spot_rgb: tuple[int, int, int] | None = None) -> Image.Image:
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        ty = y / max(1, h - 1)
        r0 = top_rgb[0] * (1 - ty) + bot_rgb[0] * ty
        g0 = top_rgb[1] * (1 - ty) + bot_rgb[1] * ty
        b0 = top_rgb[2] * (1 - ty) + bot_rgb[2] * ty
        for x in range(w):
            dx = (x / w - 0.5) * 1.6
            dy = (ty - 0.38) * 1.4
            rad = math.exp(-(dx * dx + dy * dy) * 1.8)
            sr = spot_rgb[0] if spot_rgb else min(255, top_rgb[0] + 22)
            sg = spot_rgb[1] if spot_rgb else min(255, top_rgb[1] + 22)
            sb = spot_rgb[2] if spot_rgb else min(255, top_rgb[2] + 22)
            r = int(max(0, min(255, r0 * (1 - 0.25 * rad) + sr * 0.25 * rad)))
            g = int(max(0, min(255, g0 * (1 - 0.25 * rad) + sg * 0.25 * rad)))
            b = int(max(0, min(255, b0 * (1 - 0.25 * rad) + sb * 0.25 * rad)))
            px[x, y] = (r, g, b)
    return img


def draw_cobalt_overshirt(draw: ImageDraw.ImageDraw, cx: int, cy: int, scale: float = 1.0, tilt_px: int = 0) -> None:
    s = scale
    # Soft floor shadow
    shadow = [
        (cx - int(130 * s), cy - int(145 * s)),
        (cx + int(130 * s), cy - int(145 * s)),
        (cx + int(225 * s), cy + int(55 * s)),
        (cx + int(165 * s), cy + int(85 * s)),
        (cx + int(125 * s), cy + int(30 * s)),
        (cx + int(120 * s), cy + int(215 * s)),
        (cx - int(120 * s), cy + int(215 * s)),
        (cx - int(125 * s), cy + int(30 * s)),
        (cx - int(165 * s), cy + int(85 * s)),
        (cx - int(225 * s), cy + int(55 * s)),
    ]
    draw.polygon([(x + 14, y + 18) for x, y in shadow], fill=(22, 24, 34))

    cobalt_main = (46, 75, 255)
    cobalt_dark = (29, 51, 198)
    cobalt_light = (84, 110, 255)
    stitch = (158, 178, 255)

    # Sleeves + torso silhouette
    body = [
        (cx - int(72 * s), cy - int(152 * s)),
        (cx + int(72 * s), cy - int(152 * s)),
        (cx + int(135 * s), cy - int(125 * s)),
        (cx + int(222 * s), cy + int(45 * s) + tilt_px),
        (cx + int(162 * s), cy + int(76 * s) + tilt_px),
        (cx + int(118 * s), cy - int(12 * s)),
        (cx + int(112 * s), cy + int(206 * s)),
        (cx - int(112 * s), cy + int(206 * s)),
        (cx - int(118 * s), cy - int(12 * s)),
        (cx - int(162 * s), cy + int(76 * s) - tilt_px),
        (cx - int(222 * s), cy + int(45 * s) - tilt_px),
        (cx - int(135 * s), cy - int(125 * s)),
    ]
    draw.polygon(body, fill=cobalt_main, outline=cobalt_dark)

    # Subtle vertical shading fold
    draw.rectangle(
        [cx - int(105 * s), cy - int(120 * s), cx - int(45 * s), cy + int(200 * s)],
        fill=(40, 67, 236),
    )
    # Center placket
    draw.rectangle(
        [cx - int(14 * s), cy - int(120 * s), cx + int(14 * s), cy + int(206 * s)],
        fill=cobalt_light,
        outline=cobalt_dark,
    )
    # Collar
    draw.polygon(
        [
            (cx - int(72 * s), cy - int(152 * s)),
            (cx, cy - int(104 * s)),
            (cx - int(58 * s), cy - int(84 * s)),
        ],
        fill=cobalt_light,
        outline=cobalt_dark,
    )
    draw.polygon(
        [
            (cx + int(72 * s), cy - int(152 * s)),
            (cx, cy - int(104 * s)),
            (cx + int(58 * s), cy - int(84 * s)),
        ],
        fill=cobalt_light,
        outline=cobalt_dark,
    )
    # Dual chest utility pockets
    for side in (-1, 1):
        px0 = cx + side * int(58 * s) - int(32 * s)
        py0 = cy - int(56 * s)
        px1 = px0 + int(64 * s)
        py1 = py0 + int(74 * s)
        draw.rectangle([px0, py0, px1, py1], fill=cobalt_dark, outline=stitch)
        draw.polygon(
            [(px0, py0), (px1, py0), (px1, py0 + int(22 * s)), (cx + side * int(58 * s), py0 + int(30 * s)), (px0, py0 + int(22 * s))],
            fill=cobalt_light,
            outline=stitch,
        )
    # Matte horn buttons
    for b_idx in range(5):
        by = cy - int(90 * s) + b_idx * int(64 * s)
        r = max(3, int(6 * s))
        draw.ellipse([cx - r, by - r, cx + r, by + r], fill=(20, 22, 32), outline=(120, 140, 220))


def generate_garments() -> None:
    # Main garment studio shot
    bg = draw_studio_backdrop(800, 960, (244, 239, 230), (225, 219, 206), (255, 252, 245))
    d = ImageDraw.Draw(bg)
    draw_cobalt_overshirt(d, 400, 460, scale=1.45)
    add_film_grain(bg, 101, 7.0).save(PHOTOS_DIR / "garment-cobalt-overshirt.jpg", quality=92)

    looks = [
        ("look-1-butter.jpg", (243, 211, 107), (224, 186, 74), 0),
        ("look-2-cream.jpg", (244, 239, 230), (220, 212, 198), 10),
        ("look-3-terracotta.jpg", (217, 107, 67), (176, 74, 42), -10),
        ("look-4-sage.jpg", (148, 180, 159), (108, 144, 122), 8),
        ("look-5-greyblue.jpg", (138, 158, 181), (98, 118, 144), -8),
    ]
    for idx, (fname, top_c, bot_c, tilt) in enumerate(looks, start=1):
        img = draw_studio_backdrop(720, 960, top_c, bot_c)
        dr = ImageDraw.Draw(img)
        # Editorial model neck/shoulders + overshirt crop
        dr.rectangle([322, 180, 398, 290], fill=(214, 168, 142))
        dr.ellipse([300, 72, 420, 212], fill=(214, 168, 142))
        dr.arc([296, 62, 424, 175], 180, 360, fill=(30, 26, 24), width=28)
        draw_cobalt_overshirt(dr, 360, 440, scale=1.32, tilt_px=tilt)
        # Editorial lower trousers
        dr.rectangle([235, 710, 345, 960], fill=(24, 26, 32))
        dr.rectangle([375, 710, 485, 960], fill=(20, 22, 28))
        add_film_grain(img, 200 + idx, 9.0).save(PHOTOS_DIR / fname, quality=92)


def generate_models_and_avatars() -> None:
    profiles = [
        ("model-1.jpg", (236, 228, 216), (214, 162, 134), (26, 22, 20), (46, 75, 255)),
        ("model-2.jpg", (222, 228, 236), (146, 98, 72), (18, 16, 16), (22, 24, 30)),
        ("model-3.jpg", (240, 224, 206), (234, 194, 166), (168, 114, 62), (46, 75, 255)),
        ("model-4.jpg", (212, 224, 216), (186, 134, 102), (34, 24, 20), (243, 211, 107)),
        ("model-5.jpg", (230, 222, 232), (224, 176, 152), (42, 34, 32), (46, 75, 255)),
        ("model-6.jpg", (236, 230, 220), (124, 78, 56), (16, 14, 14), (217, 107, 67)),
    ]
    for idx, (fname, bg_c, skin, hair, jacket) in enumerate(profiles, start=1):
        img = draw_studio_backdrop(540, 660, bg_c, (bg_c[0] - 24, bg_c[1] - 24, bg_c[2] - 24))
        dr = ImageDraw.Draw(img)
        # Shoulders
        dr.pieslice([70, 410, 470, 820], 180, 360, fill=jacket)
        # Neck & Head
        dr.rectangle([232, 330, 308, 440], fill=skin)
        dr.ellipse([186, 140, 354, 355], fill=skin)
        # Stylized editorial hair + brow + sunglasses/gaze
        dr.chord([176, 118, 364, 275], 170, 370, fill=hair)
        dr.rectangle([212, 232, 256, 246], fill=(28, 24, 22))
        dr.rectangle([284, 232, 328, 246], fill=(28, 24, 22))
        dr.line([(256, 238), (284, 238)], fill=(28, 24, 22), width=4)
        add_film_grain(img, 300 + idx, 8.0).save(PHOTOS_DIR / fname, quality=92)

    # Sam Rivera + Reply Avatars
    for fname, bg_c, skin, hair, coat in [
        ("avatar-sam.jpg", (216, 27, 120), (228, 176, 146), (22, 20, 24), (20, 20, 22)),
        ("avatar-reply.jpg", (61, 163, 93), (172, 118, 86), (18, 16, 18), (242, 176, 30)),
    ]:
        img = draw_studio_backdrop(320, 320, bg_c, (max(0, bg_c[0] - 40), max(0, bg_c[1] - 40), max(0, bg_c[2] - 40)))
        dr = ImageDraw.Draw(img)
        dr.pieslice([35, 200, 285, 420], 180, 360, fill=coat)
        dr.ellipse([104, 62, 216, 202], fill=skin)
        dr.chord([98, 52, 222, 154], 180, 360, fill=hair)
        add_film_grain(img, hash(fname) & 0xFFFF, 6.0).save(PHOTOS_DIR / fname, quality=92)


def generate_cutline_thumbs() -> None:
    # 1. Sunset Pier
    pier = Image.new("RGB", (960, 540))
    px = pier.load()
    for y in range(540):
        for x in range(960):
            ny = y / 540.0
            nx = x / 960.0
            if ny < 0.56:
                t = ny / 0.56
                r = int(22 * (1 - t) + 242 * t)
                g = int(35 * (1 - t) + 124 * t)
                b = int(63 * (1 - t) + 84 * t)
            else:
                t = (ny - 0.56) / 0.44
                r = int(194 * (1 - t) + 22 * t)
                g = int(78 * (1 - t) + 35 * t)
                b = int(96 * (1 - t) + 63 * t)
            # Glowing sun + water reflection
            dx = nx - 0.52
            dy = (ny - 0.50) * 1.77
            sun = math.exp(-(dx * dx + dy * dy) * 32.0)
            refl = math.exp(-abs(dx) * 18.0) * (1.0 if ny > 0.56 else 0.0) * (0.5 + 0.5 * math.sin(ny * 120))
            val = min(1.0, sun + refl * 0.65)
            r = min(255, int(r + (255 - r) * val))
            g = min(255, int(g + (220 - g) * val))
            b = min(255, int(b + (130 - b) * val))
            px[x, y] = (r, g, b)
    dr = ImageDraw.Draw(pier)
    # Pier deck & wooden pilings
    dr.polygon([(380, 540), (470, 315), (510, 315), (600, 540)], fill=(18, 22, 34))
    for k in range(5):
        py = 330 + k * 42
        sp = 32 + k * 24
        dr.rectangle([490 - sp - 6, py - 24, 490 - sp + 4, py + 12], fill=(12, 14, 22))
        dr.rectangle([490 + sp - 4, py - 24, 490 + sp + 6, py + 12], fill=(12, 14, 22))
    add_film_grain(pier, 401, 7.0).save(PHOTOS_DIR / "thumb-pier.jpg", quality=92)

    # 2. Skyline
    sky = draw_studio_backdrop(640, 360, (16, 28, 62), (194, 24, 91), (242, 176, 30))
    dr = ImageDraw.Draw(sky)
    rng = random.Random(402)
    x = 0
    while x < 640:
        bw = rng.randint(28, 68)
        bh = rng.randint(90, 250)
        dr.rectangle([x, 360 - bh, x + bw - 3, 360], fill=(18, 24, 42))
        for wy in range(360 - bh + 14, 345, 16):
            for wx in range(x + 6, x + bw - 10, 12):
                if rng.random() > 0.45:
                    dr.rectangle([wx, wy, wx + 5, wy + 7], fill=(242, 198, 92))
        x += bw
    add_film_grain(sky, 402, 7.0).save(PHOTOS_DIR / "thumb-skyline.jpg", quality=92)

    # 3. Skatepark
    skate = draw_studio_backdrop(640, 360, (46, 75, 255), (242, 176, 30), (255, 244, 214))
    dr = ImageDraw.Draw(skate)
    dr.chord([-80, 140, 720, 480], 0, 180, fill=(224, 218, 206), outline=(22, 35, 63), width=4)
    dr.ellipse([430, 62, 488, 120], fill=(255, 244, 210))
    # Skater silhouette
    dr.line([(290, 210), (312, 165), (332, 205)], fill=(22, 35, 63), width=8)
    dr.ellipse([300, 134, 326, 160], fill=(22, 35, 63))
    dr.line([(272, 215), (350, 210)], fill=(194, 24, 91), width=7)
    add_film_grain(skate, 403, 7.0).save(PHOTOS_DIR / "thumb-skate.jpg", quality=92)

    # 4. Tabletop / Cooking
    cook = draw_studio_backdrop(640, 360, (242, 234, 222), (216, 202, 184))
    dr = ImageDraw.Draw(cook)
    dr.ellipse([180, 45, 460, 325], fill=(255, 252, 246), outline=(22, 35, 63), width=6)
    dr.ellipse([215, 80, 425, 290], fill=(240, 90, 40))
    dr.ellipse([245, 110, 395, 260], fill=(242, 176, 30))
    dr.ellipse([290, 155, 345, 210], fill=(61, 163, 93))
    add_film_grain(cook, 404, 7.0).save(PHOTOS_DIR / "thumb-cooking.jpg", quality=92)


def generate_molote_assets() -> None:
    # Transparent PNG portable Bluetooth speaker cutout (Molote Parche 2)
    sp = Image.new("RGBA", (720, 720), (0, 0, 0, 0))
    dr = ImageDraw.Draw(sp)
    # Soft drop shadow
    dr.ellipse([155, 585, 565, 650], fill=(0, 0, 0, 90))
    sp = sp.filter(ImageFilter.GaussianBlur(10))
    dr = ImageDraw.Draw(sp)

    # Outer industrial speaker shell
    dr.rounded_rectangle([170, 110, 550, 610], radius=120, fill=(28, 30, 34, 255), outline=(56, 60, 68, 255), width=6)
    # Top anodized control cap + tactile orange power/play ring
    dr.rounded_rectangle([185, 118, 535, 198], radius=65, fill=(44, 47, 54, 255))
    dr.ellipse([306, 134, 414, 184], fill=(240, 90, 40, 255), outline=(246, 240, 226, 255), width=4)
    # Perforated acoustic mesh grille
    for gy in range(225, 545, 18):
        for gx in range(210, 515, 18):
            dx = (gx - 360) / 160.0
            if abs(dx) < 0.92:
                dr.ellipse([gx - 4, gy - 4, gx + 4, gy + 4], fill=(14, 15, 18, 255))
    # Specular highlight bar on left + green accent strap tag
    dr.rounded_rectangle([196, 215, 212, 545], radius=8, fill=(255, 255, 255, 38))
    dr.rounded_rectangle([534, 260, 578, 338], radius=10, fill=(59, 165, 92, 255), outline=(20, 20, 20, 255), width=4)
    sp.save(PHOTOS_DIR / "speaker-cutout.png")

    # Warm golden-hour friends Polaroid snapshot
    fr = draw_studio_backdrop(840, 640, (248, 176, 88), (59, 128, 96), (255, 232, 168))
    dr = ImageDraw.Draw(fr)
    # Sunburst + distant hills
    dr.ellipse([540, 70, 680, 210], fill=(255, 236, 176))
    dr.polygon([(0, 460), (260, 380), (540, 420), (840, 355), (840, 640), (0, 640)], fill=(38, 86, 62))
    # Three laughing friend silhouettes holding up speaker
    for px, py, col in [(250, 330, (240, 90, 40)), (415, 305, (246, 240, 226)), (585, 325, (20, 20, 20))]:
        dr.ellipse([px - 42, py - 42, px + 42, py + 42], fill=(42, 34, 30))
        dr.pieslice([px - 88, py + 36, px + 88, py + 320], 180, 360, fill=col)
    # Small speaker held in center
    dr.rounded_rectangle([388, 356, 444, 445], radius=18, fill=(28, 30, 34), outline=(240, 90, 40), width=3)
    add_film_grain(fr, 505, 11.0).save(PHOTOS_DIR / "friends-photo.jpg", quality=92)


def main() -> None:
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    generate_garments()
    generate_models_and_avatars()
    generate_cutline_thumbs()
    generate_molote_assets()
    files = sorted(p.name for p in PHOTOS_DIR.iterdir())
    print(f"[photos] Generated {len(files)} assets in {PHOTOS_DIR}: {', '.join(files)}")


if __name__ == "__main__":
    main()
