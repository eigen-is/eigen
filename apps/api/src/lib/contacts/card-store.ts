import { EIGEN_ACCENT_COLORS } from '@workspace/lib/constants/colors';
import { sql } from 'drizzle-orm';
import { computeResourceEtag, PATHS, type ResourceScan, sanitizeResourceUri, statResourceDir } from '../core';
import type { LocalFilesystem } from '../core/local-filesystem';
import type { ParsedCard } from '../vcard/types';
import type * as schema from './schema';

// The card-shaped half of the store over `core/indexed-file-store.ts`. See docs/CONTACTS.md § Storage model — files as truth.

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

// Sizes Contacts for a Home nobody booted; `homeFs` is rooted at the home folder, not at the contacts root.
export async function readContactsTotalSize(homeFs: LocalFilesystem): Promise<number> {
    const cards = `${PATHS.CONTACTS.ROOT}/${PATHS.CONTACTS.CARDS}`;
    // The avatars are counted whether or not any card is: a photo outlives the card it was cropped for.
    let total = await homeFs.dirSize(`${PATHS.CONTACTS.ROOT}/${PATHS.CONTACTS.AVATARS}`);
    if (!(await homeFs.dirExists(cards))) return total;
    const scan = await statResourceDir(homeFs, cards, CARD_SUFFIX);
    for (const file of scan.files.values()) total += file.size;
    return total;
}

// Hashed by the photo bytes, so a superseded photo's cache falls out of reference and the sweep reclaims it.
export function avatarCacheName(contactId: string, bytes: Uint8Array): string {
    return `${contactId}-${computeResourceEtag(bytes).slice(0, 8)}.webp`;
}

const CONTACT_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'; // randomUUID()
const PHOTO_HASH = '[0-9a-f]{8}'; // avatarCacheName's hash suffix

// Allowlisting the two served webp names refuses separators, `..` and control characters by construction.
export const AVATAR_FILENAME = new RegExp(`^${CONTACT_ID}(-${PHOTO_HASH})?\\.webp$`);
const OWN_PHOTO_CACHE = new RegExp(`^${PHOTO_HASH}\\.webp$`);

// Another row may still reference a staged or legacy name, so only a card's own hash cache is safe to unlink.
export function isCardPhotoCacheOf(contactId: string, filename: string): boolean {
    return filename.startsWith(`${contactId}-`) && OWN_PHOTO_CACHE.test(filename.slice(contactId.length + 1));
}

// Staged beside the served webp: the exact PHOTO bytes a save embeds verbatim for Apple, never served itself.
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

// One home for the avatar URL shape and its inverse, so the reconcile, cache and upload seams can't drift.
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

// `avatar` is the cache URL only — inline photo bytes never enter the index.
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

// eigenId stays out: resolveSelfLink and the reconcile rematch own the self-link and spread it back in.
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
