// Where a sheet's comment cards sit: the card ids in a cell's `commentCardIds`, on any sheet of the workbook. The
// editor asks two things of them: which cards are anchored and where, for the comments pane and its counts, and how a
// delete takes a card off its cells. Both read every sheet, because a card on a tab that is not open is still in use.

import type { ActiveComments } from '@workspace/lib/types/comments';
import type { SearchHighlight, Sheet, WorkbookInstance } from '@workspace/sheet';
import { sheetOrder } from '@workspace/sheet';

type AnchoredComments = ActiveComments & {
    titlePrefixes: ReadonlyMap<string, string>;
    firstCells: ReadonlyMap<string, SearchHighlight>;
};

// A card on several cells counts as being on the first, in tab order, so a prefix names the sheet a jump goes to. A
// large sheet has many cells and few comments, so the walk skips a cell with none before anything else.
export function anchoredComments(sheets: readonly Sheet[], currentSheetId: string): AnchoredComments {
    const ids = new Set<string>();
    const titlePrefixes = new Map<string, string>();
    const firstCells = new Map<string, SearchHighlight>();
    for (const sheet of [...sheets].sort((a, b) => sheetOrder(a) - sheetOrder(b))) {
        if (!sheet.data) continue;
        for (let r = 0; r < sheet.data.length; r++) {
            const row = sheet.data[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c++) {
                const cellCardIds = row[c]?.commentCardIds;
                if (!cellCardIds?.length) continue;
                for (const cardId of cellCardIds) {
                    ids.add(cardId);
                    if (firstCells.has(cardId)) continue;
                    firstCells.set(cardId, { sheetId: sheet.id, r, c });
                    if (sheet.id !== currentSheetId) titlePrefixes.set(cardId, sheet.name);
                }
            }
        }
    }
    return { ids, titlePrefixes, firstCells };
}

// The delete is one undo step, so one ⌘Z puts the card back on every cell it was on. A write that throws still ends
// the step, or every later edit would join it.
export function stripCommentCard(workbook: WorkbookInstance, cardId: string): void {
    const release = workbook.beginGesture();
    try {
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
    } finally {
        release();
    }
}
