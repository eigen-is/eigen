// Reads and places the caret in a cell editor or the formula bar. A formula's editor is a row of colored spans
// that is rebuilt as the user types, so a caret is kept as a character offset into the editor's whole text,
// which survives the rebuild, and placed back on whichever text node holds that character.

// The selection as character offsets into the editor's text, or null when the selection is outside it.
export function selectionTextOffsets(editor: HTMLElement): { start: number; end: number } | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
    return {
        start: textOffsetAt(editor, range.startContainer, range.startOffset),
        end: textOffsetAt(editor, range.endContainer, range.endOffset),
    };
}

export function selectTextOffsets(editor: HTMLElement, start: number, end: number) {
    const range = document.createRange();
    range.setStart(...textPoint(editor, start));
    range.setEnd(...textPoint(editor, end));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function textOffsetAt(editor: HTMLElement, node: Node, nodeOffset: number): number {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.setEnd(node, nodeOffset);
    return range.toString().length;
}

// The text node and offset `at` characters into the editor's text. A point between two text nodes is the start of
// the right one, so a caret just before a reference sits in the reference's span, where the reference hints look.
function textPoint(editor: HTMLElement, at: number): [Node, number] {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let left = at;
    let lastText: Text | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node instanceof Text)) continue;
        if (left < node.data.length) return [node, left];
        left -= node.data.length;
        lastText = node;
    }
    return lastText ? [lastText, lastText.data.length] : [editor, 0];
}
