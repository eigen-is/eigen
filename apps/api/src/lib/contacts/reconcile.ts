import { randomUUID } from 'node:crypto';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import { mergeVCard } from '../carddav/vcard-serialize';
import {
    computeResourceEtag,
    dedupeByUid,
    diffFileStats,
    nextSyncGen,
    PATHS,
    statResourceFile,
    uriKeyOf,
    writeResourceFile,
} from '../core';
import type { ParsedCard } from '../vcard/types';
import type { CardRowInput } from './card-store';
import { avatarNameOf, cardPath, cardUpdateSet, listCardUris } from './card-store';
import type { Contacts } from './contacts';
import * as schema from './schema';

// The two index passes over the Contacts facade — a stat-only reconcile that re-reads only what drifted, and a
// from-scratch rebuild that re-derives the whole index and rotates syncGen — plus the ranking machinery that
// hands the single self-link to exactly one card. See docs/CONTACTS.md § Reconcile vs. rebuild.

// The only incumbent-row scalars the candidate build reads: a stable contact id, the uid fallback, the
// eigenId that ranks a self-link claim, and the uri + etag a drifted file is compared against — never the
// `data` JSON, so init parses no stored projection.
type IndexIncumbent = Pick<typeof schema.contacts.$inferSelect, 'id' | 'uri' | 'uid' | 'eigenId' | 'etag'>;

// One card file, prepared but not yet committed. The incumbent rides along so the caller can tell a new
// card from an updated one.
type CardCandidate = {
    row: CardRowInput;
    categories: string[];
    parsed: ParsedCard;
    existing?: IndexIncumbent;
    rank: 0 | 1 | 2 | 3;
};

// Strength of a card's claim to the single self-link slot, highest wins; ties break by uri sort (candidates
// are pre-sorted). 3 incumbent — its index row already held the link; 2 strong — the file asserts
// X-EIGEN-ID = user.id; 1 email-only — an exact owner-email match, a weak claim that only rewrites the file
// if it actually wins. A forged foreign X-EIGEN-ID scores 0: it stays in the file verbatim and drives nothing.
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

// A strictly-greater rank is required to displace, so the earliest max-rank card in the pre-sorted list wins.
function pickSelfWinner(candidates: CardCandidate[]): CardCandidate | undefined {
    let winner: CardCandidate | undefined;
    for (const c of candidates) {
        if (c.rank > 0 && (!winner || c.rank > winner.rank)) winner = c;
    }
    return winner;
}

// Stamp the winner's row with the self-link and, when its file does not already assert it, restore
// X-EIGEN-ID into that one file so the link survives a restart — the case of an email-only claim, or an
// incumbent whose file a client stripped. No loser's file is ever touched.
async function applySelfLink(contacts: Contacts, winner: CardCandidate): Promise<void> {
    winner.row.eigenId = contacts.home.user.id;
    if (winner.parsed.eigenId === contacts.home.user.id) return;
    const bytes = new TextEncoder().encode(mergeVCard(winner.parsed, { eigenId: contacts.home.user.id }));
    const { mtime, size } = await writeResourceFile(contacts.storage, cardPath(winner.row.uri), bytes);
    winner.row.etag = computeResourceEtag(bytes);
    winner.row.mtime = mtime;
    winner.row.size = size;
}

// A card's uid is unique across the whole book (the idx_contacts_uid UNIQUE), so the collision scope is the
// uid itself.
function dedupeCardsByUid(candidates: CardCandidate[], uidOwner: Map<string, string>): CardCandidate[] {
    return dedupeByUid(candidates, uidOwner, (c) => ({ scope: c.row.uid, id: c.row.id, uri: c.row.uri }));
}

// Phase 1 of both passes: prepare each entry into a candidate row without touching the self-link, ranking its
// claim against the entry's incumbent eigenId. One unreadable card never fails the whole pass.
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

