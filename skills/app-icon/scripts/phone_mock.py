"""Android home-screen mock at the phone's native resolution, launcher icons at real size.

Opened full-screen on the same phone, the picture is pixel-for-pixel: the icons look exactly
as big as on the real home screen. Pixel Launcher defaults: circle mask, ~56 dp icon.

usage: python -I phone_mock.py <out_dir> <neighbors_dir> label=path.png [label=path.png ...]
         [--size 1080x2424] [--density 420] [--icon-dp 56]
Writes <out_dir>/home-light.png and home-dark.png.
Take size and density from the device: `adb shell wm size`, `adb shell wm density`
(use the Override value when present). Neighbors: *.png in <neighbors_dir>, sorted.
Needs Pillow.
"""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument("out_dir", type=Path)
ap.add_argument("neighbors_dir", type=Path)
ap.add_argument("icons", nargs="+", help="label=path.png, up to 6")
ap.add_argument("--size", default="1080x2424")
ap.add_argument("--density", type=int, default=420)
ap.add_argument("--icon-dp", type=int, default=56)
args = ap.parse_args()
if len(args.icons) > 6:
    ap.error(f"at most 6 icons per mock, got {len(args.icons)} - split into two runs")
args.out_dir.mkdir(parents=True, exist_ok=True)

W, H = map(int, args.size.lower().split("x"))
DP = args.density / 160
ICON = round(args.icon_dp * DP)
COLS = 4


def font(size: int, light: bool = False) -> ImageFont.FreeTypeFont:
    names = (["segoeuil.ttf", "Roboto-Light.ttf", "DejaVuSans.ttf"] if light
             else ["segoeui.ttf", "Roboto-Regular.ttf", "DejaVuSans.ttf"])
    dirs = ["C:/Windows/Fonts", "/System/Library/Fonts/Supplemental", "/usr/share/fonts/truetype/dejavu",
            "/usr/share/fonts/truetype/roboto/unhinted/RobotoTTF"]
    for d in dirs:
        for n in names:
            p = Path(d) / n
            if p.exists():
                return ImageFont.truetype(str(p), size)
    return ImageFont.load_default(size)


LABEL = font(round(12.5 * DP))
CLOCK = font(round(64 * DP), light=True)


def circle_icon(path: Path) -> Image.Image:
    big = ICON * 4  # supersample, then downscale for a smooth edge
    im = Image.open(path).convert("RGBA").resize((big, big), Image.LANCZOS)
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big - 1, big - 1), fill=255)
    bg = Image.new("RGBA", (big, big), (255, 255, 255, 255))  # white bg under transparent legacy icons
    bg.alpha_composite(im)
    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask)
    return out.resize((ICON, ICON), Image.LANCZOS)


def wallpaper(dark: bool) -> Image.Image:
    top, bottom = ((24, 28, 40), (52, 40, 70)) if dark else ((236, 214, 190), (150, 176, 214))
    wp = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(wp)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return wp.convert("RGBA")


ours = [(lbl, Path(p)) for lbl, p in (a.split("=", 1) for a in args.icons)]
# label = last dot-segment of the file name ("com.todoist" -> "Todoist"); name files as you want them labelled
neighbors = [(p.stem.split(".")[-1].replace("_", " ").capitalize()[:12], p)
             for p in sorted(args.neighbors_dir.glob("*.png"))]
rows = max(3, -(-len(ours) * 2 // COLS))
cells = rows * COLS
# spread ours over the rows, column shifting per pass: up to 3 icons get one row each with
# neighbors around them; 4-6 icons share rows and may sit side by side (no slot collisions)
slots = {(i % rows) * COLS + (1 + i // rows + i % rows) % COLS: o for i, o in enumerate(ours)}
grid, it = [], iter(neighbors)
for k in range(cells):
    item = slots.get(k) or next(it, None)
    if item:
        grid.append((k, item))

for dark in (False, True):
    img = wallpaper(dark)
    d = ImageDraw.Draw(img)
    d.text((W // 2, round(H * 0.14)), "12:00", font=CLOCK, fill=(255, 255, 255), anchor="mm")
    col_w = W // COLS
    row_h = ICON + round(40 * DP)
    y0 = H - round(H * 0.18) - rows * row_h
    for k, (label, path) in grid:
        r, c = divmod(k, COLS)
        cx, y = c * col_w + col_w // 2, y0 + r * row_h
        shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ImageDraw.Draw(shadow).ellipse((cx - ICON // 2, y + 6, cx + ICON // 2, y + ICON + 6), fill=(0, 0, 0, 60))
        img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(8)))
        img.alpha_composite(circle_icon(path), (cx - ICON // 2, y))
        d.text((cx, y + ICON + round(14 * DP)), label, font=LABEL, fill=(255, 255, 255),
               anchor="mm", stroke_width=2, stroke_fill=(0, 0, 0))
    name = f"home-{'dark' if dark else 'light'}.png"
    img.convert("RGB").save(args.out_dir / name)
    print("ok", name, f"{W}x{H}", "icon px =", ICON)
