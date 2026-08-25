import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { compressBlob, decompressBlob } from '../../lib/collab/blob-codec';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

describe('blob-codec', () => {
    test('large compressible buffer becomes a smaller zstd frame', () => {
        const big = Buffer.from('row,'.repeat(5000));
        const out = compressBlob(big);
        expect(out.byteLength).toBeLessThan(big.byteLength);
        expect(out.subarray(0, 4)).toEqual(ZSTD_MAGIC);
    });

    test('round-trips a large buffer losslessly', () => {
        const big = Buffer.from(JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ r: i, c: 0, v: i }))));
        expect(Buffer.from(decompressBlob(compressBlob(big)))).toEqual(big);
    });

    test('tiny buffer below threshold is stored raw (no zstd frame)', () => {
        const small = Buffer.from([1, 2, 3, 4, 5]);
        const out = compressBlob(small);
        expect(Buffer.from(out)).toEqual(small);
        expect(out.subarray(0, 4)).not.toEqual(ZSTD_MAGIC);
    });

    test('decompressBlob passes legacy raw bytes through unchanged', () => {
        // Legacy blobs are raw Yjs updates — they start with 0x01, never the zstd magic.
        const raw = Buffer.from([1, 1, 200, 7, 0, 42, 99]);
        expect(Buffer.from(decompressBlob(raw))).toEqual(raw);
    });

    test('decompressBlob tolerates buffers shorter than the magic', () => {
        const tiny = Buffer.from([0, 0]);
        expect(Buffer.from(decompressBlob(tiny))).toEqual(tiny);
    });

    test('real Yjs update survives compress -> decompress -> applyUpdate', () => {
        const doc = new Y.Doc();
        doc.getMap('state').set('snapshot', 'x'.repeat(5000));
        const update = Y.encodeStateAsUpdate(doc);
        const restored = new Y.Doc();
        Y.applyUpdate(restored, decompressBlob(compressBlob(update)));
        expect(restored.getMap('state').get('snapshot')).toBe('x'.repeat(5000));
    });
});
