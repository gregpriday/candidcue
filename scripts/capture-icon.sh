#!/usr/bin/env bash
# Screenshots of the CandidCue app icon, for a design review. Opt-in: it does
# nothing unless DESIGN_CAPTURE_DIR names a directory to write into, and it
# never writes inside the repository. macOS only, like build-icons.sh, and it
# needs swiftc (Xcode or the Command Line Tools) on top of what that needs.
#
#   DESIGN_CAPTURE_DIR=/tmp/icon-shots bash scripts/capture-icon.sh
#
# The icon is built from its sources by build-icons.sh into a scratch
# directory, put in a throwaway .app, and drawn by macOS itself (NSWorkspace),
# so every picture is what Finder and the Dock show — the system's own edge
# treatment and its choice of representation at each size included — beside
# the real icons of apps installed on this Mac.
#
#   master.png      the 1024 artwork as it goes into the .icns
#   dock-dark.png   among real neighbours in a dark Dock, 64 pt at 2x
#   dock-light.png  the same in a light Dock
#   ladder.png      every size macOS draws, light and dark; the small sizes
#                   enlarged pixel for pixel at 1x and at 2x (what a Retina
#                   Finder list shows); and a greyscale squint row
#   windows.png     the .ico entries on dark and light taskbars, enlarged
#   sizes.png       every built size as it ships (the PNGs at 128/64/32 and
#                   the .ico's 48/30/24/20/16) at 1x on light and dark, then
#                   the 32 and 16 px drawings one pixel to a block
#   brandmark.png   the in-app mark (BrandMark.svelte) as Welcome draws it,
#                   in both themes
#
# Each picture is checked before it counts, and the run fails rather than
# leave a short or stale set behind.
set -euo pipefail

out="${DESIGN_CAPTURE_DIR:-}"
[ -n "$out" ] || { echo "capture-icon: set DESIGN_CAPTURE_DIR to run it" >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd)"
case "$(cd "$(dirname "$out")" 2>/dev/null && pwd)/" in
  "$root"/*) echo "capture-icon: DESIGN_CAPTURE_DIR must be outside the repository" >&2; exit 2 ;;
esac
for tool in magick swiftc rsvg-convert iconutil; do
  command -v "$tool" >/dev/null || { echo "capture-icon: $tool is required" >&2; exit 1; }
done

mkdir -p "$out"
rm -f "$out"/{master,dock-dark,dock-light,ladder,windows,sizes,brandmark}.png
work="$(mktemp -d)"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
app="$work/CandidCueIconProbe.app"
cleanup() {
  [ -d "$app" ] && "$lsregister" -u "$app" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

font=/System/Library/Fonts/HelveticaNeue.ttc

# --- The icon set, built exactly as it ships -------------------------------

bash "$root/scripts/build-icons.sh" "$work/icons" >/dev/null

# --- A throwaway app carrying it --------------------------------------------
# A fresh bundle identifier every run, so Launch Services cannot answer from
# an icon it cached for an earlier run.

mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$work/icons/icon.icns" "$app/Contents/Resources/icon.icns"
printf '#!/bin/sh\nexit 0\n' > "$app/Contents/MacOS/probe"
chmod +x "$app/Contents/MacOS/probe"
printf 'APPL????' > "$app/Contents/PkgInfo"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>probe</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleIdentifier</key><string>com.candidcue.iconprobe.$$.$RANDOM$RANDOM</string>
  <key>CFBundleName</key><string>CandidCue</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
"$lsregister" -f "$app"

cat > "$work/appicon.swift" <<'SWIFT'
import AppKit
// appicon <out.png> <pt> <path> [scale]: the icon Finder shows for <path>, at
// <pt> points in a <scale>x context (1 by default), so the system picks the
// representation it would on a screen of that density.
let a = CommandLine.arguments
let pt = Int(a[2])!
let scale = a.count > 4 ? Int(a[4])! : 1
let image = NSWorkspace.shared.icon(forFile: a[3])
let px = pt * scale
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: pt, height: pt)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
image.draw(in: NSRect(x: 0, y: 0, width: pt, height: pt), from: .zero, operation: .copy, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[1]))
SWIFT
swiftc -O "$work/appicon.swift" -o "$work/appicon" 2>/dev/null
icon() { "$work/appicon" "$2" "$1" "$3" "${4:-1}"; }

for px in 16 32 64 128 256 512 1024; do icon "$px" "$work/sys-$px.png" "$app"; done
icon 16 "$work/sys-16at2x.png" "$app" 2
icon 32 "$work/sys-32at2x.png" "$app" 2

# The system drew OUR icon and not a cached or generic one: at 256 it must
# match the PNG build-icons.sh wrote for that size, apart from the edge
# treatment macOS adds.
# (compare exits 1 whenever the images differ at all, hence the `|| true`.)
rmse="$( { magick compare -metric RMSE "$work/sys-256.png" "$work/icons/128x128@2x.png" null: 2>&1 || true; } \
  | sed -E 's/.*\(([0-9.e-]+)\).*/\1/')"
