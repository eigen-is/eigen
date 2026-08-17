import { randomUUID } from 'node:crypto';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq, sql } from 'drizzle-orm';
import type { ParsedCard } from '../carddav/vcard-parse';
import { mergeVCard } from '../carddav/vcard-serialize';
import { PATHS } from '../core';
import { cardPath, computeCardEtag, listCardUris, uriKeyOf, writeCardFile } from './card-store';
import type { CardRowInput, Contacts } from './contacts';
import * as schema from './schema';

// The two index passes over the Contacts facade — a stat-only reconcile that re-reads only what drifted, and a
// from-scratch rebuild that re-derives the whole index and rotates syncGen — plus the ranking machinery that
// hands the single self-link to exactly one card. See docs/CONTACTS.md § Reconcile vs. rebuild.

// The only incumbent-row scalars the candidate build reads: a stable contact id, the uid fallback, and the
// eigenId that ranks a self-link claim. The reconcile/rebuild passes project these (never the `data` JSON) so
// init never parses a stored projection.
type IndexIncumbent = Pick<typeof schema.contacts.$inferSelect, 'id' | 'uid' | 'eigenId'>;

// One card file, read and prepared but not yet committed — what phase 1 of the reconcile/rebuild passes
// produces and phases 2/3 (self-link ranking, uid dedupe, the write transaction) consume. The incumbent
// rides along so the caller can tell a new card from an updated one.
type CardCandidate = {
    row: CardRowInput;
    categories: string[];
    parsed: ParsedCard;
    existing?: IndexIncumbent;
    rank: 0 | 1 | 2 | 3;
};

// Strength of a card's claim to the single self-link slot (spec § 2), highest wins; ties break by uri sort
// (candidates are pre-sorted). 3 incumbent — the card's existing index row already held the link; 2 strong —
// the file asserts X-EIGEN-ID = user.id; 1 email-only — no X-EIGEN-ID but an exact owner-email match (a weak
// claim that only rewrites the file if it actually wins). A forged foreign X-EIGEN-ID scores 0 — it stays in
// the file verbatim and drives nothing.
export function selfClaimRank(
    contacts: Contacts,
    parsed: ParsedCard,
    incumbentEigenId: string | undefined,
): 0 | 1 | 2 | 3 {
    if (incumbentEigenId === contacts.home.user.id) return 3;
    if (parsed.eigenId === contacts.home.user.id) return 2;
    const ownerEmail = contacts.home.user.email.toLowerCase();
    if (!parsed.eigenId && parsed.email.some((e) => e.toLowerCase() === ownerEmail)) return 1;
    return 0;
}

// Pick the highest-ranked self-link claimant (first in the pre-sorted list on a tie); a strictly-greater rank
// is required to displace, so the earliest max-rank card wins.
function pickSelfWinner(candidates: CardCandidate[]): CardCandidate | undefined {
    let winner: CardCandidate | undefined;
    for (const c of candidates) {
        if (c.rank > 0 && (!winner || c.rank > winner.rank)) winner = c;
    }
    return winner;
}

// Stamp the chosen winner's row with the self-link and, when its file does not already assert the link,
// restore X-EIGEN-ID into that one file and re-stat/re-etag it — the § 2 durability rewrite, covering an
// email-only claim and an incumbent whose file a client stripped. No loser's file is ever touched.
async function applySelfLink(contacts: Contacts, winner: CardCandidate): Promise<void> {
    winner.row.eigenId = contacts.home.user.id;
    if (winner.parsed.eigenId === contacts.home.user.id) return;
    const bytes = new TextEncoder().encode(mergeVCard(winner.parsed, { eigenId: contacts.home.user.id }));
    await writeCardFile(contacts.storage, winner.row.uri, bytes);
    const stat = await contacts.storage.stat(cardPath(winner.row.uri));
    winner.row.etag = computeCardEtag(bytes);
    winner.row.mtime = Math.round(stat.mtimeMs);
    winner.row.size = stat.size;
}

// Drop prepared rows whose uid is already owned by a row the transaction will leave in place — the
// idx_contacts_uid UNIQUE would otherwise throw inside the write and brick the whole pass (spec § 1).
// `uidOwner` maps each uid to the row id that will hold it after the pass: seeded with every surviving
// row (reconcile) or empty (rebuild clears the table first). A candidate updating its own incumbent keeps
// that row's slot (owner === its id); any other collision is skipped-and-warned, earliest uri winning
// since candidates arrive uri-sorted.
function dedupeByUid(candidates: CardCandidate[], uidOwner: Map<string, string>): CardCandidate[] {
    const kept: CardCandidate[] = [];
    for (const c of candidates) {
        const owner = uidOwner.get(c.row.uid);
        if (owner !== undefined && owner !== c.row.id) {
            console.warn(`contacts: skipping ${c.row.uri} — UID ${c.row.uid} already claimed by another card`);
            continue;
        }
        uidOwner.set(c.row.uid, c.row.id);
        kept.push(c);
    }
    return kept;
}

