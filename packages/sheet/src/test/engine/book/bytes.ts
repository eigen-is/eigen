// What "the same bytes" means in the laws of the workbook: the snapshot text of a book once every formula is
// computed with the book's last clock, as `content` gives it. It does not depend on look ids or on the history of
// the book. And the server's fold, which writes the snapshot a later reader loads.

import type { BookContent } from '@workspace/lib/sheets/book-codec';
import { decodeBook, encodeBook } from '@workspace/lib/sheets/book-codec';
import type { Batch } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';

export function bytes(book: Workbook): string {
    while (book.engine.recalc(Number.MAX_SAFE_INTEGER).stopped);
    return encodeBook(book.content());
}

// A snapshot's text with the batches after it folded in: decoded and loaded, each batch landed with its clock and a
// refused one skipped, passes of `cap` formulas until one does not stop, and the content encoded. It counts the
// passes that stopped into `stops`.
export function fold(text: string, batches: readonly Batch[], cap = Number.MAX_SAFE_INTEGER, stops = { n: 0 }): string {
    const book = new Workbook(decoded(text));
    for (const { ops, now, seed } of batches) {
        try {
            applyOps(book, ops);
        } catch (error) {
            if (error instanceof Refusal) continue;
            throw error;
        }
        book.setClock(now, seed);
    }
    while (book.engine.recalc(cap).stopped) stops.n += 1;
    return encodeBook(book.content());
}

export function decoded(text: string): BookContent {
    const content = decodeBook(text);
    if (!content) throw new Error('the text is no book');
    return content;
}