awk -v r="$rmse" 'BEGIN { exit !(r < 0.12) }' || {
  echo "capture-icon: macOS drew something other than the built icon (RMSE $rmse)" >&2; exit 1; }

# --- master ----------------------------------------------------------------

cp "$work/icons/icon.png" "$out/master.png"

# --- dock-dark / dock-light --------------------------------------------------
# Real neighbours, chosen to include the blue and green icons this petrol one
# has to stand apart from. Whatever is not installed is skipped; at least four
# must be.

neighbours=(
  /System/Library/CoreServices/Finder.app
  /System/Applications/Notes.app
  /Applications/Pages.app
  @self
  /Applications/Keynote.app
  /Applications/Claude.app
  /System/Applications/Messages.app
  /System/Applications/Photos.app
)
row=()
found=0
self_index=0
for n in "${neighbours[@]}"; do
  if [ "$n" = @self ]; then self_index=${#row[@]}; row+=("$work/sys-128.png"); continue; fi
  [ -d "$n" ] || continue
  f="$work/nb-$(basename "$n" .app).png"
  icon 128 "$f" "$n"
  row+=("$f")
  found=$((found + 1))
done
[ "$found" -ge 4 ] || { echo "capture-icon: only $found neighbour apps installed" >&2; exit 1; }
# A fixed 148px pitch (128 + 20), so the running dot can be placed under the
# icon by arithmetic; +smush would close the gaps up to the visible pixels.
magick "${row[@]}" -background none -gravity east -splice 20x0 +append -gravity east -chop 20x0 "$work/row.png"
rw="$(magick identify -format %w "$work/row.png")"

dock() { # dock <out> <wallpaper top> <wallpaper bottom> <plate> <plate edge> <dot>
  local w=$((rw + 120)) h=300
  local pw=$((rw + 40)) ph=164 px=40 py=96
  local dot_x=$((px + 20 + self_index * 148 + 64))
  magick -size "${w}x${h}" "gradient:$2-$3" \
    \( -size "${pw}x${ph}" xc:none -fill "$4" -stroke "$5" -strokewidth 2 \
       -draw "roundrectangle 1,1 $((pw - 2)),$((ph - 2)) 40,40" \) \
    -geometry "+$px+$py" -composite \
    "$work/row.png" -geometry "+$((px + 20))+$((py + 14))" -composite \
    -fill "$6" -stroke none -draw "circle $dot_x,$((py + ph - 10)) $((dot_x + 4)),$((py + ph - 10))" \
    "$1"
}
dock "$out/dock-dark.png" '#2b3448' '#14161c' 'rgba(40,40,46,0.72)' 'rgba(255,255,255,0.14)' 'rgba(255,255,255,0.75)'
dock "$out/dock-light.png" '#dfe7f1' '#b9c6d6' 'rgba(250,250,252,0.62)' 'rgba(0,0,0,0.10)' 'rgba(0,0,0,0.6)'

# --- ladder -----------------------------------------------------------------

label() { magick -background none -fill "$2" -font "$font" -pointsize 22 label:"$1" "$3"; }
ladder_row() { # ladder_row <bg> <fg> <out>
  local cells=()
  for px in 512 256 128 64 32 16; do
    label "${px}px" "$2" "$work/lbl-$px.png"
    magick "$work/sys-$px.png" "$work/lbl-$px.png" -background none -gravity center -smush 12 "$work/cell-$px.png"
    cells+=("$work/cell-$px.png")
  done
  magick "${cells[@]}" -background none -gravity south +smush 48 \
    -background "$1" -flatten -bordercolor "$1" -border 32 "$3"
}
ladder_row '#ffffff' '#555555' "$work/ladder-light.png"
ladder_row '#1e1e20' '#aaaaaa' "$work/ladder-dark.png"
# The small sizes one pixel to a block: 16 and 32 pt on a 1x screen, then 16
# and 32 pt on a 2x screen (a Retina Finder list and icon view); then the Dock
# size in greyscale and blurred, the squint test for whether the mark holds its
# shape by value alone.
magick "$work/sys-16.png" -filter point -resize 800% "$work/z16.png"
magick "$work/sys-32.png" -filter point -resize 400% "$work/z32.png"
magick "$work/sys-16at2x.png" -filter point -resize 400% "$work/z16at2x.png"
magick "$work/sys-32at2x.png" -filter point -resize 200% "$work/z32at2x.png"
magick "$work/sys-128.png" -colorspace Gray "$work/grey.png"
magick "$work/sys-128.png" -colorspace Gray -blur 0x3 "$work/squint.png"
magick "$work/z16.png" "$work/z32.png" "$work/z16at2x.png" "$work/z32at2x.png" "$work/grey.png" "$work/squint.png" \
  -background none -gravity center +smush 48 \
  -background '#f2f2f2' -flatten -bordercolor '#f2f2f2' -border 32 "$work/ladder-zoom.png"
magick "$work/ladder-light.png" "$work/ladder-dark.png" "$work/ladder-zoom.png" \
  -background '#888888' -gravity center -append "$out/ladder.png"

# --- windows ----------------------------------------------------------------

magick "$work/icons/icon.ico" "$work/ico-%d.png"
ico_cells=()
for f in "$work"/ico-*.png; do
  s="$(magick identify -format %w "$f")"
  [ "$s" -le 48 ] || continue
  ico_cells+=("$f")
done
[ "${#ico_cells[@]}" -ge 4 ] || { echo "capture-icon: the .ico holds only ${#ico_cells[@]} small entries" >&2; exit 1; }
win_row() { # win_row <bg> <out>
  magick "${ico_cells[@]}" -background none -gravity south +smush 12 \
    -background "$1" -flatten -bordercolor "$1" -border 8 \
    -filter point -resize 400% "$2"
}
win_row '#202020' "$work/win-dark.png"
win_row '#f3f3f3' "$work/win-light.png"
magick "$work/win-dark.png" "$work/win-light.png" -append "$out/windows.png"

# --- sizes ------------------------------------------------------------------
# The built files themselves, not the system's render of them: what a Windows
# shell or a Linux desktop is handed at each size, side by side at 1x.

ico_at() { # ico_at <px> <out>: the .ico entry of exactly that size
  local f; for f in "$work"/ico-*.png; do
    [ "$(magick identify -format %w "$f")" = "$1" ] && { cp "$f" "$2"; return; }
  done
  echo "capture-icon: the .ico has no ${1}px entry" >&2; exit 1
}
for px in 48 30 24 20 16; do ico_at "$px" "$work/sz-$px.png"; done
cp "$work/icons/128x128.png" "$work/sz-128.png"; cp "$work/icons/64x64.png" "$work/sz-64.png"
cp "$work/icons/32x32.png" "$work/sz-32.png"
sizes_row() { # sizes_row <bg> <out>
  local cells=() px
  for px in 128 64 48 32 30 24 20 16; do
    magick "$work/sz-$px.png" -background "$1" -gravity center -extent 150x150 "$work/szc-$px.png"
    cells+=("$work/szc-$px.png")
  done
  magick "$work/sz-32.png" -background "$1" -alpha remove -filter point -resize 400% -gravity center -extent 150x150 "$work/szz-32.png"
  magick "$work/sz-16.png" -background "$1" -alpha remove -filter point -resize 800% -gravity center -extent 150x150 "$work/szz-16.png"
  magick "${cells[@]}" "$work/szz-32.png" "$work/szz-16.png" -background "$1" +append "$2"
}
sizes_row '#eceeed' "$work/sizes-light.png"
sizes_row '#1e2326' "$work/sizes-dark.png"
magick "$work/sizes-light.png" "$work/sizes-dark.png" -append "$out/sizes.png"

# --- brandmark --------------------------------------------------------------
# The component's own markup, lifted out of the .svelte file, so this shows
# what Welcome draws rather than a copy of it. The tile is a fixed petrol, so
# the per-theme --accent below only matters if the mark ever takes it again.
# The name beside it is a stand-in: ImageMagick cannot read the bundled
# Archivo woff2, so it is set in $font. Judge the mark here, and the
# wordmark's letterforms in the app itself.

mark_svg() { # mark_svg <accent> <px> <out>
  sed -n '/<svg/,/<\/svg>/p' "$root/src/control/components/BrandMark.svelte" \
    | sed -E -e 's/class="brand-mark"/xmlns="http:\/\/www.w3.org\/2000\/svg"/' \
        -e "s/\\{size\\}/\"$2\"/g" -e "s/var\\(--accent\\)/$1/g" \
        -e '/aria-hidden|focusable/d' > "$3"
  grep -q '<svg' "$3" || { echo "capture-icon: no <svg> in BrandMark.svelte" >&2; exit 1; }
}
wordmark() { # wordmark <bg> <fg> <accent> <out>
  mark_svg "$3" 44 "$work/mark.svg"
  rsvg-convert -w 44 -h 44 "$work/mark.svg" -o "$work/mark.png"
  magick -background none -fill "$2" -font "$font" -pointsize 30 label:CandidCue "$work/word.png"
  magick "$work/mark.png" "$work/word.png" -background none -gravity center +smush 16 \
    -background "$1" -flatten -bordercolor "$1" -border 28x24 "$4"
}
wordmark '#f6f7f5' '#22282b' '#176b75' "$work/wm-light.png"
wordmark '#22282b' '#f6f7f5' '#a4cdd1' "$work/wm-dark.png"
magick "$work/wm-light.png" "$work/wm-dark.png" -append -filter point -resize 200% "$out/brandmark.png"

# --- verify -----------------------------------------------------------------

for f in master dock-dark dock-light ladder windows sizes brandmark; do
  [ -s "$out/$f.png" ] || { echo "capture-icon: $f.png was not written" >&2; exit 1; }
  magick identify "$out/$f.png" >/dev/null
done
echo "capture-icon: wrote 7 images to $out (system render RMSE $rmse)"
