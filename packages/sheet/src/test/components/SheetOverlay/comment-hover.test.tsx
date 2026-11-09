// A mounted Workbook reports the comment under the pointer through its hook, on the mouse moves the grid already takes.
// The pointer counts as on a cell over the grid's own surface and the selection's handles, which straddle a selected
// cell's edges. Anything else in the cell area covers the cell, and the page around the grid is not the grid at all.
import { afterEach, expect, test } from 'bun:test';
import { newSheetChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import type { SheetChart } from '@workspace/lib/sheets';
import type { CommentHoverTarget } from '@workspace/lib/types/comments';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
type Sheet = import('../../../state').Sheet;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

// The chart floats over B2, the cell that holds the card c2.
const chart: SheetChart = {
    id: 'chart',
    index: 'a0',
    x: 105,
    y: 25,
    width: 60,
    height: 10,
    ...newSheetChartSpecParts({
        ...sampleChartSpec('column'),
        data: { source: 'inline', categories: ['A'], series: [{ id: 's-1', name: 'S', values: [1] }] },
    }),
};

const COMMENTED = { clientX: 5, clientY: 5 };
const PLAIN = { clientX: 5, clientY: 50 };
const UNDER_CHART = { clientX: 110, clientY: 30 };

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

async function mount(onHover: (target: CommentHoverTarget | null, workbook: WorkbookInstance) => void = () => {}) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const workbook = createRef<WorkbookInstance>();
    const reports: (CommentHoverTarget | null)[] = [];
    const data: Sheet[] = [
        {
            id: 's1',
            name: 'One',
            order: 0,
            row: 10,
            column: 5,
            celldata: [
                { r: 0, c: 0, v: { v: 'a', m: 'a', commentCardIds: ['c1'] } },
                { r: 1, c: 1, v: { v: 'b', m: 'b', commentCardIds: ['c2'] } },
            ],
            config: {},
            charts: { chart },
        },
    ];
    const commentCards = {
        c1: { id: 'c1', title: 'One', description: '' },
        c2: { id: 'c2', title: 'Two', description: '' },
    };
    const hooks = {
        onCommentHover: (target: CommentHoverTarget | null) => {
            reports.push(target);
            if (workbook.current) onHover(target, workbook.current);
        },
    };
    await act(async () => {
        root.render(createElement(Workbook, { ref: workbook, data, hooks, commentCards }));
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };

    const find = (selector: string) => {
        const element = container.querySelector(selector);
        if (!element) throw new Error(`no ${selector}`);
        return element;
    };
    // A press outside the area's rect selects nothing, and happy-dom lays nothing out.
    find('.sheet-cell-area').getBoundingClientRect = () => new DOMRect(0, 0, 600, 400);
    const dispatch = (element: Element, event: Event) =>
        act(async () => {
            element.dispatchEvent(event);
        });
    // The last thing the workbook reported for a move at this point, over this element.
    const moveOn = async (element: Element, point: { clientX: number; clientY: number }) => {
        await dispatch(element, new MouseEvent('mousemove', { bubbles: true, ...point }));
        return reports.at(-1);
    };
    const press = (point: { clientX: number; clientY: number }, type = 'mousedown') =>
        dispatch(find('.sheet-cell-table'), new MouseEvent(type, { bubbles: true, ...point }));
    return { find, moveOn, press, workbook, reports };
}

test('over a commented cell it reports the card and the cell, over a plain one nothing', async () => {
    const { find, moveOn } = await mount();
    const hover = await moveOn(find('.sheet-cell-table'), COMMENTED);
    expect(hover?.cardId).toBe('c1');
    expect([hover?.rect.x, hover?.rect.y]).toEqual([0, 0]);
    expect(await moveOn(find('.sheet-cell-table'), PLAIN)).toBeNull();
});

test('the page around the grid is not the cell at the same place', async () => {
    const { find, moveOn } = await mount();
    expect(await moveOn(find('.sheet-cell-table'), COMMENTED)).not.toBeNull();
    expect(await moveOn(document.body, COMMENTED)).toBeNull();
});

test('the cell area outside the grid is not the cell, such as its scrollbars or the add-rows row', async () => {
    const { find, moveOn } = await mount();
    expect(await moveOn(find('.sheet-cell-area'), COMMENTED)).toBeNull();
    expect(await moveOn(find('.sheet-bottom-controll-row button'), COMMENTED)).toBeNull();
});

test('a floating object hides the cell under it', async () => {
    const { find, moveOn } = await mount();
    expect((await moveOn(find('.sheet-cell-table'), UNDER_CHART))?.cardId).toBe('c2');
    expect(await moveOn(find('[data-floating-id="chart"] > div'), UNDER_CHART)).toBeNull();
});

test('the handles on a selected cell still read as the cell', async () => {
    const { find, moveOn, workbook } = await mount();
    await act(async () => workbook.current?.revealSearchMatch({ sheetId: 's1', r: 0, c: 0 }));
    expect((await moveOn(find('.sheet-cs-draghandle-right'), COMMENTED))?.cardId).toBe('c1');
    expect((await moveOn(find('.sheet-cs-fillhandle'), COMMENTED))?.cardId).toBe('c1');
});

test('a selection drag reports nothing until the press ends', async () => {
    const { find, moveOn, press } = await mount();
    await press(PLAIN);
    expect(await moveOn(find('.sheet-cell-table'), COMMENTED)).toBeNull();
    await press(COMMENTED, 'mouseup');
    expect((await moveOn(find('.sheet-cell-table'), COMMENTED))?.cardId).toBe('c1');
});

test('an open cell editor reports nothing', async () => {
    const { find, moveOn, press } = await mount();
    await press(COMMENTED);
    await press(COMMENTED, 'mouseup');
    await press(COMMENTED, 'dblclick');
    expect(await moveOn(find('.sheet-cell-table'), COMMENTED)).toBeNull();
});

test('a press on the cell area reports nothing, before any move', async () => {
    const { find, moveOn, press, reports } = await mount();
    expect((await moveOn(find('.sheet-cell-table'), COMMENTED))?.cardId).toBe('c1');
    await press(COMMENTED);
    expect(reports.at(-1)).toBeNull();
});

test('an edit opened from the keyboard reports nothing, with the pointer at rest on the cell', async () => {
    const { find, moveOn, workbook, reports } = await mount();
    await act(async () => workbook.current?.revealSearchMatch({ sheetId: 's1', r: 0, c: 0 }));
    expect((await moveOn(find('.sheet-cell-table'), COMMENTED))?.cardId).toBe('c1');
    await act(async () => {
        find('.sheet-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    });
    expect(reports.at(-1)).toBeNull();
});

test('a write the host makes on the report stays, since the report comes after the frame is written', async () => {
    const { find, moveOn, workbook } = await mount((target, opened) => {
        if (target) opened.setCellFormat(4, 4, 'bl', 1);
    });
    await moveOn(find('.sheet-cell-table'), COMMENTED);
    expect(workbook.current?.getFlowdata()?.[4]?.[4]?.bl).toBe(1);
});
