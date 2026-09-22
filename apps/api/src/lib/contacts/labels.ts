import { randomUUID } from 'node:crypto';
import type { Label } from '@workspace/lib/types/label';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq, inArray, sql } from 'drizzle-orm';
import { ApiError, computeResourceEtag } from '../core';
import { mergeVCard, parseVCard } from '../vcard';
import type { ParsedCard } from '../vcard/types';
import type { CardRowInput, Tx } from './card-store';
import { indexCard, normalizeLabelName } from './card-store';
import type { Contacts } from './contacts';
import * as schema from './schema';

// Membership truth lives in each card's CATEGORIES, so a rename or delete rewrites every member card. See docs/CONTACTS.md § Labels ↔ CATEGORIES.

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

// What the caller settles once the transaction it lent has committed: the byte delta and the events.
type FanOut = { bytes: number; contactIds: string[]; createdLabelIds: string[] };
const NO_FAN_OUT: FanOut = { bytes: 0, contactIds: [], createdLabelIds: [] };

// Rewrites every member card's CATEGORIES inside the caller's transaction, so the label row and its members
// move together. One ctag for the whole fan-out: a rename is one change to the book.
function rewriteCardCategories(
    contacts: Contacts,
    tx: Tx,
    contactIds: string[],
    transform: (names: string[]) => string[],
): FanOut {
    const rewrites: { row: CardRowInput; was: number; categories: string[] }[] = [];
    for (const contactId of contactIds) {
        const row = tx
            .select({
                id: schema.contacts.id,
                uri: schema.contacts.uri,
                uid: schema.contacts.uid,
                vcard: schema.contacts.vcard,
                firstName: schema.contacts.firstName,
                lastName: schema.contacts.lastName,
                eigenId: schema.contacts.eigenId,
                isGroup: schema.contacts.isGroup,
                data: schema.contacts.data,
            })
            .from(schema.contacts)
            .where(eq(schema.contacts.id, contactId))
            .get();
        if (!row) continue;

        // One corrupt card is skipped and logged rather than failing every later label write.
        let card: ParsedCard;
        try {
            card = parseVCard(new TextDecoder().decode(row.vcard));
        } catch (e) {
            console.warn(`contacts: skipping unreadable card ${row.uri} in the label fan-out: ${e}`);
            continue;
        }
        const categories = transform(card.categories);
        // Unchanged bytes keep their etag, so clients are given nothing to refetch.
        const unchanged =
            categories.length === card.categories.length && categories.every((n, i) => n === card.categories[i]);
        if (unchanged) continue;

        const bytes = new TextEncoder().encode(mergeVCard(card, { categories }));
        rewrites.push({
            // The stored projection, not the fresh parse: only CATEGORIES changed here.
            row: { ...row, vcard: Buffer.from(bytes), etag: computeResourceEtag(bytes) },
            was: row.vcard.byteLength,
            categories,
        });
    }
    if (rewrites.length === 0) return NO_FAN_OUT;

    const createdLabelIds: string[] = [];
    const ctag = contacts.bumpCtag(tx);
    let bytes = 0;
    for (const { row, was, categories } of rewrites) {
        bytes += row.vcard.byteLength - was;
        indexCard(tx, row, categories, ctag, createdLabelIds);
    }
    return { bytes, contactIds: rewrites.map((r) => r.row.id), createdLabelIds };
}

// Everything a fan-out owes the world once its transaction has committed.
function settleFanOut(contacts: Contacts, fanout: FanOut): void {
    contacts.cardsBytes += fanout.bytes;
    for (const id of fanout.createdLabelIds) contacts.emitLabel(SSEventType.LABEL_CREATED, id);
    for (const id of fanout.contactIds) contacts.announce(SSEventType.CONTACT_UPDATED, id);
}

export async function addLabel(contacts: Contacts, label: Omit<Label, 'id'>): Promise<string> {
    // syncCardLabels skips an empty key, so such a label would drop every membership while the save reported success.
    const nameKey = normalizeLabelName(label.name);
    if (!nameKey) throw new ApiError(400, 'Label name is required');

    return contacts.writeLock.run(async () => {
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

    return contacts.writeLock.run(async () => {
        const before = contacts.db
            .select({ name: schema.labels.name, nameKey: schema.labels.nameKey })
            .from(schema.labels)
            .where(eq(schema.labels.id, id))
            .get();
        if (!before) throw new ApiError(404, 'Label not found');
        // Only a display-name change touches cards — the color never appears in a vCard.
        const newName = label.name.trim();
        const renamed = before.name !== newName;
        const members = renamed ? labelMemberIds(contacts, [id]) : [];

        let fanout = NO_FAN_OUT;
        try {
            contacts.db.transaction((tx) => {
                tx.update(schema.labels)
                    .set({ name: newName, nameKey, color: label.color, updatedAt: sql`unixepoch()` })
                    .where(eq(schema.labels.id, id))
                    .run();

                // The label row and every member card move together, so no card is ever left on the old name.
                // Matched case-insensitively: CATEGORIES may carry a different case than the label's stored name.
                if (renamed) {
                    fanout = rewriteCardCategories(contacts, tx, members, (names) =>
                        names.map((n) => (normalizeLabelName(n) === before.nameKey ? newName : n)),
                    );
                }
            });
        } catch (e) {
            rethrowDuplicateLabelName(e);
        }
        settleFanOut(contacts, fanout);
        contacts.emitLabel(SSEventType.LABEL_UPDATED, id);
        // The row committed this exact name and color, so the DTO is assembled rather than read back.
        return { id, name: newName, color: label.color };
    });
}

export async function deleteLabel(contacts: Contacts, id: string): Promise<void> {
    return contacts.writeLock.run(async () => {
        const label = contacts.db
            .select({ nameKey: schema.labels.nameKey })
            .from(schema.labels)
            .where(eq(schema.labels.id, id))
            .get();
        if (!label) return;
        const members = labelMemberIds(contacts, [id]);

        let fanout = NO_FAN_OUT;
        contacts.db.transaction((tx) => {
            fanout = rewriteCardCategories(contacts, tx, members, (names) =>
                names.filter((n) => normalizeLabelName(n) !== label.nameKey),
            );
            // The junction rows cascade with the label row (FK ON DELETE CASCADE).
            tx.delete(schema.labels).where(eq(schema.labels.id, id)).run();
        });
        settleFanOut(contacts, fanout);
        contacts.emitLabel(SSEventType.LABEL_DELETED, id);
    });
}
