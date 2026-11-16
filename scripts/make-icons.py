import math
import struct
import sys
import zlib
from pathlib import Path

OUT = Path(sys.argv[1])
BG = (14, 99, 156)
FG = (255, 255, 255)


def coverage(px, py, size):
    s = size
    r = 0.22 * s
    x = min(px, s - px)
    y = min(py, s - py)
    if x < r and y < r and math.hypot(r - x, r - y) > r:
        return None
    cx, cy = s / 2, s * 0.62
    radius = s * 0.30
    d = math.hypot(px - cx, py - cy)
    on_arc = abs(d - radius) < s * 0.075 and py < cy
    pillars = abs(py - cy) < s * 0.20 and py >= cy - s * 0.02 and any(abs(px - (cx + k * radius)) < s * 0.075 for k in (-1, 1))
    deck = abs(py - (cy + s * 0.02)) < s * 0.05 and s * 0.12 < px < s * 0.88
    return on_arc or pillars or deck


def render(size):
    ss = 4
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    c = coverage(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss, size)
                    if c is None:
                        continue
                    col = FG if c else BG
                    acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255
            n = ss * ss
            a = acc[3] / n
            if a:
                row += bytes([round(acc[0] / (acc[3] / 255)), round(acc[1] / (acc[3] / 255)), round(acc[2] / (acc[3] / 255)), round(a)])
            else:
                row += bytes(4)
        rows.append(bytes(row))
    raw = zlib.compress(b''.join(rows), 9)

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)

    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', raw) + chunk(b'IEND', b'')


OUT.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 48, 128):
    (OUT / f'{size}.png').write_bytes(render(size))
