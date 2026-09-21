import { randomUUID } from 'node:crypto';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq, gt } from 'drizzle-orm';
import { mergeVCard } from '../carddav/vcard-serialize';
import {
    ApiError,
    computeResourceEtag,
    matchesIfMatch,
    matchesIfNoneMatch,
    readResourceFile,
    uriKeyOf,
    writeResourceFile,
} from '../core';
import { pushUserProfile } from '../home/home-relay';
import { parseVCard, transcodeTo30 } from '../vcard';
import type { ParsedCard } from '../vcard/types';
import { deriveCardPhotoCache, downloadAvatar } from './avatars';
import { avatarNameOf, CARD_MAX_BYTES, cardPath, parsedToData, sanitizeCardUri } from './card-store';
import type { Contacts } from './contacts';
import { selfClaimRank } from './reconcile';
import * as schema from './schema';

// The CardDAV store seam over the Contacts facade: the index reads the protocol handlers sit on, and the
// PUT/DELETE write seams behind them — preconditions, UID rules, the quota gate and the self-link decision,
// all evaluated inside the facade's write gate. See docs/CONTACTS.md § CardDAV surface.

// The index projection the sync layer reads for a resource; the etag is the hash the handler quotes.
export type CardRow = { uri: string; etag: string };
const CARD_ROW = { uri: schema.contacts.uri, etag: schema.contacts.etag };

// ctag advances on each change, syncGen rotates on an index rebuild so stale sync tokens are refused.
export type CardBook = { ctag: number; syncGen: number };

// The typed outcome of a DAV PUT, which the handler turns into a 4xx or a 201/204. No raw throw crosses this
// seam for a client-caused failure — only genuine IO errors bubble.
export type PutCardResult =
    | { ok: true; etag: string; created: boolean }
    | { ok: false; error: 'precondition' | 'uid-conflict' | 'invalid' | 'too-large' | 'quota'; message?: string };

// Mirrors PutCardResult so both write seams name their result once: a 404 for an unknown uri, a 403 for your
// own card, a 412 for a stale If-Match.
export type DeleteCardResult = { ok: true } | { ok: false; error: 'not-found' | 'precondition' | 'self-delete' };

// The index-only reads the protocol handlers sit on. Each drains a pending failed pair before observing the
// index so no DAV read is served past a torn write — which is why they are async even where the shape looks
// synchronous.

export async function getBook(contacts: Contacts): Promise<CardBook> {
    await contacts.gate.ensureDrained();
    const book = contacts.db.select().from(schema.book).where(eq(schema.book.id, 1)).get()!;
    return { ctag: book.ctag, syncGen: book.syncGen };
}

// Every resource in the book — group cards included, since DAV serves the whole book (the app list hides them).
export async function listCards(contacts: Contacts): Promise<CardRow[]> {
    await contacts.gate.ensureDrained();
    return contacts.db.select(CARD_ROW).from(schema.contacts).all();
}

// The rows changed after book token N — the sync-collection delta (cardCtag is stamped on every change).
export async function getChangedCardsSince(contacts: Contacts, sinceCtag: number): Promise<CardRow[]> {
    await contacts.gate.ensureDrained();
    return contacts.db.select(CARD_ROW).from(schema.contacts).where(gt(schema.contacts.cardCtag, sinceCtag)).all();
}

// The uris removed after book token N — the sync-collection 404 rows (one row per uri, no duplicate hrefs).
export async function getDeletedCardsSince(contacts: Contacts, sinceCtag: number): Promise<{ uri: string }[]> {
    await contacts.gate.ensureDrained();
    return contacts.db
        .select({ uri: schema.contactTombstones.uri })
        .from(schema.contactTombstones)
        .where(gt(schema.contactTombstones.deletedAtCtag, sinceCtag))
        .all();
}