// Phase 1 of both passes: parse + prepare each entry into a candidate row without touching the self-link,
// ranking its self-claim against the entry's incumbent eigenId. A card that can't be read (garbage vCard,
// or one that vanished mid-pass) is skipped-and-logged rather than failing the whole pass (spec § 1).
async function buildCandidates(
    contacts: Contacts,
    entries: { uri: string; existing?: IndexIncumbent }[],
): Promise<CardCandidate[]> {
    const candidates: CardCandidate[] = [];
    for (const { uri, existing } of entries) {
        try {
            const p = await contacts.prepareCardRow(uri, existing?.id ?? randomUUID(), existing?.uid);
            candidates.push({ ...p, existing, rank: selfClaimRank(contacts, p.parsed, existing?.eigenId) });
        } catch (e) {
            console.warn(`contacts: skipping unreadable card ${uri}: ${e}`);
        }
    }
    return candidates;
}

// Stat-only reconcile: list cards/, compare (mtime,size) to the index, and re-read only what drifted (plus
// any row whose derived avatar cache is gone) — the clean case (always, in practice) is two listings plus
// stats, zero file reads. New/drifted cards are re-indexed and vanished rows tombstoned under a single ctag
// bump; a fully clean pass parses nothing and bumps nothing (spec § 1). A same-size, timestamp-preserving
// replacement is invisible here — that needs `rebuildIndex`.
export async function reconcileIndex(contacts: Contacts): Promise<void> {
    return contacts.writeLock.run(async () => {
        const present = new Map<string, { uri: string; mtime: number; size: number }>();
        // A stat that failed (transient IO, not a real removal) must not tombstone a live row, so track its
        // key and exclude it from the vanished set below.
        const skipped = new Set<string>();
        // listCardUris hands back the sanitized, sorted, case-deduped uris; stat each to capture drift.
        for (const { uri, key } of await listCardUris(contacts.storage)) {
            try {
                const stat = await contacts.storage.stat(cardPath(uri));
                present.set(key, { uri, mtime: Math.round(stat.mtimeMs), size: stat.size });
            } catch (e) {
                // Listed but un-stattable — skip it this pass; the next one catches up. Its row is NOT
                // treated as vanished, so a transient failure can't delete + tombstone a live card.
                skipped.add(key);
                console.warn(`contacts: skipping ${uri} — could not stat card file: ${e}`);
            }
        }

        // Project the scalars the pass reads plus the stored projection's avatar URL — no card file is
        // read, so a clean init still parses nothing.
        const rows = contacts.db
            .select({
                id: schema.contacts.id,
                uri: schema.contacts.uri,
                uriKey: schema.contacts.uriKey,
                uid: schema.contacts.uid,
                mtime: schema.contacts.mtime,
                size: schema.contacts.size,
                eigenId: schema.contacts.eigenId,
                data: schema.contacts.data,
            })
            .from(schema.contacts)
            .all();
        const rowByKey = new Map(rows.map((r) => [r.uriKey, r] as const));

        // One listing answers "is this row's derived avatar cache still there?" for every row. Without it,
        // restoring cards/ + contacts.db without avatars/ leaves stat-clean cards whose avatar URL 404s
        // forever — no card ever drifts on its own, so nothing would ever regenerate the cache.
        const avatarFiles = new Set(await contacts.storage.list(PATHS.CONTACTS.AVATARS));

        const reindex: { uri: string; existing?: (typeof rows)[number] }[] = [];
        for (const [key, info] of present) {
            const existing = rowByKey.get(key);
            const avatarName = existing?.data?.avatar?.split('/').pop();
            const cacheMissing = !!avatarName && !avatarFiles.has(avatarName);
            if (!existing || info.mtime !== existing.mtime || info.size !== existing.size || cacheMissing) {
                reindex.push({ uri: info.uri, existing });
            }
        }
        const vanished = rows.filter((r) => !present.has(r.uriKey) && !skipped.has(r.uriKey));

        // What cards/ holds right now — cardsBytes whenever this pass commits nothing. Unindexable bytes
        // count: the file occupies storage (and quota) whether or not the index can make sense of it, and
        // rebuildIndex counts the same way.
        const presentBytes = [...present.values()].reduce((sum, p) => sum + p.size, 0);

        if (reindex.length === 0 && vanished.length === 0) {
            contacts.cardsBytes = presentBytes;
            return; // clean pass: zero parses, zero bump
        }

        reindex.sort((a, b) => (a.uri < b.uri ? -1 : 1)); // stable order for the self-link tie-break
        const reindexKeys = new Set(reindex.map((r) => uriKeyOf(r.uri)));

        const candidates = await buildCandidates(contacts, reindex);

        // Seed the uid→owner guard with every row that will REMAIN after the vanished deletes (not just the
        // untouched ones): a reindexing incumbent whose candidate is skipped-as-garbage or loses dedupe keeps
        // its stored uid, so a new same-UID card must lose to it rather than trip the UNIQUE index inside the
        // transaction. A candidate updating its own incumbent (owner === its id) is free to keep that uid.
        const vanishedIds = new Set(vanished.map((r) => r.id));
        const uidOwner = new Map(rows.filter((r) => !vanishedIds.has(r.id)).map((r) => [r.uid, r.id] as const));
        const prepared = dedupeByUid(candidates, uidOwner);

        // Nothing survived to commit — every drifted card was skipped as unreadable or dropped by the uid
        // guard — and nothing vanished. A card that can never be indexed drifts into this set on every
        // restart, so running the transaction here would bump the ctag for a book that never changed and
        // send every client into a no-op delta poll per restart (spec § 1).
        if (prepared.length === 0 && vanished.length === 0) {
            contacts.cardsBytes = presentBytes;
            return;
        }

        // Phase 2: choose the one self-link winner. A self row that survives this pass untouched (file
        // present or un-stattable, and not re-indexing) holds the slot outright; only a self row whose file
        // is really gone — tombstoned this same pass — frees the slot for a twin's claim. A skipped stat is
        // explicitly not a removal above, so it may not silently mint a second eigenId row here either.
        const survivingSelf = rows.some(
            (r) =>
                r.eigenId === contacts.home.user.id &&
                !reindexKeys.has(r.uriKey) &&
                (present.has(r.uriKey) || skipped.has(r.uriKey)),
        );
        if (!survivingSelf) {
            const winner = pickSelfWinner(prepared);
            if (winner) await applySelfLink(contacts, winner);
        }

        const createdLabelIds: string[] = [];
        contacts.db.transaction((tx) => {
            const ctag = contacts.bumpCtag(tx);
            // Delete vanished rows before inserting prepared ones so a card renamed within this pass (old
            // uri gone, new uri carrying the same UID) can't collide with the row it replaces on the uid
            // UNIQUE index.
            for (const r of vanished) {
                tx.delete(schema.contacts).where(eq(schema.contacts.id, r.id)).run();
                contacts.tombstone(tx, r.uri, r.uriKey, ctag);
            }
            for (const { row } of prepared) {
                tx.insert(schema.contacts)
                    .values({ ...row, cardCtag: ctag })
                    .onConflictDoUpdate({
                        target: schema.contacts.id,
                        set: {
                            // uri/uriKey/uid follow the file: a delete + case-variant recreate reuses the
                            // contact id but changes the on-disk name, so the stored uri must refresh or
                            // every later read ENOENTs on a case-sensitive FS.
                            uri: row.uri,
                            uriKey: row.uriKey,
                            uid: row.uid,
                            firstName: row.firstName,
                            lastName: row.lastName,
                            eigenId: row.eigenId,
                            isGroup: row.isGroup,
                            data: row.data,
                            etag: row.etag,
                            cardCtag: ctag,
                            mtime: row.mtime,
                            size: row.size,
                            updatedAt: sql`unixepoch()`,
                        },
                    })
                    .run();
                // A present card is alive again: clear any live tombstone for its uri (by the folded key, as
                // commitCard does) so a card re-planted at a deleted uri drops its stale removal.
                tx.delete(schema.contactTombstones).where(eq(schema.contactTombstones.uriKey, row.uriKey)).run();
                // This pass just paid whatever write intent the uri carried — a crashed write whose file
                // drifted. Clearing it here (as commitCard does for its own) keeps the recovery drain that
                // follows init's reconcile from re-parsing and re-bumping the very card it re-indexed.
                tx.delete(schema.pendingCardWrites).where(eq(schema.pendingCardWrites.uri, row.uri)).run();
            }
            for (const { row, categories } of prepared)
                contacts.syncCardLabels(tx, row.id, categories, createdLabelIds);
        });

        // cardsBytes is authoritative from the pass's final sizes (post-rewrite for any rematched card; a
        // skipped card keeps its present size — its file is still on disk).
        const finalSize = new Map<string, number>();
        for (const [key, info] of present) finalSize.set(key, info.size);
        for (const { row } of prepared) finalSize.set(row.uriKey, row.size);
        contacts.cardsBytes = [...finalSize.values()].reduce((sum, v) => sum + v, 0);

        for (const labelId of createdLabelIds) contacts.emitLabel(SSEventType.LABEL_CREATED, labelId);
        for (const { row, existing } of prepared) {
            contacts.emitContact(existing ? SSEventType.CONTACT_UPDATED : SSEventType.CONTACT_CREATED, row.id);
        }
        for (const r of vanished) contacts.emitContact(SSEventType.CONTACT_DELETED, r.id);
    });
}

