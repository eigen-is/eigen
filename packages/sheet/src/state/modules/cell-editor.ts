// Opening the in-cell editor, in one step inside the opener's recipe: the position, the editor's text with the formula
// bar's copy of it, and the caret, so nothing is left for a render to finish. Every opener comes here, such as a typed
// key, a double click, the formula bar or Insert function. It loads the cell only as it opens: from then on the text is
// the person's, whatever a peer does to the cell or its row.

import { escapeHtml } from '@workspace/lib/html';
import { valueShowEs } from '../../engine/format';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import { getFormulaHtml, getInlineStringHTML } from './cell';
import { createRangeHighlight } from './formula-range';
import { isInlineStringCell, placeEditorCaret } from './inline-string';

// `html` replaces the cell's text and must be markup we built or escaped. The bar gets it too; without it the bar already
// shows the cell and may hold the caret. Without `caret` the caret stays put, because moving it would break a composition
// the typed key starts.
export function openCellEditor(
    ctx: Context,
    r: number,
    c: number,
    { html, caret }: { html?: string; caret?: number | 'end' } = {},
) {
    if (html === undefined && ctx.editingCellPosition.length > 0) return;
    ctx.editingCellPosition = [r, c];
    const input = ctx.getRefs().cellInput.current;
    if (!input) return;
    input.innerHTML = html ?? loadCellHtml(ctx, r, c);
    const fxInput = ctx.getRefs().fxInput.current;
    if (html !== undefined && fxInput) fxInput.innerHTML = html;
    if (caret !== undefined) placeEditorCaret(input, caret);
}

function loadCellHtml(ctx: Context, r: number, c: number): string {
    const flowdata = getFlowdata(ctx);
    const cell = flowdata?.[r]?.[c];
    if (!flowdata || !cell) return '';
    if (isInlineStringCell(cell)) return getInlineStringHTML(r, c, flowdata);
    if (cell.f) {
        const formulaHtml = getFormulaHtml(r, c, flowdata) ?? '';
        createRangeHighlight(ctx, formulaHtml);
        return formulaHtml;
    }
    return escapeHtml(String(valueShowEs(r, c, flowdata) ?? ''));
}
