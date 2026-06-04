// zstd compression for collab Yjs blobs (doc_snapshots.stateData, doc_updates.updateData).
// A Yjs snapshot embeds the whole document state verbatim — for a large sheet the JSON
// snapshot string rides inside the update uncompressed (~48MB). zstd level 3 takes that to
// ~1MB at ~28ms encode / ~18ms decode. Compression is at the SQLite storage boundary only;
// the live WebSocket sync protocol still exchanges raw Yjs updates.
//
// Backward compatible: legacy blobs are raw Yjs updates. The full 4-byte zstd frame magic
// (28 b5 2f fd) cannot plausibly arise from lib0-encoded Yjs data — a V1 update opens with the
// state-vector client count (so byte 0 is 0x28 only with exactly 40 clients) and V2 opens with
// 0x00, after which the three trailing magic bytes would have to match an improbable struct
// sequence. decompressBlob sniffs the 4-byte magic and passes legacy/raw blobs through untouched
// (the < 4 guard also covers the 2-byte empty-doc update [0, 0]); a false positive would throw
// in the caller's existing try/catch and skip that one row — losing one update's edits, or a
// snapshot's consolidated pre-history — rather than silently corrupting state. No schema
// migration — the BLOB column stores either form, and old/new rows coexist because each row is
// decoded independently.

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
