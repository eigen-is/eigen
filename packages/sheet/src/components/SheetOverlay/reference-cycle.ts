import { cycleReferenceAtCaret } from '../../engine/formula-reference-cycle';
import {
    type Context,
    cancelFunctionrangeSelected,
    createRangeHightlight,
    functionHTMLGenerate,
    rangeHightlightselected,
    resetRangeIndexes,
} from '../../state';

// Plain-text offset (character count) from the start of `editor` up to a DOM point.
function textOffsetAt(editor: HTMLElement, node: Node, nodeOffset: number): number {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.setEnd(node, nodeOffset);
    return range.toString().length;
}

function getSelectionOffsets(editor: HTMLElement): { start: number; end: number } | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
    const start = textOffsetAt(editor, range.startContainer, range.startOffset);
    const end = textOffsetAt(editor, range.endContainer, range.endOffset);
    return { start: Math.min(start, end), end: Math.max(start, end) };
}

// Map a plain-text offset back onto the editor's (possibly multi-span) text nodes.
// On a node boundary the offset lands at the START of the next text node, so a
// selection anchored at a reference begins in the reference's own span (the
// anchor-based hint heuristics read the span under the anchor).
function locateOffset(editor: HTMLElement, target: number): { node: Node; offset: number } {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let remaining = target;
    let lastText: Text | null = null;
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        if (remaining < node.data.length) return { node, offset: remaining };
        remaining -= node.data.length;
        lastText = node;
    }
    return lastText ? { node: lastText, offset: lastText.data.length } : { node: editor, offset: 0 };
}

function setSelectionOffsets(editor: HTMLElement, start: number, end: number) {
    const from = locateOffset(editor, start);
    const to = locateOffset(editor, end);
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

// Wires F4 reference-cycling for the cell input and the fx box. Reads the editor's
// plain text + caret, cycles the reference at the caret through the pure engine
// helper, then writes back the way the editor's other programmatic writers do
// (autocomplete's insertFormulaFunctionDom, range-drag's rangeSetValue): rebuild the
// highlight spans directly with functionHTMLGenerate — the same span deriver every
// keystroke uses, so the DOM matches typed input — place the selection explicitly,
// and mirror into `copyTo` (cell input ⇄ fx box). handleFormulaInput is deliberately
// NOT used: its functionRange/findrangeindex caret recovery assumes a keystroke-shaped
// before/after DOM and walks off a 1-char text node on a whole-text replacement, and
// here the caret target is known exactly. The context updates mirror
// handleFormulaInput's tail: clear stale range-select state, re-derive the formula
// range highlights, and refresh the function hint at the new selection.
// A no-op (caret not on a reference, or non-formula text) simply returns.
export function cycleReferenceInEditor(
    editor: HTMLDivElement,
    copyTo: HTMLDivElement | null | undefined,
    setContext: (recipe: (ctx: Context) => void) => void,
) {
    const offsets = getSelectionOffsets(editor);
    if (!offsets) return;

    const result = cycleReferenceAtCaret(editor.innerText, offsets.start, offsets.end);
    if (!result) return;

    setContext((draftCtx) => {
        resetRangeIndexes();
        const html = functionHTMLGenerate(result.text);
        editor.innerHTML = html;
        if (copyTo) copyTo.innerHTML = html;
        setSelectionOffsets(editor, result.selectionStart, result.selectionEnd);

        cancelFunctionrangeSelected(draftCtx);
        createRangeHightlight(draftCtx, html);
        draftCtx.formulaCache.rangestart = false;
        draftCtx.formulaCache.rangedrag_column_start = false;
        draftCtx.formulaCache.rangedrag_row_start = false;
        rangeHightlightselected(draftCtx, editor);
    });
}
