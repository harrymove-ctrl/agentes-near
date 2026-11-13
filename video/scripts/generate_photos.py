#!/usr/bin/env python3
from __future__ import annotations
"""
Generates high-craft Agentes NEAR editorial product plates, real UI screenshot cards,
sleek AI Agent Studio identity emblems (@ada, @kronos, @theo, @lia, @mira, @zen),
and a transparent OutLayer Intel TDX Hardware Enclave Vault cutout in video/public/photos/.
"""

import math
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

VIDEO_ROOT = Path(__file__).resolve().parent.parent
PHOTOS_DIR = VIDEO_ROOT / "public" / "photos"
SCREENSHOTS_DIR = VIDEO_ROOT.parent / "docs" / "screenshots"


def get_font(size: int, bold: bool = False, mono: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates: list[str] = []
    if mono:
        candidates.extend([
            "/System/Library/Fonts/SFNSMono.ttf",
            "/System/Library/Fonts/Menlo.ttc",
            "/System/Library/Fonts/Monaco.ttf",
        ])
    elif bold:
        candidates.extend([
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/HelveticaNeue.ttc",
            "/System/Library/Fonts/SFNS.ttf",
        ])
    else:
        candidates.extend([
            "/System/Library/Fonts/SFNS.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
        ])
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size=size)
            except Exception:
                pass
    try:
        return ImageFont.load_default(size=size)
    except Exception:
        return ImageFont.load_default()


def add_film_grain(img: Image.Image, seed: int, amount: float = 7.5) -> Image.Image:
    rng = random.Random(seed)
    w, h = img.size
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
    return Image.blend(img, grain_layer, 0.065)


def draw_studio_backdrop(
    w: int,
    h: int,
    top_rgb: tuple[int, int, int],
    bot_rgb: tuple[int, int, int],
    spot_rgb: tuple[int, int, int] | None = None,
) -> Image.Image:
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        ty = y / max(1, h - 1)
        r0 = top_rgb[0] * (1 - ty) + bot_rgb[0] * ty
        g0 = top_rgb[1] * (1 - ty) + bot_rgb[1] * ty
        b0 = top_rgb[2] * (1 - ty) + bot_rgb[2] * ty
        for x in range(w):
            dx = (x / w - 0.5) * 1.5
            dy = (ty - 0.38) * 1.35
            rad = math.exp(-(dx * dx + dy * dy) * 1.75)
            sr = spot_rgb[0] if spot_rgb else min(255, top_rgb[0] + 24)
            sg = spot_rgb[1] if spot_rgb else min(255, top_rgb[1] + 24)
            sb = spot_rgb[2] if spot_rgb else min(255, top_rgb[2] + 24)
            r = int(max(0, min(255, r0 * (1 - 0.25 * rad) + sr * 0.25 * rad)))
            g = int(max(0, min(255, g0 * (1 - 0.25 * rad) + sg * 0.25 * rad)))
            b = int(max(0, min(255, b0 * (1 - 0.25 * rad) + sb * 0.25 * rad)))
            px[x, y] = (r, g, b)
    return img


def load_real_screenshot(name: str, target_w: int, target_h: int) -> Image.Image:
    p = SCREENSHOTS_DIR / name
    if p.exists():
        try:
            with Image.open(p) as im:
                rgb = im.convert("RGB")
                return ImageOps.fit(rgb, (target_w, target_h), method=Image.Resampling.LANCZOS, centering=(0.5, 0.25))
        except Exception:
            pass
    # High-craft fallback UI canvas if screenshot is unavailable
    fallback = draw_studio_backdrop(target_w, target_h, (13, 16, 23), (20, 26, 38), (34, 48, 72))
    dr = ImageDraw.Draw(fallback)
    dr.rounded_rectangle([16, 16, target_w - 16, target_h - 16], radius=14, outline=(0, 236, 151), width=2)
    dr.text((32, 32), f"AGENTES NEAR · {name}", fill=(244, 246, 251), font=get_font(22, bold=True))
    return fallback


