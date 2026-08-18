import { randomUUID } from 'node:crypto';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq, gt } from 'drizzle-orm';
import type { ParsedCard } from '../carddav/vcard-parse';
import { parseVCard } from '../carddav/vcard-parse';
import { mergeVCard } from '../carddav/vcard-serialize';
import { transcodeTo30 } from '../carddav/vcard-transcode';
import { ApiError, matchesIfMatch, matchesIfNoneMatch } from '../core';
import { pushUserProfile } from '../home/home-relay';
import { deriveCardPhotoCache, downloadAvatar } from './avatars';
import { CARD_MAX_BYTES, computeCardEtag, sanitizeCardUri, uriKeyOf, writeCardFile } from './card-store';
import type { Contacts } from './contacts';
import { selfClaimRank } from './reconcile';
import * as schema from './schema';

// The CardDAV store seam over the Contacts facade: the index reads the protocol handlers sit on, and the
// PUT/DELETE write seams behind them — preconditions, UID rules, the quota gate and the self-link decision,
// all evaluated inside the facade's write lock. See docs/CONTACTS.md § CardDAV surface.

// The index projection the CardDAV sync layer reads for a resource (multiget/sync-collection). Group cards
// are included — DAV sees the whole book — and the etag is the unquoted content hash the handler quotes.
export type CardRow = { uri: string; etag: string };
// The Drizzle projection behind CardRow, spelled once and shared by listCards/getChangedCardsSince/getCard/getCardMeta.
const CARD_ROW = { uri: schema.contacts.uri, etag: schema.contacts.etag };

// The book counters every DAV sync surface reads: ctag advances on each change, syncGen rotates on an index
// rebuild so stale sync tokens are refused. Named once, as CalDAV's builders take a CalendarItem.
export type CardBook = { ctag: number; syncGen: number };

// The typed outcome of a DAV PUT: a mapped precondition/conflict/limit result the handler turns into a 4xx,
// or the stored etag plus whether the resource was newly created (201 vs 204). No raw throw crosses this seam
// for a client-caused failure — only genuine IO errors bubble.
export type PutCardResult =
    | { ok: true; etag: string; created: boolean }
    | { ok: false; error: 'precondition' | 'uid-conflict' | 'invalid' | 'too-large' | 'quota'; message?: string };

// The typed outcome of a DAV DELETE: a 404 for an unknown uri, a 403 for your own card, or a 412 for a stale
// If-Match. Mirrors PutCardResult so both write seams name their result once.
export type DeleteCardResult = { ok: true } | { ok: false; error: 'not-found' | 'precondition' | 'self-delete' };

// The index-only reads the protocol handlers sit on. Each drains a pending failed pair before
// observing the index so no DAV read is served past a torn write (fail-closed, spec § 1), exactly as
// getContacts does — which is why they are async even where the shape looks synchronous.

export async function getBook(contacts: Contacts): Promise<CardBook> {
    await contacts.ensureDrained();
    const book = contacts.db.select().from(schema.book).where(eq(schema.book.id, 1)).get()!;
    return { ctag: book.ctag, syncGen: book.syncGen };
}

// Every resource in the book — group cards included, since DAV serves the whole book (the app list hides them).
export async function listCards(contacts: Contacts): Promise<CardRow[]> {
    await contacts.ensureDrained();
    return contacts.db.select(CARD_ROW).from(schema.contacts).all();
}

// The rows changed after book token N — the sync-collection delta (cardCtag is stamped on every change).
export async function getChangedCardsSince(contacts: Contacts, sinceCtag: number): Promise<CardRow[]> {
    await contacts.ensureDrained();
    return contacts.db.select(CARD_ROW).from(schema.contacts).where(gt(schema.contacts.cardCtag, sinceCtag)).all();
}

// The uris removed after book token N — the sync-collection 404 rows (one row per uri, no duplicate hrefs).
export async function getDeletedCardsSince(contacts: Contacts, sinceCtag: number): Promise<{ uri: string }[]> {
    await contacts.ensureDrained();
    return contacts.db
        .select({ uri: schema.contactTombstones.uri })
        .from(schema.contactTombstones)
        .where(gt(schema.contactTombstones.deletedAtCtag, sinceCtag))
        .all();
}

