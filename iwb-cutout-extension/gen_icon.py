import struct, zlib

def create_png(width, height, pixels):
    def make_chunk(chunk_type, data):
        c = chunk_type + data
        crc = struct.pack('>I', zlib.crc32(c) & 0xffffffff)
        return struct.pack('>I', len(data)) + c + crc
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    raw = b''
    for y in range(height):
        raw += b'\x00'
        for x in range(width):
            idx = (y * width + x) * 4
            raw += bytes(pixels[idx:idx+4])
    compressed = zlib.compress(raw)
    return sig + make_chunk(b'IHDR', ihdr) + make_chunk(b'IDAT', compressed) + make_chunk(b'IEND', b'')

def draw_icon(size):
    pixels = bytearray(size * size * 4)
    margin = size // 8
    r = size // 6
    icon_color = [255, 255, 255, 255]
    
    for y in range(size):
        for x in range(size):
            idx = (y * size + x) * 4
            in_rect = margin <= x < size - margin and margin <= y < size - margin
            if in_rect:
                corners = [
                    (margin + r, margin + r),
                    (size - margin - r - 1, margin + r),
                    (margin + r, size - margin - r - 1),
                    (size - margin - r - 1, size - margin - r - 1)
                ]
                in_corner = False
                for ccx, ccy in corners:
                    dx = abs(x - ccx)
                    dy = abs(y - ccy)
                    if dx < r and dy < r and (dx*dx + dy*dy) > r*r:
                        in_corner = True
                        break
                if in_corner:
                    pixels[idx:idx+4] = [0, 0, 0, 0]
                    continue
                t = y / size
                pixels[idx:idx+4] = [int(232 - t * 40), int(167 - t * 30), int(53 - t * 10), 255]
            else:
                pixels[idx:idx+4] = [0, 0, 0, 0]
    
    # Draw scissors: two circles + crossing lines
    r1 = max(size // 8, 3)
    c1x, c1y = size // 2 - size // 6, size // 2 - size // 6
    c2x, c2y = size // 2 - size // 6, size // 2 + size // 6
    
    for y in range(size):
        for x in range(size):
            idx = (y * size + x) * 4
            if pixels[idx + 3] == 0:
                continue
            d1 = ((x - c1x)**2 + (y - c1y)**2) ** 0.5
            d2 = ((x - c2x)**2 + (y - c2y)**2) ** 0.5
            ring_w = max(2, size // 24)
            if abs(d1 - r1) < ring_w or abs(d2 - r1) < ring_w:
                pixels[idx:idx+4] = icon_color
            # Crossing lines
            lw = max(1, size // 32)
            # Line 1: c1 -> right
            for t in range(200):
                px = int(c1x + t * size / 200)
                py = int(c1y + t * size / 200)
                if abs(x - px) < lw and abs(y - py) < lw:
                    pixels[idx:idx+4] = icon_color
            # Line 2: c2 -> right
            for t in range(200):
                px = int(c2x + t * size / 200)
                py = int(c2y - t * size / 200)
                if abs(x - px) < lw and abs(y - py) < lw:
                    pixels[idx:idx+4] = icon_color
    return pixels

for size, name in [(48, 'icon48.png'), (128, 'icon128.png')]:
    pixels = draw_icon(size)
    png_data = create_png(size, size, pixels)
    path = f'D:/sync/obsidian/card/iwb-plaus/iwb-cutout-extension/icons/{name}'
    with open(path, 'wb') as f:
        f.write(png_data)
    print(f'Created {name} ({len(png_data)} bytes)')
