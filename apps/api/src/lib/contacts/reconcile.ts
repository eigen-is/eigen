import { randomUUID } from 'node:crypto';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import {
    computeResourceEtag,
    dedupeByUid,
    diffFileStats,
    nextSyncGen,
    PATHS,
    uriKeyOf,
    writeResourceFile,
} from '../core';
import { mergeVCard } from '../vcard';
import type { ParsedCard } from '../vcard/types';
import type { CardRowInput } from './card-store';
import { avatarNameOf, cardPath, cardUpdateSet, statCardDir } from './card-store';
import type { Contacts } from './contacts';
import * as schema from './schema';

// The stat-only index pass, plus the ranking that hands the self-link to exactly one card. See docs/CONTACTS.md § Reconcile.

// Scalars only — never the `data` JSON, so init parses no stored projection.
type IndexIncumbent = Pick<typeof schema.contacts.$inferSelect, 'id' | 'uri' | 'uid' | 'eigenId' | 'etag'>;

type CardCandidate = {
    row: CardRowInput;
    categories: string[];
    parsed: ParsedCard;
    existing?: IndexIncumbent;
    rank: 0 | 1 | 2 | 3;
};

// Self-link claim, highest wins, ties by uri: 3 incumbent, 2 the file asserts our X-EIGEN-ID, 1 owner-email only, 0 a foreign X-EIGEN-ID.
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

// Restores X-EIGEN-ID into the winner's file so the link survives a restart; no loser's file is ever touched.
async function applySelfLink(contacts: Contacts, winner: CardCandidate): Promise<void> {
    winner.row.eigenId = contacts.home.user.id;
    if (winner.parsed.eigenId === contacts.home.user.id) return;
    const bytes = new TextEncoder().encode(mergeVCard(winner.parsed, { eigenId: contacts.home.user.id }));
    const { mtime, size } = await writeResourceFile(contacts.storage, cardPath(winner.row.uri), bytes);
    winner.row.etag = computeResourceEtag(bytes);
    winner.row.mtime = mtime;
    winner.row.size = size;
}

// A card's uid is unique across the whole book (idx_contacts_uid), so the collision scope is the uid itself.
function dedupeCardsByUid(candidates: CardCandidate[], uidOwner: Map<string, string>): CardCandidate[] {
    return dedupeByUid(candidates, uidOwner, (c) => ({ scope: c.row.uid, id: c.row.id, uri: c.row.uri }));
}

// One unreadable card never fails the whole pass.
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

// Stat-only: a same-size, timestamp-preserving replacement is invisible here — the write journal catches that one.
export async function reconcileIndex(contacts: Contacts): Promise<void> {
    return contacts.gate.run(async () => {
        const scan = await statCardDir(contacts.storage);
        const { files: present, skipped } = scan;

        // A lost book row rebuilds from cards/ under a rotated generation, so stale sync tokens are refused instead of hiding gap-deletions.
        if (!contacts.db.select({ id: schema.book.id }).from(schema.book).where(eq(schema.book.id, 1)).get()) {
            const lost = present.size > 0 || skipped.size > 0;
            contacts.db
                .insert(schema.book)
                .values({ id: 1, syncGen: lost ? nextSyncGen(undefined, Date.now()) : 1 })
                .run();
            if (lost) console.warn('contacts: the book row is gone — rebuilding under a new sync generation');
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

        // A gone avatar cache is drift too: nothing else would ever regenerate it, so the URL would 404 forever.
        const avatarFiles = new Set(await contacts.storage.list(PATHS.CONTACTS.AVATARS));
        const cacheMissing = new Set(
            rows
                .filter((row) => {
                    const avatarName = row.data?.avatar ? avatarNameOf(row.data.avatar) : undefined;
                    return !!avatarName && !avatarFiles.has(avatarName);
                })
                .map((row) => row.uriKey),
        );
        const diff = diffFileStats(scan, rowByKey, (row) => cacheMissing.has(row.uriKey));

        // Sorted, so this pass's tie-breaks — the self-link winner, a uid collision — take the earliest uri.
        const reindex = [
            ...diff.added.map((file) => ({ uri: file.uri, existing: undefined })),
            ...diff.changed.map(({ file, row }) => ({ uri: file.uri, existing: row })),
        ].sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));

        // Unindexable bytes count too: the file occupies quota whatever the index makes of it.
        const presentBytes = [...present.values()].reduce((sum, p) => sum + p.size, 0);

        if (reindex.length === 0 && diff.vanished.length === 0) {
            contacts.cardsBytes = presentBytes;
            return; // clean pass: zero parses, zero bump
        }

        const reindexKeys = new Set(reindex.map((r) => uriKeyOf(r.uri)));

        const candidates = await buildCandidates(contacts, reindex);

        // Seeded with every row that survives the vanished deletes, so a new same-uid card loses instead of tripping the UNIQUE index.
        const vanishedIds = new Set(diff.vanished.map((r) => r.id));
        const uidOwner = new Map(rows.filter((r) => !vanishedIds.has(r.id)).map((r) => [r.uid, r.id] as const));
        const prepared = dedupeCardsByUid(candidates, uidOwner);

        // A never-indexable card drifts in on every restart; committing here would bump the ctag and send every client a no-op delta poll.
        if (prepared.length === 0 && diff.vanished.length === 0) {
            contacts.cardsBytes = presentBytes;
            return;
        }

        // A self row that survives this pass keeps the slot; only one tombstoned here frees it, and a skipped stat is not a removal.
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

        // A restore drifts every mtime: a card that still hashes the same only refreshes its stat, or every client refetches the book.
        const isRestored = (c: CardCandidate) =>
            !!c.existing &&
            c.existing.etag === c.row.etag &&
            c.existing.uri === c.row.uri &&
            c.existing.eigenId === c.row.eigenId &&
            !cacheMissing.has(c.row.uriKey);
        const restored: CardCandidate[] = [];
        const changed: CardCandidate[] = [];
        for (const c of prepared) (isRestored(c) ? restored : changed).push(c);

        const createdLabelIds: string[] = [];
        contacts.db.transaction((tx) => {
            for (const { row } of restored) {
                tx.update(schema.contacts)
                    .set({ mtime: row.mtime, size: row.size })
                    .where(eq(schema.contacts.id, row.id))
                    .run();
            }
            // A pass that only refreshed stats is a clean pass for sync purposes: no bump, so no delta.
            if (changed.length > 0 || diff.vanished.length > 0) {
                const ctag = contacts.bumpCtag(tx);
                // Vanished first, or a card renamed within this pass collides with itself on the uid UNIQUE index.
                for (const r of diff.vanished) {
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
                    // A present card is alive again, so one re-planted at a deleted uri drops its stale removal.
                    tx.delete(schema.contactTombstones).where(eq(schema.contactTombstones.uriKey, row.uriKey)).run();
                }
            }
            // This pass settled every prepared uri, so the recovery drain behind init owes their intents nothing.
            for (const { row } of prepared) {
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
        for (const r of diff.vanished) contacts.emitContact(SSEventType.CONTACT_DELETED, r.id);
    });
}
