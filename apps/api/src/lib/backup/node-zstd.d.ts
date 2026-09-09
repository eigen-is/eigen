import type { Transform } from 'node:stream';

// Bun implements node:zlib's Zstandard streams (the Node 22 API); the pinned @types/node (20)
// predates them. archive.ts needs the streaming form — Bun.zstdCompressSync takes a whole buffer,
// and an artifact is as big as the home it holds.
declare module 'node:zlib' {
    export function createZstdCompress(): Transform;
    export function createZstdDecompress(): Transform;
}
