import { IMPORT_MAX_CARDS, VCARD_PREVIEW_MAX_CARDS } from '@workspace/lib/constants/contact';
import { ApiError } from '../core/errors';
import { parseVCard } from '../vcard/parse';
import { splitVCards } from '../vcard/split';
import { parsedCardToContact } from '../vcard/to-contact';
import { transcodeTo30 } from '../vcard/transcode';
import type { VCardPreview } from './vcard-preview-payload';

// File bytes → the cards a .vcf preview serves. Runs inside the transform Worker (worker.ts owns
// execution; the main-thread orchestration lives in preview-cache.ts). This module must not reach the
// Mount or the transform seam — the Worker imports it, and its type-only import of the payload schema
// keeps Elysia out of the Worker.
//
// The only reference that leaves here is an inline PHOTO turned into a data: URI by parsedCardToContact —
// a PHOTO;VALUE=uri is dropped there rather than fetched, so an untrusted file cannot make a viewer's
// browser call a URL it chose.
export function buildVCardPreviewPayload(data: ArrayBuffer): VCardPreview {
    let texts: string[];
    try {
        // The same fatal decode both import routes take: a file in another encoding is not a book of
        // names stored with replacement characters.
        texts = splitVCards(new TextDecoder('utf-8', { fatal: true }).decode(data));
    } catch {
        throw new ApiError(422, 'Could not read this file');
    }

    // No more cards than an import would accept, and one card the parser refuses never costs the
    // preview the rest of the file. A quick look reads, it doesn't scroll a whole address book: past
    // VCARD_PREVIEW_MAX_CARDS the counts are all a surface gets.
    const cards: VCardPreview['cards'] = [];
    let dropped = 0;
    for (const text of texts.slice(0, IMPORT_MAX_CARDS)) {
        try {
            const parsed = parseVCard(transcodeTo30(text));
            if (cards.length < VCARD_PREVIEW_MAX_CARDS) cards.push(parsedCardToContact(parsed));
        } catch {
            dropped++;
        }
    }

    return { cards, dropped, total: texts.length };
}
