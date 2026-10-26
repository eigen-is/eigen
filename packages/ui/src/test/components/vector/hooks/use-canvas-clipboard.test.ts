import { afterEach, describe, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';

// ⌘C/⌘X leave the clipboard to a live text selection outside the canvas — the user is copying that
// run, not the shapes behind it. The canvas surface is `select-none`, so nothing on it ever collapses
// a selection made elsewhere: the pointerdown that selects an element drops it instead. ⌘V places
// another app's chart item as a chart element, another app's text item at its size in pt, and a canvas copy's own
// elements item as itself.
installHappyDom();
// A pasted text box is measured on a 2d canvas, which happy-dom does not implement.
// biome-ignore lint/suspicious/noExplicitAny: test-only DOM stub happy-dom does not implement
(window.HTMLCanvasElement.prototype as any).getContext = () => ({ font: '', measureText: () => ({ width: 40 }) });

const { createElement } = await import('react');
const { MAX_CHART_SPEC_BYTES, newChartSpecParts, sampleChartSpec } = await import('@workspace/lib/charts');
const { writeEigenClipboard } = await import('@workspace/lib/clipboard');
const {
    buildElementsClipboardItem,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_SCENE_META,
    ELEMENT_KINDS,
    solidFill,
    VECTOR_STYLE_DEFAULTS,
} = await import('@workspace/lib/vector');
const { renderInDocument } = await import('../../../render-in-document');
const { dropOutsideTextSelection, useCanvasClipboard } = await import(
    '../../../../components/vector/hooks/use-canvas-clipboard'
);
type EigenClipboardItem = import('@workspace/lib/types/clipboard').EigenClipboardItem;
type NewVectorElement = import('@workspace/lib/vector').NewVectorElement;
type VectorElement = import('@workspace/lib/vector').VectorElement;

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

describe("⌘V of another app's items", () => {
    let unmount: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await unmount?.();
        unmount = undefined;
    });

    // A deck at DEFAULT_SCENE_META's 960 pt unless a drawing is asked for.
    async function pasteOnCanvas(
        items: EigenClipboardItem[],
        viewport: 'infinite' | 'frame' = 'frame',
    ): Promise<NewVectorElement[]> {
        const added: NewVectorElement[] = [];
        const addElements = mock((partials: NewVectorElement[]) => {
            added.push(...partials);
            return partials.map((_, i) => `new-${i}`);
        });
        const noop = () => {};
        function Host() {
            useCanvasClipboard({
                canEdit: true,
                textEditingRef: { current: false },
                containerRef: { current: null },
                viewport,
                frameId: 'f1',
                styleDefaults: VECTOR_STYLE_DEFAULTS,
                ordered: [],
                meta: DEFAULT_SCENE_META,
                selectedIds: [],
                setSelectedIds: noop,
                addElement: () => undefined,
                addElements,
                updateElements: noop,
                updateElementUntracked: noop,
                deleteElements: noop,
                deleteElementsUntracked: noop,
                undoManager: null,
                viewportCenterScene: () => ({ x: 960, y: 540 }),
                insertImageFiles: async () => {},
                mediaFolderId: null,
                resolveMediaPath: () => undefined,
                resolveMediaUrl: () => null,
                uploadFile: async () => null,
            });
            return null;
        }
        ({ unmount } = await renderInDocument(createElement(Host)));
        const event = new ClipboardEvent('paste', {
            clipboardData: new DataTransfer(),
            bubbles: true,
            cancelable: true,
        });
        writeEigenClipboard(event, { version: 1, items });
        document.dispatchEvent(event);
        return added;
    }

    const parts = newChartSpecParts(sampleChartSpec('bar'));

    const look = {
        fill: solidFill('#ffeeaa', 'zigzag'),
        color: '#ffffff',
        strokeColor: '#336699',
        strokeWidth: 4,
        strokeStyle: 'dotted',
        roughness: 2,
        seed: 77,
    } as const;

    test("another app's chart lands as a chart element at its size, centered, its spec and look as they came", async () => {
        const added = await pasteOnCanvas([{ type: 'chart', parts, width: 600.5, height: 371, look }]);
        expect(added).toEqual([
            {
                type: 'chart',
                x: 960 - 600.5 / 2,
                y: 540 - 371 / 2,
                width: 600.5,
                height: 371,
                angle: 0,
                ...newChartSpecParts(sampleChartSpec('bar')),
                ...look,
            },
        ]);
    });

    // Each part as the text it came as: a newer build's part is kept, one that doesn't parse stays as it is, and a keyed
    // part the item lacks is the empty record a new chart holds.
    test("another app's chart keeps every part it carries, and a keyed part it lacks lands empty", async () => {
        const { specPoints, ...rest } = parts;
        const carried = { ...rest, specTitle: '{"text":', specFuture: '{"later":true}' };
        const added = await pasteOnCanvas([{ type: 'chart', parts: carried, width: 600, height: 371, look }]);
        expect(added).toEqual([expect.objectContaining({ ...carried, specPoints: '{}' })]);
        expect(specPoints).toBe('{}');
    });

    // At the limit as the item carries it, past it once the canvas adds the specPoints it lacks.
    test("another app's chart that would land past the byte limit pastes nothing", async () => {
        const { specPoints: _, ...lacking } = parts;
        const bytes = (texts: Record<string, string>) =>
            Object.entries(texts).reduce((sum, [key, text]) => sum + new TextEncoder().encode(key + text).length, 0);
        const padded = (pad: string) => ({
            ...lacking,
            specChart: JSON.stringify({ ...JSON.parse(lacking.specChart), pad }),
        });
        const atLimit = padded('x'.repeat(MAX_CHART_SPEC_BYTES - bytes(padded(''))));
        const added = await pasteOnCanvas([
            { type: 'chart', parts: atLimit, width: 600, height: 371, look },
            { type: 'chart', parts, width: 600, height: 371, look },
        ]);
        expect(added).toEqual([expect.objectContaining(parts)]);
    });

    // A 10 pt cell copied from Sheets: the wire's size is pt, so it lands in a drawing as 10 pt at 96 dpi, not as 10 px.
    test("another app's text item lands in a drawing at its size in pt", async () => {
        const added = await pasteOnCanvas(
            [{ type: 'text', text: 'cell', width: 100, height: 20, typography: { fontSize: 10 } }],
            'infinite',
        );
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({ type: 'richtext', fontSize: 40 / 3 });
    });

    // A 960 pt deck is 2 px a pt, so a 44 pt title lands at 88 px.
    test("another app's text item lands on a deck at its size in the deck's pt", async () => {
        const added = await pasteOnCanvas([
            { type: 'text', text: 'title', width: 100, height: 20, typography: { fontSize: 44 } },
        ]);
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({ type: 'richtext', fontSize: 88 });
    });

    test("a canvas copy's chart pastes from its elements item, not as a second chart", async () => {
        const record: VectorElement = {
            ...DEFAULT_ELEMENT_PROPS,
            ...ELEMENT_KINDS.chart.defaults(VECTOR_STYLE_DEFAULTS),
            id: 'c1',
            type: 'chart',
            index: 'a0',
            x: 10,
            y: 20,
            width: 640,
            height: 400,
            angle: 0,
            ...newChartSpecParts(sampleChartSpec('bar')),
        };
        const elements = buildElementsClipboardItem([record], 'f2');
        if (!elements) throw new Error('no elements item');
        const added = await pasteOnCanvas([elements, { type: 'chart', parts, width: 640, height: 400, look }]);
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({
            type: 'chart',
            x: 10,
            y: 20,
            width: 640,
            height: 400,
            ...newChartSpecParts(sampleChartSpec('bar')),
        });
    });
});
