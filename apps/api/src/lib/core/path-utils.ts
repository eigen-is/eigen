import * as path from 'node:path';
import { ApiError } from './errors';

// The one rule for a client-chosen name that becomes a path segment: no `/`, no `..`, no leading dot, no
// space, no control character. Unicode letters, marks and numbers are in — the callers fold to NFC first,
// so one spelling reaches the filesystem.
const SAFE_PATH_SEGMENT = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._@-]*$/u;

// Budgeted in bytes, not characters, so `writeAtomic`'s `.`-prefixed temp name stays under NAME_MAX (255)
// for an accented name too.
const SEGMENT_MAX_BYTES = 200;

export function isSafePathSegment(value: string): boolean {
    return Buffer.byteLength(value) <= SEGMENT_MAX_BYTES && SAFE_PATH_SEGMENT.test(value);
}

export function resolveWithinBase(baseDir: string, key: string): string {
    const resolved = path.resolve(baseDir, key);
    if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
        throw new ApiError(400, 'Invalid storage path: path traversal detected');
    }
    return resolved;
}
