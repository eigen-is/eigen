// Escape in a formula with the function suggestions open, as in Excel and Google Sheets: the first Escape closes the
// list and leaves the edit open, the second cancels the edit. Neither writes the cell.

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
    return { input, a1: () => workbook.current?.getAllSheets()[0]?.data?.[0]?.[0] };
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
