# Keeps the top rows of a non-interlaced 8-bit PNG (the filter bytes stay valid when only the bottom rows go).
import struct, sys, zlib
src, dst, H = sys.argv[1], sys.argv[2], int(sys.argv[3])
d = open(src,'rb').read(); pos = 8; idat=b''; ihdr=None
while pos < len(d):
    n, t = struct.unpack('>I4s', d[pos:pos+8]); c = d[pos+8:pos+8+n]; pos += 12+n
    if t==b'IHDR': ihdr=c
    elif t==b'IDAT': idat+=c
w,h,bd,ct,cm,fm,il = struct.unpack('>IIBBBBB', ihdr)
assert il==0 and bd==8
ch={0:1,2:3,3:1,4:2,6:4}[ct]; stride=w*ch+1
raw=zlib.decompress(idat)[:stride*H]
def chunk(t,c): return struct.pack('>I',len(c))+t+c+struct.pack('>I',zlib.crc32(t+c))
out=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,H,bd,ct,cm,fm,il))+chunk(b'IDAT',zlib.compress(raw,9))+chunk(b'IEND',b'')
open(dst,'wb').write(out)
