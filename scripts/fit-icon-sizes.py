#!/usr/bin/env python3
"""Write the app icon's small-size drawings into src-tauri/icons/source/sizes/.

The 1024 master (icon.svg) shrunk to 16-48 px puts its rim, line and cue
triangles between pixel rows, so they render as grey smears and the triangles
fuse with the line. Each size here is the same mark redrawn for its pixel grid:
every horizontal edge (the tile's flat sides, the rim, the line) on a whole
pixel; the rim at least one pixel; the line shorter than the master's, so the
cue triangles keep a visible depth and a clear pixel of tile before the line;
the sides at the master's 17.66 degree lean. At 16 px the line gives up most
of its length (3 px) so the triangles keep 1.7 px of depth.

Windows sizes fill more of their canvas than the macOS grid does (a one- or
two-pixel margin), because Windows shell icons fill their slot; mac-32 is the
32 px drawing for the .icns 16@2x slot, on the macOS proportions.

    python3 scripts/fit-icon-sizes.py      # then: bash scripts/build-icons.sh
"""
import math
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'src-tauri', 'icons', 'source', 'sizes')
SLOPE = math.tan(math.radians(17.66))  # the master's side lean

# One row per drawing, in pixels on its own canvas:
#   n canvas, m tile margin, w outer bottom width, h outer height, y0 outer top,
#   t rim, lh line height, ll line length, line_y line top row, gap tile between
#   a cue tip and the line, rh half the cue's root span on the inner side,
#   gradient (the master's) or flat Optical Blue.
SIZES = {
    '16':     dict(n=16, m=1, w=13, h=8,  y0=4,  t=1, lh=2, ll=3,  line_y=7,  gap=1,   rh=2.0,  gradient=False),
    '20':     dict(n=20, m=1, w=16, h=10, y0=5,  t=1, lh=2, ll=4,  line_y=9,  gap=1,   rh=2.0,  gradient=False),
    '24':     dict(n=24, m=1, w=18, h=11, y0=6,  t=1, lh=3, ll=6,  line_y=10, gap=1,   rh=2.25, gradient=False),
    '30':     dict(n=30, m=1, w=22, h=13, y0=8,  t=2, lh=3, ll=6,  line_y=13, gap=1,   rh=2.5,  gradient=False),
    '32':     dict(n=32, m=1, w=24, h=14, y0=9,  t=2, lh=3, ll=8,  line_y=14, gap=1,   rh=2.5,  gradient=False),
    'mac-32': dict(n=32, m=2, w=24, h=14, y0=9,  t=2, lh=3, ll=8,  line_y=14, gap=1,   rh=2.5,  gradient=False),
    '36':     dict(n=36, m=1, w=28, h=16, y0=10, t=2, lh=3, ll=10, line_y=16, gap=1,   rh=3.0,  gradient=False),
    '40':     dict(n=40, m=1, w=30, h=18, y0=11, t=2, lh=3, ll=12, line_y=18, gap=1.5, rh=3.0,  gradient=False),
    '48':     dict(n=48, m=2, w=36, h=21, y0=13, t=2, lh=3, ll=14, line_y=22, gap=1.5, rh=3.5,  gradient=True),
    # BrandMark.svelte copies this mark's path: Welcome draws it at 22 CSS px,
    # which is 44 device pixels on a 2x screen. The tile there is its own.
    'brand-44': dict(n=44, m=0, w=34, h=20, y0=12, t=2, lh=3, ll=14, line_y=20, gap=1.5, rh=3.5, gradient=False),
}
TILE, TOP, BOTTOM, MARK = '#3D63B8', '#4B70C3', '#3759A5', '#ffffff'

