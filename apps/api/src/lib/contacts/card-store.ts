// Plain helpers over the vCard card files and their derived keys — the storage seam Tasks 8–13 build the
// file-backed Contacts refit on. `Contacts` stays the facade; these are the mount/*.ts-style free functions.
// The cards live under `cards/` in the contacts home; each is one vCard whose filename is its CardDAV
// resource name (uri).
import { EIGEN_ACCENT_COLORS } from '@workspace/lib/constants/colors';
import type { LocalFilesystem } from '../core/local-filesystem';

export const CARDS_DIR = 'cards';
export const CARD_MAX_BYTES = 5_242_880;

export function cardPath(uri: string): string {
    return `${CARDS_DIR}/${uri}`;
}

// A client-chosen resource name that is safe as both a filename and a DAV href. NFC-normalized, a leading
// alphanumeric, then only `A-Za-z0-9._@-` — which excludes `/`, `..`, leading dots and control characters —
// capped at 255 bytes and required to end in a literal lowercase `.vcf` (iOS/DAVx⁵/Thunderbird all emit it).
export function sanitizeCardUri(raw: string): string | null {
    const uri = raw.normalize('NFC');
    const valid = uri.length <= 255 && uri.endsWith('.vcf') && /^[A-Za-z0-9][A-Za-z0-9._@-]{0,250}$/.test(uri);
    return valid ? uri : null;
}

// Case- and normalization-insensitive key for uri uniqueness (a file system may fold case; two uris that
// differ only in case or Unicode form are the same card).
export function uriKeyOf(uri: string): string {
    return uri.normalize('NFC').toLowerCase();
}

export function computeCardEtag(bytes: Uint8Array): string {
    return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

export function normalizeLabelName(name: string): string {
    return name.normalize('NFC').trim().toLowerCase();
}

// Deterministic accent color for a label, so the same name always renders the same color across books and
// sessions. FNV-1a over the normalized key gives a stable, well-spread index into the accent palette.
export function labelColorFor(nameKey: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < nameKey.length; i++) {
        hash ^= nameKey.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return EIGEN_ACCENT_COLORS[(hash >>> 0) % EIGEN_ACCENT_COLORS.length].value;
}

export async function writeCardFile(
    storage: LocalFilesystem,
    uri: string,
    bytes: Uint8Array,
): Promise<{ mtime: number; size: number }> {
    const filePath = cardPath(uri);
    await storage.writeAtomic(filePath, bytes);
    const stat = await storage.stat(filePath);
    return { mtime: stat.mtimeMs, size: stat.size };
}

// Sweep crash leftovers from `cards/`: the `.`-prefixed temp files a torn writeAtomic can leave, plus any
// stray non-`.vcf` entry. Safe to run under init's lock, before the directory is scanned into the index.
export async function cleanupTempCardFiles(storage: LocalFilesystem): Promise<void> {
    for (const name of await storage.list(CARDS_DIR)) {
        if (name.startsWith('.') || !name.endsWith('.vcf')) {
            await storage.delete(cardPath(name));
        }
    }
}
