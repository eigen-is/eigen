import type { VCardPreview } from '@workspace/lib/types/preview';
import { ApiError } from '../core/errors';
import { decodeUtf8Strict, VCARD_IMPORT_MAX_CARDS } from '../core/transfer';
import { parsedCardToContact, parseVCard, splitVCards, transcodeTo30 } from '../vcard';

// A quick look reads, it doesn't scroll a whole address book: past this the preview serves counts only.
export const VCARD_PREVIEW_MAX_CARDS = 200;

export const parseVCardPreview = (body: string): VCardPreview => JSON.parse(body);

// File bytes → the cards a .vcf preview serves. The only reference that leaves here is an inline PHOTO
// turned into a data: URI by parsedCardToContact — a PHOTO;VALUE=uri is dropped there rather than fetched,
// so an untrusted file cannot make a viewer's browser call a URL it chose.
export function buildVCardPreviewPayload(data: ArrayBuffer): VCardPreview {
    // The same fatal decode both import routes take: a file in another encoding is not a book of names
    // stored with replacement characters.
    const text = decodeUtf8Strict(data);
    if (text === null) throw new ApiError(422, 'Could not read this file');

    let texts: string[];
    try {
        texts = splitVCards(text);
    } catch {
        throw new ApiError(422, 'Could not read this file');
    }

    // No more cards than an import would accept, and one card the parser refuses never costs the
    // preview the rest of the file. A quick look reads, it doesn't scroll a whole address book: past
    // VCARD_PREVIEW_MAX_CARDS the counts are all a surface gets.
    const cards: VCardPreview['cards'] = [];
    let dropped = 0;
    for (const text of texts.slice(0, VCARD_IMPORT_MAX_CARDS)) {
        try {
            const parsed = parseVCard(transcodeTo30(text));
            if (cards.length < VCARD_PREVIEW_MAX_CARDS) cards.push(parsedCardToContact(parsed));
        } catch {
            dropped++;
        }
    }

    return { cards, dropped, total: texts.length };
}
