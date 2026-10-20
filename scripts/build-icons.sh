#!/usr/bin/env bash
# Regenerate every bundled app icon from the SVG sources in
# src-tauri/icons/source/. macOS only (iconutil), and it needs rsvg-convert and
# python3: `brew install librsvg`.
#
#   bash scripts/build-icons.sh            # into src-tauri/icons
#   bash scripts/build-icons.sh <dir>      # into <dir>, leaving the tree alone
#
# icon.svg is the 1024 master on the macOS icon grid. sizes/ holds the same
# mark drawn for each small pixel grid (16 to 48 px, written by
# scripts/fit-icon-sizes.py), which is what the small slots of the .icns and
# the .ico get. `tauri icon` would downsample the master into those slots
# instead, which is exactly what the fitted drawings exist to avoid.
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
fit() { # fit <drawing> <px> <out>: a sizes/ drawing, normally at the size it was drawn for
  [ -f "$src/sizes/icon-$1.svg" ] || { echo "build-icons: no sizes/icon-$1.svg (run scripts/fit-icon-sizes.py)" >&2; exit 1; }
  rsvg-convert -w "$2" -h "$2" "$src/sizes/icon-$1.svg" -o "$3"
}
# The master framed for Windows: no baked shadow (the macOS one reads as a
# smudge on Windows surfaces), and the 100 px margin cropped so the tile fills
# 93.75% of its canvas, as the fitted 30 and 32 px drawings do. Windows shell
# icons fill their slot; on the macOS framing the tile drew about a tenth
# smaller than its neighbours in Explorer, on the desktop and in the taskbar.
sed -e '/<path id="shadow"/d' -e 's/viewBox="0 0 1024 1024"/viewBox="72.5 72.5 879 879"/' "$src/icon.svg" > "$work/icon-win.svg"
grep -q 'viewBox="72.5 72.5 879 879"' "$work/icon-win.svg" || { echo "build-icons: icon.svg has no 1024 viewBox" >&2; exit 1; }
! grep -q 'url(#shadow)' "$work/icon-win.svg" || { echo "build-icons: icon.svg's shadow is not its own <path id=\"shadow\"> line" >&2; exit 1; }
win() { rsvg-convert -w "$1" -h "$1" "$work/icon-win.svg" -o "$2"; }

# macOS: the .icns, from an .iconset with a fitted drawing in the small slot.
# Only the 2x small slots: macOS 26 sets a 1x 16 or 32 px representation in a
# legacy .icns on a grey plate, whichever drawing is in it, and leaves the 2x
# ones alone. Without the 1x slots a 2x screen draws 16 pt from the fitted
# drawing (16@2x) and 32 pt from the master (32@2x); a 1x screen scales the
# master down for both — softer at 16 px, but never on the plate. 16@2x is the
# 32 px drawing on the macOS proportions (mac-32), not the Windows one.
set_dir="$work/icon.iconset"
mkdir -p "$set_dir"
fit mac-32 32 "$set_dir/icon_16x16@2x.png"
big 64 "$set_dir/icon_32x32@2x.png"
big 128 "$set_dir/icon_128x128.png"
big 256 "$set_dir/icon_128x128@2x.png"
big 256 "$set_dir/icon_256x256.png"
big 512 "$set_dir/icon_256x256@2x.png"
big 512 "$set_dir/icon_512x512.png"
big 1024 "$set_dir/icon_512x512@2x.png"
iconutil -c icns "$set_dir" -o "$icons/icon.icns"

# The PNGs tauri.conf.json bundles, and the master.
fit 32 32 "$icons/32x32.png"
big 64 "$icons/64x64.png"
big 128 "$icons/128x128.png"
big 256 "$icons/128x128@2x.png"
big 1024 "$icons/icon.png"

# Windows: the .ico (a fitted drawing for every size up to 48, the Windows
# framing of the master above), and the Store tiles. 20, 30, 36 and 40 are
# what a title bar, the taskbar and Start pins draw at 125% and 150%; without
# them Windows shrinks the next entry up and loses the fitting. Every entry
# PNG-compressed (Vista and later read that), so the 256px entry is kilobytes
# rather than ImageMagick's uncompressed bitmap of several hundred.
for size in 16 20 24 30 32 36 40 48; do fit "$size" "$size" "$work/ico-$size.png"; done
for size in 64 256; do win "$size" "$work/ico-$size.png"; done
python3 -I - "$icons/icon.ico" "$work"/ico-{16,20,24,30,32,36,40,48,64,256}.png <<'PY'
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
fit 30 30 "$icons/Square30x30Logo.png"
fit 48 44 "$icons/Square44x44Logo.png"
for size in 71 89 107 142 150 284 310; do win "$size" "$icons/Square${size}x${size}Logo.png"; done
win 50 "$icons/StoreLogo.png"

echo "build-icons: wrote $(ls "$icons" | grep -c '\.\(png\|icns\|ico\)$') files to $icons"
