import { randomUUID } from 'node:crypto';
import type { Label } from '@workspace/lib/types/label';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq, inArray, sql } from 'drizzle-orm';
import type { ParsedCard } from '../carddav/vcard-parse';
import { parseVCard } from '../carddav/vcard-parse';
import { mergeVCard } from '../carddav/vcard-serialize';
import { ApiError } from '../core';
import { computeCardEtag, normalizeLabelName, writeCardFile } from './card-store';
import type { Contacts } from './contacts';
import * as schema from './schema';

// Label definitions and the CATEGORIES fan-out machinery over the Contacts facade: membership truth lives in each
// card's CATEGORIES, so a rename or a delete rewrites every member file through the same write→commit pair a
// contact edit takes, journalled so a half-applied fan-out resumes. See docs/CONTACTS.md § Labels ↔ CATEGORIES.

// The v2 UNIQUE index on labels(nameKey) closes duplicate/case-variant label names. bun:sqlite names the
// column in the violation message ("UNIQUE constraint failed: labels.nameKey"); match on it so an unrelated
// UNIQUE (the id PRIMARY KEY) still surfaces as a real error rather than a spurious 409.
function rethrowDuplicateLabelName(e: unknown): never {
    if (e instanceof Error && e.message.includes('labels.nameKey')) {
        throw new ApiError(409, 'A label with this name already exists');
    }
    throw e;
}

export function labelNamesFor(contacts: Contacts, labelIds: string[]): string[] {
    if (labelIds.length === 0) return [];
    const byId = new Map(
        contacts.db
            .select({ id: schema.labels.id, name: schema.labels.name })
            .from(schema.labels)
            .all()
            .map((l) => [l.id, l.name] as const),
    );
    return labelIds.map((id) => byId.get(id)).filter((name): name is string => name !== undefined);
}

// Projected to the DTO: nameKey and the timestamps are index bookkeeping, not part of the wire contract.
export async function getLabels(contacts: Contacts): Promise<Label[]> {
    await contacts.ensureDrained();
    return contacts.db
        .select({ id: schema.labels.id, name: schema.labels.name, color: schema.labels.color })
        .from(schema.labels)
        .all();
}

// The contacts linked to any of these labels, deduped — the fan-out set for a rename or a delete.
function labelMemberIds(contacts: Contacts, labelIds: string[]): string[] {
    const rows = contacts.db
        .select({ contactId: schema.contactsToLabels.contactId })
        .from(schema.contactsToLabels)
        .where(inArray(schema.contactsToLabels.labelId, labelIds))
        .all();
    return [...new Set(rows.map((r) => r.contactId))];
}

// A label rename/delete fans out to its member cards so CATEGORIES stays the membership truth: each card
// is re-read, its category names remapped by `transform`, then written and re-indexed through the same
// file→commit pipeline as a contact edit (its etag/cardCtag bump, so DAV clients re-fetch). Callers hold
// the writeLock and drive it directly rather than via updateContact, which would re-enter the
// non-reentrant lock.
async function rewriteCardCategories(
    contacts: Contacts,
    contactIds: string[],
    transform: (names: string[]) => string[],
): Promise<void> {
    for (const contactId of contactIds) {
        const row = contacts.db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)).get();
        if (!row) continue;

        // One member corrupted out of band may not take the fan-out down with it: a throw here strands the
        // rename's journal record, and every later label mutation resumes it and fails again — one bad file
        // would brick all label writes. Skip-and-log instead (as buildCandidates does), leaving that card's
        // CATEGORIES for the reconcile/rebuild that can read the file again to converge (spec § 1).
        let card: ParsedCard;
        try {
            card = parseVCard(new TextDecoder().decode(await contacts.readCardBytes(row.uri)));
        } catch (e) {
            console.warn(`contacts: skipping unreadable card ${row.uri} in the label fan-out: ${e}`);
            continue;
        }
        const categories = transform(card.categories);
        // A card the transform doesn't touch — one a resumed fan-out already reached, or whose CATEGORIES
        // never carried the name — keeps its exact bytes: no etag rotation, nothing for clients to refetch.
        const unchanged =
            categories.length === card.categories.length && categories.every((n, i) => n === card.categories[i]);
        if (unchanged) continue;

        const bytes = new TextEncoder().encode(mergeVCard(card, { categories }));

        try {
            contacts.recordCardWrite(row.uri);
            const { mtime, size } = await writeCardFile(contacts.storage, row.uri, bytes);
            contacts.commitCard({
                row: {
                    id: row.id,
                    uri: row.uri,
                    uriKey: row.uriKey,
                    uid: row.uid,
                    firstName: row.firstName,
                    lastName: row.lastName,
                    eigenId: row.eigenId,
                    isGroup: row.isGroup,
                    // Deliberately the stored projection, not the fresh parse: committing it with the
                    // rewritten file's stats hides an out-of-band edit from the stat-only reconcile. Only
                    // hand-editing a card file under a live server can produce that, so projecting from the
                    // parse above is deferred to the phase-2 DAV PUT seam.
                    data: row.data,
                    etag: computeCardEtag(bytes),
                    mtime: Math.round(mtime),
                    size,
                },
                categories,
            });
            contacts.cardsBytes += size - row.size;
        } catch (e) {
            contacts.markCardDirty(row.uri);
            throw e;
        }

        contacts.emitContact(SSEventType.CONTACT_UPDATED, row.id);
    }
}

