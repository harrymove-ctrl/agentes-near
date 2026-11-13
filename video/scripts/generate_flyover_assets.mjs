/**
 * generate_flyover_assets.mjs
 * Generates high-DPI flyover PNG captures for ActLandingFlyover3D:
 *   - page-full.png  (full-length vertical strip, 1200x3600, deviceScaleFactor=2)
 *   - hero-window.png, chip-1click.png, chip-tdx.png, card-3col.png,
 *     card-outlayer.png, card-winner.png, card-enclave.png, logo-tile.png
 *     (transparent cropped plates via element selectors or region crops)
 *
 * Target: https://agentes-near-production.up.railway.app/ocelli
 * Falls back to Pillow-style code plates if the page is unavailable.
 *
 * Usage: node scripts/generate_flyover_assets.mjs
 */

import { chromium } from "@playwright/test";
import { createCanvas } from "canvas";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "../public/flyover");
const URL = "https://agentes-near-production.up.railway.app/ocelli";

fs.mkdirSync(OUT_DIR, { recursive: true });

async function tryPlaywright() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();

    console.log(`Navigating to ${URL}...`);
    await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);

    // Full page screenshot (vertical strip)
    const fullPath = path.join(OUT_DIR, "page-full.png");
    await page.screenshot({ path: fullPath, fullPage: true });
    console.log(`Saved: ${fullPath}`);

    // Crop individual data-layer tiles from the full page
    // These are approximate viewport regions — tuned to the /ocelli layout
    const crops = [
      { name: "hero-window",   clip: { x: 0,   y: 56,  width: 1200, height: 440 } },
      { name: "chip-1click",   clip: { x: 700, y: 56,  width: 500,  height: 180 } },
      { name: "chip-tdx",      clip: { x: 700, y: 220, width: 500,  height: 180 } },
      { name: "card-3col",     clip: { x: 0,   y: 480, width: 800,  height: 300 } },
      { name: "card-outlayer", clip: { x: 500, y: 480, width: 500,  height: 220 } },
      { name: "card-winner",   clip: { x: 0,   y: 56,  width: 400,  height: 220 } },
      { name: "card-enclave",  clip: { x: 400, y: 480, width: 400,  height: 200 } },
      { name: "logo-tile",     clip: { x: 0,   y: 0,   width: 200,  height: 56  } },
    ];

    for (const crop of crops) {
      const cropPath = path.join(OUT_DIR, `${crop.name}.png`);
      await page.screenshot({ path: cropPath, clip: crop.clip });
      console.log(`Saved: ${cropPath}`);
    }

    await browser.close();
    return true;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.warn("Playwright capture failed:", err.message);
    return false;
  }
}