// The stored bytes for a resource (GET/multiget). Looks the row up by its folded key, then reads the file
// under its canonical uri. A row whose file has vanished is not a 500: mark it so the next drain tombstones
// it (the vanished-file branch) and answer this request as a miss.
export async function getCard(contacts: Contacts, uri: string): Promise<{ bytes: Uint8Array; etag: string } | null> {
    await contacts.ensureDrained();
    const row = contacts.db
        .select(CARD_ROW)
        .from(schema.contacts)
        .where(eq(schema.contacts.uriKey, uriKeyOf(uri)))
        .get();
    if (!row) return null;
    try {
        return { bytes: await contacts.readCardBytes(row.uri), etag: row.etag };
    } catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
            contacts.markCardDirty(row.uri);
            return null;
        }
        throw e;
    }
}

// The resource metadata (canonical uri + etag) for one card by its folded key — the single-resource
// PROPFIND read. An indexed single-row lookup, unlike a `listCards().find()` over the whole book; getCard
// is the wrong tool here because it reads the file bytes a PROPFIND never returns.
export async function getCardMeta(contacts: Contacts, uri: string): Promise<CardRow | null> {
    await contacts.ensureDrained();
    return (
        contacts.db
            .select(CARD_ROW)
            .from(schema.contacts)
            .where(eq(schema.contacts.uriKey, uriKeyOf(uri)))
            .get() ?? null
    );
}

// The single self-link for a card being PUT, plus the bytes to store (§ 2). commitCard's UPDATE omits
// eigenId, so an incumbent's link rides an update untouched — this decides only what the row carries and
// whether the file needs X-EIGEN-ID restored. On update the row keeps its existing link (a non-self card
// stays non-self; promoting it is left to the reconcile rematch, as updateContact does). On create it
// claims the link when its X-EIGEN-ID or an exact owner-email match wins and no other row already holds
// it (selfClaimRank). When this card holds the link but its bytes don't assert X-EIGEN-ID — a client
// stripped it, or an email-only claim never wrote it — the property is restored so the stored file and
// the index never disagree (applySelfLink's shape, but before the single write a PUT makes). Sync: no IO.
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