// Stat-only reconcile: compare (mtime,size) to the index and re-read only what drifted, plus any row whose
// derived avatar cache is gone. A fully clean pass parses nothing and bumps nothing. A same-size,
// timestamp-preserving replacement is invisible here — that needs `rebuildIndex`.
export async function reconcileIndex(contacts: Contacts): Promise<void> {
    return contacts.gate.run(async () => {
        const present = new Map<string, { uri: string; mtime: number; size: number }>();
        // A stat that failed (transient IO, not a real removal) must not tombstone a live row.
        const skipped = new Set<string>();
        for (const { uri, key } of await listCardUris(contacts.storage)) {
            try {
                present.set(key, { uri, ...(await statResourceFile(contacts.storage, cardPath(uri))) });
            } catch (e) {
                // Listed but un-stattable: skip it this pass, the next one catches up.
                skipped.add(key);
                console.warn(`contacts: skipping ${uri} — could not stat card file: ${e}`);
            }
        }

        // Only the scalars the pass reads — no card file is read, so a clean init still parses nothing.
        const rows = contacts.db
            .select({
                id: schema.contacts.id,
                uri: schema.contacts.uri,
                uriKey: schema.contacts.uriKey,
                uid: schema.contacts.uid,
                mtime: schema.contacts.mtime,
                size: schema.contacts.size,
                eigenId: schema.contacts.eigenId,
                etag: schema.contacts.etag,
                data: schema.contacts.data,
            })
            .from(schema.contacts)
            .all();
        const rowByKey = new Map(rows.map((r) => [r.uriKey, r] as const));

        // A stat-clean card whose derived avatar cache is gone counts as drifted too: restoring cards/ +
        // contacts.db without avatars/ would otherwise leave its avatar URL 404ing forever, since no card
        // drifts on its own and nothing would ever regenerate the cache.
        const avatarFiles = new Set(await contacts.storage.list(PATHS.CONTACTS.AVATARS));
        const cacheMissing = new Set(
            rows
                .filter((row) => {
                    const avatarName = row.data?.avatar ? avatarNameOf(row.data.avatar) : undefined;
                    return !!avatarName && !avatarFiles.has(avatarName);
                })
                .map((row) => row.uriKey),
        );
        const diff = diffFileStats(present, rowByKey, (row) => cacheMissing.has(row.uriKey));

        // Re-read in the listing's sorted order: this pass's tie-breaks — the self-link winner, a uid
        // collision — take the earliest uri.
        const reindex = [
            ...diff.added.map((file) => ({ uri: file.uri, existing: undefined })),
            ...diff.changed.map(({ file, row }) => ({ uri: file.uri, existing: row })),
        ].sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
        // A stat that failed is not a removal, so a skipped key keeps its row.
        const vanished = diff.vanished.filter((r) => !skipped.has(r.uriKey));

        // Unindexable bytes count too: the file occupies storage (and quota) whether or not the index can
        // make sense of it, and rebuildIndex counts the same way.
        const presentBytes = [...present.values()].reduce((sum, p) => sum + p.size, 0);

        if (reindex.length === 0 && vanished.length === 0) {
            contacts.cardsBytes = presentBytes;
            return; // clean pass: zero parses, zero bump
        }

        const reindexKeys = new Set(reindex.map((r) => uriKeyOf(r.uri)));

        const candidates = await buildCandidates(contacts, reindex);

        // Seed the uid→owner guard with every row that will REMAIN after the vanished deletes, not just the
        // untouched ones: a reindexing incumbent whose candidate is skipped keeps its stored uid, so a new
        // same-UID card must lose to it rather than trip the UNIQUE index inside the transaction.
        const vanishedIds = new Set(vanished.map((r) => r.id));
        const uidOwner = new Map(rows.filter((r) => !vanishedIds.has(r.id)).map((r) => [r.uid, r.id] as const));
        const prepared = dedupeCardsByUid(candidates, uidOwner);

        // Nothing survived to commit and nothing vanished. A card that can never be indexed drifts into this
        // set on every restart, so running the transaction here would bump the ctag for a book that never
        // changed and send every client into a no-op delta poll per restart.
        if (prepared.length === 0 && vanished.length === 0) {
            contacts.cardsBytes = presentBytes;
            return;
        }

        // Phase 2: choose the one self-link winner. A self row that survives this pass untouched holds the
        // slot outright; only one whose file is really gone — tombstoned this same pass — frees it for a
        // twin's claim. A skipped stat is not a removal, so it may not mint a second eigenId row either.
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

        // The restore rule: a per-home restore does not preserve mtimes, so a drifted card whose file still
        // hashes to the indexed etag — under the same name, holding the same self-link — changed nothing. It
        // refreshes its stat and stays out of the delta; re-stamping it would bump the book ctag and send
        // every client back for the whole book. A missing avatar cache is drift the stats cannot see, so
        // such a card is here to be regenerated, not to be left alone.
        const isRestored = (c: CardCandidate) =>
            !!c.existing &&
            c.existing.etag === c.row.etag &&
            c.existing.uri === c.row.uri &&
            c.existing.eigenId === c.row.eigenId &&
            !cacheMissing.has(c.row.uriKey);
        const restored = prepared.filter(isRestored);
        const changed = prepared.filter((c) => !isRestored(c));

        const createdLabelIds: string[] = [];
        contacts.db.transaction((tx) => {
            // A pass that only refreshed stats is a clean pass for sync purposes: no bump, so no delta.
            const ctag = changed.length > 0 || vanished.length > 0 ? contacts.bumpCtag(tx) : 0;
            for (const { row } of restored) {
                tx.update(schema.contacts)
                    .set({ mtime: row.mtime, size: row.size })
                    .where(eq(schema.contacts.id, row.id))
                    .run();
            }
            // Vanished rows go first so a card renamed within this pass (old uri gone, new uri carrying the
            // same UID) can't collide with the row it replaces on the uid UNIQUE index.
            for (const r of vanished) {
                tx.delete(schema.contacts).where(eq(schema.contacts.id, r.id)).run();
                contacts.tombstone(tx, r.uri, r.uriKey, ctag);
            }
            for (const { row } of changed) {
                tx.insert(schema.contacts)
                    .values({ ...row, cardCtag: ctag })
                    .onConflictDoUpdate({
                        target: schema.contacts.id,
                        set: { ...cardUpdateSet(row, ctag), eigenId: row.eigenId },
                    })
                    .run();
                // A present card is alive again, so a card re-planted at a deleted uri drops its stale removal.
                tx.delete(schema.contactTombstones).where(eq(schema.contactTombstones.uriKey, row.uriKey)).run();
                // This pass just paid whatever write intent the uri carried, so the recovery drain that
                // follows init's reconcile won't re-parse and re-bump the very card it re-indexed.
                tx.delete(schema.pendingCardWrites).where(eq(schema.pendingCardWrites.uri, row.uri)).run();
            }
            for (const { row, categories } of changed) contacts.syncCardLabels(tx, row.id, categories, createdLabelIds);
        });

        // Post-rewrite for a rematched card, the present size for a skipped one (its file is still there).
        const finalSize = new Map<string, number>();
        for (const [key, info] of present) finalSize.set(key, info.size);
        for (const { row } of prepared) finalSize.set(row.uriKey, row.size);
        contacts.cardsBytes = [...finalSize.values()].reduce((sum, v) => sum + v, 0);

        for (const labelId of createdLabelIds) contacts.emitLabel(SSEventType.LABEL_CREATED, labelId);
        for (const { row, existing } of changed) {
            contacts.emitContact(existing ? SSEventType.CONTACT_UPDATED : SSEventType.CONTACT_CREATED, row.id);
        }
        for (const r of vanished) contacts.emitContact(SSEventType.CONTACT_DELETED, r.id);
    });
}

