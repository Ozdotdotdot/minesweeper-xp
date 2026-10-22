"""Extract the game's resources from WINMINE.EXE into web-friendly files.

Usage: python3 -I tools/extract_resources.py original/WINMINE.EXE assets/

Resource offsets/sizes come from REA `inspect_pe_resources`
(evidence ev_2d438d0be2002e857547e2f1b199cd4243ce933eeab54b446fe929cd0018d666,
WINMINE.EXE sha256 bcff8931...caaf41). Pure standard library; no Pillow needed.
"""
import hashlib
import json
import pathlib
import struct
import sys
import zlib

EXPECTED_SHA256 = "bcff89311d792f6428468e813ac6929a346a979f907071c302f418d128eaaf41"

# name -> (resource id, file offset, size)
BITMAPS = {
    "blocks": (410, 42632, 2152), "blocks_mono": (411, 44784, 1072),
    "led": (420, 45856, 2312), "led_mono": (421, 48168, 1152),
    "faces": (430, 49320, 1544), "faces_mono": (431, 50864, 528),
}
WAVES = {"tick": (432, 51392, 1360), "win": (433, 52752, 37960), "lose": (434, 90712, 25711)}
STRING_TABLE = (1, 118808, 838)  # RT_STRING block 1 -> string ids 0..15
ICON_GROUP = (100, 42512, 118)
ICONS = {1: (19080, 744), 2: (19824, 304), 3: (20128, 3752), 4: (23880, 2216),
         5: (26096, 1384), 6: (27480, 9640), 7: (37120, 4264), 8: (41384, 1128)}


def write_png(path, width, height, rows):
    """rows: list of bytes objects, RGBA, top-down."""
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def decode_dib(data, height_override=None, and_mask=False):
    """Decode a palettized/32bpp bottom-up DIB to top-down RGBA rows."""
    hsize, w, h, _planes, bpp, _comp, _isz, _xp, _yp, clr, _imp = struct.unpack_from("<IiiHHIIiiII", data)
    if height_override:
        h = height_override
    ncolors = clr or (1 << bpp if bpp <= 8 else 0)
    pal_off = hsize
    palette = [data[pal_off + 4 * i: pal_off + 4 * i + 3][::-1] for i in range(ncolors)]  # BGRx -> RGB
    pix = pal_off + 4 * ncolors
    stride = ((w * bpp + 31) // 32) * 4
    mask_stride = ((w + 31) // 32) * 4
    mask_off = pix + stride * h
    rows = []
    for y in range(h):
        src = h - 1 - y
        line = data[pix + src * stride: pix + (src + 1) * stride]
        out = bytearray()
        for x in range(w):
            if bpp == 32:
                b, g, r, a = line[4 * x: 4 * x + 4]
                out += bytes((r, g, b, a))
                continue
            if bpp == 8:
                idx = line[x]
            elif bpp == 4:
                idx = (line[x // 2] >> (4 if x % 2 == 0 else 0)) & 0xF
            else:
                idx = (line[x // 8] >> (7 - x % 8)) & 1
            alpha = 255
            if and_mask:
                m = data[mask_off + src * mask_stride + x // 8]
                alpha = 0 if (m >> (7 - x % 8)) & 1 else 255
            out += palette[idx] + bytes((alpha,))
        rows.append(bytes(out))
    return w, h, rows


def main():
    exe = pathlib.Path(sys.argv[1]).read_bytes()
    out = pathlib.Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(exe).hexdigest()
    if digest != EXPECTED_SHA256:
        sys.exit(f"unexpected WINMINE.EXE (sha256 {digest}); offsets are only valid for {EXPECTED_SHA256}")

    for name, (_rid, off, size) in BITMAPS.items():
        w, h, rows = decode_dib(exe[off: off + size])
        write_png(out / f"{name}.png", w, h, rows)
        print(f"{name}.png  {w}x{h}")

    for name, (_rid, off, size) in WAVES.items():
        (out / f"{name}.wav").write_bytes(exe[off: off + size])
        print(f"{name}.wav  {size} bytes")

    _rid, off, size = STRING_TABLE
    data, p, strings = exe[off: off + size], 0, {}
    for i in range(16):
        n = struct.unpack_from("<H", data, p)[0]
        p += 2
        if n:
            strings[i] = data[p: p + 2 * n].decode("utf-16le")
        p += 2 * n
    (out / "strings.json").write_text(json.dumps(strings, indent=2) + "\n")

    # Icon: rebuild a .ico from RT_GROUP_ICON 100, and a 48x48 32bpp PNG for the page.
    _rid, off, size = ICON_GROUP
    grp = exe[off: off + size]
    count = struct.unpack_from("<H", grp, 4)[0]
    entries, blobs = [], []
    for i in range(count):
        bw, bh, cc, res, planes, bits, nbytes, icon_id = struct.unpack_from("<BBBBHHIH", grp, 6 + 14 * i)
        ioff, isize = ICONS[icon_id]
        blobs.append(exe[ioff: ioff + isize])
        entries.append((bw, bh, cc, res, planes, bits, isize))
    ico = struct.pack("<HHH", 0, 1, count)
    pos = 6 + 16 * count
    for (bw, bh, cc, res, planes, bits, isize), blob in zip(entries, blobs):
        ico += struct.pack("<BBBBHHII", bw, bh, cc, res, planes, bits, isize, pos)
        pos += isize
    (out / "winmine.ico").write_bytes(ico + b"".join(blobs))
    for size_px, icon_id in ((48, 6), (16, 8)):
        ioff, isize = ICONS[icon_id]
        w, h, rows = decode_dib(exe[ioff: ioff + isize], height_override=size_px)
        write_png(out / f"icon{size_px}.png", w, h, rows)
    print("winmine.ico, icon48.png, icon16.png")


if __name__ == "__main__":
    main()