// A DAV PUT: store the client's card verbatim (after the 4.0→3.0 transcode) as the resource, with every
// precondition, UID rule, quota gate, and self-link decision evaluated INSIDE the writeLock against the
// state the write overwrites (§ 3). The uri is the client-chosen filename; the router sanitizes it (§ 4)
// but this is a public method that turns the uri into a filesystem path, so it re-validates before any
// write — a traversal or otherwise-unsafe name is refused, never renamed over a sibling file. Mirrors the
// addContact/updateContact write seam.
export async function putCard(
    contacts: Contacts,
    uri: string,
    body: string,
    pre: { ifMatch: string | null; ifNoneMatch: string | null },
): Promise<PutCardResult> {
    if (sanitizeCardUri(uri) !== uri) return { ok: false, error: 'invalid' };
    return contacts.writeLock.run(async (): Promise<PutCardResult> => {
        await contacts.drainDirty();

        // The raw body is bounded before any parse so a hostile multi-MiB payload never reaches the AST
        // unfolder (§ 4); enforceCardBudget re-checks the same ceiling on the stored bytes below.
        if (Buffer.byteLength(body) > CARD_MAX_BYTES) return { ok: false, error: 'too-large' };

        // The book is 3.0 on disk: a 4.0 client's card is transcoded (identity for 3.0), then parsed for the
        // index projection. Anything that isn't one well-formed vCard is a client error, not a 500.
        let parsed: ParsedCard;
        let stored: string;
        try {
            stored = transcodeTo30(body);
            parsed = parseVCard(stored);
        } catch {
            return { ok: false, error: 'invalid' };
        }

        // Preconditions, against the state the write will overwrite: two racing If-Match PUTs serialize
        // through the lock, so the loser sees the winner's new etag and fails here.
        const existing = contacts.db
            .select()
            .from(schema.contacts)
            .where(eq(schema.contacts.uriKey, uriKeyOf(uri)))
            .get();
        const currentEtag = existing?.etag ?? null;
        if (pre.ifNoneMatch !== null && matchesIfNoneMatch(pre.ifNoneMatch, currentEtag)) {
            return { ok: false, error: 'precondition' };
        }
        if (pre.ifMatch !== null && !matchesIfMatch(pre.ifMatch, currentEtag)) {
            return { ok: false, error: 'precondition' };
        }

        // On update, the write keeps the incumbent's on-disk spelling: matching is case/normalization
        // insensitive (uriKey), but a case-variant PUT must rewrite the existing file in place — writing
        // under the caller's spelling would strand the old file on a case-sensitive fs and let the next
        // reconcile re-index from its stale bytes (silently reverting the accepted write).
        const storedUri = existing?.uri ?? uri;

        // A card carries one UID for its life: it is required, immutable on update, and a UID already owned
        // by another resource is a conflict, never a raw idx_contacts_uid 500 (§ 3/§ 4).
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

        // Resolve the self-link (and restore X-EIGEN-ID into the bytes when this card holds the link but its
        // payload dropped it) before the quota gate, so the meter and the returned etag both hash the exact
        // bytes written.
        const { eigenId, bytes } = resolveSelfLinkOnPut(contacts, parsed, new TextEncoder().encode(stored), existing);

        // The stored bytes credit the card this one replaces (0 on create). enforceCardBudget raises 413 for
        // the whole-card ceiling and 507 for the mail+contacts quota; map both to typed results.
        try {
            await contacts.enforceCardBudget(bytes, existing?.size ?? 0);
        } catch (e) {
            if (e instanceof ApiError && e.status === 413) return { ok: false, error: 'too-large' };
            if (e instanceof ApiError && e.status === 507) return { ok: false, error: 'quota' };
            throw e;
        }

        const id = existing?.id ?? randomUUID();
        const isSelf = eigenId === contacts.home.user.id;

        // Fail closed on the canonical write or any later step: a throw marks the uri dirty for the next
        // drain and rethrows, and the durable intent recorded first covers a process death.
        let projectionAvatar = '';
        let etag = '';
        try {
            contacts.recordCardWrite(storedUri);
            const { mtime, size } = await writeCardFile(contacts.storage, storedUri, bytes);
            etag = computeCardEtag(bytes);
            // Inline PHOTO → derived webp cache; keep a promoted first-generation cache on an unchanged-photo
            // re-PUT (regenerate only when the hash-named file is missing). Projection stores its URL
            // (a uri/absent photo → '').
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
                    data: {
                        email: parsed.email,
                        phone: parsed.phone,
                        company: parsed.company,
                        jobTitle: parsed.jobTitle,
                        address: parsed.address,
                        birthday: parsed.birthday,
                        notes: parsed.notes,
                        avatar: projectionAvatar,
                    },
                    etag,
                    mtime: Math.round(mtime),
                    size,
                },
                categories: parsed.categories,
                // A create re-using a tombstoned uri clears its removal in the same transaction, so no href
                // is ever both a 200 and a 404 in one sync response (§ 1, single-href guarantee).
                tombstoneCleared: true,
            });
            contacts.cardsBytes += size - (existing?.size ?? 0);
        } catch (e) {
            contacts.markCardDirty(storedUri);
            throw e;
        }

        // A self-card PUT renames the user org-wide, exactly as updateContact's push does — after the commit,
        // failure logged never rethrown. A DAV PUT carries no staged avatar URL, so the pushed bytes are the
        // derived webp cache (the generation-one image Eigen serves); no photo → null clears the server avatar.
        if (isSelf) {
            let avatarWebP: Buffer | null = null;
            if (projectionAvatar) {
                const data = await downloadAvatar(contacts, projectionAvatar.split('/').pop()!);
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

// A DAV DELETE: an unknown uri is a 404 (deliberately unlike REST's idempotent no-op), your own card is a
// 403, and a stale If-Match is a 412 — then the shared purge tail removes the file, tombstone, byte total,
// and derived avatar under the lock.
export async function deleteCard(
    contacts: Contacts,
    uri: string,
    pre: { ifMatch: string | null },
): Promise<DeleteCardResult> {
    return contacts.writeLock.run(async (): Promise<DeleteCardResult> => {
        await contacts.drainDirty();
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
        if (pre.ifMatch !== null && !matchesIfMatch(pre.ifMatch, row.etag)) {
            return { ok: false, error: 'precondition' };
        }
        await contacts.purgeCard(row);
        return { ok: true };
    });
}
