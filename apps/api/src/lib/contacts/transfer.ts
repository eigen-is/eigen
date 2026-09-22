import { randomUUID } from 'node:crypto';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { eq } from 'drizzle-orm';
import {
    ApiError,
    decodeUtf8Strict,
    NOT_A_VCARD_FILE,
    NOT_UTF8_FILE,
    type PutResourceResult,
    VCARD_IMPORT_MAX_CARDS,
} from '../core';
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
import * as schema from './schema';

// Whole-file vCard transfer; import replays each card through the CardDAV PUT seam. See docs/CONTACTS.md § vCard import / export.

// X-EIGEN-ID carries the account's uuid, which no export may hand out.
const isEigenName = (name: string) => name.startsWith('X-EIGEN-');

// Groups are excluded, as import skips them; every line but Eigen's own re-emits from its own source bytes.
export async function exportCards(contacts: Contacts, ids?: string[]): Promise<string> {
    const rows = contacts.db
        .select({ id: schema.contacts.id, isGroup: schema.contacts.isGroup })
        .from(schema.contacts)
        .all();
    const targets = ids ?? rows.filter((row) => !row.isGroup).map((row) => row.id);

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

function withMintedUid(parsed: ParsedCard): string {
    const version = parsed.lines.findIndex((line) => line.name === 'VERSION');
    const lines = [...parsed.lines];
    lines.splice(version === -1 ? 1 : version + 1, 0, makeLine('UID', randomUUID()));
    return serializeVCardLines(lines);
}

// Strict UTF-8 (RFC 6350 §3.1): decoded leniently, a Windows-1252 export stores U+FFFD in every accented name and re-serves it to DAV clients.
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

    const emails = new Set<string>();
    for (const contact of await contacts.getContacts()) {
        for (const email of contact.email) {
            if (email.trim()) emails.add(email.trim().toLowerCase());
        }
    }

    const result: ImportCountsResult = { imported: 0, skipped: 0, failed: 0 };
    // One list-level event for the whole file instead of one per card (a thousand cards were a thousand broadcasts).
    await contacts.withBatchedEvents(async () => {
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

            if (parsed.isGroup) {
                result.skipped++;
                continue;
            }
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
            let put: PutResourceResult;
            try {
                put = await contacts.putCard(`${randomUUID()}.vcf`, body, { ifMatch: null, ifNoneMatch: '*' });
            } catch {
                // One card's write failing is that card's failure; a retry finishes the file.
                result.failed++;
                continue;
            }
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
    });
    return result;
}
