// Whole-file vCard transfer for an address book. Export joins the stored cards into one .vcf file
// and leaves out the lines that belong to Eigen alone. Import splits a file into cards and saves
// each one through putCard, as a CardDAV PUT would. Routes for "import" and "export" call it.

import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { eq } from 'drizzle-orm';
import { ApiError, decodeUtf8Strict, NOT_A_VCARD_FILE, NOT_UTF8_FILE, VCARD_IMPORT_MAX_CARDS } from '../core';
import {
    makeLine,
    parseVCard,
    parseVCardLines,
    serializeVCardLines,
    splitVCards,
    transcodeTo30,
    VCardError,
} from '../vcard';
import type { ParsedCard, VCardLine } from '../vcard/types';
import type { Contacts } from './contacts';
import * as davStore from './dav-store';
import * as schema from './schema';
import { buildContactsChangedEvent } from './sse-events';

// X-EIGEN-ID carries the account's uuid, which no export may hand out.
const isEigenName = (name: string) => name.startsWith('X-EIGEN-');

// A whole-book export leaves out groups, as import does. Every line but Eigen's own is written from its source bytes.
export async function exportCards(contacts: Contacts, ids?: readonly string[]): Promise<string> {
    const targets =
        ids ??
        contacts.db
            .select({ id: schema.contacts.id })
            .from(schema.contacts)
            .where(eq(schema.contacts.isGroup, false))
            .all()
            .map((row) => row.id);

    const cards: string[] = [];
    for (const id of targets) {
        // Read one card at a time: the whole book's bytes at once is the one query that would not scale.
        const row = contacts.db
            .select({ uri: schema.contacts.uri, vcard: schema.contacts.vcard })
            .from(schema.contacts)
            .where(eq(schema.contacts.id, id))
            .get();
        if (!row) throw new ApiError(404, 'Contact not found');
        let lines: VCardLine[];
        try {
            lines = parseVCardLines(new TextDecoder().decode(row.vcard));
        } catch (e) {
            // Bytes that will not parse cannot have Eigen's own lines taken out of them, so they stay in.
            console.warn(`contacts: skipping ${row.uri} in the export — it does not parse: ${e}`);
            continue;
        }
        cards.push(serializeVCardLines(lines.filter((line) => !isEigenName(line.name))));
    }
    return cards.join('');
}

// Strict UTF-8, as RFC 6350 §3.1 asks. Decoded leniently, a Windows-1252 export would store U+FFFD in every accented
// name and serve it again to DAV clients.
export async function importCards(contacts: Contacts, bytes: Uint8Array): Promise<ImportCountsResult> {
    const text = decodeUtf8Strict(bytes);
    if (text === null) throw new ApiError(400, NOT_UTF8_FILE);

    let cards: string[];
    try {
        cards = splitVCards(text);
    } catch (e) {
        if (e instanceof VCardError) throw new ApiError(400, NOT_A_VCARD_FILE);
        throw e;
    }
    if (cards.length > VCARD_IMPORT_MAX_CARDS) throw new ApiError(413, 'Too many cards');

    // Built outside the write lock, so a concurrent import or DAV PUT may still add the same address twice.
    const emails = new Set<string>();
    for (const contact of await contacts.getContacts()) {
        for (const email of contact.email) {
            if (email.trim()) emails.add(email.trim().toLowerCase());
        }
    }

    const result: ImportCountsResult = { imported: 0, skipped: 0, failed: 0 };
    // The store announces nothing, so the file is one event, sent even when a refusal stops it partway.
    try {
        for (const card of cards) {
            let parsed: ParsedCard;
            let body: string;
            try {
                body = transcodeTo30(card);
                parsed = parseVCard(body);
            } catch {
                result.failed++;
                continue;
            }

            // A group is no contact and no duplicate, so it counts as neither: the client calls a skip a duplicate.
            if (parsed.isGroup) continue;
            if (parsed.uid) {
                // Queried per card, so the loop's own writes count: a repeated UID skips like a re-import.
                const stored = contacts.db
                    .select({ id: schema.contacts.id })
                    .from(schema.contacts)
                    .where(eq(schema.contacts.uid, parsed.uid))
                    .get();
                if (stored) {
                    result.skipped++;
                    continue;
                }
            }
            const firstEmail = parsed.email[0]?.trim().toLowerCase();
            if (firstEmail && emails.has(firstEmail)) {
                result.skipped++;
                continue;
            }
            if (!parsed.uid) body = withMintedUid(parsed);

            // A UID is not a safe filename (Apple's `…:ABPerson`, `urn:uuid:`), so mint one; If-None-Match: * keeps the write a create.
            const put = await davStore.putCard(contacts, `${crypto.randomUUID()}.vcf`, body, {
                ifMatch: null,
                ifNoneMatch: '*',
                import: true,
            });
            if (put.ok) {
                result.imported++;
                for (const email of parsed.email) {
                    if (email.trim()) emails.add(email.trim().toLowerCase());
                }
            } else if (put.error === 'uid-conflict') {
                result.skipped++;
            } else if (put.error === 'quota') {
                throw new ApiError(507, `Storage quota exceeded after importing ${result.imported} contacts`);
            } else {
                result.failed++;
            }
        }
    } finally {
        if (result.imported > 0) contacts.home.broadcast(buildContactsChangedEvent());
    }
    return result;
}

function withMintedUid(parsed: ParsedCard): string {
    const version = parsed.lines.findIndex((line) => line.name === 'VERSION');
    const lines = [...parsed.lines];
    lines.splice(version === -1 ? 1 : version + 1, 0, makeLine('UID', crypto.randomUUID()));
    return serializeVCardLines(lines);
}
