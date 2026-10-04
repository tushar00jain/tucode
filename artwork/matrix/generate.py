"""Deterministic pixel-art digital rain. Run with Python + Pillow."""
from pathlib import Path
import random
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
R = random.Random(73)
SIZE = 256
im = Image.new('RGB', (SIZE, SIZE), (1, 7, 4))
draw = ImageDraw.Draw(im)
# Hand-drawn 5 by 7 bitmap glyphs: code symbols and angular invented runes.
GLYPHS = [
['01110','10001','10011','10101','11001','10001','01110'],
['00100','01100','00100','00100','00100','00100','01110'],
['11110','00001','00001','01110','10000','10000','11111'],
['11111','00100','00100','00100','00100','00100','00100'],
['10001','01010','00100','01010','10001','00000','00100'],
['00110','01000','01000','10000','01000','01000','00110'],
['01100','00010','00010','00001','00010','00010','01100'],
['00000','00100','01000','10000','01000','00100','00000'],
['00000','00100','00010','00001','00010','00100','00000'],
['10010','10010','11111','00010','00100','01000','10000'],
['11111','00001','00101','00101','00100','01000','10000'],
['00100','11111','00100','01110','10101','00100','00100'],
['10000','10111','10101','11101','00101','00101','00111'],
['11110','10010','10110','10100','10100','10000','11111'],
['01010','11111','01010','01010','11111','01010','00000'],
['11111','10001','00110','00100','00110','10001','11111'],
]

def glyph(x, y, scale, color):
    bits = R.choice(GLYPHS)
    for row, line in enumerate(bits):
        for col, bit in enumerate(line):
            if bit == '1':
                xx, yy = x + col * scale, y + row * scale
                draw.rectangle((xx, yy, xx + scale - 1, yy + scale - 1), fill=color)

# Distant rain: fine, dim, partly broken streams.
for x in range(-2, SIZE, 8):
    head = R.randrange(30, 290)
    length = R.randrange(9, 29)
    for j in range(length):
        y = head - j * 9
        if R.random() < .23:
            continue
        fade = (1 - j / length) ** .8
        green = int(13 + 36 * fade * R.uniform(.5, 1))
        glyph(x, y, 1, (2, green, int(green * .38)))

# Foreground streams: different termination heights and long tapering trails.
heads = [76, 176, 124, 220, 92, 188, 248, 143, 205, 111, 232, 166, 69, 210, 137, 239]
for col, x in enumerate(range(3, 256, 16)):
    head = heads[col]
    length = R.randrange(9, 17)
    strength = R.uniform(.64, 1.0)
    for j in reversed(range(length)):
        y = head - j * 18
        if y < -14 or (j > 3 and R.random() < .12):
            continue
        fade = (1 - j / length) ** 1.65
        g = int((32 + 215 * fade) * strength)
        color = (int(g * .08), g, int(g * .36))
        if j == 0:
            color = (146, 255, 184) if col % 3 else (204, 255, 219)
        elif j == 1:
            color = (44, min(255, g + 20), 103)
        glyph(x, y, 2, color)
    # A second faint segment lets the rain continue through the full square.
    for y in range(head + R.randrange(32, 65), 256, 18):
        if R.random() > .25:
            glyph(x, y, 2, (3, R.randrange(24, 65), 19))

im.resize((1024, 1024), Image.Resampling.NEAREST).save(OUT / 'tucode-matrix.png')
im.save(OUT / 'tucode-matrix-256.png')
print(OUT / 'tucode-matrix.png')
