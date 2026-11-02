// An edit that would leave a validation rule more ranges than a rule may hold is refused whole: every peer, the server
// and a reload would drop such a rule. The author keeps the workbook as it was and sees why, and no batch reaches a peer.
import { afterEach, describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
const {
    MAX_VALIDATION_RANGES,
    SHEET_COLUMN_HEADER_HEIGHT,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_ROW_HEIGHT,
    SHEET_ROW_HEADER_WIDTH,
} = await import('@workspace/lib/sheets');
type Sheet = import('../../../state').Sheet;
type Op = import('../../../state').Op;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;
type SingleRange = import('@workspace/lib/sheets').SingleRange;

// Under the grid's row limit, so a paste on the last row can still add one.
const ROWS = 9000;
const RULE = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
const NOTICE = 'This edit would make a data validation rule too complex.';

const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    Reflect.deleteProperty(document, 'execCommand');
    HTMLElement.prototype.getBoundingClientRect = getBoundingClientRect;
    await cleanup?.();
    cleanup = undefined;
});

// Single cells on every other row of the given columns, which no coalescing joins.
function spacedRanges(columns: number[], count: number): SingleRange[] {
    return Array.from({ length: count }, (_, i) => {
        const row = 2 * Math.floor(i / columns.length);
        const column = columns[i % columns.length];
        return { row: [row, row], column: [column, column] };
    });
}

async function key(target: HTMLElement, init: KeyboardEventInit) {
    await act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    });
}

