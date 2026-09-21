import { randomUUID } from 'node:crypto';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { eq } from 'drizzle-orm';
import {
    ApiError,
    decodeUtf8Strict,
    NOT_A_VCARD_FILE,
    NOT_UTF8_FILE,
    readResourceFile,
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
import { cardPath } from './card-store';
import type { Contacts } from './contacts';
import * as schema from './schema';

// Whole-file vCard transfer over the Contacts facade: export concatenates the stored 3.0 cards, import
// replays a multi-card file through the CardDAV PUT seam so every card is stored byte-faithfully and metered
// by the same gate a device sync takes. See docs/CONTACTS.md § vCard import / export.

// Which lines of a stored card are Eigen's own bookkeeping rather than the user's data. Only `X-EIGEN-ID`
// exists today, and it carries the account's uuid, which no export may hand out.
const isEigenName = (name: string) => name.startsWith('X-EIGEN-');

// The stored cards for `ids`, in that order — or the whole book (groups excluded, as the contact list serves
// it, symmetric with import skipping them). Each card's terminator is normalized to exactly one CRLF so the
// concatenation is one well-formed directory whatever the writers left behind; every line but Eigen's own is
// re-emitted from its own source bytes, PHOTO and unknown properties included.
export async function exportCards(contacts: Contacts, ids?: string[]): Promise<string> {
    await contacts.gate.ensureDrained();
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
        const bytes = await readResourceFile(contacts.storage, cardPath(uri));
        // A row whose file is gone is a torn pair the next drain repairs; it is nothing to export.
        if (!bytes) continue;
        let lines: VCardLine[];
        try {
            lines = parseVCardLines(new TextDecoder().decode(bytes));
        } catch (e) {
            // Bytes that will not parse cannot have Eigen's own lines taken out of them, so they stay in.
            console.warn(`contacts: skipping ${uri} in the export — it does not parse: ${e}`);
            continue;
        }
        cards.push(serializeVCardLines(lines.filter((line) => !isEigenName(line.name))));
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

// Replay a multi-card file into the book, bytes in: the decode and the parse are the domain's, as the
// mail and calendar imports' are. vCard files are UTF-8 (RFC 6350 §3.1) — decoded leniently a
// Windows-1252 export would import with U+FFFD in every accented name, stored in the card bytes and
// re-served to every DAV client. Duplicates skip, never merge: a card whose UID is already in the book,
// or whose first email already belongs to a contact, is counted and passed over — the running Set means
// a file that repeats an address imports it once. A card that fails on its own content (unparseable,
// refused by the PUT) is counted and the file continues; only the shared storage quota stops the run,
// because every later card would be refused the same way.
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
    });
    return result;
}
