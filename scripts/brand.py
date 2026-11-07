"""Render every ChatGPT Gateway brand image from one definition of the mark.

The mark: a gateway arch (teal) with one wire passing through it, from a client (a violet circle)
to a model (an amber diamond), in the colors of the project family (FlowPilot, Telegram Assist).

    uv run --no-project --with pillow python scripts/brand.py --font Onest.ttf

``--font`` is the Onest variable TTF (https://github.com/google/fonts/tree/main/ofl/onest), used
for the wordmark. Writes:

- ``assets/brand/gateway-mark.svg``        vector source of the mark
- ``assets/brand/logo.png``, ``dark_logo.png``  logos for the README (light and dark themes)
- ``addon/icon.png``, ``addon/logo.png``   the app in the app store
- ``assets/brand/social-preview.png``      GitHub social preview (upload by hand)

Images are PNG, transparent, without empty margins (as home-assistant/brands asks).
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
NAME = "ChatGPT Gateway"

TEAL = "#2BB8A6"
VIOLET = "#9C7BF0"
AMBER = "#E9A23B"
INK_LIGHT = "#1D2330"  # wordmark on light backgrounds
INK_DARK = "#E4E7EC"  # wordmark on dark backgrounds
INK_ANY = "#6B7484"  # wordmark that reads on both (the app store has no dark variant)
CANVAS = "#1B1F26"

# Geometry in a unit square (the same numbers go into the SVG)
GATE = (0.30, 0.70, 0.40, 0.88)  # left x, right x, y where the arch starts, foot y
GATE_W = 0.10  # stroke width of the arch
WIRE_Y = 0.66
WIRE_W = 0.07
CLIENT = (0.10, WIRE_Y, 0.085)  # cx, cy, r
MODEL = (0.86, WIRE_Y, 0.085 * 1.3)  # cx, cy, half diagonal


def _round_line(d: ImageDraw.ImageDraw, a: tuple[float, float], b: tuple[float, float],
                width: float, color: str) -> None:  # fmt: skip
    d.line([a, b], fill=color, width=round(width))
    for x, y in (a, b):
        d.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=color)


def mark(size: int) -> Image.Image:
    """The mark, trimmed to its content and centred in a transparent square of ``size``."""
    s = 2048
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    left, right, top, foot = (v * s for v in GATE)
    w = GATE_W * s
    r = (right - left) / 2
    cx = (left + right) / 2
    # the wire goes through the gate, behind its pillars: violet from the client, amber towards the model
    y = WIRE_Y * s
    _round_line(d, (CLIENT[0] * s, y), (cx, y), WIRE_W * s, VIOLET)
    _round_line(d, (cx, y), (MODEL[0] * s, y), WIRE_W * s, AMBER)
    # the arch: a half ring on top of two pillars, drawn with a centred stroke
    d.arc([left - w / 2, top - r - w / 2, right + w / 2, top + r + w / 2], 180, 360,
          fill=TEAL, width=round(w))  # fmt: skip
    _round_line(d, (left, top), (left, foot), w, TEAL)
    _round_line(d, (right, top), (right, foot), w, TEAL)
    x, y, cr = (v * s for v in CLIENT)
    d.ellipse([x - cr, y - cr, x + cr, y + cr], fill=VIOLET)
    x, y, h = (v * s for v in MODEL)
    d.polygon([(x, y - h), (x + h, y), (x, y + h), (x - h, y)], fill=AMBER)
    trimmed = img.crop(img.getbbox())
    side = max(trimmed.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(trimmed, ((side - trimmed.width) // 2, (side - trimmed.height) // 2))
    return square.resize((size, size), Image.Resampling.LANCZOS)


def mark_svg() -> str:
    """The same mark as SVG, viewBox trimmed to the content (units of 1/1000)."""
    k = 1000
    left, right, top, foot = (v * k for v in GATE)
    r = (right - left) / 2
    w = GATE_W * k
    y = WIRE_Y * k
    cx = (left + right) / 2
    ccx, _, ccr = (v * k for v in CLIENT)
    mx, _, mh = (v * k for v in MODEL)
    vb_left, vb_right = ccx - ccr, mx + mh
    vb_top, vb_bottom = top - r - w / 2, foot + w / 2
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb_left:g} {vb_top:g} {vb_right - vb_left:g} {vb_bottom - vb_top:g}">
<title>{NAME}</title>
<g stroke-width="{WIRE_W * k:g}" stroke-linecap="round">
  <path d="M{ccx:g} {y:g} L{cx:g} {y:g}" stroke="{VIOLET}" />
  <path d="M{cx:g} {y:g} L{mx:g} {y:g}" stroke="{AMBER}" />
</g>
<path d="M{left:g} {foot:g} L{left:g} {top:g} A{r:g} {r:g} 0 0 1 {right:g} {top:g} L{right:g} {foot:g}" fill="none" stroke="{TEAL}" stroke-width="{w:g}" stroke-linecap="round" />
<circle cx="{ccx:g}" cy="{y:g}" r="{ccr:g}" fill="{VIOLET}" />
<path d="M{mx:g} {y - mh:g} L{mx + mh:g} {y:g} L{mx:g} {y + mh:g} L{mx - mh:g} {y:g} Z" fill="{AMBER}" />
</svg>
"""  # noqa: E501


