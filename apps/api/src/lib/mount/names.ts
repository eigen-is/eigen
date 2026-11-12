// The rules a name in a mount's paths table keeps, how deep a row may sit, and the storage key a flat-key
// backend derives from a name. Mount checks every new row with them, and a backup restore reads archived
// paths tables with them while the API runs, so no import here opens anything.

import { CONTROL_CHARS } from '@workspace/lib/validation';
import { ApiError } from '../core/errors';

// On a `local` mount the trash is the folder `.trash`, so every name the disk folds onto it would be that folder. The
// rule holds on every mount, so an item can always move to another.
export function isReservedName(name: string): boolean {
    return foldName(name) === '.trash';
}

// APFS folds more than toLowerCase() does (ß onto ss, ſ onto s), so this round-trips through upper case.
// The dotless ı stays, since APFS keeps it apart from i, and a decomposed result such as ΐ is composed again.
export function foldName(name: string): string {
    return name
        .split('ı')
        .map((part) => part.toLowerCase().toUpperCase().toLowerCase())
        .join('ı')
        .normalize('NFC');
}

// Filesystem ENAMETOOLONG is a byte limit, not a character limit.
export const MAX_NAME_BYTES = 255;

// The most levels a row sits below its mount's root. Verify and restore walk every row's ancestors on the
// event loop, so a deeper tree would hold the API.
export const MAX_FOLDER_DEPTH = 256;

// Answers without throwing, since a row from an uploaded archive was never held to validateName. Control bytes are
// refused because a name creatable via the API must stay reachable over WebDAV (RFC 4918) and archivable.
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

// A name from outside, such as an upload's, with its slashes made underscores. NFC, as the store keeps it, so the
// name is compared with its siblings in the same form.
export function cleanName(name: string): string {
    return name.replace(/[/\\]/g, '_').normalize('NFC');
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
