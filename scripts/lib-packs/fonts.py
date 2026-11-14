"""Fetch the fonts shipped in packs/fonts and turn them into libass-friendly static TTFs.

Usage (maintainers only; the generated fonts are committed):

    py -m pip install "fonttools>=4.56"
    py -I scripts/lib-packs/fonts.py            # writes packs/fonts/<Family>/*.ttf + licence

Why this exists
---------------
* Every font comes from the google/fonts repository at a PINNED commit (or Google Fonts'
  versioned static builds), so the output is reproducible and the licence provenance is
  clear (OFL-1.1; Permanent Marker is Apache-2.0).
* Several families are only published there as variable fonts. libass (FFmpeg export and
  JASSUB preview) renders the default instance of a variable font only, so we cut static
  instances with fontTools' instancer - the same tool Google uses for its static builds.
* libass matches the requested family ONLY against name ID 1 (legacy family) and the full
  name, never the typographic family (ID 16). Stock statics name e.g. ExtraBold as family
  "Montserrat ExtraBold", so `\\fnMontserrat\\b800` would silently fall back to Bold. We
  therefore normalise every file of a family to name ID 1 = "<Family>" and let
  OS/2.usWeightClass carry the weight, which libass uses for nearest-weight matching.
* Timestamps are not recalculated so re-running produces byte-identical files.
"""

from __future__ import annotations

import io
import sys
import urllib.request
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

COMMIT = "38411257417e616c5d4daa1b9e91a3dbcebe1c2e"
RAW = f"https://raw.githubusercontent.com/google/fonts/{COMMIT}"
# Versioned (immutable) static builds served by Google Fonts.
GSTATIC = "https://fonts.gstatic.com/s/playfairdisplay/v40"

WEIGHT_NAMES = {
    100: "Thin",
    200: "ExtraLight",
    300: "Light",
    400: "Regular",
    500: "Medium",
    600: "SemiBold",
    700: "Bold",
    800: "ExtraBold",
    900: "Black",
}

# family -> (repo dir, licence file, [(weight, italic, source file)])
# A source containing "[" is a variable font that is instanced at `weight`; an absolute URL
# is fetched as-is.
FAMILIES: dict[str, tuple[str, str, list[tuple[int, bool, str]]]] = {
    "Montserrat": (
        "ofl/montserrat",
        "OFL.txt",
        [(w, False, "Montserrat[wght].ttf") for w in (400, 600, 700, 800, 900)],
    ),
    "Poppins": (
        "ofl/poppins",
        "OFL.txt",
        [
            (400, False, "Poppins-Regular.ttf"),
            (600, False, "Poppins-SemiBold.ttf"),
            (700, False, "Poppins-Bold.ttf"),
            (800, False, "Poppins-ExtraBold.ttf"),
            (900, False, "Poppins-Black.ttf"),
        ],
    ),
    "Inter": (
        "ofl/inter",
        "OFL.txt",
        [(w, False, "Inter[opsz,wght].ttf") for w in (400, 600, 800)],
    ),
    "Bebas Neue": ("ofl/bebasneue", "OFL.txt", [(400, False, "BebasNeue-Regular.ttf")]),
    "Anton": ("ofl/anton", "OFL.txt", [(400, False, "Anton-Regular.ttf")]),
    "Oswald": ("ofl/oswald", "OFL.txt", [(w, False, "Oswald[wght].ttf") for w in (400, 600, 700)]),
    "Archivo Black": ("ofl/archivoblack", "OFL.txt", [(400, False, "ArchivoBlack-Regular.ttf")]),
    "Bangers": ("ofl/bangers", "OFL.txt", [(400, False, "Bangers-Regular.ttf")]),
    "Permanent Marker": (
        "apache/permanentmarker",
        "LICENSE.txt",
        [(400, False, "PermanentMarker-Regular.ttf")],
    ),
    "Pacifico": ("ofl/pacifico", "OFL.txt", [(400, False, "Pacifico-Regular.ttf")]),
    "Lilita One": ("ofl/lilitaone", "OFL.txt", [(400, False, "LilitaOne-Regular.ttf")]),
    "Roboto": ("ofl/roboto", "OFL.txt", [(w, False, "Roboto[wdth,wght].ttf") for w in (400, 700, 900)]),
    # Playfair Display carries a Reserved Font Name, so we must not ship modified instances:
    # use Google's own static builds (RIBBI weights only, which libass matches unmodified).
    "Playfair Display": (
        "ofl/playfairdisplay",
        "OFL.txt",
        [
            (400, False, f"{GSTATIC}/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKdFvUDQ.ttf"),
            (700, False, f"{GSTATIC}/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKeiukDQ.ttf"),
            (400, True, f"{GSTATIC}/nuFRD-vYSZviVYUb_rj3ij__anPXDTnCjmHKM4nYO7KN_qiTbtY.ttf"),
            (700, True, f"{GSTATIC}/nuFRD-vYSZviVYUb_rj3ij__anPXDTnCjmHKM4nYO7KN_k-UbtY.ttf"),
        ],
    ),
    "Caveat": ("ofl/caveat", "OFL.txt", [(w, False, "Caveat[wght].ttf") for w in (400, 700)]),
    "Rubik": ("ofl/rubik", "OFL.txt", [(w, False, "Rubik[wght].ttf") for w in (400, 700, 900)]),
}