async function mount(sheet: Partial<Sheet>, showToolbar = false) {
    document.execCommand = () => true;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const workbook = createRef<WorkbookInstance>();
    const batches: Op[][] = [];
    const data: Sheet[] = [{ id: 's1', name: 'One', order: 0, status: 1, row: ROWS, column: 20, config: {}, ...sheet }];
    await act(async () => {
        root.render(
            createElement(Workbook, {
                ref: workbook,
                data,
                showToolbar,
                showFormulaBar: false,
                onOp: (ops: Op[]) => batches.push(ops),
            }),
        );
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const input = container.querySelector<HTMLDivElement>('#sheet-rich-text-editor');
    if (!input) throw new Error('no cell editor');
    input.focus();
    const api = () => {
        if (!workbook.current) throw new Error('workbook did not mount');
        return workbook.current;
    };
    return { container, input, api, batches, data };
}

// The warning dialog opens a moment after the refusal.
async function notice() {
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    return document.body.textContent ?? '';
}

async function copy(input: HTMLElement) {
    await key(input, { key: 'c', code: 'KeyC', ctrlKey: true });
    const clipboardData = new DataTransfer();
    await act(async () => {
        document.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
    });
    expect(clipboardData.getData('text/html')).toContain('<table');
    return clipboardData;
}

async function paste(input: HTMLElement, clipboardData: DataTransfer) {
    await key(input, { key: 'v', code: 'KeyV', ctrlKey: true });
    await act(async () => {
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
}

// A1 holds a rule and A2 none, and A1:A2 pasted down column C would land the rule on every other row.
test('a paste that would make a rule too complex changes nothing, sends nothing and says why', async () => {
    const rows = 17_000;
    const { input, api, batches, data } = await mount({
        row: rows,
        celldata: [{ r: 0, c: 0, v: { v: 'a', m: 'a' } }],
        dataValidations: { v: { ranges: [{ row: [0, 0], column: [0, 0] }], rule: RULE } },
    });
    const sheet = () => api().getAllSheets()[0];

    await act(async () => api().setSelection([{ row: [0, 1], column: [0, 0] }]));
    const clipboardData = await copy(input);
    await act(async () => api().setSelection([{ row: [0, rows - 1], column: [2, 2] }]));
    const sent = batches.length;
    await paste(input, clipboardData);

    expect(batches.length).toBe(sent);
    expect(sheet()?.dataValidations).toEqual(data[0].dataValidations);
    expect(sheet()?.data?.[0]?.[2] ?? null).toBeNull();
    // The refused paste left no undo step, so an undo has nothing to send.
    await act(async () => api().undo());
    expect(batches.length).toBe(sent);
    expect(await notice()).toContain(NOTICE);
});

// One rule holds as many ranges as a rule may: every other row of columns P and R, D1 and the block H1:J3. A fill, a move or
// a paint that adds a range to it is refused. The refusal also ends the drag, so the next click starts fresh.
describe('a refused mouse-up ends its drag', () => {
    const NUMBER = { type: 'number', type2: 'between', value1: '1', value2: '9' };
    const cellAt = (a1: string) => {
        const [, column, row] = /^([A-Z])(\d+)$/.exec(a1) ?? [];
        return { row: Number(row) - 1, column: column.charCodeAt(0) - 65 };
    };
    const capped = {
        v: {
            ranges: [
                ...spacedRanges([15, 17], MAX_VALIDATION_RANGES - 2),
                { row: [0, 0], column: [3, 3] },
                { row: [0, 2], column: [7, 9] },
            ],
            rule: NUMBER,
        },
    };

    async function mountCapped(showToolbar = false) {
        HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 1600, 900);
        const mounted = await mount(
            {
                celldata: [
                    { r: 1, c: 3, v: { v: 'x', m: 'x' } },
                    { r: 0, c: 11, v: { v: 'y', m: 'y', bl: 1 } },
                ],
                dataValidations: capped,
            },
            showToolbar,
        );
        return { ...mounted, sheet: () => mounted.api().getAllSheets()[0] };
    }

    // The page point inside a cell, by default its middle, as the grid lays cells out with no scroll.
    function pointIn(a1: string, dx = SHEET_DEFAULT_COL_WIDTH / 2, dy = SHEET_DEFAULT_ROW_HEIGHT / 2) {
        const { row, column } = cellAt(a1);
        return {
            pageX: SHEET_ROW_HEADER_WIDTH + column * SHEET_DEFAULT_COL_WIDTH + dx,
            pageY: SHEET_COLUMN_HEADER_HEIGHT + row * SHEET_DEFAULT_ROW_HEIGHT + dy,
        };
    }

    async function mouse(target: EventTarget, type: string, point: { pageX: number; pageY: number }) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
        Object.defineProperties(event, { pageX: { value: point.pageX }, pageY: { value: point.pageY } });
        await act(async () => {
            target.dispatchEvent(event);
        });
    }

    function element(container: HTMLElement, selector: string) {
        const found = container.querySelector(selector);
        if (!found) throw new Error(`no ${selector}`);
        return found;
    }

    test('a fill-handle drag', async () => {
        const { container, api, batches, sheet } = await mountCapped();
        await act(async () => api().setSelection([{ row: [0, 1], column: [3, 3] }]));
        const sent = batches.length;
        await mouse(element(container, '.sheet-cs-fillhandle'), 'mousedown', pointIn('D2', 98, 18));
        await mouse(document, 'mouseup', pointIn('D4'));
        expect(batches.length).toBe(sent);
        expect(sheet()?.data?.[3]?.[3] ?? null).toBeNull();
        expect(await notice()).toContain(NOTICE);

        // A drag still running would fill D1:D2 into E1:E2 here.
        await mouse(document, 'mouseup', pointIn('E2'));
        expect(batches.length).toBe(sent);
        expect(sheet()?.data?.[1]?.[4] ?? null).toBeNull();
    });

    test('a cell move', async () => {
        const { container, api, batches, sheet } = await mountCapped();
        await act(async () => api().setSelection([{ row: [0, 0], column: [11, 11] }]));
        const sent = batches.length;
        await mouse(element(container, '.sheet-cell-selected'), 'mousedown', pointIn('L1', 2, 2));
        await mouse(document, 'mousemove', pointIn('I2', 2, 2));
        await mouse(document, 'mouseup', pointIn('I2', 2, 2));
        expect(batches.length).toBe(sent);
        expect(sheet()?.data?.[0]?.[11]?.v).toBe('y');
        expect(await notice()).toContain(NOTICE);

        // A move still running would move L1 to F1 here.
        await mouse(document, 'mouseup', pointIn('F1', 2, 2));
        expect(batches.length).toBe(sent);
        expect(sheet()?.data?.[0]?.[11]?.v).toBe('y');
    });

    test('a one-shot format painter', async () => {
        const { container, api, batches, sheet } = await mountCapped(true);
        await act(async () => api().setSelection([{ row: [0, 0], column: [11, 11] }]));
        const edit = [...container.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]')].find(
            (button) => button.textContent?.trim() === 'Edit',
        );
        if (!edit) throw new Error('no Edit menu');
        await act(async () => {
            edit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        });
        const painter = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
            (item) => item.textContent?.trim() === 'Paint format',
        );
        if (!painter) throw new Error('no Paint format item');
        await act(async () => painter.click());

        const sent = batches.length;
        const cellArea = element(container, '.sheet-cell-area');
        await mouse(cellArea, 'mousedown', pointIn('I2'));
        await mouse(document, 'mouseup', pointIn('I2'));
        expect(batches.length).toBe(sent);
        expect(sheet()?.data?.[1]?.[8]?.bl ?? 0).toBe(0);
        expect(await notice()).toContain(NOTICE);

        // A painter still on would paint F1 bold here.
        await mouse(cellArea, 'mousedown', pointIn('F1'));
        await mouse(document, 'mouseup', pointIn('F1'));
        expect(batches.length).toBe(sent);
        expect(sheet()?.data?.[0]?.[5]?.bl ?? 0).toBe(0);
    });
});