// From-scratch rebuild: re-read every card, rebuild the index (stable contact ids preserved by uri), clear
// tombstones, and rotate book.syncGen so old sync tokens die and clients full-resync (RFC 6578 recovery).
// Runs when init's integrity check fails, and catches the same-stat replacement a reconcile cannot.
export async function rebuildIndex(contacts: Contacts): Promise<void> {
    return contacts.gate.run(async () => {
        // id/uid preserve identity, eigenId ranks the self-link claim; `data` is re-derived from the file.
        const existingByKey = new Map(
            contacts.db
                .select({
                    id: schema.contacts.id,
                    uri: schema.contacts.uri,
                    uriKey: schema.contacts.uriKey,
                    uid: schema.contacts.uid,
                    eigenId: schema.contacts.eigenId,
                    etag: schema.contacts.etag,
                })
                .from(schema.contacts)
                .all()
                .map((r) => [r.uriKey, r] as const),
        );
        const book = contacts.db.select().from(schema.book).where(eq(schema.book.id, 1)).get();
        const newCtag = (book?.ctag ?? 0) + 1;
        const newSyncGen = nextSyncGen(book?.syncGen, Date.now());

        // Pair each listed uri with its pre-clear incumbent, so a surviving self row still outranks an
        // email-only twin that sorts earlier.
        const entries = (await listCardUris(contacts.storage)).map(({ uri, key }) => ({
            uri,
            key,
            existing: existingByKey.get(key),
        }));
        const candidates = await buildCandidates(contacts, entries);
        // The whole index is cleared below, so two files sharing a UID resolve purely first-by-uri.
        const prepared = dedupeCardsByUid(candidates, new Map());

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

        // What cards/ holds, not what the index understood — the same rule reconcileIndex follows, so the two
        // passes never disagree about the book's size.
        const indexedKeys = new Set(prepared.map((p) => p.row.uriKey));
        let bytes = prepared.reduce((sum, p) => sum + p.row.size, 0);
        for (const { uri, key } of entries) {
            if (!indexedKeys.has(key)) bytes += (await contacts.storage.size(cardPath(uri))) ?? 0;
        }
        contacts.cardsBytes = bytes;

        for (const labelId of createdLabelIds) contacts.emitLabel(SSEventType.LABEL_CREATED, labelId);
    });
}