function generateCodePlates() {
  // Fallback: generate rich code-plate PNGs using node-canvas
  // These are dark-themed UI mockup plates that match the tile specs
  console.log("Generating code-plate fallbacks with node-canvas...");

  const plates = [
    { name: "hero-window",   w: 760, h: 440, bg: "#0d1a2e", border: "#00EC9740", label: "Agentes NEAR\nSlack for Teams + AI",    accent: "#00EC97" },
    { name: "chip-1click",   w: 280, h: 160, bg: "#0d2a1f", border: "#00EC9770", label: "1Click\n358.13 wNEAR · +16 bps",        accent: "#00EC97" },
    { name: "chip-tdx",      w: 260, h: 150, bg: "#1a1200", border: "#F59E0B70", label: "OutLayer TDX\n$25/tx Cap",               accent: "#F59E0B" },
    { name: "card-3col",     w: 500, h: 280, bg: "#0a1520", border: "#38BDF870", label: "3-Col Ocelli Workspace\n6 Autonomous Agents", accent: "#38BDF8" },
    { name: "card-outlayer", w: 300, h: 180, bg: "#120d00", border: "#F59E0B50", label: "OutLayer Intel\nTDX Enclave",            accent: "#F59E0B" },
    { name: "card-winner",   w: 320, h: 190, bg: "#1a0010", border: "#EC489970", label: "13 NEAR Tracks\nMIT License",           accent: "#EC4899" },
    { name: "card-enclave",  w: 300, h: 180, bg: "#0d1a2e", border: "#38BDF870", label: "Corpus x402\nH100 TEE Enclave",         accent: "#38BDF8" },
    { name: "logo-tile",     w: 180, h: 180, bg: "#05060a", border: "#00EC9790", label: "NEAR\nProtocol",                        accent: "#00EC97" },
  ];

  // We'll write a minimal valid PNG header with a 1x1 pixel placeholder
  // since node-canvas may not be available; instead generate via Python
  const pySrc = `#!/usr/bin/env python3
"""Fallback: generate flyover PNG code plates with Pillow."""
from PIL import Image, ImageDraw, ImageFont
import os, math

OUT = "${OUT_DIR.replace(/\\/g, "/")}"
os.makedirs(OUT, exist_ok=True)

plates = [
    ("hero-window",   760, 440, "#0d1a2e", "#00EC97", "Agentes NEAR\\nSlack for Teams + AI"),
    ("chip-1click",   280, 160, "#0d2a1f", "#00EC97", "1Click · 358.13 wNEAR"),
    ("chip-tdx",      260, 150, "#1a1200", "#F59E0B", "OutLayer TDX · $25/tx"),
    ("card-3col",     500, 280, "#0a1520", "#38BDF8", "3-Col Ocelli Workspace\\n6 Agents"),
    ("card-outlayer", 300, 180, "#120d00", "#F59E0B", "OutLayer Intel\\nTDX Enclave"),
    ("card-winner",   320, 190, "#1a0010", "#EC4899", "13 NEAR Tracks\\nMIT License"),
    ("card-enclave",  300, 180, "#0d1a2e", "#38BDF8", "Corpus x402\\nH100 TEE"),
    ("logo-tile",     180, 180, "#05060a", "#00EC97", "NEAR\\nProtocol"),
]

def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

for name, w, h, bg, accent, label in plates:
    # Scale up 2x for high-DPI
    sw, sh = w * 2, h * 2
    img = Image.new("RGBA", (sw, sh), hex_to_rgb(bg) + (255,))
    draw = ImageDraw.Draw(img)
    # Border glow
    bcolor = hex_to_rgb(accent) + (80,)
    draw.rectangle([2, 2, sw-3, sh-3], outline=bcolor, width=4)
    # Accent top bar
    draw.rectangle([0, 0, sw, 8], fill=hex_to_rgb(accent) + (180,))
    # Label
    lines = label.split("\\n")
    font_size = max(24, min(48, sw // (max(len(l) for l in lines) + 2)))
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size)
        small_font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", font_size // 2)
    except:
        font = ImageFont.load_default()
        small_font = font
    y0 = sh // 2 - (len(lines) * (font_size + 8)) // 2
    for i, line in enumerate(lines):
        bbox = draw.textbbox((0, 0), line, font=font if i == 0 else small_font)
        tw = bbox[2] - bbox[0]
        draw.text(((sw - tw) // 2, y0 + i * (font_size + 8)), line,
                  fill=(255, 255, 255, 220 if i == 0 else 160),
                  font=font if i == 0 else small_font)
    # Corner radius simulation via masking
    mask = Image.new("L", (sw, sh), 0)
    md = ImageDraw.Draw(mask)
    radius = 28
    md.rounded_rectangle([0, 0, sw, sh], radius=radius, fill=255)
    img.putalpha(mask)
    out_path = os.path.join(OUT, f"{name}.png")
    img.save(out_path)
    print(f"Saved: {out_path}")

# page-full.png: full vertical strip 1200x3600
page = Image.new("RGBA", (2400, 7200), (249, 251, 251, 255))
draw = ImageDraw.Draw(page)
# Navbar
draw.rectangle([0, 0, 2400, 112], fill=(249, 251, 251, 255))
draw.rectangle([0, 110, 2400, 112], fill=(232, 234, 239, 255))
draw.rounded_rectangle([64, 36, 284, 72], radius=12, fill=(13, 26, 46, 255))
# Hero text placeholder
draw.text((128, 140), "Slack for Teams", fill=(13, 26, 46, 255))
draw.text((128, 240), "+ NEAR AI Agents", fill=(0, 236, 151, 255))
page.save(os.path.join(OUT, "page-full.png"))
print(f"Saved: {os.path.join(OUT, 'page-full.png')}")
print("All flyover plates generated.")
`;

  const pyPath = path.join(__dirname, "generate_flyover_plates.py");
  fs.writeFileSync(pyPath, pySrc);
  console.log(`Python fallback script written to: ${pyPath}`);
}

(async () => {
  const success = await tryPlaywright();
  if (!success) {
    generateCodePlates();
    // Run Python fallback
    const { execSync } = await import("child_process");
    try {
      execSync(`python3 ${path.join(__dirname, "generate_flyover_plates.py")}`, { stdio: "inherit" });
    } catch (e) {
      console.error("Python fallback also failed:", e.message);
      process.exit(1);
    }
  }
  console.log("Done! Flyover assets in:", OUT_DIR);
})();
