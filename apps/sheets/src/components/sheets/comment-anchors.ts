// Where a sheet's comment cards sit: the card ids in a cell's `commentCardIds`, on any sheet of the workbook. The
// editor asks two things of them: which cards are anchored, for the comments pane and its counts, and how a delete
// takes a card off its cells. Both read every sheet, because a card on a tab that is not open is still in use.

import { columnIndexToLabel } from '@workspace/lib/sheets';
import type { ActiveComments } from '@workspace/lib/types/comments';
import type { Sheet, WorkbookInstance } from '@workspace/sheet';

// A card on several cells takes the first one as its anchor text, in the order the workbook lists its sheets.
export function anchoredComments(sheets: readonly Sheet[]): ActiveComments {
    const ids = new Set<string>();
    const anchorTexts = new Map<string, string>();
    for (const sheet of sheets) {
        for (const [r, row] of (sheet.data ?? []).entries()) {
            for (const [c, cell] of (row ?? []).entries()) {
                for (const cardId of cell?.commentCardIds ?? []) {
                    ids.add(cardId);
                    if (!anchorTexts.has(cardId)) anchorTexts.set(cardId, `Cell ${columnIndexToLabel(c)}${r + 1}`);
                }
            }
        }
    }
    return { ids, anchorTexts };
}

// The delete is one undo step, so one ⌘Z puts the card back on every cell it was on.
export function stripCommentCard(workbook: WorkbookInstance, cardId: string): void {
    const release = workbook.beginGesture();
    for (const sheet of workbook.getAllSheets()) {
        for (const [r, row] of (sheet.data ?? []).entries()) {
            for (const [c, cell] of (row ?? []).entries()) {
                const ids = cell?.commentCardIds;
                if (!ids?.includes(cardId)) continue;
                const kept = ids.filter((id) => id !== cardId);
                workbook.setCellFormat(r, c, 'commentCardIds', kept, { id: sheet.id });
            }
        }
    }
    release();
}