def draw_window_card(
    canvas: Image.Image,
    shot: Image.Image,
    x: int,
    y: int,
    w: int,
    h: int,
    tag: str,
    title: str,
    subtitle: str,
    accent: tuple[int, int, int],
) -> None:
    dr = ImageDraw.Draw(canvas)
    # Soft offset card shadow
    dr.rounded_rectangle([x + 12, y + 16, x + w + 12, y + h + 16], radius=24, fill=(18, 20, 26))
    # Crisp white editorial card frame
    dr.rounded_rectangle([x, y, x + w, y + h], radius=24, fill=(255, 255, 255), outline=(20, 20, 20), width=4)

    # Top browser/app chrome bar
    bar_h = 46
    dr.rounded_rectangle([x + 14, y + 14, x + w - 14, y + 14 + bar_h], radius=12, fill=(17, 21, 30))
    for idx, dot_col in enumerate([(239, 68, 68), (245, 158, 11), (16, 185, 129)]):
        cx = x + 34 + idx * 18
        cy = y + 14 + bar_h // 2
        dr.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=dot_col)
    dr.text(
        (x + 98, y + 25),
        tag,
        fill=accent,
        font=get_font(15, mono=True),
    )

    # Screenshot viewport
    shot_y0 = y + 14 + bar_h + 10
    shot_h = h - bar_h - 156
    fitted = ImageOps.fit(shot, (w - 28, max(80, shot_h)), method=Image.Resampling.LANCZOS, centering=(0.5, 0.2))
    canvas.paste(fitted, (x + 14, shot_y0))
    dr.rectangle([x + 14, shot_y0, x + w - 14, shot_y0 + fitted.height], outline=(22, 26, 36), width=2)

    # Bottom editorial caption strip
    foot_y = shot_y0 + fitted.height + 14
    dr.rounded_rectangle([x + 14, foot_y, x + w - 14, y + h - 14], radius=14, fill=(16, 20, 29))
    dr.text((x + 30, foot_y + 14), title, fill=(247, 247, 242), font=get_font(24, bold=True))
    dr.text((x + 30, foot_y + 48), subtitle, fill=accent, font=get_font(15, mono=True))


def generate_garments() -> None:
    ws_shot = load_real_screenshot("workspace-near.png", 1280, 800)
    enclave_shot = load_real_screenshot("enclave-guard.png", 1280, 800)
    ocelli_shot = load_real_screenshot("ocelli-desktop.png", 1280, 800)
    studio_shot = load_real_screenshot("motion-studio.png", 1280, 800)
    mobile_shot = load_real_screenshot("ocelli-mobile.png", 600, 900)

    # 1. Hero Plate: garment-cobalt-overshirt.jpg (800x960)
    bg = draw_studio_backdrop(800, 960, (244, 239, 230), (222, 215, 202), (255, 252, 245))
    draw_window_card(
        bg,
        ws_shot,
        x=52,
        y=56,
        w=696,
        h=848,
        tag="AGENTES NEAR v2.0 · #near-intents-arena",
        title="Slack for Teams + AI Agents",
        subtitle="LIVE NEAR INTENTS · OUTLAYER TDX · ML-DSA-65",
        accent=(0, 236, 151),
    )
    add_film_grain(bg, 101, 6.5).save(PHOTOS_DIR / "garment-cobalt-overshirt.jpg", quality=93)

    # 2. 5 Product Lookbook Plates on signature paper backdrops (720x960)
    looks = [
        (
            "look-1-butter.jpg",
            (243, 211, 107),
            (224, 186, 74),
            ws_shot,
            "01 · #NEAR-INTENTS-ARENA",
            "1Click Multi-Solver Swap",
            "12 USDC -> 3.40 wNEAR · SETTLED IN 22S",
            (0, 236, 151),
        ),
        (
            "look-2-cream.jpg",
            (244, 239, 230),
            (220, 212, 198),
            enclave_shot,
            "02 · OUTLAYER INTEL TDX",
            "Hardware Enclave Spend Cap",
            "$25/TX GUARD · $45 ROGUE DRAIN BLOCKED",
            (90, 168, 255),
        ),
        (
            "look-3-terracotta.jpg",
            (217, 107, 67),
            (176, 74, 42),
            ws_shot,
            "03 · TERRACE + HUNCH MARKET",
            "In-Chat Conviction Betting",
            "BACK / FADE IN wNEAR · $AGENTES BURN",
            (243, 211, 107),
        ),
        (
            "look-4-sage.jpg",
            (148, 180, 159),
            (108, 144, 122),
            ocelli_shot,
            "04 · CORPUS X402 + KYVERA PQ",
            "H100 TEE Compute & Audit",
            "$1.84/HR H100 · FIPS 204 ML-DSA-65 SIGNED",
            (0, 236, 151),
        ),
        (
            "look-5-greyblue.jpg",
            (138, 158, 181),
            (98, 118, 144),
            studio_shot if studio_shot else mobile_shot,
            "05 · AGENT MOTION STUDIO",
            "7 Choreographed Acts @ 60fps",
            "LIVE AT /OCELLI · 1080P REMOTION + FFMPEG",
            (255, 112, 166),
        ),
    ]
    for idx, (fname, top_c, bot_c, shot, tag, title, sub, acc) in enumerate(looks, start=1):
        img = draw_studio_backdrop(720, 960, top_c, bot_c)
        draw_window_card(
            img,
            shot,
            x=44,
            y=58,
            w=632,
            h=844,
            tag=tag,
            title=title,
            subtitle=sub,
            accent=acc,
        )
        add_film_grain(img, 200 + idx, 7.0).save(PHOTOS_DIR / fname, quality=93)


