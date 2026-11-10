// F4 in the cell editor or the formula bar cycles the reference at the caret: A1, $A$1, A$1, $A1 and back. The
// editor's text and selection go through cycleReferenceAtCaret, and the result is written back as the colored spans
// a typed formula gets, with the selection over the new reference and a copy in the other editor.

import { cycleReferenceAtCaret } from '../../engine/formula-reference-cycle';
import type { Context } from '../../state';
import {
    cancelFunctionrangeSelected,
    createRangeHightlight,
    functionHTMLGenerate,
    rangeHightlightselected,
    resetRangeIndexes,
    selectionTextOffsets,
    selectTextOffsets,
} from '../../state';

export function cycleReferenceInEditor(
    editor: HTMLDivElement,
    copyTo: HTMLDivElement | null | undefined,
    setContext: (recipe: (ctx: Context) => void) => void,
) {
    const offsets = selectionTextOffsets(editor);
    if (!offsets) return;

    const result = cycleReferenceAtCaret(editor.innerText, offsets.start, offsets.end);
    if (!result) return;

    setContext((draftCtx) => {
        resetRangeIndexes();
        const html = functionHTMLGenerate(result.text);
        editor.innerHTML = html;
        if (copyTo) copyTo.innerHTML = html;
        selectTextOffsets(editor, result.selectionStart, result.selectionEnd);

        cancelFunctionrangeSelected(draftCtx);
        createRangeHightlight(draftCtx, html);
        draftCtx.formulaCache.rangestart = false;
        draftCtx.formulaCache.rangedrag_column_start = false;
        draftCtx.formulaCache.rangedrag_row_start = false;
        rangeHightlightselected(draftCtx, editor);
    });
}
