#!/usr/bin/env python3
"""
generate_flyover_plates.py
Generate high-DPI flyover PNG code plates for ActLandingFlyover3D.
Tiles are RGBA with rounded corners and Pillow rendering.
"""
from PIL import Image, ImageDraw, ImageFont
import os, sys

OUT = os.path.join(os.path.dirname(__file__), "../public/flyover")
os.makedirs(OUT, exist_ok=True)

SCALE = 2  # 2x high-DPI

def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def hex_rgba(h, a=255):
    return hex_rgb(h) + (a,)

def load_font(size):
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSText.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    for c in candidates:
        try:
            return ImageFont.truetype(c, size)
        except:
            pass
    return ImageFont.load_default()

def make_plate(name, w, h, bg, accent, lines, radius=28):
    sw, sh = w * SCALE, h * SCALE
    img = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background with rounded corners via mask
    bg_layer = Image.new("RGBA", (sw, sh), hex_rgba(bg))
    mask = Image.new("L", (sw, sh), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, sw - 1, sh - 1], radius=radius * SCALE, fill=255)
    img.paste(bg_layer, mask=mask)

    draw = ImageDraw.Draw(img)

    # Subtle border glow (1.5px equivalent)
    for t, a in [(6, 40), (4, 60), (2, 100)]:
        col = hex_rgb(accent)
        draw.rounded_rectangle(
            [t, t, sw - 1 - t, sh - 1 - t],
            radius=max(0, radius * SCALE - t),
            outline=col + (a,),
            width=2,
        )

    # Accent top bar
    draw.rounded_rectangle(
        [0, 0, sw, 16],
        radius=radius * SCALE,
        fill=hex_rgba(accent, 180),
    )
    draw.rectangle([0, 8, sw, 16], fill=hex_rgba(accent, 180))

    # Text labels
    main_line = lines[0]
    sub_line  = lines[1] if len(lines) > 1 else None

    max_chars = max(len(l) for l in lines)
    main_size = max(20, min(52, (sw - 32) // max(max_chars, 1))) if max_chars else 48
    sub_size  = max(16, main_size // 2)

    main_font = load_font(main_size)
    sub_font  = load_font(sub_size)

    # Measure and center
    bbox1 = draw.textbbox((0, 0), main_line, font=main_font)
    tw1   = bbox1[2] - bbox1[0]
    th1   = bbox1[3] - bbox1[1]

    total_h = th1 + (sub_size + 8 if sub_line else 0)
    y0 = (sh - total_h) // 2 + 8

    draw.text(((sw - tw1) // 2, y0), main_line, fill=(255, 255, 255, 230), font=main_font)

    if sub_line:
        bbox2 = draw.textbbox((0, 0), sub_line, font=sub_font)
        tw2   = bbox2[2] - bbox2[0]
        draw.text(
            ((sw - tw2) // 2, y0 + th1 + 8),
            sub_line,
            fill=hex_rgba(accent, 180),
            font=sub_font,
        )

    out_path = os.path.join(OUT, f"{name}.png")
    img.save(out_path, "PNG")
    print(f"  Saved: {out_path}  ({sw}x{sh})")
    return out_path


plates = [
    ("hero-window",   760, 440, "#0d1a2e", "#00EC97", ["Agentes NEAR", "Slack for Teams + AI"]),
    ("chip-1click",   280, 160, "#0d2a1f", "#00EC97", ["1Click · 358.13 wNEAR", "+16 bps yield"]),
    ("chip-tdx",      260, 150, "#1a1200", "#F59E0B", ["OutLayer TDX", "$25/tx Cap enforced"]),
    ("card-3col",     500, 280, "#0a1520", "#38BDF8", ["3-Col Ocelli Workspace", "6 Autonomous Agents"]),
    ("card-outlayer", 300, 180, "#120d00", "#F59E0B", ["OutLayer Intel", "TDX Enclave verified"]),
    ("card-winner",   320, 190, "#1a0010", "#EC4899", ["13 NEAR Tracks", "MIT License"]),
    ("card-enclave",  300, 180, "#0d1a2e", "#38BDF8", ["Corpus x402", "H100 TEE $1.84/hr"]),
    ("logo-tile",     180, 180, "#05060a", "#00EC97", ["NEAR", "Protocol"]),
]

print(f"Generating {len(plates)} flyover tiles to {OUT}:")
for name, w, h, bg, accent, lines in plates:
    make_plate(name, w, h, bg, accent, lines)

# page-full.png: simulated full landing page vertical strip (1200x3600)
print("Generating page-full.png...")
pw, ph = 1200 * SCALE, 3600 * SCALE
page = Image.new("RGBA", (pw, ph), hex_rgba("#f9fbfb"))
draw = ImageDraw.Draw(page)

# Navbar
nav_h = 56 * SCALE
draw.rectangle([0, 0, pw, nav_h], fill=hex_rgba("#f9fbfb"))
draw.rectangle([0, nav_h - 2, pw, nav_h], fill=hex_rgba("#e8eaef"))
# Logo bar
draw.rounded_rectangle([64, 18 * SCALE, 220, 38 * SCALE], radius=6 * SCALE, fill=hex_rgba("#0d1a2e"))

# Badge
badge_x, badge_y = 128, nav_h + 48 * SCALE
draw.rounded_rectangle([badge_x, badge_y, badge_x + 400, badge_y + 36], radius=18, fill=hex_rgba("#00EC97", 32))
draw.rounded_rectangle([badge_x, badge_y, badge_x + 400, badge_y + 36], radius=18, outline=hex_rgba("#00EC97", 64), width=2)

main_font_lg = load_font(96)
main_font_md = load_font(60)
sub_font_sm  = load_font(32)

# Hero heading
hx, hy = 128, badge_y + 60
draw.text((hx, hy), "Slack for Teams", fill=hex_rgba("#0d1a2e"), font=main_font_lg)
draw.text((hx, hy + 110), "+ NEAR AI Agents", fill=hex_rgba("#00EC97"), font=main_font_lg)

# Subtitle
draw.text((hx, hy + 240), "Self-hosted workspace — 6 AI agents + human team", fill=hex_rgba("#6b7a9a"), font=sub_font_sm)

# Stats strip
stats_y = hy + 340
for i, (v, u, c) in enumerate([("358.13", "wNEAR settled", "#00EC97"), ("$25/tx", "TDX spend cap", "#F59E0B"), ("13/13", "NEAR tracks", "#38BDF8")]):
    sx = hx + i * 380
    draw.rounded_rectangle([sx, stats_y, sx + 350, stats_y + 150], radius=32, fill=hex_rgba("#f0f2f6"))
    draw.text((sx + 24, stats_y + 24), v, fill=hex_rgba(c), font=load_font(56))
    draw.text((sx + 24, stats_y + 94), u, fill=hex_rgba("#6b7a9a"), font=sub_font_sm)

# Agent chips
chips_y = stats_y + 200
for i, ag in enumerate(["@ada · Intents", "@theo · Analytics", "@lia · Content", "@kronos · Scheduler", "@nova · Research", "@rex · Security"]):
    cx = hx + (i % 3) * 480
    cy = chips_y + (i // 3) * 80
    cw = 440
    draw.rounded_rectangle([cx, cy, cx + cw, cy + 60], radius=30, fill=hex_rgba("#00EC97", 32))
    draw.rounded_rectangle([cx, cy, cx + cw, cy + 60], radius=30, outline=hex_rgba("#00EC97", 64), width=2)
    draw.text((cx + 20, cy + 14), ag, fill=hex_rgba("#00EC97"), font=load_font(28))

page_path = os.path.join(OUT, "page-full.png")
page.save(page_path, "PNG")
print(f"  Saved: {page_path}  ({pw}x{ph})")

print(f"\nAll flyover assets generated in: {OUT}")
print(f"Total files: {len(plates) + 1}")