// Finish a label rename whose member-card fan-out never completed — process death mid-fan-out, or a
// compensation that itself failed. The label row is the truth for the final name, so every member card
// carrying either spelling is remapped onto it (a forward fan-out resumes, a half-compensated one rolls
// back, a case-only rename still lands its casing). The transform is keyed on the name, so re-running it
// rewrites nothing once the cards agree, and the record clears only after every member committed. Caller
// holds the writeLock, as drainDirty's callers do.
export async function resumeLabelRenames(contacts: Contacts): Promise<void> {
    for (const pending of contacts.db.select().from(schema.pendingLabelRenames).all()) {
        // The record cascades with its label row, so the label is always there.
        const label = contacts.db.select().from(schema.labels).where(eq(schema.labels.id, pending.labelId)).get()!;
        const keys = [...new Set([normalizeLabelName(pending.oldName), normalizeLabelName(pending.newName)])];
        // A member the fan-out never reached re-mints the name it still carries as a label of its own the
        // moment membership is re-derived from CATEGORIES (the drain above, a rebuild). Those cards are
        // this rename's members too; their stand-in label rows go once the cards are back on the real one.
        const duplicateIds = contacts.db
            .select({ id: schema.labels.id })
            .from(schema.labels)
            .where(inArray(schema.labels.nameKey, keys))
            .all()
            .map((l) => l.id)
            .filter((id) => id !== pending.labelId);

        await rewriteCardCategories(contacts, labelMemberIds(contacts, [pending.labelId, ...duplicateIds]), (names) => [
            ...new Set(names.map((n) => (keys.includes(normalizeLabelName(n)) ? label.name : n))),
        ]);

        for (const id of duplicateIds) {
            contacts.db.delete(schema.labels).where(eq(schema.labels.id, id)).run();
            contacts.emitLabel(SSEventType.LABEL_DELETED, id);
        }
        clearPendingRename(contacts, pending.labelId);
    }
}

function clearPendingRename(contacts: Contacts, labelId: string): void {
    contacts.db.delete(schema.pendingLabelRenames).where(eq(schema.pendingLabelRenames.labelId, labelId)).run();
}

export async function addLabel(contacts: Contacts, label: Omit<Label, 'id'>): Promise<string> {
    // A name that normalizes to nothing is not storable: syncCardLabels skips the empty key, so every
    // membership assigned to such a label would be dropped while the save reported success.
    const nameKey = normalizeLabelName(label.name);
    if (!nameKey) throw new ApiError(400, 'Label name is required');

    return contacts.writeLock.run(async () => {
        await contacts.drainDirty();
        await resumeLabelRenames(contacts);
        const labelId = randomUUID();

        try {
            await contacts.db.insert(schema.labels).values({
                id: labelId,
                name: label.name.trim(),
                nameKey,
                color: label.color,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            });
        } catch (e) {
            rethrowDuplicateLabelName(e);
        }

        contacts.emitLabel(SSEventType.LABEL_CREATED, labelId);

        return labelId;
    });
}

