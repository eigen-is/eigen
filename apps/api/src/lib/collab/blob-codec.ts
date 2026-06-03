// zstd compression for collab Yjs blobs (doc_snapshots.stateData, doc_updates.updateData).
// A Yjs snapshot embeds the whole document state verbatim — for a large sheet the JSON
// snapshot string rides inside the update uncompressed (~48MB). zstd level 3 takes that to
// ~1MB at ~28ms encode / ~18ms decode. Compression is at the SQLite storage boundary only;
// the live WebSocket sync protocol still exchanges raw Yjs updates.
//
// Backward compatible: legacy blobs were raw Yjs updates, which start with 0x00 or 0x01 (the
// lib0 update format bytes) — never 0x28. zstd frames start with the 4-byte magic 28 b5 2f fd,
// so decompressBlob sniffs the magic and passes legacy/raw blobs through untouched (the < 4
// guard also covers the 2-byte empty-doc update [0, 0]). No schema migration — the BLOB column
// stores either form, and old/new rows coexist because each row is decoded independently.

// zstd standard frame magic (little-endian 0xFD2FB528).
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

// Below this, zstd's frame overhead outweighs the gain — keystroke-sized Yjs updates stay
// raw. The wins (snapshots, sheet whole-doc flushes) are far above it. Tunable.
const COMPRESS_MIN_BYTES = 1024;

export function compressBlob(bytes: Uint8Array): Buffer {
    if (bytes.byteLength < COMPRESS_MIN_BYTES) return Buffer.from(bytes);
    return Bun.zstdCompressSync(bytes, { level: 3 });
}

export function decompressBlob(stored: Uint8Array): Uint8Array {
    if (stored.byteLength < 4) return stored;
    const isZstd =
        stored[0] === ZSTD_MAGIC[0] &&
        stored[1] === ZSTD_MAGIC[1] &&
        stored[2] === ZSTD_MAGIC[2] &&
        stored[3] === ZSTD_MAGIC[3];
    return isZstd ? Bun.zstdDecompressSync(stored) : stored;
}
