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
// capped at 200 chars (spec § 4, so writeAtomic's `.`-prefixed temp name stays under NAME_MAX) and required
// to end in a literal lowercase `.vcf` (iOS/DAVx⁵/Thunderbird all emit it). The length lives in the
// `length <= 200` check alone; the regex owns only the charset, so the two facts can't drift.
export function sanitizeCardUri(raw: string): string | null {
    const uri = raw.normalize('NFC');
    const valid = uri.length <= 200 && uri.endsWith('.vcf') && /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(uri);
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

// The derived avatar cache lives under `avatars/` as `<contactId>-<hash8>.webp`, hashed by the embedded
// photo bytes so a superseded photo's cache file falls out of reference and the sweep reclaims it.
export function avatarCacheName(contactId: string, bytes: Uint8Array): string {
    return `${contactId}-${computeCardEtag(bytes).slice(0, 8)}.webp`;
}

// The projection URL the contact index stores for an avatar (cache or staged upload), one home for the shape
// so the reconcile/cache/upload seams can't drift on it.
export function avatarUrl(userId: string, name: string): string {
    return `contacts/${userId}/avatar/${name}`;
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

// Sweep crash leftovers from `cards/`: ONLY writeAtomic's own temp files — `.`-prefixed AND carrying the
// `.tmp-` infix it stamps (`.<name>.tmp-<uuid>`). A stray non-`.vcf` (a README, a csv, a mixed-case `.VCF`)
// or a hand-placed dotfile (a `.backup.vcf`) is not temp debris and is left on disk — reconcile and rebuild
// warn-skip it rather than deleting data we didn't create. Safe to run under init's lock.
export async function cleanupTempCardFiles(storage: LocalFilesystem): Promise<void> {
    for (const name of await storage.list(CARDS_DIR)) {
        if (name.startsWith('.') && name.includes('.tmp-')) {
            await storage.delete(cardPath(name));
        }
    }
}

// The one enumerate seam the reconcile, rebuild (and future DAV) passes share: list `cards/`, sort so a
// uriKey collision resolves first-by-sort every pass, sanitize each name to a valid uri (warn-skip a
// non-conforming entry), and fold to its case/normalization key (warn-skip a case-variant duplicate). Returns
// the surviving `{ uri, key }` in sorted order so the self-link tie-break stays stable and the two byte-identical
// warn strings live in exactly one place.
export async function listCardUris(storage: LocalFilesystem): Promise<{ uri: string; key: string }[]> {
    const seen = new Set<string>();
    const entries: { uri: string; key: string }[] = [];
    const names = (await storage.readdir(CARDS_DIR, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    for (const name of names) {
        const uri = sanitizeCardUri(name);
        if (!uri) {
            console.warn(`contacts: ignoring non-conforming entry ${name} in cards/`);
            continue;
        }
        const key = uriKeyOf(uri);
        if (seen.has(key)) {
            console.warn(`contacts: ignoring case-variant duplicate ${name} in cards/`);
            continue;
        }
        seen.add(key);
        entries.push({ uri, key });
    }
    return entries;
}
