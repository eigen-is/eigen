// What "the same bytes" means in the laws of the workbook: the snapshot text of a book once every formula is
// computed with the book's last clock, as `content` gives it. It does not depend on look ids or on the history of
// the book.

import { encodeBook } from '@workspace/lib/sheets/book-codec';
import type { Workbook } from '../../../engine/book/workbook';

export function bytes(book: Workbook): string {
    while (book.engine.recalc(Number.MAX_SAFE_INTEGER).stopped);
    return encodeBook(book.content());
}
