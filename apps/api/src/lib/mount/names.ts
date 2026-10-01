import { ApiError } from '../core/errors';

// The rules a name in a mount's paths table keeps, and the storage key a flat-key backend derives from one. No
// import here opens anything: a backup restore reads archived paths tables with them while the API runs.

// Reserved: any case variant of `.trash` aliases the real trash dir (Mount.trashDir) on path-based mounts.
// Also checked on move (updatePath) so a legacy pre-guard row can't be re-parented onto the alias.
// NFKC before folding: APFS equates compatibility characters ('.traſh' with U+017F IS '.trash'),
// which plain toLowerCase misses.
export function isReservedName(name: string): boolean {
    return name.normalize('NFKC').toLowerCase() === '.trash';
}

// Control bytes (incl. NUL) are rejected in both names and WebDAV path segments — a name creatable
// via the API must stay reachable over WebDAV, which rejects this range per RFC 4918.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point
export const CONTROL_CHARS = /[\x00-\x1f]/;

// Filesystem ENAMETOOLONG is a byte limit, not a character limit.
export const MAX_NAME_BYTES = 255;

// One path segment and nothing else, answered without throwing: an archived paths table is held to
// the rule validateName writes live rows by, and a row that came in inside an uploaded archive has
// never been held to anything.
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