_cache: dict[str, bytes] = {}


def fetch(path: str) -> bytes:
    url = path if path.startswith("https://") else f"{RAW}/{path}"
    if url not in _cache:
        with urllib.request.urlopen(url, timeout=60) as res:  # noqa: S310 (pinned https)
            _cache[url] = res.read()
    return _cache[url]


def style_name(weight: int, italic: bool) -> str:
    name = WEIGHT_NAMES[weight]
    if italic:
        return "Italic" if weight == 400 else f"{name} Italic"
    return name


def normalise_names(font: TTFont, family: str, weight: int, italic: bool) -> None:
    """Make name ID 1 the plain family so libass matches by family + usWeightClass."""
    style = style_name(weight, italic)
    full = family if style == "Regular" else f"{family} {style}"
    ps = f"{family.replace(' ', '')}-{style.replace(' ', '')}"
    name = font["name"]
    for nid in (1, 2, 4, 6, 16, 17, 21, 22, 25):
        name.removeNames(nameID=nid)
    for nid, value in ((1, family), (2, style), (4, full), (6, ps), (16, family), (17, style)):
        name.setName(value, nid, 3, 1, 0x409)  # Windows / Unicode BMP / en-US
        name.setName(value, nid, 1, 0, 0)  # Macintosh / Roman / English
    os2 = font["OS/2"]
    os2.usWeightClass = weight
    sel = os2.fsSelection & ~(0b1 | 0b100000 | 0b1000000)  # clear ITALIC, BOLD, REGULAR
    if italic:
        sel |= 0b1
    if weight == 700:
        sel |= 0b100000
    if weight == 400 and not italic:
        sel |= 0b1000000
    os2.fsSelection = sel
    font["head"].macStyle = (1 if weight == 700 else 0) | (2 if italic else 0)
    if "post" in font:
        font["post"].italicAngle = font["post"].italicAngle if italic else 0


def build_one(src: bytes, weight: int, italic: bool, family: str) -> bytes:
    font = TTFont(io.BytesIO(src), recalcTimestamp=False)
    if (
        "fvar" not in font
        and font["name"].getDebugName(1) == family
        and font["OS/2"].usWeightClass == weight
    ):
        return src  # already libass-friendly: ship the upstream file untouched
    if "fvar" in font:
        location = {a.axisTag: a.defaultValue for a in font["fvar"].axes}
        location["wght"] = weight
        font = instancer.instantiateVariableFont(font, location)
        font.recalcTimestamp = False
        for table in ("STAT",):
            if table in font:
                del font[table]
    normalise_names(font, family, weight, italic)
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


def main(out_dir: Path) -> None:
    for family, (repo_dir, licence, files) in FAMILIES.items():
        target = out_dir / family
        target.mkdir(parents=True, exist_ok=True)
        for old in target.glob("*.ttf"):
            old.unlink()
        (target / licence).write_bytes(fetch(f"{repo_dir}/{licence}").replace(b"\r\n", b"\n"))
        for weight, italic, src in files:
            url = src if src.startswith("https://") else f"{repo_dir}/{src}"
            data = build_one(fetch(url), weight, italic, family)
            file_name = f"{family.replace(' ', '')}-{style_name(weight, italic).replace(' ', '')}.ttf"
            (target / file_name).write_bytes(data)
            print(f"{family:18} {weight} {'italic' if italic else '      '} {len(data):>8} B  {file_name}")


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else root / "packs" / "fonts")
