import type JSZip from 'jszip';
import { ApiError } from '../core/errors';

// xlsx and docx are both zips, and the upload route only bounds the COMPRESSED bytes
// (getUploadMaxSize, default 35 MB / mount quota) — so a decompression bomb, a few KB of
// highly compressible bytes, expands to many GB in memory and OOM-kills the process,
// dropping every Home on the box. Both parsers (exceljs, mammoth) inflate the whole
// package unconditionally and that OOM is not catchable, so the caps below run BEFORE the
// parser sees the buffer.
//
// Byte cap: total inflated bytes across all zip entries. A legit DENSE spreadsheet at the
// importer's cell cap decompresses to ~140 MB (measured ~35 bytes per populated cell of
// worksheet + deduped sharedStrings XML), comfortably under 200 MB, and a document that
// large is far past anything a word processor authors. 200 MB also sits far below the
// ~36 GB an honest 35 MB-compressed bomb declares.
const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;

// JSZip records each entry's declared uncompressed size (from the zip central directory)
// on a private `_data`; reading it does NOT decompress. Public typings omit it.
type JSZipEntryInternals = { _data?: { uncompressedSize?: number } };

// internalStream decompresses lazily and emits the ACTUAL bytes in ~16 KB chunks; pausing
// propagates upstream to the source worker, stopping pako mid-inflate (public typings omit
// both). The streaming belt below relies on that pause for backpressure.
type JSZipByteStream = {
    on(event: 'data', handler: (chunk: Uint8Array) => void): JSZipByteStream;
    on(event: 'end', handler: () => void): JSZipByteStream;
    on(event: 'error', handler: (err: unknown) => void): JSZipByteStream;
    pause(): JSZipByteStream;
    resume(): JSZipByteStream;
};
type JSZipStreamable = { internalStream(type: 'uint8array'): JSZipByteStream };

// `tooLargeMessage` is the 413 body the format's route surfaces ("Spreadsheet too large",
// "Document too large"). Declared-size is the fast reject (an honest bomb dies with ZERO
// decompression); the streaming pass is the belt that closes the forged-central-directory
// case before the parser re-inflates the entries.
export async function assertDecompressedSizeWithinBounds(zip: JSZip, tooLargeMessage: string): Promise<void> {
    assertDeclaredSizeWithinBounds(zip, tooLargeMessage);
    await assertActualSizeWithinBounds(zip, tooLargeMessage);
}

function assertDeclaredSizeWithinBounds(zip: JSZip, tooLargeMessage: string): void {
    let total = 0;
    for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        total += (entry as unknown as JSZipEntryInternals)._data?.uncompressedSize ?? 0;
        if (total > MAX_DECOMPRESSED_BYTES) throw new ApiError(413, tooLargeMessage);
    }
}

// The declared-size guard trusts the central-directory uncompressedSize, which an attacker
// can forge SMALL while the DEFLATE stream actually inflates to tens of GB — the parser
// would then inflate the entry unconditionally (→ uncatchable OOM). Stream-decompress every
// entry, keep a running total of ACTUAL bytes across the whole package, discard each chunk
// (memory stays ~one chunk), and reject the moment the total crosses the cap. Pausing stops
// the upstream source worker (backpressure), so pako inflates no further — memory stays flat
// even against a 36 GB bomb. Entries are processed sequentially so the running total is
// exact and only one entry inflates at a time.
async function assertActualSizeWithinBounds(zip: JSZip, tooLargeMessage: string): Promise<void> {
    let total = 0;
    for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        const stream = (entry as unknown as JSZipStreamable).internalStream('uint8array');
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            stream
                .on('data', (chunk) => {
                    if (settled) return;
                    total += chunk.length;
                    if (total > MAX_DECOMPRESSED_BYTES) {
                        settled = true;
                        stream.pause();
                        reject(new ApiError(413, tooLargeMessage));
                    }
                })
                .on('error', (err) => {
                    if (settled) return;
                    settled = true;
                    reject(err);
                })
                .on('end', () => {
                    if (settled) return;
                    settled = true;
                    resolve();
                })
                .resume();
        });
    }
}
