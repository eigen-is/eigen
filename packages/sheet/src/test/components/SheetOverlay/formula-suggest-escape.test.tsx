// The function suggestions while a formula is open. As in Excel and Google Sheets, the first Escape closes the list and
// leaves the edit open, the second cancels the edit, and neither writes the cell. A click on another cell commits the
// edit, and the list goes with it.

import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DocSearchProvider } = await import('@workspace/ui/components/search/doc-search-provider');
const { Workbook } = await import('../../../components/Workbook');
type Sheet = import('../../../state').Sheet;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

async function mount() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const workbook = createRef<WorkbookInstance>();
    const data: Sheet[] = [
        {
            id: 's1',
            name: 'One',
            order: 0,
            status: 1,
            row: 10,
            column: 5,
            celldata: [{ r: 0, c: 0, v: { v: 'Name', m: 'Name', ct: { fa: 'General', t: 'g' } } }],
            config: {},
        },
    ];
    const controller = { search: () => [], highlightAll: () => {}, reveal: () => {}, canReplace: true };
    await act(async () => {
        root.render(
            createElement(DocSearchProvider, {
                controller,
                children: createElement(Workbook, { ref: workbook, data, showFormulaBar: false, hooks: {} }),
            }),
        );
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const input = container.querySelector<HTMLDivElement>('#sheet-rich-text-editor');
    if (!input) throw new Error('no cell editor');
    await act(async () => {
        workbook.current?.setSelection([{ row: [0, 0], column: [0, 0] }]);
    });
    await act(async () => input.focus());
    return { container, input, a1: () => workbook.current?.getAllSheets()[0]?.data?.[0]?.[0] };
}

async function key(target: HTMLElement, init: KeyboardEventInit) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    await act(async () => {
        target.dispatchEvent(event);
    });
}

// Types the text into the open editor the way a browser does: the key, then the edited text with the caret at its
// end, then the input event the editor reruns the formula parse on.
async function type(input: HTMLElement, text: string) {
    for (const ch of text) {
        await key(input, { key: ch, keyCode: ch.toUpperCase().charCodeAt(0) });
        await act(async () => {
            input.textContent = `${input.textContent ?? ''}${ch}`;
            const range = document.createRange();
            const node = input.lastChild?.lastChild ?? input.lastChild;
            if (node) {
                range.setStart(node, node.textContent?.length ?? 0);
                document.getSelection()?.removeAllRanges();
                document.getSelection()?.addRange(range);
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
}

const suggestions = () => document.querySelectorAll('.eigen-list-item').length;
// The editor box is see-through while no edit is open (InputBox).
const editorOpen = (input: HTMLElement) => input.closest<HTMLElement>('.sheet-input-box')?.style.opacity === '1';

test('the first Escape closes the suggestions, the second cancels, and neither writes the cell', async () => {
    const { input, a1 } = await mount();
    await key(input, { key: 'F2', code: 'F2' });
    await act(async () => {
        input.textContent = '';
    });
    await type(input, '=SUM(Z');
    expect(suggestions()).toBeGreaterThan(0);
    expect(editorOpen(input)).toBe(true);

    await key(input, { key: 'Escape', code: 'Escape', keyCode: 27 });
    expect(suggestions()).toBe(0);
    expect(editorOpen(input)).toBe(true);
    expect(input.textContent).toBe('=SUM(Z');
    expect(a1()?.v).toBe('Name');

    await key(input, { key: 'Escape', code: 'Escape', keyCode: 27 });
    expect(editorOpen(input)).toBe(false);
    expect(a1()?.v).toBe('Name');
    expect(a1()?.f).toBeUndefined();
});

test('a click on another cell commits the formula and leaves no suggestions behind', async () => {
    const { container, input, a1 } = await mount();
    await key(input, { key: 'F2', code: 'F2' });
    await act(async () => {
        input.textContent = '';
    });
    await type(input, '=SUM(Z');
    expect(suggestions()).toBeGreaterThan(0);

    const cellArea = container.querySelector<HTMLElement>('.sheet-cell-area');
    if (!cellArea) throw new Error('no cell area');
    // happy-dom lays nothing out: give the cell area a size, so the press lands on a cell rather than past the grid.
    cellArea.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    await act(async () => {
        cellArea.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 200, clientY: 50 }));
        cellArea.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 200, clientY: 50 }));
    });
    expect(a1()?.f).toBe('=SUM(Z)');
    expect(editorOpen(input)).toBe(false);
    expect(suggestions()).toBe(0);

    // The grid hands its keys back to the editor, which is focused again as the next edit opens.
    await act(async () => input.blur());
    await act(async () => input.focus());
    await key(input, { key: 'F2', code: 'F2' });
    expect(suggestions()).toBe(0);
});
