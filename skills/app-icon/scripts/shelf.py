"""Store-shelf preview for app icon variants.

For every PNG in <variants_dir> writes into <out_dir>:
  <name>-512.png    the icon at 512 px with the Google Play 30% corner mask
  <name>-shelf.png  the icon at 48 px (@2x) between competitor icons, light row over dark row,
                    with an accent bar under ours

usage: python -I shelf.py <variants_dir> <competitors_dir> <out_dir> [--max-competitors 7]
Competitors: every *.png in <competitors_dir>, sorted by name; ours goes in the middle.
Needs Pillow.
"""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw

ap = argparse.ArgumentParser()
ap.add_argument("variants_dir", type=Path)
ap.add_argument("competitors_dir", type=Path)
ap.add_argument("out_dir", type=Path)
ap.add_argument("--max-competitors", type=int, default=7)
args = ap.parse_args()
args.out_dir.mkdir(parents=True, exist_ok=True)

SCALE = 2           # @2x so 48 px stays crisp on hi-dpi review screens
ICON = 48 * SCALE   # Play list/search icon size
GAP = 16 * SCALE
PAD = 16 * SCALE
SURFACES = [(255, 255, 255), (32, 33, 36)]  # Play light / dark surface
ACCENT = (244, 169, 35)


def masked(img: Image.Image, size: int) -> Image.Image:
    img = img.convert("RGBA").resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * 0.3), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


comps = [Image.open(p) for p in sorted(args.competitors_dir.glob("*.png"))[: args.max_competitors]]
mid = len(comps) // 2

for v in sorted(args.variants_dir.glob("*.png")):
    hero = Image.open(v)
    masked(hero, 512).save(args.out_dir / f"{v.stem}-512.png")
    row = comps[:mid] + [hero] + comps[mid:]
    w = PAD * 2 + len(row) * ICON + (len(row) - 1) * GAP
    h = PAD * 2 + ICON
    sheet = Image.new("RGB", (w, h * len(SURFACES)))
    draw = ImageDraw.Draw(sheet)
    for band, bg in enumerate(SURFACES):
        draw.rectangle((0, band * h, w, band * h + h), fill=bg)
        for i, im in enumerate(row):
            ic = masked(im, ICON)
            x, y = PAD + i * (ICON + GAP), band * h + PAD
            if im is hero:
                draw.rectangle((x, y + ICON + 6, x + ICON, y + ICON + 9), fill=ACCENT)
            sheet.paste(ic, (x, y), ic)
    sheet.save(args.out_dir / f"{v.stem}-shelf.png")
    print("ok", v.stem)
