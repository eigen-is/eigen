import { EIGEN_ACCENT_COLORS } from '@workspace/lib/constants/colors';
import { sql } from 'drizzle-orm';
import { computeResourceEtag, PATHS, type ResourceScan, sanitizeResourceUri, statResourceDir } from '../core';
import type { LocalFilesystem } from '../core/local-filesystem';
import type { ParsedCard } from '../vcard/types';
import type * as schema from './schema';

// The card-shaped half of the store over `core/indexed-file-store.ts`. See docs/CONTACTS.md § Storage model.

const CARD_SUFFIX = '.vcf';
export const CARD_MAX_BYTES = 5_242_880;

export function cardPath(uri: string): string {
    return `${PATHS.CONTACTS.CARDS}/${uri}`;
}

export function sanitizeCardUri(raw: string): string | null {
    return sanitizeResourceUri(raw, CARD_SUFFIX);
}

export function statCardDir(storage: LocalFilesystem): Promise<ResourceScan> {
    return statResourceDir(storage, PATHS.CONTACTS.CARDS, CARD_SUFFIX);
}

// The card bytes of a Home nobody has booted, read from its own folder for the admin usage view. Counts
// what `Contacts.cardsBytes` counts, through the same scan. `homeFs` is rooted at the home folder, not at
// the contacts root.
export async function readCardsTotalSize(homeFs: LocalFilesystem): Promise<number> {
    const cards = `${PATHS.CONTACTS.ROOT}/${PATHS.CONTACTS.CARDS}`;
    if (!(await homeFs.dirExists(cards))) return 0;
    const scan = await statResourceDir(homeFs, cards, CARD_SUFFIX);
    let total = 0;
    for (const file of scan.files.values()) total += file.size;
    return total;
}

// Hashed by the photo bytes, so a superseded photo's cache falls out of reference and the sweep reclaims it.
export function avatarCacheName(contactId: string, bytes: Uint8Array): string {
    return `${contactId}-${computeResourceEtag(bytes).slice(0, 8)}.webp`;
}

const CONTACT_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'; // randomUUID()
const PHOTO_HASH = '[0-9a-f]{8}'; // avatarCacheName's hash suffix

// Serving from `avatars/` is allowlisted to the two webp names — a staged upload and a derived photo cache —
// so separators, `..` and control characters are refused by construction rather than one blocklist at a time.
export const AVATAR_FILENAME = new RegExp(`^${CONTACT_ID}(-${PHOTO_HASH})?\\.webp$`);
const OWN_PHOTO_CACHE = new RegExp(`^${PHOTO_HASH}\\.webp$`);

// Historical rows may share a staged or legacy name another row still references, so only a card's own hash
// cache is safe to unlink along with it.
export function isCardPhotoCacheOf(contactId: string, filename: string): boolean {
    return filename.startsWith(`${contactId}-`) && OWN_PHOTO_CACHE.test(filename.slice(contactId.length + 1));
}

// The Apple-safe embed sibling `uploadAvatar` stages next to the served `<uuid>.webp`: the exact PHOTO bytes a
// save embeds verbatim. Keyed by the encoder format so the extension, the vCard media type and the allowlist
// shape are one source of truth. Never served — only read back by `resolveStagedAvatar` and then swept.
const STAGED_EMBED_FORMATS = {
    jpeg: { ext: 'jpg', mediaType: 'image/jpeg' },
    png: { ext: 'png', mediaType: 'image/png' },
    gif: { ext: 'gif', mediaType: 'image/gif' },
} as const;
export type EmbedFormat = keyof typeof STAGED_EMBED_FORMATS;

function stagedBase(webpName: string): string {
    return webpName.replace(/\.webp$/, '');
}

export function stagedEmbedName(webpName: string, format: EmbedFormat): string {
    return `${stagedBase(webpName)}.embed.${STAGED_EMBED_FORMATS[format].ext}`;
}

// The order `resolveStagedAvatar` probes in; exactly one sibling is ever written per upload.
export function stagedEmbedCandidates(webpName: string): { name: string; mediaType: string }[] {
    const base = stagedBase(webpName);
    return Object.values(STAGED_EMBED_FORMATS).map((f) => ({ name: `${base}.embed.${f.ext}`, mediaType: f.mediaType }));
}

// The URL shape the index stores for an avatar (cache or staged upload), and its inverse — one home for both
// so the reconcile/cache/upload seams can't drift on it.
export function avatarUrl(userId: string, name: string): string {
    return `contacts/${userId}/avatar/${name}`;
}

export function avatarNameOf(url: string): string {
    return url.slice(url.lastIndexOf('/') + 1);
}

export function normalizeLabelName(name: string): string {
    return name.normalize('NFC').trim().toLowerCase();
}

// FNV-1a over the normalized key, so a label name renders the same color across books and sessions.
export function labelColorFor(nameKey: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < nameKey.length; i++) {
        hash ^= nameKey.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return EIGEN_ACCENT_COLORS[(hash >>> 0) % EIGEN_ACCENT_COLORS.length].value;
}

// The columns a card (re)index computes; the ctag + timestamps are stamped inside the write transaction.
export type CardRowInput = Omit<typeof schema.contacts.$inferInsert, 'cardCtag' | 'createdAt' | 'updatedAt'>;

// The index-stored projection: the owned properties minus what lives in dedicated columns (names/eigenId)
// or the junction (labels). `avatar` is the cache URL only — inline photo bytes never enter the index.
export type CardData = NonNullable<(typeof schema.contacts.$inferSelect)['data']>;

// The projection from a parsed card file; `avatar` is the derived cache URL the caller resolved.
export function parsedToData(parsed: ParsedCard, avatar: string): CardData {
    return {
        email: parsed.email,
        phone: parsed.phone,
        company: parsed.company,
        jobTitle: parsed.jobTitle,
        address: parsed.address,
        birthday: parsed.birthday,
        notes: parsed.notes,
        avatar,
    };
}

// The columns an upsert of an indexed card refreshes (uri/uriKey/uid follow the file). eigenId is not in
// here: the self-link is managed by resolveSelfLink and the reconcile rematch, which spreads it back in.
export function cardUpdateSet(row: CardRowInput, ctag: number) {
    return {
        uri: row.uri,
        uriKey: row.uriKey,
        uid: row.uid,
        firstName: row.firstName,
        lastName: row.lastName,
        isGroup: row.isGroup,
        data: row.data,
        etag: row.etag,
        cardCtag: ctag,
        mtime: row.mtime,
        size: row.size,
        updatedAt: sql`unixepoch()`,
    };
}
