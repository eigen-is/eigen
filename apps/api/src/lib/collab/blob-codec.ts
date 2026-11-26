// zstd compression for collab Yjs blobs (doc_snapshots.stateData, doc_updates.updateData) at the SQLite boundary. A
// Yjs snapshot embeds the whole document state verbatim, so a large sheet's rides at ~48 MB raw and ~1 MB compressed.
// A small update stays raw, so a column holds both forms and a read tells them apart by the zstd frame magic. The live
// WebSocket sync and the state route still send raw Yjs updates.

// zstd standard frame magic (little-endian 0xFD2FB528).
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

// Below this, zstd's frame overhead outweighs the gain.
const COMPRESS_MIN_BYTES = 1024;

export function compressBlob(bytes: Uint8Array): Buffer {
    if (bytes.byteLength < COMPRESS_MIN_BYTES) return Buffer.from(bytes);
    return Bun.zstdCompressSync(bytes, { level: 3 });
}

export function decompressBlob(stored: Uint8Array): Uint8Array {
    return isZstd(stored) ? Bun.zstdDecompressSync(stored) : stored;
}

// Off the event loop, for a request that answers a whole document.
export async function decompressBlobAsync(stored: Uint8Array): Promise<Uint8Array> {
    return isZstd(stored) ? Bun.zstdDecompress(stored) : stored;
}

function isZstd(stored: Uint8Array): boolean {
    return ZSTD_MAGIC.every((byte, i) => stored[i] === byte);
}
