#!/bin/sh
# Renders what the agents' desktops show (apps/server/runner/desktop-look.ts):
#   desktop-wallpaper.png  wall.ts bundled with the sky engine, one headless Chromium screenshot of wall.html at
#                          1280×900 (DESKTOP_SIZE), scale 1, sRGB
#   desktop-mark.png       the favicon (apps/web/public/favicon.svg) at 32 px, the dock's icon size
# into apps/server/runner/assets/, each with its base64 text (`.png.b64`), which the runner embeds. Needs bun,
# chromium (CHROMIUM=path) and rsvg-convert (librsvg2-bin). Two runs give byte-identical images.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
assets="$repo/apps/server/runner/assets"
out="$here/out"
mkdir -p "$out"
"${BUN:-bun}" build "$here/wall.ts" --outfile "$out/wall.js" --format iife --target browser >/dev/null
rm -rf "$out/profile" "$assets/desktop-wallpaper.png"
"${CHROMIUM:-chromium}" --headless --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --force-color-profile=srgb --allow-file-access-from-files --window-size=1280,900 --virtual-time-budget=5000 \
  --user-data-dir="$out/profile" --screenshot="$assets/desktop-wallpaper.png" "file://$here/wall.html" >/dev/null 2>&1
[ -s "$assets/desktop-wallpaper.png" ] || { echo "no wallpaper" >&2; exit 1; }
rm -rf "$out/profile"
rsvg-convert -w 32 -h 32 "$repo/apps/web/public/favicon.svg" -o "$assets/desktop-mark.png"
for png in "$assets/desktop-wallpaper.png" "$assets/desktop-mark.png"; do base64 < "$png" | tr -d '\n' > "$png.b64"; done
