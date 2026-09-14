#!/usr/bin/env python3
"""Generate the Orca HarmonyOS app icons.

Dependency-free: emits PNGs with zlib + struct only, so it runs on a bare macOS
Python without Pillow. Renders at 4x and box-downsamples for antialiasing.

Usage: python3 tools/make_app_icons.py
"""
import math
import os
import struct
import zlib

SS = 4  # supersample factor
SIZE = 216  # final icon edge, px (HarmonyOS recommended app icon size)
BG = (0x11, 0x11, 0x11)
FG = (0xF5, 0xF5, 0xF5)
ACCENT = (0x3B, 0x82, 0xF6)
CORNER_RADIUS = 0.2237  # HarmonyOS squircle approximation, fraction of edge


def write_png(path: str, width: int, height: int, rgba: bytes) -> None:
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw += rgba[y * stride : (y + 1) * stride]
    chunks = [
        (b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)),
        (b"IDAT", zlib.compress(bytes(raw), 9)),
        (b"IEND", b""),
    ]
    out = bytearray(b"\x89PNG\r\n\x1a\n")
    for tag, payload in chunks:
        out += struct.pack(">I", len(payload)) + tag + payload
        out += struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    with open(path, "wb") as handle:
        handle.write(bytes(out))


def lerp(a, b, t):
    return a + (b - a) * t


def render(edge: int) -> bytes:
    n = edge * SS
    radius = CORNER_RADIUS * n
    cx = cy = n / 2.0
    # Ring geometry, all as a fraction of the icon edge.
    rings = [(0.085, 0.028), (0.155, 0.026), (0.225, 0.022)]
    dot_r = 0.052 * n
    buf = bytearray(n * n * 4)
    for y in range(n):
        for x in range(n):
            # Rounded-square coverage.
            dx = max(radius - x, x - (n - radius), 0.0)
            dy = max(radius - y, y - (n - radius), 0.0)
            if math.hypot(dx, dy) > radius:
                continue
            r = BG[0]
            g = BG[1]
            b = BG[2]
            dist = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            # Centre dot.
            if dist <= dot_r:
                r, g, b = FG
            else:
                for ring_r, ring_w in rings:
                    rr = ring_r * n
                    ww = (ring_w * n) / 2.0
                    if abs(dist - rr) <= ww:
                        t = 1.0 - abs(dist - rr) / ww
                        r = int(lerp(r, FG[0], t))
                        g = int(lerp(g, FG[1], t))
                        b = int(lerp(b, FG[2], t))
                        break
            # One accent tick at 45°, so the mark is not pure monochrome.
            angle = math.degrees(math.atan2(y + 0.5 - cy, x + 0.5 - cx)) % 360.0
            if 40.0 <= angle <= 50.0 and dist <= 0.155 * n and abs(dist - 0.155 * n) <= 0.013 * n:
                t = 1.0 - abs(angle - 45.0) / 5.0
                r = int(lerp(r, ACCENT[0], t))
                g = int(lerp(g, ACCENT[1], t))
                b = int(lerp(b, ACCENT[2], t))
            off = (y * n + x) * 4
            buf[off] = r
            buf[off + 1] = g
            buf[off + 2] = b
            buf[off + 3] = 0xFF
    # Box-downsample SSxSS.
    out = bytearray(edge * edge * 4)
    area = SS * SS
    for y in range(edge):
        for x in range(edge):
            sr = sg = sb = sa = 0
            for yy in range(SS):
                base = ((y * SS + yy) * n + x * SS) * 4
                for xx in range(SS):
                    off = base + xx * 4
                    sr += buf[off]
                    sg += buf[off + 1]
                    sb += buf[off + 2]
                    sa += buf[off + 3]
            off = (y * edge + x) * 4
            out[off] = sr // area
            out[off + 1] = sg // area
            out[off + 2] = sb // area
            out[off + 3] = sa // area
    return bytes(out)


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    targets = [
        os.path.join(root, "AppScope", "resources", "base", "media", "app_icon.png"),
        os.path.join(root, "entry", "src", "main", "resources", "base", "media", "app_icon.png"),
        os.path.join(root, "entry", "src", "main", "resources", "base", "media", "startIcon.png"),
    ]
    pixels = render(SIZE)
    for path in targets:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        write_png(path, SIZE, SIZE, pixels)
        print("wrote %s (%d bytes)" % (path, os.path.getsize(path)))


if __name__ == "__main__":
    main()
