"""Generate a simple 256x256 ICO for AMLyrics (no external dependencies)."""
import math
import os
import struct

SIZE = 256
os.makedirs(os.path.join(os.path.dirname(__file__), "build"), exist_ok=True)
out = os.path.join(os.path.dirname(__file__), "build", "icon.ico")

# RGBA bitmap, bottom-up rows
pixels = [[(16, 16, 22, 255) for _ in range(SIZE)] for _ in range(SIZE)]

def blend(x, y, color, alpha=255):
    if 0 <= x < SIZE and 0 <= y < SIZE:
        if alpha == 255:
            pixels[y][x] = (color[2], color[1], color[0], 255)  # BGRA
        else:
            r, g, b, a = pixels[y][x]
            pixels[y][x] = (
                int(b * (1 - alpha / 255) + color[2] * alpha / 255),
                int(g * (1 - alpha / 255) + color[1] * alpha / 255),
                int(r * (1 - alpha / 255) + color[0] * alpha / 255),
                255,
            )

# soft circular gradient disc
for y in range(SIZE):
    for x in range(SIZE):
        d = math.hypot(x - 128, y - 128)
        if d < 104:
            t = d / 104
            color = (int(120 - 60 * t), int(226 - 90 * t), int(208 - 70 * t))
            blend(x, y, color, int(255 * (1 - t ** 3)))

# eighth-note: head ellipse + stem + flag
for y in range(SIZE):
    for x in range(SIZE):
        head = ((x - 100) / 30) ** 2 + ((y - 168) / 22) ** 2
        stem = 126 <= x <= 134 and 62 <= y <= 168
        flag = 134 <= x <= 168 and 62 <= y <= 118 and ((y - 62) > (x - 134) * 0.7)
        if head <= 1 or stem or flag:
            blend(x, y, (250, 250, 252), 255)

xor = b"".join(bytes(pixels[y][x][c] for x in range(SIZE) for c in range(4)) for y in range(SIZE - 1, -1, -1))
and_mask = b"\x00" * (SIZE // 8 * SIZE)

header = struct.pack(
    "<IiiHHIIiiII", 40, SIZE, SIZE * 2, 1, 32, 0, len(xor), 0, 0, 0, 0
)
image = header + xor + and_mask
ico = struct.pack("<HHH", 0, 1, 1) + struct.pack(
    "<BBBBHHII", SIZE % 256, SIZE % 256, 0, 0, 1, 32, len(image), 22
) + image
with open(out, "wb") as f:
    f.write(ico)
print("wrote", out, len(ico), "bytes")