export async function updateLabel(contacts: Contacts, id: string, label: Omit<Label, 'id'>): Promise<Label> {
    // Same refusal as addLabel, and before the rename fan-out: an empty name would rewrite every member
    // card's CATEGORIES to a value the junction can no longer resolve.
    const nameKey = normalizeLabelName(label.name);
    if (!nameKey) throw new ApiError(400, 'Label name is required');

    return contacts.writeLock.run(async () => {
        await contacts.drainDirty();
        await resumeLabelRenames(contacts);

        const before = contacts.db.select().from(schema.labels).where(eq(schema.labels.id, id)).get();
        if (!before) throw new ApiError(404, 'Label not found');
        // Only a display-name change touches cards — the color never appears in a vCard.
        const newName = label.name.trim();
        const renamedFrom = before.name !== newName ? before : undefined;

        try {
            contacts.db.transaction((tx) => {
                tx.update(schema.labels)
                    .set({
                        name: newName,
                        nameKey,
                        color: label.color,
                        updatedAt: sql`unixepoch()`,
                    })
                    .where(eq(schema.labels.id, id))
                    .run();

                // The fan-out is owed from the moment the row changes, so the intent is durable from that
                // same moment: the member files a crash never reaches stay stat-clean, and no reconcile
                // can find them (the proposal's original no-journal claim — see PROPOSAL_CARDDAV.md § 1 amendment).
                if (renamedFrom) {
                    tx.insert(schema.pendingLabelRenames)
                        .values({ labelId: id, oldName: renamedFrom.name, newName })
                        .run();
                }
            });
        } catch (e) {
            rethrowDuplicateLabelName(e);
        }

        // The old name is matched case-insensitively (CATEGORIES may carry a different case than the
        // label's stored name).
        if (renamedFrom) {
            const oldNameKey = renamedFrom.nameKey;
            try {
                await rewriteCardCategories(contacts, labelMemberIds(contacts, [id]), (names) =>
                    names.map((n) => (normalizeLabelName(n) === oldNameKey ? newName : n)),
                );
                clearPendingRename(contacts, id);
            } catch (forwardError) {
                try {
                    await contacts.db
                        .update(schema.labels)
                        .set({
                            name: renamedFrom.name,
                            nameKey: renamedFrom.nameKey,
                            color: renamedFrom.color,
                            updatedAt: renamedFrom.updatedAt,
                        })
                        .where(eq(schema.labels.id, id));
                    await rewriteCardCategories(contacts, labelMemberIds(contacts, [id]), (names) =>
                        names.map((n) => (normalizeLabelName(n) === nameKey ? renamedFrom.name : n)),
                    );
                    clearPendingRename(contacts, id);
                } catch (rollbackError) {
                    // The record stays: the next init (or label mutation) resumes the cards onto whatever
                    // name the row ended up carrying.
                    console.error(`contacts: failed to compensate label rename ${id}:`, rollbackError);
                }
                throw forwardError;
            }
        }

        contacts.emitLabel(SSEventType.LABEL_UPDATED, id);
        // Reaching here means the row committed this exact name and color — the fan-out's only other exit
        // is a throw — so the DTO is assembled instead of read back with the bookkeeping columns.
        return { id, name: newName, color: label.color };
    });
}

export async function deleteLabel(contacts: Contacts, id: string): Promise<void> {
    return contacts.writeLock.run(async () => {
        await contacts.drainDirty();
        // Converge a half-applied rename first, so the delete below removes the name the cards actually
        // carry. The pending record itself cascades away with the label row.
        await resumeLabelRenames(contacts);

        const label = contacts.db.select().from(schema.labels).where(eq(schema.labels.id, id)).get();
        if (label) {
            const { nameKey } = label;
            await rewriteCardCategories(contacts, labelMemberIds(contacts, [id]), (names) =>
                names.filter((n) => normalizeLabelName(n) !== nameKey),
            );
        }

        // The junction rows cascade with the label row (FK ON DELETE CASCADE); the fan-out has already
        // rewritten every member's CATEGORIES.
        contacts.db.delete(schema.labels).where(eq(schema.labels.id, id)).run();
        contacts.emitLabel(SSEventType.LABEL_DELETED, id);
    });
}
