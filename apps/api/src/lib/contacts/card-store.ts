import { randomUUID } from 'node:crypto';
import { EIGEN_ACCENT_COLORS } from '@workspace/lib/constants/colors';
import { eq, sql } from 'drizzle-orm';
import { computeResourceEtag, type Tx as DatabaseTx, PATHS, readBlobTableSize, sanitizeResourceUri } from '../core';
import type { LocalFilesystem } from '../core/local-filesystem';
import type { ParsedCard } from '../vcard/types';
import { CONTACTS_DB_CONFIG } from './db-config';
import * as schema from './schema';

// The card-shaped half of the store over `core/blob-store.ts`. See docs/CONTACTS.md § Storage model.

export type Tx = DatabaseTx<typeof schema>;

const CARD_SUFFIX = '.vcf';
export const CARD_MAX_BYTES = 5_242_880;

// A card's stored size is the length of its bytes; no column beside them can drift from them.
export const cardBytes = sql<number>`length(${schema.contacts.vcard})`;

// Never the blob: a contact list that read every card's bytes would carry the whole book into memory.
export const CONTACT_ROW = {
    id: schema.contacts.id,
    firstName: schema.contacts.firstName,
    lastName: schema.contacts.lastName,
    eigenId: schema.contacts.eigenId,
    data: schema.contacts.data,
    etag: schema.contacts.etag,
};
export type ContactRow = { [K in keyof typeof CONTACT_ROW]: (typeof schema.contacts.$inferSelect)[K] };

// What purgeCard needs of the row it removes: its name for the tombstone, its photo for the cache sweep.
export const PURGED_CARD = {
    id: schema.contacts.id,
    uri: schema.contacts.uri,
    eigenId: schema.contacts.eigenId,
    etag: schema.contacts.etag,
    data: schema.contacts.data,
};
export type PurgedCard = { [K in keyof typeof PURGED_CARD]: (typeof schema.contacts.$inferSelect)[K] };

export function sanitizeCardUri(raw: string): string | null {
    return sanitizeResourceUri(raw, CARD_SUFFIX);
}

// `homeFs` is rooted at the home folder, not at the contacts root.
export async function readContactsTotalSize(homeFs: LocalFilesystem): Promise<number> {
    // The avatars are counted whether or not any card is: a photo outlives the card it was cropped for.
    const avatars = await homeFs.dirSize(`${PATHS.CONTACTS.ROOT}/${PATHS.CONTACTS.AVATARS}`);
    const cards = readBlobTableSize(
        homeFs.absolutePath(PATHS.CONTACTS.DB),
        'contacts',
        'vcard',
        CONTACTS_DB_CONFIG.currentVersion,
    );
    return avatars + cards;
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

// The columns a card write carries; the ctag is stamped inside the write transaction.
export type CardRowInput = Omit<typeof schema.contacts.$inferInsert, 'cardCtag'>;

// Everything a card's own bytes decide; `data` is always there, because writeCard fills the avatar URL into
// it. The caller owns the id, the uri and the server-owned eigenId.
export type CardProjection = Omit<CardRowInput, 'id' | 'uri' | 'eigenId' | 'data'> & { data: CardData };

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
    };
}

// A missing label is minted with its deterministic color, and its id rides back out so the caller emits LABEL_CREATED after the transaction.
export function syncCardLabels(tx: Tx, contactId: string, categories: string[]): string[] {
    const createdLabelIds: string[] = [];
    const labelIds = new Set<string>();
    for (const name of categories) {
        const nameKey = normalizeLabelName(name);
        if (!nameKey) continue;
        const existing = tx
            .select({ id: schema.labels.id })
            .from(schema.labels)
            .where(eq(schema.labels.nameKey, nameKey))
            .get();
        if (existing) {
            labelIds.add(existing.id);
        } else {
            const id = randomUUID();
            tx.insert(schema.labels)
                .values({ id, name: name.trim(), nameKey, color: labelColorFor(nameKey) })
                .run();
            createdLabelIds.push(id);
            labelIds.add(id);
        }
    }

    tx.delete(schema.contactsToLabels).where(eq(schema.contactsToLabels.contactId, contactId)).run();
    for (const labelId of labelIds) {
        tx.insert(schema.contactsToLabels).values({ contactId, labelId }).run();
    }
    return createdLabelIds;
}

// Runs inside the transaction that bumped the ctag, so a card write and a label fan-out leave one shape behind.
export function indexCard(tx: Tx, row: CardRowInput, categories: string[], ctag: number): string[] {
    tx.insert(schema.contacts)
        .values({ ...row, cardCtag: ctag })
        .onConflictDoUpdate({ target: schema.contacts.id, set: cardUpdateSet(row, ctag) })
        .run();

    const createdLabelIds = syncCardLabels(tx, row.id, categories);

    // A card at this uri is alive, so one written over a deleted name drops its stale removal.
    tx.delete(schema.contactTombstones).where(eq(schema.contactTombstones.uri, row.uri)).run();
    return createdLabelIds;
}

// The pure half of a card write: bytes in, the projection they decide out. `avatar` is the cache URL the
// caller resolved, `fallbackUid` the uid a card carrying none keeps from the row it replaces.
export function prepareCard(
    bytes: Uint8Array,
    parsed: ParsedCard,
    avatar: string,
    fallbackUid: string,
): CardProjection {
    return {
        uid: parsed.uid ?? fallbackUid,
        vcard: Buffer.from(bytes),
        firstName: parsed.firstName.trim(),
        lastName: parsed.lastName.trim(),
        isGroup: parsed.isGroup,
        data: parsedToData(parsed, avatar),
        etag: computeResourceEtag(bytes),
    };
}
