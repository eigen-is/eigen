import { randomUUID } from 'node:crypto';
import type { Label } from '@workspace/lib/types/label';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq, inArray, sql } from 'drizzle-orm';
import { ApiError, computeResourceEtag, writeResourceFile } from '../core';
import { mergeVCard, parseVCard } from '../vcard';
import type { ParsedCard } from '../vcard/types';
import { cardPath, normalizeLabelName } from './card-store';
import type { Contacts } from './contacts';
import * as schema from './schema';

// Membership truth lives in each card's CATEGORIES, so a rename or delete rewrites every member file. See docs/CONTACTS.md § Labels ↔ CATEGORIES.

// bun:sqlite names the column in the violation ("UNIQUE constraint failed: labels.nameKey"), so an id collision still surfaces as a real error.
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
    await contacts.gate.ensureDrained();
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

// Callers hold the write gate, so this drives the write pipeline directly — updateContact would re-enter the non-reentrant lock.
async function rewriteCardCategories(
    contacts: Contacts,
    contactIds: string[],
    transform: (names: string[]) => string[],
): Promise<void> {
    for (const contactId of contactIds) {
        const row = contacts.db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)).get();
        if (!row) continue;

        // A throw here would strand the journal record and brick every later label write, so one corrupt card is skipped and logged.
        let card: ParsedCard;
        try {
            card = parseVCard(new TextDecoder().decode(await contacts.readCardBytes(row.uri)));
        } catch (e) {
            console.warn(`contacts: skipping unreadable card ${row.uri} in the label fan-out: ${e}`);
            continue;
        }
        const categories = transform(card.categories);
        // Unchanged bytes keep their etag, so a resumed fan-out gives clients nothing to refetch.
        const unchanged =
            categories.length === card.categories.length && categories.every((n, i) => n === card.categories[i]);
        if (unchanged) continue;

        const bytes = new TextEncoder().encode(mergeVCard(card, { categories }));

        try {
            contacts.recordCardWrite(row.uri);
            const { mtime, size } = await writeResourceFile(contacts.storage, cardPath(row.uri), bytes);
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
                    // The stored projection, not the fresh parse: the parse plus the new stats hides an out-of-band edit from the reconcile.
                    data: row.data,
                    etag: computeResourceEtag(bytes),
                    mtime,
                    size,
                },
                categories,
            });
            contacts.cardsBytes += size - row.size;
        } catch (e) {
            contacts.gate.markDirty(row.uri);
            throw e;
        }

        contacts.emitContact(SSEventType.CONTACT_UPDATED, row.id);
    }
}

// Cards carrying either spelling are remapped onto the label row's name, so a forward fan-out resumes and a half-compensated one rolls back.
export async function resumeLabelRenames(contacts: Contacts): Promise<void> {
    for (const pending of contacts.db.select().from(schema.pendingLabelRenames).all()) {
        // The record cascades with its label row, so the label is always there.
        const label = contacts.db.select().from(schema.labels).where(eq(schema.labels.id, pending.labelId)).get()!;
        const keys = [...new Set([normalizeLabelName(pending.oldName), normalizeLabelName(pending.newName)])];
        // A card the fan-out never reached re-mints its old name as a label, so those stand-in rows go once the cards are back on the real one.
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
    // syncCardLabels skips an empty key, so such a label would drop every membership while the save reported success.
    const nameKey = normalizeLabelName(label.name);
    if (!nameKey) throw new ApiError(400, 'Label name is required');

    return contacts.gate.run(async () => {
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
    // An empty name would rewrite every member card's CATEGORIES to a value the junction cannot resolve.
    const nameKey = normalizeLabelName(label.name);
    if (!nameKey) throw new ApiError(400, 'Label name is required');

    return contacts.gate.run(async () => {
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

                // Durable from the moment the row changes: member files a crash never reaches stay stat-clean, so no reconcile finds them.
                if (renamedFrom) {
                    tx.insert(schema.pendingLabelRenames)
                        .values({ labelId: id, oldName: renamedFrom.name, newName })
                        .run();
                }
            });
        } catch (e) {
            rethrowDuplicateLabelName(e);
        }

        // Matched case-insensitively: CATEGORIES may carry a different case than the label's stored name.
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
                    // The record stays: the next resume puts the cards onto whatever name the row ended up carrying.
                    console.error(`contacts: failed to compensate label rename ${id}:`, rollbackError);
                }
                throw forwardError;
            }
        }

        contacts.emitLabel(SSEventType.LABEL_UPDATED, id);
        // The row committed this exact name and color, so the DTO is assembled rather than read back.
        return { id, name: newName, color: label.color };
    });
}

export async function deleteLabel(contacts: Contacts, id: string): Promise<void> {
    return contacts.gate.run(async () => {
        // Converge a half-applied rename first, so the delete removes the name the cards actually carry.
        await resumeLabelRenames(contacts);

        const label = contacts.db.select().from(schema.labels).where(eq(schema.labels.id, id)).get();
        if (label) {
            const { nameKey } = label;
            await rewriteCardCategories(contacts, labelMemberIds(contacts, [id]), (names) =>
                names.filter((n) => normalizeLabelName(n) !== nameKey),
            );
        }

        // The junction rows cascade with the label row (FK ON DELETE CASCADE).
        contacts.db.delete(schema.labels).where(eq(schema.labels.id, id)).run();
        contacts.emitLabel(SSEventType.LABEL_DELETED, id);
    });
}