// The stored bytes for a resource (GET/multiget). A row whose file has vanished is not a 500: mark it so the
// next drain tombstones it and answer this request as a miss. The etag hashes the bytes just read, so body
// and validator are one revision by construction even when the read raced a write or the row is stale — and a
// row that turned out stale is marked too, or every conditional write against the etag served here is a 412.
export async function getCard(contacts: Contacts, uri: string): Promise<{ bytes: Uint8Array; etag: string } | null> {
    await contacts.gate.ensureDrained();
    const row = contacts.db
        .select(CARD_ROW)
        .from(schema.contacts)
        .where(eq(schema.contacts.uriKey, uriKeyOf(uri)))
        .get();
    if (!row) return null;
    const bytes = await readResourceFile(contacts.storage, cardPath(row.uri));
    if (!bytes) {
        contacts.gate.markDirty(row.uri);
        return null;
    }
    const etag = computeResourceEtag(bytes);
    if (etag !== row.etag) contacts.gate.markDirty(row.uri);
    return { bytes, etag };
}

// The single-resource PROPFIND read: an indexed single-row lookup, unlike a `listCards().find()` over the
// whole book, and unlike getCard it doesn't read the file bytes a PROPFIND never returns.
export async function getCardMeta(contacts: Contacts, uri: string): Promise<CardRow | null> {
    await contacts.gate.ensureDrained();
    return (
        contacts.db
            .select(CARD_ROW)
            .from(schema.contacts)
            .where(eq(schema.contacts.uriKey, uriKeyOf(uri)))
            .get() ?? null
    );
}

// The single self-link for a card being PUT, plus the bytes to store. On update the row keeps its existing
// link — promoting a non-self card is left to the reconcile rematch, as updateContact does. When this card
// holds the link but its bytes don't assert X-EIGEN-ID (a client stripped it, or an email-only claim never
// wrote it), the property is restored so the stored file and the index never disagree.
function resolveSelfLinkOnPut(
    contacts: Contacts,
    parsed: ParsedCard,
    bytes: Uint8Array,
    existing: { id: string; eigenId: string } | undefined,
): { eigenId: string; bytes: Uint8Array } {
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
        return { eigenId, bytes: new TextEncoder().encode(mergeVCard(parsed, { eigenId: me })) };
    }
    return { eigenId, bytes };
}

