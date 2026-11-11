// Own or foreign, ⌘V and the Edit menu's Paste decide alike: a paste is this workbook's own copy exactly when the
// clipboard's table carries the id of the workbook's copy. The clipboard here is a DataTransfer the copy events write
// and the stubbed navigator.clipboard reads back.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
const { MAX_SHEET_ROW_COUNT } = await import('../../../engine/defaults');
type Sheet = import('../../../state').Sheet;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
});

const A1 = { sheetId: 's1', r: 0, c: 0 };
const B1 = { sheetId: 's1', r: 0, c: 1 };
const C1 = { sheetId: 's1', r: 0, c: 2 };
const B2 = { sheetId: 's1', r: 1, c: 1 };

// What the browser's async clipboard hands a menu row: the items of the system clipboard, or a refusal.
function stubClipboard(read: () => Promise<{ types: string[]; getType: (type: string) => Promise<Blob> }[]>) {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read } });
}

function clipboardItems(clipboard: DataTransfer) {
    stubClipboard(async () => [
        {
            types: ['text/html', 'text/plain'].filter((type) => clipboard.getData(type)),
            getType: async (type) => new Blob([clipboard.getData(type)], { type }),
        },
    ]);
}

async function mount(rows = 10) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const workbook = createRef<WorkbookInstance>();
    let sent = 0;
    const data: Sheet[] = [
        {
            id: 's1',
            name: 'One',
            order: 0,
            row: rows,
            column: 5,
            celldata: [
                { r: 0, c: 0, v: { v: 2, m: '2', f: '=1+1' } },
                { r: 0, c: 2, v: { v: 'kept', m: 'kept' } },
            ],
            config: {},
        },
    ];
    await act(async () => {
        root.render(createElement(Workbook, { ref: workbook, data, hooks: {}, onOp: () => (sent += 1) }));
    });
    cleanups.push(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    const cellAt = (r: number, c: number) => workbook.current?.getAllSheets()[0].data?.[r]?.[c];
    const select = (cell: { sheetId: string; r: number; c: number }) =>
        act(async () => {
            workbook.current?.revealSearchMatch(cell);
        });
    // The key as the workbook sees it on the grid's input, then the event the browser fires after it.
    const shortcut = async (code: 'KeyC' | 'KeyX' | 'KeyV', clipboardData: DataTransfer) => {
        const input = container.querySelector<HTMLElement>('#sheet-rich-text-editor');
        if (!input) throw new Error('no cell input');
        input.focus();
        const type = { KeyC: 'copy', KeyX: 'cut', KeyV: 'paste' }[code];
        await act(async () => {
            input.dispatchEvent(
                new KeyboardEvent('keydown', { code, key: code.at(-1)?.toLowerCase(), ctrlKey: true, bubbles: true }),
            );
            input.dispatchEvent(new ClipboardEvent(type, { clipboardData, bubbles: true, cancelable: true }));
        });
    };
    const editMenuRow = async (label: string) => {
        const edit = [...container.querySelectorAll('[role="menubar"] [role="menuitem"]')].find(
            (trigger) => trigger.textContent === 'Edit',
        );
        await act(async () => {
            edit?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        });
        const row = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((item) =>
            item.textContent?.trim().startsWith(label),
        );
        if (!row) throw new Error(`no ${label} row`);
        await act(async () => {
            row.click();
        });
    };
    const menuPaste = () => editMenuRow('Paste');
    // A painter's one use: the row, then a press and a release on a cell.
    const paintOnce = async () => {
        await editMenuRow('Paint format');
        const area = container.querySelector('.sheet-cell-area');
        if (!area) throw new Error('no cell area');
        area.getBoundingClientRect = () => new DOMRect(0, 0, 1600, 900);
        const mouse = async (target: EventTarget, type: string) => {
            const event = new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                button: 0,
                clientX: 300,
                clientY: 100,
            });
            await act(async () => {
                target.dispatchEvent(event);
            });
        };
        await mouse(area, 'mousedown');
        await mouse(document, 'mouseup');
    };
    return { cellAt, select, shortcut, menuPaste, paintOnce, sentOps: () => sent };
}

// The notice opens a moment after the edit.
test('a paste past the row limit leaves a notice and no edit', async () => {
    const { cellAt, select, shortcut, sentOps } = await mount(MAX_SHEET_ROW_COUNT);
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', 'a\nb');
    await select({ sheetId: 's1', r: MAX_SHEET_ROW_COUNT - 1, c: 0 });
    const sentBefore = sentOps();
    await shortcut('KeyV', clipboard);
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(document.querySelector('[role="alertdialog"], [role="dialog"]')?.textContent).toContain(
        `above the limit of ${MAX_SHEET_ROW_COUNT}`,
    );
    expect(cellAt(MAX_SHEET_ROW_COUNT - 1, 0)).toBeNull();
    expect(sentOps()).toBe(sentBefore);
});

test('a menu Paste after a cut was pasted lands the clipboard and leaves the source alone', async () => {
    const { cellAt, select, shortcut, menuPaste } = await mount();
    const clipboard = new DataTransfer();
    await select(A1);
    await shortcut('KeyX', clipboard);
    await select(B1);
    await shortcut('KeyV', clipboard);
    expect(cellAt(0, 1)?.f).toBe('=1+1');
    expect(cellAt(0, 0)).toBeNull();

    clipboardItems(clipboard);
    await select(C1);
    await menuPaste();
    expect(cellAt(0, 2)?.v).toBe(2);
    expect(cellAt(0, 2)?.f).toBeUndefined();
    expect(cellAt(0, 1)?.f).toBe('=1+1');
});

test('after the format painter a copy still pastes as itself, by ⌘V and by the menu', async () => {
    const { cellAt, select, shortcut, menuPaste, paintOnce } = await mount();
    const clipboard = new DataTransfer();
    await select(A1);
    await shortcut('KeyC', clipboard);
    await select(B2);
    await paintOnce();

    await select(B1);
    await shortcut('KeyV', clipboard);
    expect(cellAt(0, 1)?.f).toBe('=1+1');

    clipboardItems(clipboard);
    await select(B2);
    await menuPaste();
    expect(cellAt(1, 1)?.f).toBe('=1+1');
});

test('a menu Paste after a copy in another app pastes that copy, not this tab’s old one', async () => {
    const { cellAt, select, shortcut, menuPaste } = await mount();
    await select(A1);
    await shortcut('KeyC', new DataTransfer());

    const other = new DataTransfer();
    other.setData('text/plain', 'from elsewhere');
    clipboardItems(other);
    await select(B1);
    await menuPaste();
    expect(cellAt(0, 1)?.v).toBe('from elsewhere');
    expect(cellAt(0, 1)?.f).toBeUndefined();
});

test('a menu Paste after a painter with no copy pastes the clipboard', async () => {
    const { cellAt, select, menuPaste, paintOnce } = await mount();
    await select(A1);
    await paintOnce();

    const other = new DataTransfer();
    other.setData('text/plain', 'from elsewhere');
    clipboardItems(other);
    await select(B1);
    await menuPaste();
    expect(cellAt(0, 1)?.v).toBe('from elsewhere');
});

test('a menu Paste the browser refuses pastes nothing and says to press the key', async () => {
    const { cellAt, select, menuPaste } = await mount();
    stubClipboard(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    await select(B1);
    await menuPaste();
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(document.body.textContent).toContain('Your browser blocks Paste from a menu.');
    expect(cellAt(0, 1) ?? null).toBeNull();
});
