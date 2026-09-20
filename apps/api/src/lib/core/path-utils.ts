import * as path from 'node:path';
import { ApiError } from './errors';

// The one rule for a client-chosen name that becomes a path segment — a CardDAV resource name, a calendar id,
// a mail draft id: a leading alphanumeric then `A-Za-z0-9._@-`, which excludes `/`, `..`, leading dots, spaces
// and control characters, capped at 200 chars so `writeAtomic`'s `.`-prefixed temp name stays under NAME_MAX.
// ASCII-only, so a value that passes is byte-identical in every Unicode normal form.
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

export function isSafePathSegment(value: string): boolean {
    return value.length <= 200 && SAFE_PATH_SEGMENT.test(value);
}

export function resolveWithinBase(baseDir: string, key: string): string {
    const resolved = path.resolve(baseDir, key);
    if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
        throw new ApiError(400, 'Invalid storage path: path traversal detected');
    }
    return resolved;
}