# The macOS continuous-corner squircle, as a polyline on a 32-unit grid spanning
# 2..30; every drawing maps it onto its own tile.
SQUIRCLE = (
    '30.00 16.00 29.99 19.88 29.97 21.24 29.92 22.25 29.87 23.07 29.79 23.78 29.70 24.40 29.59 24.96 '
    '29.46 25.47 29.31 25.93 29.15 26.36 28.97 26.75 28.77 27.11 28.55 27.45 28.30 27.76 28.04 28.04 '
    '27.76 28.30 27.45 28.55 27.11 28.77 26.75 28.97 26.36 29.15 25.93 29.31 25.47 29.46 24.96 29.59 '
    '24.40 29.70 23.78 29.79 23.07 29.87 22.25 29.92 21.24 29.97 19.88 29.99 16.00 30.00 12.12 29.99 '
    '10.76 29.97 9.75 29.92 8.93 29.87 8.22 29.79 7.60 29.70 7.04 29.59 6.53 29.46 6.07 29.31 5.64 29.15 '
    '5.25 28.97 4.89 28.77 4.55 28.55 4.24 28.30 3.96 28.04 3.70 27.76 3.45 27.45 3.23 27.11 3.03 26.75 '
    '2.85 26.36 2.69 25.93 2.54 25.47 2.41 24.96 2.30 24.40 2.21 23.78 2.13 23.07 2.08 22.25 2.03 21.24 '
    '2.01 19.88 2.00 16.00 2.01 12.12 2.03 10.76 2.08 9.75 2.13 8.93 2.21 8.22 2.30 7.60 2.41 7.04 '
    '2.54 6.53 2.69 6.07 2.85 5.64 3.03 5.25 3.23 4.89 3.45 4.55 3.70 4.24 3.96 3.96 4.24 3.70 4.55 3.45 '
    '4.89 3.23 5.25 3.03 5.64 2.85 6.07 2.69 6.53 2.54 7.04 2.41 7.60 2.30 8.22 2.21 8.93 2.13 9.75 2.08 '
    '10.76 2.03 12.12 2.01 16.00 2.00 19.88 2.01 21.24 2.03 22.25 2.08 23.07 2.13 23.78 2.21 24.40 2.30 '
    '24.96 2.41 25.47 2.54 25.93 2.69 26.36 2.85 26.75 3.03 27.11 3.23 27.45 3.45 27.76 3.70 28.04 3.96 '
    '28.30 4.24 28.55 4.55 28.77 4.89 28.97 5.25 29.15 5.64 29.31 6.07 29.46 6.53 29.59 7.04 29.70 7.60 '
    '29.79 8.22 29.87 8.93 29.92 9.75 29.97 10.76 29.99 12.12'
)


def num(v):
    s = f'{v:.3f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def tile(n, m):
    vals = [float(v) for v in SQUIRCLE.split()]
    k = (n - 2 * m) / 28.0
    pts = [(m + (vals[i] - 2) * k, m + (vals[i + 1] - 2) * k) for i in range(0, len(vals), 2)]
    return 'M' + 'L'.join(f'{num(x)} {num(y)}' for x, y in pts) + 'Z'


def mark(n, w, h, y0, t, lh, ll, line_y, gap, rh, **_):
    cx, yb = n / 2.0, y0 + h
    outer = lambda y: w / 2.0 - SLOPE * (yb - y)
    inset = t / math.cos(math.atan(SLOPE))
    inner = lambda y: outer(y) - inset
    ti, bi = y0 + t, yb - t
    axis = line_y + lh / 2.0
    up, lo, tip = axis - rh, axis + rh, ll / 2.0 + gap
    if inner(axis) - tip < 0.5:
        raise SystemExit(f'{n}px: no room for the cue triangles')
    d = f'M{num(cx - outer(yb))} {num(yb)}H{num(cx + outer(yb))}L{num(cx + outer(y0))} {num(y0)}H{num(cx - outer(y0))}Z'
    d += (f'M{num(cx - inner(bi))} {num(bi)}L{num(cx - inner(lo))} {num(lo)}L{num(cx - tip)} {num(axis)}'
          f'L{num(cx - inner(up))} {num(up)}L{num(cx - inner(ti))} {num(ti)}H{num(cx + inner(ti))}'
          f'L{num(cx + inner(up))} {num(up)}L{num(cx + tip)} {num(axis)}L{num(cx + inner(lo))} {num(lo)}'
          f'L{num(cx + inner(bi))} {num(bi)}Z')
    r = lh / 2.0
    x0, x1 = cx - ll / 2.0 + r, cx + ll / 2.0 - r
    d += (f'M{num(x0)} {num(line_y)}H{num(x1)}A{num(r)} {num(r)} 0 0 1 {num(x1)} {num(line_y + lh)}'
          f'H{num(x0)}A{num(r)} {num(r)} 0 0 1 {num(x0)} {num(line_y)}Z')
    return d


def write(name, p):
    n, m = p['n'], p['m']
    defs, fill = '', TILE
    if p['gradient']:
        defs = (f'  <defs><linearGradient id="tile" x1="0" y1="{m}" x2="0" y2="{n - m}" gradientUnits="userSpaceOnUse">'
                f'<stop offset="0" stop-color="{TOP}"/><stop offset="1" stop-color="{BOTTOM}"/></linearGradient></defs>\n')
        fill = 'url(#tile)'
    role = {'mac': ' (the .icns 16@2x slot)', 'brand': " (the source of BrandMark.svelte's mark)"}.get(name.split('-')[0], '')
    body = (f'<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<!-- The app icon drawn for {n} px{role}. '
            f'Generated by scripts/fit-icon-sizes.py: change the table there, not this file. -->\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" width="{n}" height="{n}">\n{defs}'
            f'  <path d="{tile(n, m)}" fill="{fill}"/>\n'
            f'  <path d="{mark(**p)}" fill="{MARK}" fill-rule="evenodd"/>\n</svg>\n')
    with open(os.path.join(OUT, f'icon-{name}.svg'), 'w') as fh:
        fh.write(body)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for name, p in SIZES.items():
        write(name, p)
    print(f'fit-icon-sizes: wrote {len(SIZES)} drawings to {OUT}')
