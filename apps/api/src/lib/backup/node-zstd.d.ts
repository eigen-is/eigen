// Bun implements node:zlib's Zstandard streams, the Node 22 API, but the pinned @types/node (20) predates them.
// Packing an archive needs the streaming form: Bun.zstdCompressSync takes a whole buffer, and an archive is as big
// as the home it holds.

import type { Transform } from 'node:stream';

declare module 'node:zlib' {
    export function createZstdCompress(): Transform;
    export function createZstdDecompress(): Transform;
}
