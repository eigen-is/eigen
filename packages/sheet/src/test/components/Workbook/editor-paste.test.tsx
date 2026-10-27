// While a cell is open, the editor owns a paste: the text lands once, in the editor, and the grid pastes
// nothing, neither cells nor an image or a chart. A ⌘V whose paste the grid passed on doesn't make the next
// paste into the editor a grid paste that closes it.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { newChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import { buildChartClipboardItem, writeEigenClipboard } from '@workspace/lib/clipboard';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
type Sheet = import('../../../state').Sheet;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

const inserted: string[] = [];
let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
    inserted.length = 0;
    document.execCommand = (command, _showUI, value) => {
        if (command === 'insertText' && value !== undefined) inserted.push(value);
        return true;
    };
});
afterEach(async () => {
    Reflect.deleteProperty(document, 'execCommand');
    await cleanup?.();
    cleanup = undefined;
});

async function mount() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const workbook = createRef<WorkbookInstance>();
    const data: Sheet[] = [
        { id: 's1', name: 'One', order: 0, status: 1, row: 20, column: 10, celldata: [], config: {} },
    ];
    await act(async () => {
        root.render(createElement(Workbook, { ref: workbook, data, showToolbar: false, showFormulaBar: false }));
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const input = container.querySelector<HTMLDivElement>('#sheet-rich-text-editor');
    if (!input) throw new Error('no cell editor');
    input.focus();
    const sheet = () => workbook.current?.getAllSheets()[0];
    const rows = () => sheet()?.data?.length;
    const cell = (r: number, c: number) => sheet()?.data?.[r]?.[c] ?? null;
    const charts = () => Object.keys(sheet()?.charts ?? {});
    return { input, rows, cell, charts };
}

async function key(target: HTMLElement, init: KeyboardEventInit) {
    await act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    });
}

// F2 opens the selected cell, as a user would before pasting into it.
async function openEditor(input: HTMLElement) {
    await key(input, { key: 'F2', code: 'F2' });
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
}

async function paste(input: HTMLElement, clipboardData: DataTransfer) {
    await act(async () => {
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
}

function textClipboard(text: string) {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    clipboardData.setData('text/html', `<table><tr><td>${text}</td></tr><tr><td>b</td></tr></table>`);
    return clipboardData;
}

function chartClipboard() {
    const chart = newChartSpecParts(sampleChartSpec('pie'));
    const item = buildChartClipboardItem({ chart, box: { width: 320, height: 200 }, look: {} });
    if (!item) throw new Error('no item');
    const clipboardData = new DataTransfer();
    writeEigenClipboard(new ClipboardEvent('copy', { clipboardData }), { version: 1, items: [item] });
    return clipboardData;
}

test('a paste into the open editor inserts its text once and leaves the grid alone', async () => {
    const { input, rows, cell } = await mount();
    await openEditor(input);
    await paste(input, textClipboard('a'));
    expect(inserted).toEqual(['a']);
    expect(rows()).toBe(20);
    expect(cell(1, 0)).toBeNull();
});

test('a chart on the clipboard pastes into the open editor as nothing but text', async () => {
    const { input, charts } = await mount();
    await openEditor(input);
    await paste(input, chartClipboard());
    expect(charts()).toEqual([]);
});

test('a ⌘V on the grid that pasted a chart leaves no grid paste waiting for the editor', async () => {
    const { input, cell, charts } = await mount();
    await key(input, { key: 'v', code: 'KeyV', metaKey: true });
    await paste(input, chartClipboard());
    expect(charts()).toHaveLength(1);
    await openEditor(input);
    await paste(input, textClipboard('a'));
    expect(inserted).toEqual(['a']);
    expect(cell(1, 0)).toBeNull();
});