// From-scratch rebuild: re-read every card, rebuild the index (stable contact ids preserved by uri), clear
// tombstones, and rotate book.syncGen so old sync tokens die and clients full-resync (RFC 6578 recovery,
// spec § 1). Runs when init's integrity check fails; also exported for a future admin path (no route in v1).
// Catches the same-stat replacement a stat-only reconcile cannot.
export async function rebuildIndex(contacts: Contacts): Promise<void> {
    return contacts.writeLock.run(async () => {
        // Only the scalars a rebuild reads from an incumbent — id/uid preserve identity, eigenId ranks the
        // self-link claim; the `data` JSON is re-derived from the file, never read here.
        const existingByKey = new Map(
            contacts.db
                .select({
                    id: schema.contacts.id,
                    uriKey: schema.contacts.uriKey,
                    uid: schema.contacts.uid,
                    eigenId: schema.contacts.eigenId,
                })
                .from(schema.contacts)
                .all()
                .map((r) => [r.uriKey, r] as const),
        );
        // `.get()` yields undefined for a missing book row, so one read covers both the intact and gone cases.
        const book = contacts.db.select().from(schema.book).where(eq(schema.book.id, 1)).get();
        const newCtag = Math.max(book?.ctag ?? 0, 0) + 1;
        const newSyncGen = (book?.syncGen ?? 1) + 1;

        // listCardUris hands back the sanitized, sorted, case-deduped uris (already the stable self-link
        // tie-break order); pair each with its pre-clear incumbent so a surviving self row still outranks an
        // email-only twin that sorts earlier.
        const entries = (await listCardUris(contacts.storage)).map(({ uri, key }) => ({
            uri,
            key,
            existing: existingByKey.get(key),
        }));
        const candidates = await buildCandidates(contacts, entries);
        // The whole index is cleared and rebuilt below, so nothing survives to seed the collision guard —
        // two files sharing a UID resolve purely first-by-uri.
        const prepared = dedupeByUid(candidates, new Map());

        // Phase 2: the highest-ranked card claims the single self-link; only an email-only winner is rewritten.
        const winner = pickSelfWinner(prepared);
        if (winner) await applySelfLink(contacts, winner);

        const createdLabelIds: string[] = [];
        contacts.db.transaction((tx) => {
            tx.delete(schema.contactsToLabels).run();
            tx.delete(schema.contacts).run();
            tx.delete(schema.contactTombstones).run();
            tx.insert(schema.book)
                .values({ id: 1, ctag: newCtag, syncGen: newSyncGen })
                .onConflictDoUpdate({ target: schema.book.id, set: { ctag: newCtag, syncGen: newSyncGen } })
                .run();
            for (const { row } of prepared)
                tx.insert(schema.contacts)
                    .values({ ...row, cardCtag: newCtag })
                    .run();
            for (const { row, categories } of prepared)
                contacts.syncCardLabels(tx, row.id, categories, createdLabelIds);
        });

        // cardsBytes answers what cards/ holds, not what the index understood — the same rule the reconcile
        // pass follows, so the two passes never disagree about the book's size. A card skipped as unreadable
        // or dropped by the uid guard still occupies storage, so its bytes are still counted.
        const indexedKeys = new Set(prepared.map((p) => p.row.uriKey));
        let bytes = prepared.reduce((sum, p) => sum + p.row.size, 0);
        for (const { uri, key } of entries) {
            if (!indexedKeys.has(key)) bytes += (await contacts.storage.size(cardPath(uri))) ?? 0;
        }
        contacts.cardsBytes = bytes;

        for (const labelId of createdLabelIds) contacts.emitLabel(SSEventType.LABEL_CREATED, labelId);
    });
}
