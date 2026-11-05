// Where a sheet's comment cards sit: the card ids in a cell's `commentCardIds`, on any sheet of the workbook. The
// editor asks two things of them: which cards are anchored, for the comments pane and its counts, and how a delete
// takes a card off its cells. Both read every sheet, because a card on a tab that is not open is still in use.

import { columnIndexToLabel } from '@workspace/lib/sheets';
import type { ActiveComments } from '@workspace/lib/types/comments';
import type { Sheet, WorkbookInstance } from '@workspace/sheet';

// A card on several cells takes the first one as its anchor text, in the order the workbook lists its sheets. A card
// on the open tab reads as "Cell B2", and one on another tab names that tab, as "Sheet2 · B2". A large sheet has many
// cells and few comments, so the walk skips a cell with none before anything else.
export function anchoredComments(sheets: readonly Sheet[], currentSheetId: string): ActiveComments {
    const ids = new Set<string>();
    const anchorTexts = new Map<string, string>();
    for (const sheet of sheets) {
        if (!sheet.data) continue;
        const tab = sheet.id === currentSheetId ? 'Cell ' : `${sheet.name} · `;
        for (let r = 0; r < sheet.data.length; r++) {
            const row = sheet.data[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c++) {
                const cellCardIds = row[c]?.commentCardIds;
                if (!cellCardIds?.length) continue;
                for (const cardId of cellCardIds) {
                    ids.add(cardId);
                    if (!anchorTexts.has(cardId)) anchorTexts.set(cardId, `${tab}${columnIndexToLabel(c)}${r + 1}`);
                }
            }
        }
    }
    return { ids, anchorTexts };
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
