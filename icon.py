# 创建一个简单的占位图标（纯色PNG）
#python3 -c "
import struct, zlib

def create_simple_png(size, color):
    def png_chunk(chunk_type, data):
        chunk_len = len(data)
        chunk_data = chunk_type + data
        crc = zlib.crc32(chunk_data) & 0xffffffff
        return struct.pack('>I', chunk_len) + chunk_data + struct.pack('>I', crc)
    
    signature = b'\x89PNG\r\n\x1a\n'
    ihdr_data = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    ihdr = png_chunk(b'IHDR', ihdr_data)
    
    raw_data = b''
    for y in range(size):
        raw_data += b'\x00'
        for x in range(size):
            raw_data += bytes(color)
    
    compressed = zlib.compress(raw_data)
    idat = png_chunk(b'IDAT', compressed)
    iend = png_chunk(b'IEND', b'')
    
    return signature + ihdr + idat + iend

# 蓝紫色图标
png_data = create_simple_png(48, [79, 70, 229])
with open('icon.png', 'wb') as f:
    f.write(png_data)
print('icon created')