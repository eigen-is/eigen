import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import { EIGEN_ACCENT_COLORS } from '@workspace/lib/constants/colors';
import { sql } from 'drizzle-orm';
import { computeResourceEtag, PATHS, sanitizeResourceUri } from '../core';
import type { LocalFilesystem } from '../core/local-filesystem';
import type { ParsedCard } from '../vcard/types';
import * as schema from './schema';

// The card-shaped half of the store over `core/blob-store.ts`. See docs/CONTACTS.md § Storage model.

const CARD_SUFFIX = '.vcf';
export const CARD_MAX_BYTES = 5_242_880;

// A card's stored size is the length of its bytes; no column beside them can drift from them.
export const cardBytes = sql<number>`length(${schema.contacts.vcard})`;

export function sanitizeCardUri(raw: string): string | null {
    return sanitizeResourceUri(raw, CARD_SUFFIX);
}

// Sizes Contacts for a Home nobody booted; `homeFs` is rooted at the home folder, not at the contacts root.
// Read-write on purpose, following mount/helpers.ts readMountTotalSize: a read-only open of a WAL database
// whose owner is not holding it open fails outright.
export async function readContactsTotalSize(homeFs: LocalFilesystem): Promise<number> {
    // The avatars are counted whether or not any card is: a photo outlives the card it was cropped for.
    const total = await homeFs.dirSize(`${PATHS.CONTACTS.ROOT}/${PATHS.CONTACTS.AVATARS}`);
    const dbPath = homeFs.absolutePath(PATHS.CONTACTS.DB);
    if (!fs.existsSync(dbPath)) return total;
    const db = new Database(dbPath, { readwrite: true, create: false });
    try {
        db.run('PRAGMA busy_timeout = 5000;');
        const row = db
            .query<{ cards: number }, []>('SELECT COALESCE(SUM(length(vcard)), 0) AS cards FROM contacts')
            .get();
        return total + (row?.cards ?? 0);
    } finally {
        db.close();
    }
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

// One home for the avatar URL shape and its inverse, so the cache and upload seams can't drift.
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

// The columns a card write carries; the ctag + timestamps are stamped inside the write transaction.
export type CardRowInput = Omit<typeof schema.contacts.$inferInsert, 'cardCtag' | 'createdAt' | 'updatedAt'>;

// Everything a card's own bytes decide. The caller owns the id, the uri and the server-owned eigenId.
export type CardProjection = Omit<CardRowInput, 'id' | 'uri' | 'eigenId'>;

// `avatar` is the cache URL only — inline photo bytes never enter the index.
export type CardData = NonNullable<(typeof schema.contacts.$inferSelect)['data']>;

// The projection from a parsed card; `avatar` is the derived cache URL the caller resolved.
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

// eigenId stays out: resolveSelfLink and resolveSelfLinkOnPut own the self-link and spread it back in.
export function cardUpdateSet(row: CardRowInput, ctag: number) {
    return {
        uri: row.uri,
        uid: row.uid,
        vcard: row.vcard,
        firstName: row.firstName,
        lastName: row.lastName,
        isGroup: row.isGroup,
        data: row.data,
        etag: row.etag,
        cardCtag: ctag,
        updatedAt: sql`unixepoch()`,
    };
}

// The pure half of a card write: bytes in, the projection they decide out. `avatar` is the cache URL the
// caller resolved, `fallbackUid` the uid a card carrying none keeps from the row it replaces.
export function prepareCard(
    bytes: Uint8Array,
    parsed: ParsedCard,
    avatar: string,
    fallbackUid: string,
): { projection: CardProjection; categories: string[] } {
    return {
        projection: {
            uid: parsed.uid ?? fallbackUid,
            vcard: Buffer.from(bytes),
            firstName: parsed.firstName.trim(),
            lastName: parsed.lastName.trim(),
            isGroup: parsed.isGroup,
            data: parsedToData(parsed, avatar),
            etag: computeResourceEtag(bytes),
        },
        categories: parsed.categories,
    };
}
