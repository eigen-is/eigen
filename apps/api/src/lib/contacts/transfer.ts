import { randomUUID } from 'node:crypto';
import { IMPORT_MAX_CARDS } from '@workspace/lib/constants/contact';
import type { ImportContactsResult, ParsedCard } from '@workspace/lib/types/contact';
import {
    makeLine,
    parseVCard,
    serializeVCardLines,
    splitVCards,
    transcodeTo30,
    VCardError,
} from '@workspace/lib/vcard';
import { eq } from 'drizzle-orm';
import { ApiError } from '../core';
import type { Contacts } from './contacts';
import * as schema from './schema';

// Whole-file vCard transfer over the Contacts facade: export concatenates the stored 3.0 cards, import
// replays a multi-card file through the CardDAV PUT seam so every card is stored byte-faithfully and metered
// by the same gate a device sync takes. See docs/CONTACTS.md § vCard import / export.

// The stored cards for `ids`, in that order — or the whole book (groups excluded, as the contact list serves
// it, symmetric with import skipping them). Each card's terminator is normalized to exactly one CRLF so the
// concatenation is one well-formed directory whatever the writers left behind; the bytes are otherwise the
// ones on disk, PHOTO and unknown properties included.
export async function exportCards(contacts: Contacts, ids?: string[]): Promise<string> {
    await contacts.ensureDrained();
    const rows = contacts.db
        .select({ id: schema.contacts.id, uri: schema.contacts.uri, isGroup: schema.contacts.isGroup })
        .from(schema.contacts)
        .all();
    const uriById = new Map(rows.map((row) => [row.id, row.uri]));
    const targets = ids ?? rows.filter((row) => !row.isGroup).map((row) => row.id);

    const cards: string[] = [];
    for (const id of targets) {
        const uri = uriById.get(id);
        if (!uri) throw new ApiError(404, 'Contact not found');
        const text = new TextDecoder().decode(await contacts.readCardBytes(uri));
        cards.push(`${text.replace(/[\r\n]+$/, '')}\r\n`);
    }
    return cards.join('');
}

// The UID a card is stored under: its own, or a minted one spliced in after VERSION (after BEGIN when the
// card carries no VERSION line). Every other line re-emits from its own source bytes.
function withMintedUid(parsed: ParsedCard): string {
    const version = parsed.lines.findIndex((line) => line.name === 'VERSION');
    const lines = [...parsed.lines];
    lines.splice(version === -1 ? 1 : version + 1, 0, makeLine('UID', randomUUID()));
    return serializeVCardLines(lines);
}

// Replay a multi-card file into the book. Duplicates skip, never merge (spec R1): a card whose UID is
// already in the book, or whose first email already belongs to a contact, is counted and passed over — the
// running Set means a file that repeats an address imports it once. A card that fails on its own content
// (unparseable, refused by the PUT) is counted and the file continues; only the shared storage quota stops
// the run, because every later card would be refused the same way.
export async function importCards(contacts: Contacts, text: string): Promise<ImportContactsResult> {
    let cards: string[];
    try {
        cards = splitVCards(text);
    } catch (e) {
        if (e instanceof VCardError) throw new ApiError(400, 'Not a vCard file');
        throw e;
    }
    if (cards.length > IMPORT_MAX_CARDS) throw new ApiError(413, 'Too many cards');

    const emails = new Set<string>();
    for (const contact of await contacts.getContacts()) {
        for (const email of contact.email) {
            if (email.trim()) emails.add(email.trim().toLowerCase());
        }
    }

    const result: ImportContactsResult = { imported: 0, skipped: 0, failed: 0 };
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

        // A fresh resource name every time: a UID is not a safe filename (Apple's `…:ABPerson`, `urn:uuid:`
        // and anything else sanitizeCardUri refuses), and If-None-Match: * keeps the write a create.
        const put = await contacts.putCard(`${randomUUID()}.vcf`, body, { ifMatch: null, ifNoneMatch: '*' });
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
    return result;
}
