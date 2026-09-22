import { randomUUID } from 'node:crypto';
import { eq, gt } from 'drizzle-orm';
import {
    ApiError,
    type DeleteResourceResult,
    matchesIfMatch,
    matchesIfNoneMatch,
    normalizeResourceUri,
    type PutResourceResult,
    type ResourcePreconditions,
} from '../core';
import { pushUserProfile } from '../home/home-relay';
import { mergeVCard, parseVCard, transcodeTo30 } from '../vcard';
import type { ParsedCard } from '../vcard/types';
import { deriveCardPhotoCache, downloadAvatar } from './avatars';
import { avatarNameOf, CARD_MAX_BYTES, cardBytes, PURGED_CARD, prepareCard, sanitizeCardUri } from './card-store';
import type { Contacts } from './contacts';
import * as schema from './schema';

// The CardDAV store seam over the Contacts facade. See docs/CONTACTS.md § CardDAV surface.

// The size lets a REPORT weigh a row against its byte budget before reading the bytes at all; the id is what
// an announcement names.
export type CardRow = { id: string; uri: string; etag: string; size: number };
const CARD_ROW = {
    id: schema.contacts.id,
    uri: schema.contacts.uri,
    etag: schema.contacts.etag,
    size: cardBytes,
};

// ctag advances on each change, syncGen rotates on a recreated book so stale sync tokens are refused.
export type CardBook = { ctag: number; syncGen: number };

export type DeleteCardResult = DeleteResourceResult | { ok: false; error: 'self-delete' };

// A uri is unique as written; only the Unicode form is folded, so an NFD href still finds its row.
const atUri = (uri: string) => eq(schema.contacts.uri, normalizeResourceUri(uri));

export async function getBook(contacts: Contacts): Promise<CardBook> {
    const book = contacts.db
        .select({ ctag: schema.book.ctag, syncGen: schema.book.syncGen })
        .from(schema.book)
        .where(eq(schema.book.id, 1))
        .get()!;
    return { ctag: book.ctag, syncGen: book.syncGen };
}

// Every resource in the book — group cards included, since DAV serves the whole book (the app list hides them).
export async function listCards(contacts: Contacts): Promise<CardRow[]> {
    return contacts.db.select(CARD_ROW).from(schema.contacts).all();
}

// The rows changed after book token N — the sync-collection delta (cardCtag is stamped on every change).
export async function getChangedCardsSince(contacts: Contacts, sinceCtag: number): Promise<CardRow[]> {
    return contacts.db.select(CARD_ROW).from(schema.contacts).where(gt(schema.contacts.cardCtag, sinceCtag)).all();
}

// The uris removed after book token N — the sync-collection 404 rows (one row per uri, no duplicate hrefs).
export async function getDeletedCardsSince(contacts: Contacts, sinceCtag: number): Promise<{ uri: string }[]> {
    return contacts.db
        .select({ uri: schema.contactTombstones.uri })
        .from(schema.contactTombstones)
        .where(gt(schema.contactTombstones.deletedAtCtag, sinceCtag))
        .all();
}

// Body and validator are one row by construction: the etag was hashed from these very bytes at the write.
export async function getCard(contacts: Contacts, uri: string): Promise<{ bytes: Uint8Array; etag: string } | null> {
    const row = contacts.db
        .select({ vcard: schema.contacts.vcard, etag: schema.contacts.etag })
        .from(schema.contacts)
        .where(atUri(uri))
        .get();
    return row ? { bytes: row.vcard, etag: row.etag } : null;
}

// A single-row lookup that leaves the blob alone: a PROPFIND never returns the bytes.
export function getCardMeta(contacts: Contacts, uri: string): CardRow | null {
    return contacts.db.select(CARD_ROW).from(schema.contacts).where(atUri(uri)).get() ?? null;
}

// Self-link claim, highest wins: 3 incumbent, 2 the card asserts our X-EIGEN-ID, 1 owner-email only, 0 a foreign X-EIGEN-ID.
function selfClaimRank(contacts: Contacts, parsed: ParsedCard, incumbentEigenId: string | undefined): 0 | 1 | 2 | 3 {
    if (incumbentEigenId === contacts.home.user.id) return 3;
    if (parsed.eigenId === contacts.home.user.id) return 2;
    const ownerEmail = contacts.home.user.email.toLowerCase();
    if (!parsed.eigenId && parsed.email.some((e) => e.toLowerCase() === ownerEmail)) return 1;
    return 0;
}

// An update keeps the row's link, and a restored X-EIGEN-ID keeps the stored bytes and the row agreeing.
function resolveSelfLinkOnPut(
    contacts: Contacts,
    parsed: ParsedCard,
    bytes: Uint8Array,
    existing: { id: string; eigenId: string } | undefined,
): { eigenId: string; bytes: Uint8Array; merged: boolean } {
    const me = contacts.home.user.id;
    let eigenId: string;
    if (existing) {
        eigenId = existing.eigenId;
    } else {
        const claim = selfClaimRank(contacts, parsed, undefined) >= 1;
        const heldElsewhere = !!contacts.db
            .select({ id: schema.contacts.id })
            .from(schema.contacts)
            .where(eq(schema.contacts.eigenId, me))
            .get();
        eigenId = claim && !heldElsewhere ? me : '';
    }
    if (eigenId === me && parsed.eigenId !== me) {
        return { eigenId, bytes: new TextEncoder().encode(mergeVCard(parsed, { eigenId: me })), merged: true };
    }
    return { eigenId, bytes, merged: false };
}