def draw_agent_crest(
    dr: ImageDraw.ImageDraw,
    cx: int,
    cy: int,
    r: int,
    kind: str,
    accent: tuple[int, int, int],
    ink: tuple[int, int, int] = (244, 246, 251),
) -> None:
    # Outer precision ring
    dr.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(17, 21, 30), outline=accent, width=5)
    dr.ellipse([cx - int(r * 0.82), cy - int(r * 0.82), cx + int(r * 0.82), cy + int(r * 0.82)], outline=(50, 60, 82), width=2)

    if kind == "ada":
        # Neural star / 6-node mesh
        pts = []
        for k in range(6):
            ang = k * math.pi / 3.0 - math.pi / 2.0
            px = cx + int(math.cos(ang) * r * 0.54)
            py = cy + int(math.sin(ang) * r * 0.54)
            pts.append((px, py))
            dr.line([(cx, cy), (px, py)], fill=accent, width=4)
        dr.polygon(pts, outline=ink, width=3)
        for px, py in pts:
            dr.ellipse([px - 8, py - 8, px + 8, py + 8], fill=accent, outline=ink, width=2)
        dr.ellipse([cx - 16, cy - 16, cx + 16, cy + 16], fill=ink, outline=accent, width=4)
    elif kind == "kronos":
        # Hexagonal TDX hardware enclave shield
        pts = [
            (cx, cy - int(r * 0.58)),
            (cx + int(r * 0.50), cy - int(r * 0.28)),
            (cx + int(r * 0.50), cy + int(r * 0.24)),
            (cx, cy + int(r * 0.60)),
            (cx - int(r * 0.50), cy + int(r * 0.24)),
            (cx - int(r * 0.50), cy - int(r * 0.28)),
        ]
        dr.polygon(pts, fill=(24, 34, 46), outline=accent, width=5)
        dr.rounded_rectangle([cx - 24, cy - 18, cx + 24, cy + 28], radius=8, fill=accent)
        dr.arc([cx - 16, cy - 38, cx + 16, cy - 4], 180, 360, fill=ink, width=5)
    elif kind == "theo":
        # 1Click multi-solver routing arrows
        for dy, col in [(-28, accent), (0, ink), (28, accent)]:
            dr.line([(cx - int(r * 0.48), cy + dy), (cx + int(r * 0.44), cy + dy)], fill=col, width=6)
            dr.polygon(
                [
                    (cx + int(r * 0.52), cy + dy),
                    (cx + int(r * 0.34), cy + dy - 11),
                    (cx + int(r * 0.34), cy + dy + 11),
                ],
                fill=col,
            )
    elif kind == "lia":
        # Conviction market pulse bars
        bars = [-48, -24, 0, 24, 48]
        heights = [34, 62, 88, 54, 76]
        for bx, bh in zip(bars, heights):
            dr.rounded_rectangle(
                [cx + bx - 8, cy - bh // 2, cx + bx + 8, cy + bh // 2],
                radius=5,
                fill=accent if bh > 60 else ink,
            )
    elif kind == "mira":
        # H100 tensor core 3x3 grid
        for gx in (-1, 0, 1):
            for gy in (-1, 0, 1):
                bx = cx + gx * 34
                by = cy + gy * 34
                col = accent if (gx + gy) % 2 == 0 else ink
                dr.rounded_rectangle([bx - 11, by - 11, bx + 11, by + 11], radius=4, fill=col)
    else:
        # Kyvera ML-DSA-65 lattice diamond
        for scale, col in [(0.56, accent), (0.36, ink), (0.18, accent)]:
            d = int(r * scale)
            dr.polygon([(cx, cy - d), (cx + d, cy), (cx, cy + d), (cx - d, cy)], outline=col, width=4)


def generate_models_and_avatars() -> None:
    ws_shot = load_real_screenshot("workspace-near.png", 640, 360)
    enclave_shot = load_real_screenshot("enclave-guard.png", 640, 360)

    agents = [
        ("model-1.jpg", "ada", "@ada", "LEAD ORCHESTRATOR", "DEEPSEEK-V4.1 · TEE", (46, 75, 255), (236, 232, 222), ws_shot),
        ("model-2.jpg", "kronos", "@kronos", "OUTLAYER TDX GUARD", "$25/TX ENCLAVE CAP", (0, 236, 151), (222, 232, 238), enclave_shot),
        ("model-3.jpg", "theo", "@theo", "1CLICK ROUTER", "SOLVER QUOTES · 22S", (242, 176, 30), (242, 232, 214), ws_shot),
        ("model-4.jpg", "lia", "@lia", "TERRACE ORACLE", "wNEAR CONVICTION", (216, 27, 120), (238, 224, 232), ws_shot),
        ("model-5.jpg", "mira", "@mira", "CORPUS X402 GPU", "H100 TEE · $1.84/HR", (91, 63, 214), (228, 224, 240), enclave_shot),
        ("model-6.jpg", "zen", "@zen", "KYVERA PQ SIGNER", "FIPS 204 ML-DSA-65", (240, 90, 40), (240, 228, 218), enclave_shot),
    ]

    for idx, (fname, kind, handle, role, badge, accent, bg_c, shot) in enumerate(agents, start=1):
        img = draw_studio_backdrop(540, 660, bg_c, (bg_c[0] - 22, bg_c[1] - 22, bg_c[2] - 22))
        dr = ImageDraw.Draw(img)

        # Studio card container
        dr.rounded_rectangle([28, 28, 512, 632], radius=28, fill=(15, 19, 28), outline=(20, 20, 20), width=4)

        # Top status pill
        dr.rounded_rectangle([54, 52, 486, 96], radius=12, fill=(24, 30, 44))
        dr.ellipse([72, 67, 86, 81], fill=accent)
        dr.text((98, 63), badge, fill=accent, font=get_font(16, mono=True))

        # Geometric Agent Crest in center
        draw_agent_crest(dr, 270, 245, 112, kind, accent)

        # Mini live screenshot strip inside card
        strip = ImageOps.fit(shot, (432, 124), method=Image.Resampling.LANCZOS)
        img.paste(strip, (54, 386))
        dr.rectangle([54, 386, 486, 510], outline=accent, width=2)

        # Agent handle + role footer
        dr.text((54, 526), handle, fill=(247, 247, 242), font=get_font(40, bold=True))
        dr.text((54, 578), role, fill=accent, font=get_font(17, mono=True))

        add_film_grain(img, 300 + idx, 6.0).save(PHOTOS_DIR / fname, quality=93)

    # Avatar 1: Harry Phan (@harry.near) Monogram Badge
    sam = draw_studio_backdrop(320, 320, (216, 27, 120), (162, 16, 88))
    dr = ImageDraw.Draw(sam)
    dr.ellipse([22, 22, 298, 298], fill=(17, 17, 17), outline=(247, 247, 242), width=6)
    dr.ellipse([42, 42, 278, 278], outline=(216, 27, 120), width=4)
    dr.text((82, 98), "HP", fill=(247, 247, 242), font=get_font(108, bold=True))
    add_film_grain(sam, 391, 5.0).save(PHOTOS_DIR / "avatar-sam.jpg", quality=93)

    # Avatar 2: @ada AI Core Emblem
    rep = draw_studio_backdrop(320, 320, (61, 163, 93), (38, 118, 64))
    dr = ImageDraw.Draw(rep)
    draw_agent_crest(dr, 160, 160, 132, "ada", (0, 236, 151))
    add_film_grain(rep, 392, 5.0).save(PHOTOS_DIR / "avatar-reply.jpg", quality=93)


def generate_cutline_thumbs() -> None:
    ws_shot = load_real_screenshot("workspace-near.png", 1280, 800)
    enclave_shot = load_real_screenshot("enclave-guard.png", 1280, 800)
    ocelli_shot = load_real_screenshot("ocelli-desktop.png", 1280, 800)
    studio_shot = load_real_screenshot("motion-studio.png", 1280, 800)

    # 1. thumb-pier.jpg (960x540): Master Workspace Monitor Plate
    pier = draw_studio_backdrop(960, 540, (22, 35, 63), (14, 21, 38))
    fitted_ws = ImageOps.fit(ws_shot, (912, 444), method=Image.Resampling.LANCZOS, centering=(0.5, 0.2))
    pier.paste(fitted_ws, (24, 72))
    dr = ImageDraw.Draw(pier)
    dr.rectangle([24, 20, 936, 64], fill=(242, 176, 30))
    dr.text((42, 30), "AGENTES NEAR 2.0 · LIVE WORKSPACE + 1CLICK MULTI-SOLVER", fill=(22, 35, 63), font=get_font(20, bold=True))
    dr.rectangle([24, 72, 936, 516], outline=(242, 238, 229), width=4)
    add_film_grain(pier, 401, 5.5).save(PHOTOS_DIR / "thumb-pier.jpg", quality=93)

    # 2. thumb-skyline.jpg (640x360)
    sky = ImageOps.fit(ws_shot, (640, 360), method=Image.Resampling.LANCZOS, centering=(0.2, 0.2))
    dr = ImageDraw.Draw(sky)
    dr.rectangle([0, 304, 640, 360], fill=(22, 35, 63))
    dr.text((20, 320), "01 · #NEAR-INTENTS-ARENA · 1CLICK SWAP", fill=(242, 176, 30), font=get_font(18, bold=True))
    add_film_grain(sky, 402, 5.5).save(PHOTOS_DIR / "thumb-skyline.jpg", quality=93)

    # 3. thumb-skate.jpg (640x360)
    skate = ImageOps.fit(enclave_shot, (640, 360), method=Image.Resampling.LANCZOS, centering=(0.5, 0.3))
    dr = ImageDraw.Draw(skate)
    dr.rectangle([0, 304, 640, 360], fill=(194, 24, 91))
    dr.text((20, 320), "02 · OUTLAYER INTEL TDX · $25/TX GUARD", fill=(242, 238, 229), font=get_font(18, bold=True))
    add_film_grain(skate, 403, 5.5).save(PHOTOS_DIR / "thumb-skate.jpg", quality=93)

    # 4. thumb-cooking.jpg (640x360)
    cook = ImageOps.fit(studio_shot if studio_shot else ocelli_shot, (640, 360), method=Image.Resampling.LANCZOS, centering=(0.5, 0.25))
    dr = ImageDraw.Draw(cook)
    dr.rectangle([0, 304, 640, 360], fill=(20, 24, 34))
    dr.text((20, 320), "03 · KYVERA ML-DSA-65 · PQ AUDIT LEDGER", fill=(0, 236, 151), font=get_font(18, bold=True))
    add_film_grain(cook, 404, 5.5).save(PHOTOS_DIR / "thumb-cooking.jpg", quality=93)


def generate_molote_assets() -> None:
    # 1. Transparent PNG OutLayer Intel TDX Hardware Enclave Vault & NEAR AI Core cutout
    sp = Image.new("RGBA", (720, 720), (0, 0, 0, 0))
    dr = ImageDraw.Draw(sp)
    # Soft floor shadow
    dr.ellipse([145, 590, 575, 656], fill=(0, 0, 0, 95))
    sp = sp.filter(ImageFilter.GaussianBlur(10))
    dr = ImageDraw.Draw(sp)

    # White die-cut sticker outline for stop-motion collage pop
    dr.rounded_rectangle([146, 86, 574, 624], radius=88, fill=(246, 240, 226, 255), outline=(20, 20, 20, 255), width=6)

    # Outer industrial anodized TDX Enclave Vault shell
    dr.rounded_rectangle([166, 106, 554, 604], radius=72, fill=(22, 26, 34, 255), outline=(58, 66, 82, 255), width=6)

    # Top security telemetry crown
    dr.rounded_rectangle([186, 120, 534, 196], radius=44, fill=(34, 40, 52, 255), outline=(0, 236, 151, 255), width=3)
    dr.ellipse([212, 144, 240, 172], fill=(0, 236, 151, 255))
    dr.text((256, 144), "OUTLAYER TDX VAULT", fill=(246, 240, 226, 255), font=get_font(22, bold=True))

    # Central circular hardware enclave core +emerald/orange ring
    cx, cy = 360, 355
    dr.ellipse([cx - 126, cy - 126, cx + 126, cy + 126], fill=(14, 17, 23, 255), outline=(240, 90, 40, 255), width=8)
    dr.ellipse([cx - 98, cy - 98, cx + 98, cy + 98], fill=(20, 26, 36, 255), outline=(0, 236, 151, 255), width=5)
    # Hexagonal shield inside core
    pts = [
        (cx, cy - 64),
        (cx + 56, cy - 32),
        (cx + 56, cy + 32),
        (cx, cy + 64),
        (cx - 56, cy + 32),
        (cx - 56, cy - 32),
    ]
    dr.polygon(pts, fill=(28, 38, 52, 255), outline=(0, 236, 151, 255), width=4)
    dr.text((cx - 48, cy - 16), "$25 CAP", fill=(246, 240, 226, 255), font=get_font(24, bold=True))

    # Bottom hardware LED spend guard meter
    dr.rounded_rectangle([206, 506, 514, 568], radius=16, fill=(14, 17, 23, 255), outline=(60, 70, 88, 255), width=3)
    for idx in range(8):
        lx = 224 + idx * 35
        col = (0, 236, 151, 255) if idx < 6 else (240, 90, 40, 255)
        dr.rounded_rectangle([lx, 522, lx + 24, 552], radius=5, fill=col)

    # Side tactile NEP-413 hardware key tag
    dr.rounded_rectangle([546, 250, 594, 356], radius=12, fill=(59, 165, 92, 255), outline=(20, 20, 20, 255), width=5)
    sp.save(PHOTOS_DIR / "speaker-cutout.png")

    # 2. friends-photo.jpg (840x640): Live Agentes NEAR Workspace + Enclave Guard Polaroid Composite
    ws_shot = load_real_screenshot("workspace-near.png", 840, 540)
    enclave_shot = load_real_screenshot("enclave-guard.png", 360, 240)
    fr = ImageOps.fit(ws_shot, (840, 640), method=Image.Resampling.LANCZOS, centering=(0.5, 0.2))
    dr = ImageDraw.Draw(fr)
    # Inset floating enclave card in bottom-right
    dr.rounded_rectangle([446, 346, 816, 616], radius=18, fill=(246, 240, 226), outline=(20, 20, 20), width=5)
    inset = ImageOps.fit(enclave_shot, (346, 210), method=Image.Resampling.LANCZOS)
    fr.paste(inset, (458, 358))
    dr.text((466, 578), "OUTLAYER TDX · ZERO KEY LEAKS", fill=(20, 20, 20), font=get_font(18, bold=True))

    # Top banner badge
    dr.rectangle([0, 0, 840, 54], fill=(20, 20, 20))
    dr.text((24, 14), "AGENTES NEAR · SELF-HOSTED SLACK FOR TEAMS & AI SWARMS", fill=(0, 236, 151), font=get_font(20, bold=True))
    add_film_grain(fr, 505, 6.5).save(PHOTOS_DIR / "friends-photo.jpg", quality=93)


def main() -> None:
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    generate_garments()
    generate_models_and_avatars()
    generate_cutline_thumbs()
    generate_molote_assets()
    files = sorted(p.name for p in PHOTOS_DIR.iterdir())
    print(f"[photos] Generated {len(files)} Agentes NEAR studio assets in {PHOTOS_DIR}: {', '.join(files)}")


if __name__ == "__main__":
    main()