def font(path: Path, size: int, weight: int = 640) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(path), size)
    f.set_variation_by_axes([weight])
    return f


def logo(height: int, ink: str, font_path: Path) -> Image.Image:
    """Mark and wordmark side by side, trimmed: the short side is ``height``."""
    scale = 4
    h = height * scale
    m = mark(h)
    f = font(font_path, int(h * 0.56))
    box = f.getbbox(NAME)
    gap = int(h * 0.22)
    canvas = Image.new("RGBA", (h + gap + box[2] + h, h), (0, 0, 0, 0))
    canvas.paste(m, (0, 0), m)
    d = ImageDraw.Draw(canvas)
    d.text((h + gap, (h - (box[3] + box[1])) // 2), NAME, font=f, fill=ink)
    trimmed = canvas.crop(canvas.getbbox())
    width = round(trimmed.width * height / trimmed.height)
    return trimmed.resize((width, height), Image.Resampling.LANCZOS)


def fit(img: Image.Image, width: int, height: int) -> Image.Image:
    """Scale ``img`` into a ``width``x``height`` transparent box (the app logo has a fixed box)."""
    img = img.copy()
    img.thumbnail((width, height), Image.Resampling.LANCZOS)
    box = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    box.paste(img, ((width - img.width) // 2, (height - img.height) // 2), img)
    return box


def social(font_path: Path) -> Image.Image:
    img = Image.new("RGB", (1280, 640), CANVAS)
    m = mark(280)
    img.paste(m, (110, 180), m)
    d = ImageDraw.Draw(img)
    d.text((450, 200), "ChatGPT", font=font(font_path, 104), fill=INK_DARK)
    d.text((450, 310), "Gateway", font=font(font_path, 104), fill=INK_DARK)
    tagline = font(font_path, 36, 420)
    d.text((454, 450), "Your ChatGPT plan as an OpenAI-compatible", font=tagline, fill="#8A93A3")
    d.text((454, 496), "API in your home, for Home Assistant", font=tagline, fill="#8A93A3")
    return img


def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)
    print(f"{path.relative_to(ROOT)}  {img.width}x{img.height}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--font", type=Path, required=True, help="Onest variable TTF")
    font_path = parser.parse_args().font

    assets = ROOT / "assets" / "brand"
    assets.mkdir(parents=True, exist_ok=True)
    (assets / "gateway-mark.svg").write_text(mark_svg())
    print("assets/brand/gateway-mark.svg")

    save(logo(128, INK_LIGHT, font_path), assets / "logo.png")
    save(logo(128, INK_DARK, font_path), assets / "dark_logo.png")

    save(mark(128), ROOT / "addon" / "icon.png")
    save(fit(logo(200, INK_ANY, font_path), 250, 100), ROOT / "addon" / "logo.png")

    save(social(font_path), assets / "social-preview.png")


if __name__ == "__main__":
    main()