// Preconditions, UID rules, quota and the self-link are decided inside the lock, against the state the write overwrites.
export async function putCard(
    contacts: Contacts,
    uri: string,
    body: string,
    options: ResourcePreconditions,
): Promise<PutResourceResult> {
    if (sanitizeCardUri(uri) !== uri) return { ok: false, error: 'invalid' };

    // Bounded before any parse, so a hostile multi-MiB payload never reaches the AST unfolder.
    if (Buffer.byteLength(body) > CARD_MAX_BYTES) return { ok: false, error: 'too-large' };

    // The body says nothing about stored state, so a 5 MiB parse waits for no other writer. The book is
    // stored as 3.0, and anything that isn't one well-formed vCard is a client error, not a 500.
    let parsed: ParsedCard;
    let stored: string;
    try {
        stored = transcodeTo30(body);
        parsed = parseVCard(stored);
    } catch {
        return { ok: false, error: 'invalid' };
    }
    const uid = parsed.uid;
    if (!uid) return { ok: false, error: 'invalid', message: 'UID is required' };

    return contacts.writeLock.run(async (): Promise<PutResourceResult> => {
        // Two racing If-Match PUTs serialize through the lock, so the loser sees the winner's new etag here.
        const existing = contacts.db
            .select({
                id: schema.contacts.id,
                uid: schema.contacts.uid,
                eigenId: schema.contacts.eigenId,
                etag: schema.contacts.etag,
                size: cardBytes,
            })
            .from(schema.contacts)
            .where(atUri(uri))
            .get();
        const currentEtag = existing ? `"${existing.etag}"` : null;
        if (options.ifNoneMatch !== null && matchesIfNoneMatch(options.ifNoneMatch, currentEtag)) {
            return { ok: false, error: 'precondition' };
        }
        if (options.ifMatch !== null && !matchesIfMatch(options.ifMatch, currentEtag)) {
            return { ok: false, error: 'precondition' };
        }

        // A UID another resource owns is a conflict the client can act on, not a raw 500 on the UNIQUE index.
        const holder = contacts.db
            .select({ id: schema.contacts.id, uri: schema.contacts.uri })
            .from(schema.contacts)
            .where(eq(schema.contacts.uid, uid))
            .get();
        if (holder && holder.id !== existing?.id) {
            return { ok: false, error: 'uid-conflict', conflictUri: holder.uri };
        }
        if (existing && uid !== existing.uid) return { ok: false, error: 'uid-conflict' };

        // Before the quota check, so the meter and the stored etag both hash the exact bytes stored.
        const { eigenId, bytes, merged } = resolveSelfLinkOnPut(
            contacts,
            parsed,
            new TextEncoder().encode(stored),
            existing,
        );
        // A body the server rewrote is not the client's revision, so no validator goes back and the client re-reads (RFC 4918 § 9.7.2).
        const verbatim = stored === body && !merged;

        const id = existing?.id ?? randomUUID();
        const isSelf = eigenId === contacts.home.user.id;

        // The avatar URL writeCard derived and stored, after both ceilings passed.
        let projectionAvatar: string;
        const projection = prepareCard(bytes, parsed, '', uid);
        // The stored bytes credit the card this one replaces; a raised 413/507 maps to a typed result.
        try {
            // sanitizeCardUri already accepted this spelling, so the stored uri is the NFC one.
            projectionAvatar = await contacts.writeCard({
                row: { id, uri, eigenId, ...projection },
                categories: parsed.categories,
                creditBytes: existing?.size ?? 0,
                // Regenerated only when the hash-named file is missing, so an unchanged-photo re-PUT keeps its cache.
                cache: () => deriveCardPhotoCache(contacts, id, parsed.photo),
            });
        } catch (e) {
            if (e instanceof ApiError && e.status === 413) return { ok: false, error: 'too-large' };
            if (e instanceof ApiError && e.status === 507) return { ok: false, error: 'quota' };
            throw e;
        }

        // A self-card PUT renames the user org-wide; a DAV PUT stages no avatar, so the pushed bytes are the derived webp cache.
        if (isSelf) {
            let avatarWebP: Buffer | null = null;
            if (projectionAvatar) {
                const data = await downloadAvatar(contacts, avatarNameOf(projectionAvatar));
                if (data) avatarWebP = Buffer.from(data);
            }
            try {
                await pushUserProfile(
                    contacts.home.user.id,
                    `${parsed.firstName.trim()} ${parsed.lastName.trim()}`.trim(),
                    avatarWebP,
                );
            } catch (e) {
                console.error(`contacts: failed to propagate the profile of ${contacts.home.user.id}:`, e);
            }
        }

        return { ok: true, id, etag: verbatim ? projection.etag : null, created: !existing };
    });
}

// An unknown uri is a 404, deliberately unlike REST's idempotent no-op.
export async function deleteCard(
    contacts: Contacts,
    uri: string,
    pre: Pick<ResourcePreconditions, 'ifMatch'>,
): Promise<DeleteCardResult> {
    return contacts.writeLock.run(async (): Promise<DeleteCardResult> => {
        const row = contacts.db.select(PURGED_CARD).from(schema.contacts).where(atUri(uri)).get();
        if (!row) return { ok: false, error: 'not-found' };
        // Self before etag, mirroring deleteContact: your own card cannot be removed regardless of token.
        if (row.eigenId === contacts.home.user.id) {
            // Thunderbird drops the card from its view and ignores the 403, so bump the ctag: the next delta lists it and that client re-downloads it.
            contacts.db.transaction((tx) => {
                const ctag = contacts.bumpCtag(tx);
                tx.update(schema.contacts).set({ cardCtag: ctag }).where(eq(schema.contacts.id, row.id)).run();
            });
            return { ok: false, error: 'self-delete' };
        }
        if (pre.ifMatch !== null && !matchesIfMatch(pre.ifMatch, `"${row.etag}"`)) {
            return { ok: false, error: 'precondition' };
        }
        await contacts.purgeCard(row);
        return { ok: true, id: row.id };
    });
}
