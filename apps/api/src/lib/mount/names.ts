// The rules a name in a mount's paths table keeps, and the storage key a flat-key backend derives from
// one. Mount checks every new name with them, and a backup restore reads archived paths tables with them
// while the API runs, so no import here opens anything.

import { CONTROL_CHARS } from '@workspace/lib/validation';
import { ApiError } from '../core/errors';

// On a `local` mount the trash is the folder `.trash`, and every name the disk folds onto it would be
// that folder. The rule holds on every mount, so an item can always move to another one. A move checks
// it too, because a row can carry the name from before the rule.
export function isReservedName(name: string): boolean {
    return foldName(name) === '.trash';
}

// Two names that fold alike are one file on a case-insensitive disk such as APFS, which folds more than
// toLowerCase() does (ß onto ss, ſ onto s, ﬃ onto ffi). The round trip through upper case gets those.
// The dotless ı is kept as it is: the round trip would make it i, but APFS keeps ı and i apart.
// The round trip can leave a letter decomposed, such as ΐ, so the result is composed again.
export function foldName(name: string): string {
    return name
        .split('ı')
        .map((part) => part.toLowerCase().toUpperCase().toLowerCase())
        .join('ı')
        .normalize('NFC');
}

// Filesystem ENAMETOOLONG is a byte limit, not a character limit.
export const MAX_NAME_BYTES = 255;

// One path segment and nothing else, answered without throwing: an archived paths table is held to
// the rule validateName writes live rows by, and a row that came in inside an uploaded archive has
// never been held to anything. Control bytes (incl. NUL and DEL) are refused because a name creatable
// via the API must stay reachable over WebDAV, which rejects them per RFC 4918, and archivable by a
// backup, whose path check refuses the same range.
export function isUsableName(name: string): boolean {
    if (!name || name === '.' || name === '..') return false;
    return !(name.includes('/') || name.includes('\\') || CONTROL_CHARS.test(name));
}

export function validateName(name: string): string {
    if (!isUsableName(name)) {
        throw new ApiError(400, `Invalid file or folder name: "${name}"`);
    }
    // Store NFC so a decomposed (NFD) name still matches the NFC-normalized getChildByName/resolvePath lookups.
    const normalized = name.normalize('NFC');
    if (isReservedName(normalized)) {
        throw new ApiError(400, `"${name}" is a reserved name`);
    }
    if (Buffer.byteLength(normalized, 'utf8') > MAX_NAME_BYTES) {
        throw new ApiError(400, `File or folder name too long (max ${MAX_NAME_BYTES} bytes)`);
    }
    return normalized;
}

export function buildStorageKey(id: string, name: string): string {
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx > 0) {
        const ext = name.slice(dotIdx + 1).toLowerCase();
        if (ext.length > 0 && ext.length <= 12) {
            return `${id}.${ext}`;
        }
    }
    return id;
}

// Where trashPath moves a trash root's bytes on a path-based mount, and what it writes into the row's `file`.
export function trashStorageKey(id: string, name: string): string {
    return `.trash/${buildStorageKey(id, name)}`;
}