// A DAV PUT: store the client's card verbatim (after the 4.0→3.0 transcode), with every precondition, UID
// rule, quota gate and self-link decision evaluated INSIDE the write gate against the state the write
// overwrites. The router already sanitizes the client-chosen uri, but this is a public method that turns it
// into a filesystem path, so it re-validates before any write.
export async function putCard(
    contacts: Contacts,
    uri: string,
    body: string,
    pre: { ifMatch: string | null; ifNoneMatch: string | null },
): Promise<PutCardResult> {
    if (sanitizeCardUri(uri) !== uri) return { ok: false, error: 'invalid' };
    return contacts.gate.run(async (): Promise<PutCardResult> => {
        // Bounded before any parse, so a hostile multi-MiB payload never reaches the AST unfolder.
        if (Buffer.byteLength(body) > CARD_MAX_BYTES) return { ok: false, error: 'too-large' };

        // The book is 3.0 on disk. Anything that isn't one well-formed vCard is a client error, not a 500.
        let parsed: ParsedCard;
        let stored: string;
        try {
            stored = transcodeTo30(body);
            parsed = parseVCard(stored);
        } catch {
            return { ok: false, error: 'invalid' };
        }

        // Two racing If-Match PUTs serialize through the lock, so the loser sees the winner's new etag here.
        const existing = contacts.db
            .select()
            .from(schema.contacts)
            .where(eq(schema.contacts.uriKey, uriKeyOf(uri)))
            .get();
        const currentEtag = existing ? `"${existing.etag}"` : null;
        if (pre.ifNoneMatch !== null && matchesIfNoneMatch(pre.ifNoneMatch, currentEtag)) {
            return { ok: false, error: 'precondition' };
        }
        if (pre.ifMatch !== null && !matchesIfMatch(pre.ifMatch, currentEtag)) {
            return { ok: false, error: 'precondition' };
        }

        // A case-variant PUT rewrites the existing file in place: writing under the caller's spelling would
        // strand the old file on a case-sensitive fs and let the next reconcile re-index from its stale
        // bytes, silently reverting the accepted write.
        const storedUri = existing?.uri ?? uri;

        // A card carries one UID for its life, and one another resource owns is a conflict, not a raw 500.
        if (!parsed.uid) return { ok: false, error: 'invalid', message: 'UID is required' };
        if (existing) {
            if (parsed.uid !== existing.uid) return { ok: false, error: 'uid-conflict' };
        } else if (
            contacts.db
                .select({ id: schema.contacts.id })
                .from(schema.contacts)
                .where(eq(schema.contacts.uid, parsed.uid))
                .get()
        ) {
            return { ok: false, error: 'uid-conflict' };
        }

        // Before the quota gate, so the meter and the returned etag both hash the exact bytes written.
        const { eigenId, bytes } = resolveSelfLinkOnPut(contacts, parsed, new TextEncoder().encode(stored), existing);

        // The stored bytes credit the card this one replaces; a raised 413/507 maps to a typed result.
        try {
            await contacts.enforceCardBudget(bytes, existing?.size ?? 0);
        } catch (e) {
            if (e instanceof ApiError && e.status === 413) return { ok: false, error: 'too-large' };
            if (e instanceof ApiError && e.status === 507) return { ok: false, error: 'quota' };
            throw e;
        }

        const id = existing?.id ?? randomUUID();
        const isSelf = eigenId === contacts.home.user.id;

        // Fail closed on the canonical write or any later step, as addContact does.
        let projectionAvatar = '';
        let etag = '';
        try {
            contacts.recordCardWrite(storedUri);
            const { mtime, size } = await writeResourceFile(contacts.storage, cardPath(storedUri), bytes);
            etag = computeResourceEtag(bytes);
            // Regenerates only when the hash-named file is missing, so an unchanged-photo re-PUT keeps the
            // promoted first-generation cache.
            projectionAvatar = await deriveCardPhotoCache(contacts, id, parsed.photo);
            contacts.commitCard({
                row: {
                    id,
                    uri: storedUri,
                    uriKey: uriKeyOf(storedUri),
                    uid: parsed.uid,
                    firstName: parsed.firstName.trim(),
                    lastName: parsed.lastName.trim(),
                    eigenId,
                    isGroup: parsed.isGroup,
                    data: parsedToData(parsed, projectionAvatar),
                    etag,
                    mtime,
                    size,
                },
                categories: parsed.categories,
                // So no href is ever both a 200 and a 404 in one sync response.
                tombstoneCleared: true,
            });
            contacts.cardsBytes += size - (existing?.size ?? 0);
        } catch (e) {
            contacts.gate.markDirty(storedUri);
            throw e;
        }

        // A self-card PUT renames the user org-wide, exactly as updateContact's push does — after the commit,
        // failure logged never rethrown. A DAV PUT carries no staged avatar URL, so the pushed bytes are the
        // derived webp cache.
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

        contacts.emitContact(existing ? SSEventType.CONTACT_UPDATED : SSEventType.CONTACT_CREATED, id);
        return { ok: true, etag, created: !existing };
    });
}

// A DAV DELETE: an unknown uri is a 404 (deliberately unlike REST's idempotent no-op), your own card a 403,
// a stale If-Match a 412 — then the shared purge tail runs under the lock.
export async function deleteCard(
    contacts: Contacts,
    uri: string,
    pre: { ifMatch: string | null },
): Promise<DeleteCardResult> {
    return contacts.gate.run(async (): Promise<DeleteCardResult> => {
        const row = contacts.db
            .select()
            .from(schema.contacts)
            .where(eq(schema.contacts.uriKey, uriKeyOf(uri)))
            .get();
        if (!row) return { ok: false, error: 'not-found' };
        // Self before etag, mirroring deleteContact: your own card cannot be removed regardless of token.
        if (row.eigenId === contacts.home.user.id) {
            // The delete is refused, but the client (Thunderbird) drops the card from its view before the
            // request and ignores the 403 — a delta that doesn't list the self card leaves that view wrong
            // forever. So touch it: bump the book ctag and re-stamp the self row's cardCtag, bytes/etag/mtime
            // untouched (no SSE — nothing the app shows changed). The next sync-collection delta then lists
            // it as an unchanged 200 row and the ignoring client re-downloads it. This deliberately bends
            // the "ctag bumps only on a real change" rule: a user-initiated mutation WAS refused, and the
            // trade is one phantom re-fetch row for every other client so the refusal self-heals on theirs.
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
        return { ok: true };
    });
}
