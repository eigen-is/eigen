import JSZip from 'jszip';

// A zip whose central directory LIES about its entry's uncompressed size — the shared
// decompression-bomb guard (lib/import/zip-size-guard.ts) reads that number straight
// from the directory and never decompresses, so the fixture needs no real payload.
// Forging keeps the tests off the 200 MB deflate path that made them hit the timeout.
// Fixed zip timestamps keep the bytes stable across runs.

const EPOCH = new Date(Date.UTC(2024, 0, 1));

export async function buildDeclaredSizeBombZip(entryName: string, declaredBytes: number): Promise<Buffer> {
    const zip = new JSZip();
    // The guard rejects before any parser sees the entry, so its content is irrelevant.
    zip.file(entryName, Buffer.from('<xml/>'), { date: EPOCH });
    const honest = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    return forgeCentralDirUncompressedSize(honest, declaredBytes);
}

// Forge the uncompressedSize a zip DECLARES for its file entries, so the declared size no
// longer matches the DEFLATE stream's true output. Walk the central directory (located via
// the End Of Central Directory record, PK\x05\x06 → CD offset at +16), and rewrite the
// uncompressedSize field (+24) of every central header (PK\x01\x02) that declares content —
// JSZip prepends zero-size directory entries (`word/`, `xl/worksheets/`) for a nested path, so
// the real file entry is not the first. Walking the CD (fixed 46-byte header + name + extra +
// comment) lands the patch precisely and skips false signature hits in the compressed data.
function forgeCentralDirUncompressedSize(zip: Buffer, forgedSize: number): Buffer {
    const out = Buffer.from(zip);
    let eocd = out.length - 22;
    while (eocd >= 0 && out.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error('EOCD not found');
    let p = out.readUInt32LE(eocd + 16);
    let patched = 0;
    while (p < eocd && out.readUInt32LE(p) === 0x02014b50) {
        if (out.readUInt32LE(p + 24) > 0) {
            out.writeUInt32LE(forgedSize, p + 24);
            patched++;
        }
        p += 46 + out.readUInt16LE(p + 28) + out.readUInt16LE(p + 30) + out.readUInt16LE(p + 32);
    }
    if (patched === 0) throw new Error('no file entry to forge');
    return out;
}
