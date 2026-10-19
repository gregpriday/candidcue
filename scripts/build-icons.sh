#!/usr/bin/env bash
# Regenerate every bundled app icon from the two SVG sources in
# src-tauri/icons/source/. macOS only (iconutil), and it needs rsvg-convert and
# python3: `brew install librsvg`.
#
#   bash scripts/build-icons.sh            # into src-tauri/icons
#   bash scripts/build-icons.sh <dir>      # into <dir>, leaving the tree alone
#
# icon.svg is the 1024 master on the macOS icon grid; icon-small.svg is the
# same mark redrawn for 16 and 32 px, which is what the small slots of the .icns
# and the .ico get. `tauri icon` would downsample the master into those slots
# instead, which is exactly what the small drawing exists to avoid.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/src-tauri/icons/source"
icons="${1:-$root/src-tauri/icons}"
mkdir -p "$icons"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for tool in rsvg-convert python3 iconutil; do
  command -v "$tool" >/dev/null || { echo "build-icons: $tool is required" >&2; exit 1; }
done

big() { rsvg-convert -w "$1" -h "$1" "$src/icon.svg" -o "$2"; }
small() { rsvg-convert -w "$1" -h "$1" "$src/icon-small.svg" -o "$2"; }
# The master framed for Windows: the macOS grid's 100px margin cropped to the
# small drawing's, so every .ico entry fills its canvas by the same share
# (87.5%) and Explorer does not shrink the tile as the view grows.
sed 's/viewBox="0 0 1024 1024"/viewBox="41 41 942 942"/' "$src/icon.svg" > "$work/icon-wide.svg"
grep -q 'viewBox="41 41 942 942"' "$work/icon-wide.svg" || { echo "build-icons: icon.svg has no 1024 viewBox" >&2; exit 1; }
wide() { rsvg-convert -w "$1" -h "$1" "$work/icon-wide.svg" -o "$2"; }

# macOS: the .icns, from an .iconset with the small drawing in the small slots.
# Only the 2x small slots: macOS 26 sets a 1x 16 or 32 px representation in a
# legacy .icns on a grey plate, whichever drawing is in it, and leaves the 2x
# ones alone. Without the 1x slots a 2x screen draws 16 pt from the small
# drawing (16@2x) and 32 pt from the master (32@2x); a 1x screen scales the
# master down for both — softer at 16 px, but never on the plate.
set_dir="$work/icon.iconset"
mkdir -p "$set_dir"
small 32 "$set_dir/icon_16x16@2x.png"
big 64 "$set_dir/icon_32x32@2x.png"
big 128 "$set_dir/icon_128x128.png"
big 256 "$set_dir/icon_128x128@2x.png"
big 256 "$set_dir/icon_256x256.png"
big 512 "$set_dir/icon_256x256@2x.png"
big 512 "$set_dir/icon_512x512.png"
big 1024 "$set_dir/icon_512x512@2x.png"
iconutil -c icns "$set_dir" -o "$icons/icon.icns"

# The PNGs tauri.conf.json bundles, and the master.
small 32 "$icons/32x32.png"
big 64 "$icons/64x64.png"
big 128 "$icons/128x128.png"
big 256 "$icons/128x128@2x.png"
big 1024 "$icons/icon.png"

# Windows: the .ico (small drawing at 16-32, the framed master above), and the
# Store tiles. Every entry PNG-compressed (Vista and later read that), so the
# 256px entry is kilobytes rather than ImageMagick's uncompressed bitmap of
# several hundred.
for size in 16 24 32; do small "$size" "$work/ico-$size.png"; done
for size in 48 64 256; do wide "$size" "$work/ico-$size.png"; done
python3 -I - "$icons/icon.ico" "$work"/ico-{16,24,32,48,64,256}.png <<'PY'
import struct, sys
out, pngs = sys.argv[1], sys.argv[2:]
blobs = [open(p, 'rb').read() for p in pngs]
offset = 6 + 16 * len(blobs)
head = struct.pack('<HHH', 0, 1, len(blobs))
entries = b''
for blob in blobs:
    w, h = struct.unpack('>II', blob[16:24])
    entries += struct.pack('<BBBBHHII', w % 256, h % 256, 0, 0, 1, 32, len(blob), offset)
    offset += len(blob)
open(out, 'wb').write(head + entries + b''.join(blobs))
PY
for size in 30 44 71 89 107 142 150 284 310; do
  if [ "$size" -le 44 ]; then small "$size" "$icons/Square${size}x${size}Logo.png"
  else big "$size" "$icons/Square${size}x${size}Logo.png"; fi
done
big 50 "$icons/StoreLogo.png"

echo "build-icons: wrote $(ls "$icons" | grep -c '\.\(png\|icns\|ico\)$') files to $icons"
