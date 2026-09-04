import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

// ⌘C/⌘X leave the clipboard to a live text selection outside the canvas — the user is copying that
// run, not the shapes behind it. The canvas surface is `select-none`, so nothing on it ever collapses
// a selection made elsewhere: the pointerdown that selects an element drops it instead. This file
// borrows a happy-dom document the way the element-layer test next door does.
const window = new Window();
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.document = window.document;
g.Node = window.Node;

afterAll(() => {
    g.document = undefined;
    g.Node = undefined;
});

const { dropOutsideTextSelection } = await import('../../../../components/vector/hooks/use-canvas-clipboard');

function selectContents(node: Node): Selection {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = document.getSelection();
    if (!selection) throw new Error('the document has no selection');
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
}

function surfaces(): { canvas: HTMLElement; comment: HTMLElement } {
    document.body.innerHTML = '<div id="comment">a comment run</div><div id="canvas"><p>element text</p></div>';
    const comment = document.getElementById('comment');
    const canvas = document.getElementById('canvas');
    if (!comment || !canvas) throw new Error('the fixture lost a surface');
    return { canvas, comment };
}

describe('dropOutsideTextSelection', () => {
    test('drops a run selected outside the canvas, so the next copy is the element', () => {
        const { canvas, comment } = surfaces();
        const selection = selectContents(comment);
        expect(selection.isCollapsed).toBe(false);

        dropOutsideTextSelection(canvas);
        expect(document.getSelection()?.rangeCount).toBe(0);
    });

    test('keeps a selection made inside the canvas', () => {
        const { canvas } = surfaces();
        selectContents(canvas);

        dropOutsideTextSelection(canvas);
        expect(document.getSelection()?.toString()).toBe('element text');
    });

    test('leaves a collapsed selection alone: a caret is not a copy', () => {
        const { canvas, comment } = surfaces();
        const selection = selectContents(comment);
        selection.collapseToStart();

        dropOutsideTextSelection(canvas);
        expect(document.getSelection()?.rangeCount).toBe(1);
    });

    test('a canvas that never mounted is a no-op', () => {
        surfaces();
        expect(() => dropOutsideTextSelection(null)).not.toThrow();
    });
});
